import type { Provider } from '../types.js';
import { anthropic } from './anthropic.js';
import { deepseek } from './deepseek.js';
import { gemini } from './gemini.js';
import { openai } from './openai.js';
import { qwen } from './qwen.js';
import type { Adapter, PreparedRequest, ProviderInput, ProviderResult } from './types.js';

export const adapters: Record<Provider, Adapter> = { openai, anthropic, deepseek, gemini, qwen, grok: openai };

export interface Exchange {
  httpStatus: number | null;
  headers: Record<string, string>;
  rawBody: string;
  result?: ProviderResult;
  error?: string;
  retryable: boolean;
  retryAfterMs?: number;
}

/** Persist only these request fields. Authentication is never part of PreparedRequest. */
export function prepareRequest(input: ProviderInput): PreparedRequest {
  return adapters[input.model.provider].build(input);
}

export async function sendRequest(input: ProviderInput, request: PreparedRequest, fetcher: typeof fetch = fetch): Promise<Exchange> {
  const key = process.env[input.model.apiKeyEnv];
  if (!key) throw new Error(`Missing API key ${input.model.apiKeyEnv}`);
  const headers = { 'content-type': 'application/json', ...request.headers } as Record<string, string>;
  if (input.model.provider === 'gemini') headers['x-goog-api-key'] = key;
  else if (input.model.provider === 'anthropic') headers['x-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  try {
    const response = await fetcher(request.url, { method: 'POST', headers, body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(input.timeoutMs), redirect: 'error' });
    const rawBody = await response.text();
    const keptHeaders: Record<string, string> = {};
    for (const name of ['x-request-id', 'request-id', 'retry-after', 'date']) {
      const value = response.headers.get(name);
      if (value) keptHeaders[name] = value;
    }
    const retryAfter = response.headers.get('retry-after');
    let retryAfterMs: number | undefined;
    if (retryAfter) retryAfterMs = /^\d+(\.\d+)?$/.test(retryAfter)
      ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
    const exchange: Exchange = { httpStatus: response.status, headers: keptHeaders, rawBody,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined };
    if (!response.ok) return { ...exchange, error: `HTTP ${response.status}` };
    try {
      return { ...exchange, result: adapters[input.model.provider].decode(JSON.parse(rawBody)), retryable: false };
    } catch {
      return { ...exchange, error: 'Provider returned an invalid response envelope', retryable: false };
    }
  } catch (error) {
    const cause = error instanceof Error ? error.name : 'NetworkError';
    // Avoid persisting exception messages that might contain credentials or request details.
    return { httpStatus: null, headers: {}, rawBody: '', error: `Transport failure (${cause})`, retryable: true };
  }
}
