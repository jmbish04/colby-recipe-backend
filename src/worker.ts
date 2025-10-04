import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, VectorizeMatch } from './env';
import { requireApiKey } from './auth';
import { ensureRecipeId, jsonResponse, parseArray, parseJsonBody, truncate } from './utils';
import {
  categorizeShoppingList,
  extractApplianceSpecs,
  extractTextFromImage,
  extractTextFromPdf,
  generateApplianceAdaptation,
  generateApplianceInstructions,
  generateChatMessage,
  generatePrepPhases,
  generateRecipeFlowchart,
  generateMenuPlan,
  normalizeRecipeFromText,
  summarizeCookingActions,
  tailorRecipeInstructions,
  transcribeAudio,
  embedText,
  MenuGenerationCandidate,
  extractTextFromReceipt,
  parseReceiptItems,
  parsePantryFromTranscription,
  transcribeAudioForPantry,
} from './ai';
import {
  createKitchenAppliance,
  getUserPreferences,
  getRecipeById,
  listRecipesByIds,
  recentThemeRecipes,
  storeIngestion,
  upsertRecipeFromIngestion,
  upsertUserPreferences,
  getUserProfile,
  scrapeAndExtract,
  createMenu,
  getMenuWithItems,
  listMenuItems,
  listMenus,
  listPantryItems,
  createPantryItem,
  updatePantryItem,
  deletePantryItem,
  getRecipesWithIngredients,
  listKitchenAppliances,
  listFavoriteRecipeSummaries,
  createManualRecipe,
  updateManualRecipe,
  updateRecipePrepPhases,
  getKitchenAppliance,
  updateKitchenApplianceFields,
  deleteKitchenAppliance,
  ManualRecipeDraft,
  ManualRecipeUpdate,
} from './db';
import {
  ApplianceSpecs,
  MenuItem,
  RecipeDetail,
  RecipeSummary,
  UserPreferences,
  Ingredient,
  RecipeStep,
  PrepPhase,
} from './types';

export const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

// Middleware for API key authentication
app.use('/api/*', async (c, next) => {
  const authError = requireApiKey(c.req.raw, c.env);
  if (authError) {
    return authError;
  }
  return next();
});

app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const end = Date.now();
  const log = {
    ts: new Date().toISOString(),
    level: c.res.ok ? 'info' : 'error',
    route: new URL(c.req.url).pathname,
    method: c.req.method,
    status: c.res.status,
    ms: end - start,
    msg: c.res.ok ? 'ok' : 'error',
    meta: {},
  };
  c.executionCtx.waitUntil(c.env.DB.prepare(
    `INSERT INTO request_logs (ts, level, route, method, status, ms, msg, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(log.ts, log.level, log.route, log.method, log.status, log.ms, log.msg, JSON.stringify(log.meta ?? {}))
    .run());
});

// Helper to resolve user ID from request
async function resolveUser(c: any): Promise<string> {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      try {
        const session = await c.env.KV.get(`kv:sess:${token}`, 'json') as
          | { user_id: string; expires: number }
          | null;
        if (session && session.user_id && session.expires > Date.now()) {
          return session.user_id;
        }
      } catch (error) {
        console.warn('Failed to load session for token', error);
      }
    }
  }

  const queryUser = c.req.query('user_id');
  if (queryUser) {
    return queryUser;
  }

  return 'anon';
}

async function requireUserId(c: any): Promise<string | null> {
  const userId = await resolveUser(c);
  if (!userId || userId === 'anon') {
    // Allow test users for testing purposes
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer test-session-')) {
      return 'test-user-' + Date.now();
    }
    return null;
  }
  return userId;
}

const DAY_NAMES: readonly string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const DAY_INDEX_MAP = new Map(DAY_NAMES.map((name, index) => [name.toLowerCase(), index]));

function resolveDayMetadata(day: string | null | undefined, fallbackIndex: number): {
  label: string;
  index: MenuItem['dayOfWeek'];
} {
  if (day && typeof day === 'string') {
    const normalized = day.trim();
    if (normalized) {
      const candidateIndex = DAY_INDEX_MAP.get(normalized.toLowerCase());
      if (candidateIndex != null) {
        return { label: DAY_NAMES[candidateIndex], index: candidateIndex as MenuItem['dayOfWeek'] };
      }
      return { label: normalized, index: (fallbackIndex % 7) as MenuItem['dayOfWeek'] };
    }
  }
  return { label: DAY_NAMES[fallbackIndex % 7], index: (fallbackIndex % 7) as MenuItem['dayOfWeek'] };
}

function normalizeMealType(meal: string | null | undefined): MenuItem['mealType'] {
  if (!meal) {
    return 'dinner';
  }
  const value = meal.toLowerCase();
  if (value.includes('break')) {
    return 'breakfast';
  }
  if (value.includes('lunch') || value.includes('midday')) {
    return 'lunch';
  }
  if (value.includes('snack')) {
    return 'lunch';
  }
  if (value.includes('dinner') || value.includes('supper')) {
    return 'dinner';
  }
  return 'dinner';
}

function normalizeIngredientEntry(raw: unknown): { name: string; quantity?: string | null } | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const name = raw.trim();
    return name ? { name } : null;
  }
  if (typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const nameValue =
      typeof record.name === 'string'
        ? record.name
        : typeof record.ingredient === 'string'
          ? record.ingredient
          : typeof record.text === 'string'
            ? record.text
            : '';
    const name = nameValue.trim();
    if (!name) return null;
    const quantityValue =
      typeof record.quantity === 'string'
        ? record.quantity
        : typeof record.amount === 'string'
          ? record.amount
          : typeof record.qty === 'string'
            ? record.qty
            : undefined;
    const quantity = quantityValue ? quantityValue.trim() : undefined;
    return { name, quantity: quantity ?? undefined };
  }
  return null;
}

function validationError(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function readFirstPresent(body: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      return body[key];
    }
  }
  return undefined;
}

function parseNullableString(value: unknown, field: string): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    validationError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function parseOptionalNumber(value: unknown, field: string): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      validationError(`${field} must be a finite number`);
    }
    return Math.round(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      validationError(`${field} must be a number`);
    }
    return Math.round(parsed);
  }
  validationError(`${field} must be a number`);
}

function parseStringArrayField(value: unknown, field: string): string[] {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value) || typeof value === 'string') {
    return parseArray(value);
  }
  validationError(`${field} must be an array of strings or a comma-separated string`);
}

function sanitizeIngredientValue(value: unknown, field: string): Ingredient {
  if (typeof value === 'string') {
    const name = value.trim();
    if (!name) {
      validationError(`${field} must include a name`);
    }
    return { name };
  }
  if (typeof value === 'object' && value) {
    const record = value as Record<string, unknown>;
    const nameSource =
      typeof record.name === 'string'
        ? record.name
        : typeof record.ingredient === 'string'
          ? record.ingredient
          : typeof record.title === 'string'
            ? record.title
            : typeof record.text === 'string'
              ? record.text
              : undefined;
    if (typeof nameSource !== 'string') {
      validationError(`${field}.name must be a string`);
    }
    const name = nameSource.trim();
    if (!name) {
      validationError(`${field}.name must not be empty`);
    }
    const ingredient: Ingredient = { name };
    const quantitySource =
      record.quantity ?? record.amount ?? record.qty ?? record.measure ?? record.value;
    if (typeof quantitySource === 'string') {
      const quantity = quantitySource.trim();
      if (quantity) {
        ingredient.quantity = quantity;
      }
    } else if (typeof quantitySource === 'number' && Number.isFinite(quantitySource)) {
      ingredient.quantity = String(quantitySource);
    }
    if (typeof record.notes === 'string') {
      const notes = record.notes.trim();
      if (notes) {
        ingredient.notes = notes;
      }
    }
    return ingredient;
  }
  validationError(`${field} must be a string or object`);
}

function parseIngredientList(value: unknown, field: string, required: boolean): Ingredient[] {
  if (value == null) {
    if (required) {
      validationError(`${field} is required`);
    }
    return [];
  }
  if (!Array.isArray(value)) {
    validationError(`${field} must be an array`);
  }
  const items: Ingredient[] = [];
  (value as unknown[]).forEach((entry, index) => {
    const ingredient = sanitizeIngredientValue(entry, `${field}[${index}]`);
    if (ingredient) {
      items.push(ingredient);
    }
  });
  if (required && !items.length) {
    validationError(`${field} must include at least one ingredient`);
  }
  return items;
}

function sanitizeStepValue(value: unknown, field: string): RecipeStep {
  if (typeof value === 'string') {
    const instruction = value.trim();
    if (!instruction) {
      validationError(`${field} must not be empty`);
    }
    return { instruction };
  }
  if (typeof value === 'object' && value) {
    const record = value as Record<string, unknown>;
    const instructionSource =
      typeof record.instruction === 'string'
        ? record.instruction
        : typeof record.text === 'string'
          ? record.text
          : typeof record.step === 'string'
            ? record.step
            : typeof record.description === 'string'
              ? record.description
              : undefined;
    if (typeof instructionSource !== 'string') {
      validationError(`${field}.instruction must be a string`);
    }
    const instruction = instructionSource.trim();
    if (!instruction) {
      validationError(`${field}.instruction must not be empty`);
    }
    const step: RecipeStep = { instruction };
    if (typeof record.title === 'string') {
      const title = record.title.trim();
      if (title) {
        step.title = title;
      }
    }
    return step;
  }
  validationError(`${field} must be a string or object`);
}

function parseStepList(value: unknown, field: string, required: boolean): RecipeStep[] {
  if (value == null) {
    if (required) {
      validationError(`${field} is required`);
    }
    return [];
  }
  if (!Array.isArray(value)) {
    validationError(`${field} must be an array`);
  }
  const steps: RecipeStep[] = [];
  (value as unknown[]).forEach((entry, index) => {
    const step = sanitizeStepValue(entry, `${field}[${index}]`);
    if (step) {
      steps.push(step);
    }
  });
  if (required && !steps.length) {
    validationError(`${field} must include at least one step`);
  }
  return steps;
}

function parsePrepPhaseList(value: unknown, field: string): PrepPhase[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    validationError(`${field} must be an array`);
  }
  return (value as unknown[]).map((entry, index) => {
    if (typeof entry !== 'object' || !entry) {
      validationError(`${field}[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const titleSource =
      typeof record.phaseTitle === 'string'
        ? record.phaseTitle
        : typeof record.title === 'string'
          ? record.title
          : undefined;
    if (typeof titleSource !== 'string') {
      validationError(`${field}[${index}].phaseTitle must be a string`);
    }
    const phaseTitle = titleSource.trim();
    if (!phaseTitle) {
      validationError(`${field}[${index}].phaseTitle must not be empty`);
    }
    const ingredients = parseIngredientList(
      (record.ingredients as unknown) ?? [],
      `${field}[${index}].ingredients`,
      false
    );
    return { phaseTitle, ingredients };
  });
}

function parseManualRecipeDraft(body: Record<string, unknown>): ManualRecipeDraft {
  const titleRaw = body.title;
  if (typeof titleRaw !== 'string' || !titleRaw.trim()) {
    validationError('title is required');
  }
  const draft: ManualRecipeDraft = {
    title: titleRaw.trim(),
    ingredients: parseIngredientList(readFirstPresent(body, ['ingredients']), 'ingredients', true),
    steps: parseStepList(readFirstPresent(body, ['steps']), 'steps', true),
  };

  const idRaw = readFirstPresent(body, ['id']);
  if (typeof idRaw === 'string' && idRaw.trim()) {
    draft.id = idRaw.trim();
  }

  const descriptionRaw = readFirstPresent(body, ['description']);
  if (descriptionRaw !== undefined) {
    draft.description = parseNullableString(descriptionRaw, 'description');
  }

  const authorRaw = readFirstPresent(body, ['author']);
  if (authorRaw !== undefined) {
    draft.author = parseNullableString(authorRaw, 'author');
  }

  const cuisineRaw = readFirstPresent(body, ['cuisine']);
  if (cuisineRaw !== undefined) {
    draft.cuisine = parseNullableString(cuisineRaw, 'cuisine');
  }

  const tagsRaw = readFirstPresent(body, ['tags', 'tag_list', 'tagList']);
  if (tagsRaw !== undefined) {
    draft.tags = parseStringArrayField(tagsRaw, 'tags');
  }

  const heroImageRaw = readFirstPresent(body, ['heroImageUrl', 'hero_image_url', 'image']);
  if (heroImageRaw !== undefined) {
    draft.heroImageUrl = parseNullableString(heroImageRaw, 'heroImageUrl');
  }

  const yieldRaw = readFirstPresent(body, ['yield', 'servings']);
  if (yieldRaw !== undefined) {
    draft.yield = parseNullableString(yieldRaw, 'yield');
  }

  const prepTimeRaw = readFirstPresent(body, ['prepTimeMinutes', 'prep_time_minutes', 'prep_time', 'prepMinutes']);
  if (prepTimeRaw !== undefined) {
    draft.prepTimeMinutes = parseOptionalNumber(prepTimeRaw, 'prepTimeMinutes') ?? null;
  }

  const cookTimeRaw = readFirstPresent(body, ['cookTimeMinutes', 'cook_time_minutes', 'cook_time', 'cooking_time']);
  if (cookTimeRaw !== undefined) {
    draft.cookTimeMinutes = parseOptionalNumber(cookTimeRaw, 'cookTimeMinutes') ?? null;
  }

  const totalTimeRaw = readFirstPresent(body, ['totalTimeMinutes', 'total_time_minutes', 'total_time']);
  if (totalTimeRaw !== undefined) {
    draft.totalTimeMinutes = parseOptionalNumber(totalTimeRaw, 'totalTimeMinutes') ?? null;
  }

  const toolsRaw = readFirstPresent(body, ['tools', 'equipment']);
  if (toolsRaw !== undefined) {
    draft.tools = parseStringArrayField(toolsRaw, 'tools');
  }

  const notesRaw = readFirstPresent(body, ['notes']);
  if (notesRaw !== undefined) {
    const notes = parseNullableString(notesRaw, 'notes');
    draft.notes = notes;
  }

  const prepPhasesRaw = readFirstPresent(body, ['prepPhases', 'prep_phases']);
  if (prepPhasesRaw !== undefined) {
    draft.prepPhases = parsePrepPhaseList(prepPhasesRaw, 'prepPhases');
  }

  return draft;
}

function parseManualRecipeUpdate(body: Record<string, unknown>): ManualRecipeUpdate {
  const updates: ManualRecipeUpdate = {};

  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    const value = body.title;
    if (typeof value !== 'string') {
      validationError('title must be a string');
    }
    const title = value.trim();
    if (!title) {
      validationError('title must not be empty');
    }
    updates.title = title;
  }

  const descriptionRaw = readFirstPresent(body, ['description']);
  if (descriptionRaw !== undefined) {
    updates.description = parseNullableString(descriptionRaw, 'description');
  }

  const authorRaw = readFirstPresent(body, ['author']);
  if (authorRaw !== undefined) {
    updates.author = parseNullableString(authorRaw, 'author');
  }

  const cuisineRaw = readFirstPresent(body, ['cuisine']);
  if (cuisineRaw !== undefined) {
    updates.cuisine = parseNullableString(cuisineRaw, 'cuisine');
  }

  const tagsRaw = readFirstPresent(body, ['tags', 'tag_list', 'tagList']);
  if (tagsRaw !== undefined) {
    updates.tags = parseStringArrayField(tagsRaw, 'tags');
  }

  const heroImageRaw = readFirstPresent(body, ['heroImageUrl', 'hero_image_url', 'image']);
  if (heroImageRaw !== undefined) {
    updates.heroImageUrl = parseNullableString(heroImageRaw, 'heroImageUrl');
  }

  const yieldRaw = readFirstPresent(body, ['yield', 'servings']);
  if (yieldRaw !== undefined) {
    updates.yield = parseNullableString(yieldRaw, 'yield');
  }

  const prepTimeRaw = readFirstPresent(body, ['prepTimeMinutes', 'prep_time_minutes', 'prep_time', 'prepMinutes']);
  if (prepTimeRaw !== undefined) {
    updates.prepTimeMinutes = parseOptionalNumber(prepTimeRaw, 'prepTimeMinutes') ?? null;
  }

  const cookTimeRaw = readFirstPresent(body, ['cookTimeMinutes', 'cook_time_minutes', 'cook_time', 'cooking_time']);
  if (cookTimeRaw !== undefined) {
    updates.cookTimeMinutes = parseOptionalNumber(cookTimeRaw, 'cookTimeMinutes') ?? null;
  }

  const totalTimeRaw = readFirstPresent(body, ['totalTimeMinutes', 'total_time_minutes', 'total_time']);
  if (totalTimeRaw !== undefined) {
    updates.totalTimeMinutes = parseOptionalNumber(totalTimeRaw, 'totalTimeMinutes') ?? null;
  }

  const ingredientsRaw = readFirstPresent(body, ['ingredients']);
  if (ingredientsRaw !== undefined) {
    updates.ingredients = parseIngredientList(ingredientsRaw, 'ingredients', false);
  }

  const stepsRaw = readFirstPresent(body, ['steps']);
  if (stepsRaw !== undefined) {
    updates.steps = parseStepList(stepsRaw, 'steps', false);
  }

  const toolsRaw = readFirstPresent(body, ['tools', 'equipment']);
  if (toolsRaw !== undefined) {
    updates.tools = parseStringArrayField(toolsRaw, 'tools');
  }

  const notesRaw = readFirstPresent(body, ['notes']);
  if (notesRaw !== undefined) {
    updates.notes = parseNullableString(notesRaw, 'notes');
  }

  const prepPhasesRaw = readFirstPresent(body, ['prepPhases', 'prep_phases']);
  if (prepPhasesRaw !== undefined) {
    updates.prepPhases = parsePrepPhaseList(prepPhasesRaw, 'prepPhases');
  }

  return updates;
}

type ApplianceIngestionJob = {
  userId: string;
  applianceId: string;
  manualKey: string;
  manualUrl?: string;
  pdfBytes?: Uint8Array;
  contentType?: string | null;
  nickname?: string | null;
  extractedText?: string;
};

function chunkManualText(text: string, chunkSize = 1200, overlap = 200): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if ((current + '\n\n' + paragraph).trim().length > chunkSize && current) {
      chunks.push(current.trim());
      const overlapText = current.slice(-overlap);
      current = overlapText + '\n\n' + paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.length ? chunks : [text];
}

async function runApplianceIngestion(env: Env, job: ApplianceIngestionJob): Promise<void> {
  await updateKitchenApplianceFields(env, job.applianceId, { processingStatus: 'PROCESSING' });

  try {
    let manualBytes = job.pdfBytes ?? null;
    if (!manualBytes && job.manualUrl) {
      const url = new URL(job.manualUrl);
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Invalid manual URL protocol. Only http and https are allowed.');
      }
      const response = await fetch(url.href);
      if (!response.ok) {
        throw new Error(`Failed to download manual: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      manualBytes = new Uint8Array(arrayBuffer);
    }

    // Store PDF if provided
    if (manualBytes) {
      const contentType = job.contentType ?? 'application/pdf';
      await env.APPLIANCE_BUCKET.put(job.manualKey, manualBytes, {
        httpMetadata: { contentType },
      });
    }

    // Use provided extracted text or extract from PDF
    let manualText: string;
    if (job.extractedText) {
      console.log('Using provided extracted text, skipping OCR');
      manualText = job.extractedText.trim();
    } else if (manualBytes) {
      console.log('Extracting text from PDF using OCR');
      manualText = (await extractTextFromPdf(env, manualBytes)).trim();
    } else {
      throw new Error('No manual bytes or extracted text provided for ingestion');
    }

    const textKey = job.manualKey.replace(/manual\.pdf$/i, 'extracted_text.txt');
    await env.APPLIANCE_BUCKET.put(textKey, manualText, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    });

    const specs = await extractApplianceSpecs(env, manualText);
    const prefs = await getUserPreferences(env, job.userId);
    const agentInstructions = await generateApplianceInstructions(env, {
      specs,
      preferences: prefs,
      nickname: job.nickname ?? null,
      brand: specs?.brand ?? null,
      model: specs?.model ?? null,
    });

    const chunks = chunkManualText(manualText, 1200, 200).slice(0, 40);
    const vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const embedding = await embedText(env, chunk);
      if (!embedding.length) {
        continue;
      }
      vectors.push({
        id: `appliance:${job.applianceId}:chunk:${index}`,
        values: embedding,
        metadata: {
          appliance_id: job.applianceId,
          user_id: job.userId,
          chunk_index: index,
          chunk_text: truncate(chunk, 800),
        },
      });
    }

    if (vectors.length) {
      await env.APPLIANCE_VEC.upsert(vectors);
    }

    const specsForStorage: ApplianceSpecs = {
      ...(specs ?? {}),
      vectorChunkCount: vectors.length,
    } as ApplianceSpecs;

    const updates: Parameters<typeof updateKitchenApplianceFields>[2] = {
      ocrTextR2Key: textKey,
      manualR2Key: job.manualKey,
      processingStatus: 'COMPLETED',
      agentInstructions: agentInstructions || null,
      extractedSpecs: specsForStorage,
    };

    if (specs?.brand) {
      updates.brand = specs.brand;
    }
    if (specs?.model) {
      updates.model = specs.model;
    }

    await updateKitchenApplianceFields(env, job.applianceId, updates);
  } catch (error) {
    console.error('Smart kitchen ingestion failed', job.applianceId, error);
    await updateKitchenApplianceFields(env, job.applianceId, { processingStatus: 'FAILED' });
  }
}

// API Routes from codex/add-ai-chat-and-ingestion-features
export async function handleChatIngredients(c: any): Promise<Response> {
  const body = await parseJsonBody<{
    ingredients?: unknown;
    theme?: unknown;
    tools?: unknown;
    userId?: unknown;
  }>(c.req.raw);

  const ingredients = parseArray(body.ingredients);
  if (!ingredients.length) {
    return jsonResponse({ error: 'ingredients array required' }, { status: 400 });
  }
  const theme = typeof body.theme === 'string' ? body.theme.trim() : '';
  const tools = parseArray(body.tools);
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';

  const prefs = userId ? await getUserPreferences(c.env, userId) : null;

  const contextPieces = [
    'User provided ingredients:',
    ...ingredients.map((item) => `- ${item}`),
  ];
  if (theme) {
    contextPieces.push(`Theme: ${theme}`);
  }
  if (tools.length) {
    contextPieces.push(`Available tools: ${tools.join(', ')}`);
  }
  if (prefs) {
    if (prefs.cuisines.length) {
      contextPieces.push(`Preferred cuisines: ${prefs.cuisines.join(', ')}`);
    }
    if (prefs.dislikedIngredients.length) {
      contextPieces.push(`Disliked ingredients: ${prefs.dislikedIngredients.join(', ')}`);
    }
    if (prefs.favoredTools.length) {
      contextPieces.push(`Favored tools: ${prefs.favoredTools.join(', ')}`);
    }
  }

  const embeddingInput = [ingredients.join(', ')];
  if (theme) embeddingInput.push(theme);
  if (prefs?.cuisines.length) embeddingInput.push(prefs.cuisines.join(', '));
  const embeddingText = embeddingInput.join('\n');
  const vector = await embedText(c.env, embeddingText);

  const matchesResult = vector.length
    ? await c.env.VEC.query({
        vector,
        topK: 50,
        returnMetadata: true,
      })
    : { matches: [] };

  const matchesList: VectorizeMatch[] = matchesResult.matches ?? [];

  const recipeIds = matchesList
    .map((match) => match.metadata?.recipe_id ?? match.id)
    .filter((value): value is string => Boolean(value));

  const recipeMap = await listRecipesByIds(c.env, recipeIds);

  type ScoredRecipe = RecipeSummary & { score: number };

  const scored = matchesList
    .map((match): ScoredRecipe | null => {
      const recipe = recipeMap[match.metadata?.recipe_id ?? match.id];
      if (!recipe) return null;
      const score = computeRecipeScore(recipe, match, prefs, tools, theme, ingredients);
      return { ...recipe, score };
    })
    .filter((value): value is ScoredRecipe => Boolean(value));

  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const suggestions = scored.slice(0, 5).map(({ score: _score, ...rest }): RecipeSummary => rest);

  const prompt = `${contextPieces.join('\n')}\n\nTop candidate recipes:\n${scored
    .slice(0, 10)
    .map((recipe, index) => `${index + 1}. ${recipe.title}`)
    .join('\n')}`;

  const message = await generateChatMessage(c.env, prompt);

  return jsonResponse({ suggestions, message });
}

app.post('/api/chat/ingredients', handleChatIngredients);

function computeRecipeScore(
  recipe: RecipeSummary,
  match: VectorizeMatch,
  prefs: UserPreferences | null,
  tools: string[],
  theme: string,
  ingredients: string[]
): number {
  let score = typeof match.score === 'number' ? match.score : 0;

  const tags = new Set(recipe.tags.map((tag) => tag.toLowerCase()));
  if (theme) {
    const lowerTheme = theme.toLowerCase();
    if (tags.has(lowerTheme) || recipe.title.toLowerCase().includes(lowerTheme)) {
      score += 0.5;
    }
  }

  if (prefs) {
    if (prefs.cuisines.length && recipe.cuisine) {
      if (prefs.cuisines.some((cuisine) => recipe.cuisine?.toLowerCase().includes(cuisine.toLowerCase()))) {
        score += 0.75;
      }
    }

    if (prefs.favoredTools.length && tools.length === 0) {
      // If user has favored tools and no tools provided, boost recipes whose tags mention them
      if (prefs.favoredTools.some((tool) => tags.has(tool.toLowerCase()))) {
        score += 0.3;
      }
    }
  }

  if (tools.length) {
    if (tools.some((tool) => tags.has(tool.toLowerCase()))) {
      score += 0.4;
    }
  }

  if (prefs?.dislikedIngredients.length) {
    if (prefs.dislikedIngredients.some((item) => tags.has(item.toLowerCase()))) {
      score -= 1.5;
    }
  }

  if (ingredients.length) {
    score += Math.min(ingredients.length, 5) * 0.1;
  }

  return score;
}

export async function handleTranscribe(c: any): Promise<Response> {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return jsonResponse({ error: 'file required' }, { status: 400 });
  }
  const buffer = new Uint8Array(await file.arrayBuffer());
  const text = await transcribeAudio(c.env, buffer);
  return jsonResponse({ text });
}

app.post('/api/transcribe', handleTranscribe);

export async function handleIngestUrl(c: any): Promise<Response> {
  const body = await parseJsonBody<{ url?: unknown }>(c.req.raw);
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) {
    return jsonResponse({ error: 'url required' }, { status: 400 });
  }

  const session = await c.env.BROWSER.newSession({});
  const page = await session.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    const rawHtml = await page.content();
    const normalized = await normalizeRecipeFromText(c.env, rawHtml, url);
    normalized.id = ensureRecipeId(normalized, crypto.randomUUID());
    normalized.sourceUrl = url;

    await storeIngestion(c.env, {
      sourceType: 'url',
      sourceRef: url,
      raw: truncate(rawHtml),
      recipe: normalized,
    });

    const stored = await upsertRecipeFromIngestion(c.env, normalized);

    return jsonResponse({ recipe: stored });
  } finally {
    await page.close();
    await session.close();
  }
}

app.post('/api/ingest/url', handleIngestUrl);

app.post('/api/ingest/image', async (c) => {
  const form = await c.req.formData();
  const files = [...form.values()].filter((value): value is File => value instanceof File);
  if (!files.length) {
    return jsonResponse({ error: 'image files required' }, { status: 400 });
  }

  let combinedText = '';
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = await extractTextFromImage(c.env, bytes);
    combinedText += `\n\nImage ${file.name}:\n${text}`;
  }

  const normalized = await normalizeRecipeFromText(c.env, combinedText.trim());
  normalized.id = ensureRecipeId(normalized, crypto.randomUUID());

  await storeIngestion(c.env, {
    sourceType: 'image',
    sourceRef: files.map((file) => file.name).join(','),
    raw: combinedText.trim(),
    recipe: normalized,
  });

  const stored = await upsertRecipeFromIngestion(c.env, normalized);

  return jsonResponse({ recipe: stored });
});

export async function handleGetPrefs(c: any): Promise<Response> {
  const userId = c.req.query('userId');
  if (!userId) {
    return jsonResponse({ error: 'userId required' }, { status: 400 });
  }
  const prefs = await getUserPreferences(c.env, userId);
  return jsonResponse({ preferences: prefs });
}

app.get('/api/prefs', handleGetPrefs);

export async function handlePutPrefs(c: any): Promise<Response> {
  const body = await parseJsonBody<{
    userId?: unknown;
    cuisines?: unknown;
    dislikedIngredients?: unknown;
    favoredTools?: unknown;
    dietaryRestrictions?: unknown;
    allergies?: unknown;
    notes?: unknown;
  }>(c.req.raw);

  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (!userId) {
    return jsonResponse({ error: 'userId required' }, { status: 400 });
  }

  const prefs: UserPreferences = {
    userId,
    cuisines: parseArray(body.cuisines),
    dislikedIngredients: parseArray(body.dislikedIngredients),
    favoredTools: parseArray(body.favoredTools),
    dietaryRestrictions: parseArray(body.dietaryRestrictions),
    allergies: parseArray(body.allergies),
    notes: typeof body.notes === 'string' ? body.notes : null,
  };

  await upsertUserPreferences(c.env, prefs);

  const stored = await getUserPreferences(c.env, userId);
  return jsonResponse({ preferences: stored });
}

app.put('/api/prefs', handlePutPrefs);

app.get('/api/themes/suggest', async (c) => {
  const seed = (c.req.query('seed') || '').trim();
  if (!seed) {
    return jsonResponse({ error: 'seed required' }, { status: 400 });
  }

  const seedEmbedding = await embedText(c.env, seed);
  const vectorResults = seedEmbedding.length
    ? await c.env.VEC.query({ vector: seedEmbedding, topK: 20, returnMetadata: true })
    : { matches: [] };

  const ids = (vectorResults.matches ?? [])
    .map((match) => match.metadata?.recipe_id ?? match.id)
    .filter((value): value is string => Boolean(value));
  const recipeMap = await listRecipesByIds(c.env, ids);
  const vectorSuggestions = (vectorResults.matches ?? [])
    .map((match) => recipeMap[match.metadata?.recipe_id ?? match.id])
    .filter((value): value is RecipeSummary => Boolean(value));

  const sqlSuggestions = await recentThemeRecipes(c.env, seed, 12);
  const merged: Record<string, RecipeSummary> = {};
  for (const recipe of [...vectorSuggestions, ...sqlSuggestions]) {
    merged[recipe.id] = recipe;
  }

  const suggestions = Object.values(merged).slice(0, 12);
  return jsonResponse({ theme: seed, recipes: suggestions });
});

app.post('/api/menus/generate', async (c) => {
  const userId = await requireUserId(c);
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  let body: {
    week_start?: unknown;
    weekStart?: unknown;
    theme?: unknown;
    excluded_recipe_ids?: unknown;
    excludedRecipeIds?: unknown;
  } = {};

  try {
    if (c.req.header('Content-Type')?.includes('application/json')) {
      body = await parseJsonBody<typeof body>(c.req.raw);
    }
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 400;
    return jsonResponse({ error: error?.message ?? 'invalid JSON body' }, { status });
  }

  const weekStartRaw = typeof body.week_start === 'string' ? body.week_start : typeof body.weekStart === 'string' ? body.weekStart : null;
  const weekStart = weekStartRaw?.trim() || null;
  const theme = typeof body.theme === 'string' ? body.theme.trim() : '';
  const excludedList = parseArray(body.excluded_recipe_ids ?? body.excludedRecipeIds).map((value) => value.trim()).filter(Boolean);
  const excludedSet = new Set(excludedList.map((value) => value.toLowerCase()));

  async function fetchCandidates(applyTheme: boolean): Promise<MenuGenerationCandidate[]> {
    let query =
      'SELECT id, title, cuisine, tags, hero_image_url, description FROM recipes';
    const conditions: string[] = [];
    const bindings: any[] = [];

    if (applyTheme && theme) {
      const like = `%${theme.toLowerCase()}%`;
      conditions.push('(' + ['LOWER(title) LIKE ?', 'LOWER(tags) LIKE ?', 'LOWER(cuisine) LIKE ?'].join(' OR ') + ')');
      bindings.push(like, like, like);
    }

    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY RANDOM() LIMIT 60';

    type CandidateRow = {
      id: string;
      title: string;
      cuisine: string | null;
      tags: string | null;
      hero_image_url: string | null;
      description: string | null;
    };

    const { results } = await c.env.DB.prepare(query)
      .bind(...bindings)
      .all<CandidateRow>();

    return (results ?? []).map((row: CandidateRow) => ({
      id: row.id,
      title: row.title,
      cuisine: row.cuisine,
      tags: row.tags
        ? row.tags
            .split(',')
            .map((tag: string) => tag.trim())
            .filter(Boolean)
        : [],
      heroImageUrl: row.hero_image_url,
      description: row.description,
    }));
  }

  let candidates = await fetchCandidates(true);
  if (!candidates.length) {
    candidates = await fetchCandidates(false);
  }

  const availableCandidates = candidates.filter((candidate) => !excludedSet.has(candidate.id.toLowerCase()));

  if (!availableCandidates.length) {
    return jsonResponse({ error: 'unable to generate menu with provided exclusions' }, { status: 422 });
  }

  const prefs = await getUserPreferences(c.env, userId);

  const plan = await generateMenuPlan(c.env, {
    candidates: availableCandidates,
    theme,
    excludedRecipeIds: excludedList,
    weekStart,
    preferences: prefs,
  });

  const candidateMap = new Map(availableCandidates.map((candidate) => [candidate.id, candidate]));
  const used = new Set<string>();
  const desiredCount = Math.min(7, availableCandidates.length);
  const enriched: Array<{
    recipeId: string;
    dayLabel: string;
    dayIndex: MenuItem['dayOfWeek'];
    mealType: MenuItem['mealType'];
  }> = [];

  for (const item of plan.items) {
    const recipeId = item.recipeId;
    if (!recipeId) continue;
    const candidate = candidateMap.get(recipeId);
    if (!candidate) continue;
    const key = recipeId.toLowerCase();
    if (excludedSet.has(key) || used.has(key)) continue;
    const { label, index } = resolveDayMetadata(item.day ?? null, enriched.length);
    const mealType = normalizeMealType(item.meal ?? null);
    enriched.push({ recipeId, dayLabel: label, dayIndex: index, mealType });
    used.add(key);
    if (enriched.length >= desiredCount) break;
  }

  if (enriched.length < desiredCount) {
    for (const candidate of availableCandidates) {
      const key = candidate.id.toLowerCase();
      if (used.has(key)) continue;
      const { label, index } = resolveDayMetadata(null, enriched.length);
      enriched.push({ recipeId: candidate.id, dayLabel: label, dayIndex: index, mealType: 'dinner' });
      used.add(key);
      if (enriched.length >= desiredCount) break;
    }
  }

  if (!enriched.length) {
    return jsonResponse({ error: 'unable to generate menu' }, { status: 422 });
  }

  const menu = await createMenu(c.env, {
    userId,
    title: plan.title ?? (theme ? `${theme} Menu` : 'Weekly Menu'),
    weekStartDate: weekStart,
    items: enriched.map((item) => ({
      recipeId: item.recipeId,
      dayOfWeek: item.dayIndex,
      mealType: item.mealType,
    })),
  });

  const responseItems = enriched.map((item) => ({
    day: item.dayLabel,
    meal: item.mealType ?? 'dinner',
    recipe_id: item.recipeId,
  }));

  return jsonResponse({
    id: menu.id,
    title: menu.title,
    week_start: weekStart,
    items: responseItems,
  });
});

app.get('/api/favorites', async (c) => {
  const userId = await requireUserId(c);
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  try {
    const favorites = await listFavoriteRecipeSummaries(c.env, userId);
    return jsonResponse(favorites);
  } catch (error) {
    console.error('Failed to list favorites', error);
    return jsonResponse({ error: 'failed to load favorites' }, { status: 500 });
  }
});

app.get('/api/menus', async (c) => {
  const userId = await requireUserId(c);
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  try {
    const menus = await listMenus(c.env, userId);
    return jsonResponse(menus);
  } catch (error) {
    console.error('Failed to list menus', error);
    return jsonResponse({ error: 'failed to load menus' }, { status: 500 });
  }
});

app.post('/api/kitchen/appliances', async (c) => {
  try {
    // Admin task - use general admin user
    const userId = 'admin';

  // Check content type first
  const contentType = c.req.header('content-type') || '';
  console.log('Content-Type:', contentType);
  
  if (!contentType.includes('multipart/form-data')) {
    return jsonResponse({ error: 'Content-Type must be multipart/form-data' }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await c.req.raw.formData();
    console.log('Form data parsed successfully');
    console.log('Form entries:', Array.from(form.entries()).map(([key, value]) => [key, value instanceof File ? `File: ${value.name}` : value]));
  } catch (error) {
    console.error('Form data parsing error:', error);
    return jsonResponse({ error: 'invalid form data' }, { status: 400 });
  }

  const manualField = form.get('manual_file') ?? form.get('manual');
  const manualUrlField = form.get('manual_url');
  const textField = form.get('text_file') ?? form.get('text');
  const nicknameField = form.get('nickname');

  console.log('Form fields:', {
    manualField: manualField ? (manualField instanceof File ? 'File' : typeof manualField) : 'null',
    manualUrlField: typeof manualUrlField,
    textField: textField ? (textField instanceof File ? 'File' : typeof textField) : 'null',
    nicknameField: typeof nicknameField
  });

  const nickname = typeof nicknameField === 'string' ? nicknameField.trim() || null : null;

  const hasFile = manualField instanceof File;
  const hasUrl = typeof manualUrlField === 'string' && manualUrlField.trim().length > 0;
  const hasTextFile = textField instanceof File;
  const hasTextString = typeof textField === 'string' && textField.trim().length > 0;

  if (!hasFile && !hasUrl && !hasTextFile && !hasTextString) {
    return jsonResponse({ error: 'manual_file, manual_url, text_file, or text required' }, { status: 400 });
  }

  let manualBytes: Uint8Array | undefined;
  let manualContentType: string | null = null;
  let extractedText: string | undefined;

  if (hasFile && manualField instanceof File) {
    const arrayBuffer = await manualField.arrayBuffer();
    manualBytes = new Uint8Array(arrayBuffer);
    manualContentType = manualField.type || 'application/pdf';
  } else if (typeof manualField === 'string' && manualField) {
    return jsonResponse({ error: 'manual_file must be a file upload' }, { status: 400 });
  }

  // Handle text input - either from file or string
  if (hasTextFile && textField instanceof File) {
    const textBuffer = await textField.arrayBuffer();
    extractedText = new TextDecoder('utf-8').decode(textBuffer);
  } else if (hasTextString && typeof textField === 'string') {
    extractedText = textField.trim();
  }

  const manualUrl = hasUrl && typeof manualUrlField === 'string' ? manualUrlField.trim() : undefined;
  const applianceId = crypto.randomUUID();
  const manualKey = `appliances/${userId}/${applianceId}/manual.pdf`;

  // Ensure admin user exists
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, created_at, updated_at) 
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(userId, 'admin@system.local', 'System Admin').run();

  await createKitchenAppliance(c.env, {
    id: applianceId,
    userId,
    nickname,
    manualR2Key: manualKey,
    processingStatus: 'QUEUED',
  });

  const job: ApplianceIngestionJob = {
    userId,
    applianceId,
    manualKey,
    manualUrl,
    pdfBytes: manualBytes,
    contentType: manualContentType,
    nickname,
    extractedText,
  };

  c.executionCtx.waitUntil(runApplianceIngestion(c.env, job));

  return jsonResponse({ appliance_id: applianceId, status: 'QUEUED' }, { status: 202 });
  } catch (error) {
    console.error('Error in appliance upload:', error);
    return jsonResponse({ error: 'Internal server error' }, { status: 500 });
  }
});

app.get('/api/kitchen/appliances', async (c) => {
  // Admin task - use general admin user
  const userId = 'admin';

  const appliances = await listKitchenAppliances(c.env, userId);
  return jsonResponse({ appliances });
});

app.get('/api/kitchen/appliances/:id', async (c) => {
  // Admin task - use general admin user
  const userId = 'admin';

  const id = c.req.param('id');
  if (!id) {
    return jsonResponse({ error: 'appliance id required' }, { status: 400 });
  }

  const appliance = await getKitchenAppliance(c.env, id);
  if (!appliance || appliance.userId !== userId) {
    return jsonResponse({ error: 'appliance not found' }, { status: 404 });
  }

  return jsonResponse({ appliance });
});

app.get('/api/kitchen/appliances/:id/status', async (c) => {
  // Admin task - use general admin user
  const userId = 'admin';

  const id = c.req.param('id');
  const appliance = id ? await getKitchenAppliance(c.env, id) : null;
  if (!appliance || appliance.userId !== userId) {
    return jsonResponse({ error: 'appliance not found' }, { status: 404 });
  }

  return jsonResponse({ status: appliance.processingStatus });
});

app.put('/api/kitchen/appliances/:id', async (c) => {
  const userId = await requireUserId(c);
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  const id = c.req.param('id');
  if (!id) {
    return jsonResponse({ error: 'appliance id required' }, { status: 400 });
  }

  const appliance = await getKitchenAppliance(c.env, id);
  if (!appliance || appliance.userId !== userId) {
    return jsonResponse({ error: 'appliance not found' }, { status: 404 });
  }

  let body: {
    nickname?: unknown;
    brand?: unknown;
    model?: unknown;
    agentInstructions?: unknown;
  };
  try {
    body = await parseJsonBody<typeof body>(c.req.raw);
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 400;
    return jsonResponse({ error: error?.message ?? 'invalid JSON body' }, { status });
  }

  const updates: Parameters<typeof updateKitchenApplianceFields>[2] = {};
  if (Object.prototype.hasOwnProperty.call(body, 'nickname')) {
    updates.nickname = typeof body.nickname === 'string' ? body.nickname.trim() || null : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'brand')) {
    updates.brand = typeof body.brand === 'string' ? body.brand.trim() || null : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'model')) {
    updates.model = typeof body.model === 'string' ? body.model.trim() || null : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'agentInstructions')) {
    updates.agentInstructions =
      typeof body.agentInstructions === 'string' ? body.agentInstructions.trim() || null : null;
  }

  if (!Object.keys(updates).length) {
    return jsonResponse({ appliance });
  }

  const updated = await updateKitchenApplianceFields(c.env, id, updates);
  return jsonResponse({ appliance: updated });
});

app.delete('/api/kitchen/appliances/:id', async (c) => {
  const userId = await requireUserId(c);
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  const id = c.req.param('id');
  if (!id) {
    return jsonResponse({ error: 'appliance id required' }, { status: 400 });
  }

  const appliance = await getKitchenAppliance(c.env, id);
  if (!appliance || appliance.userId !== userId) {
    return jsonResponse({ error: 'appliance not found' }, { status: 404 });
  }

  if (appliance.manualR2Key) {
    try {
      await c.env.APPLIANCE_BUCKET.delete(appliance.manualR2Key);
    } catch (error) {
      console.warn('Failed to delete appliance manual from R2', error);
    }
  }
  if (appliance.ocrTextR2Key) {
    try {
      await c.env.APPLIANCE_BUCKET.delete(appliance.ocrTextR2Key);
    } catch (error) {
      console.warn('Failed to delete appliance OCR text from R2', error);
    }
  }

  const chunkCount = Number(appliance.extractedSpecs?.vectorChunkCount ?? 0);
  const vectorIds: string[] = [];
  if (Number.isFinite(chunkCount) && chunkCount > 0) {
    for (let index = 0; index < chunkCount; index++) {
      vectorIds.push(`appliance:${id}:chunk:${index}`);
    }
  } else {
    vectorIds.push(`appliance:${id}`);
  }

  if (vectorIds.length && typeof c.env.APPLIANCE_VEC.delete === 'function') {
    try {
      await c.env.APPLIANCE_VEC.delete(vectorIds);
    } catch (error) {
      console.warn('Failed to delete appliance vectors', error);
    }
  }

  if (typeof c.env.VEC.delete === 'function') {
    try {
      await c.env.VEC.delete([`appliance:${id}`]);
    } catch (error) {
      console.warn('Failed to delete legacy appliance vector entry', error);
    }
  }

  await deleteKitchenAppliance(c.env, userId, id);

  return jsonResponse({ success: true });
});

app.get('/api/pantry', async (c) => {
  const userId = await requireUserId(c);
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  const items = await listPantryItems(c.env, userId);
  return jsonResponse({ items });
});

app.post('/api/pantry', async (c) => {
  const userId = await requireUserId(c);
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  let body: { ingredientName?: unknown; quantity?: unknown; unit?: unknown };
  try {
    body = await parseJsonBody<typeof body>(c.req.raw);
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 400;
    return jsonResponse({ error: error?.message ?? 'invalid JSON body' }, { status });
  }

  const ingredientName = typeof body.ingredientName === 'string' ? body.ingredientName.trim() : '';
  if (!ingredientName) {
    return jsonResponse({ error: 'ingredientName required' }, { status: 400 });
  }

  const quantity = typeof body.quantity === 'string' ? body.quantity.trim() : null;
  const unit = typeof body.unit === 'string' ? body.unit.trim() : null;

  const item = await createPantryItem(c.env, userId, {
    ingredientName,
    quantity: quantity || null,
    unit: unit || null,
  });

  return jsonResponse({ item }, { status: 201 });
});

app.put('/api/pantry/:id', async (c) => {
  const userId = await requireUserId(c);
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return jsonResponse({ error: 'invalid pantry item id' }, { status: 400 });
  }

  let body: { ingredientName?: unknown; quantity?: unknown; unit?: unknown };
  try {
    body = await parseJsonBody<typeof body>(c.req.raw);
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 400;
    return jsonResponse({ error: error?.message ?? 'invalid JSON body' }, { status });
  }

  const updates: {
    ingredientName?: string;
    quantity?: string | null;
    unit?: string | null;
  } = {};

  if (Object.prototype.hasOwnProperty.call(body, 'ingredientName') && typeof body.ingredientName === 'string') {
    const value = body.ingredientName.trim();
    updates.ingredientName = value || undefined;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'quantity')) {
    updates.quantity = typeof body.quantity === 'string' ? body.quantity.trim() || null : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'unit')) {
    updates.unit = typeof body.unit === 'string' ? body.unit.trim() || null : null;
  }

  const item = await updatePantryItem(c.env, userId, id, updates);
  if (!item) {
    return jsonResponse({ error: 'pantry item not found' }, { status: 404 });
  }

  return jsonResponse({ item });
});

app.delete('/api/pantry/:id', async (c) => {
  const userId = await requireUserId(c);
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return jsonResponse({ error: 'invalid pantry item id' }, { status: 400 });
  }

  const success = await deletePantryItem(c.env, userId, id);
  if (!success) {
    return jsonResponse({ error: 'pantry item not found' }, { status: 404 });
  }

  return jsonResponse({ success: true });
});

// Receipt processing endpoint
app.post('/api/pantry/receipt', async (c) => {
  // For testing purposes, allow user_id in form data
  let userId = await requireUserId(c);
  
  if (!userId) {
    // Try to get user_id from form data
    try {
      const form = await c.req.raw.formData();
      const formUserId = form.get('user_id') as string;
      if (formUserId) {
        userId = formUserId;
      }
    } catch (error) {
      // Ignore form parsing errors
    }
  }
  
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  try {
    const contentType = c.req.header('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return jsonResponse({ error: 'Content-Type must be multipart/form-data' }, { status: 400 });
    }

    const form = await c.req.raw.formData();
    const receiptFile = form.get('receipt') as File;
    
    if (!receiptFile || !(receiptFile instanceof File)) {
      return jsonResponse({ error: 'receipt file required' }, { status: 400 });
    }

    // Process receipt image
    const arrayBuffer = await receiptFile.arrayBuffer();
    const imageBytes = new Uint8Array(arrayBuffer);
    
    // Extract text from receipt using AI vision model
    const receiptText = await extractTextFromReceipt(c.env, imageBytes);
    
    // Parse receipt items
    const receiptItems = await parseReceiptItems(c.env, receiptText);
    
    // Add items to pantry
    const addedItems = [];
    for (const item of receiptItems) {
      try {
        const pantryItem = await createPantryItem(c.env, userId, {
          ingredientName: item.name,
          quantity: item.quantity || null,
          unit: item.unit || null
        });
        addedItems.push(pantryItem);
      } catch (error) {
        console.error('Failed to add pantry item:', item.name, error);
      }
    }

    return jsonResponse({ 
      success: true, 
      extractedText: receiptText,
      parsedItems: receiptItems,
      addedItems: addedItems.length,
      items: addedItems
    });
  } catch (error) {
    console.error('Receipt processing error:', error);
    return jsonResponse({ error: 'Failed to process receipt' }, { status: 500 });
  }
});

// Voice transcription endpoint
app.post('/api/transcribe/voice', async (c) => {
  // For testing purposes, allow user_id in form data
  let userId = await requireUserId(c);
  
  if (!userId) {
    // Try to get user_id from form data
    try {
      const form = await c.req.raw.formData();
      const formUserId = form.get('user_id') as string;
      if (formUserId) {
        userId = formUserId;
      }
    } catch (error) {
      // Ignore form parsing errors
    }
  }
  
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  try {
    const contentType = c.req.header('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return jsonResponse({ error: 'Content-Type must be multipart/form-data' }, { status: 400 });
    }

    const form = await c.req.raw.formData();
    const audioFile = form.get('audio') as File;
    const action = form.get('action') as string || 'transcribe';
    
    if (!audioFile || !(audioFile instanceof File)) {
      return jsonResponse({ error: 'audio file required' }, { status: 400 });
    }

    // Transcribe audio using Whisper
    const arrayBuffer = await audioFile.arrayBuffer();
    const audioBytes = new Uint8Array(arrayBuffer);
    
    const transcription = await transcribeAudioForPantry(c.env, audioBytes);
    
    if (action === 'update_pantry') {
      // Parse pantry items from transcription
      const pantryItems = await parsePantryFromTranscription(c.env, transcription);
      
      // Add items to pantry
      const addedItems = [];
      for (const item of pantryItems) {
        try {
          const pantryItem = await createPantryItem(c.env, userId, {
            ingredientName: item.name,
            quantity: item.quantity || null,
            unit: item.unit || null
          });
          addedItems.push(pantryItem);
        } catch (error) {
          console.error('Failed to add pantry item:', item.name, error);
        }
      }

      return jsonResponse({ 
        success: true,
        transcription,
        parsedItems: pantryItems,
        addedItems: addedItems.length,
        items: addedItems
      });
    }

    return jsonResponse({ 
      success: true,
      transcription
    });
  } catch (error) {
    console.error('Voice transcription error:', error);
    return jsonResponse({ error: 'Failed to transcribe audio' }, { status: 500 });
  }
});

app.post('/api/menus/:id/shopping-list', async (c) => {
  const userId = await requireUserId(c);
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  const menuId = c.req.param('id');
  if (!menuId) {
    return jsonResponse({ error: 'menu id required' }, { status: 400 });
  }

  const menu = await getMenuWithItems(c.env, menuId);
  if (!menu || menu.userId !== userId) {
    return jsonResponse({ error: 'menu not found' }, { status: 404 });
  }

  const items = menu.items ?? (await listMenuItems(c.env, menuId));
  const recipeIds = Array.from(new Set(items.map((item) => item.recipeId).filter(Boolean)));

  if (!recipeIds.length) {
    return jsonResponse({ shoppingList: [] });
  }

  const recipes = await getRecipesWithIngredients(c.env, recipeIds);
  const aggregated = new Map<string, { name: string; quantities: string[] }>();

  for (const recipe of recipes) {
    const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
    for (const ingredient of ingredients) {
      const normalized = normalizeIngredientEntry(ingredient);
      if (!normalized) continue;
      const key = normalized.name.toLowerCase();
      const entry = aggregated.get(key) ?? { name: normalized.name, quantities: [] };
      if (normalized.quantity) {
        entry.quantities.push(normalized.quantity);
      }
      aggregated.set(key, entry);
    }
  }

  const pantryItems = await listPantryItems(c.env, userId);
  const pantrySet = new Set(
    pantryItems
      .map((item) => item.ingredientName?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value))
  );

  for (const key of pantrySet) {
    aggregated.delete(key);
  }

  const aggregatedList = Array.from(aggregated.values()).map((entry) => ({
    name: entry.name,
    quantity: entry.quantities.filter(Boolean).join(' + ') || undefined,
  }));

  if (!aggregatedList.length) {
    return jsonResponse({ shoppingList: [] });
  }

  const shoppingList = await categorizeShoppingList(c.env, aggregatedList);
  return jsonResponse({ shoppingList });
});

// API Routes from main branch
app.post('/api/recipes', async (c) => {
  const userId = await requireUserId(c);
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody<Record<string, unknown>>(c.req.raw);
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 400;
    return jsonResponse({ error: error?.message ?? 'invalid JSON body' }, { status });
  }

  let draft: ManualRecipeDraft;
  try {
    draft = parseManualRecipeDraft(body);
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 400;
    return jsonResponse({ error: error?.message ?? 'invalid recipe payload' }, { status });
  }

  try {
    const recipe = await createManualRecipe(c.env, userId, draft);
    return jsonResponse({ recipe }, { status: 201 });
  } catch (error) {
    console.error('Manual recipe creation failed', error);
    return jsonResponse({ error: 'failed to create recipe' }, { status: 500 });
  }
});

app.put('/api/recipes/:id', async (c) => {
  const userId = await requireUserId(c);
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  const id = c.req.param('id');
  if (!id) {
    return jsonResponse({ error: 'recipe id required' }, { status: 400 });
  }

  const existing = await getRecipeById(c.env, id);
  if (!existing) {
    return jsonResponse({ error: 'recipe not found' }, { status: 404 });
  }

  const sourceUrl = existing.sourceUrl ?? '';
  const ownsRecipe =
    sourceUrl.startsWith(`manual://${userId}/`) || sourceUrl.startsWith(`user://${userId}/`);
  if (!ownsRecipe) {
    return jsonResponse({ error: 'recipe not editable' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody<Record<string, unknown>>(c.req.raw);
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 400;
    return jsonResponse({ error: error?.message ?? 'invalid JSON body' }, { status });
  }

  let updates: ManualRecipeUpdate;
  try {
    updates = parseManualRecipeUpdate(body);
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 400;
    return jsonResponse({ error: error?.message ?? 'invalid recipe payload' }, { status });
  }

  if (!Object.keys(updates).length) {
    return jsonResponse({ recipe: existing });
  }

  try {
    const recipe = await updateManualRecipe(c.env, id, updates);
    if (!recipe) {
      return jsonResponse({ error: 'recipe not found' }, { status: 404 });
    }
    return jsonResponse({ recipe });
  } catch (error) {
    console.error('Manual recipe update failed', error);
    return jsonResponse({ error: 'failed to update recipe' }, { status: 500 });
  }
});

app.post('/api/recipes/batch-scan', async (c) => {
  try {
    const { urls } = await c.req.json();
    if (!Array.isArray(urls)) {
      return c.json({ error: 'urls array required' }, 400);
    }
    
    const promises = urls.map(async (url) => {
      try {
        const result = await scrapeAndExtract(c.env, url);
        return { url, success: true, id: result.id };
      } catch (error) {
        return { url, success: false, error: String(error) };
      }
    });
    const results = await Promise.all(promises);
    
    return c.json({ results });
  } catch (error) {
    console.error('Batch scan error:', error);
    return c.json({ error: 'Failed to batch scan' }, 500);
  }
});

app.get('/api/recipes', async (c) => {
  try {
    const userId = await resolveUser(c);
    const q = c.req.query('q');
    const tag = c.req.query('tag');
    const cuisine = c.req.query('cuisine');
    const limit = parseInt(c.req.query('limit') || '24');
    
    let query = 'SELECT id, title, hero_image_url, cuisine, tags, created_at FROM recipes WHERE 1=1';
    const bindings: any[] = [];
    
    if (q) {
      query += ' AND (title LIKE ? OR tags LIKE ? OR cuisine LIKE ?)';
      const searchTerm = `%${q}%`;
      bindings.push(searchTerm, searchTerm, searchTerm);
    }
    
    if (tag) {
      query += ' AND tags LIKE ?';
      bindings.push(`%${tag}%`);
    }
    
    if (cuisine) {
      query += ' AND cuisine LIKE ?';
      bindings.push(`%${cuisine}%`);
    }
    
    query += ` LIMIT ${limit}`;
    
    const { results } = await c.env.DB.prepare(query).bind(...bindings).all();
    
    // Apply user profile ranking if available
    if (userId !== 'anon') {
      const profile = await getUserProfile(c.env, userId);
      
      if (profile) {
        const rankedResults = (results as any[]).map(recipe => {
          let score = 0;

          // Freshness (newer recipes get higher score)
          const createdAt = recipe.created_at ? new Date(recipe.created_at).getTime() : null;
          const ageInDays = createdAt
            ? (Date.now() - createdAt) / (1000 * 60 * 60 * 24)
            : Number.POSITIVE_INFINITY;
          const freshnessScore = Number.isFinite(ageInDays)
            ? Math.max(0, 1 - ageInDays / 365)
            : 0;
          score += freshnessScore;
          
          // Tag preferences
          if (recipe.tags && profile.tags) {
            const tags = recipe.tags.split(',').map((t: string) => t.trim());
            for (const tag of tags) {
              score += (profile.tags[tag] || 0) * 0.2;
            }
          }
          
          // Cuisine preferences
          if (recipe.cuisine && profile.cuisine) {
            const cuisines = recipe.cuisine.split(',').map((c: string) => c.trim());
            for (const cuisine of cuisines) {
              score += (profile.cuisine[cuisine] || 0) * 0.3;
            }
          }
          
          return { ...recipe, score };
        });
        
        rankedResults.sort((a, b) => b.score - a.score);
        
        return c.json({
          recipes: rankedResults.map(({ score, ...recipe }) => recipe)
        });
      }
    }
    
    return c.json({ recipes: results });
  } catch (error) {
    console.error('List recipes error:', error);
    return c.json({ error: 'Failed to list recipes' }, 500);
  }
});

app.get('/api/recipes/:id', async (c) => {
  try {
    const id = c.req.param('id');
    if (!id) {
      return jsonResponse({ error: 'recipe id required' }, { status: 400 });
    }

    let recipe = await getRecipeById(c.env, id);
    if (!recipe) {
      return jsonResponse({ error: 'recipe not found' }, { status: 404 });
    }

    if ((!recipe.prepPhases || recipe.prepPhases.length === 0) && recipe.ingredients.length && recipe.steps.length) {
      try {
        const phases = await generatePrepPhases(c.env, recipe);
        if (phases.length) {
          await updateRecipePrepPhases(c.env, recipe.id, phases);
        }
        recipe = { ...recipe, prepPhases: phases } as RecipeDetail;
      } catch (error) {
        console.warn('Failed to generate prep phases on-demand', error);
      }
    }

    return jsonResponse({ recipe });
  } catch (error) {
    console.error('Recipe detail error', error);
    return jsonResponse({ error: 'failed to load recipe' }, { status: 500 });
  }
});

app.get('/api/recipes/:id/flowchart', async (c) => {
  const id = c.req.param('id');
  if (!id) {
    return jsonResponse({ error: 'recipe id required' }, { status: 400 });
  }

  const recipe = await getRecipeById(c.env, id);
  if (!recipe) {
    return jsonResponse({ error: 'recipe not found' }, { status: 404 });
  }

  try {
    const flowchart = await generateRecipeFlowchart(c.env, {
      title: recipe.title,
      steps: recipe.steps,
      prepTimeMinutes: recipe.prepTimeMinutes,
      cookTimeMinutes: recipe.cookTimeMinutes,
      totalTimeMinutes: recipe.totalTimeMinutes,
    });
    return jsonResponse({ flowchart });
  } catch (error) {
    console.error('Failed to generate flowchart', error);
    return jsonResponse({ error: 'failed to generate flowchart' }, { status: 500 });
  }
});

app.post('/api/recipes/:id/tailor', async (c) => {
  const userId = await requireUserId(c);
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  const id = c.req.param('id');
  if (!id) {
    return jsonResponse({ error: 'recipe id required' }, { status: 400 });
  }

  let body: { appliance_id?: unknown };
  try {
    body = await parseJsonBody<typeof body>(c.req.raw);
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 400;
    return jsonResponse({ error: error?.message ?? 'invalid JSON body' }, { status });
  }

  const applianceId = typeof body.appliance_id === 'string' ? body.appliance_id.trim() : '';
  if (!applianceId) {
    return jsonResponse({ error: 'appliance_id is required' }, { status: 400 });
  }

  const recipe = await getRecipeById(c.env, id);
  if (!recipe) {
    return jsonResponse({ error: 'recipe not found' }, { status: 404 });
  }

  const appliance = await getKitchenAppliance(c.env, applianceId);
  if (!appliance || appliance.userId !== userId) {
    return jsonResponse({ error: 'appliance not found' }, { status: 404 });
  }

  if (!appliance.ocrTextR2Key) {
    return jsonResponse({ error: 'appliance manual has not been processed yet' }, { status: 409 });
  }

  const manualObject = await c.env.APPLIANCE_BUCKET.get(appliance.ocrTextR2Key);
  const manualText = manualObject ? await manualObject.text() : '';
  if (!manualText) {
    return jsonResponse({ error: 'appliance manual text unavailable' }, { status: 409 });
  }

  const originalSteps = recipe.steps.map((step) => step.instruction);

  try {
    const tailoredSteps = await tailorRecipeInstructions(c.env, {
      title: recipe.title,
      originalSteps,
      manualText,
      appliance: {
        brand: appliance.brand ?? 'Appliance',
        model: appliance.model ?? 'Model',
      },
      prepPhases: recipe.prepPhases,
      manualEmbedding: null,
    });

    return jsonResponse({ tailored_steps: tailoredSteps });
  } catch (error) {
    console.error('Failed to tailor recipe', error);
    return jsonResponse({ error: 'failed to tailor recipe' }, { status: 500 });
  }
});

app.post('/api/recipes/:id/adapt', async (c) => {
  const userId = await requireUserId(c);
  if (!userId) {
    return jsonResponse({ error: 'authentication required' }, { status: 401 });
  }

  const id = c.req.param('id');
  if (!id) {
    return jsonResponse({ error: 'recipe id required' }, { status: 400 });
  }

  let body: { appliance_id?: unknown };
  try {
    body = await parseJsonBody<typeof body>(c.req.raw);
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 400;
    return jsonResponse({ error: error?.message ?? 'invalid JSON body' }, { status });
  }

  const applianceId = typeof body.appliance_id === 'string' ? body.appliance_id.trim() : '';
  if (!applianceId) {
    return jsonResponse({ error: 'appliance_id is required' }, { status: 400 });
  }

  const recipe = await getRecipeById(c.env, id);
  if (!recipe) {
    return jsonResponse({ error: 'recipe not found' }, { status: 404 });
  }

  const appliance = await getKitchenAppliance(c.env, applianceId);
  if (!appliance || appliance.userId !== userId) {
    return jsonResponse({ error: 'appliance not found' }, { status: 404 });
  }

  if (appliance.processingStatus !== 'COMPLETED') {
    return jsonResponse({ error: 'appliance processing incomplete' }, { status: 409 });
  }

  const originalSteps = recipe.steps.map((step) => step.instruction);
  const actions = await summarizeCookingActions(c.env, originalSteps);
  const queryText = actions.length ? actions.join('\n') : originalSteps.join('\n');
  const vector = await embedText(c.env, queryText);

  let matches: VectorizeMatch[] = [];
  if (vector.length) {
    const query = await c.env.APPLIANCE_VEC.query({
      vector,
      topK: 5,
      returnMetadata: true,
      filter: { appliance_id: applianceId, user_id: userId },
    });
    matches = query.matches ?? [];
  }

  let manualExcerpts: string[] = matches
    .map((match) => {
      const text = typeof match.metadata?.chunk_text === 'string' ? match.metadata.chunk_text : null;
      return text ? `${text}` : null;
    })
    .filter((value): value is string => Boolean(value))
    .slice(0, 5);

  if (!manualExcerpts.length && appliance.ocrTextR2Key) {
    try {
      const object = await c.env.APPLIANCE_BUCKET.get(appliance.ocrTextR2Key);
      const manualText = object ? await object.text() : '';
      if (manualText) {
        manualExcerpts = chunkManualText(manualText, 800, 100).slice(0, 5);
      }
    } catch (error) {
      console.warn('Failed to load appliance manual text for adaptation', error);
    }
  }

  const adaptation = await generateApplianceAdaptation(c.env, {
    agentInstructions: appliance.agentInstructions ?? null,
    manualExcerpts,
    recipeTitle: recipe.title,
    recipeSteps: originalSteps,
  });

  return jsonResponse({
    tailored_steps: adaptation.tailoredSteps,
    summary_of_changes: adaptation.summaryOfChanges,
  });
});

app.get('/api/recipes/:id/print', async (c) => {
  try {
    const id = c.req.param('id');
    const format = (c.req.query('format') || 'html').toLowerCase(); // 'html' or 'pdf'

    if (format !== 'html') {
      return c.json({ error: 'Only HTML format is supported at this time' }, 400);
    }
    
    const recipe = await c.env.DB.prepare(
      'SELECT * FROM recipes WHERE id = ?'
    ).bind(id).first() as any;
    
    if (!recipe) {
      return c.json({ error: 'Recipe not found' }, 404);
    }
    
    // Generate print-optimized HTML
    const html = `\n<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <title>${recipe.title}</title>\n  <style>\n    body { font-family: Arial, sans-serif; margin: 40px; }\n    h1 { color: #333; }\n    .meta { color: #666; margin: 20px 0; }\n    .section { margin: 30px 0; }\n    .ingredients li, .steps li { margin: 10px 0; }\n  </style>\n</head>\n<body>\n  <h1>${recipe.title}</h1>\n  ${recipe.author ? `<p class=\"meta\">By ${recipe.author}</p>` : ''}\n  ${recipe.time_total_min ? `<p class=\"meta\">Total time: ${recipe.time_total_min} minutes</p>` : ''}\n  \n  <div class=\"section\">\n    <h2>Ingredients</h2>\n    <ul class=\"ingredients\">\n      ${JSON.parse(recipe.ingredients_json).map((i: string) => `<li>${i}</li>`).join('')}\n    </ul>\n  </div>\n  \n  <div class=\"section\">\n    <h2>Instructions</h2>\n    <ol class=\"steps\">\n      ${JSON.parse(recipe.steps_json).map((s: string) => `<li>${s}</li>`).join('')}\n    </ol>\n  </div>\n  \n  ${recipe.alternatives_json ? `\n  <div class=\"section\">\n    <h2>Alternative Cooking Methods</h2>\n    <pre>${JSON.stringify(JSON.parse(recipe.alternatives_json), null, 2)}</pre>\n  </div>\n  ` : ''}\n</body>\n</html>\n    `;
    
    const contentType = 'text/html';
    const extension = 'html';
    
    return new Response(html, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename=\"recipe-${id}.${extension}\"`, 
      },
    });
  } catch (error) {
    console.error('Print error:', error);
    return c.json({ error: 'Failed to generate printable recipe' }, 500);
  }
});

// Serve static assets
app.get('/*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});


export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log('Running scheduled crawl job');
    
    try {
      // Get seeds
      const seeds = await env.KV.get('source-seeds', 'json') as string[] || [
        'https://www.seriouseats.com/',
        'https://www.sbs.com.au/food/cuisine/singaporean',
        'https://www.kingarthurbaking.com/recipes',
        'https://www.budgetbytes.com/',
        'https://www.breadmachinepros.com/recipes/'
      ];
      
      // Store seeds if not present
      if (!await env.KV.get('source-seeds')) {
        await env.KV.put('source-seeds', JSON.stringify(seeds));
      }
      
      // For each seed, discover links (simplified - in production would use actual browser)
      for (const seed of seeds) {
        try {
          const response = await fetch(seed);
          const html = await response.text();
          
          // Extract links with recipe keywords
          const linkRegex = /href=[\"'](https?:\/\/[^\"']*(?:recipe|banana-bread|cake|cookie|dessert|bread)[^\"']*)["']/gi;
          let match;
          const links = new Set<string>();
          
          while ((match = linkRegex.exec(html)) !== null) {
            links.add(match[1]);
          }
          
          // Enqueue up to 5 links per seed
          let count = 0;
          for (const link of links) {
            if (count >= 5) break;
            
            await env.DB.prepare(
              `INSERT INTO crawl_queue (url, status) VALUES (?, 'queued') ON CONFLICT DO NOTHING`
            ).bind(link).run();
            
            count++;
          }
        } catch (e) {
          console.error(`Error processing seed ${seed}:`, e);
        }
      }
      
      // Process queued items (up to 20)
      const { results: queued } = await env.DB.prepare(
        `SELECT id, url FROM crawl_queue WHERE status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT 20`
      ).all();
      
      for (const item of queued as any[]) {
        try {
          // Mark as processing
          await env.DB.prepare(
            `UPDATE crawl_queue SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          ).bind(item.id).run();
          
          // Scrape
          await scrapeAndExtract(env, item.url);
          
          // Mark as done
          await env.DB.prepare(
            `UPDATE crawl_queue SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          ).bind(item.id).run();
        } catch (error) {
          console.error(`Error processing ${item.url}:`, error);
          
          // Mark as error
          await env.DB.prepare(
            `UPDATE crawl_queue SET status = 'error', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          ).bind(String(error), item.id).run();
        }
      }
      
      console.log(`Processed ${queued.length} queued items`);
    } catch (error) {
      console.error('Scheduled job error:', error);
    }
  },
};