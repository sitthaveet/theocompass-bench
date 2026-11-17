import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const staged = new Set(execFileSync('git', ['diff', '--cached', '--no-ext-diff', '--name-only', '--diff-filter=ACMRT', '-z'],
  { encoding: 'utf8' }).split('\0').filter(Boolean));
// Include new files and staged changes, while respecting pending working-tree deletions.
// Ignored files that are tracked or staged still need checking.
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' }).split('\0').filter(path => path && (existsSync(path) || staged.has(path))))];
const local = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
const secrets = [...Object.entries(local), ...Object.entries(process.env)]
  .filter(([name, value]) => name.endsWith('_API_KEY') && value && value.length >= 8);
const failures = [];

function checkContent(path, content) {
  for (const [name, value] of secrets) {
    if (content.includes(value)) failures.push(`${path}: contains the configured ${name} value`);
  }
}

for (const path of files) {
  const basename = path.split('/').at(-1);
  const localDirectory = /^(?:results|output|coverage|node_modules|\.serena|\.vscode|\.idea|\.codex|\.claude)(?:\/|$)/.test(path)
    || path.startsWith('data/compiled/');
  const credentialFile = (/^\.env(?:\.|$)/.test(basename) && basename !== '.env.example')
    || /^\.dev\.vars(?:\.|$)/.test(basename)
    || ['.npmrc', '.netrc'].includes(basename)
    || /\.(?:pem|key|pfx|p12)$/i.test(basename);
  if (localDirectory || credentialFile) failures.push(`${path}: local or credential file must not be published`);
  if (existsSync(path)) checkContent(path, readFileSync(path));
  if (staged.has(path)) checkContent(`${path} (staged)`, execFileSync('git', ['show', `:${path}`], { maxBuffer: 16 * 1024 * 1024 }));
}

const requiredKeys = ['OPENAI_API_KEY', 'CLAUDE_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'QWEN_API_KEY', 'GROK_API_KEY'];
const examples = [['.env.example', readFileSync('.env.example', 'utf8')]];
if (staged.has('.env.example')) examples.push(['.env.example (staged)', execFileSync('git', ['show', ':.env.example'], { encoding: 'utf8' })]);
for (const [path, content] of examples) {
  const example = parseEnv(content);
  for (const name of requiredKeys) {
    if (!(name in example) || example[name] !== '') failures.push(`${path}: ${name} must exist and be empty`);
  }
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`Publication file check passed (${files.length} files; ${secrets.length} configured API keys checked).`);
  console.log('Also run Gitleaks on the publication files and full Git history; this check only matches configured API keys.');
}
