import { Env } from './env';
import { NormalizedRecipe, PrepPhase, RecipeSummary, RecipeStep, UserPreferences } from './types';
import { truncate } from './utils';

const CHAT_MODEL = '@cf/meta/llama-3.1-70b-instruct';
const EMBEDDING_MODEL = '@cf/embedding/embeddinggemma-300m';
const ASR_MODEL = '@cf/openai/whisper';
const OCR_MODEL = '@cf/meta/llama-3.1-70b-instruct';

export async function embedText(env: Env, text: string): Promise<number[]> {
  if (!text.trim()) {
    return [];
  }

  const response = await env.AI.run(EMBEDDING_MODEL, { text });
  const vector = response?.data?.[0]?.embedding || response?.data?.[0]?.vector;
  if (Array.isArray(vector)) {
    return vector.map((value: unknown) => (typeof value === 'number' ? value : Number(value)));
  }
  if (Array.isArray(response?.embedding)) {
    return response.embedding.map((value: unknown) => (typeof value === 'number' ? value : Number(value)));
  }
  return [];
}

export async function generateChatMessage(env: Env, prompt: string): Promise<string> {
  const response = await env.AI.run(CHAT_MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'You are MenuForge, an upbeat culinary assistant who tailors recipe suggestions using personalization preferences. Keep answers friendly and concise.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const choices = response?.choices;
  if (Array.isArray(choices) && choices[0]?.message?.content) {
    return choices[0].message.content as string;
  }

  if (typeof response?.result === 'string') {
    return response.result;
  }
  if (typeof response?.response === 'string') {
    return response.response;
  }
  if (typeof response?.output_text === 'string') {
    return response.output_text;
  }
  return 'Here are some recipes you might enjoy!';
}

export async function transcribeAudio(env: Env, audio: Uint8Array): Promise<string> {
  const response = await env.AI.run(ASR_MODEL, { audio });
  if (typeof response?.text === 'string') {
    return response.text;
  }
  if (Array.isArray(response?.results) && typeof response.results[0]?.text === 'string') {
    return response.results[0].text;
  }
  return '';
}

export async function extractTextFromImage(env: Env, image: Uint8Array): Promise<string> {
  const result = await env.AI.run(OCR_MODEL, {
    messages: [
      {
        role: 'system',
        content: 'You are an OCR assistant. Read the image and provide the visible recipe text.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Please read the text from this recipe photo.',
          },
          {
            type: 'input_image',
            image,
          },
        ],
      },
    ],
  });

  if (typeof result?.text === 'string') {
    return result.text;
  }
  if (Array.isArray(result?.choices) && result.choices[0]?.message?.content) {
    return String(result.choices[0].message.content);
  }
  return '';
}

export async function extractTextFromPdf(env: Env, pdf: Uint8Array): Promise<string> {
  const result = await env.AI.run(OCR_MODEL, {
    messages: [
      {
        role: 'system',
        content: 'You are an OCR assistant. Read the attached PDF manual and return all text in reading order.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Please extract the manual text from this PDF.',
          },
          {
            type: 'input_file',
            data: pdf,
            mime_type: 'application/pdf',
          },
        ],
      },
    ],
  });

  if (typeof result?.text === 'string') {
    return result.text;
  }
  if (Array.isArray(result?.choices) && result.choices[0]?.message?.content) {
    return String(result.choices[0].message.content);
  }
  if (typeof result?.result === 'string') {
    return result.result;
  }
  return '';
}

export async function generatePrepPhases(env: Env, recipe: NormalizedRecipe): Promise<PrepPhase[]> {
  const payload = {
    title: recipe.title,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
  };

  const response = await env.AI.run(CHAT_MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'You are a culinary prep planner. Group recipe ingredients into logical prep phases based on the steps. Respond ONLY with JSON matching [{"phaseTitle":string,"ingredients":[{name,quantity?,notes?}]}].',
      },
      {
        role: 'user',
        content: JSON.stringify(payload),
      },
    ],
  });

  const raw = typeof response?.choices?.[0]?.message?.content === 'string'
    ? response.choices[0].message.content
    : typeof response?.result === 'string'
      ? response.result
      : typeof response?.response === 'string'
        ? response.response
        : typeof response?.output_text === 'string'
          ? response.output_text
          : '[]';

  const sanitized = raw.trim().startsWith('```')
    ? raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
    : raw;

  try {
    const parsed = JSON.parse(sanitized);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item: any): PrepPhase | null => {
        const phaseTitle =
          typeof item?.phaseTitle === 'string'
            ? item.phaseTitle
            : typeof item?.phase_title === 'string'
              ? item.phase_title
              : null;
        if (!phaseTitle) {
          return null;
        }
        const ingredients = Array.isArray(item?.ingredients)
          ? item.ingredients
              .map((ingredient: any): { name: string; quantity?: string; notes?: string } | null => {
                if (!ingredient) return null;
                const name =
                  typeof ingredient.name === 'string'
                    ? ingredient.name
                    : typeof ingredient?.ingredient === 'string'
                      ? ingredient.ingredient
                      : typeof ingredient?.text === 'string'
                        ? ingredient.text
                        : '';
                const trimmed = name.trim();
                if (!trimmed) return null;
                const quantity =
                  typeof ingredient.quantity === 'string'
                    ? ingredient.quantity
                    : typeof ingredient.amount === 'string'
                      ? ingredient.amount
                      : undefined;
                const notes = typeof ingredient.notes === 'string' ? ingredient.notes : undefined;
                return {
                  name: trimmed,
                  quantity: quantity?.trim() || undefined,
                  notes: notes?.trim() || undefined,
                };
              })
              .filter(
                (value: { name: string; quantity?: string; notes?: string } | null): value is {
                  name: string;
                  quantity?: string;
                  notes?: string;
                } => Boolean(value)
              )
          : [];
        return {
          phaseTitle: phaseTitle.trim(),
          ingredients,
        };
      })
      .filter((value): value is PrepPhase => Boolean(value));
  } catch (error) {
    console.warn('Failed to parse prep phases', error);
    return [];
  }
}

export async function generateRecipeFlowchart(
  env: Env,
  input: {
    title: string;
    steps: RecipeStep[];
    prepTimeMinutes?: number | null;
    cookTimeMinutes?: number | null;
    totalTimeMinutes?: number | null;
  }
): Promise<string> {
  const response = await env.AI.run(CHAT_MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'You are a culinary visualization expert. Create Mermaid.js flowcharts that capture cooking workflows, parallel steps, and timing. Respond ONLY with the Mermaid definition.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          title: input.title,
          steps: input.steps,
          timing: {
            prep: input.prepTimeMinutes,
            cook: input.cookTimeMinutes,
            total: input.totalTimeMinutes,
          },
        }),
      },
    ],
  });

  const raw = typeof response?.choices?.[0]?.message?.content === 'string'
    ? response.choices[0].message.content
    : typeof response?.result === 'string'
      ? response.result
      : typeof response?.response === 'string'
        ? response.response
        : typeof response?.output_text === 'string'
          ? response.output_text
          : '';

  const trimmed = raw.trim();
  if (!trimmed) {
    return 'graph TD\n  A[Start] --> B[Cook]';
  }
  return trimmed;
}

export async function tailorRecipeInstructions(
  env: Env,
  input: {
    title: string;
    originalSteps: string[];
    manualText: string;
    appliance: { brand: string; model: string };
    prepPhases?: PrepPhase[];
    manualEmbedding?: number[] | null;
  }
): Promise<string[]> {
  const prepPhaseSection = input.prepPhases && input.prepPhases.length
    ? `Prep Phases: ${JSON.stringify(input.prepPhases)}`
    : '';
  const embeddingSummary = Array.isArray(input.manualEmbedding) && input.manualEmbedding.length
    ? `Embedding vector retrieved (length ${input.manualEmbedding.length}).`
    : 'No stored embedding vector found.';
  const manualText = truncate(input.manualText ?? '', 18000);
  const prompt = `Recipe Title: ${input.title}\nAppliance: ${input.appliance.brand} ${input.appliance.model}\n${embeddingSummary}\n\nOriginal Recipe Steps:\n${input.originalSteps
    .map((step, index) => `${index + 1}. ${step}`)
    .join('\n')}\n\n${prepPhaseSection}\n\nAppliance Manual Text:\n${manualText}\n\nInstruction: Rewrite the following recipe instructions to be optimized for the provided user manual. Pay close attention to the device's specific functions, constraints (like a lack of temperature control), and recommended settings. Maintain the original recipe's intent but adapt the technique. Respond ONLY with JSON array of strings representing the tailored steps.`;

  const response = await env.AI.run(CHAT_MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'You are a culinary assistant that adapts recipes to specific kitchen appliances. Always respond with valid JSON arrays of instructions.',
      },
      { role: 'user', content: prompt },
    ],
  });

  let raw = typeof response?.choices?.[0]?.message?.content === 'string'
    ? response.choices[0].message.content
    : typeof response?.result === 'string'
      ? response.result
      : typeof response?.response === 'string'
        ? response.response
        : typeof response?.output_text === 'string'
          ? response.output_text
          : '[]';

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    raw = fenceMatch[1];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((value) => String(value));
    }
    if (Array.isArray(parsed?.steps)) {
      return parsed.steps.map((value: unknown) => String(value));
    }
  } catch (error) {
    console.warn('Failed to parse tailored steps JSON', error);
  }

  return raw
    .split(/\n+/)
    .map((line: string) => line.trim())
    .filter(Boolean);
}

export async function normalizeRecipeFromText(env: Env, text: string, sourceUrl?: string): Promise<NormalizedRecipe> {
  const response = await env.AI.run(CHAT_MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'You convert unstructured recipe notes into strict JSON. Respond ONLY with JSON that matches the schema {id?, title, description?, cuisine?, tags?, heroImageUrl?, yield?, prepTimeMinutes?, cookTimeMinutes?, totalTimeMinutes?, ingredients:[{name, quantity?, notes?}], steps:[{title?, instruction}], tools?, notes?, sourceUrl?}. Arrays must be present even if empty.',
      },
      {
        role: 'user',
        content: `Source: ${sourceUrl ?? 'unknown'}\n\n${text}`,
      },
    ],
  });

  const raw = typeof response?.choices?.[0]?.message?.content === 'string'
    ? response.choices[0].message.content
    : typeof response?.result === 'string'
      ? response.result
      : typeof response?.response === 'string'
        ? response.response
        : typeof response?.output_text === 'string'
          ? response.output_text
          : '{}';

  try {
    const parsed = JSON.parse(raw);
    const normalized: NormalizedRecipe = {
      id: parsed.id || crypto.randomUUID(),
      title: parsed.title || 'Untitled Recipe',
      description: parsed.description ?? undefined,
      cuisine: parsed.cuisine ?? undefined,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map((t: unknown) => String(t)) : [],
      heroImageUrl: parsed.heroImageUrl ?? undefined,
      yield: parsed.yield ?? undefined,
      prepTimeMinutes: parsed.prepTimeMinutes ?? null,
      cookTimeMinutes: parsed.cookTimeMinutes ?? null,
      totalTimeMinutes: parsed.totalTimeMinutes ?? null,
      ingredients: Array.isArray(parsed.ingredients)
        ? parsed.ingredients.map((item: any) => ({
            name: String(item.name ?? ''),
            quantity: item.quantity ? String(item.quantity) : undefined,
            notes: item.notes ? String(item.notes) : undefined,
          }))
        : [],
      steps: Array.isArray(parsed.steps)
        ? parsed.steps.map((step: any) => ({
            title: step.title ? String(step.title) : undefined,
            instruction: String(step.instruction ?? step.step ?? ''),
          }))
        : [],
      tools: Array.isArray(parsed.tools) ? parsed.tools.map((tool: unknown) => String(tool)) : [],
      notes: parsed.notes ? String(parsed.notes) : undefined,
      sourceUrl: sourceUrl ?? parsed.sourceUrl ?? undefined,
    };

    if (!normalized.ingredients.length) {
      normalized.ingredients = [];
    }
    if (!normalized.steps.length) {
      normalized.steps = [];
    }

    return normalized;
  } catch (error) {
    console.error('Failed to parse normalized recipe', error);
    return {
      id: crypto.randomUUID(),
      title: 'Untitled Recipe',
      ingredients: [],
      steps: [],
      sourceUrl,
    };
  }
}

export interface MenuGenerationCandidate extends RecipeSummary {
  description?: string | null;
}

export interface GeneratedMenuItem {
  day?: string | null;
  meal?: string | null;
  recipeId: string;
}

export interface GeneratedMenuPlan {
  title?: string | null;
  items: GeneratedMenuItem[];
}

export async function generateMenuPlan(
  env: Env,
  options: {
    candidates: MenuGenerationCandidate[];
    theme?: string;
    excludedRecipeIds?: string[];
    weekStart?: string | null;
    preferences?: UserPreferences | null;
  }
): Promise<GeneratedMenuPlan> {
  const candidates = options.candidates;
  if (!candidates.length) {
    return { title: options.theme ?? 'Weekly Menu', items: [] };
  }

  const excluded = new Set(
    (options.excludedRecipeIds ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean)
  );

  const preferenceContext: string[] = [];
  const prefs = options.preferences;
  if (prefs) {
    if (prefs.dietaryRestrictions?.length) {
      preferenceContext.push(`Dietary restrictions: ${prefs.dietaryRestrictions.join(', ')}`);
    }
    if (prefs.allergies?.length) {
      preferenceContext.push(`Allergies: ${prefs.allergies.join(', ')}`);
    }
    if (prefs.dislikedIngredients.length) {
      preferenceContext.push(`Avoid ingredients: ${prefs.dislikedIngredients.join(', ')}`);
    }
    if (prefs.cuisines.length) {
      preferenceContext.push(`Favorite cuisines: ${prefs.cuisines.join(', ')}`);
    }
  }

  const candidateLines = candidates.map((candidate, index) => {
    const tags = candidate.tags.length ? candidate.tags.join(', ') : 'no tags';
    const cuisine = candidate.cuisine ? candidate.cuisine : 'unknown cuisine';
    return `${index + 1}. ${candidate.id} :: ${candidate.title} (cuisine: ${cuisine}; tags: ${tags})`;
  });

  const systemPrompt =
    'You are MenuForge, an expert culinary planner. Respond ONLY with JSON that matches {"title": string, "items": [{"day": string, "meal": string, "recipe_id": string}]}. Use each recipe at most once.';

  const lines: string[] = [
    'Plan a 7-day dinner menu for this user.',
    options.weekStart ? `Week starts on ${options.weekStart}.` : 'Week start date not specified.',
    options.theme
      ? `Theme to emphasize: "${options.theme}". Favor recipes that align with this theme.`
      : 'No specific theme provided; aim for variety.',
    excluded.size ? `Do NOT use any recipes with these IDs: ${Array.from(excluded).join(', ')}` : 'No recipe IDs are explicitly banned.',
  ];

  if (preferenceContext.length) {
    lines.push(...preferenceContext);
  }

  lines.push('Candidate recipes (use only these IDs):');
  lines.push(...candidateLines);
  lines.push(
    'Return JSON with exactly seven items, one per day. Use real recipe_id values from the list above. Choose a meal label (breakfast, lunch, or dinner).'
  );

  const response = await env.AI.run(CHAT_MODEL, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: lines.join('\n') },
    ],
  });

  const raw = extractContentFromResponse(response);

  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('Failed to parse menu generation response; falling back', error);
  }

  const rawItems = Array.isArray(parsed?.items)
    ? parsed.items
    : Array.isArray(parsed?.menu?.items)
      ? parsed.menu.items
      : [];

  const normalized: GeneratedMenuItem[] = [];
  const used = new Set<string>();

  for (const item of rawItems) {
    if (!item) continue;
    const recipeId = String(item.recipeId ?? item.recipe_id ?? '').trim();
    if (!recipeId) continue;
    const key = recipeId.toLowerCase();
    if (excluded.has(key) || used.has(key)) {
      continue;
    }
    used.add(key);
    normalized.push({
      recipeId,
      day: typeof item.day === 'string' ? item.day : typeof item.day_of_week === 'string' ? item.day_of_week : null,
      meal: typeof item.meal === 'string' ? item.meal : typeof item.meal_type === 'string' ? item.meal_type : 'dinner',
    });
  }

  const targetCount = Math.min(7, candidates.length - excluded.size);
  const fallbackIds = candidates
    .map((candidate) => candidate.id)
    .filter((id) => {
      const key = id.toLowerCase();
      return !excluded.has(key) && !used.has(key);
    });

  for (const id of fallbackIds) {
    if (normalized.length >= targetCount) break;
    normalized.push({ recipeId: id, day: null, meal: 'dinner' });
    used.add(id.toLowerCase());
  }

  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  normalized.forEach((item, index) => {
    if (!item.day || !item.day.trim()) {
      item.day = dayNames[index % dayNames.length];
    }
    if (!item.meal || !item.meal.trim()) {
      item.meal = 'dinner';
    }
  });

  return {
    title: parsed?.title ?? parsed?.menu?.title ?? (options.theme ? `${options.theme} Menu` : 'Weekly Menu'),
    items: normalized.slice(0, targetCount > 0 ? targetCount : normalized.length),
  };
}

export interface ShoppingListCategorizedItem {
  name: string;
  quantity?: string | null;
}

export interface ShoppingListCategory {
  category: string;
  items: ShoppingListCategorizedItem[];
}

export async function categorizeShoppingList(
  env: Env,
  items: ShoppingListCategorizedItem[]
): Promise<ShoppingListCategory[]> {
  if (!items.length) {
    return [];
  }

  const systemPrompt =
    'You categorize grocery list items. Respond ONLY with JSON like {"shoppingList":[{"category":"Produce","items":[{"name":"Tomatoes","quantity":"2"}]}]}.';
  const response = await env.AI.run(CHAT_MODEL, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Categorize these grocery items: ${JSON.stringify(items)}` },
    ],
  });

  const raw = extractContentFromResponse(response);

  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.shoppingList) ? parsed.shoppingList : Array.isArray(parsed) ? parsed : [];
    const categories: ShoppingListCategory[] = [];

    for (const category of list) {
      if (!category) continue;
      const name = typeof category.category === 'string' ? category.category : typeof category.name === 'string' ? category.name : 'Other';
      const rawItems = Array.isArray(category.items) ? category.items : [];
      const categoryItems: ShoppingListCategorizedItem[] = [];
      for (const item of rawItems) {
        if (!item) continue;
        const itemName = typeof item.name === 'string' ? item.name : typeof item.item === 'string' ? item.item : '';
        if (!itemName.trim()) continue;
        const quantity = typeof item.quantity === 'string' ? item.quantity : typeof item.amount === 'string' ? item.amount : null;
        categoryItems.push({ name: itemName, quantity });
      }
      if (categoryItems.length) {
        categories.push({ category: name, items: categoryItems });
      }
    }

    if (categories.length) {
      return categories;
    }
  } catch (error) {
    console.warn('Failed to parse categorized shopping list; falling back', error);
  }

  return [
    {
      category: 'Groceries',
      items,
    },
  ];
}

function extractContentFromResponse(response: any): string {
  const choiceContent = response?.choices?.[0]?.message?.content;
  if (typeof choiceContent === 'string') {
    return choiceContent;
  }
  if (typeof response?.result === 'string') {
    return response.result;
  }
  if (typeof response?.response === 'string') {
    return response.response;
  }
  if (typeof response?.output_text === 'string') {
    return response.output_text;
  }
  return '{}';
}
