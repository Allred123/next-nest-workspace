import { pinyin } from "pinyin-pro";
import { RetrievedDoc, SearchRow } from "./book.types";

export function mergeRetrievedDocs(
  existing: RetrievedDoc[],
  rows: SearchRow[],
  question: string,
): RetrievedDoc[] {
  const dedup = new Map<string, RetrievedDoc>();
  for (const item of existing) {
    dedup.set(
      `${item.chapterNum}::${item.index}::${item.content.slice(0, 120)}`,
      item,
    );
  }

  for (const row of rows) {
    const content = (row.content ?? "").trim();
    if (!content) continue;
    const doc: RetrievedDoc = {
      question,
      chapterNum: row.chapter_num ?? "N/A",
      index: row.index ?? "N/A",
      content,
      score: Number(row.score ?? 0),
    };
    const key = `${doc.chapterNum}::${doc.index}::${doc.content.slice(0, 120)}`;
    if (!dedup.has(key)) {
      dedup.set(key, doc);
    }
  }
  return [...dedup.values()];
}

export function buildLocalContext(docs: RetrievedDoc[]): string {
  if (!docs.length) return "";
  return docs
    .map(
      (doc, idx) =>
        `[Chunk ${idx + 1}] 子问题: ${doc.question}\nChapter ${doc.chapterNum}, Index ${doc.index}, Score ${doc.score.toFixed(4)}\n${doc.content}`,
    )
    .join("\n\n");
}

export function extractModelText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const content = (response as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
}

export function chunkText(text: string, maxLength: number): string[] {
  if (!text.trim()) return [];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    chunks.push(text.slice(cursor, cursor + maxLength));
    cursor += maxLength;
  }
  return chunks;
}

export function toPinyinSlug(bookName: string): string {
  const base = pinyin(bookName, { toneType: "none" })
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9_]/g, "");
  if (!base) return `book_${Date.now()}`;
  return /^\d/.test(base) ? `b${base}` : base;
}

