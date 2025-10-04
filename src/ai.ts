import { Env } from './env';
import {
  ApplianceSpecs,
  NormalizedRecipe,
  PrepPhase,
  RecipeSummary,
  RecipeStep,
  UserPreferences,
} from './types';
import { truncate } from './utils';

const CHAT_MODEL = '@cf/meta/llama-3.1-70b-instruct';
const EMBEDDING_MODEL = '@cf/google/embeddinggemma-300m';
const ASR_MODEL = '@cf/openai/whisper';
const OCR_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

async function tryExtractWithPdfJs(pdf: Uint8Array): Promise<string | null> {
  try {
    // Add polyfills for missing DOM APIs in Cloudflare Workers
    if (typeof (globalThis as any).DOMMatrix === 'undefined') {
      (globalThis as any).DOMMatrix = class DOMMatrix {
        constructor(_init?: string | number[]) {
          // Simple polyfill - PDF.js might not use this extensively
        }
        static fromMatrix() {
          return new DOMMatrix();
        }
        toString() {
          return 'matrix(1, 0, 0, 1, 0, 0)';
        }
      };
    }
    
    if (typeof (globalThis as any).DOMPoint === 'undefined') {
      (globalThis as any).DOMPoint = class DOMPoint {
        constructor(x = 0, y = 0, z = 0, w = 1) {
          this.x = x;
          this.y = y;
          this.z = z;
          this.w = w;
        }
        x: number;
        y: number;
        z: number;
        w: number;
      };
    }

    // Add more polyfills that PDF.js might need
    if (typeof (globalThis as any).DOMRect === 'undefined') {
      (globalThis as any).DOMRect = class DOMRect {
        constructor(x = 0, y = 0, width = 0, height = 0) {
          this.x = x;
          this.y = y;
          this.width = width;
          this.height = height;
        }
        x: number;
        y: number;
        width: number;
        height: number;
        get top() { return this.y; }
        get right() { return this.x + this.width; }
        get bottom() { return this.y + this.height; }
        get left() { return this.x; }
      };
    }

    // Add URL polyfill if needed
    if (typeof (globalThis as any).URL === 'undefined') {
      (globalThis as any).URL = class URL {
        constructor(_url: string, _base?: string) {
          // Simple polyfill
        }
        toString() {
          return '';
        }
      };
    }

    // Add polyfill for String.prototype.includes if missing
    if (typeof String.prototype.includes === 'undefined') {
      String.prototype.includes = function(search: string, start?: number): boolean {
        if (typeof start !== 'number') {
          start = 0;
        }
        if (start + search.length > this.length) {
          return false;
        } else {
          return this.indexOf(search, start) !== -1;
        }
      };
    }

    let pdfjs: PdfJsModule;
    try {
      pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    } catch (importError) {
      console.warn('Failed to import PDF.js:', importError);
      return null;
    }
    if (!pdfjs.getDocument) {
      return null;
    }
    const source =
      pdf.byteOffset === 0 && pdf.byteLength === pdf.buffer.byteLength
        ? pdf.buffer
        : pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength);
    const loadingTask = pdfjs.getDocument({ data: source });
    const doc = await loadingTask.promise;
    const pageTexts: string[] = [];
    const clean = (value: unknown): string => {
      if (typeof value === 'string') {
        return value.replace(/\s+/g, ' ').trim();
      }
      return '';
    };
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const items = Array.isArray(textContent.items) ? textContent.items : [];
      const text = items
        .map((item: { str?: string; text?: string }) => clean(item?.str ?? item?.text))
        .filter(Boolean)
        .join(' ')
        .trim();
      if (text) {
        pageTexts.push(text);
      }
    }
    const joined = pageTexts.join('\n\n').trim();
    return joined.length ? joined : null;
  } catch (error) {
    console.warn('PDF.js extraction failed', error);
    return null;
  }
}

async function extractTextFromPdfViaAi(env: Env, pdf: Uint8Array): Promise<string> {
  // Convert PDF to base64 for vision model using a more efficient method
  let binary = '';
  const chunkSize = 8192; // Process in chunks to avoid call stack overflow
  for (let i = 0; i < pdf.length; i += chunkSize) {
    const chunk = pdf.slice(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  const base64 = btoa(binary);
  const dataUrl = `data:application/pdf;base64,${base64}`;
  
  const result = await env.AI.run(OCR_MODEL, {
    messages: [
      {
        role: 'system',
        content: 'You are an OCR assistant. Read the attached PDF manual and return all text in reading order.',
      },
      {
        role: 'user',
        content: 'Please extract the manual text from this PDF.',
      },
    ],
    image: dataUrl,
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
  if (typeof result?.response === 'string') {
    return result.response;
  }
  if (typeof result?.output_text === 'string') {
    return result.output_text;
  }
  return '';
}

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
  const localText = await tryExtractWithPdfJs(pdf);
  if (localText && localText.length > 200) {
    return localText;
  }

  const aiText = await extractTextFromPdfViaAi(env, pdf);
  if (aiText && aiText.length > 0) {
    if (localText && aiText.length < localText.length / 4) {
      return localText;
    }
    return aiText;
  }

  return localText ?? '';
}

export async function extractApplianceSpecs(env: Env, text: string): Promise<ApplianceSpecs | null> {
  if (!text.trim()) {
    return null;
  }

  const prompt =
    "Analyze the following user manual text and return a JSON object with the keys: 'brand', 'model', 'capacity', 'wattage', and a list of 'key_features'.";

  const response = await env.AI.run(CHAT_MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'You are a structured data extraction assistant. Always respond with valid JSON and avoid extra commentary.',
      },
      { role: 'user', content: `${prompt}\n\nManual Text:\n${truncate(text, 12000)}` },
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

  const jsonString = raw.trim().startsWith('```')
    ? raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
    : raw;

  try {
    const parsed = JSON.parse(jsonString) as Record<string, unknown>;
    const keyFeatures = Array.isArray(parsed.key_features)
      ? parsed.key_features.map((value) => String(value))
      : Array.isArray(parsed.keyFeatures)
        ? parsed.keyFeatures.map((value) => String(value))
        : [];
    const specs: ApplianceSpecs = {
      brand: typeof parsed.brand === 'string' ? parsed.brand : null,
      model: typeof parsed.model === 'string' ? parsed.model : null,
      capacity: typeof parsed.capacity === 'string' ? parsed.capacity : null,
      wattage: typeof parsed.wattage === 'string' ? parsed.wattage : null,
      keyFeatures,
    };
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in specs)) {
        (specs as Record<string, unknown>)[key] = value;
      }
    }
    return specs;
  } catch (error) {
    console.warn('Failed to parse appliance specs JSON', error);
  }
  return null;
}

export async function generateApplianceInstructions(
  env: Env,
  input: {
    specs: ApplianceSpecs | null;
    preferences: UserPreferences | null;
    nickname?: string | null;
    brand?: string | null;
    model?: string | null;
  }
): Promise<string> {
  const preferenceSummary = input.preferences
    ? {
        cuisines: input.preferences.cuisines,
        allergies: input.preferences.allergies,
        dislikedIngredients: input.preferences.dislikedIngredients,
        favoredTools: input.preferences.favoredTools,
        skillLevel: input.preferences.skillLevel,
      }
    : null;

  const specSummary = input.specs
    ? {
        ...input.specs,
        keyFeatures: input.specs.keyFeatures ?? [],
      }
    : null;

  const response = await env.AI.run(CHAT_MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'You are MenuForge, a culinary agent designer. Produce concise, helpful guidance (2-3 sentences) for another agent that will cook with this appliance.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          appliance: {
            nickname: input.nickname ?? null,
            brand: input.brand ?? input.specs?.brand ?? null,
            model: input.model ?? input.specs?.model ?? null,
            specs: specSummary,
          },
          userPreferences: preferenceSummary,
          instruction:
            'Based on this appliance\'s features and the user\'s cooking preferences, write a short, helpful instruction for a cooking agent on how to best utilize this device for this user.',
        }),
      },
    ],
  });

  const message = typeof response?.choices?.[0]?.message?.content === 'string'
    ? response.choices[0].message.content
    : typeof response?.result === 'string'
      ? response.result
      : typeof response?.response === 'string'
        ? response.response
        : typeof response?.output_text === 'string'
          ? response.output_text
          : '';

  return message.trim();
}

export async function summarizeCookingActions(env: Env, steps: string[]): Promise<string[]> {
  if (!steps.length) {
    return [];
  }

  const response = await env.AI.run(CHAT_MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'You are an expert recipe analyst. Identify the core cooking actions, temperatures, and time cues in a recipe. Return them as a JSON array of short bullet strings.',
      },
      {
        role: 'user',
        content: JSON.stringify({ steps }),
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

  const text = raw.trim().startsWith('```')
    ? raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
    : raw;

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((value) => String(value));
    }
  } catch (error) {
    console.warn('Failed to parse cooking actions JSON', error);
  }
  return steps.slice(0, 5).map((step, index) => `${index + 1}. ${step}`);
}

export async function generateApplianceAdaptation(
  env: Env,
  input: {
    agentInstructions: string | null;
    manualExcerpts: string[];
    recipeTitle: string;
    recipeSteps: string[];
  }
): Promise<{ tailoredSteps: string[]; summaryOfChanges: string }> {
  const response = await env.AI.run(CHAT_MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'You are an expert culinary assistant adapting recipes to specific appliances. Always return valid JSON with keys "tailored_steps" and "summary_of_changes".',
      },
      {
        role: 'user',
        content: `You are adapting the recipe "${input.recipeTitle}" for a user's appliance.\n\n**User's Appliance Instructions:**\n${input.agentInstructions ?? 'No additional instructions provided.'}\n\n**Relevant Excerpts from the Appliance Manual:**\n${input.manualExcerpts.map((excerpt, index) => `${index + 1}. ${excerpt}`).join('\n')}\n\n**Original Recipe Instructions:**\n${input.recipeSteps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\nRewrite the recipe instructions to be executed using the user's appliance. Refer to the manual excerpts to use correct modes, temperatures, and timings. If the original recipe calls for a feature the appliance lacks, provide the closest alternative based on the manual. Finally, provide a brief summary of the changes you made. Respond with JSON {"tailored_steps": string[], "summary_of_changes": string}.`,
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

  const json = raw.trim().startsWith('```')
    ? raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
    : raw;

  try {
    const parsed = JSON.parse(json);
    const tailoredSteps = Array.isArray(parsed?.tailored_steps)
      ? parsed.tailored_steps.map((value: unknown) => String(value))
      : Array.isArray(parsed?.tailoredSteps)
        ? parsed.tailoredSteps.map((value: unknown) => String(value))
        : [];
    const summary = typeof parsed?.summary_of_changes === 'string'
      ? parsed.summary_of_changes
      : typeof parsed?.summaryOfChanges === 'string'
        ? parsed.summaryOfChanges
        : '';
    return {
      tailoredSteps,
      summaryOfChanges: summary,
    };
  } catch (error) {
    console.warn('Failed to parse appliance adaptation JSON', error);
  }

  return {
    tailoredSteps: input.recipeSteps,
    summaryOfChanges: 'Unable to adapt recipe with the provided manual excerpts.',
  };
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

// Receipt processing functions
export async function extractTextFromReceipt(env: Env, imageBytes: Uint8Array): Promise<string> {
  // Convert image to base64 for vision model
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < imageBytes.length; i += chunkSize) {
    const chunk = imageBytes.slice(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  const base64 = btoa(binary);
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  try {
    const result = await env.AI.run(VISION_MODEL, {
      messages: [
        {
          role: 'system',
          content: 'You are an OCR assistant specialized in reading receipts. Extract all text from the receipt image in reading order, preserving the structure and layout.',
        },
        {
          role: 'user',
          content: 'Please extract all text from this receipt image.',
        },
      ],
      image: dataUrl,
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
    if (typeof result?.response === 'string') {
      return result.response;
    }
    if (typeof result?.output_text === 'string') {
      return result.output_text;
    }
    return '';
  } catch (error) {
    console.error('Receipt OCR failed:', error);
    return '';
  }
}

export async function parseReceiptItems(env: Env, receiptText: string): Promise<Array<{ name: string; quantity?: string; unit?: string }>> {
  const prompt = `Parse this receipt text and extract grocery items. For each item, identify:
1. The item name (normalize to common ingredient names)
2. Quantity (if mentioned)
3. Unit (if mentioned)

Return the result as a JSON array of objects with "name", "quantity", and "unit" fields.

Receipt text:
${receiptText}

Example format:
[
  {"name": "organic tomatoes", "quantity": "2", "unit": "lbs"},
  {"name": "milk", "quantity": "1", "unit": "gallon"},
  {"name": "bread", "quantity": "1", "unit": "loaf"}
]`;

  try {
    const result = await env.AI.run(CHAT_MODEL, {
      messages: [
        {
          role: 'system',
          content: 'You are a receipt parsing assistant. Extract grocery items from receipt text and return them as a JSON array.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    let responseText = '';
    if (typeof result?.text === 'string') {
      responseText = result.text;
    } else if (Array.isArray(result?.choices) && result.choices[0]?.message?.content) {
      responseText = String(result.choices[0].message.content);
    } else if (typeof result?.result === 'string') {
      responseText = result.result;
    } else if (typeof result?.response === 'string') {
      responseText = result.response;
    } else if (typeof result?.output_text === 'string') {
      responseText = result.output_text;
    }

    // Extract JSON from response
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const items = JSON.parse(jsonMatch[0]);
      return Array.isArray(items) ? items : [];
    }
    return [];
  } catch (error) {
    console.error('Receipt parsing failed:', error);
    return [];
  }
}

// Voice transcription functions
export async function transcribeAudioForPantry(env: Env, audioBytes: Uint8Array): Promise<string> {
  try {
    const result = await env.AI.run(ASR_MODEL, {
      audio: [...audioBytes],
    });

    if (typeof result?.text === 'string') {
      return result.text;
    }
    if (typeof result?.transcription === 'string') {
      return result.transcription;
    }
    if (typeof result?.result === 'string') {
      return result.result;
    }
    if (typeof result?.response === 'string') {
      return result.response;
    }
    if (typeof result?.output_text === 'string') {
      return result.output_text;
    }
    return '';
  } catch (error) {
    console.error('Audio transcription failed:', error);
    return '';
  }
}

export async function parsePantryFromTranscription(env: Env, transcription: string): Promise<Array<{ name: string; quantity?: string; unit?: string }>> {
  const prompt = `Parse this voice transcription about pantry items and extract ingredient information. For each item mentioned, identify:
1. The ingredient name (normalize to common names)
2. Quantity (if mentioned)
3. Unit (if mentioned)

Return the result as a JSON array of objects with "name", "quantity", and "unit" fields.

Transcription:
${transcription}

Example format:
[
  {"name": "tomatoes", "quantity": "3", "unit": "pieces"},
  {"name": "milk", "quantity": "1", "unit": "gallon"},
  {"name": "eggs", "quantity": "12", "unit": "pieces"}
]`;

  try {
    const result = await env.AI.run(CHAT_MODEL, {
      messages: [
        {
          role: 'system',
          content: 'You are a pantry assistant. Extract ingredient information from voice transcriptions and return them as a JSON array.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    let responseText = '';
    if (typeof result?.text === 'string') {
      responseText = result.text;
    } else if (Array.isArray(result?.choices) && result.choices[0]?.message?.content) {
      responseText = String(result.choices[0].message.content);
    } else if (typeof result?.result === 'string') {
      responseText = result.result;
    } else if (typeof result?.response === 'string') {
      responseText = result.response;
    } else if (typeof result?.output_text === 'string') {
      responseText = result.output_text;
    }

    // Extract JSON from response
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const items = JSON.parse(jsonMatch[0]);
      return Array.isArray(items) ? items : [];
    }
    return [];
  } catch (error) {
    console.error('Pantry parsing from transcription failed:', error);
    return [];
  }
}
