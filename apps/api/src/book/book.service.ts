import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
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
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
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
  private readonly milvusClient: MilvusClient;
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
    const milvusToken = this.configService.get<string>("MILVUS_TOKEN")?.trim();
    this.milvusClient = new MilvusClient({
      address:
        this.configService.get<string>("MILVUS_ADDRESS") ?? "localhost:19530",
      token: milvusToken || undefined,
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
        `Unsupported STORAGE_DRIVER "${this.storageDriver}". Use "local" or "s3".`,
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
      throw new BadRequestException("bookName is required");
    }
    const fileExt = (extname(originalFileName) || "").toLowerCase();
    const extAllowed = fileExt === ".epub" || fileExt === ".txt";
    const mimeAllowed = ALLOWED_MIME_TYPES.includes(file.mimetype);
    if (!extAllowed && !mimeAllowed) {
      throw new BadRequestException(
        "Unsupported file type. Please upload .epub or .txt file.",
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
      const data = chunks.map((content, idx) => ({
        id: `${bookNamePinyin}_${chapterIndex + 1}_${idx}_${now}`,
        chapter_num: chapterIndex + 1,
        index: idx,
        content: content.slice(0, 10000),
        vector: vectors[idx],
      }));

      const result = await this.withTimeout(
        this.milvusClient.insert({
          collection_name: milvusCollection,
          data,
        }),
        `milvus-insert-chapter-${chapterIndex + 1}`,
        this.saveTimeoutMilvusInsertChapterMs,
      );
      totalChunks += Number(result.insert_cnt ?? data.length);
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
      const text = "query is required";
      if (sessionId) {
        this.emitTtsError(sessionId, text);
      }
      yield text;
      return;
    }

    const book = await this.findBook(input.bookId, input.bookName);
    if (!book) {
      const text = "book not found in mysql table";
      if (sessionId) {
        this.emitTtsError(sessionId, text);
      }
      throw new NotFoundException(text);
    }

    try {
      await this.milvusClient.connectPromise;
      await this.loadCollection(book.milvusCollection);

      const queryVector = await this.embeddings.embedQuery(query);
      const searchResult = await this.milvusClient.search({
        collection_name: book.milvusCollection,
        vector: queryVector,
        limit: topK,
        metric_type: MetricType.COSINE,
        output_fields: ["chapter_num", "index", "content"],
      });

      const rows = (searchResult.results ?? []) as SearchRow[];
      if (!rows.length) {
        const fallback = "No relevant content found in this book.";
        if (sessionId) {
          this.emitTtsChunk(sessionId, fallback);
          this.emitTtsEnd(sessionId);
        }
        yield fallback;
        return;
      }

      const context = rows
        .map(
          (item, i) =>
            `[Chunk ${i + 1}] Chapter ${item.chapter_num ?? "N/A"}: ${item.content ?? ""}`,
        )
        .join("\n\n");

      const prompt = PromptTemplate.fromTemplate(
        [
          "You are a book assistant. Answer strictly based on the provided context.",
          "If context does not contain the answer, explicitly say you do not know.",
          "",
          "Context:",
          "{context}",
          "",
          "Question: {query}",
          "",
          "Answer:",
        ].join("\n"),
      );
      const chain = prompt.pipe(this.chatModel).pipe(new StringOutputParser());
      const stream = await chain.stream({ query, context });

      for await (const chunk of stream) {
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
      this.logger.error(`[saveBook failed] step=${label}, reason=${message}`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
