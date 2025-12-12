/**
 * Prisma Database Client for Cloudflare D1
 * Uses @prisma/adapter-d1 for D1 compatibility
 */

import { PrismaClient } from '@prisma/client';
import { PrismaD1 } from '@prisma/adapter-d1';
import type { Env } from '../types';

// Cache for Prisma client instances per request
const clientCache = new WeakMap<D1Database, PrismaClient>();

/**
 * Get or create a Prisma client for the given D1 database binding
 * Uses a WeakMap cache to reuse clients within the same request context
 */
export function getPrismaClient(env: Env): PrismaClient {
  const cached = clientCache.get(env.DB);
  if (cached) {
    return cached;
  }

  const adapter = new PrismaD1(env.DB);
  const prisma = new PrismaClient({ adapter });

  clientCache.set(env.DB, prisma);
  return prisma;
}

/**
 * Execute a database operation with automatic client management
 */
export async function withPrisma<T>(
  env: Env,
  operation: (prisma: PrismaClient) => Promise<T>
): Promise<T> {
  const prisma = getPrismaClient(env);
  return operation(prisma);
}

/**
 * Helper to parse JSON fields from database records
 */
export function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Helper to stringify values for JSON fields
 */
export function stringifyJsonField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

/**
 * Helper to parse comma-separated tags into array
 */
export function parseTags(tags: string | null | undefined): string[] {
  if (!tags) return [];
  return tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Helper to join array into comma-separated tags
 */
export function joinTags(tags: string[] | null | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  return tags.join(',');
}
