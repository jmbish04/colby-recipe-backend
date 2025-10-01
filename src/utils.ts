import { NormalizedRecipe } from './types';

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { ...init, headers });
}

export async function parseJsonBody<T>(request: Request): Promise<T> {
  try {
    return await request.json<T>();
  } catch (error) {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

export function parseArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

export function truncate(input: string, max = 20000): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}\u2026`;
}

export function buildEmbeddingText(recipe: NormalizedRecipe): string {
  const parts: string[] = [recipe.title];
  if (recipe.description) parts.push(recipe.description);
  if (recipe.cuisine) parts.push(recipe.cuisine);
  if (recipe.tags?.length) parts.push(recipe.tags.join(' '));
  const ingredientText = recipe.ingredients.map((ingredient) => `${ingredient.quantity ?? ''} ${ingredient.name}`.trim()).join('\n');
  if (ingredientText) parts.push(ingredientText);
  const stepText = recipe.steps.map((step) => step.instruction).join('\n');
  if (stepText) parts.push(stepText);
  if (recipe.tools?.length) parts.push(recipe.tools.join(' '));
  return parts.join('\n');
}

export function ensureRecipeId(recipe: Partial<NormalizedRecipe>, fallback?: string): string {
  if (recipe.id) return recipe.id;
  return fallback ?? crypto.randomUUID();
}

export function safeDateISOString(): string {
  return new Date().toISOString();
}
