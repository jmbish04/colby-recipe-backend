/**
 * OpenAPI Zod Schemas
 *
 * Defines all request/response schemas for the Cognitive Kitchen API.
 * These schemas are used for both runtime validation and OpenAPI spec generation.
 */

import { z } from '@hono/zod-openapi';

// ============================================================================
// Common Schemas
// ============================================================================

export const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string().openapi({ example: 'An error occurred' }),
  details: z.string().optional(),
}).openapi('ErrorResponse');

export const SuccessResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
}).openapi('SuccessResponse');

export const PaginationSchema = z.object({
  page: z.number().int().positive().openapi({ example: 1 }),
  pageSize: z.number().int().positive().openapi({ example: 24 }),
  total: z.number().int().nonnegative().openapi({ example: 100 }),
  hasMore: z.boolean().openapi({ example: true }),
}).openapi('Pagination');

export const MetaSchema = z.object({
  timestamp: z.string().datetime().openapi({ example: '2025-01-15T10:30:00Z' }),
  latencyMs: z.number().int().optional().openapi({ example: 42 }),
}).openapi('Meta');

// ============================================================================
// Health Schemas
// ============================================================================

export const ServiceHealthSchema = z.object({
  name: z.string().openapi({ example: 'D1 Database' }),
  status: z.enum(['OK', 'ERROR']).openapi({ example: 'OK' }),
  latencyMs: z.number().int().openapi({ example: 15 }),
  error: z.string().optional().openapi({ example: 'Connection timeout' }),
}).openapi('ServiceHealth');

export const HealthCheckResultSchema = z.object({
  status: z.enum(['OK', 'ERROR']).openapi({ example: 'OK' }),
  timestamp: z.string().datetime().openapi({ example: '2025-01-15T10:30:00Z' }),
  latencyMs: z.number().int().openapi({ example: 150 }),
  triggeredBy: z.enum(['scheduled', 'manual']).openapi({ example: 'manual' }),
  services: z.object({
    d1: ServiceHealthSchema,
    vectorize: ServiceHealthSchema,
    ai: ServiceHealthSchema,
    kv: ServiceHealthSchema,
  }),
}).openapi('HealthCheckResult');

export const HealthLatestResponseSchema = z.object({
  success: z.literal(true),
  data: HealthCheckResultSchema.nullable(),
  message: z.string().optional(),
}).openapi('HealthLatestResponse');

export const HealthHistoryResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(HealthCheckResultSchema),
  meta: z.object({
    count: z.number().int(),
    limit: z.number().int(),
  }),
}).openapi('HealthHistoryResponse');

export const HealthRunResponseSchema = z.object({
  success: z.literal(true),
  data: HealthCheckResultSchema,
  meta: MetaSchema,
}).openapi('HealthRunResponse');

// ============================================================================
// Recipe Schemas
// ============================================================================

export const IngredientSchema = z.object({
  name: z.string().min(1).openapi({ example: 'All-purpose flour' }),
  quantity: z.string().optional().openapi({ example: '2 cups' }),
  unit: z.string().optional().openapi({ example: 'cups' }),
  notes: z.string().optional().openapi({ example: 'sifted' }),
}).openapi('Ingredient');

export const RecipeStepSchema = z.object({
  instruction: z.string().min(1).openapi({ example: 'Preheat oven to 350°F' }),
  title: z.string().optional().openapi({ example: 'Preparation' }),
  duration: z.number().int().optional().openapi({ example: 10 }),
}).openapi('RecipeStep');

export const RecipeSummarySchema = z.object({
  id: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
  title: z.string().openapi({ example: 'Classic Banana Bread' }),
  description: z.string().nullable().optional().openapi({ example: 'A moist and delicious banana bread recipe' }),
  cuisine: z.string().nullable().optional().openapi({ example: 'American' }),
  tags: z.array(z.string()).openapi({ example: ['dessert', 'baking', 'quick'] }),
  heroImageUrl: z.string().url().nullable().optional().openapi({ example: 'https://example.com/banana-bread.jpg' }),
  prepTimeMinutes: z.number().int().nullable().optional().openapi({ example: 15 }),
  cookTimeMinutes: z.number().int().nullable().optional().openapi({ example: 60 }),
  totalTimeMinutes: z.number().int().nullable().optional().openapi({ example: 75 }),
}).openapi('RecipeSummary');

export const RecipeDetailSchema = RecipeSummarySchema.extend({
  authorName: z.string().nullable().optional().openapi({ example: 'Chef John' }),
  yield: z.string().nullable().optional().openapi({ example: '1 loaf (8 servings)' }),
  ingredients: z.array(IngredientSchema),
  steps: z.array(RecipeStepSchema),
  prepPhases: z.array(z.object({
    phaseTitle: z.string(),
    ingredients: z.array(IngredientSchema),
  })).optional(),
  equipment: z.array(z.string()).optional().openapi({ example: ['9x5 loaf pan', 'mixing bowl'] }),
  notes: z.string().nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).openapi('RecipeDetail');

export const RecipeListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(RecipeSummarySchema),
  pagination: PaginationSchema,
}).openapi('RecipeListResponse');

export const RecipeDetailResponseSchema = z.object({
  success: z.literal(true),
  data: RecipeDetailSchema,
}).openapi('RecipeDetailResponse');

export const RecipeCreateRequestSchema = z.object({
  title: z.string().min(1).max(200).openapi({ example: 'My Homemade Pasta' }),
  description: z.string().max(2000).optional(),
  cuisine: z.string().max(100).optional(),
  tags: z.array(z.string()).optional(),
  yield: z.string().max(100).optional(),
  prepTimeMinutes: z.number().int().positive().optional(),
  cookTimeMinutes: z.number().int().positive().optional(),
  ingredients: z.array(z.object({
    name: z.string().min(1),
    quantity: z.string().optional(),
    unit: z.string().optional(),
    notes: z.string().optional(),
  })).min(1).openapi({ description: 'At least one ingredient is required' }),
  steps: z.array(z.object({
    instruction: z.string().min(1),
    title: z.string().optional(),
  })).min(1).openapi({ description: 'At least one step is required' }),
  equipment: z.array(z.string()).optional(),
  notes: z.string().max(5000).optional(),
}).openapi('RecipeCreateRequest');

export const RecipeIngestRequestSchema = z.object({
  url: z.string().url().openapi({
    example: 'https://www.seriouseats.com/best-banana-bread-recipe',
    description: 'URL of the recipe page to scrape and ingest',
  }),
}).openapi('RecipeIngestRequest');

export const RecipeIngestResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().openapi({ example: 'URL queued for ingestion' }),
  data: z.object({
    recipeId: z.string().uuid().optional(),
  }).optional(),
}).openapi('RecipeIngestResponse');

// ============================================================================
// Agent Schemas
// ============================================================================

export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.string().datetime(),
}).openapi('ChatMessage');

export const ChefChatRequestSchema = z.object({
  message: z.string().min(1).max(4000).openapi({
    example: 'What can I make with chicken, garlic, and lemon?',
    description: 'The message to send to the Chef assistant',
  }),
}).openapi('ChefChatRequest');

export const ChefChatResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    response: z.string().openapi({ example: 'Great ingredients! Here are some ideas...' }),
    conversationId: z.string(),
  }),
}).openapi('ChefChatResponse');

export const ChatHistoryResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    history: z.array(ChatMessageSchema),
  }),
}).openapi('ChatHistoryResponse');

export const PlannerGenerateRequestSchema = z.object({
  theme: z.string().max(200).optional().openapi({
    example: 'Mediterranean',
    description: 'Optional theme for the menu plan',
  }),
  excludeRecipeIds: z.array(z.string().uuid()).optional().openapi({
    description: 'Recipe IDs to exclude from the plan',
  }),
  weekStartDate: z.string().datetime().optional().openapi({
    example: '2025-01-19T00:00:00Z',
    description: 'Start date for the week (defaults to next Sunday)',
  }),
}).openapi('PlannerGenerateRequest');

export const MenuPlanItemSchema = z.object({
  recipeId: z.string().uuid(),
  day: z.string().optional().openapi({ example: 'Monday' }),
  meal: z.string().optional().openapi({ example: 'dinner' }),
  reason: z.string().optional(),
}).openapi('MenuPlanItem');

export const MenuPlanSchema = z.object({
  title: z.string().optional().openapi({ example: 'Mediterranean Week' }),
  items: z.array(MenuPlanItemSchema),
}).openapi('MenuPlan');

export const PlannerGenerateResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    menuId: z.string().uuid(),
    plan: MenuPlanSchema,
  }),
}).openapi('PlannerGenerateResponse');

export const PlannerStatusSchema = z.object({
  userId: z.string(),
  lastRunAt: z.string().datetime().optional(),
  lastMenuId: z.string().uuid().optional(),
  config: z.object({
    preferredDay: z.number().int().min(0).max(6).optional(),
    mealTypes: z.array(z.enum(['breakfast', 'lunch', 'dinner', 'snack'])).optional(),
    theme: z.string().optional(),
  }).optional(),
}).openapi('PlannerStatus');

export const PlannerStatusResponseSchema = z.object({
  success: z.literal(true),
  data: PlannerStatusSchema,
}).openapi('PlannerStatusResponse');

export const PlannerConfigRequestSchema = z.object({
  config: z.object({
    preferredDay: z.number().int().min(0).max(6).optional().openapi({
      description: 'Preferred day to run (0=Sunday, 6=Saturday)',
    }),
    mealTypes: z.array(z.enum(['breakfast', 'lunch', 'dinner', 'snack'])).optional(),
    theme: z.string().max(200).optional(),
  }),
}).openapi('PlannerConfigRequest');

// ============================================================================
// Query Parameter Schemas
// ============================================================================

export const RecipeListQuerySchema = z.object({
  q: z.string().optional().openapi({
    description: 'Search query for title, tags, or cuisine',
    example: 'pasta',
  }),
  tag: z.string().optional().openapi({
    description: 'Filter by tag',
    example: 'quick',
  }),
  cuisine: z.string().optional().openapi({
    description: 'Filter by cuisine',
    example: 'Italian',
  }),
  limit: z.string().optional().openapi({
    description: 'Number of results (default: 24)',
    example: '24',
  }),
  offset: z.string().optional().openapi({
    description: 'Offset for pagination (default: 0)',
    example: '0',
  }),
}).openapi('RecipeListQuery');

export const HealthHistoryQuerySchema = z.object({
  limit: z.string().optional().openapi({
    description: 'Number of records to return (default: 24)',
    example: '24',
  }),
}).openapi('HealthHistoryQuery');
