/**
 * Cognitive Kitchen - Main Worker Entry Point
 *
 * A Cloudflare Workers application using:
 * - Hono with OpenAPI 3.1.0 support
 * - Prisma with D1 adapter for database
 * - Workers AI for reasoning and extraction
 * - Vectorize for semantic search
 * - Durable Objects for stateful agents
 * - Queues for async processing
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { stringify as yamlStringify } from 'yaml';
import type { HonoEnv, Env, QueueBatch, RecipeIngestionMessage } from './types';
import { getPrismaClient, parseJsonField, parseTags } from './lib/db';

// OpenAPI route definitions
import * as routes from './openapi/routes';

// Service imports
import {
  runHealthCheck as runHealthCheckService,
  getLatestHealthCheck,
  getHealthCheckHistory,
  cleanupOldHealthLogs,
} from './services/health';
import { processRecipeIngestionBatch } from './workflows/recipe-ingestion';
import { enqueueRecipeIngestion } from './workflows/recipe-ingestion';
import type { Ingredient, RecipeStep, RecipeDetail, RecipeSummary, UserPreferences } from './types/domain';

// Agent exports (for wrangler to find the Durable Objects)
export { ChefAgent } from './agents/ChefAgent';
export { PlannerAgent } from './agents/PlannerAgent';

// ============================================================================
// OpenAPI Application
// ============================================================================

const app = new OpenAPIHono<HonoEnv>();

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
app.use('/api/*', async (c, next) => {
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

// API Key authentication middleware
app.use('/api/*', async (c, next) => {
  // Skip auth for health endpoints and docs
  const path = c.req.path;
  if (path.startsWith('/api/health') || path === '/api') {
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
  c.set('userId', undefined);
  return next();
});

// ============================================================================
// Health Routes
// ============================================================================

app.openapi(routes.getHealthLatest, async (c) => {
  try {
    const latest = await getLatestHealthCheck(c.env);
    return c.json({
      success: true as const,
      data: latest,
      message: latest ? undefined : 'No health checks recorded yet',
    });
  } catch (error) {
    console.error('Failed to get latest health check:', error);
    return c.json({ success: false as const, error: 'Failed to retrieve health status' }, 500);
  }
});

app.openapi(routes.getHealthHistory, async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '24', 10);
    const history = await getHealthCheckHistory(c.env, limit);
    return c.json({
      success: true as const,
      data: history.map(h => ({
        ...h,
        timestamp: h.timestamp.toISOString(),
      })),
      meta: { count: history.length, limit },
    });
  } catch (error) {
    console.error('Failed to get health history:', error);
    return c.json({ success: false as const, error: 'Failed to retrieve health history' }, 500);
  }
});

app.openapi(routes.runHealthCheck, async (c) => {
  try {
    const startTime = Date.now();
    const result = await runHealthCheckService(c.env, 'manual');
    return c.json({
      success: true as const,
      data: {
        ...result,
        timestamp: result.timestamp.toISOString(),
      },
      meta: {
        timestamp: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
      },
    });
  } catch (error) {
    console.error('Health check failed:', error);
    return c.json({
      success: false as const,
      error: 'Health check failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

// ============================================================================
// Recipe Routes
// ============================================================================

app.openapi(routes.listRecipes, async (c) => {
  try {
    const prisma = getPrismaClient(c.env);
    const { q, tag, cuisine } = c.req.query();
    const limit = parseInt(c.req.query('limit') || '24', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    const where: Record<string, unknown> = {};
    if (q) {
      where.OR = [
        { title: { contains: q } },
        { tags: { contains: q } },
        { cuisine: { contains: q } },
        { description: { contains: q } },
      ];
    }
    if (tag) where.tags = { contains: tag };
    if (cuisine) where.cuisine = { contains: cuisine };

    const [recipeList, total] = await Promise.all([
      prisma.recipe.findMany({
        where,
        select: {
          id: true, title: true, description: true, cuisine: true,
          tags: true, heroImageUrl: true, prepTimeMinutes: true,
          cookTimeMinutes: true, totalTimeMinutes: true,
        },
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.recipe.count({ where }),
    ]);

    const items: RecipeSummary[] = recipeList.map(r => ({
      id: r.id,
      title: r.title,
      description: r.description,
      cuisine: r.cuisine,
      tags: parseTags(r.tags),
      heroImageUrl: r.heroImageUrl,
      prepTimeMinutes: r.prepTimeMinutes,
      cookTimeMinutes: r.cookTimeMinutes,
      totalTimeMinutes: r.totalTimeMinutes,
    }));

    return c.json({
      success: true as const,
      data: items,
      pagination: {
        page: Math.floor(offset / limit) + 1,
        pageSize: limit,
        total,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    console.error('Failed to list recipes:', error);
    return c.json({ success: false as const, error: 'Failed to list recipes' }, 500);
  }
});

app.openapi(routes.getRecipe, async (c) => {
  try {
    const { id } = c.req.param();
    const prisma = getPrismaClient(c.env);

    const recipe = await prisma.recipe.findUnique({
      where: { id },
      include: { ingredients: { orderBy: { sortOrder: 'asc' } } },
    });

    if (!recipe) {
      return c.json({ success: false as const, error: 'Recipe not found' }, 404);
    }

    const ingredientsFromJson = parseJsonField<Ingredient[]>(recipe.ingredientsJson, []);
    const steps = parseJsonField<RecipeStep[]>(recipe.stepsJson, []);
    const equipment = parseJsonField<string[]>(recipe.equipmentJson, []);
    const prepPhases = parseJsonField(recipe.prepPhasesJson, []);

    const ingredients: Ingredient[] = recipe.ingredients.length > 0
      ? recipe.ingredients.map(i => ({
          name: i.name,
          quantity: i.quantity ?? undefined,
          unit: i.unit ?? undefined,
          notes: i.notes ?? undefined,
        }))
      : ingredientsFromJson;

    const detail: RecipeDetail = {
      id: recipe.id,
      title: recipe.title,
      description: recipe.description,
      authorName: recipe.authorName,
      cuisine: recipe.cuisine,
      tags: parseTags(recipe.tags),
      heroImageUrl: recipe.heroImageUrl,
      yield: recipe.yield,
      prepTimeMinutes: recipe.prepTimeMinutes,
      cookTimeMinutes: recipe.cookTimeMinutes,
      totalTimeMinutes: recipe.totalTimeMinutes,
      ingredients,
      steps,
      prepPhases,
      equipment,
      notes: recipe.notes,
      sourceUrl: recipe.sourceUrl,
      createdAt: recipe.createdAt,
      updatedAt: recipe.updatedAt,
    };

    return c.json({
      success: true as const,
      data: {
        ...detail,
        createdAt: detail.createdAt.toISOString(),
        updatedAt: detail.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('Failed to get recipe:', error);
    return c.json({ success: false as const, error: 'Failed to get recipe' }, 500);
  }
});

app.openapi(routes.createRecipe, async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false as const, error: 'Authentication required' }, 401);
    }

    const body = c.req.valid('json');

    await enqueueRecipeIngestion(c.env, {
      type: 'manual',
      userId,
      manualData: {
        title: body.title,
        ingredients: body.ingredients.map(i => i.name),
        steps: body.steps.map(s => s.instruction),
      },
      metadata: {
        description: body.description,
        cuisine: body.cuisine,
        tags: body.tags,
        yield: body.yield,
        prepTimeMinutes: body.prepTimeMinutes,
        cookTimeMinutes: body.cookTimeMinutes,
        equipment: body.equipment,
        notes: body.notes,
        fullIngredients: body.ingredients,
        fullSteps: body.steps,
      },
    });

    return c.json({ success: true as const, message: 'Recipe queued for processing' }, 202);
  } catch (error) {
    console.error('Failed to create recipe:', error);
    return c.json({ success: false as const, error: 'Failed to create recipe' }, 500);
  }
});

app.openapi(routes.ingestRecipeUrl, async (c) => {
  try {
    const { url } = c.req.valid('json');

    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return c.json({ success: false as const, error: 'Invalid URL protocol' }, 400);
      }
    } catch {
      return c.json({ success: false as const, error: 'Invalid URL format' }, 400);
    }

    const prisma = getPrismaClient(c.env);
    const existing = await prisma.recipe.findFirst({
      where: { sourceUrl: url },
      select: { id: true },
    });

    if (existing) {
      return c.json({
        success: true as const,
        message: 'Recipe already exists',
        data: { recipeId: existing.id },
      });
    }

    await enqueueRecipeIngestion(c.env, {
      type: 'url',
      url,
      userId: c.get('userId'),
    });

    return c.json({ success: true as const, message: 'URL queued for ingestion' }, 202);
  } catch (error) {
    console.error('Failed to queue URL:', error);
    return c.json({ success: false as const, error: 'Failed to queue URL' }, 500);
  }
});

// ============================================================================
// Chef Agent Routes
// ============================================================================

app.openapi(routes.chatWithChef, async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false as const, error: 'Authentication required' }, 401);
    }

    const { message } = c.req.valid('json');

    const prisma = getPrismaClient(c.env);
    const prefs = await prisma.userPreference.findUnique({ where: { userId } });

    const preferences: UserPreferences | undefined = prefs ? {
      userId,
      cuisines: parseJsonField<string[]>(prefs.cuisines, []),
      dislikedIngredients: parseJsonField<string[]>(prefs.dislikedIngredients, []),
      favoredTools: parseJsonField<string[]>(prefs.favoredTools, []),
      dietaryRestrictions: parseJsonField<string[]>(prefs.dietaryRestrictions, []),
      allergies: parseJsonField<string[]>(prefs.allergies, []),
      skillLevel: prefs.skillLevel ?? undefined,
      defaultServings: prefs.defaultServings ?? undefined,
      notes: prefs.notes,
    } : undefined;

    const agentId = c.env.CHEF_AGENT.idFromName(userId);
    const agent = c.env.CHEF_AGENT.get(agentId);

    const response = await agent.fetch(
      new Request('http://internal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, userId, preferences }),
      })
    );

    if (!response.ok) {
      const error = await response.json() as { error?: string };
      return c.json({ success: false as const, error: error.error || 'Agent error' }, 500);
    }

    const result = await response.json() as { response: string; conversationId: string };
    return c.json({ success: true as const, data: result });
  } catch (error) {
    console.error('ChefAgent chat error:', error);
    return c.json({ success: false as const, error: 'Failed to process message' }, 500);
  }
});

app.openapi(routes.getChefHistory, async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false as const, error: 'Authentication required' }, 401);
    }

    const agentId = c.env.CHEF_AGENT.idFromName(userId);
    const agent = c.env.CHEF_AGENT.get(agentId);

    const response = await agent.fetch(
      new Request(`http://internal/history?userId=${userId}`, { method: 'GET' })
    );

    if (!response.ok) {
      return c.json({ success: false as const, error: 'Failed to get history' }, 500);
    }

    const result = await response.json() as { history: unknown[] };
    return c.json({ success: true as const, data: result });
  } catch (error) {
    console.error('ChefAgent history error:', error);
    return c.json({ success: false as const, error: 'Failed to get history' }, 500);
  }
});

app.openapi(routes.clearChefHistory, async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false as const, error: 'Authentication required' }, 401);
    }

    const agentId = c.env.CHEF_AGENT.idFromName(userId);
    const agent = c.env.CHEF_AGENT.get(agentId);

    const response = await agent.fetch(
      new Request(`http://internal/history?userId=${userId}`, { method: 'DELETE' })
    );

    if (!response.ok) {
      return c.json({ success: false as const, error: 'Failed to clear history' }, 500);
    }

    return c.json({ success: true as const, message: 'History cleared' });
  } catch (error) {
    console.error('ChefAgent clear history error:', error);
    return c.json({ success: false as const, error: 'Failed to clear history' }, 500);
  }
});

// ============================================================================
// Planner Agent Routes
// ============================================================================

app.openapi(routes.generateMenuPlan, async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false as const, error: 'Authentication required' }, 401);
    }

    const body = c.req.valid('json');

    const agentId = c.env.PLANNER_AGENT.idFromName(userId);
    const agent = c.env.PLANNER_AGENT.get(agentId);

    const response = await agent.fetch(
      new Request('http://internal/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          theme: body.theme,
          excludeRecipeIds: body.excludeRecipeIds,
          weekStartDate: body.weekStartDate,
        }),
      })
    );

    if (!response.ok) {
      const error = await response.json() as { error?: string };
      return c.json({ success: false as const, error: error.error || 'Agent error' }, 500);
    }

    const result = await response.json() as { menuId: string; plan: unknown };
    return c.json({ success: true as const, data: result });
  } catch (error) {
    console.error('PlannerAgent generate error:', error);
    return c.json({ success: false as const, error: 'Failed to generate menu plan' }, 500);
  }
});

app.openapi(routes.getPlannerStatus, async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false as const, error: 'Authentication required' }, 401);
    }

    const agentId = c.env.PLANNER_AGENT.idFromName(userId);
    const agent = c.env.PLANNER_AGENT.get(agentId);

    const response = await agent.fetch(
      new Request(`http://internal/status?userId=${userId}`, { method: 'GET' })
    );

    if (!response.ok) {
      return c.json({ success: false as const, error: 'Failed to get status' }, 500);
    }

    const result = await response.json();
    return c.json({ success: true as const, data: result });
  } catch (error) {
    console.error('PlannerAgent status error:', error);
    return c.json({ success: false as const, error: 'Failed to get status' }, 500);
  }
});

app.openapi(routes.updatePlannerConfig, async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false as const, error: 'Authentication required' }, 401);
    }

    const body = c.req.valid('json');

    const agentId = c.env.PLANNER_AGENT.idFromName(userId);
    const agent = c.env.PLANNER_AGENT.get(agentId);

    const response = await agent.fetch(
      new Request('http://internal/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, config: body.config }),
      })
    );

    if (!response.ok) {
      return c.json({ success: false as const, error: 'Failed to update config' }, 500);
    }

    return c.json({ success: true as const, message: 'Configuration updated' });
  } catch (error) {
    console.error('PlannerAgent config error:', error);
    return c.json({ success: false as const, error: 'Failed to update config' }, 500);
  }
});

// ============================================================================
// OpenAPI Documentation
// ============================================================================

// Register OpenAPI spec
app.doc31('/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'Cognitive Kitchen API',
    version: '1.0.0',
    description: `AI-powered recipe and menu management API.

## Features
- **Recipe Management**: Create, list, and search recipes
- **AI Recipe Ingestion**: Extract recipes from URLs using AI
- **Chef Assistant**: Chat with an AI chef for cooking help
- **Menu Planner**: Generate weekly menu plans automatically

## Authentication
Most endpoints require authentication via Bearer token or API key.
- \`Authorization: Bearer <session-token>\`
- \`X-API-Key: <api-key>\`

For testing, you can also use the \`user_id\` query parameter.`,
    contact: {
      name: 'Cognitive Kitchen API',
    },
    license: {
      name: 'MIT',
    },
  },
  servers: [
    {
      url: 'https://cognitive-kitchen-backend.workers.dev',
      description: 'Production',
    },
    {
      url: 'http://localhost:8787',
      description: 'Local Development',
    },
  ],
  tags: [
    { name: 'Health', description: 'Service health monitoring' },
    { name: 'Recipes', description: 'Recipe management and search' },
    { name: 'Chef Agent', description: 'AI Chef assistant for cooking help' },
    { name: 'Planner Agent', description: 'AI-powered menu planning' },
  ],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Session token authentication',
      },
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'API key authentication',
      },
    },
  },
});

// Serve OpenAPI YAML
app.get('/openapi.yaml', async (c) => {
  const spec = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'Cognitive Kitchen API',
      version: '1.0.0',
      description: 'AI-powered recipe and menu management API.',
    },
  });
  const yaml = yamlStringify(spec);
  return new Response(yaml, {
    headers: { 'Content-Type': 'text/yaml' },
  });
});

// Swagger UI
app.get('/docs', swaggerUI({ url: '/openapi.json' }));

// API info endpoint
app.get('/api', (c) => {
  return c.json({
    name: 'Cognitive Kitchen API',
    version: '1.0.0',
    documentation: {
      swagger: '/docs',
      openapi_json: '/openapi.json',
      openapi_yaml: '/openapi.yaml',
    },
    endpoints: {
      health: '/api/health',
      recipes: '/api/recipes',
      agents: '/api/agents',
    },
  });
});

// Serve static assets (including frontend)
app.get('/*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// ============================================================================
// Worker Handlers
// ============================================================================

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

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
            await runHealthCheckService(env, 'scheduled');
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
            const prisma = getPrismaClient(env);
            const enabledAgents = await prisma.userAgent.findMany({
              where: { agentType: 'planner', isEnabled: true },
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
      batch.retryAll({ delaySeconds: 60 });
    }
  },
};
