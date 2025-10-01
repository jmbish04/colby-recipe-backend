import { Env } from './auth';
import { enrichRecipe } from './ai';

export async function scrapeAndExtract(env: Env, url: string): Promise<any> {
  let browser;
  
  try {
    // Launch browser using Browser Rendering API
    browser = await env.BROWSER.fetch('http://localhost');
    
    // Note: Actual Browser Rendering API usage would be through puppeteer
    // For this implementation, we'll simulate the scraping process
    // In production, you would use:
    // const browser = await puppeteer.launch(env.BROWSER);
    // const page = await browser.newPage();
    
    const pageResponse = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MenuForge/1.0; +https://menuforge.example.com/bot)',
      },
    });
    
    if (!pageResponse.ok) {
      throw new Error(`Failed to fetch ${url}: ${pageResponse.status}`);
    }
    
    const html = await pageResponse.text();
    
    // Limit HTML size to ~200KB
    const truncatedHtml = html.substring(0, 200000);
    
    // Extract JSON-LD blocks
    const jsonLdBlocks: any[] = [];
    const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    
    while ((match = scriptRegex.exec(html)) !== null) {
      try {
        const jsonData = JSON.parse(match[1]);
        jsonLdBlocks.push(jsonData);
      } catch (e) {
        console.error('Error parsing JSON-LD:', e);
      }
    }
    
    // Find recipe data in JSON-LD
    let recipeData: any = null;
    for (const block of jsonLdBlocks) {
      if (block['@type'] === 'Recipe' || (Array.isArray(block['@graph']) && block['@graph'].some((item: any) => item['@type'] === 'Recipe'))) {
        if (block['@type'] === 'Recipe') {
          recipeData = block;
        } else if (Array.isArray(block['@graph'])) {
          recipeData = block['@graph'].find((item: any) => item['@type'] === 'Recipe');
        }
        break;
      }
    }
    
    // Build candidate object
    const candidate: any = {
      source_url: url,
      source_domain: new URL(url).hostname,
      title: recipeData?.name || 'Untitled Recipe',
      author: recipeData?.author?.name || recipeData?.author || null,
      hero_image_url: recipeData?.image?.url || recipeData?.image || null,
      cuisine: recipeData?.recipeCuisine || null,
      tags: recipeData?.recipeCategory || null,
      yield: recipeData?.recipeYield || null,
      time_prep_min: parseTime(recipeData?.prepTime),
      time_cook_min: parseTime(recipeData?.cookTime),
      time_total_min: parseTime(recipeData?.totalTime),
      calories_per_serving: recipeData?.nutrition?.calories ? parseInt(recipeData.nutrition.calories) : null,
      ingredients: Array.isArray(recipeData?.recipeIngredient) ? recipeData.recipeIngredient : [],
      steps: Array.isArray(recipeData?.recipeInstructions) 
        ? recipeData.recipeInstructions.map((s: any) => typeof s === 'string' ? s : s.text)
        : [],
      source_blocks: [
        {
          kind: 'html',
          value: truncatedHtml
        }
      ],
      jsonld_raw: jsonLdBlocks.length > 0 ? JSON.stringify(jsonLdBlocks) : null,
    };
    
    // Enrich with AI
    const enriched = await enrichRecipe(env, candidate);
    
    // Generate UUID for recipe
    const recipeId = enriched.id || crypto.randomUUID();
    
    // Store HTML snapshot to R2
    const htmlKey = `snapshots/${recipeId}.html`;
    await env.R2.put(htmlKey, truncatedHtml, {
      httpMetadata: { contentType: 'text/html' }
    });
    
    // Store screenshot (simulated - in production would use actual browser rendering)
    const screenshotKey = `snapshots/${recipeId}.png`;
    // await env.R2.put(screenshotKey, screenshotBuffer);
    
    // Download and store hero image if present
    if (enriched.hero_image_url) {
      try {
        const imgResponse = await fetch(enriched.hero_image_url);
        if (imgResponse.ok) {
          const imgBuffer = await imgResponse.arrayBuffer();
          const imgKey = `images/${recipeId}.jpg`;
          await env.R2_IMAGES.put(imgKey, imgBuffer, {
            httpMetadata: { contentType: 'image/jpeg' }
          });
          enriched.hero_image_url = `/cdn/images/${imgKey}`;
        }
      } catch (e) {
        console.error('Error downloading hero image:', e);
      }
    }
    
    // Upsert recipe to database
    await upsertRecipe(env, enriched);
    
    // Store snapshot record
    await env.DB.prepare(
      `INSERT INTO snapshots (recipe_id, html_r2_key, screenshot_r2_key) 
       VALUES (?, ?, ?)`
    ).bind(recipeId, htmlKey, screenshotKey).run();
    
    return { id: recipeId, ...enriched };
    
  } catch (error) {
    console.error('Error scraping:', error);
    throw error;
  }
}

function parseTime(duration?: string): number | null {
  if (!duration) return null;
  
  // Parse ISO 8601 duration (e.g., PT30M, PT1H30M)
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (match) {
    const hours = parseInt(match[1] || '0');
    const minutes = parseInt(match[2] || '0');
    return hours * 60 + minutes;
  }
  
  return null;
}

async function upsertRecipe(env: Env, recipe: any): Promise<void> {
  const {
    id, source_url, source_domain, title, author, hero_image_url,
    cuisine, tags, yield: recipeYield, time_prep_min, time_cook_min, time_total_min,
    calories_per_serving, ingredients_json, steps_json, equipment_json,
    nutrition_json, allergens_json, source_blocks_json, alternatives_json, confidence
  } = recipe;
  
  await env.DB.prepare(
    `INSERT INTO recipes (
      id, source_url, source_domain, title, author, hero_image_url,
      cuisine, tags, yield, time_prep_min, time_cook_min, time_total_min,
      calories_per_serving, ingredients_json, steps_json, equipment_json,
      nutrition_json, allergens_json, source_blocks_json, alternatives_json,
      confidence, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      author = excluded.author,
      hero_image_url = excluded.hero_image_url,
      cuisine = excluded.cuisine,
      tags = excluded.tags,
      yield = excluded.yield,
      time_prep_min = excluded.time_prep_min,
      time_cook_min = excluded.time_cook_min,
      time_total_min = excluded.time_total_min,
      calories_per_serving = excluded.calories_per_serving,
      ingredients_json = excluded.ingredients_json,
      steps_json = excluded.steps_json,
      equipment_json = excluded.equipment_json,
      nutrition_json = excluded.nutrition_json,
      allergens_json = excluded.allergens_json,
      source_blocks_json = excluded.source_blocks_json,
      alternatives_json = excluded.alternatives_json,
      confidence = excluded.confidence,
      updated_at = CURRENT_TIMESTAMP`
  ).bind(
    id, source_url, source_domain, title, author, hero_image_url,
    cuisine, tags, recipeYield, time_prep_min, time_cook_min, time_total_min,
    calories_per_serving,
    typeof ingredients_json === 'string' ? ingredients_json : JSON.stringify(ingredients_json || []),
    typeof steps_json === 'string' ? steps_json : JSON.stringify(steps_json || []),
    equipment_json ? (typeof equipment_json === 'string' ? equipment_json : JSON.stringify(equipment_json)) : null,
    nutrition_json ? (typeof nutrition_json === 'string' ? nutrition_json : JSON.stringify(nutrition_json)) : null,
    allergens_json ? (typeof allergens_json === 'string' ? allergens_json : JSON.stringify(allergens_json)) : null,
    typeof recipe.source_blocks === 'string' ? recipe.source_blocks : JSON.stringify(recipe.source_blocks || []),
    typeof recipe.alternatives === 'string' ? recipe.alternatives : JSON.stringify(recipe.alternatives || {}),
    confidence || 'medium'
  ).run();
}
