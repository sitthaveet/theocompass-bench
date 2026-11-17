import { ANSWER_JSON_SCHEMA, userTurn } from '../prompts/index.js';
import type { Adapter } from './types.js';

/** Responses protocol shared by OpenAI and xAI; credentials are attached only at send time. */
export const openai: Adapter = {
  build(input) {
    return { url: `${input.model.baseUrl}/responses`, headers: {}, outputMode: 'json_schema', body: {
      model: input.model.model, instructions: input.system,
      input: [{ role: 'user', content: [{ type: 'input_text', text: userTurn(input.preamble, input.prompt) }] }],
      max_output_tokens: input.maxOutputTokens, store: false, tools: [],
      text: { format: { type: 'json_schema', name: 'theology_answer', strict: true, schema: ANSWER_JSON_SCHEMA } },
    } };
  },
  decode(body) {
    const content = (body.output || []).flatMap((item: any) => item.type === 'message' ? item.content || [] : []);
    return { text: content.filter((item: any) => item.type === 'output_text').map((item: any) => item.text).join(''),
      refusal: content.some((item: any) => item.type === 'refusal'),
      truncated: body.status === 'incomplete' || body.status === 'failed' || !!body.error,
      returnedModel: body.model || null,
      usage: { inputTokens: body.usage?.input_tokens ?? null, outputTokens: body.usage?.output_tokens ?? null,
        reasoningTokens: body.usage?.output_tokens_details?.reasoning_tokens ?? null,
        cachedInputTokens: body.usage?.input_tokens_details?.cached_tokens ?? null },
    };
  },
};
