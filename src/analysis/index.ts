import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { modeQuestions, verifyDataset } from '../dataset/index.js';
import { toScoringAnswer } from '../prompts/index.js';
import { SCORING_VERSION, scoreAnswers } from '../scoring/index.js';
import { readEvents, terminalAnswers, writeAnswers } from '../runner/store.js';
import type { AnswerRecord, Manifest } from '../runner/types.js';
import { AXES, type Dataset, type Score, type UserResponse } from '../types.js';
import { hash, readJson, writeJson } from '../util.js';
import { usageCost } from './cost.js';

export interface RepetitionResult {
  modelId: string;
  repetition: number;
  usable: number;
  expected: number;
  outcomes: Record<string, number>;
  score: Score | null;
}
export interface Statistics { n: number; mean: number | null; sd: number | null }
export interface Aggregate {
  modelId: string;
  completeRepetitions: number;
  denominations: { id: string; name: string; family: string; stats: Statistics }[];
  families: { family: string; stats: Statistics }[];
  axes: Record<string, Statistics>;
}
export interface ScoreArtifact {
  runId: string;
  kind: Manifest['kind'];
  datasetHash: string;
  scoringVersion: string;
  repetitions: RepetitionResult[];
  aggregates: Aggregate[];
}

export function statistics(values: number[]): Statistics {
  if (!values.length) return { n: 0, mean: null, sd: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : null;
  return { n: values.length, mean: Number(mean.toFixed(4)), sd: variance === null ? null : Number(Math.sqrt(variance).toFixed(4)) };
}

export function calculateScores(manifest: Manifest, dataset: Dataset, records: AnswerRecord[]): ScoreArtifact {
  const fullQuestions = modeQuestions(dataset, manifest.experiment.mode);
  const repetitions: RepetitionResult[] = [];
  for (const model of manifest.models) {
    for (let repetition = 1; repetition <= manifest.experiment.repetitions; repetition++) {
      const found = records.filter(record => record.modelId === model.id && record.repetition === repetition);
      const outcomes: Record<string, number> = { pending: manifest.questionIds.length - found.length };
      const answers: UserResponse[] = [];
      for (const record of found) {
        outcomes[record.outcome.status] = (outcomes[record.outcome.status] || 0) + 1;
        if (!record.outcome.answer) continue;
        const answer = toScoringAnswer(record.questionId, record.outcome.answer);
        if (answer) answers.push(answer);
      }
      const complete = manifest.kind === 'pilot' && fullQuestions.length === answers.length
        && fullQuestions.every(question => answers.some(answer => answer.questionId === question.id));
      repetitions.push({ modelId: model.id, repetition, usable: answers.length, expected: manifest.questionIds.length,
        outcomes, score: complete ? scoreAnswers(dataset, answers) : null });
    }
  }
  const aggregates = manifest.models.map(model => {
    const scores = repetitions.filter(item => item.modelId === model.id && item.score).map(item => item.score!);
    return { modelId: model.id, completeRepetitions: scores.length,
      denominations: dataset.denominations.map(denom => ({ id: denom.id, name: denom.name, family: denom.family,
        stats: statistics(scores.map(score => score.matches.find(match => match.id === denom.id)!.matchPercentage)),
      })).sort((a, b) => (b.stats.mean ?? -1) - (a.stats.mean ?? -1)),
      families: [...new Set(dataset.denominations.map(denom => denom.family))].filter(family => family && family !== 'Unknown')
        .map(family => ({ family, stats: statistics(scores.map(score => score.familyMatches.find(match => match.family === family)!.matchPercentage)) }))
        .sort((a, b) => (b.stats.mean ?? -1) - (a.stats.mean ?? -1)),
      axes: Object.fromEntries([...AXES, 'tolerance', 'certainty'].map(axis => [axis,
        statistics(scores.map(score => score.axes[axis as keyof Score['axes']])),
      ])),
    };
  });
  return { runId: manifest.id, kind: manifest.kind, datasetHash: dataset.hash, scoringVersion: SCORING_VERSION, repetitions, aggregates };
}

export async function scoreRun(directory: string): Promise<ScoreArtifact> {
  const manifest = await readJson<Manifest>(join(directory, 'manifest.json'));
  const dataset = await readJson<Dataset>(join(directory, 'dataset.json'));
  verifyDataset(dataset);
  if (dataset.hash !== manifest.datasetHash) throw new Error('Manifest and dataset snapshot disagree');
  if (manifest.scoringVersion !== SCORING_VERSION || manifest.scorerHash !== hash(await readFile('src/scoring/index.ts'))) {
    throw new Error('Scoring implementation changed; use the recorded scorer version to reproduce this run');
  }
  const { events } = await readEvents(directory);
  const scores = calculateScores(manifest, dataset, [...terminalAnswers(events).values()]);
  await writeAnswers(directory, events);
  await writeJson(join(directory, 'scores.json'), scores);
  return scores;
}

function csv(rows: unknown[][]): string {
  return rows.map(row => row.map(value => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',')).join('\n') + '\n';
}
const md = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
const percent = (part: number, whole: number): string => whole ? `${(100 * part / whole).toFixed(1)}%` : '—';
/** Above this share of scheduled answers, silence rather than chosen positions dominates a model's matches. */
export const SILENCE_WARNING_SHARE = 0.25;

export interface ResponseProfile {
  modelId: string;
  scheduled: number;
  answered: number;
  apathetic: number;
  hostile: number;
  refusal: number;
  failed: number;
  pending: number;
  /** Questions where every repetition produced a usable outcome. */
  stableDenominator: number;
  /** Of those, questions where every repetition gave the same option or the same silence type. */
  stable: number;
}

export function responseProfiles(manifest: Manifest, records: AnswerRecord[]): ResponseProfile[] {
  return manifest.models.map(model => {
    const own = records.filter(record => record.modelId === model.id);
    const count = (...statuses: string[]) => own.filter(record => statuses.includes(record.outcome.status)).length;
    let stable = 0;
    let stableDenominator = 0;
    for (const questionId of manifest.questionIds) {
      const values = own.filter(record => record.questionId === questionId && record.outcome.answer)
        .map(record => record.outcome.answer!.answerId ?? record.outcome.answer!.status);
      if (values.length !== manifest.experiment.repetitions) continue;
      stableDenominator++;
      if (new Set(values).size === 1) stable++;
    }
    const scheduled = manifest.questionIds.length * manifest.experiment.repetitions;
    return { modelId: model.id, scheduled, answered: count('answered'), apathetic: count('apathetic'), hostile: count('hostile'),
      refusal: count('refusal'), failed: count('invalid_response', 'truncated', 'api_error'), pending: scheduled - own.length,
      stableDenominator, stable };
  });
}
function display(stats: Statistics): string {
  if (stats.mean === null) return '—';
  return `${stats.mean.toFixed(2)}${stats.sd === null ? '' : ` ± ${stats.sd.toFixed(2)}`}`;
}

export async function reportRun(directory: string): Promise<ScoreArtifact> {
  const scores = await scoreRun(directory);
  const manifest = await readJson<Manifest>(join(directory, 'manifest.json'));
  const { events } = await readEvents(directory);
  const records = [...terminalAnswers(events).values()];
  const finished = events.filter(event => event.type === 'attempt_finished');
  const started = events.filter(event => event.type === 'attempt_started');
  const usage = manifest.models.map(model => {
    const own = finished.filter(event => event.task.modelId === model.id);
    const paid = own.filter(event => !event.reusedFrom);
    const reused = own.filter(event => event.reusedFrom);
    const requestsSent = started.filter(event => event.task.modelId === model.id).length;
    const known = paid.filter(event => event.exchange.result?.usage.inputTokens != null && event.exchange.result?.usage.outputTokens != null);
    const total = (field: 'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens') =>
      known.reduce((sum, event) => sum + (event.exchange.result!.usage[field] || 0), 0);
    const cost = (events: typeof own) => model.pricing
      ? events.reduce((sum, event) => sum + (usageCost(event.exchange.result?.usage, model.pricing!) || 0), 0) : null;
    return { modelId: model.id, model: model.model, requestsSent, answersReused: reused.length,
      requestsWithUnknownUsage: requestsSent - known.length,
      inputTokens: total('inputTokens'), cachedInputTokens: total('cachedInputTokens'), cacheWriteInputTokens: total('cacheWriteInputTokens'),
      outputTokens: total('outputTokens'), reasoningTokens: total('reasoningTokens'),
      pricing: model.pricing || null, costUSD: cost(paid), reuseSavedUSD: cost(reused) };
  });
  const priced = usage.filter(item => item.costUSD !== null);
  const sum = (field: 'requestsSent' | 'answersReused' | 'inputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens' | 'outputTokens' | 'reasoningTokens') =>
    usage.reduce((total, item) => total + item[field], 0);
  const totals = { requestsSent: sum('requestsSent'), answersReused: sum('answersReused'), inputTokens: sum('inputTokens'),
    cachedInputTokens: sum('cachedInputTokens'), cacheWriteInputTokens: sum('cacheWriteInputTokens'),
    outputTokens: sum('outputTokens'), reasoningTokens: sum('reasoningTokens'),
    costUSD: priced.reduce((total, item) => total + item.costUSD!, 0), reuseSavedUSD: priced.reduce((total, item) => total + (item.reuseSavedUSD || 0), 0),
    unpricedModels: usage.filter(item => item.costUSD === null).map(item => item.modelId) };
  await writeJson(join(directory, 'usage.json'), {
    note: 'Tokens and cost of requests this run sent and paid for. Answers reused from earlier runs cost nothing here; reuseSavedUSD is what they would have cost. inputTokens includes cached and cache-write tokens. outputTokens includes reasoning tokens. Costs use the configured dated prices (cache rates when configured) and exclude requests with unknown usage; they are estimates, not invoices. costUSD totals priced models only.',
    budgetUSD: manifest.experiment.maxUSD ?? null, totals, models: usage });
  const rankingRows: unknown[][] = [['model', 'kind', 'rank', 'id', 'name', 'family', 'n', 'mean', 'sample_sd']];
  const axisRows: unknown[][] = [['model', 'axis', 'n', 'mean', 'sample_sd']];
  for (const aggregate of scores.aggregates) {
    if (!aggregate.completeRepetitions) continue;
    aggregate.denominations.forEach((item, i) => rankingRows.push([aggregate.modelId, 'denomination', i + 1, item.id, item.name, item.family, item.stats.n, item.stats.mean, item.stats.sd]));
    aggregate.families.forEach((item, i) => rankingRows.push([aggregate.modelId, 'family', i + 1, '', item.family, item.family, item.stats.n, item.stats.mean, item.stats.sd]));
    for (const [axis, stats] of Object.entries(aggregate.axes)) axisRows.push([aggregate.modelId, axis, stats.n, stats.mean, stats.sd]);
  }
  const frequencyRows: unknown[][] = [['model', 'question', 'outcome_or_answer_id', 'count', 'scheduled_repetitions']];
  for (const model of manifest.models) for (const questionId of manifest.questionIds) {
    const counts = new Map<string, number>();
    for (let repetition = 1; repetition <= manifest.experiment.repetitions; repetition++) {
      const record = records.find(item => item.modelId === model.id && item.questionId === questionId && item.repetition === repetition);
      const value = record?.outcome.answer?.status === 'answered' ? record.outcome.answer.answerId! : record?.outcome.status || 'pending';
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    for (const [value, count] of counts) frequencyRows.push([model.id, questionId, value, count, manifest.experiment.repetitions]);
  }
  const coverageRows: unknown[][] = [['model', 'repetition', 'usable', 'expected', 'scored', 'answered', 'apathetic', 'hostile', 'refusal', 'invalid_response', 'truncated', 'api_error', 'pending']];
  for (const item of scores.repetitions) coverageRows.push([item.modelId, item.repetition, item.usable, item.expected, !!item.score,
    ...['answered', 'apathetic', 'hostile', 'refusal', 'invalid_response', 'truncated', 'api_error', 'pending'].map(status => item.outcomes[status] || 0)]);
  const profiles = responseProfiles(manifest, records);
  const profileRows: unknown[][] = [['model', 'scheduled', 'answered', 'apathetic', 'hostile', 'refusal', 'failed', 'pending', 'stable_questions', 'stable_denominator'],
    ...profiles.map(p => [p.modelId, p.scheduled, p.answered, p.apathetic, p.hostile, p.refusal, p.failed, p.pending, p.stable, p.stableDenominator])];
  await Promise.all([
    writeFile(join(directory, 'rankings.csv'), csv(rankingRows)), writeFile(join(directory, 'axes.csv'), csv(axisRows)),
    writeFile(join(directory, 'answer-frequencies.csv'), csv(frequencyRows)), writeFile(join(directory, 'coverage.csv'), csv(coverageRows)),
    writeFile(join(directory, 'response-profile.csv'), csv(profileRows)),
  ]);

  const lines = [`# Theology benchmark: ${manifest.id}`, '',
    `Kind: **${manifest.kind}**. Questionnaire: **${manifest.experiment.mode}**. Prompt: **SOUL only**.`, '',
    `Scheduled answers: ${manifest.scheduledAnswers}. Requests started: ${started.length}. Terminal outcomes: ${records.length}.`, '',
    'These scores describe expressed alignment within TheoCompass’s framework. They do not establish personal beliefs or prove absence of bias.', '',
    `Generation: provider-default reasoning/sampling; output cap ${manifest.experiment.maxOutputTokens} tokens. Option order: ${manifest.experiment.shuffleOptions ? `seeded (${manifest.experiment.seed})` : 'fixed'}.`, '',
    '## Coverage', '', '| Model | API model | Usable / scheduled | Complete repetitions |', '|---|---|---:|---:|'];
  for (const model of manifest.models) {
    const items = scores.repetitions.filter(item => item.modelId === model.id);
    const aggregate = scores.aggregates.find(item => item.modelId === model.id)!;
    lines.push(`| ${md(model.id)} | ${md(model.model)} | ${items.reduce((sum, item) => sum + item.usable, 0)} / ${manifest.questionIds.length * manifest.experiment.repetitions} | ${aggregate.completeRepetitions} / ${manifest.experiment.repetitions} |`);
  }
  if (manifest.kind === 'smoke') lines.push('', 'Smoke tests check connectivity and response format only. They do not receive theological rankings.');
  lines.push('', 'Only fully usable pilot repetitions are scored. Refusals, invalid responses, transport errors, truncations, and pending items remain separate in coverage.csv.', '',
    '## Response profile', '',
    'Shares of scheduled answers. TheoCompass scores silence as a position: where silence is common, denomination matches mostly reflect which denominations leave those doctrines unrecorded, not positions the model chose. "Same across repetitions" counts questions where every repetition gave the same option or silence type.', '',
    '| Model | Answered | Apathetic | Hostile | Refusal | Failed | Pending | Same across repetitions |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const p of profiles) {
    const silent = (p.apathetic + p.hostile) / p.scheduled;
    const flag = silent > SILENCE_WARNING_SHARE ? ' ⚠' : '';
    lines.push(`| ${md(p.modelId)}${flag} | ${percent(p.answered, p.scheduled)} | ${percent(p.apathetic, p.scheduled)} | ${percent(p.hostile, p.scheduled)} | ${percent(p.refusal, p.scheduled)} | ${percent(p.failed, p.scheduled)} | ${percent(p.pending, p.scheduled)} | ${p.stable} / ${p.stableDenominator} |`);
  }
  if (profiles.some(p => (p.apathetic + p.hostile) / p.scheduled > SILENCE_WARNING_SHARE)) {
    lines.push('', `⚠ More than ${SILENCE_WARNING_SHARE * 100}% of a flagged model's scheduled answers were silence; read its alignment as a silence profile.`);
  }
  const compared = scores.aggregates.filter(aggregate => aggregate.completeRepetitions);
  if (compared.length) {
    lines.push('', '## Axis comparison', '', 'Mean native 0–100 coordinate across complete repetitions; see the per-model sections for spread.', '',
      `| Axis | ${compared.map(a => md(a.modelId)).join(' | ')} |`, `|---|${compared.map(() => '---:').join('|')}|`);
    for (const axis of Object.keys(compared[0].axes)) {
      lines.push(`| ${axis} | ${compared.map(a => a.axes[axis].mean === null ? '—' : a.axes[axis].mean!.toFixed(1)).join(' | ')} |`);
    }
    lines.push('', `| Top match | ${compared.map(a => md(a.modelId)).join(' | ')} |`, `|---|${compared.map(() => '---').join('|')}|`,
      `| Denomination | ${compared.map(a => md(a.denominations[0].name)).join(' | ')} |`,
      `| Family | ${compared.map(a => md(a.families[0]?.family ?? '—')).join(' | ')} |`);
  }
  lines.push('', '## Alignment', '', 'Values are mean ± sample standard deviation across complete repetitions. A single repetition has no standard deviation. With three repetitions, variation is descriptive, not a confidence interval.');
  for (const aggregate of scores.aggregates) {
    if (!aggregate.completeRepetitions) continue;
    lines.push('', `### ${md(aggregate.modelId)}`, '', '| Rank | Denomination | Match % |', '|---:|---|---:|');
    aggregate.denominations.slice(0, 10).forEach((item, i) => lines.push(`| ${i + 1} | ${md(item.name)} | ${display(item.stats)} |`));
    lines.push('', '| Family | Match % |', '|---|---:|');
    aggregate.families.slice(0, 5).forEach(item => lines.push(`| ${md(item.family)} | ${display(item.stats)} |`));
    lines.push('', '| Axis (native 0–100) | Value |', '|---|---:|');
    for (const [axis, stats] of Object.entries(aggregate.axes)) lines.push(`| ${axis} | ${display(stats)} |`);
  }
  const usd = (value: number | null) => value === null ? 'No price set' : `$${value.toFixed(4)}`;
  lines.push('', '## Cost and tokens', '', '| Model | Requests sent | Answers reused | Input tokens | Cached input | Output tokens | Reasoning | Cost USD |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const item of usage) lines.push(`| ${md(item.modelId)} | ${item.requestsSent} | ${item.answersReused} | ${item.inputTokens} | ${item.cachedInputTokens} | ${item.outputTokens} | ${item.reasoningTokens} | ${usd(item.costUSD)} |`);
  lines.push(`| **Total** | ${totals.requestsSent} | ${totals.answersReused} | ${totals.inputTokens} | ${totals.cachedInputTokens} | ${totals.outputTokens} | ${totals.reasoningTokens} | ${priced.length ? usd(totals.costUSD) : 'No price set'} |`);
  lines.push('', `Counts cover requests this run paid for; output includes reasoning.${totals.unpricedModels.length ? ` No price set for: ${totals.unpricedModels.join(', ')}, so the total covers priced models only.` : ''}${totals.answersReused ? ` Reused answers saved about ${usd(totals.reuseSavedUSD)}.` : ''} Details in usage.json. Estimates, not invoices.`, '',
    '## Provenance', '',
    `Dataset: \`${manifest.datasetHash}\``, '', `Scoring: \`${manifest.scoringVersion}\``, '', `Protocol: \`${manifest.protocolVersion}\``, '',
    `SOUL hash: \`${manifest.soulHash}\``, '', `Code hash: \`${manifest.codeHash}\``, '',
    'All normalized outcomes are in answers.jsonl; exact sanitized request/response attempts are in responses.jsonl.');
  await writeFile(join(directory, 'report.md'), lines.join('\n') + '\n');
  return scores;
}
