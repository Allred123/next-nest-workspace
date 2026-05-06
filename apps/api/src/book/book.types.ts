import type { Express } from "express";

export type StorageDriver = "local" | "s3";

export type ReadInput = {
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

export type SearchRow = {
  chapter_num?: number;
  index?: number;
  content?: string;
  score?: number;
};

export type RetrievedDoc = {
  question: string;
  chapterNum: number | string;
  index: number | string;
  content: string;
  score: number;
};

export type RouteStrategy = "simple" | "complex";

export type EvaluationResult = {
  enough: boolean;
  missing: string[];
  reason: string;
  webQuery?: string;
};

export type MilvusInsertRow = {
  id: string;
  chapter_num: number;
  index: number;
  content: string;
  vector: number[];
};

export type PersistedUploadFile = {
  persistedFilePath: string;
  parserFilePath: string;
  cleanup?: () => Promise<void>;
};

