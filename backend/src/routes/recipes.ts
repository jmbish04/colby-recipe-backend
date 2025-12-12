/**
 * Recipe API Routes
 *
 * Endpoints:
 * - GET /api/recipes - List recipes
 * - GET /api/recipes/:id - Get recipe detail
 * - POST /api/recipes - Create a manual recipe
 * - POST /api/recipes/ingest - Queue a URL for ingestion
 */

import { Hono } from 'hono';
import type { HonoEnv } from '../types';
import { getPrismaClient, parseJsonField, parseTags } from '../lib/db';
import { enqueueRecipeIngestion } from '../workflows/recipe-ingestion';
import type { Ingredient, RecipeStep, RecipeDetail, RecipeSummary } from '../types/domain';

const recipes = new Hono<HonoEnv>();

/**
 * GET /api/recipes
 * List recipes with optional filtering
 */
recipes.get('/', async (c) => {
  try {
    const prisma = getPrismaClient(c.env);

    const q = c.req.query('q');
    const tag = c.req.query('tag');
    const cuisine = c.req.query('cuisine');
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

    if (tag) {
      where.tags = { contains: tag };
    }

    if (cuisine) {
      where.cuisine = { contains: cuisine };
    }

    const [recipeList, total] = await Promise.all([
      prisma.recipe.findMany({
        where,
        select: {
          id: true,
          title: true,
          description: true,
          cuisine: true,
          tags: true,
          heroImageUrl: true,
          prepTimeMinutes: true,
          cookTimeMinutes: true,
          totalTimeMinutes: true,
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
      success: true,
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
    return c.json({ success: false, error: 'Failed to list recipes' }, 500);
  }
});

/**
 * GET /api/recipes/:id
 * Get recipe detail by ID
 */
recipes.get('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const prisma = getPrismaClient(c.env);

    const recipe = await prisma.recipe.findUnique({
      where: { id },
      include: {
        ingredients: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!recipe) {
      return c.json({ success: false, error: 'Recipe not found' }, 404);
    }

    // Parse JSON fields
    const ingredientsFromJson = parseJsonField<Ingredient[]>(recipe.ingredientsJson, []);
    const steps = parseJsonField<RecipeStep[]>(recipe.stepsJson, []);
    const equipment = parseJsonField<string[]>(recipe.equipmentJson, []);
    const prepPhases = parseJsonField(recipe.prepPhasesJson, []);

    // Prefer ingredients from relation, fallback to JSON
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

    return c.json({ success: true, data: detail });
  } catch (error) {
    console.error('Failed to get recipe:', error);
    return c.json({ success: false, error: 'Failed to get recipe' }, 500);
  }
});

/**
 * POST /api/recipes
 * Create a manual recipe
 */
recipes.post('/', async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false, error: 'Authentication required' }, 401);
    }

    const body = await c.req.json<{
      title: string;
      description?: string;
      cuisine?: string;
      tags?: string[];
      yield?: string;
      prepTimeMinutes?: number;
      cookTimeMinutes?: number;
      ingredients: Array<{ name: string; quantity?: string; unit?: string; notes?: string }>;
      steps: Array<{ instruction: string; title?: string }>;
      equipment?: string[];
      notes?: string;
    }>();

    if (!body.title?.trim()) {
      return c.json({ success: false, error: 'Title is required' }, 400);
    }

    if (!body.ingredients?.length) {
      return c.json({ success: false, error: 'At least one ingredient is required' }, 400);
    }

    if (!body.steps?.length) {
      return c.json({ success: false, error: 'At least one step is required' }, 400);
    }

    // Enqueue for async processing (handles embedding generation)
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

    return c.json({
      success: true,
      message: 'Recipe queued for processing',
    }, 202);
  } catch (error) {
    console.error('Failed to create recipe:', error);
    return c.json({ success: false, error: 'Failed to create recipe' }, 500);
  }
});

/**
 * POST /api/recipes/ingest
 * Queue a URL for recipe ingestion
 */
recipes.post('/ingest', async (c) => {
  try {
    const body = await c.req.json<{ url?: string }>();
    const url = body.url?.trim();

    if (!url) {
      return c.json({ success: false, error: 'URL is required' }, 400);
    }

    // Validate URL
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return c.json({ success: false, error: 'Invalid URL protocol' }, 400);
      }
    } catch {
      return c.json({ success: false, error: 'Invalid URL format' }, 400);
    }

    // Check if already exists
    const prisma = getPrismaClient(c.env);
    const existing = await prisma.recipe.findFirst({
      where: { sourceUrl: url },
      select: { id: true },
    });

    if (existing) {
      return c.json({
        success: true,
        data: { recipeId: existing.id },
        message: 'Recipe already exists',
      });
    }

    // Enqueue for processing
    await enqueueRecipeIngestion(c.env, {
      type: 'url',
      url,
      userId: c.get('userId'),
    });

    return c.json({
      success: true,
      message: 'URL queued for ingestion',
    }, 202);
  } catch (error) {
    console.error('Failed to queue URL:', error);
    return c.json({ success: false, error: 'Failed to queue URL' }, 500);
  }
});

export { recipes };
