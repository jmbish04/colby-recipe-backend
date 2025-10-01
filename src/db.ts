import { Env } from './env';
import { NormalizedRecipe, RecipeSummary, UserPreferences } from './types';
import { buildEmbeddingText } from './utils';
import { embedText } from './ai';

export async function getUserPreferences(env: Env, userId: string): Promise<UserPreferences | null> {
  const stmt = env.DB.prepare(
    `SELECT user_id, cuisines, disliked_ingredients, favored_tools, notes, updated_at
     FROM user_prefs WHERE user_id = ?`
  ).bind(userId);
  const row = await stmt.first<{
    user_id: string;
    cuisines: string | null;
    disliked_ingredients: string | null;
    favored_tools: string | null;
    notes: string | null;
    updated_at: string;
  }>();

  if (!row) return null;
  return {
    userId: row.user_id,
    cuisines: parseJsonArray(row.cuisines),
    dislikedIngredients: parseJsonArray(row.disliked_ingredients),
    favoredTools: parseJsonArray(row.favored_tools),
    notes: row.notes,
    updatedAt: row.updated_at,
  };
}

export async function upsertUserPreferences(env: Env, prefs: UserPreferences): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_prefs (user_id, cuisines, disliked_ingredients, favored_tools, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       cuisines = excluded.cuisines,
       disliked_ingredients = excluded.disliked_ingredients,
       favored_tools = excluded.favored_tools,
       notes = excluded.notes,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(
      prefs.userId,
      JSON.stringify(prefs.cuisines ?? []),
      JSON.stringify(prefs.dislikedIngredients ?? []),
      JSON.stringify(prefs.favoredTools ?? []),
      prefs.notes ?? null
    )
    .run();
}

export async function storeIngestion(env: Env, input: {
  sourceType: 'url' | 'image';
  sourceRef: string;
  raw: string;
  recipe: NormalizedRecipe;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ingestions (source_type, source_ref, raw, recipe_json)
     VALUES (?, ?, ?, ?)`
  )
    .bind(input.sourceType, input.sourceRef, input.raw, JSON.stringify(input.recipe))
    .run();
}

export async function upsertRecipeFromIngestion(env: Env, recipe: NormalizedRecipe): Promise<NormalizedRecipe> {
  const id = recipe.id;
  const domain = recipe.sourceUrl ? new URL(recipe.sourceUrl).hostname : 'local';
  const tags = recipe.tags?.join(',');
  await env.DB.prepare(
    `INSERT INTO recipes (id, source_url, source_domain, title, cuisine, tags, hero_image_url, yield, time_prep_min, time_cook_min, time_total_min, ingredients_json, steps_json, equipment_json, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(source_url) DO UPDATE SET
       id = excluded.id,
       title = excluded.title,
       cuisine = excluded.cuisine,
       tags = excluded.tags,
       hero_image_url = excluded.hero_image_url,
       yield = excluded.yield,
       time_prep_min = excluded.time_prep_min,
       time_cook_min = excluded.time_cook_min,
       time_total_min = excluded.time_total_min,
       ingredients_json = excluded.ingredients_json,
       steps_json = excluded.steps_json,
       equipment_json = excluded.equipment_json,
       notes = excluded.notes,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(
      id,
      recipe.sourceUrl ?? `ingestion:${id}`,
      domain,
      recipe.title,
      recipe.cuisine ?? null,
      tags ?? null,
      recipe.heroImageUrl ?? null,
      recipe.yield ?? null,
      recipe.prepTimeMinutes ?? null,
      recipe.cookTimeMinutes ?? null,
      recipe.totalTimeMinutes ?? null,
      JSON.stringify(recipe.ingredients ?? []),
      JSON.stringify(recipe.steps ?? []),
      JSON.stringify(recipe.tools ?? []),
      recipe.notes ?? null
    )
    .run();

  const text = buildEmbeddingText(recipe);
  const embedding = await embedText(env, text);
  if (embedding.length) {
    await env.VEC.upsert([
      {
        id,
        values: embedding,
        metadata: {
          recipe_id: id,
          title: recipe.title,
          tags: recipe.tags ?? [],
          cuisine: recipe.cuisine,
        },
      },
    ]);
  }

  return recipe;
}

export async function listRecipesByIds(env: Env, ids: string[]): Promise<Record<string, RecipeSummary>> {
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const stmt = env.DB.prepare(
    `SELECT id, title, cuisine, tags, hero_image_url FROM recipes WHERE id IN (${placeholders})`
  ).bind(...ids);
  const { results } = await stmt.all<{
    id: string;
    title: string;
    cuisine: string | null;
    tags: string | null;
    hero_image_url: string | null;
  }>();

  const map: Record<string, RecipeSummary> = {};
  for (const row of results ?? []) {
    map[row.id] = {
      id: row.id,
      title: row.title,
      cuisine: row.cuisine,
      tags: row.tags ? row.tags.split(',').map((tag: string) => tag.trim()).filter(Boolean) : [],
      heroImageUrl: row.hero_image_url,
    };
  }
  return map;
}

export async function recentThemeRecipes(env: Env, seed: string, limit = 12): Promise<RecipeSummary[]> {
  const like = `%${seed}%`;
  const stmt = env.DB.prepare(
    `SELECT id, title, cuisine, tags, hero_image_url
     FROM recipes
     WHERE (tags LIKE ? OR title LIKE ? OR cuisine LIKE ?)
     ORDER BY datetime(updated_at) DESC
     LIMIT ?`
  ).bind(like, like, like, limit);

  const { results } = await stmt.all<{
    id: string;
    title: string;
    cuisine: string | null;
    tags: string | null;
    hero_image_url: string | null;
  }>();

  const mapped: RecipeSummary[] = [];
  for (const row of results ?? []) {
    mapped.push({
      id: row.id,
      title: row.title,
      cuisine: row.cuisine,
      tags: row.tags ? row.tags.split(',').map((tag: string) => tag.trim()).filter(Boolean) : [],
      heroImageUrl: row.hero_image_url,
    });
  }
  return mapped;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item));
    }
  } catch (error) {
    console.warn('Failed to parse JSON array', error);
  }
  return [];
}
