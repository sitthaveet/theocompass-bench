export const AXES = [
  'theolconslib', 'socialconslib', 'counterpromodern', 'supernat',
  'cultsepeng', 'clericegal', 'divhumagency', 'communindiv',
  'liturgspont', 'sacramfunct', 'literalcrit', 'intellectexper',
] as const;
export type Axis = typeof AXES[number];
export type Mode = 'quick' | 'standard' | 'deep';
export type Posture = 'affirmed' | 'apathetic' | 'hostile';
export type Provider = 'openai' | 'gemini' | 'anthropic' | 'deepseek' | 'qwen' | 'grok';
export type Dimensions<T> = Record<Axis, T>;

export interface AnswerOption {
  id: string;
  text: string;
  description: string;
  label: string;
  scores: Dimensions<number | null>;
}
export interface Question {
  id: string;
  category: string;
  text: string;
  priority: number;
  dimensions: Dimensions<number> | null;
  options: AnswerOption[];
}
export interface Doctrine {
  answered: boolean;
  C: number;
  T: number;
  posture: Posture;
  splitCount: number;
  dimensions: Partial<Dimensions<{ values: number[] }>>;
}
export interface Denomination {
  id: string;
  name: string;
  family: string;
  description: string;
  founded: string;
  region: string;
  perQuestion: Record<string, Doctrine>;
}
export interface Dataset {
  schemaVersion: 1;
  hash: string;
  sourceHashes: Record<string, string>;
  questions: Question[];
  modes: Record<Mode, string[]>;
  denominations: Denomination[];
  families: Record<string, string>[];
  diagnostics: string[];
}
export interface UserResponse {
  questionId: string;
  answerId: string;
  answerIds?: string[];
  certainty: number;
  tolerance: number;
  isSilence: boolean;
  silenceType?: 'apathetic' | 'hostile';
}
export interface Match {
  id: string;
  name: string;
  family: string;
  matchPercentage: number;
}
export interface Score {
  scoringVersion: string;
  matches: Match[];
  familyMatches: { family: string; matchPercentage: number }[];
  axes: Dimensions<number> & { tolerance: number; certainty: number };
}
/** USD per million tokens. Cache rates default to the input rate when absent. */
export interface Pricing {
  asOf: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheWritePerMillion?: number;
}
export interface ModelConfig {
  id: string;
  provider: Provider;
  model: string;
  apiKeyEnv: string;
  baseUrl: string;
  baseUrlEnv?: string;
  pricing?: Pricing;
}
export interface Experiment {
  mode: Mode;
  repetitions: number;
  models: string[];
  soul: string;
  shuffleOptions: boolean;
  seed: number;
  timeoutMs: number;
  maxOutputTokens: number;
  maxAttempts: number;
  concurrencyPerProvider: number;
  maxRequests: number;
  /** Stop starting new requests once known spend reaches this. Not part of the run fingerprint. */
  maxUSD?: number;
}
