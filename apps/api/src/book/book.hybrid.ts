import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { RetrievedDoc, SearchRow } from "./book.types";

export function buildHybridRetrievalQueries(
  originalQuery: string,
  augmentation?: { queries?: string[] },
): string[] {
  const candidates = [
    originalQuery,
    ...((augmentation?.queries ?? []).map((item) => item?.trim()) as string[]),
  ].filter((item): item is string => Boolean(item && item.trim()));
  const uniq = new Set<string>();
  const result: string[] = [];
  for (const q of candidates) {
    const key = q.trim();
    if (!key || uniq.has(key)) continue;
    uniq.add(key);
    result.push(key);
  }
  return result.length ? result : [originalQuery];
}

export async function recallEsDocuments(input: {
  esClient: ElasticsearchClient;
  indexName: string;
  queries: string[];
  totalK: number;
}): Promise<RetrievedDoc[]> {
  const { esClient, indexName, queries, totalK } = input;
  const n = Math.max(1, queries.length);
  const kEach = Math.max(2, Math.ceil(totalK / n));
  const batches = await Promise.all(
    queries.map((q) =>
      esClient.search({
        index: indexName,
        size: kEach,
        query: {
          multi_match: {
            query: q,
            fields: ["note_title^2", "note_body", "title", "content"],
            type: "best_fields",
            analyzer: "ik_smart",
          },
        },
      }),
    ),
  );

  const out: RetrievedDoc[] = [];
  for (let qi = 0; qi < queries.length; qi += 1) {
    const q = queries[qi];
    const hits = (batches[qi].hits?.hits ?? []) as Array<{
      _id?: string;
      _score?: number;
      _source?: Record<string, unknown>;
    }>;
    for (const hit of hits) {
      const src = hit._source ?? {};
      const title = String(src.note_title ?? src.title ?? "").trim();
      const body = String(src.note_body ?? src.content ?? "").trim();
      const content = [title, body].filter(Boolean).join("\n").trim();
      if (!content) continue;
      out.push({
        question: q,
        chapterNum: "ES",
        index: hit._id ?? "N/A",
        content,
        score: Number(hit._score ?? 0),
      });
    }
  }
  return out;
}

export async function recallMilvusDocuments(input: {
  collectionName: string;
  queries: string[];
  totalK: number;
  searchFn: (collection: string, query: string, topK: number) => Promise<SearchRow[]>;
}): Promise<RetrievedDoc[]> {
  const { collectionName, queries, totalK, searchFn } = input;
  const n = Math.max(1, queries.length);
  const kEach = Math.max(2, Math.ceil(totalK / n));
  const batches = await Promise.all(
    queries.map((q) => searchFn(collectionName, q, kEach)),
  );
  const out: RetrievedDoc[] = [];
  for (let qi = 0; qi < queries.length; qi += 1) {
    const q = queries[qi];
    for (const row of batches[qi] ?? []) {
      const content = String(row.content ?? "").trim();
      if (!content) continue;
      out.push({
        question: q,
        chapterNum: row.chapter_num ?? "N/A",
        index: row.index ?? "N/A",
        content,
        score: Number(row.score ?? 0),
      });
    }
  }
  return out;
}

export function mergeHybridDocs(
  esDocs: RetrievedDoc[],
  milvusDocs: RetrievedDoc[],
): RetrievedDoc[] {
  const combined = [...(esDocs ?? []), ...(milvusDocs ?? [])];
  const seen = new Set<string>();
  const out: RetrievedDoc[] = [];
  for (const doc of combined) {
    const id = `${doc.chapterNum}::${doc.index}::${doc.content.slice(0, 120)}`;
    if (!doc.content?.trim() || seen.has(id)) continue;
    seen.add(id);
    out.push(doc);
  }
  return out;
}

export async function rerankHybridDocs(input: {
  query: string;
  docs: RetrievedDoc[];
  topN: number;
  rerankApiKey?: string;
  rerankModel: string;
  rerankBaseUrl: string;
  onWarn?: (message: string) => void;
}): Promise<RetrievedDoc[]> {
  const {
    query,
    docs,
    topN,
    rerankApiKey,
    rerankModel,
    rerankBaseUrl,
    onWarn,
  } = input;
  if (!docs.length) return [];
  if (!rerankApiKey) {
    return docs.slice(0, topN);
  }

  try {
    const payload = {
      model: rerankModel,
      input: {
        query,
        documents: docs.map((item) => item.content),
      },
      parameters: {
        top_n: Math.min(topN, docs.length),
      },
    };
    const resp = await fetch(rerankBaseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rerankApiKey}`,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`rerank http status ${resp.status}`);
    }
    const data = (await resp.json()) as {
      output?: { results?: Array<{ index?: number }> };
    };
    const idxs = (data.output?.results ?? [])
      .map((item) => Number(item.index))
      .filter((num) => Number.isInteger(num) && num >= 0 && num < docs.length);
    if (!idxs.length) return docs.slice(0, topN);
    return idxs.map((idx) => docs[idx]).slice(0, topN);
  } catch (error) {
    if (onWarn) {
      onWarn(error instanceof Error ? error.message : String(error));
    }
    return docs.slice(0, topN);
  }
}

export function formatHybridContext(docs: RetrievedDoc[]): string {
  return docs
    .map(
      (doc, idx) =>
        `[${idx + 1}] chapter=${doc.chapterNum} index=${doc.index} score=${doc.score.toFixed(4)}\n${doc.content}`,
    )
    .join("\n\n---\n\n");
}

