/**
 * Domain Types for Cognitive Kitchen
 * Business logic types for recipes, menus, and AI processing
 */

import { z } from 'zod';

// ============================================================================
// Recipe Types
// ============================================================================

export const IngredientSchema = z.object({
  name: z.string().min(1),
  quantity: z.string().optional(),
  unit: z.string().optional(),
  notes: z.string().optional(),
});

export type Ingredient = z.infer<typeof IngredientSchema>;

export const RecipeStepSchema = z.object({
  instruction: z.string().min(1),
  title: z.string().optional(),
  duration: z.number().optional(),
  temperature: z.string().optional(),
});

export type RecipeStep = z.infer<typeof RecipeStepSchema>;

export const PrepPhaseSchema = z.object({
  phaseTitle: z.string().min(1),
  ingredients: z.array(IngredientSchema),
  steps: z.array(RecipeStepSchema).optional(),
});

export type PrepPhase = z.infer<typeof PrepPhaseSchema>;

export const RecipeSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  authorName: z.string().optional(),
  cuisine: z.string().optional(),
  tags: z.array(z.string()).optional(),
  heroImageUrl: z.string().url().optional(),
  yield: z.string().optional(),
  prepTimeMinutes: z.number().int().positive().optional(),
  cookTimeMinutes: z.number().int().positive().optional(),
  totalTimeMinutes: z.number().int().positive().optional(),
  ingredients: z.array(IngredientSchema),
  steps: z.array(RecipeStepSchema),
  prepPhases: z.array(PrepPhaseSchema).optional(),
  equipment: z.array(z.string()).optional(),
  notes: z.string().optional(),
  sourceUrl: z.string().url().optional(),
});

export type Recipe = z.infer<typeof RecipeSchema>;

export interface RecipeSummary {
  id: string;
  title: string;
  description?: string | null;
  cuisine?: string | null;
  tags: string[];
  heroImageUrl?: string | null;
  prepTimeMinutes?: number | null;
  cookTimeMinutes?: number | null;
  totalTimeMinutes?: number | null;
}

export interface RecipeDetail extends RecipeSummary {
  authorName?: string | null;
  yield?: string | null;
  ingredients: Ingredient[];
  steps: RecipeStep[];
  prepPhases?: PrepPhase[];
  equipment?: string[];
  notes?: string | null;
  sourceUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Menu Types
// ============================================================================

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface MenuItem {
  id?: number;
  recipeId: string;
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  servings?: number;
  notes?: string;
  recipe?: RecipeSummary;
}

export interface Menu {
  id: string;
  title?: string;
  weekStartDate?: Date;
  theme?: string;
  items: MenuItem[];
  createdAt: Date;
  updatedAt: Date;
}

export interface MenuPlan {
  title?: string;
  items: Array<{
    recipeId: string;
    day?: string;
    meal?: string;
    reason?: string;
  }>;
}

// ============================================================================
// User Preferences Types
// ============================================================================

export const UserPreferencesSchema = z.object({
  userId: z.string(),
  cuisines: z.array(z.string()),
  dislikedIngredients: z.array(z.string()),
  favoredTools: z.array(z.string()),
  dietaryRestrictions: z.array(z.string()),
  allergies: z.array(z.string()),
  skillLevel: z.number().optional(),
  defaultServings: z.number().optional(),
  notes: z.string().nullable().optional(),
});

export interface UserPreferences {
  userId: string;
  cuisines: string[];
  dislikedIngredients: string[];
  favoredTools: string[];
  dietaryRestrictions: string[];
  allergies: string[];
  skillLevel?: number;
  defaultServings?: number;
  notes?: string | null;
}

// ============================================================================
// Pantry Types
// ============================================================================

export interface PantryItem {
  id: number;
  ingredientName: string;
  quantity?: string | null;
  unit?: string | null;
  category?: string | null;
  location?: string | null;
  purchaseDate?: Date | null;
  expiryDate?: Date | null;
}

// ============================================================================
// Kitchen Appliance Types
// ============================================================================

export type ProcessingStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface ApplianceSpecs {
  brand?: string;
  model?: string;
  type?: string;
  features?: string[];
  capacity?: string;
  wattage?: number;
  programs?: string[];
  temperatureRange?: { min: number; max: number };
  vectorChunkCount?: number;
  [key: string]: unknown;
}

export interface KitchenAppliance {
  id: string;
  userId: string;
  nickname?: string | null;
  brand?: string | null;
  model?: string | null;
  extractedSpecs?: ApplianceSpecs | null;
  manualR2Key?: string | null;
  ocrTextR2Key?: string | null;
  agentInstructions?: string | null;
  processingStatus: ProcessingStatus;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Health Check Types
// ============================================================================

export type HealthStatus = 'OK' | 'ERROR';

export interface ServiceHealth {
  name: string;
  status: HealthStatus;
  latencyMs: number;
  error?: string;
}

export interface HealthCheckResult {
  status: HealthStatus;
  timestamp: Date;
  latencyMs: number;
  triggeredBy: 'scheduled' | 'manual';
  services: {
    d1: ServiceHealth;
    vectorize: ServiceHealth;
    ai: ServiceHealth;
    kv: ServiceHealth;
  };
}

// ============================================================================
// AI Pipeline Types
// ============================================================================

export interface DeepThoughtResult<T> {
  reasoning: string;
  structured: T;
  latencyMs: number;
}

// Schema definitions for AI extraction
export const ExtractedRecipeSchema = RecipeSchema;

export const ShoppingListItemSchema = z.object({
  name: z.string(),
  quantity: z.string().optional(),
  category: z.string().optional(),
});

export const ShoppingListSchema = z.array(ShoppingListItemSchema);

export type ShoppingListItem = z.infer<typeof ShoppingListItemSchema>;

// ============================================================================
// Agent Types
// ============================================================================

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

export interface ChefAgentState {
  userId: string;
  conversationHistory: ChatMessage[];
  lastActivity: Date;
  context?: {
    currentRecipe?: string;
    pantryItems?: string[];
    preferences?: UserPreferences;
  };
}

export interface PlannerAgentState {
  userId: string;
  lastRunAt?: Date;
  lastMenuId?: string;
  config?: {
    preferredDay?: DayOfWeek;
    mealTypes?: MealType[];
    theme?: string;
  };
}

// ============================================================================
// API Response Types
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    timestamp: string;
    latencyMs?: number;
  };
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
  };
}
