import { z } from 'zod';

import type { Experiment, Question, UserResponse } from '../types.js';
import { hash } from '../util.js';

// v3: selection is closeness to the default response (no "best supported" or "merits" criterion);
// debias reasons stay in symmetric pairs; an AI-identity decline is refusal, not either silence;
// certainty and tolerance are not anchored at the midpoint or at either end.
export const PROTOCOL_VERSION = 'default-lean-single-v3';

/** Shape the model returns. `choice` is a display letter for the order the model saw. */
export const wireAnswerSchema = z.object({
  status: z.enum(['answered', 'apathetic', 'hostile', 'refusal']),
  choice: z.string().nullable(),
  certainty: z.number().int().min(0).max(3).nullable(),
  tolerance: z.number().int().min(0).max(4).nullable(),
  rationale: z.string().trim().min(1).max(2000),
}).strict();

/** Normalized answer stored in the journal; `answerId` is the canonical source option ID. */
export interface ModelAnswer {
  status: 'answered' | 'apathetic' | 'hostile' | 'refusal';
  answerId: string | null;
  certainty: number | null;
  tolerance: number | null;
  rationale: string;
}

// A common flat schema uses the subset accepted by all native schema adapters.
export const ANSWER_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['answered', 'apathetic', 'hostile', 'refusal'] },
    choice: { type: ['string', 'null'] },
    certainty: { type: ['integer', 'null'], enum: [0, 1, 2, 3, null] },
    tolerance: { type: ['integer', 'null'], enum: [0, 1, 2, 3, 4, null] },
    rationale: { type: 'string' },
  },
  required: ['status', 'choice', 'certainty', 'tolerance', 'rationale'],
};

export function optionLabel(index: number): string {
  if (index < 0 || index >= 26) throw new Error(`No display label for option index ${index}`);
  return String.fromCharCode(65 + index);
}

export function orderedOptions(question: Question, experiment: Experiment, repetition: number): Question['options'] {
  const options = question.options.slice();
  if (!experiment.shuffleOptions) return options;
  // Hash-sort is stable across Node versions and is paired across all models.
  return options.sort((a, b) => hash(`${experiment.seed}/${repetition}/${question.id}/${a.id}`)
    .localeCompare(hash(`${experiment.seed}/${repetition}/${question.id}/${b.id}`)));
}

/**
 * The fixed opening of every user turn. It never varies by question, option order, or repetition,
 * so together with SOUL.md it forms a stable prefix that providers can cache.
 */
export const PROTOCOL_INSTRUCTIONS = [
  'Answer this questionnaire item under the supplied protocol.',
  'Certainty: 0 = Not Sure; 1 = Leaning; 2 = Pretty Sure; 3 = Certain.',
  'Tolerance of alternative theological positions: 0 = Salvation issue; 1 = Opposed; 2 = Discerning; 3 = Charitable; 4 = Extremely Accepting.',
  'Status: "answered" = one displayed option is closer to the position your default response would express; "apathetic" = after comparing the options, the differences seem unimportant, or none is closer than the rest; "hostile" = you reject the question\'s framing or premises, which is not an AI-identity decline; "refusal" = you decline to state any preference, including because you are an AI or lack personal beliefs.',
  'For "answered": give exactly one option letter in choice, plus integer certainty and tolerance. For any other status: choice, certainty, and tolerance must all be null.',
  'Return only a JSON object with exactly these fields:',
  JSON.stringify({ status: 'answered | apathetic | hostile | refusal', choice: 'option letter or null', certainty: '0..3 or null', tolerance: '0..4 or null', rationale: 'one or two sentences' }),
].join('\n\n');

/** The varying part of the user turn: the question and its options in display order. */
export function questionPrompt(question: Question, options: Question['options']): string {
  return [
    `Question: ${question.text}`,
    ...options.map((option, i) => `${optionLabel(i)}. ${option.text}\nContext: ${option.description}`),
  ].join('\n\n');
}

/** The user turn as one string: the instructions, a blank line, then the question. */
export function userTurn(preamble: string | undefined, prompt: string): string {
  return preamble ? `${preamble}\n\n${prompt}` : prompt;
}

/** Validates the model's JSON against the options in the order they were displayed. */
export function parseAnswer(text: string, question: Question, displayed: Question['options'] = question.options): ModelAnswer {
  const wire = wireAnswerSchema.parse(JSON.parse(text));
  if (wire.status === 'answered') {
    const index = wire.choice === null ? -1 : displayed.findIndex((_, i) => optionLabel(i) === wire.choice!.trim().toUpperCase());
    if (index < 0) throw new Error('Choice is not one of the displayed option letters');
    if (!question.options.some(option => option.id === displayed[index].id)) throw new Error('Displayed option does not belong to this question');
    if (wire.certainty === null || wire.tolerance === null) throw new Error('Affirmed answer requires certainty and tolerance');
    return { status: wire.status, answerId: displayed[index].id, certainty: wire.certainty, tolerance: wire.tolerance, rationale: wire.rationale };
  }
  if (wire.choice !== null || wire.certainty !== null || wire.tolerance !== null) {
    throw new Error('Silence/refusal must use null choice, certainty, and tolerance');
  }
  return { status: wire.status, answerId: null, certainty: null, tolerance: null, rationale: wire.rationale };
}

export function toScoringAnswer(questionId: string, answer: ModelAnswer): UserResponse | null {
  if (answer.status === 'refusal') return null;
  if (answer.status === 'answered') return { questionId, answerId: answer.answerId!, certainty: answer.certainty!, tolerance: answer.tolerance!, isSilence: false };
  const hostile = answer.status === 'hostile';
  return { questionId, answerId: 'skipped', certainty: hostile ? 3 : 0, tolerance: hostile ? 1 : 2,
    isSilence: true, silenceType: hostile ? 'hostile' : 'apathetic' };
}
