/**
 * PlannerAgent - Scheduled Menu Planning Agent
 *
 * A Durable Object that runs on a schedule (Sunday 8 AM) to automatically
 * generate weekly menu plans based on:
 * - User preferences
 * - Available pantry items
 * - Previous menu history
 *
 * Features:
 * - Reads Pantry table via Prisma
 * - Generates Menu Plan using AI Pipeline
 * - Saves to Menu table
 * - Configurable per-user scheduling
 */

import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import type { Env, DurableObjectState } from '../types';
import type { PlannerAgentState, MenuPlan, UserPreferences, MealType, DayOfWeek } from '../types/domain';
import { getPrismaClient, parseJsonField } from '../lib/db';
import { processIdeally, generateEmbedding } from '../services/ai-pipeline';

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MenuPlanSchema = z.object({
  title: z.string().optional(),
  items: z.array(z.object({
    recipeId: z.string(),
    day: z.string().optional(),
    meal: z.string().optional(),
    reason: z.string().optional(),
  })),
});

export class PlannerAgent extends DurableObject<Env> {
  private state: DurableObjectState;
  private env: Env;
  private agentState: PlannerAgentState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.env = env;
  }

  /**
   * Initialize the agent state
   */
  private async initialize(userId: string): Promise<void> {
    const stored = await this.state.storage.get<PlannerAgentState>('state');

    if (stored && stored.userId === userId) {
      this.agentState = stored;
    } else {
      this.agentState = {
        userId,
        lastRunAt: undefined,
        lastMenuId: undefined,
        config: {
          preferredDay: 0, // Sunday
          mealTypes: ['breakfast', 'lunch', 'dinner'],
        },
      };
    }
  }

  /**
   * Save agent state to storage
   */
  private async saveState(): Promise<void> {
    if (this.agentState) {
      await this.state.storage.put('state', this.agentState);
    }
  }

  /**
   * Generate a weekly menu plan for a user
   */
  async generateMenuPlan(
    userId: string,
    options: {
      theme?: string;
      excludeRecipeIds?: string[];
      weekStartDate?: Date;
    } = {}
  ): Promise<{ menuId: string; plan: MenuPlan }> {
    await this.initialize(userId);

    const prisma = getPrismaClient(this.env);

    // 1. Load user preferences
    const userPrefs = await prisma.userPreference.findUnique({
      where: { userId },
    });

    const preferences: UserPreferences = {
      userId,
      cuisines: parseJsonField<string[]>(userPrefs?.cuisines, []),
      dislikedIngredients: parseJsonField<string[]>(userPrefs?.dislikedIngredients, []),
      favoredTools: parseJsonField<string[]>(userPrefs?.favoredTools, []),
      dietaryRestrictions: parseJsonField<string[]>(userPrefs?.dietaryRestrictions, []),
      allergies: parseJsonField<string[]>(userPrefs?.allergies, []),
      skillLevel: userPrefs?.skillLevel ?? undefined,
      defaultServings: userPrefs?.defaultServings ?? undefined,
      notes: userPrefs?.notes,
    };

    // 2. Load pantry items
    const pantryItems = await prisma.pantryItem.findMany({
      where: { userId },
    });

    const availableIngredients = pantryItems.map(item => item.ingredientName);

    // 3. Load candidate recipes (with vector search if theme provided)
    let candidateRecipes = await this.loadCandidateRecipes(
      options.theme,
      options.excludeRecipeIds || [],
      preferences
    );

    if (candidateRecipes.length === 0) {
      // Fallback: get random recipes
      candidateRecipes = await prisma.recipe.findMany({
        take: 30,
        select: {
          id: true,
          title: true,
          cuisine: true,
          tags: true,
          description: true,
          heroImageUrl: true,
        },
      });
    }

    // 4. Generate menu plan using AI
    const plan = await this.generatePlanWithAI(
      candidateRecipes,
      preferences,
      availableIngredients,
      options.theme
    );

    // 5. Create menu in database
    const weekStart = options.weekStartDate || this.getNextSunday();

    const menu = await prisma.menu.create({
      data: {
        userId,
        title: plan.title || (options.theme ? `${options.theme} Menu` : 'Weekly Menu'),
        weekStartDate: weekStart,
        theme: options.theme,
        items: {
          create: plan.items.slice(0, 7).map((item, index) => ({
            recipeId: item.recipeId,
            dayOfWeek: this.parseDayOfWeek(item.day) ?? (index % 7),
            mealType: this.normalizeMealType(item.meal),
          })),
        },
      },
    });

    // 6. Update agent state
    this.agentState!.lastRunAt = new Date();
    this.agentState!.lastMenuId = menu.id;
    await this.saveState();

    return { menuId: menu.id, plan };
  }

  /**
   * Load candidate recipes, optionally using vector search
   */
  private async loadCandidateRecipes(
    theme: string | undefined,
    excludeIds: string[],
    preferences: UserPreferences
  ): Promise<Array<{
    id: string;
    title: string;
    cuisine: string | null;
    tags: string | null;
    description: string | null;
    heroImageUrl: string | null;
  }>> {
    const prisma = getPrismaClient(this.env);

    // If theme provided, use vector search
    if (theme) {
      try {
        const embedding = await generateEmbedding(this.env, theme);

        const vectorResults = await this.env.RECIPE_VECTORIZE.query({
          vector: embedding,
          topK: 50,
          returnMetadata: true,
        });

        if (vectorResults.matches && vectorResults.matches.length > 0) {
          const recipeIds = vectorResults.matches
            .map(m => m.metadata?.recipe_id)
            .filter((id): id is string => typeof id === 'string' && !excludeIds.includes(id));

          if (recipeIds.length > 0) {
            const recipes = await prisma.recipe.findMany({
              where: { id: { in: recipeIds } },
              select: {
                id: true,
                title: true,
                cuisine: true,
                tags: true,
                description: true,
                heroImageUrl: true,
              },
            });

            return recipes;
          }
        }
      } catch (error) {
        console.error('Vector search failed, falling back to SQL:', error);
      }
    }

    // Fallback: SQL-based search with preference matching
    const cuisineFilter = preferences.cuisines.length > 0
      ? { OR: preferences.cuisines.map(c => ({ cuisine: { contains: c } })) }
      : {};

    return prisma.recipe.findMany({
      where: {
        id: { notIn: excludeIds },
        ...cuisineFilter,
      },
      take: 50,
      select: {
        id: true,
        title: true,
        cuisine: true,
        tags: true,
        description: true,
        heroImageUrl: true,
      },
    });
  }

  /**
   * Generate menu plan using the AI pipeline
   */
  private async generatePlanWithAI(
    candidates: Array<{
      id: string;
      title: string;
      cuisine: string | null;
      tags: string | null;
      description: string | null;
    }>,
    preferences: UserPreferences,
    pantryIngredients: string[],
    theme?: string
  ): Promise<MenuPlan> {
    const candidateList = candidates
      .slice(0, 20)
      .map((r, i) => `${i + 1}. ${r.title} (ID: ${r.id})${r.cuisine ? ` - ${r.cuisine}` : ''}`)
      .join('\n');

    const contextParts: string[] = [
      'Create a weekly dinner menu plan selecting from these recipes:',
      candidateList,
    ];

    if (theme) {
      contextParts.push(`Theme for the week: ${theme}`);
    }

    if (preferences.cuisines.length > 0) {
      contextParts.push(`Preferred cuisines: ${preferences.cuisines.join(', ')}`);
    }

    if (preferences.dietaryRestrictions.length > 0) {
      contextParts.push(`Dietary restrictions: ${preferences.dietaryRestrictions.join(', ')}`);
    }

    if (preferences.dislikedIngredients.length > 0) {
      contextParts.push(`Avoid recipes with: ${preferences.dislikedIngredients.join(', ')}`);
    }

    if (pantryIngredients.length > 0) {
      contextParts.push(`Available ingredients: ${pantryIngredients.slice(0, 20).join(', ')}`);
    }

    contextParts.push(`
Select 7 recipes for the week (one per day, Sunday through Saturday).
Ensure variety in cuisines and cooking methods.
Return the recipe IDs, day names, and meal type.`);

    const input = contextParts.join('\n\n');

    const result = await processIdeally(
      this.env,
      input,
      MenuPlanSchema,
      {
        context: 'Generate a balanced weekly menu plan from the available recipes.',
        maxReasoningTokens: 1024,
        maxStructuringTokens: 2048,
      }
    );

    return result.structured;
  }

  /**
   * Update agent configuration
   */
  async updateConfig(
    userId: string,
    config: Partial<PlannerAgentState['config']>
  ): Promise<void> {
    await this.initialize(userId);

    this.agentState!.config = {
      ...this.agentState!.config,
      ...config,
    };

    await this.saveState();
  }

  /**
   * Get agent status
   */
  async getStatus(userId: string): Promise<PlannerAgentState> {
    await this.initialize(userId);
    return this.agentState!;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private getNextSunday(): Date {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
    const nextSunday = new Date(today);
    nextSunday.setDate(today.getDate() + daysUntilSunday);
    nextSunday.setHours(0, 0, 0, 0);
    return nextSunday;
  }

  private parseDayOfWeek(day: string | undefined): DayOfWeek | null {
    if (!day) return null;
    const index = DAYS_OF_WEEK.findIndex(
      d => d.toLowerCase() === day.toLowerCase()
    );
    return index >= 0 ? (index as DayOfWeek) : null;
  }

  private normalizeMealType(meal: string | undefined): MealType {
    if (!meal) return 'dinner';
    const lower = meal.toLowerCase();
    if (lower.includes('break')) return 'breakfast';
    if (lower.includes('lunch')) return 'lunch';
    if (lower.includes('snack')) return 'snack';
    return 'dinner';
  }

  /**
   * HTTP fetch handler
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'POST' && path === '/generate') {
        const GenerateBodySchema = z.object({
          userId: z.string(),
          theme: z.string().optional(),
          excludeRecipeIds: z.array(z.string()).optional(),
          weekStartDate: z.string().datetime().optional(),
        });
        const body = GenerateBodySchema.parse(await request.json());

        const result = await this.generateMenuPlan(body.userId, {
          theme: body.theme,
          excludeRecipeIds: body.excludeRecipeIds,
          weekStartDate: body.weekStartDate ? new Date(body.weekStartDate) : undefined,
        });

        return Response.json(result);
      }

      if (request.method === 'GET' && path === '/status') {
        const userId = url.searchParams.get('userId');
        if (!userId) {
          return Response.json({ error: 'userId required' }, { status: 400 });
        }

        const status = await this.getStatus(userId);
        return Response.json(status);
      }

      if (request.method === 'PUT' && path === '/config') {
        const body = await request.json() as {
          userId: string;
          config: Partial<PlannerAgentState['config']>;
        };

        await this.updateConfig(body.userId, body.config);
        return Response.json({ success: true });
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (error) {
      console.error('PlannerAgent error:', error);
      return Response.json(
        { error: error instanceof Error ? error.message : 'Internal error' },
        { status: 500 }
      );
    }
  }
}
