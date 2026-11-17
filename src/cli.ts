import { parseArgs } from 'node:util';

import { estimateFromHistory } from './analysis/cost.js';
import { reportRun, scoreRun } from './analysis/index.js';
import { modeQuestions, prepareDataset } from './dataset/index.js';
import { createRun, executeRun, prepareRun, resumeRun } from './runner/index.js';
import { errorMessage } from './util.js';

const HELP = `TheoCompass theology benchmark

npm run bench -- prepare
npm run bench -- run [--config PATH] [--models PATH] [--dry-run] [--smoke] [--fresh]
npm run bench -- resume RUN_DIRECTORY [--fresh]
npm run bench -- score RUN_DIRECTORY
npm run bench -- report RUN_DIRECTORY

run creates an auditable run and generates scores/reports automatically.
--dry-run validates locally and prints the request budget and a cost estimate without contacting providers.
--fresh sends every request even when an earlier run already holds the reply to an identical request.
Without it, such replies are copied (and marked as reused) instead of paid for again.
--smoke sends one question per model and never produces theological rankings.
Provider defaults are preserved; all settings and prompt snapshots are saved.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    config: { type: 'string' }, models: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, smoke: { type: 'boolean', default: false },
    fresh: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  const [command, directory] = positionals;
  if (!command || values.help) { console.log(HELP); return; }
  if (positionals.length > (['resume', 'score', 'report'].includes(command) ? 2 : 1)) throw new Error('Unexpected positional arguments');
  if (command !== 'run' && (values.config || values.models || values.smoke || values['dry-run'])) throw new Error('Run options apply only to the run command');
  if (values.fresh && !['run', 'resume'].includes(command)) throw new Error('--fresh applies only to run and resume');
  if (command === 'prepare') {
    const dataset = await prepareDataset();
    console.log(`Compiled ${dataset.questions.length} questions, ${dataset.denominations.length} denominations. Dataset ${dataset.hash}`);
    for (const mode of ['quick', 'standard', 'deep'] as const) {
      try { console.log(`${mode}: ${modeQuestions(dataset, mode).length} ready`); }
      catch (error) { console.log(errorMessage(error)); }
    }
    console.log(`Source diagnostics: ${dataset.diagnostics.length}; see data/compiled/dataset.json`);
    return;
  }
  if (command === 'run') {
    const prepared = await prepareRun({ experimentPath: values.config, modelsPath: values.models, smoke: values.smoke });
    console.log(JSON.stringify({ kind: prepared.manifest.kind, models: prepared.manifest.models.map(m => ({ id: m.id, model: m.model })),
      mode: prepared.manifest.experiment.mode, repetitions: prepared.manifest.experiment.repetitions,
      scheduledAnswers: prepared.manifest.scheduledAnswers, maximumRequests: prepared.manifest.requestLimit,
      maxOutputTokensPerRequest: prepared.manifest.experiment.maxOutputTokens, maxUSD: prepared.manifest.experiment.maxUSD ?? null,
      fingerprint: prepared.manifest.fingerprint }, null, 2));
    const perModel = prepared.manifest.scheduledAnswers / prepared.manifest.models.length;
    const estimates = await estimateFromHistory(prepared.manifest.models, perModel);
    console.log('Cost estimate from tokens measured in earlier runs (uncached input, no retries, before reuse):');
    for (const item of estimates) {
      const tokens = item.samples ? `~${Math.round(item.meanInputTokens!)} in / ~${Math.round(item.meanOutputTokens!)} out per request (${item.samples} measured)` : 'no measured usage yet; run --smoke first';
      console.log(`  ${item.modelId}: ${item.scheduledAnswers} requests, ${tokens}, ${item.estimatedUSD === null ? (item.samples ? 'no price set' : 'unknown cost') : `~$${item.estimatedUSD.toFixed(4)}`}`);
    }
    const known = estimates.filter(item => item.estimatedUSD !== null);
    if (known.length) console.log(`  total for priced models: ~$${known.reduce((sum, item) => sum + item.estimatedUSD!, 0).toFixed(4)}`);
    if (values['dry-run']) return;
    const path = await createRun(prepared);
    console.log(`Run directory: ${path}`);
    const manifest = await executeRun(path, prepared, { reuse: !values.fresh });
    await reportRun(path);
    console.log(`${manifest.status}: ${path}/report.md`);
    if (manifest.status !== 'complete') process.exitCode = 2;
    return;
  }
  if (['resume', 'score', 'report'].includes(command) && !directory) throw new Error(`${command} requires a run directory`);
  if (command === 'resume') {
    const prepared = await resumeRun(directory);
    const manifest = await executeRun(directory, prepared, { reuse: !values.fresh });
    await reportRun(directory);
    console.log(`${manifest.status}: ${directory}/report.md`);
    if (manifest.status !== 'complete') process.exitCode = 2;
  } else if (command === 'score') {
    await scoreRun(directory);
    console.log(`${directory}/scores.json`);
  } else if (command === 'report') {
    await reportRun(directory);
    console.log(`${directory}/report.md`);
  } else throw new Error(`Unknown command: ${command}\n${HELP}`);
}

main().catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
