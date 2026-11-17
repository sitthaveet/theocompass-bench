import { ANSWER_JSON_SCHEMA } from '../prompts/index.js';
import type { Adapter } from './types.js';

export const anthropic: Adapter = {
  build(input) {
    // Claude's enum checker requires a single declared type per enum branch.
    const schema = { ...ANSWER_JSON_SCHEMA, properties: { ...ANSWER_JSON_SCHEMA.properties,
      choice: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      certainty: { anyOf: [{ type: 'integer', enum: [0, 1, 2, 3] }, { type: 'null' }] },
      tolerance: { anyOf: [{ type: 'integer', enum: [0, 1, 2, 3, 4] }, { type: 'null' }] },
    } };
    // Claude caches only up to an explicit breakpoint. SOUL plus the fixed instructions is the shared
    // prefix; the breakpoint after the instructions lets every later question read it from cache.
    const content = input.preamble
      ? [{ type: 'text', text: input.preamble, cache_control: { type: 'ephemeral' } }, { type: 'text', text: input.prompt }]
      : input.prompt;
    return { url: `${input.model.baseUrl}/messages`, headers: { 'anthropic-version': '2023-06-01' }, outputMode: 'json_schema', body: {
      model: input.model.model, system: input.system, messages: [{ role: 'user', content }],
      max_tokens: input.maxOutputTokens, output_config: { format: { type: 'json_schema', schema } },
    } };
  },
  decode(body) {
    return { text: (body.content || []).filter((item: any) => item.type === 'text').map((item: any) => item.text).join(''),
      refusal: body.stop_reason === 'refusal', truncated: body.stop_reason === 'max_tokens', returnedModel: body.model || null,
      usage: { inputTokens: body.usage ? (body.usage.input_tokens || 0) + (body.usage.cache_read_input_tokens || 0) + (body.usage.cache_creation_input_tokens || 0) : null,
        outputTokens: body.usage?.output_tokens ?? null, reasoningTokens: null, cachedInputTokens: body.usage?.cache_read_input_tokens ?? null,
        cacheWriteInputTokens: body.usage?.cache_creation_input_tokens ?? null },
    };
  },
};
