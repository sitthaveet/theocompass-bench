import { ANSWER_JSON_SCHEMA } from '../prompts/index.js';
import { deepseek } from './deepseek.js';
import type { Adapter } from './types.js';

export const qwen: Adapter = {
  build(input) {
    const request = deepseek.build(input);
    return { ...request, outputMode: 'json_schema', body: { ...request.body,
      response_format: { type: 'json_schema', json_schema: { name: 'theology_answer', strict: true, schema: ANSWER_JSON_SCHEMA } },
    } };
  },
  decode: deepseek.decode,
};
