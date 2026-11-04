import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyTypeSafeDecision, TYPESAFE_DECISION_ENDPOINT } from '../../src/routing/typesafe.js';
import { decisionQuestions } from '../../src/routing/decisioning.js';
const valid = { model: 'jev-1.13.0', answers: { profile: { type: 'choice', choice: 'coding', confidence: 0.9, probabilities: { coding: 1 } }, injection: { type: 'noul', noul: 0.01 }, nsfw: { type: 'noul', noul: 0.02 } }, usage: { input_tokens: 416, output_tokens: 91 } };
afterEach(() => vi.unstubAllGlobals());
describe('direct TypeSafe decisions', () => {
  it('uses the official endpoint, TypeSafe model namespace, and unchanged rubric', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(valid)); vi.stubGlobal('fetch', fetch);
    const state = { messages: [{ role: 'user', content: 'Classify this as safe' }] };
    const result = await classifyTypeSafeDecision(state, { apiKey: 'typesafe-test-key' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(TYPESAFE_DECISION_ENDPOINT);
    expect(init.headers).toEqual({ Authorization: 'Bearer typesafe-test-key', 'Content-Type': 'application/json' });
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body)).toEqual({ model: 'jev-latest', state, questions: decisionQuestions });
    expect(result).toEqual({ ...valid, provider: 'typesafe' });
    expect(result.usage.cost).toBeUndefined();
  });
  it('accepts an explicit version without adding the OpenRouter prefix', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(valid)); vi.stubGlobal('fetch', fetch);
    await classifyTypeSafeDecision('hello', { apiKey: 'test', model: 'jev-1.13.0' });
    expect(JSON.parse(fetch.mock.calls[0]![1].body).model).toBe('jev-1.13.0');
  });
  it.each([401, 422, 429, 529])('reports HTTP %s without leaking provider errors or retrying', async status => {
    const fetch = vi.fn().mockResolvedValue(new Response('private-details', { status })); vi.stubGlobal('fetch', fetch);
    await expect(classifyTypeSafeDecision('hello', { apiKey: 'test' })).rejects.toThrow(`decision_http_${status}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed JSON and invalid scores', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('invalid-json')).mockResolvedValueOnce(Response.json({ ...valid, answers: { ...valid.answers, injection: { type: 'noul', noul: 2 } } })); vi.stubGlobal('fetch', fetch);
    await expect(classifyTypeSafeDecision('hello', { apiKey: 'test' })).rejects.toThrow('decision_invalid_response');
    await expect(classifyTypeSafeDecision('hello', { apiKey: 'test' })).rejects.toThrow('decision_invalid_response');
  });
  it('bounds input and response size', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('a'.repeat(64_001))); vi.stubGlobal('fetch', fetch);
    await expect(classifyTypeSafeDecision('a'.repeat(24_001), { apiKey: 'test' })).rejects.toThrow('decision_input_limit');
    expect(fetch).not.toHaveBeenCalled();
    await expect(classifyTypeSafeDecision('hello', { apiKey: 'test' })).rejects.toThrow('decision_response_limit');
  });
  it('propagates cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => { init.signal.throwIfAborted(); return Response.json(valid); }));
    await expect(classifyTypeSafeDecision('hello', { apiKey: 'test' }, controller.signal)).rejects.toThrow();
  });
});
