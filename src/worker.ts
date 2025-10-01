import { Env, VectorizeMatch } from './env';
import { requireApiKey } from './auth';
import { ensureRecipeId, jsonResponse, parseArray, parseJsonBody, safeDateISOString, truncate } from './utils';
import { extractTextFromImage, generateChatMessage, normalizeRecipeFromText, transcribeAudio, embedText } from './ai';
import {
  getUserPreferences,
  listRecipesByIds,
  recentThemeRecipes,
  storeIngestion,
  upsertRecipeFromIngestion,
  upsertUserPreferences,
} from './db';
import { RecipeSummary, UserPreferences } from './types';

interface RequestLogEntry {
  ts: string;
  level: string;
  route: string;
  method: string;
  status: number;
  ms: number;
  msg: string;
  meta?: Record<string, unknown>;
}

async function logRequest(env: Env, entry: RequestLogEntry): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO request_logs (ts, level, route, method, status, ms, msg, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(entry.ts, entry.level, entry.route, entry.method, entry.status, entry.ms, entry.msg, JSON.stringify(entry.meta ?? {}))
    .run();
}

function methodNotAllowed(): Response {
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
}

async function handleChatIngredients(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  const body = await parseJsonBody<{
    ingredients?: unknown;
    theme?: unknown;
    tools?: unknown;
    userId?: unknown;
  }>(request);

  const ingredients = parseArray(body.ingredients);
  if (!ingredients.length) {
    return jsonResponse({ error: 'ingredients array required' }, { status: 400 });
  }
  const theme = typeof body.theme === 'string' ? body.theme.trim() : '';
  const tools = parseArray(body.tools);
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';

  const prefs = userId ? await getUserPreferences(env, userId) : null;

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
  const vector = await embedText(env, embeddingText);

  const matches = vector.length
    ? await env.VEC.query({
        vector,
        topK: 50,
        returnMetadata: true,
      })
    : { matches: [] };

  const recipeIds = (matches.matches ?? [])
    .map((match) => match.metadata?.recipe_id || match.id)
    .filter((value): value is string => Boolean(value));

  const recipeMap = await listRecipesByIds(env, recipeIds);

  const scored = (matches.matches ?? [])
    .map((match) => {
      const recipe = recipeMap[match.metadata?.recipe_id ?? match.id];
      if (!recipe) return null;
      const score = computeRecipeScore(recipe, match, prefs, tools, theme, ingredients);
      return { ...recipe, score };
    })
    .filter((value): value is RecipeSummary & { score: number } => Boolean(value));

  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const suggestions = scored.slice(0, 5).map(({ score, ...rest }) => rest);

  const prompt = `${contextPieces.join('\n')}\n\nTop candidate recipes:\n${scored
    .slice(0, 10)
    .map((recipe, index) => `${index + 1}. ${recipe.title}`)
    .join('\n')}`;

  const message = await generateChatMessage(env, prompt);

  return jsonResponse({ suggestions, message });
}

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

async function handleTranscribe(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return jsonResponse({ error: 'file required' }, { status: 400 });
  }
  const buffer = new Uint8Array(await file.arrayBuffer());
  const text = await transcribeAudio(env, buffer);
  return jsonResponse({ text });
}

async function handleIngestUrl(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  const body = await parseJsonBody<{ url?: unknown }>(request);
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) {
    return jsonResponse({ error: 'url required' }, { status: 400 });
  }

  const session = await env.BROWSER.newSession({});
  const page = await session.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    const rawHtml = await page.content();
    const normalized = await normalizeRecipeFromText(env, rawHtml, url);
    normalized.id = ensureRecipeId(normalized, crypto.randomUUID());
    normalized.sourceUrl = url;

    await storeIngestion(env, {
      sourceType: 'url',
      sourceRef: url,
      raw: truncate(rawHtml),
      recipe: normalized,
    });

    const stored = await upsertRecipeFromIngestion(env, normalized);

    return jsonResponse({ recipe: stored });
  } finally {
    await page.close();
    await session.close();
  }
}

async function handleIngestImage(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  const form = await request.formData();
  const files = [...form.values()].filter((value): value is File => value instanceof File);
  if (!files.length) {
    return jsonResponse({ error: 'image files required' }, { status: 400 });
  }

  let combinedText = '';
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = await extractTextFromImage(env, bytes);
    combinedText += `\n\nImage ${file.name}:\n${text}`;
  }

  const normalized = await normalizeRecipeFromText(env, combinedText.trim());
  normalized.id = ensureRecipeId(normalized, crypto.randomUUID());

  await storeIngestion(env, {
    sourceType: 'image',
    sourceRef: files.map((file) => file.name).join(','),
    raw: combinedText.trim(),
    recipe: normalized,
  });

  const stored = await upsertRecipeFromIngestion(env, normalized);

  return jsonResponse({ recipe: stored });
}

async function handleGetPrefs(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  if (!userId) {
    return jsonResponse({ error: 'userId required' }, { status: 400 });
  }
  const prefs = await getUserPreferences(env, userId);
  return jsonResponse({ preferences: prefs });
}

async function handlePutPrefs(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'PUT') return methodNotAllowed();
  const body = await parseJsonBody<{
    userId?: unknown;
    cuisines?: unknown;
    dislikedIngredients?: unknown;
    favoredTools?: unknown;
    notes?: unknown;
  }>(request);

  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (!userId) {
    return jsonResponse({ error: 'userId required' }, { status: 400 });
  }

  const prefs: UserPreferences = {
    userId,
    cuisines: parseArray(body.cuisines),
    dislikedIngredients: parseArray(body.dislikedIngredients),
    favoredTools: parseArray(body.favoredTools),
    notes: typeof body.notes === 'string' ? body.notes : null,
  };

  await upsertUserPreferences(env, prefs);

  const stored = await getUserPreferences(env, userId);
  return jsonResponse({ preferences: stored });
}

async function handleThemesSuggest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const seed = (url.searchParams.get('seed') || '').trim();
  if (!seed) {
    return jsonResponse({ error: 'seed required' }, { status: 400 });
  }

  const seedEmbedding = await embedText(env, seed);
  const vectorResults = seedEmbedding.length
    ? await env.VEC.query({ vector: seedEmbedding, topK: 20, returnMetadata: true })
    : { matches: [] };

  const ids = (vectorResults.matches ?? [])
    .map((match) => match.metadata?.recipe_id ?? match.id)
    .filter((value): value is string => Boolean(value));
  const recipeMap = await listRecipesByIds(env, ids);
  const vectorSuggestions = (vectorResults.matches ?? [])
    .map((match) => recipeMap[match.metadata?.recipe_id ?? match.id])
    .filter((value): value is RecipeSummary => Boolean(value));

  const sqlSuggestions = await recentThemeRecipes(env, seed, 12);
  const merged: Record<string, RecipeSummary> = {};
  for (const recipe of [...vectorSuggestions, ...sqlSuggestions]) {
    merged[recipe.id] = recipe;
  }

  const suggestions = Object.values(merged).slice(0, 12);
  return jsonResponse({ theme: seed, recipes: suggestions });
}

async function handleLogs(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
  const level = url.searchParams.get('level');

  let query = 'SELECT ts, level, route, method, status, ms, msg, meta FROM request_logs ORDER BY datetime(ts) DESC LIMIT ?';
  const bindings: (string | number)[] = [limit];
  if (level) {
    query = 'SELECT ts, level, route, method, status, ms, msg, meta FROM request_logs WHERE level = ? ORDER BY datetime(ts) DESC LIMIT ?';
    bindings.unshift(level);
  }

  const { results } = await env.DB.prepare(query).bind(...bindings).all<{
    ts: string;
    level: string;
    route: string;
    method: string;
    status: number;
    ms: number;
    msg: string;
    meta: string | null;
  }>();

  const items: Array<{
    ts: string;
    level: string;
    route: string;
    method: string;
    status: number;
    ms: number;
    msg: string;
    meta: Record<string, unknown>;
  }> = [];
  for (const row of results ?? []) {
    items.push({
      ts: row.ts,
      level: row.level,
      route: row.route,
      method: row.method,
      status: row.status,
      ms: row.ms,
      msg: row.msg,
      meta: row.meta ? JSON.parse(row.meta) : {},
    });
  }

  return jsonResponse({ items });
}

async function routeApiRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const routeStart = Date.now();

  const authError = requireApiKey(request, env);
  if (authError) {
    return authError;
  }

  let response: Response;
  try {
    if (path === '/api/chat/ingredients') {
      response = await handleChatIngredients(request, env);
    } else if (path === '/api/transcribe') {
      response = await handleTranscribe(request, env);
    } else if (path === '/api/ingest/url') {
      response = await handleIngestUrl(request, env);
    } else if (path === '/api/ingest/image') {
      response = await handleIngestImage(request, env);
    } else if (path === '/api/prefs' && request.method === 'GET') {
      response = await handleGetPrefs(request, env);
    } else if (path === '/api/prefs' && request.method === 'PUT') {
      response = await handlePutPrefs(request, env);
    } else if (path === '/api/themes/suggest') {
      response = await handleThemesSuggest(request, env);
    } else if (path === '/api/logs') {
      response = await handleLogs(request, env);
    } else {
      response = jsonResponse({ error: 'Not found' }, { status: 404 });
    }
  } catch (error) {
    console.error('Request error', error);
    response = jsonResponse({ error: (error as Error).message ?? 'Internal error' }, { status: (error as any)?.status ?? 500 });
  }

  const duration = Date.now() - routeStart;
  ctx.waitUntil(
    logRequest(env, {
      ts: safeDateISOString(),
      level: response.ok ? 'info' : 'error',
      route: path,
      method: request.method,
      status: response.status,
      ms: duration,
      msg: response.ok ? 'ok' : 'error',
    })
  );

  return response;
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    return routeApiRequest(request, env, ctx);
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};
