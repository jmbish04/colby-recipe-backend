import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, VectorizeMatch } from './env';
import { requireApiKey } from './auth';
import { ensureRecipeId, jsonResponse, parseArray, parseJsonBody, truncate } from './utils';
import { extractTextFromImage, generateChatMessage, normalizeRecipeFromText, transcribeAudio, embedText } from './ai';
import {
  getUserPreferences,
  listRecipesByIds,
  recentThemeRecipes,
  storeIngestion,
  upsertRecipeFromIngestion,
  upsertUserPreferences,
  getUserProfile,
  scrapeAndExtract,
} from './db';
import { RecipeSummary, UserPreferences } from './types';

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
  // In a real app, this would involve session validation, JWT decoding, etc.
  // For now, we'll allow a user_id query parameter for testing.
  return c.req.query('user_id') || 'anon';
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

// API Routes from main branch
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