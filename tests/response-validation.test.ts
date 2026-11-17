import { beforeAll, describe, expect, it } from 'vitest';

import { compileDataset, modeQuestions } from '../src/dataset/index.js';
import { optionLabel, orderedOptions, parseAnswer, questionPrompt, toScoringAnswer } from '../src/prompts/index.js';
import type { Experiment, Question } from '../src/types.js';

let question: Question;
beforeAll(async () => { question = modeQuestions(await compileDataset(), 'quick')[0]; });
function affirmed(): object { return { status: 'answered', choice: 'A', certainty: 3, tolerance: 0, rationale: 'A short justification.' }; }

describe('model response boundary', () => {
  it('accepts one owned option and preserves zero tolerance', () => {
    const answer = parseAnswer(JSON.stringify(affirmed()), question);
    expect(toScoringAnswer(question.id, answer)?.tolerance).toBe(0);
  });
  it.each([
    { choice: 'Z' }, { choice: 'A, B' }, { choice: ['A', 'B'] }, { choice: null }, { choice: 'GOD_01_A01' },
    { certainty: 4 }, { certainty: 1.2 }, { tolerance: -1 }, { certainty: null }, { answerId: 'A' }, { rationale: '' },
  ])('rejects malformed or multiple selections: %j', patch => {
    expect(() => parseAnswer(JSON.stringify({ ...affirmed(), ...patch }), question)).toThrow();
  });
  it.each(['apathetic', 'hostile', 'refusal'])('keeps %s distinct', status => {
    const answer = parseAnswer(JSON.stringify({ status, choice: null, certainty: null, tolerance: null, rationale: 'Explanation.' }), question);
    const scoring = toScoringAnswer(question.id, answer);
    if (status === 'refusal') expect(scoring).toBeNull();
    else expect(scoring).toMatchObject({ isSilence: true, silenceType: status, certainty: status === 'hostile' ? 3 : 0 });
  });
  it('rejects silence with a selected option and fenced/prose JSON', () => {
    expect(() => parseAnswer(JSON.stringify({ ...affirmed(), status: 'apathetic' }), question)).toThrow();
    expect(() => parseAnswer('```json\n{}\n```', question)).toThrow();
  });
  it('sends original option text/context without scoring weights or labels', () => {
    const text = questionPrompt(question, question.options);
    expect(text).toContain(question.text);
    expect(text).toContain(question.options[0].description);
    expect(text).not.toContain('priority');
    expect(text).not.toContain('matchPercentage');
  });
  it('maps the displayed letter back to the shuffled option, not the canonical position', () => {
    const shown = orderedOptions(question, { shuffleOptions: true, seed: 7 } as Experiment, 2);
    expect(shown.map(option => option.id)).not.toEqual(question.options.map(option => option.id));
    const answer = parseAnswer(JSON.stringify({ ...affirmed(), choice: 'c' }), question, shown);
    expect(answer.answerId).toBe(shown[2].id);
    expect(optionLabel(2)).toBe('C');
  });
  it('labels options by display position without leaking source IDs', () => {
    const text = questionPrompt(question, question.options.slice().reverse());
    expect(text).not.toMatch(/[A-Z]+_\d+_A\d+/);
    expect(text).toContain(`A. ${question.options.at(-1)!.text}`);
  });
  it('pairs seeded shuffles across models and leaves fixed order intact', () => {
    const config = { shuffleOptions: true, seed: 12 } as Experiment;
    expect(orderedOptions(question, config, 1)).toEqual(orderedOptions(question, config, 1));
    expect(orderedOptions(question, config, 1).map(option => option.id).sort()).toEqual(question.options.map(option => option.id).sort());
    expect(orderedOptions(question, { ...config, shuffleOptions: false }, 1)).toEqual(question.options);
  });
});
