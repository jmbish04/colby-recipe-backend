import { Env } from './env';
import { NormalizedRecipe } from './types';

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
