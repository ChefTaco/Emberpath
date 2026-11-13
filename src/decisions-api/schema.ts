// Request validation and metadata summaries for the public OpenAI-compatible
// Decisions API (`POST /v1/decisions`). This is unrelated to the internal
// shadow decision model in src/routing/decisioning.ts, which classifies other
// requests for routing observations.
import { z } from 'zod';

export const DECISIONS_MAX_QUESTIONS = 400;

const instructionsSchema = z.union([z.string(), z.array(z.record(z.string(), z.unknown())).min(1)]);
const choiceSchema = z.object({
  value: z.union([z.string(), z.boolean()]),
  description: z.string().nullable().optional(),
}).loose();
const levelSchema = z.object({
  label: z.string(),
  description: z.string().nullable().optional(),
}).loose();

export const decisionsQuestionSchema = z.object({
  type: z.enum(['predicate', 'choice', 'score']),
  name: z.string().nullable().optional(),
  instructions: instructionsSchema,
  choices: z.array(choiceSchema).min(2).max(255).optional(),
  levels: z.array(levelSchema).min(2).max(10).optional(),
}).loose().superRefine((question, context) => {
  if (question.type === 'choice' && !question.choices) context.addIssue({ code: 'custom', path: ['choices'], message: 'choice questions require 2-255 choices' });
  if (question.type === 'score' && !question.levels) context.addIssue({ code: 'custom', path: ['levels'], message: 'score questions require 2-10 levels' });
  if (question.type !== 'choice' && question.choices) context.addIssue({ code: 'custom', path: ['choices'], message: 'choices are only valid on choice questions' });
  if (question.type !== 'score' && question.levels) context.addIssue({ code: 'custom', path: ['levels'], message: 'levels are only valid on score questions' });
});

/**
 * Structural validation only. Unknown fields are kept so the OpenAI backend
 * receives the body unchanged and stays the authority on its own schema.
 */
export const decisionsRequestSchema = z.object({
  model: z.string().min(1),
  questions: z.array(decisionsQuestionSchema).min(1).max(DECISIONS_MAX_QUESTIONS),
  input: z.union([z.string(), z.array(z.record(z.string(), z.unknown())).max(131_072)]),
  prompt_cache_key: z.string().max(64).nullable().optional(),
  prompt_cache_options: z.record(z.string(), z.unknown()).nullable().optional(),
  safety_identifier: z.string().max(128).nullable().optional(),
  stream: z.unknown().optional(),
}).loose().superRefine((body, context) => {
  if (body.stream !== undefined && body.stream !== false && body.stream !== null) {
    context.addIssue({ code: 'custom', path: ['stream'], message: 'The Decisions API does not stream' });
  }
});

export type DecisionsRequest = z.infer<typeof decisionsRequestSchema>;
export type DecisionsQuestion = z.infer<typeof decisionsQuestionSchema>;

export interface DecisionsRequestSummary {
  questionCount: number;
  questionTypes: Record<'predicate' | 'choice' | 'score', number>;
  input: { kind: 'string' } | { kind: 'items'; items: number; itemTypes: Record<string, number> };
  promptCache: boolean;
  safetyIdentifier: boolean;
}

const KNOWN_ITEM_TYPES = new Set(['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output']);

/** Trace metadata: counts and types only, never question or input text. */
export function summarizeDecisionsRequest(body: DecisionsRequest): DecisionsRequestSummary {
  const questionTypes = { predicate: 0, choice: 0, score: 0 };
  for (const question of body.questions) questionTypes[question.type] += 1;
  let input: DecisionsRequestSummary['input'] = { kind: 'string' };
  if (Array.isArray(body.input)) {
    const itemTypes: Record<string, number> = {};
    for (const item of body.input) {
      const label = typeof item.type === 'string' && KNOWN_ITEM_TYPES.has(item.type) ? item.type : typeof item.role === 'string' ? 'message' : 'other';
      itemTypes[label] = (itemTypes[label] ?? 0) + 1;
    }
    input = { kind: 'items', items: body.input.length, itemTypes };
  }
  return {
    questionCount: body.questions.length,
    questionTypes,
    input,
    promptCache: body.prompt_cache_key != null || body.prompt_cache_options != null,
    safetyIdentifier: body.safety_identifier != null,
  };
}

export interface DecisionsErrorBody {
  error: { message: string; type: string; code: string; param?: string | null; details?: unknown };
}

export function decisionsError(message: string, type: string, code: string, details?: unknown, param?: string): DecisionsErrorBody {
  return { error: { message, type, code, ...(param ? { param } : {}), ...(details === undefined ? {} : { details }) } };
}
