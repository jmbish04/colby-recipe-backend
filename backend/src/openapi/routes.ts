/**
 * OpenAPI Route Definitions
 *
 * Defines all API routes with full OpenAPI 3.1.0 compliance.
 * Each route has an operationId for GPT custom action compatibility.
 */

import { createRoute } from '@hono/zod-openapi';
import {
  ErrorResponseSchema,
  SuccessResponseSchema,
  HealthLatestResponseSchema,
  HealthHistoryResponseSchema,
  HealthHistoryQuerySchema,
  HealthRunResponseSchema,
  RecipeListResponseSchema,
  RecipeListQuerySchema,
  RecipeDetailResponseSchema,
  RecipeCreateRequestSchema,
  RecipeIngestRequestSchema,
  RecipeIngestResponseSchema,
  ChefChatRequestSchema,
  ChefChatResponseSchema,
  ChatHistoryResponseSchema,
  PlannerGenerateRequestSchema,
  PlannerGenerateResponseSchema,
  PlannerStatusResponseSchema,
  PlannerConfigRequestSchema,
} from './schemas';
import { z } from '@hono/zod-openapi';

// ============================================================================
// Health Routes
// ============================================================================

export const getHealthLatest = createRoute({
  method: 'get',
  path: '/api/health/latest',
  operationId: 'getHealthLatest',
  tags: ['Health'],
  summary: 'Get latest health check',
  description: 'Returns the most recent health check result for all services (D1, Vectorize, AI, KV).',
  responses: {
    200: {
      description: 'Latest health check result',
      content: {
        'application/json': {
          schema: HealthLatestResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

export const getHealthHistory = createRoute({
  method: 'get',
  path: '/api/health/history',
  operationId: 'getHealthHistory',
  tags: ['Health'],
  summary: 'Get health check history',
  description: 'Returns historical health check results.',
  request: {
    query: HealthHistoryQuerySchema,
  },
  responses: {
    200: {
      description: 'Health check history',
      content: {
        'application/json': {
          schema: HealthHistoryResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

export const runHealthCheck = createRoute({
  method: 'post',
  path: '/api/health/run',
  operationId: 'runHealthCheck',
  tags: ['Health'],
  summary: 'Run health check now',
  description: 'Triggers an on-demand health check of all services and returns the result.',
  responses: {
    200: {
      description: 'Health check completed',
      content: {
        'application/json': {
          schema: HealthRunResponseSchema,
        },
      },
    },
    500: {
      description: 'Health check failed',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

// ============================================================================
// Recipe Routes
// ============================================================================

export const listRecipes = createRoute({
  method: 'get',
  path: '/api/recipes',
  operationId: 'listRecipes',
  tags: ['Recipes'],
  summary: 'List recipes',
  description: 'Returns a paginated list of recipes with optional filtering by search query, tag, or cuisine.',
  request: {
    query: RecipeListQuerySchema,
  },
  responses: {
    200: {
      description: 'List of recipes',
      content: {
        'application/json': {
          schema: RecipeListResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

export const getRecipe = createRoute({
  method: 'get',
  path: '/api/recipes/{id}',
  operationId: 'getRecipe',
  tags: ['Recipes'],
  summary: 'Get recipe by ID',
  description: 'Returns detailed information about a specific recipe including ingredients and steps.',
  request: {
    params: z.object({
      id: z.string().uuid().openapi({
        description: 'Recipe ID',
        example: '550e8400-e29b-41d4-a716-446655440000',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Recipe details',
      content: {
        'application/json': {
          schema: RecipeDetailResponseSchema,
        },
      },
    },
    404: {
      description: 'Recipe not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

export const createRecipe = createRoute({
  method: 'post',
  path: '/api/recipes',
  operationId: 'createRecipe',
  tags: ['Recipes'],
  summary: 'Create a recipe',
  description: 'Creates a new recipe manually. Requires authentication.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: RecipeCreateRequestSchema,
        },
      },
    },
  },
  responses: {
    202: {
      description: 'Recipe queued for processing',
      content: {
        'application/json': {
          schema: RecipeIngestResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid request',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

export const ingestRecipeUrl = createRoute({
  method: 'post',
  path: '/api/recipes/ingest',
  operationId: 'ingestRecipeUrl',
  tags: ['Recipes'],
  summary: 'Ingest recipe from URL',
  description: 'Queues a URL for recipe extraction. The system will scrape the page, extract recipe data using AI, and store it.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: RecipeIngestRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Recipe already exists',
      content: {
        'application/json': {
          schema: RecipeIngestResponseSchema,
        },
      },
    },
    202: {
      description: 'URL queued for ingestion',
      content: {
        'application/json': {
          schema: RecipeIngestResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid URL',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

// ============================================================================
// Chef Agent Routes
// ============================================================================

export const chatWithChef = createRoute({
  method: 'post',
  path: '/api/agents/chef/chat',
  operationId: 'chatWithChef',
  tags: ['Chef Agent'],
  summary: 'Chat with Chef assistant',
  description: 'Send a message to the AI Chef assistant. Maintains conversation history and considers user preferences.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: ChefChatRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Chef response',
      content: {
        'application/json': {
          schema: ChefChatResponseSchema,
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

export const getChefHistory = createRoute({
  method: 'get',
  path: '/api/agents/chef/history',
  operationId: 'getChefHistory',
  tags: ['Chef Agent'],
  summary: 'Get chat history',
  description: 'Returns the conversation history with the Chef assistant.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Conversation history',
      content: {
        'application/json': {
          schema: ChatHistoryResponseSchema,
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

export const clearChefHistory = createRoute({
  method: 'delete',
  path: '/api/agents/chef/history',
  operationId: 'clearChefHistory',
  tags: ['Chef Agent'],
  summary: 'Clear chat history',
  description: 'Clears the conversation history with the Chef assistant.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'History cleared',
      content: {
        'application/json': {
          schema: SuccessResponseSchema,
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

// ============================================================================
// Planner Agent Routes
// ============================================================================

export const generateMenuPlan = createRoute({
  method: 'post',
  path: '/api/agents/planner/generate',
  operationId: 'generateMenuPlan',
  tags: ['Planner Agent'],
  summary: 'Generate menu plan',
  description: 'Generates a weekly menu plan based on available recipes, user preferences, and pantry items.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: PlannerGenerateRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Menu plan generated',
      content: {
        'application/json': {
          schema: PlannerGenerateResponseSchema,
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

export const getPlannerStatus = createRoute({
  method: 'get',
  path: '/api/agents/planner/status',
  operationId: 'getPlannerStatus',
  tags: ['Planner Agent'],
  summary: 'Get planner status',
  description: 'Returns the current status and configuration of the Planner agent.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Planner status',
      content: {
        'application/json': {
          schema: PlannerStatusResponseSchema,
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

export const updatePlannerConfig = createRoute({
  method: 'put',
  path: '/api/agents/planner/config',
  operationId: 'updatePlannerConfig',
  tags: ['Planner Agent'],
  summary: 'Update planner config',
  description: 'Updates the configuration for the Planner agent.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: PlannerConfigRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Configuration updated',
      content: {
        'application/json': {
          schema: SuccessResponseSchema,
        },
      },
    },
    401: {
      description: 'Authentication required',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});
