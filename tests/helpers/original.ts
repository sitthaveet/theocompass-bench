import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const originalRoot = resolve('reference/theocompass');
const sourceRoot = resolve('data/source');
const silent = { log() {}, warn() {}, error() {}, info() {} };

/** Execute the original script unchanged except skipping its expensive export main(). */
export function originalData(): { data: any; profiles: any; families: any } {
  const file = join(originalRoot, 'scripts/build_precomputed.js');
  const originalFs = require('node:fs');
  const mapPath = (path: string): string => path.includes('/data/') ? join(sourceRoot, path.split('/data/')[1]) : path;
  const fs = { ...originalFs, mkdirSync() {},
    readFileSync(path: string, ...args: unknown[]) { return originalFs.readFileSync(mapPath(path), ...args); },
    existsSync(path: string) { return originalFs.existsSync(mapPath(path)); },
  };
  const context: Record<string, unknown> = { require(name: string) { return name === 'fs' ? fs : require(name); },
    __dirname: dirname(file), console: silent };
  const source = readFileSync(file, 'utf8').replace(/main\(\);\s*$/, '')
    + '\nconst profiles = buildProfiles(); globalThis.result = { data: theoData, profiles, families: buildFamilyProfiles(profiles, theoData.families) };';
  runInNewContext(source, context, { filename: file });
  return JSON.parse(JSON.stringify(context.result));
}

function loadOriginalWorker(): any {
  const cache = new Map<string, { exports: unknown }>();
  function load(file: string): any {
    if (cache.has(file)) return cache.get(file)!.exports;
    const module = { exports: {} };
    cache.set(file, module);
    const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
    } }).outputText;
    const wrapper = runInNewContext(`(function(require,module,exports){${source}\n})`, {
      console: silent, Request, Response, URL, performance, setTimeout, clearTimeout,
    }, { filename: file });
    wrapper((name: string) => {
      if (name === 'cloudflare:email') return { EmailMessage: class {} };
      if (name.startsWith('.')) return load(resolve(dirname(file), `${name}.ts`));
      return require(name);
    }, module, module.exports);
    return module.exports;
  }
  return load(join(originalRoot, 'theocompass-api/src/index.ts')).default;
}

export async function originalScore(original: ReturnType<typeof originalData>, answers: any[]): Promise<any> {
  const { data, profiles, families } = original;
  const optionRows = Object.entries(data.answerKey).flatMap(([qid, entries]) =>
    Object.entries(entries as Record<string, any>).map(([text, scores]) => {
      // The source matrix supplies stable IDs; the precompute maps by answer text.
      return { ...scores, question_id: qid, answertext: text };
    }));
  const matrixPath = join(sourceRoot, 'TheoCompass (v2.0) - Unified Answer Scoring Matrix.csv');
  const { parse } = require('csv-parse/sync');
  const matrix: any[] = parse(readFileSync(matrixPath), { columns: true, trim: true, skip_empty_lines: true, bom: true });
  const scoringRows = matrix.map(row => ({ ...optionRows.find(option => option.question_id === row.Question_ID && option.answertext === row.Answer), answer_id: row.Answer_ID }));
  const dimensionRows = Object.entries(data.hiddenDimensions).map(([question_id, dims]) => ({ question_id, ...(dims as object) }));
  const questionRows = data.questions.map((q: any) => ({ id: q.Question_ID, priority_score: Number(q.Priority_Score), category_code: q.Category_Code }));
  const prepare = (sql: string, ids: string[] = []): any => ({ sql,
    bind(...args: string[]) { return prepare(sql, args); },
    async first() { return { value: 'oracle' }; },
    async all() {
      let results: any[] = [];
      if (sql.includes('FROM answer_scoring')) results = scoringRows;
      else if (sql.includes('FROM hidden_dimensions')) results = dimensionRows;
      else if (sql.includes('FROM questions')) results = questionRows;
      else if (sql.includes('FROM answer_options')) results = matrix.filter(row => ids.includes(row.Answer_ID))
        .map(row => ({ id: row.Answer_ID, theological_label: row.Theological_Label, description: row.Full_Description }));
      return { results, meta: { rows_read: results.length } };
    },
  });
  const env = { DB: { prepare, async batch(statements: any[]) { return Promise.all(statements.map(statement => statement.all())); } },
    THEOCOMPASS_CACHE: { async get() { return { denominations: profiles, families }; } } };
  const worker = loadOriginalWorker();
  const response = await worker.fetch(new Request('http://oracle/api/calculate', { method: 'POST',
    body: JSON.stringify(Object.fromEntries(answers.map(answer => [answer.questionId, answer]))) }), env, {});
  const result = await response.json();
  if (response.status !== 200) throw new Error(JSON.stringify(result));
  return result;
}
