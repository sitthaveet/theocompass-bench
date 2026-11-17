import { userTurn } from '../prompts/index.js';
import type { Adapter } from './types.js';

export const deepseek: Adapter = {
  build(input) {
    return { url: `${input.model.baseUrl}/chat/completions`, headers: {}, outputMode: 'json_object', body: {
      model: input.model.model, messages: [{ role: 'system', content: input.system }, { role: 'user', content: userTurn(input.preamble, input.prompt) }],
      max_tokens: input.maxOutputTokens, response_format: { type: 'json_object' },
    } };
  },
  decode(body) {
    const choice = body.choices?.[0];
    return { text: choice?.message?.content || '', refusal: !!choice?.message?.refusal || choice?.finish_reason === 'content_filter',
      truncated: choice?.finish_reason === 'length' || choice?.finish_reason === 'insufficient_system_resource', returnedModel: body.model || null,
      usage: { inputTokens: body.usage?.prompt_tokens ?? null, outputTokens: body.usage?.completion_tokens ?? null,
        reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? null,
        cachedInputTokens: body.usage?.prompt_cache_hit_tokens ?? body.usage?.prompt_tokens_details?.cached_tokens ?? null },
    };
  },
};
