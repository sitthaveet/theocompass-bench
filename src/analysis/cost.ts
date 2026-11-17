import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Usage } from '../providers/types.js';
import { readEvents } from '../runner/store.js';
import type { Manifest } from '../runner/types.js';
import type { ModelConfig, Pricing } from '../types.js';
import { readJson } from '../util.js';

/**
 * Known cost of one exchange. Cache reads and writes are priced at their own rates when configured
 * and at the input rate otherwise. Output includes reasoning tokens, which every adapter reports in
 * outputTokens. Returns null when the provider returned no usage.
 */
export function usageCost(usage: Usage | null | undefined, pricing: Pricing): number | null {
  if (!usage || usage.inputTokens === null || usage.outputTokens === null) return null;
  const cached = usage.cachedInputTokens || 0;
  const written = usage.cacheWriteInputTokens || 0;
  const uncached = Math.max(0, usage.inputTokens - cached - written);
  return (uncached * pricing.inputPerMillion
    + cached * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion)
    + written * (pricing.cacheWritePerMillion ?? pricing.inputPerMillion)
    + usage.outputTokens * pricing.outputPerMillion) / 1e6;
}

export interface HistoricalEstimate {
  modelId: string;
  model: string;
  samples: number;
  meanInputTokens: number | null;
  meanOutputTokens: number | null;
  scheduledAnswers: number;
  estimatedUSD: number | null;
}

/**
 * Projects a run's cost from token usage measured in earlier runs of the same provider model.
 * Uses mean tokens per completed request, so it follows reasoning-heavy models honestly; it
 * assumes no retries and prices input uncached, so caching makes the real bill lower.
 */
export async function estimateFromHistory(models: ModelConfig[], answersPerModel: number, resultsRoot = 'results'): Promise<HistoricalEstimate[]> {
  const totals = new Map<string, { samples: number; input: number; output: number }>();
  const identity = (provider: string, model: string) => `${provider}/${model}`;
  let runs: string[] = [];
  try { runs = (await readdir(resultsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const run of runs) {
    const directory = join(resultsRoot, run);
    let manifest: Manifest;
    try { manifest = await readJson<Manifest>(join(directory, 'manifest.json')); } catch { continue; }
    const byId = new Map(manifest.models.map(model => [model.id, identity(model.provider, model.model)]));
    for (const event of (await readEvents(directory)).events) {
      if (event.type !== 'attempt_finished' || event.reusedFrom) continue;
      const usage = event.exchange.result?.usage;
      const key = byId.get(event.task.modelId);
      if (!key || !usage || usage.inputTokens === null || usage.outputTokens === null) continue;
      const total = totals.get(key) || { samples: 0, input: 0, output: 0 };
      total.samples++; total.input += usage.inputTokens; total.output += usage.outputTokens;
      totals.set(key, total);
    }
  }
  return models.map(model => {
    const total = totals.get(identity(model.provider, model.model));
    const meanInputTokens = total ? total.input / total.samples : null;
    const meanOutputTokens = total ? total.output / total.samples : null;
    const estimatedUSD = total && model.pricing
      ? answersPerModel * usageCost({ inputTokens: meanInputTokens, outputTokens: meanOutputTokens, reasoningTokens: null, cachedInputTokens: 0 }, model.pricing)!
      : null;
    return { modelId: model.id, model: model.model, samples: total?.samples ?? 0, meanInputTokens, meanOutputTokens,
      scheduledAnswers: answersPerModel, estimatedUSD };
  });
}
