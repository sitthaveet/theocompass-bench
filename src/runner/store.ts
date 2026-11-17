import { execFileSync } from 'node:child_process';
import { open, readFile, readdir, truncate, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { canonical, hash } from '../util.js';
import type { Exchange } from '../providers/index.js';
import type { PreparedRequest } from '../providers/types.js';
import type { AnswerRecord, RunEvent } from './types.js';

/**
 * Code that cannot change what is sent or how a reply becomes an outcome. Editing it must not
 * block a resume: reports and cost estimates are rebuilt offline, and the scorer is fingerprinted
 * separately through scorerHash.
 */
const OFFLINE_CODE = new Set(['src/analysis', 'src/scoring', 'src/cli.ts']);

/** Hash of the request-shaping source tree plus dependency and compiler configuration. */
export async function sourceCodeHash(directory = 'src'): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const pieces: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (OFFLINE_CODE.has(join(directory, entry.name))) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) pieces.push(`${entry.name}:${await sourceCodeHash(path)}`);
    else pieces.push(`${entry.name}:${hash(await readFile(path))}`);
  }
  if (directory === 'src') {
    for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) pieces.push(`${name}:${hash(await readFile(name))}`);
  }
  return hash(pieces.join('\n'));
}

export function gitCommit(): string | null {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

export async function readEvents(directory: string): Promise<{ events: RunEvent[]; validBytes: number; totalBytes: number }> {
  let raw: string;
  try { raw = await readFile(join(directory, 'responses.jsonl'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], validBytes: 0, totalBytes: 0 }; throw error; }
  const events: RunEvent[] = [];
  let validBytes = 0;
  const lines = raw.split('\n');
  // Only newline-terminated records are committed. A torn tail can be retried.
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i]) throw new Error(`Empty checkpoint record at line ${i + 1}`);
    const event = JSON.parse(lines[i]) as RunEvent;
    if (event.type !== 'attempt_started' && event.type !== 'attempt_finished') throw new Error(`Invalid checkpoint event at line ${i + 1}`);
    events.push(event);
    validBytes += Buffer.byteLength(lines[i] + '\n');
  }
  return { events, validBytes, totalBytes: Buffer.byteLength(raw) };
}

export function terminalAnswers(events: RunEvent[]): Map<string, AnswerRecord> {
  const result = new Map<string, AnswerRecord>();
  for (const event of events) {
    if (event.type !== 'attempt_finished' || !event.terminal) continue;
    if (result.has(event.task.key)) throw new Error(`Duplicate terminal checkpoint: ${event.task.key}`);
    result.set(event.task.key, { ...event.task, attempt: event.attempt, outcome: event.outcome, usage: event.exchange.result?.usage || null });
  }
  return result;
}

export async function writeAnswers(directory: string, events: RunEvent[]): Promise<void> {
  const records = [...terminalAnswers(events).values()];
  const { writeFile, rename } = await import('node:fs/promises');
  const temporary = join(directory, `answers.${process.pid}.tmp`);
  await writeFile(temporary, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), { mode: 0o600 });
  await rename(temporary, join(directory, 'answers.jsonl'));
}

export async function openJournal(directory: string, secrets: string[]): Promise<{
  events: RunEvent[];
  append(event: RunEvent): Promise<void>;
  close(): Promise<void>;
}> {
  const log = await readEvents(directory);
  const path = join(directory, 'responses.jsonl');
  if (log.totalBytes > log.validBytes) await truncate(path, log.validBytes);
  const handle = await open(path, 'a', 0o600);
  let pending = Promise.resolve();
  return { events: log.events,
    append(event) {
      pending = pending.then(async () => {
        let serialized = JSON.stringify(event);
        for (const secret of secrets.filter(value => value.length >= 8)) serialized = serialized.split(secret).join('[REDACTED]');
        const safe = JSON.parse(serialized) as RunEvent;
        await handle.writeFile(serialized + '\n');
        await handle.sync();
        log.events.push(safe);
      });
      return pending;
    },
    async close() { await pending; await handle.close(); },
  };
}

export async function acquireLock(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, '.lock');
  const owner = { pid: process.pid, host: hostname() };
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(path, 'utf8')) as typeof owner;
    if (previous.host !== hostname()) throw new Error('Run is locked by another host');
    let alive = true;
    try { process.kill(previous.pid, 0); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    if (alive) throw new Error(`Run is already locked by process ${previous.pid}`);
    await unlink(path);
    handle = await open(path, 'wx', 0o600);
  }
  await handle.writeFile(canonical(owner));
  return async () => { await handle.close(); await unlink(path); };
}

/** Identity of a request for reuse: everything sent, plus the repetition so repeats stay independent samples. */
export function requestKey(request: PreparedRequest, repetition: number): string {
  return hash(canonical({ url: request.url, headers: request.headers, body: request.body, repetition }));
}

export interface ReusableExchange { runId: string; attempt: number; exchange: Exchange }

/**
 * Index of paid, completed exchanges (HTTP 2xx with a decoded reply) across earlier runs, keyed by
 * requestKey. Transport and HTTP errors are never reused. Unreadable runs are skipped.
 */
export async function reusableExchanges(resultsRoot: string, excludeRunId: string): Promise<Map<string, ReusableExchange>> {
  const index = new Map<string, ReusableExchange>();
  let runs: string[] = [];
  try { runs = (await readdir(resultsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const runId of runs.sort()) {
    if (runId === excludeRunId) continue;
    let events: RunEvent[];
    try { events = (await readEvents(join(resultsRoot, runId))).events; } catch { continue; }
    const keys = new Map<string, string>();
    for (const event of events) {
      if (event.type === 'attempt_started') keys.set(`${event.task.key}#${event.attempt}`, requestKey(event.request, event.task.repetition));
      else if (!event.reusedFrom && event.exchange.result && event.exchange.httpStatus !== null
        && event.exchange.httpStatus >= 200 && event.exchange.httpStatus < 300) {
        const key = keys.get(`${event.task.key}#${event.attempt}`);
        if (key && !index.has(key)) index.set(key, { runId, attempt: event.attempt, exchange: event.exchange });
      }
    }
  }
  return index;
}
