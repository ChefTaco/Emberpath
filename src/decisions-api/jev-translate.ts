// Translation between the OpenAI Decisions wire format and the Jev decision
// format (TypeSafe `systemone` and the OpenRouter decisions API).
//
// OpenAI: { model, questions: [...], input }   -> answers: [...] in question order
// Jev:    { model, state, questions: {name: q} } -> answers: {name: answer}
//
// Anything Jev cannot express makes the request untranslatable. The caller then
// treats the Jev backend as ineligible; questions are never dropped.
import { z } from 'zod';
import type { DecisionsQuestion, DecisionsRequest } from './schema.js';

type JevQuestion =
  | { type: 'noul'; instructions: unknown }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: unknown; criteria: string[] };

export interface JevRequestBody {
  model: string;
  state: unknown;
  questions: Record<string, JevQuestion>;
}

interface QuestionMapping {
  key: string;
  question: DecisionsQuestion;
  /** Jev choice key to the original OpenAI choice value, in choice order. */
  choiceKeys?: Array<{ key: string; value: string | boolean }>;
}

export interface JevTranslation {
  body: JevRequestBody;
  mappings: QuestionMapping[];
}

export type JevTranslationResult = { ok: true; translation: JevTranslation } | { ok: false; reason: string };

const TOP_LEVEL_FIELDS = new Set(['model', 'questions', 'input', 'stream']);
const QUESTION_FIELDS = new Set(['type', 'name', 'instructions', 'choices', 'levels']);
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;

class Untranslatable extends Error {}
const fail = (reason: string): never => { throw new Untranslatable(reason); };

function textOrData(part: Record<string, unknown>, where: string): string | { type: 'json'; data: unknown } {
  if ('prompt_cache_breakpoint' in part && part.prompt_cache_breakpoint != null) fail(`prompt_cache_breakpoint in ${where} is not supported by Jev`);
  switch (part.type) {
    case 'input_text':
    case 'output_text':
      if (typeof part.text !== 'string') fail(`${where} has a text part without text`);
      return part.text as string;
    case 'refusal':
      if (typeof part.refusal !== 'string') fail(`${where} has a refusal part without text`);
      return part.refusal as string;
    case 'input_json':
      return { type: 'json', data: part.data };
    case 'input_image':
      return fail(`input_image parts in ${where} are not supported by Jev`);
    default:
      return fail(`content part type ${JSON.stringify(String(part.type))} in ${where} is not supported by Jev`);
  }
}

function translateContent(content: unknown, where: string): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return fail(`${where} has no content`);
  const parts = content.map((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return fail(`${where} has an invalid content part`);
    return textOrData(part as Record<string, unknown>, where);
  });
  return parts.every((part) => typeof part === 'string') ? parts.join('\n\n') : parts;
}

function translateState(input: DecisionsRequest['input']): unknown {
  if (typeof input === 'string') return input;
  const messages = input.map((item, index) => {
    const where = `input[${index}]`;
    const type = item.type;
    if (type !== undefined && type !== 'message') return fail(`${String(type)} input items are not supported by Jev`);
    if (!['user', 'developer', 'system', 'assistant'].includes(String(item.role))) return fail(`${where} has an unsupported role`);
    const extra = Object.keys(item).filter((key) => !['type', 'role', 'content', 'phase'].includes(key));
    if (extra.length) return fail(`${where} field ${extra[0]} is not supported by Jev`);
    return {
      role: item.role,
      content: translateContent(item.content, where),
      ...(typeof item.phase === 'string' ? { phase: item.phase } : {}),
    };
  });
  return { messages };
}

function translateInstructions(instructions: DecisionsQuestion['instructions'], where: string): unknown {
  return typeof instructions === 'string' ? instructions : translateContent(instructions, where);
}

function questionKeys(questions: DecisionsQuestion[]): string[] {
  const used = new Set<string>();
  const named = questions.map((question) => {
    const name = question.name;
    if (typeof name === 'string' && NAME_PATTERN.test(name) && !used.has(name)) { used.add(name); return name; }
    return undefined;
  });
  return named.map((name, index) => {
    if (name) return name;
    // Stable generated key for unnamed (or unusable) names, unique in this request.
    let key = `question_${index + 1}`;
    for (let suffix = 2; used.has(key); suffix += 1) key = `question_${index + 1}_${suffix}`;
    used.add(key);
    return key;
  });
}

export function translateRequestToJev(body: DecisionsRequest, model: string): JevTranslationResult {
  try {
    if (body.prompt_cache_key != null || body.prompt_cache_options != null) fail('prompt_cache_key and prompt_cache_options are not supported by Jev');
    if (body.safety_identifier != null) fail('safety_identifier is not supported by Jev');
    const extra = Object.keys(body).filter((key) => !TOP_LEVEL_FIELDS.has(key) && (body as Record<string, unknown>)[key] != null);
    if (extra.length) fail(`request field ${extra[0]} is not supported by Jev`);

    const keys = questionKeys(body.questions);
    const mappings: QuestionMapping[] = [];
    const questions: Record<string, JevQuestion> = {};
    body.questions.forEach((question, index) => {
      const where = `questions[${index}]`;
      const unknown = Object.keys(question).filter((key) => !QUESTION_FIELDS.has(key));
      if (unknown.length) fail(`${where} field ${unknown[0]} is not supported by Jev`);
      const key = keys[index]!;
      const instructions = translateInstructions(question.instructions, `${where}.instructions`);
      if (question.type === 'predicate') {
        questions[key] = { type: 'noul', instructions };
        mappings.push({ key, question });
        return;
      }
      if (question.type === 'choice') {
        const choiceKeys = question.choices!.map((choice) => ({ key: String(choice.value), value: choice.value }));
        if (new Set(choiceKeys.map((entry) => entry.key)).size !== choiceKeys.length) fail(`${where} has choices that Jev cannot distinguish (a string and a boolean with the same text)`);
        const extraChoice = question.choices!.flatMap((choice) => Object.keys(choice).filter((field) => field !== 'value' && field !== 'description'));
        if (extraChoice.length) fail(`${where} choice field ${extraChoice[0]} is not supported by Jev`);
        questions[key] = {
          type: 'choice', instructions,
          criteria: Object.fromEntries(question.choices!.map((choice) => [String(choice.value), choice.description ?? null])),
        };
        mappings.push({ key, question, choiceKeys });
        return;
      }
      const extraLevel = question.levels!.flatMap((level) => Object.keys(level).filter((field) => field !== 'label' && field !== 'description'));
      if (extraLevel.length) fail(`${where} level field ${extraLevel[0]} is not supported by Jev`);
      questions[key] = {
        type: 'score', instructions,
        criteria: question.levels!.map((level) => level.description ? `${level.label}: ${level.description}` : level.label),
      };
      mappings.push({ key, question });
    });

    return { ok: true, translation: { body: { model, state: translateState(body.input), questions }, mappings } };
  } catch (error) {
    if (error instanceof Untranslatable) return { ok: false, reason: error.message };
    throw error;
  }
}

const probability = z.number().finite().min(0).max(1);
const jevAnswerSchema = z.union([
  z.object({ type: z.literal('noul'), noul: probability }).loose(),
  z.object({ type: z.literal('choice'), choice: z.string(), confidence: probability.optional(), probabilities: z.record(z.string(), probability).optional() }).loose(),
  z.object({ type: z.literal('score'), score: z.number().finite(), confidence: probability.optional(), probabilities: z.record(z.string(), probability).optional() }).loose(),
]);
export const jevResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), jevAnswerSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).loose(),
}).loose();

export interface OpenAiDecisionsUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number; cache_write_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

export type OpenAiDecisionsAnswer =
  | { type: 'predicate'; name: string | null; probability: number }
  | { type: 'choice'; name: string | null; choice: string | boolean; confidence: number; probabilities: Array<{ value: string | boolean; probability: number }> }
  | { type: 'score'; name: string | null; score: number; confidence: number; probabilities: Array<{ label: string; probability: number; value: number }> }
  | { type: 'refusal'; name: string | null };

export interface OpenAiDecisionsResponse {
  model: string;
  answers: OpenAiDecisionsAnswer[];
  usage: OpenAiDecisionsUsage;
}

/** Thrown when Jev's answers do not match the questions that were sent. */
export class JevResponseMismatch extends Error {}

export function translateJevResponse(raw: unknown, translation: JevTranslation): OpenAiDecisionsResponse {
  const parsed = jevResponseSchema.safeParse(raw);
  if (!parsed.success) throw new JevResponseMismatch('Jev returned a response that is not a valid decision');
  const response = parsed.data;
  const answers = translation.mappings.map(({ key, question, choiceKeys }): OpenAiDecisionsAnswer => {
    const name = question.name ?? null;
    const answer = response.answers[key];
    if (!answer) throw new JevResponseMismatch(`Jev returned no answer for question ${key}`);
    if (question.type === 'predicate') {
      if (answer.type !== 'noul') throw new JevResponseMismatch(`Jev answered question ${key} with ${answer.type}, expected noul`);
      return { type: 'predicate', name, probability: answer.noul };
    }
    if (question.type === 'choice') {
      if (answer.type !== 'choice') throw new JevResponseMismatch(`Jev answered question ${key} with ${answer.type}, expected choice`);
      const selected = choiceKeys!.find((entry) => entry.key === answer.choice);
      if (!selected) throw new JevResponseMismatch(`Jev chose a value that question ${key} did not offer`);
      const probabilities = choiceKeys!
        .filter((entry) => answer.probabilities?.[entry.key] !== undefined)
        .map((entry) => ({ value: entry.value, probability: answer.probabilities![entry.key]! }));
      return { type: 'choice', name, choice: selected.value, confidence: answer.confidence ?? answer.probabilities?.[selected.key] ?? 0, probabilities };
    }
    if (answer.type !== 'score') throw new JevResponseMismatch(`Jev answered question ${key} with ${answer.type}, expected score`);
    const probabilities = question.levels!.flatMap((level, index) => {
      const value = answer.probabilities?.[String(index)];
      return value === undefined ? [] : [{ label: level.label, probability: value, value: index }];
    });
    return { type: 'score', name, score: answer.score, confidence: answer.confidence ?? 0, probabilities };
  });
  const input = response.usage.input_tokens;
  const output = response.usage.output_tokens;
  return {
    model: response.model,
    answers,
    usage: {
      input_tokens: input,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: input + output,
    },
  };
}
