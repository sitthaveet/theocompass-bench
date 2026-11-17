import type { ModelConfig } from '../types.js';

export interface ProviderInput {
  model: ModelConfig;
  system: string;
  /** Fixed opening of the user turn, identical on every request (cacheable). */
  preamble?: string;
  /** Varying part of the user turn: the question and its options. */
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
}
export interface PreparedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  outputMode: 'json_schema' | 'json_object';
}
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** Input tokens read from a provider cache (billed at a discount); included in inputTokens. */
  cachedInputTokens: number | null;
  /** Input tokens written to a provider cache (Anthropic bills a premium); included in inputTokens. */
  cacheWriteInputTokens?: number | null;
}
export interface ProviderResult {
  text: string;
  refusal: boolean;
  truncated: boolean;
  returnedModel: string | null;
  usage: Usage;
}
export interface Adapter {
  build(input: ProviderInput): PreparedRequest;
  decode(body: Record<string, any>): ProviderResult;
}
