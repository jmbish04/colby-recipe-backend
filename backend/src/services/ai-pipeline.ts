/**
 * Deep Thought AI Pipeline
 *
 * A two-phase AI processing pipeline:
 * Phase 1: Deep reasoning with @cf/openai/gpt-oss-120b
 * Phase 2: JSON extraction with @cf/meta/llama-3.1-70b-instruct
 */

import { z } from 'zod';
import type { Env, AiTextGenerationResult } from '../types';

// AI Model identifiers
const REASONING_MODEL = '@cf/openai/gpt-oss-120b';
const STRUCTURING_MODEL = '@cf/meta/llama-3.1-70b-instruct';
const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const WHISPER_MODEL = '@cf/openai/whisper';

export interface ProcessIdeallyOptions {
  /** Context for the reasoning phase */
  context?: string;
  /** Maximum tokens for reasoning phase */
  maxReasoningTokens?: number;
  /** Maximum tokens for structuring phase */
  maxStructuringTokens?: number;
  /** Temperature for reasoning (default: 0.7) */
  reasoningTemperature?: number;
  /** Temperature for structuring (default: 0.1) */
  structuringTemperature?: number;
}

export interface ProcessIdeallyResult<T> {
  /** The raw reasoning output from Phase 1 */
  reasoning: string;
  /** The structured JSON output from Phase 2 */
  structured: T;
  /** Total latency in milliseconds */
  latencyMs: number;
  /** Phase 1 latency */
  reasoningLatencyMs: number;
  /** Phase 2 latency */
  structuringLatencyMs: number;
}

/**
 * The main "Deep Thought" AI Pipeline
 *
 * @param env - Worker environment with AI binding
 * @param input - The input text to process
 * @param schema - Zod schema for output validation
 * @param options - Processing options
 * @returns Structured and validated output
 *
 * @example
 * ```ts
 * const result = await processIdeally(
 *   env,
 *   "Here's a recipe I found: Banana Bread...",
 *   RecipeSchema,
 *   { context: "Extract recipe information" }
 * );
 * ```
 */
export async function processIdeally<T>(
  env: Env,
  input: string,
  schema: z.ZodType<T>,
  options: ProcessIdeallyOptions = {}
): Promise<ProcessIdeallyResult<T>> {
  const startTime = Date.now();
  const {
    context = 'Analyze the following input carefully',
    maxReasoningTokens = 2048,
    maxStructuringTokens = 4096,
    reasoningTemperature = 0.7,
    structuringTemperature = 0.1,
  } = options;

  // =========================================================================
  // Phase 1: Deep Reasoning
  // =========================================================================
  const reasoningPrompt = `${context}

Think step-by-step about the following input. Consider:
1. What is the main purpose or content of this input?
2. What are the key pieces of information that should be extracted?
3. Are there any ambiguities that need to be resolved?
4. What assumptions might need to be made?

Input:
${input}

Provide a thorough analysis:`;

  const phase1Start = Date.now();
  const reasoningResponse = await env.AI.run(REASONING_MODEL, {
    prompt: reasoningPrompt,
    max_tokens: maxReasoningTokens,
    temperature: reasoningTemperature,
  }) as AiTextGenerationResult;

  const reasoning = reasoningResponse.response || reasoningResponse.text || '';
  const reasoningLatencyMs = Date.now() - phase1Start;

  // =========================================================================
  // Phase 2: JSON Structuring
  // =========================================================================
  const schemaDescription = getSchemaDescription(schema);

  const structuringPrompt = `You are a precise JSON extraction assistant. Your task is to extract structured data from the analysis below.

ANALYSIS:
${reasoning}

ORIGINAL INPUT:
${input}

REQUIRED JSON SCHEMA:
${schemaDescription}

INSTRUCTIONS:
1. Extract all relevant information that matches the schema
2. Use null for optional fields that cannot be determined
3. Ensure all required fields are populated
4. Output ONLY valid JSON, no explanations or markdown

JSON OUTPUT:`;

  const phase2Start = Date.now();
  const structuringResponse = await env.AI.run(STRUCTURING_MODEL, {
    prompt: structuringPrompt,
    max_tokens: maxStructuringTokens,
    temperature: structuringTemperature,
  }) as AiTextGenerationResult;

  const structuredText = structuringResponse.response || structuringResponse.text || '';
  const structuringLatencyMs = Date.now() - phase2Start;

  // Parse and validate JSON
  const structured = parseAndValidate(structuredText, schema);

  return {
    reasoning,
    structured,
    latencyMs: Date.now() - startTime,
    reasoningLatencyMs,
    structuringLatencyMs,
  };
}

/**
 * Generate text embeddings for vector search
 */
export async function generateEmbedding(
  env: Env,
  text: string
): Promise<number[]> {
  const response = await env.AI.run(EMBEDDING_MODEL, {
    text: [text],
  });

  const result = response as { data?: Array<{ values?: number[] }> };

  if (result.data?.[0]?.values) {
    return result.data[0].values;
  }

  // Fallback for different response format
  if (Array.isArray(response) && response[0]) {
    return response[0] as number[];
  }

  throw new Error('Failed to generate embedding: unexpected response format');
}

/**
 * Extract text from an image using vision model
 */
export async function extractTextFromImage(
  env: Env,
  imageBytes: Uint8Array,
  prompt: string = 'Extract all text visible in this image. Include any recipe ingredients, instructions, or other relevant information.'
): Promise<string> {
  const base64Image = btoa(String.fromCharCode(...imageBytes));

  const response = await env.AI.run(VISION_MODEL, {
    image: base64Image,
    prompt,
    max_tokens: 2048,
  }) as AiTextGenerationResult;

  return response.response || response.text || '';
}

/**
 * Transcribe audio to text using Whisper
 */
export async function transcribeAudio(
  env: Env,
  audioBytes: Uint8Array
): Promise<string> {
  const response = await env.AI.run(WHISPER_MODEL, {
    audio: Array.from(audioBytes),
  }) as { text?: string };

  return response.text || '';
}

/**
 * Simple text generation without the full pipeline
 */
export async function generateText(
  env: Env,
  prompt: string,
  options: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
  } = {}
): Promise<string> {
  const {
    model = STRUCTURING_MODEL,
    maxTokens = 1024,
    temperature = 0.7,
  } = options;

  const response = await env.AI.run(model, {
    prompt,
    max_tokens: maxTokens,
    temperature,
  }) as AiTextGenerationResult;

  return response.response || response.text || '';
}

/**
 * Chat completion with message history
 */
export async function chatCompletion(
  env: Env,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
  } = {}
): Promise<string> {
  const {
    model = STRUCTURING_MODEL,
    maxTokens = 1024,
    temperature = 0.7,
  } = options;

  const response = await env.AI.run(model, {
    messages,
    max_tokens: maxTokens,
    temperature,
  }) as AiTextGenerationResult;

  return response.response || response.text || '';
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a human-readable schema description from a Zod schema
 */
function getSchemaDescription(schema: z.ZodType<unknown>): string {
  try {
    // Use Zod's internal description if available
    if (schema.description) {
      return schema.description;
    }

    // Generate description from schema shape
    if (schema instanceof z.ZodObject) {
      const shape = schema.shape;
      const fields = Object.entries(shape).map(([key, value]) => {
        const zodValue = value as z.ZodType<unknown>;
        const isOptional = zodValue.isOptional?.() || false;
        const typeName = getZodTypeName(zodValue);
        return `  "${key}": ${typeName}${isOptional ? ' (optional)' : ''}`;
      });
      return `{\n${fields.join(',\n')}\n}`;
    }

    if (schema instanceof z.ZodArray) {
      return `Array of ${getZodTypeName(schema.element)}`;
    }

    return 'JSON object';
  } catch {
    return 'JSON object matching the expected structure';
  }
}

/**
 * Get the type name from a Zod schema
 */
function getZodTypeName(schema: z.ZodType<unknown>): string {
  if (schema instanceof z.ZodString) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  if (schema instanceof z.ZodArray) return `array`;
  if (schema instanceof z.ZodObject) return 'object';
  if (schema instanceof z.ZodOptional) return getZodTypeName(schema.unwrap());
  if (schema instanceof z.ZodNullable) return `${getZodTypeName(schema.unwrap())} | null`;
  return 'unknown';
}

/**
 * Parse JSON from AI output and validate against schema
 */
function parseAndValidate<T>(text: string, schema: z.ZodType<T>): T {
  // Try to extract JSON from the response
  const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('No JSON found in AI response');
  }

  const jsonStr = jsonMatch[0];

  try {
    const parsed = JSON.parse(jsonStr);
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Schema validation failed: ${error.errors.map(e => e.message).join(', ')}`);
    }
    throw new Error(`JSON parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// ============================================================================
// Specialized Extraction Functions
// ============================================================================

/**
 * Extract a normalized recipe from raw text (HTML, OCR, etc.)
 */
export async function extractRecipe(
  env: Env,
  rawText: string,
  sourceUrl?: string
): Promise<z.infer<typeof RecipeExtractionSchema>> {
  const result = await processIdeally(
    env,
    rawText,
    RecipeExtractionSchema,
    {
      context: `Extract recipe information from the following content.${sourceUrl ? ` Source: ${sourceUrl}` : ''}

Look for:
- Recipe title
- Ingredients list with quantities
- Cooking instructions/steps
- Preparation and cooking times
- Serving size/yield
- Equipment needed
- Any tags or categories`,
    }
  );

  return result.structured;
}

/**
 * Extract appliance specifications from manual text
 */
export async function extractApplianceSpecs(
  env: Env,
  manualText: string
): Promise<z.infer<typeof ApplianceSpecsSchema>> {
  const result = await processIdeally(
    env,
    manualText.slice(0, 10000), // Limit input size
    ApplianceSpecsSchema,
    {
      context: `Extract appliance specifications from this manual.

Look for:
- Brand and model name
- Appliance type
- Key features
- Capacity/dimensions
- Power/wattage
- Available programs/modes
- Temperature range`,
    }
  );

  return result.structured;
}

// Schemas for specialized extractions
const RecipeExtractionSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  authorName: z.string().optional(),
  cuisine: z.string().optional(),
  tags: z.array(z.string()).optional(),
  heroImageUrl: z.string().optional(),
  yield: z.string().optional(),
  prepTimeMinutes: z.number().optional(),
  cookTimeMinutes: z.number().optional(),
  totalTimeMinutes: z.number().optional(),
  ingredients: z.array(z.object({
    name: z.string(),
    quantity: z.string().optional(),
    unit: z.string().optional(),
    notes: z.string().optional(),
  })),
  steps: z.array(z.object({
    instruction: z.string(),
    title: z.string().optional(),
    duration: z.number().optional(),
  })),
  equipment: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

const ApplianceSpecsSchema = z.object({
  brand: z.string().optional(),
  model: z.string().optional(),
  type: z.string().optional(),
  features: z.array(z.string()).optional(),
  capacity: z.string().optional(),
  wattage: z.number().optional(),
  programs: z.array(z.string()).optional(),
  temperatureRange: z.object({
    min: z.number(),
    max: z.number(),
  }).optional(),
});
