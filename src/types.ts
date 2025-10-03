export interface Ingredient {
  name: string;
  quantity?: string;
  notes?: string;
}

export interface RecipeStep {
  title?: string;
  instruction: string;
}

export interface NormalizedRecipe {
  id: string;
  title: string;
  description?: string;
  cuisine?: string;
  tags?: string[];
  heroImageUrl?: string;
  yield?: string;
  prepTimeMinutes?: number | null;
  cookTimeMinutes?: number | null;
  totalTimeMinutes?: number | null;
  ingredients: Ingredient[];
  steps: RecipeStep[];
  tools?: string[];
  notes?: string;
  sourceUrl?: string;
}

export interface RecipeSummary {
  id: string;
  title: string;
  tags: string[];
  cuisine?: string | null;
  heroImageUrl?: string | null;
  score?: number;
}

export interface UserPreferences {
  userId: string;
  cuisines: string[];
  dislikedIngredients: string[];
  favoredTools: string[];
  notes?: string | null;
  updatedAt?: string;
}
