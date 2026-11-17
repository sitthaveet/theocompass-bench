import type { ModelAnswer } from '../prompts/index.js';
import type { Exchange } from '../providers/index.js';
import type { PreparedRequest, Usage } from '../providers/types.js';
import type { Experiment, ModelConfig } from '../types.js';

export interface Task {
  key: string;
  modelId: string;
  repetition: number;
  questionId: string;
}
export interface Outcome {
  status: 'answered' | 'apathetic' | 'hostile' | 'refusal' | 'invalid_response' | 'truncated' | 'api_error';
  answer?: ModelAnswer;
  detail?: string;
}
export interface StartedEvent {
  type: 'attempt_started';
  at: string;
  task: Task;
  attempt: number;
  request: PreparedRequest;
  optionOrder: string[];
}
export interface FinishedEvent {
  type: 'attempt_finished';
  at: string;
  task: Task;
  attempt: number;
  durationMs: number;
  exchange: Exchange;
  outcome: Outcome;
  terminal: boolean;
  /** Set when the exchange was copied from an identical request in an earlier run instead of sent. */
  reusedFrom?: { runId: string; attempt: number };
}
export type RunEvent = StartedEvent | FinishedEvent;
export interface AnswerRecord extends Task {
  attempt: number;
  outcome: Outcome;
  usage: Usage | null;
}
export interface Manifest {
  schemaVersion: 1;
  id: string;
  kind: 'pilot' | 'smoke';
  createdAt: string;
  updatedAt: string;
  status: 'created' | 'running' | 'complete' | 'incomplete';
  experimentPath: string;
  modelsPath: string;
  experiment: Experiment;
  models: ModelConfig[];
  questionIds: string[];
  scheduledAnswers: number;
  requestLimit: number;
  datasetHash: string;
  soulHash: string;
  codeHash: string;
  scorerHash: string;
  fingerprint: string;
  protocolVersion: string;
  scoringVersion: string;
  gitCommit: string | null;
  nodeVersion: string;
}
