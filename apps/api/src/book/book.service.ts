import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, parse } from "node:path";
import type { Express } from "express";
import { pinyin } from "pinyin-pro";
import { Repository } from "typeorm";
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
const ALLOWED_MIME_TYPES = ["text/plain", "application/epub+zip"];
const BOOK_UPLOAD_DIR = join(process.cwd(), "storage", "books");

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

@Injectable()
export class BookService {
  private readonly vectorDim: number;
  private readonly milvusClient: MilvusClient;

  constructor(
    @Inject("BOOK_CHAT_MODEL") private readonly chatModel: ChatOpenAI,
    @Inject("BOOK_EMBEDDINGS_MODEL")
    private readonly embeddings: OpenAIEmbeddings,
    @InjectRepository(Book) private readonly bookRepo: Repository<Book>,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.vectorDim = Number(
      this.configService.get<string>("EMBEDDINGS_DIM") ?? DEFAULT_VECTOR_DIM,
    );
    this.milvusClient = new MilvusClient({
      address:
        this.configService.get<string>("MILVUS_ADDRESS") ?? "localhost:19530",
    });
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

    const existing = await this.bookRepo.findOne({
      where: [{ bookNamePinyin }, { milvusCollection }],
    });
    if (existing) {
      throw new BadRequestException(
        `Book already exists: ${existing.bookName}`,
      );
    }

    await mkdir(BOOK_UPLOAD_DIR, { recursive: true });
    const normalizedExt = fileExt || ".epub";
    const savedFileName = `${bookNamePinyin}-${Date.now()}${normalizedExt}`;
    const savedFilePath = join(BOOK_UPLOAD_DIR, savedFileName);
    await writeFile(savedFilePath, file.buffer);

    const entity = this.bookRepo.create({
      bookName: sourceBookName,
      bookNamePinyin,
      milvusCollection,
      filePath: savedFilePath,
      originalFileName,
    });

    await this.milvusClient.connectPromise;
    await this.ensureCollection(milvusCollection);

    const chunkSize =
      input.chunkSize && input.chunkSize > 0
        ? input.chunkSize
        : DEFAULT_CHUNK_SIZE;
    const chunkOverlap =
      input.chunkOverlap && input.chunkOverlap >= 0
        ? input.chunkOverlap
        : DEFAULT_CHUNK_OVERLAP;
    const documents = await this.loadBookDocuments(
      savedFilePath,
      file.buffer,
      normalizedExt,
    );
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

      const vectors = await this.embedDocumentsInBatches(chunks);
      const now = Date.now();
      const data = chunks.map((content, idx) => ({
        id: `${bookNamePinyin}_${chapterIndex + 1}_${idx}_${now}`,
        chapter_num: chapterIndex + 1,
        index: idx,
        content: content.slice(0, 10000),
        vector: vectors[idx],
      }));

      const result = await this.milvusClient.insert({
        collection_name: milvusCollection,
        data,
      });
      totalChunks += Number(result.insert_cnt ?? data.length);
    }

    const savedBook = await this.bookRepo.save(entity);

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

  private normalizeOriginalFilename(fileName: string) {
    try {
      return Buffer.from(fileName, "latin1").toString("utf8");
    } catch {
      return fileName;
    }
  }
}
