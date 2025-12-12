/**
 * Cognitive Kitchen - Main Worker Entry Point
 *
 * A Cloudflare Workers application using:
 * - Hono for HTTP routing
 * - Prisma with D1 adapter for database
 * - Workers AI for reasoning and extraction
 * - Vectorize for semantic search
 * - Durable Objects for stateful agents
 * - Queues for async processing
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { HonoEnv, Env, QueueBatch, RecipeIngestionMessage } from './types';
import { getPrismaClient } from './lib/db';

// Route imports
import { health } from './routes/health';
import { recipes } from './routes/recipes';
import { agents } from './routes/agents';

// Service imports
import { runHealthCheck, cleanupOldHealthLogs } from './services/health';
import { processRecipeIngestionBatch } from './workflows/recipe-ingestion';

// Agent exports (for wrangler to find the Durable Objects)
export { ChefAgent } from './agents/ChefAgent';
export { PlannerAgent } from './agents/PlannerAgent';

// ============================================================================
// Main Application
// ============================================================================

const app = new Hono<HonoEnv>();

// ============================================================================
// Middleware
// ============================================================================

// CORS configuration
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  exposeHeaders: ['X-Request-Id'],
  maxAge: 86400,
}));

// Logger middleware
app.use('*', logger());

// Request timing and logging middleware
app.use('*', async (c, next) => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();
  c.header('X-Request-Id', requestId);

  await next();

  const duration = Date.now() - startTime;
  const logLevel = c.res.status >= 400 ? 'error' : 'info';

  // Log to D1 asynchronously
  try {
    const prisma = getPrismaClient(c.env);
    c.executionCtx.waitUntil(
      prisma.requestLog.create({
        data: {
          ts: new Date().toISOString(),
          level: logLevel,
          route: new URL(c.req.url).pathname,
          method: c.req.method,
          status: c.res.status,
          ms: duration,
          msg: c.res.status >= 400 ? 'error' : 'ok',
          meta: JSON.stringify({ requestId }),
        },
      })
    );
  } catch (error) {
    console.error('Failed to log request:', error);
  }
});

// API Key authentication middleware (optional - check for protected routes)
app.use('/api/*', async (c, next) => {
  // Skip auth for health endpoints
  if (c.req.path.startsWith('/api/health')) {
    return next();
  }

  // Check for API key or Bearer token
  const apiKey = c.req.header('X-API-Key');
  const authHeader = c.req.header('Authorization');

  // API Key authentication
  if (apiKey && c.env.WORKER_API_KEY && apiKey === c.env.WORKER_API_KEY) {
    return next();
  }

  // Bearer token authentication (session-based)
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      try {
        const session = await c.env.KV.get(`kv:sess:${token}`, 'json') as {
          user_id: string;
          expires: number;
        } | null;

        if (session && session.user_id && session.expires > Date.now()) {
          c.set('userId', session.user_id);
          return next();
        }
      } catch (error) {
        console.warn('Session validation failed:', error);
      }
    }
  }

  // Check query param for user_id (development/testing ONLY)
  if (c.env.ENVIRONMENT !== 'production') {
    const queryUserId = c.req.query('user_id');
    if (queryUserId) {
      c.set('userId', queryUserId);
      return next();
    }
  }

  // Allow unauthenticated access for public endpoints
  // Set anonymous user ID
  c.set('userId', undefined);
  return next();
});

// Prisma client middleware
app.use('*', async (c, next) => {
  c.set('prisma', getPrismaClient(c.env));
  return next();
});

// ============================================================================
// Route Mounting
// ============================================================================

// Health routes
app.route('/api/health', health);

// Recipe routes
app.route('/api/recipes', recipes);

// Agent routes
app.route('/api/agents', agents);

// ============================================================================
// Root and Static Assets
// ============================================================================

// API info endpoint
app.get('/api', (c) => {
  return c.json({
    name: 'Cognitive Kitchen API',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      recipes: '/api/recipes',
      agents: '/api/agents',
    },
  });
});

// Serve static assets
app.get('/*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// ============================================================================
// Worker Handlers
// ============================================================================

export default {
  /**
   * Main fetch handler
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  /**
   * Scheduled event handler (Cron triggers)
   */
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const cronTime = new Date(event.scheduledTime);
    const hour = cronTime.getUTCHours();
    const day = cronTime.getUTCDay();

    console.log(`Scheduled job triggered: ${event.cron} at ${cronTime.toISOString()}`);

    // Health check - every hour (0 * * * *)
    if (event.cron === '0 * * * *') {
      ctx.waitUntil(
        (async () => {
          try {
            await runHealthCheck(env, 'scheduled');
            await cleanupOldHealthLogs(env);
            console.log('Scheduled health check completed');
          } catch (error) {
            console.error('Scheduled health check failed:', error);
          }
        })()
      );
    }

    // Planner Agent - Sunday 8 AM UTC (0 8 * * 0)
    if (event.cron === '0 8 * * 0' && day === 0 && hour === 8) {
      ctx.waitUntil(
        (async () => {
          try {
            // Get all users with planner agent enabled
            const prisma = getPrismaClient(env);
            const enabledAgents = await prisma.userAgent.findMany({
              where: {
                agentType: 'planner',
                isEnabled: true,
              },
              select: { userId: true },
            });

            console.log(`Running scheduled planner for ${enabledAgents.length} users`);

            for (const agent of enabledAgents) {
              try {
                const agentId = env.PLANNER_AGENT.idFromName(agent.userId);
                const plannerAgent = env.PLANNER_AGENT.get(agentId);

                await plannerAgent.fetch(
                  new Request('http://internal/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: agent.userId }),
                  })
                );

                console.log(`Generated menu for user: ${agent.userId}`);
              } catch (error) {
                console.error(`Planner failed for user ${agent.userId}:`, error);
              }
            }
          } catch (error) {
            console.error('Scheduled planner job failed:', error);
          }
        })()
      );
    }

    // Recipe crawl - daily at 3 AM UTC (0 3 * * *)
    if (event.cron === '0 3 * * *' && hour === 3) {
      ctx.waitUntil(
        (async () => {
          try {
            console.log('Running scheduled recipe crawl job');

            // Get seeds from KV
            const seeds = await env.KV.get('source-seeds', 'json') as string[] || [
              'https://www.seriouseats.com/',
              'https://www.budgetbytes.com/',
            ];

            // Queue a sample of URLs for ingestion
            const prisma = getPrismaClient(env);
            const queuedCount = await prisma.crawlQueue.count({
              where: { status: 'queued' },
            });

            console.log(`Current queue size: ${queuedCount}`);
          } catch (error) {
            console.error('Recipe crawl job failed:', error);
          }
        })()
      );
    }
  },

  /**
   * Queue consumer handler
   */
  async queue(
    batch: QueueBatch<RecipeIngestionMessage>,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    console.log(`Processing queue batch: ${batch.messages.length} messages`);

    try {
      await processRecipeIngestionBatch(batch, env);
    } catch (error) {
      console.error('Queue processing failed:', error);
      // Retry all messages
      batch.retryAll({ delaySeconds: 60 });
    }
  },
};
