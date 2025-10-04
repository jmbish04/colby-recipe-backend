import { Env } from './env';
import {
  Favorite,
  PrepPhase,
  KitchenAppliance,
  ApplianceProcessingStatus,
  ApplianceSpecs,
  Menu,
  MenuItem,
  NormalizedRecipe,
  PantryItem,
  Rating,
  RecipeDetail,
  RecipeSummary,
  User,
  UserPreferences,
} from './types';
import { buildEmbeddingText, ensureRecipeId, safeDateISOString, truncate } from './utils';
import { embedText, generatePrepPhases, normalizeRecipeFromText } from './ai';

export async function upsertUser(env: Env, user: User): Promise<User> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, picture_url)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       name = excluded.name,
       picture_url = excluded.picture_url,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(user.id, user.email ?? null, user.name ?? null, user.pictureUrl ?? null)
    .run();

  const row = await env.DB.prepare(
    `SELECT id, email, name, picture_url, created_at, updated_at
     FROM users
     WHERE id = ?`
  )
    .bind(user.id)
    .first<{
      id: string;
      email: string | null;
      name: string | null;
      picture_url: string | null;
      created_at: string;
      updated_at: string;
    }>();

  if (!row) {
    throw new Error('Failed to upsert user');
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    pictureUrl: row.picture_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getUserPreferences(env: Env, userId: string): Promise<UserPreferences | null> {
  const stmt = env.DB.prepare(
    `SELECT user_id, cuisines, disliked_ingredients, favored_tools, dietary_restrictions, allergies, skill_level, default_servings, notes, updated_at
     FROM user_prefs WHERE user_id = ?`
  ).bind(userId);
  const row = await stmt.first<{
    user_id: string;
    cuisines: string | null;
    disliked_ingredients: string | null;
    favored_tools: string | null;
    dietary_restrictions: string | null;
    allergies: string | null;
    skill_level: number | null;
    default_servings: number | null;
    notes: string | null;
    updated_at: string;
  }>();

  if (!row) return null;
  return {
    userId: row.user_id,
    cuisines: parseJsonArray(row.cuisines),
    dislikedIngredients: parseJsonArray(row.disliked_ingredients),
    favoredTools: parseJsonArray(row.favored_tools),
    dietaryRestrictions: parseJsonArray(row.dietary_restrictions),
    allergies: parseJsonArray(row.allergies),
    skillLevel: row.skill_level == null ? null : (Number(row.skill_level) as UserPreferences['skillLevel']),
    defaultServings: row.default_servings == null ? null : Number(row.default_servings),
    notes: row.notes,
    updatedAt: row.updated_at,
  };
}

export async function upsertUserPreferences(env: Env, prefs: UserPreferences): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_prefs (user_id, cuisines, disliked_ingredients, favored_tools, dietary_restrictions, allergies, skill_level, default_servings, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       cuisines = excluded.cuisines,
       disliked_ingredients = excluded.disliked_ingredients,
       favored_tools = excluded.favored_tools,
       dietary_restrictions = excluded.dietary_restrictions,
       allergies = excluded.allergies,
       skill_level = excluded.skill_level,
       default_servings = excluded.default_servings,
       notes = excluded.notes,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(
      prefs.userId,
      JSON.stringify(prefs.cuisines ?? []),
      JSON.stringify(prefs.dislikedIngredients ?? []),
      JSON.stringify(prefs.favoredTools ?? []),
      JSON.stringify(prefs.dietaryRestrictions ?? []),
      JSON.stringify(prefs.allergies ?? []),
      prefs.skillLevel ?? null,
      prefs.defaultServings ?? null,
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
  let prepPhases = Array.isArray(recipe.prepPhases) ? recipe.prepPhases : [];
  const shouldGeneratePhases =
    (!prepPhases || prepPhases.length === 0) &&
    ((Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0) ||
      (Array.isArray(recipe.steps) && recipe.steps.length > 0));

  if (shouldGeneratePhases) {
    try {
      prepPhases = await generatePrepPhases(env, recipe);
    } catch (error) {
      console.warn('Failed to generate prep phases for recipe', id, error);
      prepPhases = [];
    }
  }

  await env.DB.prepare(
    `INSERT INTO recipes (id, source_url, source_domain, title, cuisine, tags, hero_image_url, yield, time_prep_min, time_cook_min, time_total_min, ingredients_json, steps_json, equipment_json, prep_phases_json, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
       prep_phases_json = excluded.prep_phases_json,
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
      JSON.stringify(prepPhases ?? []),
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

  recipe.prepPhases = prepPhases;
  return recipe;
}

export async function createFavorite(env: Env, favorite: Favorite): Promise<Favorite> {
  const row = await env.DB.prepare(
    `INSERT INTO favorites (user_id, recipe_id)
     VALUES (?, ?)
     ON CONFLICT(user_id, recipe_id) DO UPDATE SET recipe_id = excluded.recipe_id
     RETURNING user_id, recipe_id, created_at`
  )
    .bind(favorite.userId, favorite.recipeId)
    .first<FavoriteRow>();

  if (!row) {
    // This should be very unlikely with the query above
    throw new Error('Failed to create or retrieve favorite');
  }

  return mapFavoriteRow(row);
}

export async function getFavorite(env: Env, userId: string, recipeId: string): Promise<Favorite | null> {
  const row = await env.DB.prepare(
    `SELECT user_id, recipe_id, created_at
     FROM favorites
     WHERE user_id = ? AND recipe_id = ?`
  )
    .bind(userId, recipeId)
    .first<FavoriteRow>();

  return row ? mapFavoriteRow(row) : null;
}

export async function listFavorites(env: Env, userId: string): Promise<Favorite[]> {
  const { results } = await env.DB.prepare(
    `SELECT user_id, recipe_id, created_at
     FROM favorites
     WHERE user_id = ?
     ORDER BY datetime(created_at) DESC`
  )
    .bind(userId)
    .all<FavoriteRow>();

  return (results ?? []).map(mapFavoriteRow);
}

export async function deleteFavorite(env: Env, userId: string, recipeId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM favorites WHERE user_id = ? AND recipe_id = ?`)
    .bind(userId, recipeId)
    .run();
}

export async function upsertRating(env: Env, rating: Rating): Promise<Rating> {
  const row = await env.DB.prepare(
    `INSERT INTO ratings (user_id, recipe_id, stars, notes, cooked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, recipe_id) DO UPDATE SET
       stars = excluded.stars,
       notes = excluded.notes,
       cooked_at = excluded.cooked_at,
       updated_at = CURRENT_TIMESTAMP
     RETURNING user_id, recipe_id, stars, notes, cooked_at, created_at, updated_at`
  )
    .bind(rating.userId, rating.recipeId, rating.stars, rating.notes ?? null, rating.cookedAt ?? null)
    .first<RatingRow>();

  if (!row) {
    throw new Error('Failed to upsert rating');
  }

  return mapRatingRow(row);
}

export async function getRating(env: Env, userId: string, recipeId: string): Promise<Rating | null> {
  const row = await env.DB.prepare(
    `SELECT user_id, recipe_id, stars, notes, cooked_at, created_at, updated_at
     FROM ratings
     WHERE user_id = ? AND recipe_id = ?`
  )
    .bind(userId, recipeId)
    .first<RatingRow>();

  return row ? mapRatingRow(row) : null;
}

export async function listRatings(env: Env, userId: string): Promise<Rating[]> {
  const { results } = await env.DB.prepare(
    `SELECT user_id, recipe_id, stars, notes, cooked_at, created_at, updated_at
     FROM ratings
     WHERE user_id = ?
     ORDER BY datetime(updated_at) DESC`
  )
    .bind(userId)
    .all<RatingRow>();

  return (results ?? []).map(mapRatingRow);
}

export async function deleteRating(env: Env, userId: string, recipeId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM ratings WHERE user_id = ? AND recipe_id = ?`)
    .bind(userId, recipeId)
    .run();
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

export interface MenuCreationItem {
  recipeId: string;
  dayOfWeek?: number | null;
  mealType?: MenuItem['mealType'];
}

export async function createMenu(
  env: Env,
  input: {
    userId: string;
    title?: string | null;
    weekStartDate?: string | null;
    items: MenuCreationItem[];
  }
): Promise<Menu & { items: MenuItem[] }> {
  const menuId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO menus (id, user_id, title, week_start_date)
     VALUES (?, ?, ?, ?)`
  )
    .bind(menuId, input.userId, input.title ?? null, input.weekStartDate ?? null)
    .run();

  if (input.items.length) {
    for (const item of input.items) {
      await env.DB.prepare(
        `INSERT INTO menu_items (menu_id, recipe_id, day_of_week, meal_type)
         VALUES (?, ?, ?, ?)`
      )
        .bind(menuId, item.recipeId, item.dayOfWeek ?? null, item.mealType ?? null)
        .run();
    }
  }

  const menu = await getMenu(env, menuId);
  if (!menu) {
    throw new Error('Failed to create menu');
  }
  const items = await listMenuItems(env, menuId);
  return { ...menu, items };
}

export async function getMenu(env: Env, id: string): Promise<Menu | null> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, title, week_start_date, created_at, updated_at
     FROM menus
     WHERE id = ?`
  )
    .bind(id)
    .first<MenuRow>();

  return row ? mapMenuRow(row) : null;
}

export async function getMenuWithItems(env: Env, id: string): Promise<(Menu & { items: MenuItem[] }) | null> {
  const menu = await getMenu(env, id);
  if (!menu) {
    return null;
  }
  const items = await listMenuItems(env, id);
  return { ...menu, items };
}

export async function listMenuItems(env: Env, menuId: string): Promise<MenuItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, menu_id, recipe_id, day_of_week, meal_type
     FROM menu_items
     WHERE menu_id = ?
     ORDER BY day_of_week IS NULL, day_of_week, id`
  )
    .bind(menuId)
    .all<MenuItemRow>();

  return (results ?? []).map(mapMenuItemRow);
}

export async function replaceMenuItems(env: Env, menuId: string, items: MenuCreationItem[]): Promise<MenuItem[]> {
  await env.DB.prepare(`DELETE FROM menu_items WHERE menu_id = ?`).bind(menuId).run();

  for (const item of items) {
    await env.DB.prepare(
      `INSERT INTO menu_items (menu_id, recipe_id, day_of_week, meal_type)
       VALUES (?, ?, ?, ?)`
    )
      .bind(menuId, item.recipeId, item.dayOfWeek ?? null, item.mealType ?? null)
      .run();
  }

  return listMenuItems(env, menuId);
}

export async function listPantryItems(env: Env, userId: string): Promise<PantryItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, ingredient_name, quantity, unit, purchase_date, expiry_date, updated_at
     FROM pantry_items
     WHERE user_id = ?
     ORDER BY datetime(updated_at) DESC, id DESC`
  )
    .bind(userId)
    .all<PantryItemRow>();

  return (results ?? []).map(mapPantryItemRow);
}

export async function createPantryItem(
  env: Env,
  userId: string,
  input: { ingredientName: string; quantity?: string | null; unit?: string | null }
): Promise<PantryItem> {
  await env.DB.prepare(
    `INSERT INTO pantry_items (user_id, ingredient_name, quantity, unit, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
  )
    .bind(userId, input.ingredientName, input.quantity ?? null, input.unit ?? null)
    .run();

  const row = await env.DB.prepare(
    `SELECT id, user_id, ingredient_name, quantity, unit, purchase_date, expiry_date, updated_at
     FROM pantry_items
     WHERE rowid = last_insert_rowid()`
  ).first<PantryItemRow>();

  if (!row) {
    throw new Error('Failed to create pantry item');
  }

  return mapPantryItemRow(row);
}

export async function updatePantryItem(
  env: Env,
  userId: string,
  id: number,
  input: { ingredientName?: string; quantity?: string | null; unit?: string | null }
): Promise<PantryItem | null> {
  const existing = await env.DB.prepare(
    `SELECT id FROM pantry_items WHERE id = ? AND user_id = ?`
  )
    .bind(id, userId)
    .first<{ id: number }>();

  if (!existing) {
    return null;
  }

  const hasQuantity = Object.prototype.hasOwnProperty.call(input, 'quantity');
  const hasUnit = Object.prototype.hasOwnProperty.call(input, 'unit');

  await env.DB.prepare(
    `UPDATE pantry_items
     SET ingredient_name = COALESCE(?, ingredient_name),
         quantity = CASE WHEN ? THEN ? ELSE quantity END,
         unit = CASE WHEN ? THEN ? ELSE unit END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  )
    .bind(
      input.ingredientName ?? null,
      hasQuantity ? 1 : 0,
      hasQuantity ? input.quantity ?? null : null,
      hasUnit ? 1 : 0,
      hasUnit ? input.unit ?? null : null,
      id,
      userId
    )
    .run();

  const row = await env.DB.prepare(
    `SELECT id, user_id, ingredient_name, quantity, unit, purchase_date, expiry_date, updated_at
     FROM pantry_items
     WHERE id = ? AND user_id = ?`
  )
    .bind(id, userId)
    .first<PantryItemRow>();

  return row ? mapPantryItemRow(row) : null;
}

export async function deletePantryItem(env: Env, userId: string, id: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM pantry_items WHERE id = ? AND user_id = ?`
  )
    .bind(id, userId)
    .first<{ id: number }>();

  if (!row) {
    return false;
  }

  await env.DB.prepare(`DELETE FROM pantry_items WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .run();

  return true;
}

export async function getRecipesWithIngredients(
  env: Env,
  ids: string[]
): Promise<Array<{ id: string; title: string; ingredients: unknown }>> {
  if (!ids.length) {
    return [];
  }

  const placeholders = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, title, ingredients_json
     FROM recipes
     WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all<RecipeIngredientRow>();

  return (results ?? []).map((row: RecipeIngredientRow) => ({
    id: row.id,
    title: row.title,
    ingredients: row.ingredients_json ? JSON.parse(row.ingredients_json) : [],
  }));
}

export async function getRecipeById(env: Env, id: string): Promise<RecipeDetail | null> {
  const row = await env.DB.prepare(
    `SELECT id, source_url, title, description, author, cuisine, tags, hero_image_url, yield, time_prep_min, time_cook_min, time_total_min, ingredients_json, steps_json, equipment_json, prep_phases_json, notes, created_at, updated_at
     FROM recipes
     WHERE id = ?`
  )
    .bind(id)
    .first<RecipeRow>();

  if (!row) {
    return null;
  }

  let ingredients: unknown = [];
  let steps: unknown = [];
  let equipment: unknown = [];

  try {
    ingredients = row.ingredients_json ? JSON.parse(row.ingredients_json) : [];
  } catch (error) {
    console.warn('Failed to parse ingredients JSON', error);
    ingredients = [];
  }

  try {
    steps = row.steps_json ? JSON.parse(row.steps_json) : [];
  } catch (error) {
    console.warn('Failed to parse steps JSON', error);
    steps = [];
  }

  try {
    equipment = row.equipment_json ? JSON.parse(row.equipment_json) : [];
  } catch (error) {
    console.warn('Failed to parse equipment JSON', error);
    equipment = [];
  }

  const tags = row.tags
    ? row.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];

  const recipe: RecipeDetail = {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    author: row.author,
    cuisine: row.cuisine ?? undefined,
    tags,
    heroImageUrl: row.hero_image_url ?? undefined,
    yield: row.yield ?? undefined,
    prepTimeMinutes: row.time_prep_min == null ? null : Number(row.time_prep_min),
    cookTimeMinutes: row.time_cook_min == null ? null : Number(row.time_cook_min),
    totalTimeMinutes: row.time_total_min == null ? null : Number(row.time_total_min),
    ingredients: Array.isArray(ingredients) ? (ingredients as any[]) : [],
    steps: Array.isArray(steps) ? (steps as any[]) : [],
    tools: Array.isArray(equipment) ? (equipment as any[]) : [],
    notes: row.notes ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    prepPhases: parsePrepPhases(row.prep_phases_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  return recipe;
}

export async function updateRecipePrepPhases(env: Env, id: string, phases: PrepPhase[]): Promise<void> {
  await env.DB.prepare(
    `UPDATE recipes
     SET prep_phases_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  )
    .bind(JSON.stringify(phases ?? []), id)
    .run();
}

export async function createKitchenAppliance(
  env: Env,
  input: {
    id?: string;
    userId: string;
    nickname?: string | null;
    brand?: string | null;
    model?: string | null;
    manualR2Key?: string | null;
    ocrTextR2Key?: string | null;
    agentInstructions?: string | null;
    extractedSpecs?: ApplianceSpecs | null;
    processingStatus?: ApplianceProcessingStatus;
  }
): Promise<KitchenAppliance> {
  const id = input.id ?? crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO kitchen_appliances (
       id,
       user_id,
       nickname,
       brand,
       model,
       extracted_specs_json,
       manual_r2_key,
       ocr_text_r2_key,
       agent_instructions,
       processing_status
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.userId,
      input.nickname ?? null,
      input.brand ?? null,
      input.model ?? null,
      input.extractedSpecs ? JSON.stringify(input.extractedSpecs) : null,
      input.manualR2Key ?? null,
      input.ocrTextR2Key ?? null,
      input.agentInstructions ?? null,
      input.processingStatus ?? 'QUEUED'
    )
    .run();

  const appliance = await getKitchenAppliance(env, id);
  if (!appliance) {
    throw new Error('Failed to create kitchen appliance');
  }
  return appliance;
}

export async function listKitchenAppliances(env: Env, userId: string): Promise<KitchenAppliance[]> {
  const { results } = await env.DB.prepare(
    `SELECT
       id,
       user_id,
       nickname,
       brand,
       model,
       extracted_specs_json,
       manual_r2_key,
       ocr_text_r2_key,
       agent_instructions,
       processing_status,
       created_at,
       updated_at
     FROM kitchen_appliances
     WHERE user_id = ?
     ORDER BY datetime(created_at) DESC`
  )
    .bind(userId)
    .all<KitchenApplianceRow>();

  return (results ?? []).map(mapKitchenApplianceRow);
}

export async function getKitchenAppliance(env: Env, id: string): Promise<KitchenAppliance | null> {
  const row = await env.DB.prepare(
    `SELECT
       id,
       user_id,
       nickname,
       brand,
       model,
       extracted_specs_json,
       manual_r2_key,
       ocr_text_r2_key,
       agent_instructions,
       processing_status,
       created_at,
       updated_at
     FROM kitchen_appliances
     WHERE id = ?`
  )
    .bind(id)
    .first<KitchenApplianceRow>();

  return row ? mapKitchenApplianceRow(row) : null;
}

export async function updateKitchenApplianceFields(
  env: Env,
  id: string,
  updates: {
    nickname?: string | null;
    brand?: string | null;
    model?: string | null;
    agentInstructions?: string | null;
    extractedSpecs?: ApplianceSpecs | null;
    manualR2Key?: string | null;
    ocrTextR2Key?: string | null;
    processingStatus?: ApplianceProcessingStatus;
  }
): Promise<KitchenAppliance | null> {
  const sets: string[] = [];
  const values: any[] = [];

  if (Object.prototype.hasOwnProperty.call(updates, 'nickname')) {
    sets.push('nickname = ?');
    values.push(updates.nickname ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'brand')) {
    sets.push('brand = ?');
    values.push(updates.brand ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'model')) {
    sets.push('model = ?');
    values.push(updates.model ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'agentInstructions')) {
    sets.push('agent_instructions = ?');
    values.push(updates.agentInstructions ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'extractedSpecs')) {
    sets.push('extracted_specs_json = ?');
    values.push(updates.extractedSpecs ? JSON.stringify(updates.extractedSpecs) : null);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'manualR2Key')) {
    sets.push('manual_r2_key = ?');
    values.push(updates.manualR2Key ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'ocrTextR2Key')) {
    sets.push('ocr_text_r2_key = ?');
    values.push(updates.ocrTextR2Key ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'processingStatus')) {
    sets.push('processing_status = ?');
    values.push(updates.processingStatus ?? 'QUEUED');
  }

  if (sets.length === 0) {
    return getKitchenAppliance(env, id);
  }

  sets.push('updated_at = CURRENT_TIMESTAMP');
  await env.DB.prepare(
    `UPDATE kitchen_appliances
     SET ${sets.join(', ')}
     WHERE id = ?`
  )
    .bind(...values, id)
    .run();

  return getKitchenAppliance(env, id);
}

export async function deleteKitchenAppliance(env: Env, userId: string, id: string): Promise<KitchenAppliance | null> {
  const appliance = await getKitchenAppliance(env, id);
  if (!appliance || appliance.userId !== userId) {
    return null;
  }

  await env.DB.prepare(`DELETE FROM kitchen_appliances WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .run();

  return appliance;
}

export interface UserProfile {
  userId: string;
  tags: Record<string, number>;
  cuisine: Record<string, number>;
  updatedAt: string;
}

export async function getUserProfile(env: Env, userId: string): Promise<UserProfile | null> {
  const prefs = await getUserPreferences(env, userId);
  if (!prefs) {
    return null;
  }

  const tags: Record<string, number> = {};
  const cuisine: Record<string, number> = {};

  for (const name of prefs.favoredTools) {
    const key = name.trim();
    if (key) {
      tags[key] = Math.max(tags[key] ?? 0, 1);
    }
  }

  for (const disliked of prefs.dislikedIngredients) {
    const key = disliked.trim();
    if (key) {
      const current = tags[key] ?? 0;
      tags[key] = current < 0 ? current : -1;
    }
  }

  for (const cuisineName of prefs.cuisines) {
    const key = cuisineName.trim();
    if (key) {
      cuisine[key] = Math.max(cuisine[key] ?? 0, 1.2);
    }
  }

  return {
    userId: prefs.userId,
    tags,
    cuisine,
    updatedAt: prefs.updatedAt ?? safeDateISOString(),
  };
}

export async function scrapeAndExtract(env: Env, url: string): Promise<NormalizedRecipe> {
  if (!url) {
    throw new Error('URL is required');
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch recipe (${response.status})`);
  }

  const html = await response.text();
  const fromJsonLd = extractRecipeFromJsonLd(html, url);

  const normalized = fromJsonLd ?? (await normalizeRecipeFromText(env, html, url));
  normalized.id = ensureRecipeId(normalized, crypto.randomUUID());
  normalized.sourceUrl = normalized.sourceUrl ?? url;

  await storeIngestion(env, {
    sourceType: 'url',
    sourceRef: url,
    raw: truncate(html),
    recipe: normalized,
  });

  return upsertRecipeFromIngestion(env, normalized);
}

function extractRecipeFromJsonLd(html: string, sourceUrl: string): NormalizedRecipe | null {
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRegex.exec(html)) !== null) {
    const payload = match[1]?.trim();
    if (!payload) continue;

    try {
      const parsed = JSON.parse(decodeHtmlEntities(payload));
      const recipeNode = findRecipeNode(parsed);
      if (recipeNode) {
        return normalizeJsonLdRecipe(recipeNode, sourceUrl);
      }
    } catch (error) {
      console.warn('Failed to parse JSON-LD recipe', error);
    }
  }

  return null;
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function findRecipeNode(data: unknown): Record<string, unknown> | null {
  if (!data) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof data !== 'object') {
    return null;
  }

  const node = data as Record<string, unknown>;
  const type = node['@type'];
  if (isRecipeType(type)) {
    return node;
  }

  if (node['@graph']) {
    const foundInGraph = findRecipeNode(node['@graph']);
    if (foundInGraph) return foundInGraph;
  }

  if (node.mainEntity) {
    const foundInMain = findRecipeNode(node.mainEntity);
    if (foundInMain) return foundInMain;
  }

  if (node.itemListElement) {
    const foundInList = findRecipeNode(node.itemListElement);
    if (foundInList) return foundInList;
  }

  return null;
}

function isRecipeType(type: unknown): boolean {
  if (!type) return false;
  if (typeof type === 'string') {
    return type.toLowerCase() === 'recipe';
  }
  if (Array.isArray(type)) {
    return type.some((value) => typeof value === 'string' && value.toLowerCase() === 'recipe');
  }
  return false;
}

function normalizeJsonLdRecipe(node: Record<string, unknown>, sourceUrl: string): NormalizedRecipe {
  const tags = new Set<string>();

  const keywords = node['keywords'];
  if (typeof keywords === 'string') {
    keywords
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => tags.add(item));
  } else if (Array.isArray(keywords)) {
    for (const item of keywords) {
      if (typeof item === 'string' && item.trim()) {
        tags.add(item.trim());
      }
    }
  }

  const recipeCategory = node['recipeCategory'];
  if (typeof recipeCategory === 'string' && recipeCategory.trim()) {
    tags.add(recipeCategory.trim());
  } else if (Array.isArray(recipeCategory)) {
    for (const item of recipeCategory) {
      if (typeof item === 'string' && item.trim()) {
        tags.add(item.trim());
      }
    }
  }

  const cuisineValues = normalizeStringArray(node['recipeCuisine']);
  cuisineValues.forEach((value) => tags.add(value));

  const ingredients = normalizeIngredients(node['recipeIngredient']);
  const steps = normalizeInstructions(node['recipeInstructions']);
  const tools = normalizeStringArray(node['tool']);

  const heroImageUrl = resolveImageUrl(node['image']);

  const title = getString(node, 'name');
  const description = getString(node, 'description');
  const identifier = getString(node, 'identifier');
  const recipeYield = getString(node, 'recipeYield');
  const note = getString(node, 'note') ?? getString(node, 'notes');

  return {
    id: identifier ?? crypto.randomUUID(),
    title: title && title.trim() ? title.trim() : 'Untitled Recipe',
    description: description ?? undefined,
    cuisine: cuisineValues[0] ?? undefined,
    tags: Array.from(tags),
    heroImageUrl: heroImageUrl ?? undefined,
    yield: recipeYield ?? undefined,
    prepTimeMinutes: toMinutes(node['prepTime']),
    cookTimeMinutes: toMinutes(node['cookTime']),
    totalTimeMinutes: toMinutes(node['totalTime']),
    ingredients,
    steps,
    tools,
    notes: note ?? undefined,
    sourceUrl,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
  }
  return [];
}

function normalizeIngredients(value: unknown): NormalizedRecipe['ingredients'] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          const trimmed = item.trim();
          return trimmed ? { name: trimmed } : null;
        }
        if (item && typeof item === 'object') {
          const ingredient = item as Record<string, unknown>;
          const rawName = typeof ingredient.text === 'string'
            ? ingredient.text
            : typeof ingredient.name === 'string'
              ? ingredient.name
              : '';
          const quantity = typeof ingredient.quantity === 'string' ? ingredient.quantity : undefined;
          const notes = typeof ingredient.note === 'string' ? ingredient.note : undefined;
          const name = rawName.trim();
          if (!name) return null;
          return { name, quantity, notes };
        }
        return null;
      })
      .filter((ingredient): ingredient is { name: string; quantity?: string; notes?: string } => Boolean(ingredient));
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ name: line }));
  }
  return [];
}

function normalizeInstructions(value: unknown): NormalizedRecipe['steps'] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return { instruction: item.trim() };
        }
        if (item && typeof item === 'object') {
          const step = item as Record<string, unknown>;
          const text = typeof step.text === 'string'
            ? step.text
            : typeof step.instruction === 'string'
              ? step.instruction
              : typeof step.description === 'string'
                ? step.description
                : '';
          const titleValue = typeof step.name === 'string' ? step.name : undefined;
          if (!text.trim()) return null;
          return { title: titleValue, instruction: text.trim() };
        }
        return null;
      })
      .filter((step): step is { title?: string; instruction: string } => Boolean(step));
  }
  if (typeof value === 'string') {
    return value
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ instruction: line }));
  }
  return [];
}

function getString(node: Record<string, unknown>, key: string): string | null {
  const value = node[key];
  return typeof value === 'string' ? value : null;
}

function resolveImageUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    return value.trim() || null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = resolveImageUrl(item);
      if (resolved) return resolved;
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.url === 'string' && record.url.trim()) {
      return record.url.trim();
    }
  }
  return null;
}

function toMinutes(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!match) {
    return null;
  }

  const hours = match[1] ? parseInt(match[1], 10) : 0;
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const seconds = match[3] ? parseInt(match[3], 10) : 0;

  const totalMinutes = hours * 60 + minutes + Math.round(seconds / 60);
  return Number.isNaN(totalMinutes) ? null : totalMinutes;
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

function parsePrepPhases(value: string | null): PrepPhase[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item: any): PrepPhase | null => {
        if (!item) return null;
        const title =
          typeof item.phaseTitle === 'string'
            ? item.phaseTitle
            : typeof item.phase_title === 'string'
              ? item.phase_title
              : null;
        if (!title) return null;
        const ingredients = Array.isArray(item.ingredients)
          ? item.ingredients
              .map((ingredient: any) => {
                if (!ingredient) return null;
                const name =
                  typeof ingredient.name === 'string'
                    ? ingredient.name
                    : typeof ingredient.ingredient === 'string'
                      ? ingredient.ingredient
                      : typeof ingredient.text === 'string'
                        ? ingredient.text
                        : '';
                const normalized = name.trim();
                if (!normalized) return null;
                const quantity =
                  typeof ingredient.quantity === 'string'
                    ? ingredient.quantity.trim() || undefined
                    : typeof ingredient.amount === 'string'
                      ? ingredient.amount.trim() || undefined
                      : undefined;
                const notes = typeof ingredient.notes === 'string' ? ingredient.notes.trim() || undefined : undefined;
                return {
                  name: normalized,
                  quantity,
                  notes,
                };
              })
              .filter(
                (value: { name: string; quantity?: string; notes?: string } | null): value is {
                  name: string;
                  quantity?: string;
                  notes?: string;
                } => Boolean(value)
              )
          : [];
        return {
          phaseTitle: title,
          ingredients,
        };
      })
      .filter((value): value is PrepPhase => Boolean(value));
  } catch (error) {
    console.warn('Failed to parse prep phases JSON', error);
    return [];
  }
}

type FavoriteRow = {
  user_id: string;
  recipe_id: string;
  created_at: string;
};

type RatingRow = {
  user_id: string;
  recipe_id: string;
  stars: number;
  notes: string | null;
  cooked_at: string | null;
  created_at: string;
  updated_at: string;
};

type MenuRow = {
  id: string;
  user_id: string;
  title: string | null;
  week_start_date: string | null;
  created_at: string;
  updated_at: string;
};

type MenuItemRow = {
  id: number;
  menu_id: string;
  recipe_id: string;
  day_of_week: number | null;
  meal_type: string | null;
};

type PantryItemRow = {
  id: number;
  user_id: string;
  ingredient_name: string;
  quantity: string | null;
  unit: string | null;
  purchase_date: string | null;
  expiry_date: string | null;
  updated_at: string;
};

type RecipeIngredientRow = {
  id: string;
  title: string;
  ingredients_json: string | null;
};

type RecipeRow = {
  id: string;
  source_url: string | null;
  title: string;
  description: string | null;
  author: string | null;
  cuisine: string | null;
  tags: string | null;
  hero_image_url: string | null;
  yield: string | null;
  time_prep_min: number | null;
  time_cook_min: number | null;
  time_total_min: number | null;
  ingredients_json: string | null;
  steps_json: string | null;
  equipment_json: string | null;
  prep_phases_json: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type KitchenApplianceRow = {
  id: string;
  user_id: string;
  nickname: string | null;
  brand: string | null;
  model: string | null;
  extracted_specs_json: string | null;
  manual_r2_key: string | null;
  ocr_text_r2_key: string | null;
  agent_instructions: string | null;
  processing_status: string;
  created_at: string;
  updated_at: string;
};

function mapFavoriteRow(row: FavoriteRow): Favorite {
  return {
    userId: row.user_id,
    recipeId: row.recipe_id,
    createdAt: row.created_at,
  };
}

function mapRatingRow(row: RatingRow): Rating {
  return {
    userId: row.user_id,
    recipeId: row.recipe_id,
    stars: row.stars,
    notes: row.notes,
    cookedAt: row.cooked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMenuRow(row: MenuRow): Menu {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    weekStartDate: row.week_start_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMenuItemRow(row: MenuItemRow): MenuItem {
  return {
    id: row.id,
    menuId: row.menu_id,
    recipeId: row.recipe_id,
    dayOfWeek: row.day_of_week == null ? null : (row.day_of_week as MenuItem['dayOfWeek']),
    mealType: row.meal_type ? (row.meal_type as MenuItem['mealType']) : null,
  };
}

function mapPantryItemRow(row: PantryItemRow): PantryItem {
  return {
    id: row.id,
    userId: row.user_id,
    ingredientName: row.ingredient_name,
    quantity: row.quantity,
    unit: row.unit,
    purchaseDate: row.purchase_date,
    expiryDate: row.expiry_date,
    updatedAt: row.updated_at,
  };
}

function mapKitchenApplianceRow(row: KitchenApplianceRow): KitchenAppliance {
  let extractedSpecs: ApplianceSpecs | null = null;
  if (row.extracted_specs_json) {
    try {
      const parsed = JSON.parse(row.extracted_specs_json) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        const keyFeatures = Array.isArray((parsed as any).key_features)
          ? (parsed as any).key_features.map((value: unknown) => String(value))
          : Array.isArray((parsed as any).keyFeatures)
            ? (parsed as any).keyFeatures.map((value: unknown) => String(value))
            : undefined;
        extractedSpecs = {
          ...(parsed as Record<string, unknown>),
          brand: typeof parsed.brand === 'string' ? parsed.brand : null,
          model: typeof parsed.model === 'string' ? parsed.model : null,
          capacity: typeof parsed.capacity === 'string' ? parsed.capacity : null,
          wattage: typeof parsed.wattage === 'string' ? parsed.wattage : null,
          keyFeatures,
          vectorChunkCount: Number.isFinite(Number((parsed as any).vectorChunkCount))
            ? Number((parsed as any).vectorChunkCount)
            : Number.isFinite(Number((parsed as any).__vectorChunkCount))
              ? Number((parsed as any).__vectorChunkCount)
              : undefined,
        } as ApplianceSpecs;
      }
    } catch (error) {
      console.warn('Failed to parse appliance specs JSON', error);
    }
  }

  return {
    id: row.id,
    userId: row.user_id,
    nickname: row.nickname,
    brand: row.brand,
    model: row.model,
    extractedSpecs,
    manualR2Key: row.manual_r2_key,
    ocrTextR2Key: row.ocr_text_r2_key,
    agentInstructions: row.agent_instructions,
    processingStatus: normalizeProcessingStatus(row.processing_status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeProcessingStatus(value: string | null | undefined): ApplianceProcessingStatus {
  switch (value) {
    case 'PROCESSING':
    case 'COMPLETED':
    case 'FAILED':
    case 'QUEUED':
      return value;
    default:
      return 'QUEUED';
  }
}
