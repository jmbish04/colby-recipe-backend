/**
 * ChefAgent - Stateful Conversational Agent
 *
 * A Durable Object that maintains conversation history and provides
 * personalized cooking assistance using the AI pipeline.
 *
 * Features:
 * - Persistent conversation history in Durable Object storage
 * - User preference caching via KV
 * - Context-aware responses based on pantry and preferences
 * - RPC method: chat(message) for conversational interactions
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env, DurableObjectState } from '../types';
import type { ChatMessage, UserPreferences, ChefAgentState } from '../types/domain';
import { chatCompletion } from '../services/ai-pipeline';

const MAX_HISTORY_LENGTH = 50;
const CONTEXT_CACHE_TTL = 300; // 5 minutes

export class ChefAgent extends DurableObject<Env> {
  private state: DurableObjectState;
  private env: Env;
  private conversationHistory: ChatMessage[] = [];
  private userId: string | null = null;
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.env = env;
  }

  /**
   * Initialize the agent with user context
   */
  private async initialize(userId: string): Promise<void> {
    if (this.initialized && this.userId === userId) {
      return;
    }

    this.userId = userId;

    // Load conversation history from storage
    const storedHistory = await this.state.storage.get<ChatMessage[]>('history');
    this.conversationHistory = storedHistory || [];

    // Load user context from KV cache
    await this.loadUserContext();

    this.initialized = true;
  }

  /**
   * Load user preferences and context from KV cache
   */
  private async loadUserContext(): Promise<UserPreferences | null> {
    if (!this.userId) return null;

    const cacheKey = `chef-context:${this.userId}`;
    const cached = await this.env.KV.get<UserPreferences>(cacheKey, 'json');

    if (cached) {
      return cached;
    }

    // Context not in cache - would be loaded from DB in a real implementation
    // For now, return null and let the caller handle it
    return null;
  }

  /**
   * Cache user context in KV
   */
  private async cacheUserContext(context: UserPreferences): Promise<void> {
    if (!this.userId) return;

    const cacheKey = `chef-context:${this.userId}`;
    await this.env.KV.put(cacheKey, JSON.stringify(context), {
      expirationTtl: CONTEXT_CACHE_TTL,
    });
  }

  /**
   * Save conversation history to storage
   */
  private async saveHistory(): Promise<void> {
    // Trim history if too long
    if (this.conversationHistory.length > MAX_HISTORY_LENGTH) {
      this.conversationHistory = this.conversationHistory.slice(-MAX_HISTORY_LENGTH);
    }

    await this.state.storage.put('history', this.conversationHistory);
  }

  /**
   * Build the system prompt with user context
   */
  private buildSystemPrompt(context?: UserPreferences | null): string {
    let systemPrompt = `You are Chef Claude, a friendly and knowledgeable AI cooking assistant for the Cognitive Kitchen app.

Your role is to:
- Help users plan meals and suggest recipes
- Answer cooking questions and provide tips
- Adapt recipes to dietary restrictions and preferences
- Suggest ingredient substitutions
- Guide users through cooking techniques

Be conversational, helpful, and encouraging. Keep responses concise but informative.`;

    if (context) {
      const contextParts: string[] = [];

      if (context.cuisines.length > 0) {
        contextParts.push(`Preferred cuisines: ${context.cuisines.join(', ')}`);
      }
      if (context.dietaryRestrictions.length > 0) {
        contextParts.push(`Dietary restrictions: ${context.dietaryRestrictions.join(', ')}`);
      }
      if (context.allergies.length > 0) {
        contextParts.push(`Allergies: ${context.allergies.join(', ')}`);
      }
      if (context.dislikedIngredients.length > 0) {
        contextParts.push(`Disliked ingredients: ${context.dislikedIngredients.join(', ')}`);
      }
      if (context.favoredTools.length > 0) {
        contextParts.push(`Available tools: ${context.favoredTools.join(', ')}`);
      }

      if (contextParts.length > 0) {
        systemPrompt += `\n\nUser preferences:\n${contextParts.join('\n')}`;
      }
    }

    return systemPrompt;
  }

  /**
   * Main chat RPC method
   *
   * @param message - The user's message
   * @param userId - The user's ID for context loading
   * @param preferences - Optional user preferences to cache
   * @returns The assistant's response
   */
  async chat(
    message: string,
    userId: string,
    preferences?: UserPreferences
  ): Promise<{ response: string; conversationId: string }> {
    // Initialize with user context
    await this.initialize(userId);

    // Cache preferences if provided
    if (preferences) {
      await this.cacheUserContext(preferences);
    }

    // Load context for response generation
    const context = preferences || await this.loadUserContext();

    // Add user message to history
    const userMessage: ChatMessage = {
      role: 'user',
      content: message,
      timestamp: new Date(),
    };
    this.conversationHistory.push(userMessage);

    // Build messages array for AI
    const systemPrompt = this.buildSystemPrompt(context);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...this.conversationHistory.slice(-10).map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })),
    ];

    // Generate response
    const response = await chatCompletion(this.env, messages, {
      maxTokens: 1024,
      temperature: 0.7,
    });

    // Add assistant response to history
    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: response,
      timestamp: new Date(),
    };
    this.conversationHistory.push(assistantMessage);

    // Save updated history
    await this.saveHistory();

    return {
      response,
      conversationId: this.state.id.toString(),
    };
  }

  /**
   * Get conversation history
   */
  async getHistory(userId: string): Promise<ChatMessage[]> {
    await this.initialize(userId);
    return this.conversationHistory;
  }

  /**
   * Clear conversation history
   */
  async clearHistory(userId: string): Promise<void> {
    await this.initialize(userId);
    this.conversationHistory = [];
    await this.state.storage.delete('history');
  }

  /**
   * Update user context (preferences, pantry, etc.)
   */
  async updateContext(
    userId: string,
    context: Partial<UserPreferences>
  ): Promise<void> {
    await this.initialize(userId);

    const existing = await this.loadUserContext();
    const updated: UserPreferences = {
      userId,
      cuisines: context.cuisines ?? existing?.cuisines ?? [],
      dislikedIngredients: context.dislikedIngredients ?? existing?.dislikedIngredients ?? [],
      favoredTools: context.favoredTools ?? existing?.favoredTools ?? [],
      dietaryRestrictions: context.dietaryRestrictions ?? existing?.dietaryRestrictions ?? [],
      allergies: context.allergies ?? existing?.allergies ?? [],
      skillLevel: context.skillLevel ?? existing?.skillLevel,
      defaultServings: context.defaultServings ?? existing?.defaultServings,
      notes: context.notes ?? existing?.notes,
    };

    await this.cacheUserContext(updated);
  }

  /**
   * HTTP fetch handler for the Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'POST' && path === '/chat') {
        const body = await request.json() as {
          message: string;
          userId: string;
          preferences?: UserPreferences;
        };

        const result = await this.chat(body.message, body.userId, body.preferences);
        return Response.json(result);
      }

      if (request.method === 'GET' && path === '/history') {
        const userId = url.searchParams.get('userId');
        if (!userId) {
          return Response.json({ error: 'userId required' }, { status: 400 });
        }

        const history = await this.getHistory(userId);
        return Response.json({ history });
      }

      if (request.method === 'DELETE' && path === '/history') {
        const userId = url.searchParams.get('userId');
        if (!userId) {
          return Response.json({ error: 'userId required' }, { status: 400 });
        }

        await this.clearHistory(userId);
        return Response.json({ success: true });
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (error) {
      console.error('ChefAgent error:', error);
      return Response.json(
        { error: error instanceof Error ? error.message : 'Internal error' },
        { status: 500 }
      );
    }
  }
}
