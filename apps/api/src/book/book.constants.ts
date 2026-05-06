import { join } from "node:path";
import { tmpdir } from "node:os";

export const DEFAULT_VECTOR_DIM = 1024;
export const DEFAULT_CHUNK_SIZE = 500;
export const DEFAULT_CHUNK_OVERLAP = 50;
export const DEFAULT_TOP_K = 5;
export const EMBEDDING_BATCH_SIZE = 10;
export const SAVE_TIMEOUT_MYSQL_FIND_MS = 30_000;
export const SAVE_TIMEOUT_PERSIST_FILE_MS = 60_000;
export const SAVE_TIMEOUT_MILVUS_CONNECT_MS = 45_000;
export const SAVE_TIMEOUT_MILVUS_ENSURE_COLLECTION_MS = 120_000;
export const SAVE_TIMEOUT_LOAD_DOCUMENTS_MS = 120_000;
export const SAVE_TIMEOUT_EMBED_CHAPTER_MS = 180_000;
export const SAVE_TIMEOUT_MILVUS_INSERT_CHAPTER_MS = 300_000;
export const SAVE_TIMEOUT_MYSQL_SAVE_MS = 30_000;
export const MILVUS_INSERT_BATCH_SIZE = 20;
export const MILVUS_INSERT_RPC_TIMEOUT_MS = 30_000;
export const MILVUS_INSERT_RETRY_MAX = 3;
export const MILVUS_INSERT_RETRY_BACKOFF_MS = 1_000;
export const ALLOWED_MIME_TYPES = ["text/plain", "application/epub+zip"];
export const BOOK_UPLOAD_DIR = join(process.cwd(), "storage", "books");
export const LOCAL_TEMP_BOOK_DIR = join(tmpdir(), "new-ai-agent-books");

