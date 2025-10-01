import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, resolveUser, generateToken } from './lib/auth';
import { scrapeAndExtract } from './lib/scrape';
import { chat } from './lib/ai';
import { scheduleProfileRecompute, getUserProfile } from './lib/profile';

const app = new Hono<{ Bindings: Env }>();

app.use('/*', cors());

// Health check
app.get('/', (c) => c.json({ status: 'ok', service: 'MenuForge' }));

// CDN - Serve images from R2
app.get('/cdn/images/*', async (c) => {
  try {
    const key = c.req.path.replace('/cdn/images/', '');
    const object = await c.env.R2_IMAGES.get(key);

    if (object === null) {
      return c.notFound();
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'public, max-age=31536000, immutable');

    return new Response(object.body, {
      headers,
    });
  } catch (error) {
    console.error('Image serve error:', error);
    return c.notFound();
  }
});

// Auth - Dev login
app.post('/api/auth/dev-login', async (c) => {
  try {
    const body = await c.req.json();
    const { user_id, name, email } = body;
    
    if (!user_id) {
      return c.json({ error: 'user_id required' }, 400);
    }
    
    // Upsert user
    await c.env.DB.prepare(
      `INSERT INTO users (id, name, email, updated_at) 
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         email = excluded.email,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(user_id, name || null, email || null).run();
    
    // Generate token
    const token = generateToken();
    const sessionKey = `kv:sess:${token}`;
    
    // Store session (expires in 30 days)
    await c.env.KV.put(sessionKey, JSON.stringify({
      user_id,
      expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
    }), { expirationTtl: 30 * 24 * 60 * 60 });
    
    return c.json({ token });
  } catch (error) {
    console.error('Dev login error:', error);
    return c.json({ error: 'Failed to create session' }, 500);
  }
});

// Recipes - Scan single URL
app.post('/api/recipes/scan', async (c) => {
  try {
    const body = await c.req.json();
    const { url } = body;
    
    if (!url) {
      return c.json({ error: 'url required' }, 400);
    }
    
    const result = await scrapeAndExtract(c.env, url);
    return c.json({ id: result.id });
  } catch (error) {
    console.error('Scan error:', error);
    return c.json({ error: 'Failed to scan recipe' }, 500);
  }
});

// Recipes - Batch scan
app.post('/api/recipes/batch-scan', async (c) => {
  try {
    const body = await c.req.json();
    const { urls } = body;
    
    if (!Array.isArray(urls)) {
      return c.json({ error: 'urls array required' }, 400);
    }
    
    const results = [];
    const promises = urls.map(async (url) => {
      try {
        const result = await scrapeAndExtract(c.env, url);
        return { url, success: true, id: result.id };
      } catch (error) {
        return { url, success: false, error: String(error) };
      }
    });
    const results = await Promise.all(promises);
    
    return c.json({ results });
  } catch (error) {
    console.error('Batch scan error:', error);
    return c.json({ error: 'Failed to batch scan' }, 500);
  }
});

// Recipes - List with ranking
app.get('/api/recipes', async (c) => {
  try {
    const userId = await resolveUser(c);
    const q = c.req.query('q');
    const tag = c.req.query('tag');
    const cuisine = c.req.query('cuisine');
    const limit = parseInt(c.req.query('limit') || '24');
    
    let query = 'SELECT id, title, hero_image_url, cuisine, tags FROM recipes WHERE 1=1';
    const bindings: any[] = [];
    
    if (q) {
      query += ' AND (title LIKE ? OR tags LIKE ? OR cuisine LIKE ?)';
      const searchTerm = `%${q}%`;
      bindings.push(searchTerm, searchTerm, searchTerm);
    }
    
    if (tag) {
      query += ' AND tags LIKE ?';
      bindings.push(`%${tag}%`);
    }
    
    if (cuisine) {
      query += ' AND cuisine LIKE ?';
      bindings.push(`%${cuisine}%`);
    }
    
    query += ` LIMIT ${limit}`;
    
    const { results } = await c.env.DB.prepare(query).bind(...bindings).all();
    
    // Apply user profile ranking if available
    if (userId !== 'anon') {
      const profile = await getUserProfile(c.env, userId);
      
      if (profile) {
        const rankedResults = (results as any[]).map(recipe => {
          let score = 0;
          
          // Freshness (newer recipes get higher score)
          const createdAt = new Date(recipe.created_at || 0).getTime();
          const ageInDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
          const freshnessScore = Math.max(0, 1 - ageInDays / 365);
          score += freshnessScore;
          
          // Tag preferences
          if (recipe.tags && profile.tags) {
            const tags = recipe.tags.split(',').map((t: string) => t.trim());
            for (const tag of tags) {
              score += (profile.tags[tag] || 0) * 0.2;
            }
          }
          
          // Cuisine preferences
          if (recipe.cuisine && profile.cuisine) {
            const cuisines = recipe.cuisine.split(',').map((c: string) => c.trim());
            for (const cuisine of cuisines) {
              score += (profile.cuisine[cuisine] || 0) * 0.3;
            }
          }
          
          return { ...recipe, score };
        });
        
        rankedResults.sort((a, b) => b.score - a.score);
        
        return c.json({
          recipes: rankedResults.map(({ score, ...recipe }) => recipe)
        });
      }
    }
    
    return c.json({ recipes: results });
  } catch (error) {
    console.error('List recipes error:', error);
    return c.json({ error: 'Failed to list recipes' }, 500);
  }
});

// Recipes - Get single recipe
app.get('/api/recipes/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const userId = await resolveUser(c);
    
    const recipe = await c.env.DB.prepare(
      'SELECT * FROM recipes WHERE id = ?'
    ).bind(id).first();
    
    if (!recipe) {
      return c.json({ error: 'Recipe not found' }, 404);
    }
    
    // Track event
    if (userId !== 'anon') {
      await c.env.DB.prepare(
        'INSERT INTO events (user_id, recipe_id, event_type) VALUES (?, ?, ?)'
      ).bind(userId, id, 'open_full').run();
    }
    
    return c.json({ recipe });
  } catch (error) {
    console.error('Get recipe error:', error);
    return c.json({ error: 'Failed to get recipe' }, 500);
  }
});

// Favorites - Add
app.post('/api/favorites/:id', async (c) => {
  try {
    const userId = await resolveUser(c);
    if (userId === 'anon') {
      return c.json({ error: 'Authentication required' }, 401);
    }
    
    const recipeId = c.req.param('id');
    
    await c.env.DB.prepare(
      'INSERT INTO favorites (user_id, recipe_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
    ).bind(userId, recipeId).run();
    
    await c.env.DB.prepare(
      'INSERT INTO events (user_id, recipe_id, event_type) VALUES (?, ?, ?)'
    ).bind(userId, recipeId, 'favorite').run();
    
    scheduleProfileRecompute(c.env, userId);
    
    return c.json({ success: true });
  } catch (error) {
    console.error('Add favorite error:', error);
    return c.json({ error: 'Failed to add favorite' }, 500);
  }
});

// Favorites - Remove
app.delete('/api/favorites/:id', async (c) => {
  try {
    const userId = await resolveUser(c);
    if (userId === 'anon') {
      return c.json({ error: 'Authentication required' }, 401);
    }
    
    const recipeId = c.req.param('id');
    
    await c.env.DB.prepare(
      'DELETE FROM favorites WHERE user_id = ? AND recipe_id = ?'
    ).bind(userId, recipeId).run();
    
    return c.json({ success: true });
  } catch (error) {
    console.error('Remove favorite error:', error);
    return c.json({ error: 'Failed to remove favorite' }, 500);
  }
});

// Ratings - Add/Update
app.post('/api/recipes/:id/rating', async (c) => {
  try {
    const userId = await resolveUser(c);
    if (userId === 'anon') {
      return c.json({ error: 'Authentication required' }, 401);
    }
    
    const recipeId = c.req.param('id');
    const body = await c.req.json();
    const { stars, notes, cooked_at } = body;
    
    if (!stars || stars < 1 || stars > 5) {
      return c.json({ error: 'stars must be between 1 and 5' }, 400);
    }
    
    await c.env.DB.prepare(
      `INSERT INTO ratings (user_id, recipe_id, stars, notes, cooked_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, recipe_id) DO UPDATE SET
         stars = excluded.stars,
         notes = excluded.notes,
         cooked_at = excluded.cooked_at,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(userId, recipeId, stars, notes || null, cooked_at || null).run();
    
    await c.env.DB.prepare(
      'INSERT INTO events (user_id, recipe_id, event_type, event_value) VALUES (?, ?, ?, ?)'
    ).bind(userId, recipeId, 'rated', String(stars)).run();
    
    if (cooked_at) {
      await c.env.DB.prepare(
        'INSERT INTO events (user_id, recipe_id, event_type) VALUES (?, ?, ?)'
      ).bind(userId, recipeId, 'cooked').run();
    }
    
    scheduleProfileRecompute(c.env, userId);
    
    return c.json({ success: true });
  } catch (error) {
    console.error('Add rating error:', error);
    return c.json({ error: 'Failed to add rating' }, 500);
  }
});

// Ratings - Get
app.get('/api/recipes/:id/rating', async (c) => {
  try {
    const userId = await resolveUser(c);
    const recipeId = c.req.param('id');
    
    if (userId === 'anon') {
      return c.json({ stars: null });
    }
    
    const rating = await c.env.DB.prepare(
      'SELECT stars, notes, cooked_at FROM ratings WHERE user_id = ? AND recipe_id = ?'
    ).bind(userId, recipeId).first();
    
    if (!rating) {
      return c.json({ stars: null });
    }
    
    return c.json({ rating });
  } catch (error) {
    console.error('Get rating error:', error);
    return c.json({ error: 'Failed to get rating' }, 500);
  }
});

// Events - Track
app.post('/api/events', async (c) => {
  try {
    const userId = await resolveUser(c);
    const body = await c.req.json();
    const { event_type, recipe_id, value } = body;
    
    if (!event_type) {
      return c.json({ error: 'event_type required' }, 400);
    }
    
    await c.env.DB.prepare(
      'INSERT INTO events (user_id, recipe_id, event_type, event_value) VALUES (?, ?, ?, ?)'
    ).bind(userId === 'anon' ? null : userId, recipe_id || null, event_type, value || null).run();
    
    return c.json({ success: true });
  } catch (error) {
    console.error('Track event error:', error);
    return c.json({ error: 'Failed to track event' }, 500);
  }
});

// Menus - Generate
app.post('/api/menus/generate', async (c) => {
  try {
    const userId = await resolveUser(c);
    if (userId === 'anon') {
      return c.json({ error: 'Authentication required' }, 401);
    }
    
    const body = await c.req.json();
    const { week_start } = body;
    
    // Get user profile for boosting
    const profile = await getUserProfile(c.env, userId);
    
    // Fetch diverse recipes
    const { results: recipes } = await c.env.DB.prepare(
      `SELECT id, title, cuisine, tags FROM recipes 
       ORDER BY RANDOM() 
       LIMIT 50`
    ).all();
    
    // Score and select 7 diverse recipes
    const scored = (recipes as any[]).map(recipe => {
      let score = Math.random();
      
      if (profile) {
        if (recipe.cuisine && profile.cuisine) {
          const cuisines = recipe.cuisine.split(',').map((c: string) => c.trim());
          for (const cuisine of cuisines) {
            score += (profile.cuisine[cuisine] || 0) * 0.3;
          }
        }
        
        if (recipe.tags && profile.tags) {
          const tags = recipe.tags.split(',').map((t: string) => t.trim());
          for (const tag of tags) {
            score += (profile.tags[tag] || 0) * 0.2;
          }
        }
      }
      
      return { ...recipe, score };
    });
    
    scored.sort((a, b) => b.score - a.score);
    
    // Select top 7 with diversity
    const selected = scored.slice(0, 7);
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const items = selected.map((recipe, i) => ({
      day: days[i],
      meal: 'dinner',
      recipe_id: recipe.id,
    }));
    
    // Create menu
    const menuId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO menus (id, user_id, title, week_start, items_json)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      menuId,
      userId,
      `Menu for ${week_start || 'this week'}`,
      week_start || new Date().toISOString().split('T')[0],
      JSON.stringify(items)
    ).run();
    
    await c.env.DB.prepare(
      'INSERT INTO menu_members (menu_id, user_id, role) VALUES (?, ?, ?)'
    ).bind(menuId, userId, 'owner').run();
    
    return c.json({ id: menuId, items });
  } catch (error) {
    console.error('Generate menu error:', error);
    return c.json({ error: 'Failed to generate menu' }, 500);
  }
});

// Menus - Get
app.get('/api/menus/:id', async (c) => {
  try {
    const id = c.req.param('id');
    
    const menu = await c.env.DB.prepare(
      'SELECT * FROM menus WHERE id = ?'
    ).bind(id).first();
    
    if (!menu) {
      return c.json({ error: 'Menu not found' }, 404);
    }
    
    return c.json({ menu });
  } catch (error) {
    console.error('Get menu error:', error);
    return c.json({ error: 'Failed to get menu' }, 500);
  }
});

// Menus - Update
app.put('/api/menus/:id', async (c) => {
  try {
    const userId = await resolveUser(c);
    if (userId === 'anon') {
      return c.json({ error: 'Authentication required' }, 401);
    }
    
    const id = c.req.param('id');
    const body = await c.req.json();
    const { items } = body;
    
    if (!items) {
      return c.json({ error: 'items required' }, 400);
    }
    
    await c.env.DB.prepare(
      `UPDATE menus SET items_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(JSON.stringify(items), id).run();
    
    return c.json({ success: true });
  } catch (error) {
    console.error('Update menu error:', error);
    return c.json({ error: 'Failed to update menu' }, 500);
  }
});

// Search - Suggest
app.get('/api/search/suggest', async (c) => {
  try {
    const q = c.req.query('q');
    
    if (!q) {
      return c.json({ suggestions: [] });
    }
    
    // Check cache
    const cacheKey = `kv:search-cache:${q}`;
    const cached = await c.env.KV.get(cacheKey, 'json');
    if (cached) {
      return c.json({ suggestions: cached });
    }
    
    // Simple search
    const { results } = await c.env.DB.prepare(
      `SELECT DISTINCT title FROM recipes WHERE title LIKE ? LIMIT 5`
    ).bind(`%${q}%`).all();
    
    const suggestions = (results as any[]).map(r => r.title);
    
    // Cache for 1 hour
    await c.env.KV.put(cacheKey, JSON.stringify(suggestions), { expirationTtl: 3600 });
    
    return c.json({ suggestions });
  } catch (error) {
    console.error('Search suggest error:', error);
    return c.json({ error: 'Failed to get suggestions' }, 500);
  }
});

// Search - Scrape
app.post('/api/search/scrape', async (c) => {
  try {
    const body = await c.req.json();
    const { urls } = body;
    
    if (urls) {
      // Enqueue URLs
      for (const url of urls) {
        await c.env.DB.prepare(
          `INSERT INTO crawl_queue (url, status) VALUES (?, 'queued') ON CONFLICT DO NOTHING`
        ).bind(url).run();
      }
      return c.json({ success: true, queued: urls.length });
    }
    
    // Basic seed discovery (simplified)
    const seeds = await c.env.KV.get('source-seeds', 'json') as string[] || [
      'https://www.seriouseats.com/',
      'https://www.sbs.com.au/food/cuisine/singaporean',
      'https://www.kingarthurbaking.com/recipes',
      'https://www.budgetbytes.com/',
      'https://www.breadmachinepros.com/recipes/'
    ];
    
    for (const seed of seeds) {
      await c.env.DB.prepare(
        `INSERT INTO crawl_queue (url, priority, status) VALUES (?, 1, 'queued') ON CONFLICT DO NOTHING`
      ).bind(seed).run();
    }
    
    return c.json({ success: true, queued: seeds.length });
  } catch (error) {
    console.error('Search scrape error:', error);
    return c.json({ error: 'Failed to scrape' }, 500);
  }
});

// Print - PDF
// Print - Recipe as HTML (or PDF with Browser Rendering)
app.get('/api/recipes/:id/print', async (c) => {
  try {
    const id = c.req.param('id');
    const format = c.req.query('format') || 'html'; // 'html' or 'pdf'
    
    const recipe = await c.env.DB.prepare(
      'SELECT * FROM recipes WHERE id = ?'
    ).bind(id).first() as any;
    
    if (!recipe) {
      return c.json({ error: 'Recipe not found' }, 404);
    }
    
    // Generate print-optimized HTML
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${recipe.title}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; }
    h1 { color: #333; }
    .meta { color: #666; margin: 20px 0; }
    .section { margin: 30px 0; }
    .ingredients li, .steps li { margin: 10px 0; }
  </style>
</head>
<body>
  <h1>${recipe.title}</h1>
  ${recipe.author ? `<p class="meta">By ${recipe.author}</p>` : ''}
  ${recipe.time_total_min ? `<p class="meta">Total time: ${recipe.time_total_min} minutes</p>` : ''}
  
  <div class="section">
    <h2>Ingredients</h2>
    <ul class="ingredients">
      ${JSON.parse(recipe.ingredients_json).map((i: string) => `<li>${i}</li>`).join('')}
    </ul>
  </div>
  
  <div class="section">
    <h2>Instructions</h2>
    <ol class="steps">
      ${JSON.parse(recipe.steps_json).map((s: string) => `<li>${s}</li>`).join('')}
    </ol>
  </div>
  
  ${recipe.alternatives_json ? `
  <div class="section">
    <h2>Alternative Cooking Methods</h2>
    <pre>${JSON.stringify(JSON.parse(recipe.alternatives_json), null, 2)}</pre>
  </div>
  ` : ''}
</body>
</html>
    `;
    
    // Return HTML for now. In production with Browser Rendering API, could generate PDF
    // To generate PDF: use Browser Rendering API to render HTML and convert to PDF
    const contentType = 'text/html';
    const extension = 'html';
    
    return new Response(html, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="recipe-${id}.${extension}"`,
      },
    });
  } catch (error) {
    console.error('Print error:', error);
    return c.json({ error: 'Failed to generate printable recipe' }, 500);
  }
});

// Chat
app.post('/api/chat', async (c) => {
  try {
    const userId = await resolveUser(c);
    const body = await c.req.json();
    const { messages } = body;
    
    if (!messages || !Array.isArray(messages)) {
      return c.json({ error: 'messages array required' }, 400);
    }
    
    let userPrefs = null;
    if (userId !== 'anon') {
      userPrefs = await getUserProfile(c.env, userId);
    }
    
    const stream = await chat(c.env, messages, userPrefs);
    
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Chat error:', error);
    return c.json({ error: 'Failed to chat' }, 500);
  }
});

// Scheduled handler (Cron)
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log('Running scheduled crawl job');
    
    try {
      // Get seeds
      const seeds = await env.KV.get('source-seeds', 'json') as string[] || [
        'https://www.seriouseats.com/',
        'https://www.sbs.com.au/food/cuisine/singaporean',
        'https://www.kingarthurbaking.com/recipes',
        'https://www.budgetbytes.com/',
        'https://www.breadmachinepros.com/recipes/'
      ];
      
      // Store seeds if not present
      if (!await env.KV.get('source-seeds')) {
        await env.KV.put('source-seeds', JSON.stringify(seeds));
      }
      
      // For each seed, discover links (simplified - in production would use actual browser)
      for (const seed of seeds) {
        try {
          const response = await fetch(seed);
          const html = await response.text();
          
          // Extract links with recipe keywords
          const linkRegex = /href=["'](https?:\/\/[^"']*(?:recipe|banana-bread|cake|cookie|dessert|bread)[^"']*)["']/gi;
          let match;
          const links = new Set<string>();
          
          while ((match = linkRegex.exec(html)) !== null) {
            links.add(match[1]);
          }
          
          // Enqueue up to 5 links per seed
          let count = 0;
          for (const link of links) {
            if (count >= 5) break;
            
            await env.DB.prepare(
              `INSERT INTO crawl_queue (url, status) VALUES (?, 'queued') ON CONFLICT DO NOTHING`
            ).bind(link).run();
            
            count++;
          }
        } catch (e) {
          console.error(`Error processing seed ${seed}:`, e);
        }
      }
      
      // Process queued items (up to 20)
      const { results: queued } = await env.DB.prepare(
        `SELECT id, url FROM crawl_queue WHERE status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT 20`
      ).all();
      
      for (const item of queued as any[]) {
        try {
          // Mark as processing
          await env.DB.prepare(
            `UPDATE crawl_queue SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          ).bind(item.id).run();
          
          // Scrape
          await scrapeAndExtract(env, item.url);
          
          // Mark as done
          await env.DB.prepare(
            `UPDATE crawl_queue SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          ).bind(item.id).run();
        } catch (error) {
          console.error(`Error processing ${item.url}:`, error);
          
          // Mark as error
          await env.DB.prepare(
            `UPDATE crawl_queue SET status = 'error', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          ).bind(String(error), item.id).run();
        }
      }
      
      console.log(`Processed ${queued.length} queued items`);
    } catch (error) {
      console.error('Scheduled job error:', error);
    }
  },
};
