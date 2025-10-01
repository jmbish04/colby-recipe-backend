import { Env } from './auth';

const HALF_LIFE_DAYS = 90;

export async function recomputeProfile(env: Env, userId: string): Promise<void> {
  try {
    // Fetch all events for the user with recipe data
    const { results: events } = await env.DB.prepare(
      `SELECT e.event_type, e.event_value, e.created_at, e.recipe_id,
              r.cuisine, r.tags
       FROM events e
       LEFT JOIN recipes r ON e.recipe_id = r.id
       WHERE e.user_id = ?
       ORDER BY e.created_at DESC
       LIMIT 1000`
    ).bind(userId).all();
    
    const cuisinePrefs: Record<string, number> = {};
    const tagPrefs: Record<string, number> = {};
    const now = Date.now();
    
    for (const event of events as any[]) {
      if (!event.recipe_id) continue;
      
      // Calculate decay based on event age
      const eventDate = new Date(event.created_at).getTime();
      const ageInDays = (now - eventDate) / (1000 * 60 * 60 * 24);
      const decayFactor = Math.exp(-Math.log(2) * ageInDays / HALF_LIFE_DAYS);
      
      // Determine weight based on event type
      let weight = 0;
      switch (event.event_type) {
        case 'rated':
          const stars = parseInt(event.event_value || '3');
          weight = (stars - 3) * decayFactor; // -2, -1, 0, 1, 2
          break;
        case 'favorite':
          weight = 1.2 * decayFactor;
          break;
        case 'add_to_menu':
        case 'cooked':
          weight = 1.6 * decayFactor;
          break;
        case 'open_full':
          weight = 0.3 * decayFactor;
          break;
        case 'click_tile':
          weight = 0.1 * decayFactor;
          break;
        default:
          weight = 0;
      }
      
      // Apply weight to cuisine
      if (event.cuisine) {
        const cuisines = typeof event.cuisine === 'string' 
          ? event.cuisine.split(',').map((c: string) => c.trim())
          : [event.cuisine];
        
        for (const cuisine of cuisines) {
          if (cuisine) {
            cuisinePrefs[cuisine] = (cuisinePrefs[cuisine] || 0) + weight;
          }
        }
      }
      
      // Apply weight to tags
      if (event.tags) {
        const tags = typeof event.tags === 'string'
          ? event.tags.split(',').map((t: string) => t.trim())
          : [event.tags];
        
        for (const tag of tags) {
          if (tag) {
            tagPrefs[tag] = (tagPrefs[tag] || 0) + weight;
          }
        }
      }
    }
    
    // Clamp values to [-3, 3]
    for (const key in cuisinePrefs) {
      cuisinePrefs[key] = Math.max(-3, Math.min(3, cuisinePrefs[key]));
    }
    for (const key in tagPrefs) {
      tagPrefs[key] = Math.max(-3, Math.min(3, tagPrefs[key]));
    }
    
    // Store in D1
    await env.DB.prepare(
      `INSERT INTO user_profiles (user_id, cuisine_prefs_json, tag_prefs_json, last_recomputed_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         cuisine_prefs_json = excluded.cuisine_prefs_json,
         tag_prefs_json = excluded.tag_prefs_json,
         last_recomputed_at = CURRENT_TIMESTAMP`
    ).bind(
      userId,
      JSON.stringify(cuisinePrefs),
      JSON.stringify(tagPrefs)
    ).run();
    
    // Mirror to KV
    await env.KV.put(`kv:user-prof:${userId}`, JSON.stringify({
      cuisine: cuisinePrefs,
      tags: tagPrefs,
    }));
    
  } catch (error) {
    console.error('Error recomputing profile:', error);
  }
}

export async function scheduleProfileRecompute(env: Env, userId: string): Promise<void> {
  const debounceKey = `kv:profile-debounce:${userId}`;
  const existing = await env.KV.get(debounceKey);
  
  if (!existing) {
    await env.KV.put(debounceKey, '1', { expirationTtl: 60 });
    
    // In a real implementation, you might use a queue or scheduled task
    // For now, we'll just recompute immediately after the debounce period
    // This is a simplified version
    setTimeout(() => recomputeProfile(env, userId), 60000);
  }
}

export async function getUserProfile(env: Env, userId: string): Promise<any> {
  // Try KV first (faster)
  const cached = await env.KV.get(`kv:user-prof:${userId}`, 'json');
  if (cached) {
    return cached;
  }
  
  // Fall back to D1
  const result = await env.DB.prepare(
    `SELECT cuisine_prefs_json, tag_prefs_json FROM user_profiles WHERE user_id = ?`
  ).bind(userId).first();
  
  if (result) {
    return {
      cuisine: JSON.parse(result.cuisine_prefs_json as string || '{}'),
      tags: JSON.parse(result.tag_prefs_json as string || '{}'),
    };
  }
  
  return null;
}
