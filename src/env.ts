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
}
