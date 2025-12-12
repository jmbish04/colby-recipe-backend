/**
 * Recipe Ingestion Workflow
 *
 * Queue consumer that processes recipe ingestion jobs:
 * 1. URL: Scrapes HTML -> Extracts recipe -> Saves to DB -> Generates embedding
 * 2. Image: OCR -> Extracts recipe -> Saves to DB -> Generates embedding
 * 3. Manual: Validates -> Saves to DB -> Generates embedding
 *
 * Uses the "Deep Thought" AI Pipeline for extraction.
 */

import type { Env, QueueBatch, RecipeIngestionMessage } from '../types';
import type { Ingredient, RecipeStep } from '../types/domain';
import { getPrismaClient, stringifyJsonField } from '../lib/db';
import {
  extractRecipe,
  extractTextFromImage,
  generateEmbedding,
} from '../services/ai-pipeline';

interface IngestionResult {
  success: boolean;
  recipeId?: string;
  error?: string;
}

/**
 * Process a batch of recipe ingestion messages
 */
export async function processRecipeIngestionBatch(
  batch: QueueBatch<RecipeIngestionMessage>,
  env: Env
): Promise<void> {
  const results: IngestionResult[] = [];

  for (const message of batch.messages) {
    try {
      const result = await processIngestionMessage(message.body, env);
      results.push(result);

      if (result.success) {
        message.ack();
      } else {
        // Retry on failure
        message.retry({ delaySeconds: 60 });
      }
    } catch (error) {
      console.error('Ingestion error:', error);
      results.push({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      message.retry({ delaySeconds: 120 });
    }
  }

  console.log(`Processed ${results.length} ingestion jobs:`, {
    success: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
  });
}

/**
 * Process a single ingestion message
 */
async function processIngestionMessage(
  message: RecipeIngestionMessage,
  env: Env
): Promise<IngestionResult> {
  switch (message.type) {
    case 'url':
      return processUrlIngestion(message, env);
    case 'image':
      return processImageIngestion(message, env);
    case 'manual':
      return processManualIngestion(message, env);
    default:
      return { success: false, error: `Unknown ingestion type: ${message.type}` };
  }
}

/**
 * Process URL-based recipe ingestion
 */
async function processUrlIngestion(
  message: RecipeIngestionMessage,
  env: Env
): Promise<IngestionResult> {
  if (!message.url) {
    return { success: false, error: 'URL is required for url ingestion' };
  }

  const prisma = getPrismaClient(env);

  // Check if URL already exists
  const existing = await prisma.recipe.findFirst({
    where: { sourceUrl: message.url },
  });

  if (existing) {
    return { success: true, recipeId: existing.id };
  }

  // Scrape the URL using Browser Rendering
  let html: string;
  try {
    const session = await env.BROWSER.newSession({});
    const page = await session.newPage();

    try {
      await page.goto(message.url, {
        waitUntil: 'networkidle',
        timeout: 20000,
      });
      html = await page.content();
    } finally {
      await page.close();
      await session.close();
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to scrape URL: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }

  // Extract recipe using AI Pipeline
  const extracted = await extractRecipe(env, html, message.url);

  // Save to database
  const recipe = await saveRecipe(env, {
    ...extracted,
    sourceUrl: message.url,
    sourceDomain: new URL(message.url).hostname,
  });

  // Generate and save embedding
  await saveRecipeEmbedding(env, recipe.id, extracted);

  // Log ingestion
  await logIngestion(env, {
    sourceType: 'url',
    sourceRef: message.url,
    raw: html.slice(0, 50000),
    recipeId: recipe.id,
  });

  return { success: true, recipeId: recipe.id };
}

/**
 * Process image-based recipe ingestion
 */
async function processImageIngestion(
  message: RecipeIngestionMessage,
  env: Env
): Promise<IngestionResult> {
  if (!message.imageData) {
    return { success: false, error: 'Image data is required for image ingestion' };
  }

  // Decode base64 image
  const imageBytes = Uint8Array.from(atob(message.imageData), c => c.charCodeAt(0));

  // Extract text from image using Vision model
  const ocrText = await extractTextFromImage(env, imageBytes);

  if (!ocrText.trim()) {
    return { success: false, error: 'No text extracted from image' };
  }

  // Extract recipe using AI Pipeline
  const extracted = await extractRecipe(env, ocrText);

  // Save to database
  const recipe = await saveRecipe(env, {
    ...extracted,
    sourceUrl: `image://${Date.now()}`,
  });

  // Generate and save embedding
  await saveRecipeEmbedding(env, recipe.id, extracted);

  // Log ingestion
  await logIngestion(env, {
    sourceType: 'image',
    sourceRef: `image-${Date.now()}`,
    raw: ocrText,
    recipeId: recipe.id,
  });

  return { success: true, recipeId: recipe.id };
}

/**
 * Process manually entered recipe
 */
async function processManualIngestion(
  message: RecipeIngestionMessage,
  env: Env
): Promise<IngestionResult> {
  if (!message.manualData) {
    return { success: false, error: 'Manual data is required for manual ingestion' };
  }

  const { title, ingredients, steps } = message.manualData;

  if (!title || !ingredients.length || !steps.length) {
    return { success: false, error: 'Title, ingredients, and steps are required' };
  }

  // Convert to structured format
  const extracted = {
    title,
    ingredients: ingredients.map(name => ({ name })),
    steps: steps.map(instruction => ({ instruction })),
  };

  // Save to database
  const sourceUrl = message.userId
    ? `manual://${message.userId}/${Date.now()}`
    : `manual://anonymous/${Date.now()}`;

  const recipe = await saveRecipe(env, {
    ...extracted,
    sourceUrl,
    creatorId: message.userId,
  });

  // Generate and save embedding
  await saveRecipeEmbedding(env, recipe.id, extracted);

  // Log ingestion
  await logIngestion(env, {
    sourceType: 'manual',
    sourceRef: sourceUrl,
    raw: JSON.stringify(message.manualData),
    recipeId: recipe.id,
  });

  return { success: true, recipeId: recipe.id };
}

// ============================================================================
// Helper Functions
// ============================================================================

interface SaveRecipeData {
  title: string;
  description?: string;
  authorName?: string;
  cuisine?: string;
  tags?: string[];
  heroImageUrl?: string;
  yield?: string;
  prepTimeMinutes?: number;
  cookTimeMinutes?: number;
  totalTimeMinutes?: number;
  ingredients: Ingredient[];
  steps: RecipeStep[];
  equipment?: string[];
  notes?: string;
  sourceUrl?: string;
  sourceDomain?: string;
  creatorId?: string;
}

/**
 * Save recipe to database
 */
async function saveRecipe(
  env: Env,
  data: SaveRecipeData
): Promise<{ id: string }> {
  const prisma = getPrismaClient(env);

  const recipe = await prisma.recipe.create({
    data: {
      title: data.title,
      description: data.description,
      authorName: data.authorName,
      cuisine: data.cuisine,
      tags: data.tags?.join(','),
      heroImageUrl: data.heroImageUrl,
      yield: data.yield,
      prepTimeMinutes: data.prepTimeMinutes,
      cookTimeMinutes: data.cookTimeMinutes,
      totalTimeMinutes: data.totalTimeMinutes,
      ingredientsJson: stringifyJsonField(data.ingredients),
      stepsJson: stringifyJsonField(data.steps),
      equipmentJson: stringifyJsonField(data.equipment),
      notes: data.notes,
      sourceUrl: data.sourceUrl,
      sourceDomain: data.sourceDomain,
      creatorId: data.creatorId,
    },
    select: { id: true },
  });

  // Also save individual ingredients
  if (data.ingredients.length > 0) {
    await prisma.ingredient.createMany({
      data: data.ingredients.map((ing, index) => ({
        recipeId: recipe.id,
        name: ing.name,
        quantity: ing.quantity,
        unit: ing.unit,
        notes: ing.notes,
        sortOrder: index,
      })),
    });
  }

  return recipe;
}

/**
 * Generate and save recipe embedding to Vectorize
 */
async function saveRecipeEmbedding(
  env: Env,
  recipeId: string,
  data: {
    title: string;
    ingredients: Ingredient[];
    cuisine?: string;
    tags?: string[];
  }
): Promise<void> {
  // Create embedding text from recipe components
  const embeddingParts = [
    data.title,
    data.ingredients.map(i => i.name).join(', '),
    data.cuisine,
    data.tags?.join(', '),
  ].filter(Boolean);

  const embeddingText = embeddingParts.join('\n');
  const embedding = await generateEmbedding(env, embeddingText);

  // Upsert to Vectorize
  await env.RECIPE_VECTORIZE.upsert([
    {
      id: recipeId,
      values: embedding,
      metadata: {
        recipe_id: recipeId,
        title: data.title,
        tags: data.tags,
      },
    },
  ]);
}

/**
 * Log ingestion to database
 */
async function logIngestion(
  env: Env,
  data: {
    sourceType: string;
    sourceRef: string;
    raw: string;
    recipeId: string;
  }
): Promise<void> {
  const prisma = getPrismaClient(env);

  await prisma.ingestion.create({
    data: {
      sourceType: data.sourceType,
      sourceRef: data.sourceRef,
      raw: data.raw,
      recipeId: data.recipeId,
    },
  });
}

/**
 * Enqueue a recipe for ingestion
 */
export async function enqueueRecipeIngestion(
  env: Env,
  message: RecipeIngestionMessage
): Promise<void> {
  await env.RECIPE_INGESTION_QUEUE.send(message);
}

/**
 * Enqueue multiple recipes for ingestion
 */
export async function enqueueRecipeIngestionBatch(
  env: Env,
  messages: RecipeIngestionMessage[]
): Promise<void> {
  await env.RECIPE_INGESTION_QUEUE.sendBatch(
    messages.map(body => ({ body }))
  );
}
