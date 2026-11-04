import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyJev } from '../../src/routing/jev.js';
import { DECISION_ENDPOINT } from '../../src/routing/decisioning.js';
import { TYPESAFE_DECISION_ENDPOINT } from '../../src/routing/typesafe.js';

const config = { typesafe: { apiKey: 'direct-key', model: 'jev-latest', timeoutMs: 100 }, openrouter: { apiKey: 'fallback-key', model: '~typesafe/jev-latest', timeoutMs: 100 } };
const result = { model: 'jev-1.13.0', answers: { profile: { type: 'choice', choice: 'dangerous' }, injection: { type: 'noul', noul: 1 }, nsfw: { type: 'noul', noul: 1 } }, usage: { input_tokens: 5, output_tokens: 0 } };
afterEach(() => vi.unstubAllGlobals());
describe('Jev primary and fallback', () => {
  it('uses direct TypeSafe and accepts adverse labels without fallback', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(result)); vi.stubGlobal('fetch', fetch);
    expect(await classifyJev({ prompt: 'synthetic' }, config)).toMatchObject({ status: 'ok', decisionProvider: 'typesafe', fallbackUsed: false, answers: result.answers, durationMs: expect.any(Number) });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(TYPESAFE_DECISION_ENDPOINT);
    expect(fetch.mock.calls[0]![1].headers.Authorization).toBe('Bearer direct-key');
    expect(JSON.parse(fetch.mock.calls[0]![1].body).model).toBe('jev-latest');
  });
  it.each([401, 429, 503, 'malformed', 'network', 'timeout'])('falls back once for %s and keeps credentials and models separate', async failure => {
    const fetch = vi.fn().mockImplementationOnce(() => {
      if (failure === 'network') throw new Error('secret provider message');
      if (failure === 'timeout') throw new DOMException('timed out', 'TimeoutError');
      return Promise.resolve(failure === 'malformed' ? Response.json({}) : new Response('private upstream body', { status: typeof failure === 'number' ? failure : 500 }));
    }).mockResolvedValueOnce(Response.json({ ...result, model: 'typesafe/jev-1.13-20260917' }));
    vi.stubGlobal('fetch', fetch);
    const response = await classifyJev({ prompt: 'synthetic' }, config);
    expect(response).toMatchObject({ status: 'ok', decisionProvider: 'openrouter', fallbackUsed: true, attempts: [{ provider: 'typesafe', status: 'unavailable', durationMs: expect.any(Number) }, { provider: 'openrouter', status: 'ok', durationMs: expect.any(Number) }] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toBe(DECISION_ENDPOINT);
    expect(fetch.mock.calls[1]![1].headers.Authorization).toBe('Bearer fallback-key');
    expect(JSON.parse(fetch.mock.calls[1]![1].body).model).toBe('~typesafe/jev-latest');
    expect(JSON.stringify(response)).not.toMatch(/secret provider|private upstream|direct-key|fallback-key/);
  });
  it('reports both failures without inventing a safe classification', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 503 }))));
    const response = await classifyJev('test', config);
    expect(response).toMatchObject({ status: 'unavailable', reason: 'decision_all_providers_unavailable' });
    expect(response.attempts).toHaveLength(2); expect(response).not.toHaveProperty('answers');
  });
  it('does not fallback on caller cancellation', async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementation(() => { controller.abort(); throw new DOMException('aborted', 'AbortError'); }); vi.stubGlobal('fetch', fetch);
    expect(await classifyJev('test', config, controller.signal)).toMatchObject({ status: 'unavailable', reason: 'decision_cancelled' });
    expect(fetch).toHaveBeenCalledTimes(1);
    await classifyJev('test', config, controller.signal); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized input before either transport and handles no configuration', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await classifyJev('a'.repeat(24001), config)).toMatchObject({ reason: 'decision_input_limit', attempts: [] });
    expect(await classifyJev('test', {})).toMatchObject({ reason: 'decision_not_configured', attempts: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['typesafe', 'openrouter'] as const)('supports only %s configured', async provider => {
    const fetch = vi.fn().mockResolvedValue(Response.json(result)); vi.stubGlobal('fetch', fetch);
    expect(await classifyJev('test', { [provider]: config[provider] })).toMatchObject({ status: 'ok', decisionProvider: provider, fallbackUsed: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
