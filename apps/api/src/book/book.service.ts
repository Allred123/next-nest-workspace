import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  RequestTimeoutException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { extname, join, parse } from "node:path";
import { Repository } from "typeorm";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { EPubLoader } from "@langchain/community/document_loaders/fs/epub";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
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
import {
  ALLOWED_MIME_TYPES,
  BOOK_UPLOAD_DIR,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_TOP_K,
  DEFAULT_VECTOR_DIM,
  EMBEDDING_BATCH_SIZE,
  LOCAL_TEMP_BOOK_DIR,
  MILVUS_INSERT_BATCH_SIZE,
  MILVUS_INSERT_RETRY_BACKOFF_MS,
  MILVUS_INSERT_RETRY_MAX,
  MILVUS_INSERT_RPC_TIMEOUT_MS,
  SAVE_TIMEOUT_EMBED_CHAPTER_MS,
  SAVE_TIMEOUT_LOAD_DOCUMENTS_MS,
  SAVE_TIMEOUT_MILVUS_CONNECT_MS,
  SAVE_TIMEOUT_MILVUS_ENSURE_COLLECTION_MS,
  SAVE_TIMEOUT_MILVUS_INSERT_CHAPTER_MS,
  SAVE_TIMEOUT_MYSQL_FIND_MS,
  SAVE_TIMEOUT_MYSQL_SAVE_MS,
  SAVE_TIMEOUT_PERSIST_FILE_MS,
} from "./book.constants";
import {
  MilvusInsertRow,
  PersistedUploadFile,
  ReadInput,
  RetrievedDoc,
  RouteStrategy,
  SaveBookRequest,
  SearchRow,
  StorageDriver,
} from "./book.types";
import { chunkText, extractModelText, toPinyinSlug } from "./book.utils";
import {
  buildHybridRetrievalQueries,
  formatHybridContext,
  mergeHybridDocs,
  recallEsDocuments,
  recallMilvusDocuments,
  rerankHybridDocs,
} from "./book.hybrid";

const HYBRID_ES_K = 15;
const HYBRID_MILVUS_K = 15;
const HYBRID_RERANK_TOP_N = 3;

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
  private readonly esClient?: ElasticsearchClient;
  private readonly esIndexName?: string;
  private readonly rerankApiKey?: string;
  private readonly rerankModel: string;
  private readonly rerankBaseUrl: string;
  private readonly storageDriver: StorageDriver;
  private readonly s3Client?: S3Client;
  private readonly s3Bucket?: string;
  private readonly s3KeyPrefix: string;
  private readonly s3PublicBaseUrl?: string;

  constructor(
    @Inject("CHAT_MODEL") private readonly chatModel: ChatOpenAI,
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
    const esNode =
      this.configService.get<string>("ES_NODE")?.trim() ||
      "http://localhost:9200";
    this.esIndexName = this.configService.get<string>("ES_INDEX")?.trim();
    this.esClient = new ElasticsearchClient({ node: esNode });
    this.rerankApiKey =
      this.configService.get<string>("RERANK_API_KEY")?.trim() ||
      this.configService.get<string>("OPENAI_API_KEY")?.trim();
    this.rerankModel =
      this.configService.get<string>("RERANK_MODEL")?.trim() || "qwen3-rerank";
    this.rerankBaseUrl =
      this.configService.get<string>("RERANK_BASE_URL")?.trim() ||
      "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank";
    void this.milvusClient.connectPromise.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Milvus connect failed] ${message}`);
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
        `Unsupported STORAGE_DRIVER "${this.storageDriver}", please use "local" or "s3".`,
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
      throw new BadRequestException("bookName cannot be empty");
    }
    const fileExt = (extname(originalFileName) || "").toLowerCase();
    const extAllowed =
      fileExt === ".epub" ||
      fileExt === ".txt" ||
      fileExt === ".pdf" ||
      fileExt === ".docx";
    const mimeAllowed = ALLOWED_MIME_TYPES.includes(file.mimetype);
    if (!extAllowed && !mimeAllowed) {
      throw new BadRequestException(
        "Unsupported file type. Please upload .epub, .txt, .pdf, or .docx.",
      );
    }

    const bookNamePinyin = toPinyinSlug(sourceBookName);
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
        `Book already exists: ${existing.bookName}`,
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
    const totalChunks = await this.indexDocumentsToMilvus({
      documents,
      chunkSize,
      chunkOverlap,
      bookNamePinyin,
      milvusCollection,
    });

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
      const text = "query cannot be empty";
      if (sessionId) {
        this.emitTtsError(sessionId, text);
      }
      yield text;
      return;
    }

    const book = await this.findBook(input.bookId, input.bookName);
    if (!book) {
      const text = "Book not found in MySQL.";
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
      const queryAugmentSchema = z.object({
        queries: z.array(z.string().min(1)).min(1).max(3),
      });

      const GraphState = Annotation.Root({
        question: Annotation,
        strategy: Annotation,
        routeReason: Annotation,
        queryAugmentation: Annotation,
        esHits: Annotation,
        milvusHits: Annotation,
        merged: Annotation,
        topDocuments: Annotation,
        generation: Annotation,
      });

      const isBookFile =
        book.originalFileName.toLowerCase().endsWith(".epub");
      const docLabel = isBookFile ? "书籍" : "文档";
      const evidenceHint = isBookFile
        ? "需要当前文档中的具体情节/事实/证据，或多条件推理"
        : "需要当前文档中的具体内容/事实/数据/证据，或多条件推理";

      const routeIntentNode = async (state: any) => {
        const router = this.chatModel.withStructuredOutput(routeSchema);
        const route = await router.invoke(
          [
            "你是 RAG 路由器。",
            "请判断用户问题是 simple 还是 complex。",
            "- simple: 常识问答、定义解释、无需文档内证据。",
            `- complex: ${evidenceHint}。`,
            "",
            `问题：${state.question}`,
          ].join("\n"),
        );
        this.logger.log(`[route_intent] strategy=${route.strategy}, reason=${route.reason}`);

        return {
          strategy: route.strategy as RouteStrategy,
          routeReason: route.reason,
          queryAugmentation: { queries: [] },
          esHits: [],
          milvusHits: [],
          merged: [],
          topDocuments: [],
          generation: "",
        };
      };

      const directAnswerNode = async (state: any) => {
        this.logger.log(`[direct_answer] question=${state.question}`);
        try {
          const response = await this.chatModel.invoke(
            [
              "你是中文问答助手。",
              "这是简单问题，直接回答即可；若不确定请明确说明。",
              "",
              `问题：${state.question}`,
            ].join("\n"),
          );
          return { generation: extractModelText(response) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`[direct_answer] failed: ${message}`);
          return { generation: "抱歉，回答生成失败，请稍后重试。" };
        }
      };

      const queryAugmentNode = async (state: any) => {
        this.logger.log(`[query_augment] start, question=${state.question}`);
        try {
          const planner = this.chatModel.withStructuredOutput(queryAugmentSchema);
          const result = await planner.invoke(
            [
              "你是检索问题重写器。",
              "请基于用户问题生成 1-3 条不同角度、可直接用于检索的问句。",
              "要求：每条都具体、避免重复、保留关键约束。",
              "",
              `原问题：${state.question}`,
            ].join("\n"),
          );
          const queries = (result.queries ?? [])
            .map((item: string) => item.trim())
            .filter(Boolean)
            .slice(0, 3);
          this.logger.log(`[query_augment] generated ${queries.length} queries: ${JSON.stringify(queries)}`);
          if (!queries.length) {
            this.logger.warn(`[query_augment] LLM returned empty queries, falling back to original question`);
            return { queryAugmentation: { queries: [state.question as string] } };
          }
          return { queryAugmentation: { queries } };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`[query_augment] failed: ${message}`);
          return { queryAugmentation: { queries: [state.question as string] } };
        }
      };

      const esRecallNode = async (state: any) => {
        this.logger.log(`[es_recall] start`);
        try {
          const queries = buildHybridRetrievalQueries(
            state.question as string,
            state.queryAugmentation as { queries?: string[] },
          );
          const esHits = this.esClient
            ? await recallEsDocuments({
                esClient: this.esClient,
                indexName: this.getEsIndexName(book.milvusCollection),
                queries,
                totalK: HYBRID_ES_K,
              })
            : [];
          this.logger.log(`[es_recall] got ${esHits.length} hits`);
          return { esHits };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`[es_recall] failed: ${message}`);
          return { esHits: [] };
        }
      };

      const milvusRecallNode = async (state: any) => {
        this.logger.log(`[milvus_recall] start`);
        try {
          const queries = buildHybridRetrievalQueries(
            state.question as string,
            state.queryAugmentation as { queries?: string[] },
          );
          const milvusHits = await recallMilvusDocuments({
            collectionName: book.milvusCollection,
            queries,
            totalK: HYBRID_MILVUS_K,
            searchFn: (collection, q, limit) =>
              this.searchBookCollection(collection, q, limit),
          });
          this.logger.log(`[milvus_recall] got ${milvusHits.length} hits`);
          return { milvusHits };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`[milvus_recall] failed: ${message}`);
          return { milvusHits: [] };
        }
      };

      const mergeNode = async (state: any) => {
        const merged = mergeHybridDocs(
          (state.esHits ?? []) as RetrievedDoc[],
          (state.milvusHits ?? []) as RetrievedDoc[],
        );
        this.logger.log(`[merge_recall] merged ${merged.length} docs from es=${(state.esHits ?? []).length}, milvus=${(state.milvusHits ?? []).length}`);
        return { merged };
      };

      const rerankNode = async (state: any) => {
        this.logger.log(`[rerank] start, docs=${(state.merged ?? []).length}`);
        const topDocuments = await rerankHybridDocs({
          query: state.question as string,
          docs: (state.merged ?? []) as RetrievedDoc[],
          topN: Math.max(HYBRID_RERANK_TOP_N, topK),
          rerankApiKey: this.rerankApiKey,
          rerankModel: this.rerankModel,
          rerankBaseUrl: this.rerankBaseUrl,
          onWarn: (message) => this.logger.warn(`[rerank fallback] ${message}`),
        });
        this.logger.log(`[rerank] got ${topDocuments.length} top docs`);
        return { topDocuments };
      };

      const generateNode = async (state: any) => {
        this.logger.log(`[generate_answer] start, docs=${(state.topDocuments ?? []).length}`);
        try {
          const generation = await this.generateAnswerByDocs(
            state.question as string,
            (state.topDocuments ?? []) as RetrievedDoc[],
            docLabel,
          );
          this.logger.log(`[generate_answer] done, length=${generation.length}`);
          return { generation };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`[generate_answer] failed: ${message}`);
          return { generation: "抱歉，回答生成失败，请稍后重试。" };
        }
      };

      const afterRoute = (state: any) =>
        state.strategy === "simple" ? "direct_answer" : "query_augment";

      const graph = new StateGraph(GraphState)
        .addNode("route_intent", routeIntentNode)
        .addNode("direct_answer", directAnswerNode)
        .addNode("query_augment", queryAugmentNode)
        .addNode("es_recall", esRecallNode)
        .addNode("milvus_recall", milvusRecallNode)
        .addNode("merge_recall", mergeNode)
        .addNode("rerank", rerankNode)
        .addNode("generate_answer", generateNode)
        .addEdge(START, "route_intent")
        .addConditionalEdges("route_intent", afterRoute, {
          direct_answer: "direct_answer",
          query_augment: "query_augment",
        })
        .addEdge("query_augment", "es_recall")
        .addEdge("query_augment", "milvus_recall")
        .addEdge(["es_recall", "milvus_recall"], "merge_recall")
        .addEdge("merge_recall", "rerank")
        .addEdge("rerank", "generate_answer")
        .addEdge("direct_answer", END)
        .addEdge("generate_answer", END)
        .compile();

      const result = await graph.invoke({
        question: query,
        strategy: "complex",
        routeReason: "",
        queryAugmentation: { queries: [] },
        esHits: [],
        milvusHits: [],
        merged: [],
        topDocuments: [],
        generation: "",
      });

      const answer =
        String(result.generation ?? "").trim() ||
        "抱歉，我暂时无法生成有效答案。";
      for (const chunk of chunkText(answer, 48)) {
        if (sessionId) {
          this.emitTtsChunk(sessionId, chunk);
        }
        yield chunk;
      }
      if (sessionId) {
        this.emitTtsEnd(sessionId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[streamRead] error: ${message}`);
      if (error instanceof Error && error.stack) {
        this.logger.error(`[streamRead] stack: ${error.stack}`);
      }
      if (sessionId) {
        this.emitTtsError(sessionId, message);
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

  private getEsIndexName(defaultName: string): string {
    const fromConfig = this.esIndexName?.trim();
    return fromConfig || defaultName;
  }

  private async generateAnswerByDocs(
    query: string,
    docs: RetrievedDoc[],
    docLabel: string = "文档",
  ): Promise<string> {
    const context = formatHybridContext(docs);
    const response = await this.chatModel.invoke(
      [
        `你是严谨的中文${docLabel}问答助手。`,
        "优先依据检索片段作答，不要编造；若证据不足请明确说明不确定。",
        "",
        `用户问题：${query}`,
        "",
        "检索片段：",
        context || "（空）",
        "",
        "回答要求：先结论，再依据；简洁有条理。",
      ].join("\n"),
    );
    return extractModelText(response).trim();
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
            "Milvus connection dropped, please retry later.",
          );
        }
        if (this.isMilvusDeadlineExceededError(message)) {
          throw new RequestTimeoutException(
            "Milvus write timed out, please retry later or reduce upload size.",
          );
        }
        if (this.isMilvusUnavailableError(message)) {
          throw new ServiceUnavailableException(
            "Milvus is currently unavailable, please retry later.",
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
        const waitMs =
          this.milvusInsertRetryBackoffMs * Math.pow(2, attempt - 1);
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

  private isMilvusDeadlineExceededError(message: string): boolean {
    const msg = message.toLowerCase();
    return msg.includes("deadline exceeded") || msg.includes("code 4");
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
      const pinyinName = toPinyinSlug(inputName);
      return this.bookRepo.findOne({ where: { bookNamePinyin: pinyinName } });
    }

    return null;
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

  private async indexDocumentsToMilvus(input: {
    documents: Array<{ pageContent: string }>;
    chunkSize: number;
    chunkOverlap: number;
    bookNamePinyin: string;
    milvusCollection: string;
  }): Promise<number> {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: input.chunkSize,
      chunkOverlap: input.chunkOverlap,
    });

    let totalChunks = 0;
    for (
      let chapterIndex = 0;
      chapterIndex < input.documents.length;
      chapterIndex += 1
    ) {
      const chapter = input.documents[chapterIndex];
      const chunks = await splitter.splitText(chapter.pageContent);
      if (!chunks.length) continue;

      const vectors = await this.withTimeout(
        this.embedDocumentsInBatches(chunks),
        `embed-documents-chapter-${chapterIndex + 1}`,
        this.saveTimeoutEmbedChapterMs,
      );
      const now = Date.now();
      const data: MilvusInsertRow[] = chunks.map((content, idx) => ({
        id: `${input.bookNamePinyin}_${chapterIndex + 1}_${idx}_${now}`,
        chapter_num: chapterIndex + 1,
        index: idx,
        content: content.slice(0, 10000),
        vector: vectors[idx],
      }));

      await this.indexChapterToEs(
        this.getEsIndexName(input.milvusCollection),
        input.bookNamePinyin,
        chapterIndex + 1,
        data,
      );

      totalChunks += await this.insertChapterBatches(
        input.milvusCollection,
        data,
        chapterIndex + 1,
      );
    }

    return totalChunks;
  }

  private async insertChapterBatches(
    milvusCollection: string,
    data: MilvusInsertRow[],
    chapterNo: number,
  ): Promise<number> {
    let chapterInserted = 0;
    for (
      let offset = 0;
      offset < data.length;
      offset += this.milvusInsertBatchSize
    ) {
      const batch = data.slice(offset, offset + this.milvusInsertBatchSize);
      const batchNo = Math.floor(offset / this.milvusInsertBatchSize) + 1;
      const result = await this.withTimeout(
        this.insertBatchWithRetry(milvusCollection, batch, chapterNo, batchNo),
        `milvus-insert-chapter-${chapterNo}-batch-${batchNo}`,
        this.saveTimeoutMilvusInsertChapterMs,
      );
      chapterInserted += Number(result.insert_cnt ?? batch.length);
    }
    return chapterInserted;
  }

  private async indexChapterToEs(
    indexName: string,
    bookNamePinyin: string,
    chapterNo: number,
    rows: MilvusInsertRow[],
  ): Promise<void> {
    if (!this.esClient || !rows.length) return;

    const operations: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      operations.push({
        index: {
          _index: indexName,
          _id: row.id,
        },
      });
      operations.push({
        id: row.id,
        note_title: `${bookNamePinyin} chapter ${chapterNo}`,
        title: `${bookNamePinyin} chapter ${chapterNo}`,
        content: row.content,
        chapter_num: row.chapter_num,
        chunk_index: row.index,
        source: "book_upload",
      });
    }

    const result = await this.esClient.bulk({
      refresh: true,
      operations,
    });
    if (result.errors) {
      const firstError = result.items.find((item) => {
        const action = (item.index ?? item.create ?? item.update) as
          | { error?: { reason?: string; type?: string } }
          | undefined;
        return Boolean(action?.error);
      });
      const reason =
        (firstError?.index as { error?: { reason?: string } } | undefined)
          ?.error?.reason ?? "unknown bulk error";
      throw new Error(`Elasticsearch bulk index failed: ${reason}`);
    }
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

    if (fileExt === ".pdf") {
      const parser = new PDFParse({ data: fileBuffer });
      const parsed = await parser.getText();
      await parser.destroy();
      const text = (parsed.text ?? "").trim();
      if (!text) {
        throw new BadRequestException("Uploaded PDF file is empty");
      }
      return [{ pageContent: text }];
    }

    if (fileExt === ".docx") {
      const parsed = await mammoth.extractRawText({ buffer: fileBuffer });
      const text = (parsed.value ?? "").trim();
      if (!text) {
        throw new BadRequestException("Uploaded DOCX file is empty");
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
        reject(
          new Error(`[saveBook timeout] step=${label}, timeoutMs=${timeoutMs}`),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[saveBook failed] step=${label}, reason=${message}`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
