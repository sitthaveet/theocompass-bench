import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { usageCost } from '../analysis/cost.js';
import { loadConfiguration, requireKeys } from '../config.js';
import { compileDataset, modeQuestions } from '../dataset/index.js';
import { orderedOptions, parseAnswer, PROTOCOL_INSTRUCTIONS, PROTOCOL_VERSION, questionPrompt } from '../prompts/index.js';
import { adapters, prepareRequest, sendRequest, type Exchange } from '../providers/index.js';
import type { ProviderInput } from '../providers/types.js';
import { SCORING_VERSION } from '../scoring/index.js';
import type { Dataset, Question } from '../types.js';
import { canonical, errorMessage, hash, readJson, writeJson } from '../util.js';
import { acquireLock, gitCommit, openJournal, requestKey, reusableExchanges, sourceCodeHash, terminalAnswers, writeAnswers } from './store.js';
import type { Manifest, Outcome, Task } from './types.js';

export interface PreparedRun {
  manifest: Manifest;
  dataset: Dataset;
  soul: string;
}

/**
 * Identity of a run's requests and scoring. Prices and the dollar budget only govern when to stop,
 * so they are left out: correcting a price or raising the budget must not strand a paid run.
 */
function fingerprint(manifest: Omit<Manifest, 'fingerprint'>): string {
  const { maxUSD: _budget, ...experiment } = manifest.experiment;
  const models = manifest.models.map(({ pricing: _pricing, ...model }) => model);
  return hash(canonical({ experiment, models, kind: manifest.kind,
    datasetHash: manifest.datasetHash, soulHash: manifest.soulHash, codeHash: manifest.codeHash,
    scorerHash: manifest.scorerHash, requestLimit: manifest.requestLimit, scheduledAnswers: manifest.scheduledAnswers,
    protocolVersion: manifest.protocolVersion, scoringVersion: manifest.scoringVersion, questionIds: manifest.questionIds }));
}

export async function prepareRun(options: { experimentPath?: string; modelsPath?: string; smoke?: boolean } = {}): Promise<PreparedRun> {
  const experimentPath = options.experimentPath || 'configs/experiments/quick.yaml';
  const modelsPath = options.modelsPath || 'configs/models.yaml';
  const configuration = await loadConfiguration(experimentPath, modelsPath);
  const dataset = await compileDataset();
  const questions = modeQuestions(dataset, configuration.experiment.mode);
  const experiment = { ...configuration.experiment };
  if (options.smoke) experiment.repetitions = 1;
  const questionIds = (options.smoke ? questions.slice(0, 1) : questions).map(q => q.id);
  const scheduledAnswers = questionIds.length * experiment.repetitions * configuration.models.length;
  if (experiment.maxRequests < scheduledAnswers) throw new Error('maxRequests is smaller than the scheduled answer count');
  const now = new Date().toISOString();
  const partial: Omit<Manifest, 'fingerprint'> = {
    schemaVersion: 1, id: `${now.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`, kind: options.smoke ? 'smoke' : 'pilot',
    createdAt: now, updatedAt: now, status: 'created', experimentPath, modelsPath, experiment,
    models: configuration.models, questionIds, scheduledAnswers,
    requestLimit: Math.min(experiment.maxRequests, scheduledAnswers * experiment.maxAttempts),
    datasetHash: dataset.hash, soulHash: hash(configuration.soul), codeHash: await sourceCodeHash(),
    scorerHash: hash(await readFile('src/scoring/index.ts')), protocolVersion: PROTOCOL_VERSION,
    scoringVersion: SCORING_VERSION, gitCommit: gitCommit(), nodeVersion: process.version,
  };
  return { manifest: { ...partial, fingerprint: fingerprint(partial) }, dataset, soul: configuration.soul };
}

export async function createRun(prepared: PreparedRun, resultsRoot = 'results'): Promise<string> {
  requireKeys(prepared.manifest.models);
  const directory = join(resultsRoot, prepared.manifest.id);
  await mkdir(directory, { recursive: false, mode: 0o700 }).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(resultsRoot, { recursive: true });
    await mkdir(directory, { mode: 0o700 });
  });
  await writeJson(join(directory, 'dataset.json'), prepared.dataset);
  await writeFile(join(directory, 'SOUL.md'), prepared.soul, { mode: 0o600 });
  await writeJson(join(directory, 'manifest.json'), prepared.manifest);
  return directory;
}

export async function resumeRun(directory: string): Promise<PreparedRun> {
  const manifest = await readJson<Manifest>(join(directory, 'manifest.json'));
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported run schema');
  const current = await prepareRun({ experimentPath: manifest.experimentPath, modelsPath: manifest.modelsPath, smoke: manifest.kind === 'smoke' });
  if (manifest.fingerprint !== fingerprint(manifest) || manifest.fingerprint !== current.manifest.fingerprint) {
    throw new Error('Cannot resume: configuration, SOUL, source code, or dataset hash changed. Start a new run.');
  }
  // Take the current prices and budget, so a stopped run can be resumed with a raised budget.
  manifest.experiment.maxUSD = current.manifest.experiment.maxUSD;
  manifest.models = manifest.models.map(model => ({ ...model, pricing: current.manifest.models.find(item => item.id === model.id)?.pricing }));
  const dataset = await readJson<Dataset>(join(directory, 'dataset.json'));
  const soul = await readFile(join(directory, 'SOUL.md'), 'utf8');
  if (hash(canonical(dataset)) !== hash(canonical(current.dataset)) || hash(soul) !== manifest.soulHash) {
    throw new Error('Run snapshot hash mismatch');
  }
  requireKeys(manifest.models);
  return { manifest, dataset, soul };
}

export function buildTasks(manifest: Manifest): Task[] {
  return manifest.models.flatMap(model => Array.from({ length: manifest.experiment.repetitions }, (_, repetition) =>
    manifest.questionIds.map(questionId => ({ key: `${model.id}/${repetition + 1}/${questionId}`, modelId: model.id,
      repetition: repetition + 1, questionId })))).flat();
}

function outcomeFor(exchange: Exchange, question: Question, options: Question['options']): Outcome {
  if (exchange.error || !exchange.result) return { status: exchange.httpStatus && exchange.httpStatus < 300 ? 'invalid_response' : 'api_error', detail: exchange.error || 'No response' };
  if (exchange.result.refusal) return { status: 'refusal', detail: 'Provider signaled refusal' };
  if (exchange.result.truncated) return { status: 'truncated', detail: 'Provider did not complete the response' };
  try {
    const answer = parseAnswer(exchange.result.text, question, options);
    return { status: answer.status, answer };
  } catch (error) {
    return { status: 'invalid_response', detail: errorMessage(error).slice(0, 1200) };
  }
}

/** Re-decode a stored reply with the current adapter, so a decoder fix applies to reused replies too. */
function redecode(input: ProviderInput, exchange: Exchange): Exchange | null {
  try { return { ...exchange, result: adapters[input.model.provider].decode(JSON.parse(exchange.rawBody)), error: undefined, retryable: false }; }
  catch { return null; }
}

export interface RunDependencies {
  /** Copy replies to identical requests from earlier runs instead of paying for them again (default true). */
  reuse?: boolean;
  send?: (input: ProviderInput, request: ReturnType<typeof prepareRequest>) => Promise<Exchange>;
  sleep?: (milliseconds: number) => Promise<void>;
  progress?: (line: string) => void;
}

export async function executeRun(directory: string, prepared: PreparedRun, dependencies: RunDependencies = {}): Promise<Manifest> {
  const release = await acquireLock(directory);
  const { manifest, dataset, soul } = prepared;
  const secrets = manifest.models.map(model => process.env[model.apiKeyEnv] || '').filter(Boolean);
  const journal = await openJournal(directory, secrets).catch(async error => { await release(); throw error; });
  const send = dependencies.send || sendRequest;
  const sleep = dependencies.sleep || delay;
  const progress = dependencies.progress || console.log;
  try {
    const tasks = buildTasks(manifest);
    const terminal = terminalAnswers(journal.events);
    const attempts = new Map<string, number>();
    for (const event of journal.events) if (event.type === 'attempt_started') attempts.set(event.task.key, event.attempt);
    let requestCount = journal.events.filter(event => event.type === 'attempt_started').length;
    let done = terminal.size;
    manifest.status = 'running';
    manifest.updatedAt = new Date().toISOString();
    await writeJson(join(directory, 'manifest.json'), manifest);
    const reusable = dependencies.reuse === false ? new Map() : await reusableExchanges(dirname(directory), basename(directory));
    const pricing = new Map(manifest.models.map(model => [model.id, model.pricing]));
    const costOf = (modelId: string, exchange: Exchange) => {
      const rates = pricing.get(modelId);
      return rates ? usageCost(exchange.result?.usage, rates) || 0 : 0;
    };
    let spentUSD = journal.events.reduce((sum, event) => event.type === 'attempt_finished' && !event.reusedFrom
      ? sum + costOf(event.task.modelId, event.exchange) : sum, 0);
    const budget = manifest.experiment.maxUSD;
    let budgetReported = false;
    const overBudget = () => {
      if (budget === undefined || spentUSD < budget) return false;
      if (!budgetReported) progress(`Budget reached: $${spentUSD.toFixed(4)} of $${budget}. Raise maxUSD and resume to continue.`);
      budgetReported = true;
      return true;
    };
    const providers = [...new Set(manifest.models.map(model => model.provider))];
    const workers: Promise<void>[] = [];
    for (const provider of providers) {
      const modelIds = new Set(manifest.models.filter(model => model.provider === provider).map(model => model.id));
      const pending = tasks.filter(task => modelIds.has(task.modelId) && !terminal.has(task.key));
      let cursor = 0;
      const blockedModels = new Set<string>();
      async function worker(): Promise<void> {
        while (cursor < pending.length) {
          const task = pending[cursor++];
          if (blockedModels.has(task.modelId)) continue;
          const model = manifest.models.find(item => item.id === task.modelId)!;
          const question = dataset.questions.find(item => item.id === task.questionId)!;
          const options = orderedOptions(question, manifest.experiment, task.repetition);
          const input: ProviderInput = { model, system: soul, preamble: PROTOCOL_INSTRUCTIONS, prompt: questionPrompt(question, options),
            maxOutputTokens: manifest.experiment.maxOutputTokens, timeoutMs: manifest.experiment.timeoutMs };
          const request = prepareRequest(input);
          const previousAttempts = attempts.get(task.key) || 0;
          const earlier = previousAttempts ? undefined : reusable.get(requestKey(request, task.repetition));
          const copied = earlier && redecode(input, earlier.exchange);
          if (earlier && copied) {
            const outcome = outcomeFor(copied, question, options);
            await journal.append({ type: 'attempt_finished', at: new Date().toISOString(), task, attempt: 0, durationMs: 0,
              exchange: copied, outcome, terminal: true, reusedFrom: { runId: earlier.runId, attempt: earlier.attempt } });
            done++;
            progress(`${done}/${manifest.scheduledAnswers} ${task.key}: ${outcome.status} (reused from ${earlier.runId})`);
            continue;
          }
          // A crash after the final start record has an unknown result, never a manufactured stance.
          if (previousAttempts >= manifest.experiment.maxAttempts) {
            await journal.append({ type: 'attempt_finished', at: new Date().toISOString(), task, attempt: previousAttempts,
              durationMs: 0, exchange: { httpStatus: null, headers: {}, rawBody: '', error: 'Attempt budget exhausted before a durable terminal result', retryable: false },
              outcome: { status: 'api_error', detail: 'Interrupted request exhausted the attempt budget' }, terminal: true });
            done++;
            continue;
          }
          for (let attempt = previousAttempts + 1; attempt <= manifest.experiment.maxAttempts; attempt++) {
            if (requestCount >= manifest.requestLimit || overBudget()) return;
            requestCount++;
            attempts.set(task.key, attempt);
            await journal.append({ type: 'attempt_started', at: new Date().toISOString(), task, attempt, request,
              optionOrder: options.map(option => option.id) });
            const start = Date.now();
            const exchange = await send(input, request);
            const outcome = outcomeFor(exchange, question, options);
            spentUSD += costOf(task.modelId, exchange);
            const retry = exchange.retryable && attempt < manifest.experiment.maxAttempts;
            await journal.append({ type: 'attempt_finished', at: new Date().toISOString(), task, attempt,
              durationMs: Date.now() - start, exchange, outcome, terminal: !retry });
            if (!retry) {
              done++;
              progress(`${done}/${manifest.scheduledAnswers} ${task.key}: ${outcome.status}${exchange.error ? ` (${exchange.error})` : ''}`);
              if ([400, 401, 403, 404].includes(exchange.httpStatus || 0)) blockedModels.add(task.modelId);
              break;
            }
            progress(`${task.key}: transient failure; retry ${attempt + 1}/${manifest.experiment.maxAttempts}`);
            await sleep(Math.max(exchange.retryAfterMs || 0, 1000 * 2 ** (attempt - 1)));
          }
        }
      }
      for (let i = 0; i < manifest.experiment.concurrencyPerProvider; i++) workers.push(worker());
    }
    const results = await Promise.allSettled(workers);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const records = [...terminalAnswers(journal.events).values()];
    const usable = records.filter(record => ['answered', 'apathetic', 'hostile'].includes(record.outcome.status));
    manifest.status = usable.length === tasks.length ? 'complete' : 'incomplete';
    manifest.updatedAt = new Date().toISOString();
    await writeAnswers(directory, journal.events);
    await writeJson(join(directory, 'manifest.json'), manifest);
    return manifest;
  } finally {
    try { await journal.close(); }
    finally { await release(); }
  }
}
