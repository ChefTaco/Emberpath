import type { RouteRequest } from '../providers/types.js';

/**
 * Native routes that generate no output tokens (listings, model details, embeddings,
 * downloads, tokenization), so the quota reservation is the request alone.
 */
const NO_OUTPUT_NATIVE_PATHS = new Set([
  '/api/tags', '/api/ps', '/api/show', '/api/embed', '/api/embeddings', '/api/pull',
  '/tokenize', '/detokenize', '/version',
]);

export type OutputAllowance =
  | { kind: 'none' }
  | { kind: 'explicit'; tokens: number }
  | { kind: 'unbounded' };

/**
 * How many output tokens a request may generate, as the request states it: OpenAI
 * `max_completion_tokens`, `max_tokens` or `max_output_tokens`, or Ollama's
 * `options.num_predict` on its native routes (where -1 and -2 mean no fixed limit).
 */
export function outputAllowance(route: Pick<RouteRequest, 'endpointKind' | 'path' | 'requestBodyJson'>): OutputAllowance {
  if (route.endpointKind === 'v1.embeddings') return { kind: 'none' };
  if ((route.endpointKind === 'ollama.native' || route.endpointKind === 'vllm.native') && NO_OUTPUT_NATIVE_PATHS.has(route.path)) return { kind: 'none' };
  const body = route.requestBodyJson && typeof route.requestBodyJson === 'object' && !Array.isArray(route.requestBodyJson)
    ? route.requestBodyJson as Record<string, unknown>
    : undefined;
  let stated = body?.max_completion_tokens ?? body?.max_tokens ?? body?.max_output_tokens;
  if (stated === undefined && route.endpointKind === 'ollama.native') {
    const options = body?.options;
    if (options && typeof options === 'object' && !Array.isArray(options)) stated = (options as Record<string, unknown>).num_predict;
  }
  return typeof stated === 'number' && Number.isSafeInteger(stated) && stated > 0
    ? { kind: 'explicit', tokens: stated }
    : { kind: 'unbounded' };
}
