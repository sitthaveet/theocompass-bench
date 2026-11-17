import { beforeAll, describe, expect, it } from 'vitest';

import { compileDataset } from '../src/dataset/index.js';
import { scoreAnswers } from '../src/scoring/index.js';
import type { Dataset, Score, UserResponse } from '../src/types.js';
import { canonical, hash, readJson } from '../src/util.js';
import { originalData, originalScore } from './helpers/original.js';

interface Fixtures {
  provenance: { baselineHash: string; sourceHashes: Record<string, string> };
  cases: { name: string; answers: UserResponse[]; expected: Score }[];
}
let dataset: Dataset;
let fixtures: Fixtures;
beforeAll(async () => {
  dataset = await compileDataset();
  fixtures = await readJson('tests/fixtures/scoring-original.json');
});

describe('unchanged original scoring', () => {
  it('matches the original baseline compiler across all 230 denominations', () => {
    expect(dataset.sourceHashes).toEqual(fixtures.provenance.sourceHashes);
    expect(hash(canonical(dataset.denominations))).toBe(fixtures.provenance.baselineHash);
  });

  for (const name of ['first', 'last', 'extremes', 'apathetic', 'hostile', 'mixed', 'multiselect']) {
    it(`matches original full-Quick rankings and 14 axes: ${name}`, () => {
      const fixture = fixtures.cases.find(item => item.name === name)!;
      expect(scoreAnswers(dataset, fixture.answers)).toEqual(fixture.expected);
    });
  }

  it('also executes the archived handler as an independent oracle', async () => {
    const fixture = fixtures.cases.find(item => item.name === 'extremes')!;
    const result = await originalScore(originalData(), fixture.answers);
    expect(result.matches.map((m: any) => ({ id: m.id, name: m.name, family: m.family, matchPercentage: m.matchPercentage })))
      .toEqual(fixture.expected.matches);
  });
});
