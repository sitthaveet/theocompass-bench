import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { beforeAll, describe, expect, it } from 'vitest';

import { compileDataset, compileRows, modeQuestions, SOURCE_SUFFIXES, verifyDataset } from '../src/dataset/index.js';
import type { Dataset } from '../src/types.js';

let dataset: Dataset;
let tables: Record<string, string>[][];
beforeAll(async () => {
  dataset = await compileDataset();
  tables = await Promise.all(SOURCE_SUFFIXES.map(async suffix => parse(
    await readFile(join('data/source', `TheoCompass (v2.0) - ${suffix}`)),
    { columns: true, trim: true, skip_empty_lines: true, bom: true, delimiter: suffix.endsWith('.tsv') ? '\t' : ',', quote: suffix.endsWith('.tsv') ? false : '"' },
  )));
});

describe('source dataset', () => {
  it('compiles deterministically and preserves IDs and modes', async () => {
    expect((await compileDataset()).hash).toBe(dataset.hash);
    expect(dataset.questions).toHaveLength(123);
    expect(dataset.denominations).toHaveLength(230);
    expect(dataset.modes.quick).toHaveLength(30);
    expect(dataset.modes.standard).toHaveLength(58);
    expect(dataset.modes.deep).toHaveLength(123);
    expect(modeQuestions(dataset, 'quick')).toHaveLength(30);
    expect(() => verifyDataset(dataset)).not.toThrow();
  });
  it.each(['standard', 'deep'] as const)('rejects incomplete %s without substituting questions', mode => {
    expect(() => modeQuestions(dataset, mode)).toThrow(/incomplete.*Missing options\/dimensions/);
  });
  it('rejects a tampered snapshot', () => {
    const changed = structuredClone(dataset);
    changed.questions[0].priority = 0;
    expect(() => verifyDataset(changed)).toThrow(/hash mismatch/);
  });
  it('rejects duplicate option IDs', () => {
    const rows = structuredClone(tables);
    rows[2][1].Answer_ID = rows[2][0].Answer_ID;
    expect(() => compileRows(rows, {})).toThrow(/duplicate Answer_ID/);
  });
  it('rejects foreign question references and invalid scores', () => {
    const rows = structuredClone(tables);
    rows[2][0].Question_ID = 'not-a-question';
    expect(() => compileRows(rows, {})).toThrow(/Invalid option/);
    rows[2][0].Question_ID = tables[2][0].Question_ID;
    rows[2][0].Theol_Cons_Lib = '101';
    expect(() => compileRows(rows, {})).toThrow(/between 0 and 100/);
  });
});
