import { Env } from './auth';

export const ENRICHMENT_SYSTEM_PROMPT = `You are MenuForge, a backend chef-analyst for a recipe and meal-planning app.
Goals:
1) Normalize any found recipe (HTML, JSON-LD, microdata, text) into:
   { id, source_url, title, author, cuisine[], tags[], hero_image_url, yield, time_prep_min, time_cook_min, time_total_min, calories_per_serving, ingredients[], steps[], equipment[], nutrition{}, allergens[], notes, source_blocks[] }
2) Generate safe, pragmatic alternative-cooking notes for:
   - Tokit (pressure/slow/sauté/steam): mode, temp/pressure level, timings, liquid ratios.
   - Air fryer: temp, preheat, batch sizing, shake intervals.
   - Rice cooker: one-pot feasibility, liquid ratios, layering.
   - Bread machine: dough vs bake, pan size, program.
3) Classify cuisine & diet tags (meat, vegetarian, vegan, Asian, American, Singaporean, dessert, baking, bread-machine).
4) If uncertain, mark fields and \`confidence: low\`. Never invent unsafe steps.
5) Preserve original formatting blocks as \`source_blocks[]\` so the UI can render "as found".
Style: concise, operational, metric + US.`;

export async function embed(env: Env, text: string): Promise<number[]> {
  try {
    const response = await env.AI.run(env.EMBED_MODEL, {
      text: [text],
    }) as { data?: number[][]; shape?: number[] };
    
    if (response.data && response.data[0]) {
      return response.data[0];
    }
    return [];
  } catch (e) {
    console.error('Error generating embedding:', e);
    return [];
  }
}

export async function enrichRecipe(env: Env, candidateData: any): Promise<any> {
  try {
    const userPrompt = `Extract and normalize this recipe data:\n\n${JSON.stringify(candidateData, null, 2)}\n\nReturn ONLY valid JSON with the normalized recipe structure including alternatives for Tokit, air fryer, rice cooker, and bread machine.`;
    
    const response = await env.AI.run(env.CHAT_MODEL, {
      messages: [
        { role: 'system', content: ENRICHMENT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 4000,
    }) as { response?: string };
    
    if (!response.response) {
      throw new Error('No response from AI');
    }
    
    // Try to extract JSON from the response
    let jsonStr = response.response;
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    
    const enriched = JSON.parse(jsonStr);
    
    // Ensure required fields exist
    if (!enriched.id) {
      enriched.id = crypto.randomUUID();
    }
    if (!enriched.ingredients_json && enriched.ingredients) {
      enriched.ingredients_json = JSON.stringify(enriched.ingredients);
    }
    if (!enriched.steps_json && enriched.steps) {
      enriched.steps_json = JSON.stringify(enriched.steps);
    }
    
    return enriched;
  } catch (e) {
    console.error('Error enriching recipe:', e);
    // Return a basic structure on error
    return {
      ...candidateData,
      id: candidateData.id || crypto.randomUUID(),
      confidence: 'low',
      ingredients_json: JSON.stringify(candidateData.ingredients || []),
      steps_json: JSON.stringify(candidateData.steps || []),
    };
  }
}

export async function chat(env: Env, messages: any[], userPrefs?: any): Promise<ReadableStream> {
  const systemMessages = [];
  
  if (userPrefs) {
    const prefsStr = `User likes cuisines=${JSON.stringify(userPrefs.cuisine || {})}, tags=${JSON.stringify(userPrefs.tags || {})}. Prefer these when suggesting.`;
    systemMessages.push({ role: 'system', content: prefsStr });
  }
  
  const allMessages = [...systemMessages, ...messages];
  
  const response = await env.AI.run(env.CHAT_MODEL, {
    messages: allMessages,
    stream: true,
  }) as ReadableStream;
  
  return response;
}
