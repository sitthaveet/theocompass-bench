import { afterEach, describe, expect, it, vi } from 'vitest';

import { adapters, prepareRequest, sendRequest } from '../src/providers/index.js';
import type { ProviderInput } from '../src/providers/types.js';
import type { Provider } from '../src/types.js';

afterEach(() => vi.unstubAllEnvs());
const providers: Provider[] = ['openai', 'gemini', 'anthropic', 'deepseek', 'qwen', 'grok'];
function input(provider: Provider): ProviderInput {
  return { model: { id: provider, provider, model: 'test-model', apiKeyEnv: 'BENCH_TEST_KEY', baseUrl: 'https://example.test/v1' },
    system: 'Identical SOUL', prompt: 'Question in JSON', timeoutMs: 1000, maxOutputTokens: 8192 };
}

describe('six provider adapters', () => {
  it.each(providers)('builds a stateless %s request without credentials or sampling overrides', provider => {
    const request = prepareRequest(input(provider));
    const serialized = JSON.stringify(request);
    expect(serialized).toContain('Identical SOUL');
    expect(serialized).toContain('Question in JSON');
    expect(serialized).not.toMatch(/authorization|x-api-key|x-goog-api-key|temperature|top_p|reasoning_effort|thinkingConfig/);
    if (['openai', 'grok'].includes(provider)) {
      expect(request.url).toBe('https://example.test/v1/responses');
      expect(request.body.store).toBe(false);
      expect(request.body.tools).toEqual([]);
    }
    if (provider === 'anthropic') expect(request.body.output_config).toBeDefined();
    if (provider === 'gemini') {
      expect(request.url).toContain('models/test-model:generateContent');
      expect(request.body.generationConfig).toMatchObject({ responseFormat: { text: { mimeType: 'APPLICATION_JSON' } } });
    }
    if (provider === 'deepseek') expect(request.body.response_format).toEqual({ type: 'json_object' });
    if (provider === 'qwen') expect(request.body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
  });
  it('extracts Responses text after reasoning blocks and counts reasoning tokens', () => {
    const result = adapters.grok.decode({ model: 'grok-4.7', status: 'completed', output: [
      { type: 'reasoning', encrypted_content: 'opaque' }, { type: 'message', content: [{ type: 'output_text', text: '{"a":1}' }] },
    ], usage: { input_tokens: 20, output_tokens: 30, output_tokens_details: { reasoning_tokens: 25 } } });
    expect(result.text).toBe('{"a":1}');
    expect(result.returnedModel).toBe('grok-4.7');
    expect(result.usage.outputTokens).toBe(30);
    expect(result.usage.reasoningTokens).toBe(25);
  });
  it('uses separately typed nullable enum branches accepted by Claude', () => {
    const request = prepareRequest(input('anthropic'));
    const format = request.body.output_config as { format: { schema: typeof import('../src/prompts/index.js').ANSWER_JSON_SCHEMA } };
    expect(format.format.schema.properties.certainty).toEqual({ anyOf: [{ type: 'integer', enum: [0, 1, 2, 3] }, { type: 'null' }] });
    expect(JSON.stringify(format)).not.toContain('minimum');
  });
  it('recognizes provider refusals and truncation', () => {
    expect(adapters.openai.decode({ output: [{ type: 'message', content: [{ type: 'refusal' }] }] }).refusal).toBe(true);
    expect(adapters.anthropic.decode({ stop_reason: 'refusal' }).refusal).toBe(true);
    expect(adapters.deepseek.decode({ choices: [{ finish_reason: 'length' }] }).truncated).toBe(true);
    expect(adapters.gemini.decode({ promptFeedback: { blockReason: 'SAFETY' } }).refusal).toBe(true);
    expect(adapters.gemini.decode({ candidates: [{ finishReason: 'MAX_TOKENS' }] }).truncated).toBe(true);
  });
  it('does not treat Gemini thought text as the answer or omit thought usage', () => {
    const result = adapters.gemini.decode({ candidates: [{ content: { parts: [{ thought: true, text: 'internal' }, { text: 'answer' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 20 } });
    expect(result.text).toBe('answer');
    expect(result.usage.outputTokens).toBe(25);
  });
  it.each(providers)('attaches %s authentication only at send time', async provider => {
    vi.stubEnv('BENCH_TEST_KEY', 'fake-secret-for-test');
    const prepared = prepareRequest(input(provider));
    const fetcher = vi.fn(async (_url, options) => {
      const headers = options!.headers as Record<string, string>;
      const field = provider === 'gemini' ? 'x-goog-api-key' : provider === 'anthropic' ? 'x-api-key' : 'authorization';
      expect(headers[field]).toContain('fake-secret-for-test');
      expect(options!.redirect).toBe('error');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await sendRequest(input(provider), prepared, fetcher);
    expect(JSON.stringify(prepared)).not.toContain('fake-secret-for-test');
  });
  it.each([400, 401, 403, 404, 408, 429, 500, 503])('classifies HTTP %i for transport retry only', async status => {
    vi.stubEnv('BENCH_TEST_KEY', 'fake-secret-for-test');
    const fetcher = vi.fn(async () => new Response('{}', { status, headers: { 'retry-after': '2' } })) as unknown as typeof fetch;
    const result = await sendRequest(input('grok'), prepareRequest(input('grok')), fetcher);
    expect(result.retryable).toBe([408, 429, 500, 503].includes(status));
    expect(result.retryAfterMs).toBe(2000);
  });
  it('records malformed successful envelopes without retrying', async () => {
    vi.stubEnv('BENCH_TEST_KEY', 'fake-secret-for-test');
    const result = await sendRequest(input('openai'), prepareRequest(input('openai')),
      (async () => new Response('not-json')) as typeof fetch);
    expect(result.error).toMatch(/invalid response envelope/);
    expect(result.retryable).toBe(false);
  });
});
