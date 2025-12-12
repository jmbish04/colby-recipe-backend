/**
 * Cloudflare Worker Environment Bindings
 * Type-safe definitions for all wrangler.toml bindings
 */

import type { PrismaClient } from '@prisma/client';

// ============================================================================
// AI Service Types
// ============================================================================

export interface AiTextGenerationResult {
  response?: string;
  text?: string;
}

export interface AiEmbeddingResult {
  data?: Array<{ values: number[] }>;
  shape?: number[];
}

export interface AiTranscriptionResult {
  text?: string;
}

export interface AiService {
  run(
    model: string,
    options: Record<string, unknown>
  ): Promise<AiTextGenerationResult | AiEmbeddingResult | AiTranscriptionResult | unknown>;
}

// ============================================================================
// Vectorize Types
// ============================================================================

export interface VectorizeMetadata {
  recipe_id?: string;
  appliance_id?: string;
  user_id?: string;
  title?: string;
  chunk_index?: number;
  chunk_text?: string;
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
  count?: number;
}

export interface VectorizeVector {
  id: string;
  values: number[];
  metadata?: VectorizeMetadata;
}

export interface VectorizeIndex {
  upsert(vectors: VectorizeVector[]): Promise<{ count: number }>;
  query(options: {
    vector: number[];
    topK?: number;
    filter?: Record<string, unknown>;
    returnValues?: boolean;
    returnMetadata?: boolean;
  }): Promise<VectorizeQueryResult>;
  delete?(ids: string[]): Promise<{ count: number }>;
  getByIds?(ids: string[]): Promise<VectorizeVector[]>;
}

// ============================================================================
// R2 Types
// ============================================================================

export type R2Body =
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream
  | Blob
  | string
  | null;

export interface R2PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBody {
  key: string;
  size: number;
  uploaded: Date;
  httpEtag?: string;
  checksums?: { md5?: ArrayBuffer };
  httpMetadata?: Record<string, unknown>;
  customMetadata?: Record<string, string>;
  body: ReadableStream;
  bodyUsed: boolean;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
}

export interface R2Bucket {
  put(key: string, value: R2Body, options?: R2PutOptions): Promise<R2ObjectBody | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: Array<{ key: string; size: number; uploaded: Date }>;
    truncated: boolean;
    cursor?: string;
  }>;
  head(key: string): Promise<R2ObjectBody | null>;
}

// ============================================================================
// Browser Rendering Types
// ============================================================================

export interface BrowserPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
  content(): Promise<string>;
  close(): Promise<void>;
  evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;
  screenshot(options?: { type?: string }): Promise<ArrayBuffer>;
}

export interface BrowserSession {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface BrowserService {
  newSession(options?: Record<string, unknown>): Promise<BrowserSession>;
}

// ============================================================================
// Queue Types
// ============================================================================

export interface QueueMessage<T = unknown> {
  id: string;
  timestamp: Date;
  body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface QueueBatch<T = unknown> {
  queue: string;
  messages: QueueMessage<T>[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

export interface Queue<T = unknown> {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(
    messages: Array<{ body: T; delaySeconds?: number }>
  ): Promise<void>;
}

// ============================================================================
// Durable Object Types
// ============================================================================

export interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId;
  idFromString(id: string): DurableObjectId;
  newUniqueId(): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub<T>;
}

export interface DurableObjectId {
  toString(): string;
  equals(other: DurableObjectId): boolean;
}

export interface DurableObjectStub<T = unknown> {
  id: DurableObjectId;
  fetch(request: Request): Promise<Response>;
  // RPC methods will be typed per agent
}

export interface DurableObjectState {
  id: DurableObjectId;
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  deleteAll(): Promise<void>;
  list<T = unknown>(options?: {
    prefix?: string;
    limit?: number;
    start?: string;
    end?: string;
    reverse?: boolean;
  }): Promise<Map<string, T>>;
}

// ============================================================================
// Main Environment Interface
// ============================================================================

export interface Env {
  // Static Assets
  ASSETS: Fetcher;

  // D1 Database
  DB: D1Database;

  // Workers AI
  AI: AiService;

  // Browser Rendering
  BROWSER: BrowserService;

  // Vectorize Indexes
  RECIPE_VECTORIZE: VectorizeIndex;
  APPLIANCE_VECTORIZE: VectorizeIndex;

  // KV Namespace
  KV: KVNamespace;

  // R2 Buckets
  RECIPE_BUCKET: R2Bucket;
  APPLIANCE_BUCKET: R2Bucket;

  // Durable Objects
  CHEF_AGENT: DurableObjectNamespace;
  PLANNER_AGENT: DurableObjectNamespace;

  // Queues
  RECIPE_INGESTION_QUEUE: Queue<RecipeIngestionMessage>;

  // Environment Variables
  ENVIRONMENT?: string;
  LOG_LEVEL?: string;
  WORKER_API_KEY?: string;
}

// ============================================================================
// Queue Message Types
// ============================================================================

export interface RecipeIngestionMessage {
  type: 'url' | 'image' | 'manual';
  url?: string;
  imageData?: string; // Base64 encoded
  manualData?: {
    title: string;
    ingredients: string[];
    steps: string[];
  };
  userId?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Hono App Type
// ============================================================================

export type HonoEnv = {
  Bindings: Env;
  Variables: {
    prisma: PrismaClient;
    userId?: string;
  };
};
