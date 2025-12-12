/**
 * Health Monitor Service
 *
 * Checks the health status of D1, Vectorize, and AI services.
 * Can be triggered via:
 * - Cron (scheduled every hour)
 * - On-demand API endpoint (POST /api/health/run)
 */

import { getPrismaClient } from '../lib/db';
import type { Env } from '../types';
import type { HealthStatus, ServiceHealth, HealthCheckResult } from '../types/domain';

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';

/**
 * Run a complete health check on all services
 */
export async function runHealthCheck(
  env: Env,
  triggeredBy: 'scheduled' | 'manual' = 'manual'
): Promise<HealthCheckResult> {
  const startTime = Date.now();

  // Run all health checks in parallel
  const [d1Health, vectorizeHealth, aiHealth, kvHealth] = await Promise.all([
    checkD1Health(env),
    checkVectorizeHealth(env),
    checkAiHealth(env),
    checkKvHealth(env),
  ]);

  const latencyMs = Date.now() - startTime;

  // Determine overall status
  const allServices = [d1Health, vectorizeHealth, aiHealth, kvHealth];
  const overallStatus: HealthStatus = allServices.every(s => s.status === 'OK')
    ? 'OK'
    : 'ERROR';

  const result: HealthCheckResult = {
    status: overallStatus,
    timestamp: new Date(),
    latencyMs,
    triggeredBy,
    services: {
      d1: d1Health,
      vectorize: vectorizeHealth,
      ai: aiHealth,
      kv: kvHealth,
    },
  };

  // Store the health check result in D1 via Prisma
  await saveHealthCheckLog(env, result);

  return result;
}

/**
 * Get the latest health check result
 */
export async function getLatestHealthCheck(env: Env): Promise<HealthCheckResult | null> {
  const prisma = getPrismaClient(env);

  const latest = await prisma.healthCheckLog.findFirst({
    orderBy: { timestamp: 'desc' },
  });

  if (!latest) {
    return null;
  }

  const services = JSON.parse(latest.services) as HealthCheckResult['services'];
  const details = latest.details ? JSON.parse(latest.details) : undefined;

  return {
    status: latest.status as HealthStatus,
    timestamp: latest.timestamp,
    latencyMs: latest.latencyMs,
    triggeredBy: latest.triggeredBy as 'scheduled' | 'manual',
    services,
    ...details,
  };
}

/**
 * Get health check history
 */
export async function getHealthCheckHistory(
  env: Env,
  limit: number = 24
): Promise<HealthCheckResult[]> {
  const prisma = getPrismaClient(env);

  const logs = await prisma.healthCheckLog.findMany({
    orderBy: { timestamp: 'desc' },
    take: limit,
  });

  return logs.map(log => ({
    status: log.status as HealthStatus,
    timestamp: log.timestamp,
    latencyMs: log.latencyMs,
    triggeredBy: log.triggeredBy as 'scheduled' | 'manual',
    services: JSON.parse(log.services) as HealthCheckResult['services'],
  }));
}

// ============================================================================
// Individual Service Health Checks
// ============================================================================

/**
 * Check D1 database health
 */
async function checkD1Health(env: Env): Promise<ServiceHealth> {
  const startTime = Date.now();

  try {
    const prisma = getPrismaClient(env);

    // Simple query to verify database connectivity
    await prisma.$queryRaw`SELECT 1`;

    return {
      name: 'D1 Database',
      status: 'OK',
      latencyMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      name: 'D1 Database',
      status: 'ERROR',
      latencyMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check Vectorize health
 */
async function checkVectorizeHealth(env: Env): Promise<ServiceHealth> {
  const startTime = Date.now();

  try {
    // Query with a dummy vector to verify Vectorize connectivity
    const dummyVector = new Array(768).fill(0);
    await env.RECIPE_VECTORIZE.query({
      vector: dummyVector,
      topK: 1,
    });

    return {
      name: 'Vectorize',
      status: 'OK',
      latencyMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      name: 'Vectorize',
      status: 'ERROR',
      latencyMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check AI service health
 */
async function checkAiHealth(env: Env): Promise<ServiceHealth> {
  const startTime = Date.now();

  try {
    // Generate a simple embedding to verify AI connectivity
    await env.AI.run(EMBEDDING_MODEL, {
      text: ['health check'],
    });

    return {
      name: 'Workers AI',
      status: 'OK',
      latencyMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      name: 'Workers AI',
      status: 'ERROR',
      latencyMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check KV health
 */
async function checkKvHealth(env: Env): Promise<ServiceHealth> {
  const startTime = Date.now();

  try {
    const testKey = `health-check-${Date.now()}`;
    const testValue = 'ok';

    // Write and read test
    await env.KV.put(testKey, testValue, { expirationTtl: 60 });
    const result = await env.KV.get(testKey);
    await env.KV.delete(testKey);

    if (result !== testValue) {
      throw new Error('KV read/write mismatch');
    }

    return {
      name: 'KV Store',
      status: 'OK',
      latencyMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      name: 'KV Store',
      status: 'ERROR',
      latencyMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Storage
// ============================================================================

/**
 * Save health check result to database
 */
async function saveHealthCheckLog(env: Env, result: HealthCheckResult): Promise<void> {
  const prisma = getPrismaClient(env);

  await prisma.healthCheckLog.create({
    data: {
      timestamp: result.timestamp,
      status: result.status,
      services: JSON.stringify(result.services),
      latencyMs: result.latencyMs,
      triggeredBy: result.triggeredBy,
      details: null,
    },
  });
}

/**
 * Clean up old health check logs (keep last 7 days)
 */
export async function cleanupOldHealthLogs(env: Env): Promise<number> {
  const prisma = getPrismaClient(env);

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 7);

  const result = await prisma.healthCheckLog.deleteMany({
    where: {
      timestamp: {
        lt: cutoffDate,
      },
    },
  });

  return result.count;
}
