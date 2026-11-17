import { ANSWER_JSON_SCHEMA, userTurn } from '../prompts/index.js';
import type { Adapter } from './types.js';

export const gemini: Adapter = {
  build(input) {
    return { url: `${input.model.baseUrl}/models/${encodeURIComponent(input.model.model)}:generateContent`,
      headers: {}, outputMode: 'json_schema', body: {
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: 'user', parts: [{ text: userTurn(input.preamble, input.prompt) }] }],
        generationConfig: { maxOutputTokens: input.maxOutputTokens,
          responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: ANSWER_JSON_SCHEMA } } },
      } };
  },
  decode(body) {
    const candidate = body.candidates?.[0];
    const finish = candidate?.finishReason;
    return { text: (candidate?.content?.parts || []).filter((part: any) => !part.thought && typeof part.text === 'string').map((part: any) => part.text).join(''),
      refusal: !!body.promptFeedback?.blockReason || ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(finish),
      truncated: finish === 'MAX_TOKENS', returnedModel: body.modelVersion || null,
      usage: { inputTokens: body.usageMetadata?.promptTokenCount ?? null,
        outputTokens: body.usageMetadata ? (body.usageMetadata.candidatesTokenCount || 0) + (body.usageMetadata.thoughtsTokenCount || 0) : null,
        reasoningTokens: body.usageMetadata?.thoughtsTokenCount ?? null, cachedInputTokens: body.usageMetadata?.cachedContentTokenCount ?? null },
    };
  },
};
