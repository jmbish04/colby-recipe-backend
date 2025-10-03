export interface AiService {
  run(model: string, options: Record<string, unknown>): Promise<any>;
}

export interface VectorizeMetadata {
  recipe_id?: string;
  title?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface VectorizeMatch {
  id: string;
  score?: number;
  metadata?: VectorizeMetadata | null;
}

export interface VectorizeQueryResult {
  matches?: VectorizeMatch[];
}

export interface VectorizeIndex {
  upsert(
    vectors: Array<{
      id: string;
      values: number[];
      metadata?: VectorizeMetadata;
    }>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  query(options: {
    vector: number[];
    topK?: number;
    filter?: Record<string, unknown>;
    returnValues?: boolean;
    returnMetadata?: boolean;
  }): Promise<VectorizeQueryResult>;
  delete?(ids: string[]): Promise<unknown>;
}

export type R2Body =
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream
  | Blob
  | string
  | null;

export interface R2ObjectBody {
  body?: ReadableStream;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2Object {
  key: string;
  size: number;
  uploaded: string;
  httpEtag?: string;
  httpMetadata?: Record<string, unknown>;
  customMetadata?: Record<string, string>;
  body?: ReadableStream;
  writeHttpMetadata(response: ResponseInit): void;
  readHttpMetadata(): Record<string, unknown>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2Bucket {
  put(key: string, value: R2Body, options?: R2PutOptions): Promise<void | R2Object>;
  get(key: string): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
}

export interface BrowserPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
  content(): Promise<string>;
  close(): Promise<void>;
  evaluate<T>(fn: string | ((...args: any[]) => T), ...args: any[]): Promise<T>;
}

export interface BrowserSession {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface BrowserService {
  newSession(options?: Record<string, unknown>): Promise<BrowserSession>;
}

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  WORKER_API_KEY: string;
  AI: AiService;
  BROWSER: BrowserService;
  VEC: VectorizeIndex;
  KV: KVNamespace;
  BUCKET: R2Bucket;
}
