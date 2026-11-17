import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const checker = resolve('scripts/check-publication.mjs');
const example = readFileSync('.env.example', 'utf8');
const temporaries: string[] = [];
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

function repository(): string {
  const path = mkdtempSync(join(tmpdir(), 'theocompass-publication-'));
  temporaries.push(path);
  execFileSync('git', ['init', '-q'], { cwd: path });
  writeFileSync(join(path, '.env.example'), example);
  writeFileSync(join(path, '.gitignore'), '.env\nresults/\n');
  return path;
}

function check(path: string, extraEnv: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.endsWith('_API_KEY')));
  return spawnSync(process.execPath, [checker], { cwd: path, env: { ...env, ...extraEnv }, encoding: 'utf8' });
}

describe('publication file guard', () => {
  it('keeps ignored local keys and results outside publication candidates', () => {
    const path = repository();
    writeFileSync(join(path, '.env'), `OPENAI_API_KEY=${randomBytes(24).toString('hex')}\n`);
    mkdirSync(join(path, 'results'));
    writeFileSync(join(path, 'results/private.json'), '{}');
    expect(check(path).status).toBe(0);
  });

  it.each([false, true])('rejects a configured key in a candidate file (tracked: %s) without printing it', tracked => {
    const path = repository();
    const secret = randomBytes(24).toString('hex');
    writeFileSync(join(path, '.env'), `OPENAI_API_KEY=${secret}\n`);
    writeFileSync(join(path, 'leaked.txt'), secret);
    if (tracked) execFileSync('git', ['add', 'leaked.txt'], { cwd: path });
    const result = check(path);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain('leaked.txt: contains the configured OPENAI_API_KEY value');
    expect(String(result.stdout) + String(result.stderr)).not.toContain(secret);
  });

  it('checks local-file keys even when a different process-environment key takes precedence for requests', () => {
    const path = repository();
    const local = randomBytes(24).toString('hex');
    writeFileSync(join(path, '.env'), `OPENAI_API_KEY=${local}\n`);
    writeFileSync(join(path, 'leaked.txt'), local);
    expect(check(path, { OPENAI_API_KEY: randomBytes(24).toString('hex') }).status).toBe(1);
  });

  it('rejects a key staged earlier even after the working copy has been cleaned', () => {
    const path = repository();
    const secret = randomBytes(24).toString('hex');
    writeFileSync(join(path, '.env'), `OPENAI_API_KEY=${secret}\n`);
    writeFileSync(join(path, 'leaked.txt'), secret);
    execFileSync('git', ['add', 'leaked.txt'], { cwd: path });
    writeFileSync(join(path, 'leaked.txt'), 'clean');
    const result = check(path);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain('leaked.txt (staged): contains the configured OPENAI_API_KEY value');
    expect(String(result.stdout) + String(result.stderr)).not.toContain(secret);
  });

  it.each(['.env', 'results/private.json', '.serena/project.yml'])('rejects a forcibly tracked local file: %s', filename => {
    const path = repository();
    mkdirSync(join(path, filename, '..'), { recursive: true });
    writeFileSync(join(path, filename), '');
    execFileSync('git', ['add', '-f', filename], { cwd: path });
    const result = check(path);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain(`${filename}: local or credential file must not be published`);
  });

  it('rejects populated API-key placeholders without printing their contents', () => {
    const path = repository();
    const secret = randomBytes(24).toString('hex');
    writeFileSync(join(path, '.env.example'), example.replace('OPENAI_API_KEY=', `OPENAI_API_KEY=${secret}`));
    const result = check(path);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain('OPENAI_API_KEY must exist and be empty');
    expect(String(result.stdout) + String(result.stderr)).not.toContain(secret);
  });

  it('checks staged placeholders even when the working example is empty again', () => {
    const path = repository();
    const secret = randomBytes(24).toString('hex');
    writeFileSync(join(path, '.env.example'), example.replace('OPENAI_API_KEY=', `OPENAI_API_KEY=${secret}`));
    execFileSync('git', ['add', '.env.example'], { cwd: path });
    writeFileSync(join(path, '.env.example'), example);
    const result = check(path);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain('.env.example (staged): OPENAI_API_KEY must exist and be empty');
    expect(String(result.stdout) + String(result.stderr)).not.toContain(secret);
  });
});
