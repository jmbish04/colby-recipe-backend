import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { handleChatIngredients, handleIngestUrl, handleTranscribe, handlePutPrefs, handleGetPrefs } from '../src/worker';
import { Env, BrowserService, BrowserSession, BrowserPage, VectorizeQueryResult } from '../src/env';

vi.mock('hono', () => {
  return {
    Hono: class {
      use = vi.fn();
      get = vi.fn();
      post = vi.fn();
      put = vi.fn();
      delete = vi.fn();
    },
  };
});
vi.mock('hono/cors', () => {
  return {
    cors: vi.fn(),
  };
});

class MockStatement {
  constructor(private db: MockD1, private query: string, private bindings: unknown[] = []) {}

  bind(...values: unknown[]): this {
    this.bindings = values;
    return this;
  }

  async run(): Promise<{ success: boolean }> {
    await this.db.execute(this.query, this.bindings);
    return { success: true };
  }

  async first<T>(): Promise<T | null> {
    const result = await this.all<T>();
    return result.results?.[0] ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const results = await this.db.query<T>(this.query, this.bindings);
    return { results };
  }
}

class MockD1 implements D1Database {
  public recipes = new Map<string, { id: string; title: string; tags: string; cuisine: string | null; hero_image_url: string | null }>();
  public userPrefs = new Map<string, { cuisines: string; disliked_ingredients: string; favored_tools: string; notes: string | null; updated_at: string }>();
  public ingestions: any[] = [];
  public logs: any[] = [];

  prepare(query: string): D1PreparedStatement {
    return new MockStatement(this, query) as unknown as D1PreparedStatement;
  }

  async batch(): Promise<any> { throw new Error('Not implemented'); }
  async dump(): Promise<ArrayBuffer> { throw new Error('Not implemented'); }
  async exec(): Promise<D1Result> { throw new Error('Not implemented'); }

  async execute(query: string, bindings: unknown[]): Promise<void> {
    if (query.startsWith('INSERT INTO user_prefs')) {
      const [userId, cuisines, disliked, tools, notes] = bindings as [string, string, string, string, string | null];
      this.userPrefs.set(userId, {
        cuisines: cuisines as string,
        disliked_ingredients: disliked as string,
        favored_tools: tools as string,
        notes: notes ?? null,
        updated_at: new Date().toISOString(),
      });
      return;
    }
    if (query.startsWith('INSERT INTO ingestions')) {
      const [source_type, source_ref, raw, recipe_json] = bindings as [string, string, string, string];
      this.ingestions.push({ source_type, source_ref, raw, recipe_json });
      return;
    }
    if (query.startsWith('INSERT INTO recipes')) {
      const [id, source_url, , title, cuisine, tags, hero] = bindings as [string, string, string, string, string | null, string | null, string | null];
      this.recipes.set(id, {
        id,
        title,
        tags: tags ?? '',
        cuisine,
        hero_image_url: hero ?? null,
      });
      return;
    }
    if (query.startsWith('INSERT INTO request_logs')) {
      const [ts, level, route, method, status, ms, msg, meta] = bindings as [string, string, string, string, number, number, string, string];
      this.logs.push({ ts, level, route, method, status, ms, msg, meta: JSON.parse(meta ?? '{}') });
      return;
    }
    if (query.startsWith('UPDATE')) {
      return;
    }
    throw new Error(`Unhandled execute query: ${query}`);
  }

  async query<T>(query: string, bindings: unknown[]): Promise<T[]> {
    if (query.includes('FROM user_prefs')) {
      const [userId] = bindings as [string];
      const row = this.userPrefs.get(userId);
      if (!row) return [];
      return [
        {
          user_id: userId,
          cuisines: row.cuisines,
          disliked_ingredients: row.disliked_ingredients,
          favored_tools: row.favored_tools,
          notes: row.notes,
          updated_at: row.updated_at,
        } as unknown as T,
      ];
    }
    if (query.includes('FROM recipes WHERE id IN')) {
      const ids = bindings as string[];
      return ids
        .map((id) => this.recipes.get(id))
        .filter((value): value is { id: string; title: string; tags: string; cuisine: string | null; hero_image_url: string | null } => Boolean(value))
        .map((row) => ({
          id: row.id,
          title: row.title,
          tags: row.tags,
          cuisine: row.cuisine,
          hero_image_url: row.hero_image_url,
        }) as unknown as T);
    }
    if (query.startsWith('SELECT ts, level')) {
      const limit = bindings.at(-1) as number;
      return this.logs.slice().reverse().slice(0, limit) as T[];
    }
    if (query.includes('FROM recipes') && query.includes('ORDER BY datetime(updated_at)')) {
      return Array.from(this.recipes.values()).map((row) => ({
        id: row.id,
        title: row.title,
        tags: row.tags,
        cuisine: row.cuisine,
        hero_image_url: row.hero_image_url,
      }) as unknown as T);
    }
    throw new Error(`Unhandled query: ${query}`);
  }
}

class MockBrowser implements BrowserService {
  constructor(private page: BrowserPage) {}
  async newSession(): Promise<BrowserSession> {
    return {
      newPage: async () => this.page,
      close: async () => undefined,
    };
  }
}

function createEnv(overrides: Partial<Env & { vectorResult?: VectorizeQueryResult; aiImpl?: (model: string, options: Record<string, unknown>) => Promise<any> }> = {}): Env & { db: MockD1; aiCalls: any[] } {
  const db = new MockD1();
  db.recipes.set('recipe-1', {
    id: 'recipe-1',
    title: 'Peach Basil Crostini',
    tags: 'peach,snack,summer',
    cuisine: 'american',
    hero_image_url: null,
  });

  const vectorResult: VectorizeQueryResult = overrides.vectorResult ?? {
    matches: [
      {
        id: 'recipe-1',
        score: 0.9,
        metadata: { recipe_id: 'recipe-1', title: 'Peach Basil Crostini', tags: ['peach'] },
      },
    ],
  };

  const aiCalls: any[] = [];
  const ai = {
    run: async (model: string, options: Record<string, unknown>) => {
      aiCalls.push({ model, options });
      if (model.includes('embedding')) {
        return { data: [{ embedding: [0.1, 0.2, 0.3] }] };
      }
      if (model.includes('whisper')) {
        return { text: 'garlic, basil, tomato' };
      }
      if (options?.messages) {
        const last = Array.isArray(options.messages) ? options.messages.at(-1) : null;
        if (typeof last?.content === 'string' && last.content.includes('{')) {
          return {
            choices: [
              {
                message: {
                  content: last.content,
                },
              },
            ],
          };
        }
        if (typeof last?.content === 'string' && last.content.includes('Top candidate recipes')) {
          return {
            choices: [
              {
                message: {
                  content: 'Try Peach Basil Crostini with whipped goat cheese.',
                },
              },
            ],
          };
        }
      }
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                id: 'recipe-2',
                title: 'OCR Recipe',
                ingredients: [],
                steps: [],
              }),
            },
          },
        ],
      };
    },
  };

  const browserPage: BrowserPage = {
    async goto() {
      return undefined;
    },
    async content() {
      return '<html><body><h1>Recipe</h1></body></html>';
    },
    async close() {
      return undefined;
    },
    async evaluate() {
      return '' as any;
    },
  };

  const env: Env & { db: MockD1; aiCalls: any[] } = {
    ASSETS: {
      fetch: (request: Request) => Promise.resolve(new Response(`asset for ${new URL(request.url).pathname}`)),
    } as unknown as Fetcher,
    DB: db,
    WORKER_API_KEY: 'secret',
    AI: overrides.aiImpl ? { run: overrides.aiImpl } : (ai as any),
    BROWSER: overrides.BROWSER ?? new MockBrowser(browserPage),
    VEC: overrides.VEC ?? {
      query: async () => vectorResult,
      upsert: async () => undefined,
    },
    db,
    aiCalls,
  } as any;

  return env;
}

describe('worker', () => {
  let env: ReturnType<typeof createEnv>;
  let ctx: ExecutionContext;
  let c: any;

  beforeEach(() => {
    env = createEnv();
    ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        promise.catch((error) => {
          console.error('waitUntil error', error);
        });
      },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
  });

  it('returns chat suggestions', async () => {
    const request = new Request('https://example.com/api/chat/ingredients', {
      method: 'POST',
      body: JSON.stringify({ ingredients: ['peach', 'basil'] }),
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'secret' },
    });
    c = { req: { raw: request }, env, executionCtx: ctx };
    const response = await handleChatIngredients(c);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect(body.message).toContain('Peach Basil Crostini');
  });

  it('ingests recipe from url', async () => {
    const request = new Request('https://example.com/api/ingest/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'secret' },
      body: JSON.stringify({ url: 'https://example.com/recipe' }),
    });
    c = { req: { raw: request }, env, executionCtx: ctx };
    const response = await handleIngestUrl(c);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recipe.title).toBeDefined();
    expect(env.db.ingestions.length).toBe(1);
    expect(env.db.recipes.size).toBeGreaterThan(0);
  });

  it('transcribes audio', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([0, 1, 2])], { type: 'audio/webm' }), 'voice.webm');
    const request = new Request('https://example.com/api/transcribe', {
      method: 'POST',
      headers: { 'X-API-Key': 'secret' },
      body: form,
    });
    c = { req: { raw: request, formData: async () => request.formData() }, env, executionCtx: ctx };
    const response = await handleTranscribe(c);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.text).toBe('garlic, basil, tomato');
  });

  it('saves and loads user preferences', async () => {
    const put = new Request('https://example.com/api/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'secret' },
      body: JSON.stringify({ userId: 'household-1', cuisines: 'thai', dislikedIngredients: ['celery'], favoredTools: 'air_fryer', notes: 'no celery please' }),
    });
    c = { req: { raw: put }, env, executionCtx: ctx };
    const putRes = await handlePutPrefs(c);
    expect(putRes.status).toBe(200);

    const get = new Request('https://example.com/api/prefs?userId=household-1', {
      headers: { 'X-API-Key': 'secret' },
    });
    c = { req: { raw: get, query: (key: string) => new URL(get.url).searchParams.get(key) }, env, executionCtx: ctx };
    const getRes = await handleGetPrefs(c);
    const body = await getRes.json();
    expect(body.preferences.userId).toBe('household-1');
    expect(body.preferences.cuisines).toContain('thai');
  });
});