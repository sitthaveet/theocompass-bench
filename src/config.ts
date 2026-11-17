import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

import type { Experiment, ModelConfig } from './types.js';

const modelSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  provider: z.enum(['openai', 'gemini', 'anthropic', 'deepseek', 'qwen', 'grok']),
  model: z.string().min(1), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  baseUrl: z.url(), baseUrlEnv: z.string().optional(),
  pricing: z.object({ asOf: z.iso.date(), inputPerMillion: z.number().nonnegative(), outputPerMillion: z.number().nonnegative(),
    cachedInputPerMillion: z.number().nonnegative().optional(), cacheWritePerMillion: z.number().nonnegative().optional() }).strict().optional(),
}).strict();
const experimentSchema = z.object({
  mode: z.enum(['quick', 'standard', 'deep']), repetitions: z.number().int().min(1).max(100),
  models: z.array(z.string()).min(1), soul: z.string().min(1), shuffleOptions: z.boolean(), seed: z.number().int(),
  timeoutMs: z.number().int().min(1000).max(600000), maxOutputTokens: z.number().int().min(128).max(131072),
  maxAttempts: z.number().int().min(1).max(5), concurrencyPerProvider: z.number().int().min(1).max(10),
  maxRequests: z.number().int().min(1),
  maxUSD: z.number().positive().optional(),
}).strict();

export async function loadConfiguration(
  experimentPath = 'configs/experiments/quick.yaml', modelsPath = 'configs/models.yaml',
): Promise<{ experiment: Experiment; models: ModelConfig[]; soul: string }> {
  const experiment = experimentSchema.parse(parse(await readFile(experimentPath, 'utf8')));
  const configured = z.object({ models: z.array(modelSchema).min(1) }).strict().parse(parse(await readFile(modelsPath, 'utf8'))).models;
  if (new Set(configured.map(model => model.id)).size !== configured.length) throw new Error('Duplicate model IDs');
  if (new Set(experiment.models).size !== experiment.models.length) throw new Error('Duplicate experiment model IDs');
  const models = experiment.models.map(id => {
    const model = configured.find(item => item.id === id);
    if (!model) throw new Error(`Unknown model ${id}`);
    const baseUrl = model.baseUrlEnv ? process.env[model.baseUrlEnv] || model.baseUrl : model.baseUrl;
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error(`${id}: base URL must be HTTPS without credentials, query, or fragment`);
    }
    return { ...model, baseUrl: baseUrl.replace(/\/$/, '') };
  });
  const unpriced = models.filter(model => !model.pricing).map(model => model.id);
  if (experiment.maxUSD !== undefined && unpriced.length) {
    throw new Error(`maxUSD needs pricing for every model; missing: ${unpriced.join(', ')}`);
  }
  const soul = await readFile(experiment.soul, 'utf8');
  if (!soul.trim()) throw new Error('SOUL.md is empty');
  return { experiment, models, soul };
}

export function requireKeys(models: ModelConfig[]): void {
  const missing = models.filter(model => !process.env[model.apiKeyEnv]?.trim()).map(model => model.apiKeyEnv);
  if (missing.length) throw new Error(`Missing API keys: ${missing.join(', ')}`);
}
