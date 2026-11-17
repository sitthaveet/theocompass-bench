import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';

import { AXES, type Axis, type Dataset, type Denomination, type Dimensions, type Doctrine, type Mode, type Question } from '../types.js';
import { canonical, hash, writeJson } from '../util.js';

export const SOURCE_SUFFIXES = [
  'QUESTION_MASTER.csv', 'Hidden Dimensions.csv', 'Unified Answer Scoring Matrix.csv',
  'Denominations & Doctrines_EXPORT.tsv', 'QUIZ_SEQUENCE.csv', 'FAMILIES.csv',
] as const;

export const SOURCE_AXES: Record<Axis, string> = Object.fromEntries(AXES.map((axis, i) => [axis, [
  'Theol_Cons_Lib', 'Social_Cons_Lib', 'Counter_Pro_Modern', 'Super_Nat',
  'Cult_Sep_Eng', 'Cleric_Egal', 'Div_Hum_Agency', 'Commun_Indiv',
  'Liturg_Spont', 'Sacram_Funct', 'Literal_Crit', 'Intellect_Exper',
][i]])) as Record<Axis, string>;
const HIDDEN_AXES = [
  'Theol_Cons_Lib', 'Social_Cons_Lib', 'Counter_Pro_Modernity', 'Supernatural_Natural',
  'Cultural_Sep_Eng', 'Clerical_Egal', 'Divine_Human_Agency', 'Communal_Individual',
  'Liturgical_Spontaneous', 'Sacramental_Functional', 'Literal_Critical', 'Intellectual_Experiential',
];
type Row = Record<string, string>;

function unique(rows: Row[], column: string, label: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row[column];
    if (!id || seen.has(id)) throw new Error(`${label}: missing or duplicate ${column}: ${id}`);
    seen.add(id);
  }
}

function number(value: string | undefined, label: string, max: number): number {
  const parsed = Number(value);
  if (value === undefined || value.trim() === '' || !Number.isFinite(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`${label}: expected a number between 0 and ${max}, got ${value}`);
  }
  return parsed;
}

export function compileRows(tables: Row[][], sourceHashes: Record<string, string>): Dataset {
  const [master, hidden, matrix, doctrines, sequences, families] = tables;
  unique(master, 'Question_ID', 'questions');
  unique(hidden, 'Question_ID', 'dimensions');
  unique(matrix, 'Answer_ID', 'options');
  unique(doctrines, 'Denomination_ID', 'denominations');
  unique(sequences, 'Question_ID', 'sequences');
  unique(families, 'Family_Name', 'families');
  const questions: Question[] = master.map(row => {
    if (!row.Full_Question) throw new Error(`${row.Question_ID}: missing question text`);
    return { id: row.Question_ID, category: row.Category_Code, text: row.Full_Question,
      priority: number(row.Priority_Score, row.Question_ID, 10), dimensions: null, options: [] };
  });
  const questionMap = new Map(questions.map(q => [q.id, q]));
  for (const row of hidden) {
    const q = questionMap.get(row.Question_ID);
    if (!q) throw new Error(`Unknown dimension question ${row.Question_ID}`);
    q.dimensions = Object.fromEntries(AXES.map((axis, i) => [axis,
      number(row[HIDDEN_AXES[i]], `${q.id}/${axis}`, 100)])) as Dimensions<number>;
  }
  for (const row of matrix) {
    const q = questionMap.get(row.Question_ID);
    if (!q || !row.Answer) throw new Error(`Invalid option ${row.Answer_ID}`);
    if (q.options.some(option => option.text === row.Answer)) throw new Error(`Duplicate option text in ${q.id}`);
    q.options.push({ id: row.Answer_ID, text: row.Answer, description: row.Full_Description || '',
      label: row.Theological_Label || '', scores: Object.fromEntries(AXES.map(axis => [axis,
        row[SOURCE_AXES[axis]] === 'N/A' ? null : number(row[SOURCE_AXES[axis]], `${row.Answer_ID}/${axis}`, 100),
      ])) as Dimensions<number | null> });
  }
  const diagnostics: string[] = [];
  const modes = {} as Dataset['modes'];
  for (const mode of ['quick', 'standard', 'deep'] as const) {
    const title = mode[0].toUpperCase() + mode.slice(1);
    for (const row of sequences) {
      if (!questionMap.has(row.Question_ID)) throw new Error(`Unknown sequence question ${row.Question_ID}`);
      if (!['TRUE', 'FALSE'].includes(row[`Include_${title}`])) throw new Error(`Invalid ${mode} inclusion flag`);
    }
    const included = sequences.filter(row => row[`Include_${title}`] === 'TRUE');
    const orders = included.map(row => number(row[`Display_Order_${title}`], `${mode}/${row.Question_ID} order`, 10000));
    if (new Set(orders).size !== orders.length) diagnostics.push(`${mode}: duplicate display orders retain source row order`);
    modes[mode] = included.sort((a, b) => Number(a[`Display_Order_${title}`]) - Number(b[`Display_Order_${title}`]))
      .map(row => row.Question_ID);
  }
  const denominations: Denomination[] = doctrines.map(row => {
    const perQuestion: Record<string, Doctrine> = {};
    for (const q of questions) {
      let remaining = row[`${q.id}_Answer`] || '';
      // Preserve the original precompute's longest-exact-phrase matching and fallbacks.
      const selected = q.options.slice().sort((a, b) => b.text.length - a.text.length).filter(option => {
        if (!remaining.includes(option.text)) return false;
        remaining = remaining.replace(option.text, '');
        return true;
      });
      if (q.options.length && row[`${q.id}_Answer`] && !selected.length) {
        diagnostics.push(`${row.Denomination_ID}/${q.id}: unmatched doctrine treated as apathetic by original precompute`);
      }
      const C = ({ Certain: 3, 'Pretty Sure': 2, Leaning: 1, 'Not Sure': 0 } as Record<string, number>)[row[`${q.id}_Certainty`]] ?? 1;
      const T = ({ 'Salvation issue': 0, Opposed: 1, Discerning: 2, Charitable: 3, 'Extremely Accepting': 4 } as Record<string, number>)[row[`${q.id}_Tolerance`]] ?? 2;
      perQuestion[q.id] = {
        answered: selected.length > 0, C: selected.length ? Number(C) : 0, T: selected.length ? T : 2,
        posture: selected.length ? 'affirmed' : 'apathetic', splitCount: selected.length,
        dimensions: Object.fromEntries(AXES.filter(axis => q.dimensions && q.dimensions[axis] > 50)
          .map(axis => [axis, { values: selected.map(option => option.scores[axis]).filter(value => value !== null) }])),
      };
    }
    return { id: row.Denomination_ID, name: row.Denomination_Name || row.Name || '', family: row.Denomination_Family,
      description: row.Description || '', founded: row.Founded_Year || '', region: row.Region_Origin || '', perQuestion };
  });
  const content = { schemaVersion: 1 as const, sourceHashes, questions, modes, denominations, families, diagnostics };
  return { ...content, hash: hash(canonical(content)) };
}

export async function compileDataset(sourceDir = 'data/source'): Promise<Dataset> {
  const names = await readdir(sourceDir);
  const sourceHashes: Record<string, string> = {};
  const tables: Row[][] = [];
  for (const suffix of SOURCE_SUFFIXES) {
    const matches = names.filter(name => name.endsWith(suffix));
    if (matches.length !== 1) throw new Error(`Expected one source file ending with ${suffix}`);
    const filename = matches[0];
    const raw = await readFile(join(sourceDir, filename));
    sourceHashes[filename] = hash(raw);
    tables.push(parse(raw, { bom: true, columns: true, skip_empty_lines: true, trim: true,
      delimiter: suffix.endsWith('.tsv') ? '\t' : ',', quote: suffix.endsWith('.tsv') ? false : '"' }) as Row[]);
  }
  return compileRows(tables, sourceHashes);
}

export function modeQuestions(dataset: Dataset, mode: Mode): Question[] {
  const ids = dataset.modes[mode];
  const questions = ids.map(id => dataset.questions.find(q => q.id === id));
  const missing = ids.filter((_, i) => !questions[i]?.options.length || !questions[i]?.dimensions
    || !Object.values(questions[i]!.dimensions!).some(value => value >= 50));
  if (!ids.length || missing.length) throw new Error(`${mode} questionnaire is incomplete. Missing options/dimensions: ${missing.join(', ')}`);
  return questions as Question[];
}

export function verifyDataset(dataset: Dataset): void {
  const { hash: expected, ...content } = dataset;
  if (dataset.schemaVersion !== 1 || expected !== hash(canonical(content))) throw new Error('Dataset snapshot hash mismatch');
}

export async function prepareDataset(): Promise<Dataset> {
  const dataset = await compileDataset();
  await writeJson('data/compiled/dataset.json', dataset);
  return dataset;
}
