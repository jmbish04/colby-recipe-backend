/**
 * Agent API Routes
 *
 * Endpoints for interacting with Durable Object agents:
 * - POST /api/agents/chef/chat - Chat with ChefAgent
 * - GET /api/agents/chef/history - Get conversation history
 * - DELETE /api/agents/chef/history - Clear conversation history
 * - POST /api/agents/planner/generate - Generate a menu plan
 * - GET /api/agents/planner/status - Get planner agent status
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { HonoEnv } from '../types';
import { getPrismaClient, parseJsonField } from '../lib/db';
import type { UserPreferences } from '../types/domain';

const agents = new Hono<HonoEnv>();

// ============================================================================
// ChefAgent Routes
// ============================================================================

/**
 * POST /api/agents/chef/chat
 * Send a message to the ChefAgent
 */
agents.post('/chef/chat', async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false, error: 'Authentication required' }, 401);
    }

    const ChatBodySchema = z.object({ message: z.string().min(1) });
    const body = ChatBodySchema.parse(await c.req.json());
    const message = body.message?.trim();

    if (!message) {
      return c.json({ success: false, error: 'Message is required' }, 400);
    }

    // Load user preferences
    const prisma = getPrismaClient(c.env);
    const prefs = await prisma.userPreference.findUnique({
      where: { userId },
    });

    const preferences: UserPreferences | undefined = prefs ? {
      userId,
      cuisines: parseJsonField<string[]>(prefs.cuisines, []),
      dislikedIngredients: parseJsonField<string[]>(prefs.dislikedIngredients, []),
      favoredTools: parseJsonField<string[]>(prefs.favoredTools, []),
      dietaryRestrictions: parseJsonField<string[]>(prefs.dietaryRestrictions, []),
      allergies: parseJsonField<string[]>(prefs.allergies, []),
      skillLevel: prefs.skillLevel ?? undefined,
      defaultServings: prefs.defaultServings ?? undefined,
      notes: prefs.notes,
    } : undefined;

    // Get or create ChefAgent Durable Object
    const agentId = c.env.CHEF_AGENT.idFromName(userId);
    const agent = c.env.CHEF_AGENT.get(agentId);

    // Call the agent via fetch (HTTP bridge to RPC)
    const response = await agent.fetch(
      new Request('http://internal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, userId, preferences }),
      })
    );

    if (!response.ok) {
      const error = await response.json() as { error?: string };
      return c.json({
        success: false,
        error: error.error || 'Agent error',
      }, response.status);
    }

    const result = await response.json() as {
      response: string;
      conversationId: string;
    };

    return c.json({
      success: true,
      data: {
        response: result.response,
        conversationId: result.conversationId,
      },
    });
  } catch (error) {
    console.error('ChefAgent chat error:', error);
    return c.json({
      success: false,
      error: 'Failed to process message',
    }, 500);
  }
});

/**
 * GET /api/agents/chef/history
 * Get conversation history
 */
agents.get('/chef/history', async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false, error: 'Authentication required' }, 401);
    }

    const agentId = c.env.CHEF_AGENT.idFromName(userId);
    const agent = c.env.CHEF_AGENT.get(agentId);

    const response = await agent.fetch(
      new Request(`http://internal/history?userId=${userId}`, {
        method: 'GET',
      })
    );

    if (!response.ok) {
      return c.json({ success: false, error: 'Failed to get history' }, 500);
    }

    const result = await response.json();
    return c.json({ success: true, data: result });
  } catch (error) {
    console.error('ChefAgent history error:', error);
    return c.json({ success: false, error: 'Failed to get history' }, 500);
  }
});

/**
 * DELETE /api/agents/chef/history
 * Clear conversation history
 */
agents.delete('/chef/history', async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false, error: 'Authentication required' }, 401);
    }

    const agentId = c.env.CHEF_AGENT.idFromName(userId);
    const agent = c.env.CHEF_AGENT.get(agentId);

    const response = await agent.fetch(
      new Request(`http://internal/history?userId=${userId}`, {
        method: 'DELETE',
      })
    );

    if (!response.ok) {
      return c.json({ success: false, error: 'Failed to clear history' }, 500);
    }

    return c.json({ success: true, message: 'History cleared' });
  } catch (error) {
    console.error('ChefAgent clear history error:', error);
    return c.json({ success: false, error: 'Failed to clear history' }, 500);
  }
});

// ============================================================================
// PlannerAgent Routes
// ============================================================================

/**
 * POST /api/agents/planner/generate
 * Generate a menu plan
 */
agents.post('/planner/generate', async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false, error: 'Authentication required' }, 401);
    }

    const body = await c.req.json<{
      theme?: string;
      excludeRecipeIds?: string[];
      weekStartDate?: string;
    }>();

    const agentId = c.env.PLANNER_AGENT.idFromName(userId);
    const agent = c.env.PLANNER_AGENT.get(agentId);

    const response = await agent.fetch(
      new Request('http://internal/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          theme: body.theme,
          excludeRecipeIds: body.excludeRecipeIds,
          weekStartDate: body.weekStartDate,
        }),
      })
    );

    if (!response.ok) {
      const error = await response.json() as { error?: string };
      return c.json({
        success: false,
        error: error.error || 'Agent error',
      }, response.status);
    }

    const result = await response.json() as {
      menuId: string;
      plan: unknown;
    };

    return c.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('PlannerAgent generate error:', error);
    return c.json({
      success: false,
      error: 'Failed to generate menu plan',
    }, 500);
  }
});

/**
 * GET /api/agents/planner/status
 * Get planner agent status
 */
agents.get('/planner/status', async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false, error: 'Authentication required' }, 401);
    }

    const agentId = c.env.PLANNER_AGENT.idFromName(userId);
    const agent = c.env.PLANNER_AGENT.get(agentId);

    const response = await agent.fetch(
      new Request(`http://internal/status?userId=${userId}`, {
        method: 'GET',
      })
    );

    if (!response.ok) {
      return c.json({ success: false, error: 'Failed to get status' }, 500);
    }

    const result = await response.json();
    return c.json({ success: true, data: result });
  } catch (error) {
    console.error('PlannerAgent status error:', error);
    return c.json({ success: false, error: 'Failed to get status' }, 500);
  }
});

/**
 * PUT /api/agents/planner/config
 * Update planner agent configuration
 */
agents.put('/planner/config', async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false, error: 'Authentication required' }, 401);
    }

    const body = await c.req.json<{
      config: {
        preferredDay?: number;
        mealTypes?: string[];
        theme?: string;
      };
    }>();

    const agentId = c.env.PLANNER_AGENT.idFromName(userId);
    const agent = c.env.PLANNER_AGENT.get(agentId);

    const response = await agent.fetch(
      new Request('http://internal/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          config: body.config,
        }),
      })
    );

    if (!response.ok) {
      return c.json({ success: false, error: 'Failed to update config' }, 500);
    }

    return c.json({ success: true, message: 'Configuration updated' });
  } catch (error) {
    console.error('PlannerAgent config error:', error);
    return c.json({ success: false, error: 'Failed to update config' }, 500);
  }
});

export { agents };
