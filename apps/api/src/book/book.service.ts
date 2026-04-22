import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, parse } from "node:path";
import type { Express } from "express";
import { pinyin } from "pinyin-pro";
import { Repository } from "typeorm";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { EPubLoader } from "@langchain/community/document_loaders/fs/epub";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import {
  MilvusClient,
  DataType,
  IndexType,
  MetricType,
} from "@zilliz/milvus2-sdk-node";
import {
  AI_TTS_STREAM_EVENT,
  type AiTtsStreamEvent,
} from "../common/stream-events";
import { Book } from "./entities/book.entities";

const DEFAULT_VECTOR_DIM = 1024;
const DEFAULT_CHUNK_SIZE = 500;
const DEFAULT_CHUNK_OVERLAP = 50;
const DEFAULT_TOP_K = 5;
const EMBEDDING_BATCH_SIZE = 10;
const SAVE_TIMEOUT_MYSQL_FIND_MS = 30_000;
const SAVE_TIMEOUT_PERSIST_FILE_MS = 60_000;
const SAVE_TIMEOUT_MILVUS_CONNECT_MS = 45_000;
const SAVE_TIMEOUT_MILVUS_ENSURE_COLLECTION_MS = 120_000;
const SAVE_TIMEOUT_LOAD_DOCUMENTS_MS = 120_000;
const SAVE_TIMEOUT_EMBED_CHAPTER_MS = 180_000;
const SAVE_TIMEOUT_MILVUS_INSERT_CHAPTER_MS = 300_000;
const SAVE_TIMEOUT_MYSQL_SAVE_MS = 30_000;
const MILVUS_INSERT_BATCH_SIZE = 20;
const MILVUS_INSERT_RPC_TIMEOUT_MS = 60_000;
const MILVUS_INSERT_RETRY_MAX = 3;
const MILVUS_INSERT_RETRY_BACKOFF_MS = 1_000;
const ALLOWED_MIME_TYPES = ["text/plain", "application/epub+zip"];
const BOOK_UPLOAD_DIR = join(process.cwd(), "storage", "books");
const LOCAL_TEMP_BOOK_DIR = join(tmpdir(), "new-ai-agent-books");

type StorageDriver = "local" | "s3";

type ReadInput = {
  query: string;
  bookId?: string;
  bookName?: string;
  k?: number;
  ttsSessionId?: string;
};

export type SaveBookRequest = {
  file: Express.Multer.File;
  bookName?: string;
  chunkSize?: number;
  chunkOverlap?: number;
};

type SearchRow = {
  chapter_num?: number;
  index?: number;
  content?: string;
  score?: number;
};

type RetrievedDoc = {
  question: string;
  chapterNum: number | string;
  index: number | string;
  content: string;
  score: number;
};

type RouteStrategy = "simple" | "complex";

type EvaluationResult = {
  enough: boolean;
  missing: string[];
  reason: string;
  webQuery?: string;
};

type MilvusInsertRow = {
  id: string;
  chapter_num: number;
  index: number;
  content: string;
  vector: number[];
};

type PersistedUploadFile = {
  persistedFilePath: string;
  parserFilePath: string;
  cleanup?: () => Promise<void>;
};

@Injectable()
export class BookService {
  private readonly logger = new Logger(BookService.name);
  private readonly vectorDim: number;
  private readonly saveTimeoutMysqlFindMs: number;
  private readonly saveTimeoutPersistFileMs: number;
  private readonly saveTimeoutMilvusConnectMs: number;
  private readonly saveTimeoutMilvusEnsureCollectionMs: number;
  private readonly saveTimeoutLoadDocumentsMs: number;
  private readonly saveTimeoutEmbedChapterMs: number;
  private readonly saveTimeoutMilvusInsertChapterMs: number;
  private readonly saveTimeoutMysqlSaveMs: number;
  private readonly milvusInsertBatchSize: number;
  private readonly milvusInsertRpcTimeoutMs: number;
  private readonly milvusInsertRetryMax: number;
  private readonly milvusInsertRetryBackoffMs: number;
  private readonly milvusClient: MilvusClient;
  private readonly storageDriver: StorageDriver;
  private readonly s3Client?: S3Client;
  private readonly s3Bucket?: string;
  private readonly s3KeyPrefix: string;
  private readonly s3PublicBaseUrl?: string;

  constructor(
    @Inject("CHAT_MODEL") private readonly chatModel: ChatOpenAI,
    @Inject("WEB_SEARCH_TOOL") private readonly webSearchTool: any,
    @Inject("BOOK_EMBEDDINGS_MODEL")
    private readonly embeddings: OpenAIEmbeddings,
    @InjectRepository(Book) private readonly bookRepo: Repository<Book>,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.vectorDim = Number(
      this.configService.get<string>("EMBEDDINGS_DIM") ?? DEFAULT_VECTOR_DIM,
    );
    this.saveTimeoutMysqlFindMs = Number(
      this.configService.get<string>("SAVE_TIMEOUT_MYSQL_FIND_MS") ??
        SAVE_TIMEOUT_MYSQL_FIND_MS,
    );
    this.saveTimeoutPersistFileMs = Number(
      this.configService.get<string>("SAVE_TIMEOUT_PERSIST_FILE_MS") ??
        SAVE_TIMEOUT_PERSIST_FILE_MS,
    );
    this.saveTimeoutMilvusConnectMs = Number(
      this.configService.get<string>("SAVE_TIMEOUT_MILVUS_CONNECT_MS") ??
        SAVE_TIMEOUT_MILVUS_CONNECT_MS,
    );
    this.saveTimeoutMilvusEnsureCollectionMs = Number(
      this.configService.get<string>(
        "SAVE_TIMEOUT_MILVUS_ENSURE_COLLECTION_MS",
      ) ?? SAVE_TIMEOUT_MILVUS_ENSURE_COLLECTION_MS,
    );
    this.saveTimeoutLoadDocumentsMs = Number(
      this.configService.get<string>("SAVE_TIMEOUT_LOAD_DOCUMENTS_MS") ??
        SAVE_TIMEOUT_LOAD_DOCUMENTS_MS,
    );
    this.saveTimeoutEmbedChapterMs = Number(
      this.configService.get<string>("SAVE_TIMEOUT_EMBED_CHAPTER_MS") ??
        SAVE_TIMEOUT_EMBED_CHAPTER_MS,
    );
    this.saveTimeoutMilvusInsertChapterMs = Number(
      this.configService.get<string>("SAVE_TIMEOUT_MILVUS_INSERT_CHAPTER_MS") ??
        SAVE_TIMEOUT_MILVUS_INSERT_CHAPTER_MS,
    );
    this.saveTimeoutMysqlSaveMs = Number(
      this.configService.get<string>("SAVE_TIMEOUT_MYSQL_SAVE_MS") ??
        SAVE_TIMEOUT_MYSQL_SAVE_MS,
    );
    this.milvusInsertBatchSize = Number(
      this.configService.get<string>("MILVUS_INSERT_BATCH_SIZE") ??
        MILVUS_INSERT_BATCH_SIZE,
    );
    this.milvusInsertRpcTimeoutMs = Number(
      this.configService.get<string>("MILVUS_INSERT_RPC_TIMEOUT_MS") ??
        MILVUS_INSERT_RPC_TIMEOUT_MS,
    );
    this.milvusInsertRetryMax = Number(
      this.configService.get<string>("MILVUS_INSERT_RETRY_MAX") ??
        MILVUS_INSERT_RETRY_MAX,
    );
    this.milvusInsertRetryBackoffMs = Number(
      this.configService.get<string>("MILVUS_INSERT_RETRY_BACKOFF_MS") ??
        MILVUS_INSERT_RETRY_BACKOFF_MS,
    );
    const milvusToken = this.configService.get<string>("MILVUS_TOKEN")?.trim();
    const milvusAddress =
      this.configService.get<string>("MILVUS_ADDRESS") ?? "localhost:19530";
    const milvusSsl =
      (this.configService.get<string>("MILVUS_SSL") ?? "false") === "true" ||
      /^https:\/\//i.test(milvusAddress);
    this.milvusClient = new MilvusClient({
      address: milvusAddress,
      token: milvusToken || undefined,
      ssl: milvusSsl,
    });
    void this.milvusClient.connectPromise.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Milvus 连接失败] ${message}`);
    });
    this.storageDriver = (
      this.configService.get<string>("STORAGE_DRIVER") ?? "local"
    ).toLowerCase() as StorageDriver;
    this.s3KeyPrefix = (
      this.configService.get<string>("S3_KEY_PREFIX") ?? "books"
    )
      .replace(/^\/+|\/+$/g, "")
      .trim();
    this.s3PublicBaseUrl = this.configService
      .get<string>("S3_PUBLIC_BASE_URL")
      ?.replace(/\/+$/g, "")
      .trim();

    if (this.storageDriver === "s3") {
      const region = this.configService.get<string>("S3_REGION")?.trim();
      const bucket = this.configService.get<string>("S3_BUCKET")?.trim();
      if (!region || !bucket) {
        throw new Error(
          "S3 storage requires S3_REGION and S3_BUCKET environment variables.",
        );
      }

      const accessKeyId = this.configService
        .get<string>("S3_ACCESS_KEY_ID")
        ?.trim();
      const secretAccessKey = this.configService
        .get<string>("S3_SECRET_ACCESS_KEY")
        ?.trim();
      const endpoint = this.configService.get<string>("S3_ENDPOINT")?.trim();
      const forcePathStyle =
        (this.configService.get<string>("S3_FORCE_PATH_STYLE") ?? "false") ===
        "true";

      this.s3Bucket = bucket;
      this.s3Client = new S3Client({
        region,
        endpoint: endpoint || undefined,
        forcePathStyle,
        credentials:
          accessKeyId && secretAccessKey
            ? { accessKeyId, secretAccessKey }
            : undefined,
      });
    } else if (this.storageDriver !== "local") {
      throw new Error(
        `不支持的 STORAGE_DRIVER "${this.storageDriver}"，请使用 "local" 或 "s3"。`,
      );
    }
  }

  async listBooks() {
    const books = await this.bookRepo.find({
      order: { createdAt: "DESC" },
    });
    return books.map((item) => ({
      id: item.id,
      bookName: item.bookName,
      bookNamePinyin: item.bookNamePinyin,
      milvusCollection: item.milvusCollection,
      originalFileName: item.originalFileName,
      createdAt: item.createdAt,
    }));
  }

  async saveBook(input: SaveBookRequest) {
    const file = input.file;
    const originalFileName = this.normalizeOriginalFilename(file.originalname);

    const sourceBookName =
      input.bookName?.trim() || parse(originalFileName).name;

    if (!sourceBookName) {
      throw new BadRequestException("bookName 不能为空");
    }
    const fileExt = (extname(originalFileName) || "").toLowerCase();
    const extAllowed = fileExt === ".epub" || fileExt === ".txt";
    const mimeAllowed = ALLOWED_MIME_TYPES.includes(file.mimetype);
    if (!extAllowed && !mimeAllowed) {
      throw new BadRequestException(
        "不支持的文件类型，请上传 .epub 或 .txt 文件。",
      );
    }

    const bookNamePinyin = this.toPinyinSlug(sourceBookName);
    const milvusCollection = bookNamePinyin;

    this.logger.log(`saveBook start: bookNamePinyin=${bookNamePinyin}`);
    const existing = await this.withTimeout(
      this.bookRepo.findOne({
        where: [{ bookNamePinyin }, { milvusCollection }],
      }),
      "mysql-find-existing-book",
      this.saveTimeoutMysqlFindMs,
    );
    if (existing) {
      throw new BadRequestException(
        `书籍已存在：${existing.bookName}`,
      );
    }

    const normalizedExt = fileExt || ".epub";
    const savedFileName = `${bookNamePinyin}-${Date.now()}${normalizedExt}`;
    const uploadedFile = await this.withTimeout(
      this.persistUploadedBookFile({
        savedFileName,
        fileBuffer: file.buffer,
        contentType: file.mimetype,
      }),
      "persist-uploaded-file",
      this.saveTimeoutPersistFileMs,
    );

    const entity = this.bookRepo.create({
      bookName: sourceBookName,
      bookNamePinyin,
      milvusCollection,
      filePath: uploadedFile.persistedFilePath,
      originalFileName,
    });

    await this.withTimeout(
      this.milvusClient.connectPromise,
      "milvus-connect",
      this.saveTimeoutMilvusConnectMs,
    );
    await this.withTimeout(
      this.ensureCollection(milvusCollection),
      "milvus-ensure-collection",
      this.saveTimeoutMilvusEnsureCollectionMs,
    );

    const chunkSize =
      input.chunkSize && input.chunkSize > 0
        ? input.chunkSize
        : DEFAULT_CHUNK_SIZE;
    const chunkOverlap =
      input.chunkOverlap && input.chunkOverlap >= 0
        ? input.chunkOverlap
        : DEFAULT_CHUNK_OVERLAP;
    let documents: Array<{ pageContent: string }> = [];
    try {
      documents = await this.withTimeout(
        this.loadBookDocuments(
          uploadedFile.parserFilePath,
          file.buffer,
          normalizedExt,
        ),
        "load-book-documents",
        this.saveTimeoutLoadDocumentsMs,
      );
    } finally {
      if (uploadedFile.cleanup) {
        await uploadedFile.cleanup();
      }
    }
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap,
    });

    let totalChunks = 0;
    for (
      let chapterIndex = 0;
      chapterIndex < documents.length;
      chapterIndex += 1
    ) {
      const chapter = documents[chapterIndex];
      const chunks = await splitter.splitText(chapter.pageContent);
      if (!chunks.length) continue;

      const vectors = await this.withTimeout(
        this.embedDocumentsInBatches(chunks),
        `embed-documents-chapter-${chapterIndex + 1}`,
        this.saveTimeoutEmbedChapterMs,
      );
      const now = Date.now();
      const data: MilvusInsertRow[] = chunks.map((content, idx) => ({
        id: `${bookNamePinyin}_${chapterIndex + 1}_${idx}_${now}`,
        chapter_num: chapterIndex + 1,
        index: idx,
        content: content.slice(0, 10000),
        vector: vectors[idx],
      }));

      let chapterInserted = 0;
      for (let offset = 0; offset < data.length; offset += this.milvusInsertBatchSize) {
        const batch = data.slice(offset, offset + this.milvusInsertBatchSize);
        const batchNo = Math.floor(offset / this.milvusInsertBatchSize) + 1;
        const result = await this.withTimeout(
          this.insertBatchWithRetry(
            milvusCollection,
            batch,
            chapterIndex + 1,
            batchNo,
          ),
          `milvus-insert-chapter-${chapterIndex + 1}-batch-${batchNo}`,
          this.saveTimeoutMilvusInsertChapterMs,
        );
        chapterInserted += Number(result.insert_cnt ?? batch.length);
      }
      totalChunks += chapterInserted;
    }

    const savedBook = await this.withTimeout(
      this.bookRepo.save(entity),
      "mysql-save-book",
      this.saveTimeoutMysqlSaveMs,
    );
    this.logger.log(
      `saveBook done: bookId=${savedBook.id}, chapters=${documents.length}, inserted=${totalChunks}`,
    );

    return {
      ok: true,
      bookId: savedBook.id,
      bookName: savedBook.bookName,
      bookNamePinyin: savedBook.bookNamePinyin,
      milvusCollection: savedBook.milvusCollection,
      filePath: savedBook.filePath,
      chapters: documents.length,
      inserted: totalChunks,
    };
  }

  async *streamRead(input: ReadInput): AsyncGenerator<string> {
    const query = input.query?.trim();
    const topK = input.k && input.k > 0 ? input.k : DEFAULT_TOP_K;
    const sessionId = input.ttsSessionId?.trim();
    if (!query) {
      const text = "query 不能为空";
      if (sessionId) {
        this.emitTtsError(sessionId, text);
      }
      yield text;
      return;
    }

    const book = await this.findBook(input.bookId, input.bookName);
    if (!book) {
      const text = "未在 MySQL 中找到对应书籍";
      if (sessionId) {
        this.emitTtsError(sessionId, text);
      }
      throw new NotFoundException(text);
    }

    try {
      await this.milvusClient.connectPromise;
      await this.loadCollection(book.milvusCollection);
      const routeSchema = z.object({
        strategy: z.enum(["simple", "complex"]),
        reason: z.string().min(1),
      });
      const decomposeSchema = z.object({
        subQuestions: z.array(z.string().min(1)).min(1).max(4),
      });
      const evaluateSchema = z.object({
        enough: z.boolean(),
        missing: z.array(z.string()).max(6),
        reason: z.string().min(1),
        webQuery: z.string().optional(),
      });

      const GraphState = Annotation.Root({
        question: Annotation,
        k: Annotation,
        strategy: Annotation,
        routeReason: Annotation,
        subQuestions: Annotation,
        nextHop: Annotation,
        retrievedDocs: Annotation,
        localContext: Annotation,
        evaluation: Annotation,
        webContext: Annotation,
        generation: Annotation,
      });

      const routeIntentNode = async (state: any) => {
        const router = this.chatModel.withStructuredOutput(routeSchema);
        const route = await router.invoke(
          [
            "你是 RAG 路由器。",
            "请判断用户问题是 simple 还是 complex：",
            "- simple: 常识问答、定义解释、无需书内证据。",
            "- complex: 需要《当前书籍》具体情节/事实/证据，或多条件推理。",
            "",
            `问题：${state.question}`,
          ].join("\n"),
        );
        return {
          strategy: route.strategy as RouteStrategy,
          routeReason: route.reason,
          subQuestions: [],
          nextHop: 0,
          retrievedDocs: [],
          localContext: "",
          evaluation: undefined,
          webContext: "",
          generation: "",
        };
      };

      const directAnswerNode = async (state: any) => {
        const response = await this.chatModel.invoke(
          [
            "你是中文问答助手。",
            "这是简单问题，直接回答即可；若不确定请明确说明。",
            "",
            `问题：${state.question}`,
          ].join("\n"),
        );
        return { generation: this.extractModelText(response) };
      };

      const decomposeQuestionNode = async (state: any) => {
        const planner = this.chatModel.withStructuredOutput(decomposeSchema);
        const plan = await planner.invoke(
          [
            "把复杂问题拆成 1-4 个可检索子问题，按回答顺序返回数组。",
            "要求：",
            "1) 子问题具体、可检索。",
            "2) 避免重复。",
            "3) 保留原问题关键约束。",
            "",
            `原问题：${state.question}`,
          ].join("\n"),
        );
        return {
          subQuestions:
            plan.subQuestions?.filter((item) => item.trim()).slice(0, 4) ??
            [state.question],
          nextHop: 0,
        };
      };

      const retrieveHopNode = async (state: any) => {
        const subQuestions = Array.isArray(state.subQuestions) && state.subQuestions.length
          ? (state.subQuestions as string[])
          : [state.question as string];
        const hop = Number(state.nextHop ?? 0);
        const currentQuestion = subQuestions[hop] ?? state.question;
        const rows = await this.searchBookCollection(
          book.milvusCollection,
          currentQuestion,
          state.k as number,
        );
        const mergedDocs = this.mergeRetrievedDocs(
          (state.retrievedDocs ?? []) as RetrievedDoc[],
          rows,
          currentQuestion,
        );
        return {
          retrievedDocs: mergedDocs,
          localContext: this.buildLocalContext(mergedDocs),
          nextHop: hop + 1,
        };
      };

      const evaluateNode = async (state: any) => {
        const evaluator = this.chatModel.withStructuredOutput(evaluateSchema);
        const hasWeb = Boolean(state.webContext && String(state.webContext).trim());
        const result = await evaluator.invoke(
          [
            "你是信息充分性评估器，请评估当前上下文是否足够回答问题。",
            "",
            `问题：${state.question}`,
            "",
            "本地检索上下文：",
            state.localContext || "（空）",
            "",
            hasWeb ? "联网补充上下文：" : "",
            hasWeb ? String(state.webContext) : "",
            "",
            "输出字段：",
            "- enough: boolean",
            "- missing: 缺失信息点数组（最多 6 条）",
            "- reason: 简短原因",
            "- webQuery: 若不足，给出一个适合联网搜索的查询",
          ].join("\n"),
        );
        return {
          evaluation: {
            enough: result.enough,
            missing: result.missing ?? [],
            reason: result.reason,
            webQuery: result.webQuery,
          } as EvaluationResult,
        };
      };

      const webSearchNode = async (state: any) => {
        const webQuery =
          state.evaluation?.webQuery?.trim() || (state.question as string);
        let webContext = "";
        try {
          const result = await this.webSearchTool.invoke({
            query: webQuery,
            count: 8,
          });
          webContext =
            typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2);
        } catch (error) {
          webContext = `联网搜索失败：${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        return { webContext };
      };

      const generateNode = async (state: any) => {
        const context = [state.localContext, state.webContext]
          .filter((item) => typeof item === "string" && item.trim())
          .join("\n\n===== 联网补充 =====\n\n");
        const response = await this.chatModel.invoke(
          [
            "你是严谨的中文书籍问答助手。",
            "优先依据上下文作答，不要编造；若证据不足请明确说明不确定。",
            "",
            "上下文：",
            context || "（空）",
            "",
            `问题：${state.question}`,
            "",
            "回答要求：",
            "1) 先给结论，再给关键依据。",
            "2) 若使用联网结果，请标注 URL 或引用编号。",
            "3) 无法确认时明确说明缺失点。",
          ].join("\n"),
        );
        return { generation: this.extractModelText(response) };
      };

      const afterRoute = (state: any) =>
        state.strategy === "simple" ? "direct_answer" : "decompose_question";
      const afterRetrieve = (state: any) => {
        const subQuestions = Array.isArray(state.subQuestions)
          ? (state.subQuestions as string[])
          : [];
        return Number(state.nextHop ?? 0) < subQuestions.length
          ? "retrieve_hop"
          : "evaluate_context";
      };
      const afterEvaluate = (state: any) => {
        const enough = Boolean(state.evaluation?.enough);
        if (enough) return "generate_answer";
        if (String(state.webContext ?? "").trim()) return "generate_answer";
        return "web_search";
      };

      const graph = new StateGraph(GraphState)
        .addNode("route_intent", routeIntentNode)
        .addNode("direct_answer", directAnswerNode)
        .addNode("decompose_question", decomposeQuestionNode)
        .addNode("retrieve_hop", retrieveHopNode)
        .addNode("evaluate_context", evaluateNode)
        .addNode("web_search", webSearchNode)
        .addNode("generate_answer", generateNode)
        .addEdge(START, "route_intent")
        .addConditionalEdges("route_intent", afterRoute, {
          direct_answer: "direct_answer",
          decompose_question: "decompose_question",
        })
        .addEdge("decompose_question", "retrieve_hop")
        .addConditionalEdges("retrieve_hop", afterRetrieve, {
          retrieve_hop: "retrieve_hop",
          evaluate_context: "evaluate_context",
        })
        .addConditionalEdges("evaluate_context", afterEvaluate, {
          generate_answer: "generate_answer",
          web_search: "web_search",
        })
        .addEdge("web_search", "evaluate_context")
        .addEdge("direct_answer", END)
        .addEdge("generate_answer", END)
        .compile();

      const result = await graph.invoke({
        question: query,
        k: topK,
        strategy: "complex",
        routeReason: "",
        subQuestions: [],
        nextHop: 0,
        retrievedDocs: [],
        localContext: "",
        evaluation: undefined,
        webContext: "",
        generation: "",
      });

      const answer =
        String(result.generation ?? "").trim() ||
        "抱歉，我暂时无法生成有效答案。";
      for (const chunk of this.chunkText(answer, 48)) {
        if (sessionId) {
          this.emitTtsChunk(sessionId, chunk);
        }
        yield chunk;
      }
      if (sessionId) {
        this.emitTtsEnd(sessionId);
      }
    } catch (error) {
      if (sessionId) {
        this.emitTtsError(
          sessionId,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }

  private async searchBookCollection(
    collectionName: string,
    query: string,
    topK: number,
  ): Promise<SearchRow[]> {
    const queryVector = await this.embeddings.embedQuery(query);
    const searchResult = await this.milvusClient.search({
      collection_name: collectionName,
      vector: queryVector,
      limit: topK,
      metric_type: MetricType.COSINE,
      output_fields: ["chapter_num", "index", "content"],
    });
    return (searchResult.results ?? []) as SearchRow[];
  }

  private mergeRetrievedDocs(
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

  private buildLocalContext(docs: RetrievedDoc[]): string {
    if (!docs.length) return "";
    return docs
      .map(
        (doc, idx) =>
          `[Chunk ${idx + 1}] 子问题: ${doc.question}\nChapter ${doc.chapterNum}, Index ${doc.index}, Score ${doc.score.toFixed(4)}\n${doc.content}`,
      )
      .join("\n\n");
  }

  private extractModelText(response: unknown): string {
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

  private chunkText(text: string, maxLength: number): string[] {
    if (!text.trim()) return [];
    const chunks: string[] = [];
    let cursor = 0;
    while (cursor < text.length) {
      chunks.push(text.slice(cursor, cursor + maxLength));
      cursor += maxLength;
    }
    return chunks;
  }

  private async insertBatchWithRetry(
    collectionName: string,
    batch: MilvusInsertRow[],
    chapterNo: number,
    batchNo: number,
  ) {
    let attempt = 0;
    let lastError: unknown;
    const maxAttempts = Math.max(1, this.milvusInsertRetryMax);

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await this.milvusClient.insert({
          collection_name: collectionName,
          data: batch,
          timeout: this.milvusInsertRpcTimeoutMs,
        });
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (this.isMilvusConnectionDroppedError(message)) {
          throw new ServiceUnavailableException(
            "Milvus 连接已断开，请稍后重试。",
          );
        }
        if (this.isMilvusUnavailableError(message)) {
          throw new ServiceUnavailableException(
            "Milvus 当前不可用，请稍后重试。",
          );
        }
        const canRetry =
          attempt < maxAttempts && this.isRetryableMilvusInsertError(message);
        this.logger.warn(
          `[milvus insert retry] chapter=${chapterNo}, batch=${batchNo}, attempt=${attempt}/${maxAttempts}, retry=${canRetry}, reason=${message}`,
        );
        if (!canRetry) {
          throw error;
        }
        const waitMs = this.milvusInsertRetryBackoffMs * Math.pow(2, attempt - 1);
        await this.sleep(waitMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private isRetryableMilvusInsertError(message: string): boolean {
    const msg = message.toLowerCase();
    return (
      msg.includes("rst_stream") ||
      msg.includes("protocol error") ||
      msg.includes("unavailable") ||
      msg.includes("deadline exceeded") ||
      msg.includes("connection reset") ||
      msg.includes("socket hang up") ||
      msg.includes("econnreset") ||
      msg.includes("code 13") ||
      msg.includes("code 14")
    );
  }

  private isMilvusUnavailableError(message: string): boolean {
    const msg = message.toLowerCase();
    return msg.includes("unavailable");
  }

  private isMilvusConnectionDroppedError(message: string): boolean {
    const msg = message.toLowerCase();
    return (
      msg.includes("connection dropped") ||
      msg.includes("no connection established")
    );
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async findBook(bookId?: string, bookName?: string) {
    if (bookId?.trim() && /^\d+$/.test(bookId.trim())) {
      return this.bookRepo.findOne({ where: { id: Number(bookId.trim()) } });
    }

    if (bookName?.trim()) {
      const inputName = bookName.trim();
      const byName = await this.bookRepo.findOne({
        where: { bookName: inputName },
      });
      if (byName) return byName;
      const pinyinName = this.toPinyinSlug(inputName);
      return this.bookRepo.findOne({ where: { bookNamePinyin: pinyinName } });
    }

    return null;
  }

  private toPinyinSlug(bookName: string) {
    const base = pinyin(bookName, { toneType: "none" })
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9_]/g, "");
    if (!base) return `book_${Date.now()}`;
    return /^\d/.test(base) ? `b${base}` : base;
  }

  private async ensureCollection(collectionName: string) {
    const hasCollection = await this.milvusClient.hasCollection({
      collection_name: collectionName,
    });

    if (!hasCollection.value) {
      await this.milvusClient.createCollection({
        collection_name: collectionName,
        fields: [
          {
            name: "id",
            data_type: DataType.VarChar,
            max_length: 200,
            is_primary_key: true,
          },
          { name: "chapter_num", data_type: DataType.Int32 },
          { name: "index", data_type: DataType.Int32 },
          { name: "content", data_type: DataType.VarChar, max_length: 10000 },
          {
            name: "vector",
            data_type: DataType.FloatVector,
            dim: this.vectorDim,
          },
        ],
      });

      await this.milvusClient.createIndex({
        collection_name: collectionName,
        field_name: "vector",
        index_type: IndexType.IVF_FLAT,
        metric_type: MetricType.COSINE,
        params: { nlist: 1024 },
      });
    }

    await this.loadCollection(collectionName);
  }

  private async loadCollection(collectionName: string) {
    try {
      await this.milvusClient.loadCollection({
        collection_name: collectionName,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("already loaded")) {
        throw error;
      }
    }
  }

  private emitTtsChunk(sessionId: string, chunk: string) {
    const event: AiTtsStreamEvent = { type: "chunk", sessionId, chunk };
    this.eventEmitter.emit(AI_TTS_STREAM_EVENT, event);
  }

  private emitTtsEnd(sessionId: string) {
    const event: AiTtsStreamEvent = { type: "end", sessionId };
    this.eventEmitter.emit(AI_TTS_STREAM_EVENT, event);
  }

  private emitTtsError(sessionId: string, error: string) {
    const event: AiTtsStreamEvent = { type: "error", sessionId, error };
    this.eventEmitter.emit(AI_TTS_STREAM_EVENT, event);
  }

  private async embedDocumentsInBatches(chunks: string[]) {
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
      const batchVectors = await this.embeddings.embedDocuments(batch);
      vectors.push(...batchVectors);
    }
    return vectors;
  }

  private async loadBookDocuments(
    savedFilePath: string,
    fileBuffer: Buffer,
    fileExt: string,
  ) {
    if (fileExt === ".txt") {
      const text = fileBuffer.toString("utf8").trim();
      if (!text) {
        throw new BadRequestException("Uploaded text file is empty");
      }
      return [{ pageContent: text }];
    }

    const loader = new EPubLoader(savedFilePath, { splitChapters: true });
    return loader.load();
  }

  private async persistUploadedBookFile(input: {
    savedFileName: string;
    fileBuffer: Buffer;
    contentType?: string;
  }): Promise<PersistedUploadFile> {
    if (this.storageDriver === "local") {
      await mkdir(BOOK_UPLOAD_DIR, { recursive: true });
      const savedFilePath = join(BOOK_UPLOAD_DIR, input.savedFileName);
      await writeFile(savedFilePath, input.fileBuffer);
      return {
        persistedFilePath: savedFilePath,
        parserFilePath: savedFilePath,
      };
    }

    if (!this.s3Client || !this.s3Bucket) {
      throw new Error("S3 client is not initialized");
    }

    await mkdir(LOCAL_TEMP_BOOK_DIR, { recursive: true });
    const parserFilePath = join(
      LOCAL_TEMP_BOOK_DIR,
      `${Date.now()}-${randomUUID()}-${input.savedFileName}`,
    );
    await writeFile(parserFilePath, input.fileBuffer);

    const key = this.s3KeyPrefix
      ? `${this.s3KeyPrefix}/${input.savedFileName}`
      : input.savedFileName;

    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.s3Bucket,
          Key: key,
          Body: input.fileBuffer,
          ContentType: input.contentType || "application/octet-stream",
        }),
      );
    } catch (error) {
      await rm(parserFilePath, { force: true });
      throw error;
    }

    return {
      persistedFilePath: this.s3PublicBaseUrl
        ? `${this.s3PublicBaseUrl}/${key}`
        : `s3://${this.s3Bucket}/${key}`,
      parserFilePath,
      cleanup: async () => {
        await rm(parserFilePath, { force: true });
      },
    };
  }

  private normalizeOriginalFilename(fileName: string) {
    try {
      return Buffer.from(fileName, "latin1").toString("utf8");
    } catch {
      return fileName;
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    label: string,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`[saveBook timeout] step=${label}, timeoutMs=${timeoutMs}`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[saveBook 失败] step=${label}, reason=${message}`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
