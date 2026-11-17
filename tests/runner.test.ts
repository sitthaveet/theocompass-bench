import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reportRun, scoreRun } from '../src/analysis/index.js';
import { createRun, executeRun, prepareRun, resumeRun } from '../src/runner/index.js';
import { readEvents, terminalAnswers } from '../src/runner/store.js';
import { prepareRequest, type Exchange } from '../src/providers/index.js';
import type { ProviderInput } from '../src/providers/types.js';
import type { Manifest } from '../src/runner/types.js';
import { readJson } from '../src/util.js';

const temporaries: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaries.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function setup(smoke = true, configPath?: string): Promise<{ directory: string; prepared: Awaited<ReturnType<typeof prepareRun>> }> {
  const prepared = await prepareRun({ smoke, experimentPath: configPath });
  for (const model of prepared.manifest.models) vi.stubEnv(model.apiKeyEnv, `fake-secret-${model.id}`);
  const root = await mkdtemp(join(tmpdir(), 'theocompass-test-'));
  temporaries.push(root);
  return { directory: await createRun(prepared, root), prepared };
}
function valid(input: ProviderInput): Exchange {
  return { httpStatus: 200, headers: {}, rawBody: '{}', retryable: false, result: {
    text: JSON.stringify({ status: 'answered', choice: 'A', certainty: 2, tolerance: 2, rationale: 'Mock justification.' }),
    returnedModel: input.model.model, refusal: false, truncated: false,
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: 0 },
  } };
}
const quiet = () => {};

describe('execution and durable outcomes', () => {
  it('runs all 540 mocked pilot answers, scores 18 repetitions, and reproduces reports', async () => {
    const { directory, prepared } = await setup(false);
    const send = vi.fn(async (input: ProviderInput) => valid(input));
    const manifest = await executeRun(directory, prepared, { send, progress: quiet });
    expect(manifest.scheduledAnswers).toBe(540);
    expect(manifest.status).toBe('complete');
    expect(send).toHaveBeenCalledTimes(540);
    const artifact = await reportRun(directory);
    expect(artifact.aggregates.every(item => item.completeRepetitions === 3)).toBe(true);
    expect(artifact.repetitions).toHaveLength(18);
    expect(artifact.aggregates[0].axes.certainty.mean).toBe(66.7);
    expect(artifact.aggregates[0].axes.certainty.sd).toBe(0);
    const report = await readFile(join(directory, 'report.md'), 'utf8');
    expect(report).toContain('## Response profile');
    expect(report).toContain('## Axis comparison');
    expect(report).not.toContain('⚠');
    // Always choosing display letter A under per-repetition shuffles must not look like a stable stance.
    const profile = await readFile(join(directory, 'response-profile.csv'), 'utf8');
    expect(profile.split('\n')[1]).toMatch(/^terra,90,90,0,0,0,0,0,\d+,30$/);
    expect(Number(profile.split('\n')[1].split(',')[8])).toBeLessThan(30);
    const before = await readFile(join(directory, 'scores.json'), 'utf8');
    await reportRun(directory);
    expect(await readFile(join(directory, 'scores.json'), 'utf8')).toBe(before);
    const resumed = await resumeRun(directory);
    const never = vi.fn(async () => { throw new Error('Must not resend a persisted outcome'); });
    await executeRun(directory, resumed, { send: never, progress: quiet });
    expect(never).not.toHaveBeenCalled();
  });
  it('retries transient failures while keeping every attempt and secret-free logs', async () => {
    const { directory, prepared } = await setup();
    const seen = new Set<string>();
    const sleep = vi.fn(async () => {});
    const send = vi.fn(async (input: ProviderInput) => {
      if (!seen.has(input.model.id)) {
        seen.add(input.model.id);
        return { httpStatus: 429, headers: {}, rawBody: `echo fake-secret-${input.model.id}`, error: 'HTTP 429', retryable: true, retryAfterMs: 2000 };
      }
      return valid(input);
    });
    expect((await executeRun(directory, prepared, { send, sleep, progress: quiet })).status).toBe('complete');
    expect(send).toHaveBeenCalledTimes(12);
    expect(sleep).toHaveBeenCalledWith(2000);
    const log = await readFile(join(directory, 'responses.jsonl'), 'utf8');
    expect(log).not.toContain('fake-secret');
    const events = (await readEvents(directory)).events;
    expect(terminalAnswers(events).size).toBe(6);
    expect(events.filter(event => event.type === 'attempt_started')).toHaveLength(12);
  });
  it('does not reprompt malformed answers or score smoke tests', async () => {
    const { directory, prepared } = await setup();
    const send = vi.fn(async (input: ProviderInput) => {
      const exchange = valid(input);
      exchange.result!.text = 'not JSON';
      return exchange;
    });
    expect((await executeRun(directory, prepared, { send, progress: quiet })).status).toBe('incomplete');
    expect(send).toHaveBeenCalledTimes(6);
    const scores = await reportRun(directory);
    expect(scores.repetitions.every(item => item.score === null && item.outcomes.invalid_response === 1)).toBe(true);
  });
  it('flags models whose results are dominated by silence', async () => {
    const { directory, prepared } = await setup();
    await executeRun(directory, prepared, { progress: quiet, send: async input => {
      const exchange = valid(input);
      if (input.model.id === 'qwen') exchange.result!.text = JSON.stringify({ status: 'apathetic', choice: null, certainty: null, tolerance: null, rationale: 'None fits.' });
      return exchange;
    } });
    await reportRun(directory);
    const report = await readFile(join(directory, 'report.md'), 'utf8');
    expect(report).toContain('| qwen ⚠ | 0.0% | 100.0% |');
    expect(report).not.toContain('| terra ⚠');
  });
  it('preserves explicit and native refusals as unscored outcomes', async () => {
    const { directory, prepared } = await setup();
    await executeRun(directory, prepared, { progress: quiet, send: async input => {
      const exchange = valid(input);
      if (input.model.provider === 'openai') exchange.result!.refusal = true;
      else exchange.result!.text = JSON.stringify({ status: 'refusal', choice: null, certainty: null, tolerance: null, rationale: 'Cannot participate.' });
      return exchange;
    } });
    const scores = await scoreRun(directory);
    expect(scores.repetitions.every(item => item.usable === 0 && item.outcomes.refusal === 1)).toBe(true);
  });
  it('repairs a torn checkpoint tail and resumes an interrupted attempt', async () => {
    const { directory, prepared } = await setup();
    const model = prepared.manifest.models[0];
    const question = prepared.dataset.questions.find(q => q.id === prepared.manifest.questionIds[0])!;
    const task = { key: `${model.id}/1/${question.id}`, modelId: model.id, repetition: 1, questionId: question.id };
    const input: ProviderInput = { model, system: prepared.soul, prompt: 'original prompt', maxOutputTokens: 8192, timeoutMs: 180000 };
    await appendFile(join(directory, 'responses.jsonl'), JSON.stringify({ type: 'attempt_started', at: new Date().toISOString(), task, attempt: 1,
      request: prepareRequest(input), optionOrder: question.options.map(o => o.id) }) + '\n{"type":');
    await executeRun(directory, await resumeRun(directory), { send: async input => valid(input), progress: quiet });
    const { events } = await readEvents(directory);
    expect(terminalAnswers(events).get(task.key)?.attempt).toBe(2);
    expect(events.filter(event => event.type === 'attempt_started')).toHaveLength(7);
  });
  it('rejects changed configuration and tampered snapshots before resuming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'theocompass-config-'));
    temporaries.push(root);
    const config = join(root, 'quick.yaml');
    const original = await readFile('configs/experiments/quick.yaml', 'utf8');
    await writeFile(config, original);
    const { directory } = await setup(false, config);
    await writeFile(config, original.replace('repetitions: 3', 'repetitions: 2'));
    await expect(resumeRun(directory)).rejects.toThrow(/hash changed/);
    await writeFile(config, original);
    await writeFile(join(directory, 'SOUL.md'), 'tampered');
    await expect(resumeRun(directory)).rejects.toThrow(/snapshot hash mismatch/);
  });
  it('stops further requests to a model after a permanent configuration error', async () => {
    const { directory, prepared } = await setup(false);
    const send = vi.fn(async (input: ProviderInput) => input.model.id === 'terra'
      ? { httpStatus: 404, headers: {}, rawBody: '{}', error: 'HTTP 404', retryable: false } : valid(input));
    await executeRun(directory, prepared, { send, progress: quiet });
    expect(send.mock.calls.filter(([input]) => input.model.id === 'terra')).toHaveLength(1);
    const scores = await reportRun(directory);
    expect(scores.aggregates.find(item => item.modelId === 'terra')!.completeRepetitions).toBe(0);
    const manifest = await readJson<Manifest>(join(directory, 'manifest.json'));
    expect(manifest.status).toBe('incomplete');
  });
  it('rejects an edited request ceiling in a saved manifest', async () => {
    const { directory } = await setup();
    const manifest = await readJson<Manifest>(join(directory, 'manifest.json'));
    manifest.requestLimit++;
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await expect(resumeRun(directory)).rejects.toThrow(/hash changed/);
  });
});
