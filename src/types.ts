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
  dietaryRestrictions: string[];
  allergies: string[];
  skillLevel?: (1 | 2 | 3 | 4 | 5) | null;
  defaultServings?: number | null;
  notes?: string | null;
  updatedAt?: string;
}

export interface User {
  id: string;
  email?: string | null;
  name?: string | null;
  pictureUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Favorite {
  userId: string;
  recipeId: string;
  createdAt: string;
}

export interface Rating {
  userId: string;
  recipeId: string;
  stars: number;
  notes?: string | null;
  cookedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Event {
  id: number;
  userId: string;
  eventType: 'view' | 'cook' | 'skip' | 'add_to_menu';
  recipeId?: string | null;
  sessionId?: string | null;
  createdAt: string;
}

export interface Menu {
  id: string;
  userId: string;
  title?: string | null;
  weekStartDate?: string | null;
  createdAt: string;
  updatedAt: string;
  items?: MenuItem[];
}

export interface MenuItem {
  id: number;
  menuId: string;
  recipeId: string;
  dayOfWeek?: number | null;
  mealType?: string | null;
}

export interface PantryItem {
  id: number;
  userId: string;
  ingredientName: string;
  quantity?: string | null;
  unit?: string | null;
  purchaseDate?: string | null;
  expiryDate?: string | null;
  updatedAt: string;
}

export interface ShoppingList {
  id: string;
  userId: string;
  menuId?: string | null;
  title?: string | null;
  createdAt: string;
}

export interface ShoppingListItem {
  id: number;
  listId: string;
  ingredientName: string;
  quantity?: string | null;
  unit?: string | null;
  isChecked: boolean;
}
