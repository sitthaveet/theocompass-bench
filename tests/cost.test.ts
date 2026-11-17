import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';

import { estimateFromHistory, usageCost } from '../src/analysis/cost.js';
import { reportRun } from '../src/analysis/index.js';
import { orderedOptions, PROTOCOL_INSTRUCTIONS, questionPrompt, userTurn } from '../src/prompts/index.js';
import { adapters, prepareRequest, type Exchange } from '../src/providers/index.js';
import type { ProviderInput } from '../src/providers/types.js';
import { createRun, executeRun, prepareRun, resumeRun } from '../src/runner/index.js';
import { readEvents } from '../src/runner/store.js';
import type { Provider } from '../src/types.js';
import { readJson } from '../src/util.js';

const temporaries: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaries.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'theocompass-cost-'));
  temporaries.push(root);
  return root;
}
const quiet = () => {};
const ANSWER = JSON.stringify({ status: 'answered', choice: 'A', certainty: 2, tolerance: 2, rationale: 'Mock justification.' });

/** A provider-shaped reply body, so reused replies can be re-decoded like real ones. */
function rawReply(provider: Provider): Record<string, unknown> {
  if (provider === 'openai' || provider === 'grok') return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: ANSWER }] }],
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0 } } };
  if (provider === 'anthropic') return { content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } };
  if (provider === 'gemini') return { candidates: [{ content: { parts: [{ text: ANSWER }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } };
  return { choices: [{ message: { content: ANSWER }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
}
function reply(input: ProviderInput): Exchange {
  const body = rawReply(input.model.provider);
  return { httpStatus: 200, headers: {}, rawBody: JSON.stringify(body), retryable: false, result: adapters[input.model.provider].decode(body) };
}
async function smokeRun(root: string, options: Parameters<typeof prepareRun>[0] = {}) {
  const prepared = await prepareRun({ smoke: true, ...options });
  for (const model of prepared.manifest.models) vi.stubEnv(model.apiKeyEnv, `fake-secret-${model.id}`);
  return { prepared, directory: await createRun(prepared, root) };
}

describe('cacheable prompt layout', () => {
  it('keeps the user turn byte-identical for providers that cache automatically', () => {
    const input = { model: { id: 'x', provider: 'deepseek' as const, model: 'm', apiKeyEnv: 'K', baseUrl: 'https://example.test' },
      system: 'SOUL', preamble: PROTOCOL_INSTRUCTIONS, prompt: 'Question: Q', maxOutputTokens: 100, timeoutMs: 1000 };
    const expected = `${PROTOCOL_INSTRUCTIONS}\n\nQuestion: Q`;
    expect(userTurn(input.preamble, input.prompt)).toBe(expected);
    for (const provider of ['openai', 'grok', 'gemini', 'deepseek', 'qwen'] as const) {
      expect(JSON.stringify(prepareRequest({ ...input, model: { ...input.model, provider } }).body)).toContain(JSON.stringify(expected).slice(1, -1));
    }
  });
  it('marks a Claude cache breakpoint after the fixed instructions, before the question', () => {
    const request = prepareRequest({ model: { id: 'sonnet', provider: 'anthropic', model: 'm', apiKeyEnv: 'K', baseUrl: 'https://example.test' },
      system: 'SOUL', preamble: PROTOCOL_INSTRUCTIONS, prompt: 'Question: Q', maxOutputTokens: 100, timeoutMs: 1000 });
    const [message] = request.body.messages as { content: { text: string; cache_control?: unknown }[] }[];
    expect(message.content).toEqual([
      { type: 'text', text: PROTOCOL_INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Question: Q' },
    ]);
  });
  it('sends the same prefix for every question and repetition', async () => {
    const prepared = await prepareRun();
    const model = prepared.manifest.models.find(item => item.provider === 'anthropic')!;
    const prefixes = new Set<string>();
    for (const questionId of prepared.manifest.questionIds.slice(0, 5)) for (const repetition of [1, 2]) {
      const question = prepared.dataset.questions.find(item => item.id === questionId)!;
      const body = prepareRequest({ model, system: prepared.soul, preamble: PROTOCOL_INSTRUCTIONS,
        prompt: questionPrompt(question, orderedOptions(question, prepared.manifest.experiment, repetition)), maxOutputTokens: 100, timeoutMs: 1000 }).body;
      prefixes.add(JSON.stringify([body.model, body.system, (body.messages as { content: unknown[] }[])[0].content[0]]));
    }
    expect(prefixes.size).toBe(1);
    expect(PROTOCOL_INSTRUCTIONS).not.toMatch(/Question:/);
  });
});

describe('cost accounting', () => {
  it('prices cache reads and writes at their own rates and output including reasoning', () => {
    const pricing = { asOf: '2026-11-17', inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 0.1, cacheWritePerMillion: 2.5 };
    const usage = { inputTokens: 2_000_000, cachedInputTokens: 1_000_000, cacheWriteInputTokens: 500_000, outputTokens: 1_000_000, reasoningTokens: 800_000 };
    expect(usageCost(usage, pricing)).toBeCloseTo(0.5 * 2 + 1 * 0.1 + 0.5 * 2.5 + 1 * 10);
    expect(usageCost(usage, { asOf: '2026-11-17', inputPerMillion: 2, outputPerMillion: 10 })).toBeCloseTo(2 * 2 + 10);
    expect(usageCost({ ...usage, inputTokens: null }, pricing)).toBeNull();
  });
  it('writes per-model and total tokens and cost to usage.json and the report', async () => {
    const root = await temporary();
    const { prepared, directory } = await smokeRun(root);
    for (const model of prepared.manifest.models) model.pricing = { asOf: '2026-11-17', inputPerMillion: 1, outputPerMillion: 10 };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(prepared.manifest));
    await executeRun(directory, prepared, { send: async input => reply(input), progress: quiet });
    await reportRun(directory);
    const usage = await readJson<any>(join(directory, 'usage.json'));
    expect(usage.models[0]).toMatchObject({ requestsSent: 1, answersReused: 0, inputTokens: 100, outputTokens: 20 });
    expect(usage.models[0].costUSD).toBeCloseTo((100 * 1 + 20 * 10) / 1e6);
    expect(usage.totals).toMatchObject({ requestsSent: 6, inputTokens: 600, outputTokens: 120, unpricedModels: [] });
    expect(usage.totals.costUSD).toBeCloseTo(6 * 300 / 1e6);
    expect(await readFile(join(directory, 'report.md'), 'utf8')).toContain('## Cost and tokens');
  });
  it('projects a run from tokens measured in earlier runs', async () => {
    const root = await temporary();
    const { prepared, directory } = await smokeRun(root);
    await executeRun(directory, prepared, { send: async input => reply(input), progress: quiet });
    const models = prepared.manifest.models.map(model => ({ ...model, pricing: { asOf: '2026-11-17', inputPerMillion: 1, outputPerMillion: 10 } }));
    const [first] = await estimateFromHistory(models, 90, root);
    expect(first).toMatchObject({ samples: 1, meanInputTokens: 100, meanOutputTokens: 20 });
    expect(first.estimatedUSD).toBeCloseTo(90 * 300 / 1e6);
  });
});

describe('never paying twice', () => {
  it('copies replies to identical requests from an earlier run, and --fresh sends them again', async () => {
    const root = await temporary();
    const first = await smokeRun(root);
    await executeRun(first.directory, first.prepared, { send: async input => reply(input), progress: quiet });

    const second = await smokeRun(root);
    const never = vi.fn(async (): Promise<Exchange> => { throw new Error('Must reuse the earlier reply'); });
    expect((await executeRun(second.directory, second.prepared, { send: never, progress: quiet })).status).toBe('complete');
    expect(never).not.toHaveBeenCalled();
    const finished = (await readEvents(second.directory)).events.filter(event => event.type === 'attempt_finished');
    expect(finished).toHaveLength(6);
    expect(finished.every(event => event.type === 'attempt_finished' && event.reusedFrom?.runId === first.prepared.manifest.id && event.outcome.status === 'answered')).toBe(true);
    await reportRun(second.directory);
    expect((await readJson<any>(join(second.directory, 'usage.json'))).totals).toMatchObject({ requestsSent: 0, answersReused: 6, inputTokens: 0 });

    const third = await smokeRun(root);
    const send = vi.fn(async (input: ProviderInput) => reply(input));
    await executeRun(third.directory, third.prepared, { send, progress: quiet, reuse: false });
    expect(send).toHaveBeenCalledTimes(6);
  });
  it('does not reuse failed requests or replies to different requests', async () => {
    const root = await temporary();
    const first = await smokeRun(root);
    await executeRun(first.directory, first.prepared, { progress: quiet,
      send: async input => input.model.id === 'terra' ? { httpStatus: 500, headers: {}, rawBody: '', error: 'HTTP 500', retryable: false } : reply(input) });
    const config = join(root, 'other.yaml');
    await writeFile(config, (await readFile('configs/experiments/quick.yaml', 'utf8')).replace('maxOutputTokens: 8192', 'maxOutputTokens: 4096'));
    const second = await smokeRun(root);
    const third = await smokeRun(root, { experimentPath: config });
    const sendSecond = vi.fn(async (input: ProviderInput) => reply(input));
    await executeRun(second.directory, second.prepared, { send: sendSecond, progress: quiet });
    expect(sendSecond.mock.calls.map(([input]) => input.model.id)).toEqual(['terra']);
    const sendThird = vi.fn(async (input: ProviderInput) => reply(input));
    await executeRun(third.directory, third.prepared, { send: sendThird, progress: quiet });
    expect(sendThird).toHaveBeenCalledTimes(6);
  });
});

describe('dollar budget', () => {
  async function pricedConfig(root: string, maxUSD?: number, price = 1): Promise<{ experimentPath: string; modelsPath: string }> {
    const models = parse(await readFile('configs/models.yaml', 'utf8'));
    for (const model of models.models) model.pricing = { asOf: '2026-11-17', inputPerMillion: price, outputPerMillion: price };
    const modelsPath = join(root, 'models.yaml');
    const experimentPath = join(root, 'experiment.yaml');
    await writeFile(modelsPath, stringify(models));
    await writeFile(experimentPath, (await readFile('configs/experiments/quick.yaml', 'utf8')) + (maxUSD ? `maxUSD: ${maxUSD}\n` : ''));
    return { experimentPath, modelsPath };
  }
  it('refuses a budget when any model has no price', async () => {
    const root = await temporary();
    const experimentPath = join(root, 'experiment.yaml');
    await writeFile(experimentPath, (await readFile('configs/experiments/quick.yaml', 'utf8')) + 'maxUSD: 5\n');
    await expect(prepareRun({ experimentPath })).rejects.toThrow(/maxUSD needs pricing/);
  });
  it('stops starting requests at the budget and resumes after it is raised', async () => {
    const root = await temporary();
    // Each mocked request is 120 tokens at $1/M: $0.00012. A $0.0006 budget covers about five.
    const paths = await pricedConfig(root, 0.0006);
    const prepared = await prepareRun({ ...paths });
    for (const model of prepared.manifest.models) vi.stubEnv(model.apiKeyEnv, `fake-secret-${model.id}`);
    const directory = await createRun(prepared, join(root, 'results'));
    const lines: string[] = [];
    const send = vi.fn(async (input: ProviderInput) => reply(input));
    const manifest = await executeRun(directory, prepared, { send, progress: line => lines.push(line), reuse: false });
    expect(manifest.status).toBe('incomplete');
    // Workers for different providers run concurrently, so at most one request per provider overshoots.
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(send.mock.calls.length).toBeLessThanOrEqual(5 + 6);
    expect(lines.some(line => line.startsWith('Budget reached'))).toBe(true);

    // Raising the budget and correcting a price must not strand the paid run.
    const raised = await pricedConfig(root, 100, 2);
    await writeFile(paths.experimentPath, await readFile(raised.experimentPath, 'utf8'));
    await writeFile(paths.modelsPath, await readFile(raised.modelsPath, 'utf8'));
    const resumed = await resumeRun(directory);
    expect(resumed.manifest.experiment.maxUSD).toBe(100);
    expect(resumed.manifest.models[0].pricing?.inputPerMillion).toBe(2);
    expect((await executeRun(directory, resumed, { send, progress: quiet, reuse: false })).status).toBe('complete');
    expect(send).toHaveBeenCalledTimes(540);
  });
});
