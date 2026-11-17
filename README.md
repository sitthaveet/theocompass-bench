# TheoCompass Bench

[![CI](https://github.com/sitthaveet/theocompass-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/sitthaveet/theocompass-bench/actions/workflows/ci.yml)
![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Questionnaire](https://img.shields.io/badge/Quick_mode-30_questions-6654A3)

A local CLI for comparing the theological positions expressed by AI models under the same [SOUL.md](SOUL.md) instructions. It reuses [TheoCompass](https://github.com/TheoCompass/theocompass)'s original questionnaire, denomination baselines, and scoring behavior.

The default pilot is **6 models × 30 questions × 3 repetitions = 540 scheduled answers**. Each question starts a fresh conversation, requests exactly one option plus certainty/tolerance and a short rationale, and preserves provider-default sampling and reasoning. Explicit silence and refusal are separate outcomes.

[Quick start](#quick-start) · [Configuration](#configuration) · [Results](#results) · [Methodology](docs/methodology.md) · [Contributing](CONTRIBUTING.md) · [Publication checklist](docs/publishing.md)

**Current scope:** Quick mode is complete. Standard and Deep are rejected before API calls because their source exports are incomplete. Results describe expressed positions under this protocol, not personal beliefs or proof that bias has been removed.

## Quick start

Requires **Node.js 24 or later**, npm, and API access to the models you select. If you use nvm, `nvm install` reads [.nvmrc](.nvmrc). Run commands from the repository root:

```bash
git clone https://github.com/sitthaveet/theocompass-bench.git
cd theocompass-bench
npm ci

# Run once, only if .env does not already exist
cp .env.example .env
```

Edit `.env` and fill in the keys for your selected models. The default experiment selects all six. The CLI loads `.env`; existing process environment variables take precedence. Keep `.env` local: it is git-ignored, and [.env.example](.env.example) contains empty key placeholders. Keys are attached only when sending HTTP requests and are not saved in request headers or manifests.

```bash
npm run data:prepare                 # Local dataset validation
npm run bench -- run --dry-run       # Budget/configuration check; no API calls
npm run bench -- run --smoke         # One question per selected model
npm run bench -- run                 # Full pilot and reports
```

**Smoke tests and full runs can incur provider charges.** Start with the dry run, inspect its request ceiling, and confirm model access with a smoke test. The CLI prints the run directory; open `results/<run-id>/report.md` for the report. Smoke tests check connectivity and response format and do not generate alignment scores.

Offline tests and dry runs work without API keys:

```bash
npm run check
```

## Configuration

Models and endpoints live in [configs/models.yaml](configs/models.yaml). The shipped entries are configuration defaults, not a guarantee that each model is available to your account. Update IDs/endpoints deliberately; unavailable models are reported without substitution.

| Experiment ID | Provider | Configured API model ID | Environment variable |
|---|---|---|---|
| `terra` | OpenAI | `gpt-6.1-terra` | `OPENAI_API_KEY` |
| `hydrogen` | Google | `gemini-4-hydrogen` | `GEMINI_API_KEY` |
| `sonnet` | Anthropic | `claude-sonnet-5-5` | `CLAUDE_API_KEY` |
| `deepseek` | DeepSeek | `deepseek-flash` | `DEEPSEEK_API_KEY` |
| `qwen` | Qwen | `qwen3.8-flash` | `QWEN_API_KEY` |
| `grok` | xAI | `grok-4.7` | `GROK_API_KEY` |

Qwen defaults to Singapore; set `QWEN_BASE_URL` to your workspace's OpenAI-compatible base URL if needed. The API key must belong to the endpoint's region. No endpoint-region fallback occurs.

### Run a smaller experiment

Copy the default configuration:

```bash
cp configs/experiments/quick.yaml configs/experiments/my-run.yaml
```

Edit these fields in the copy, leaving its other fields intact:

```yaml
models: [terra, sonnet]
repetitions: 1
maxRequests: 180
```

This schedules **2 models × 30 questions × 1 repetition = 60 answers**, allowing up to 180 requests with three attempts. Only the two selected providers need keys.

```bash
npm run bench -- run --config configs/experiments/my-run.yaml --dry-run
npm run bench -- run --config configs/experiments/my-run.yaml --smoke
npm run bench -- run --config configs/experiments/my-run.yaml
```

Use `--models PATH` to select a separate model configuration. Custom experiment files are regular repository files; keep credentials out of them. Set `maxUSD` only after adding dated `pricing` for every selected model. Token and dollar costs are estimates; the repository does not set a default dollar cap.

## Commands

```bash
# Compile the unchanged source data and inspect available modes
npm run bench -- prepare

# Validate locally and print the request budget and a cost estimate; nothing is sent
npm run bench -- run --dry-run

# One question per model; connectivity/format checks, with no alignment scores
npm run bench -- run --smoke

# Collect the full 540-answer pilot, then generate scores and reports
npm run bench -- run

# Continue unfinished tasks with the same request code/config/prompts/data
npm run bench -- resume results/<run-id>

# Regenerate deterministic scores or the full report from saved artifacts
npm run bench -- score results/<run-id>
npm run bench -- report results/<run-id>

npm run typecheck
npm test
```

`run` accepts `--config PATH` and `--models PATH`. The default experiment is [configs/experiments/quick.yaml](configs/experiments/quick.yaml). Option order is shuffled by default (seeded, with the same permutation for every model in a given repetition) because the source lists options from conservative to liberal; options are shown as A, B, C… so source IDs cannot reveal the original order. For an order-sensitivity experiment, copy the configuration and set `shuffleOptions: false`. Keep fixed and shuffled runs separate.

The default limits are one concurrent request per provider, 180 seconds per request, 8,192 output tokens, and three attempts for transient failures. The pilot request ceiling is 1,620; a smoke test allows at most 18 requests. Attempts also count against the saved request ceiling after a restart. A timeout can be billed even if its outcome is unknown.

HTTP 408, 429, and 5xx responses and transport failures may be retried, honoring `Retry-After`. Malformed answers, refusals, and truncations are terminal and never reprompted. HTTP 400/401/403/404 stops further work for that model during the invocation; other models continue. Resume continues pending work and preserves terminal outcomes. Start a new run to replace terminal failures or change experimental settings.

### Keeping cost down

- **Reuse saved replies.** A run first looks through earlier runs in `results/` for a completed reply (HTTP 2xx) to a byte-identical request with the same repetition number, and copies it instead of sending. Copied replies are re-decoded and re-parsed with current code, marked `reusedFrom` in `responses.jsonl`, and cost nothing in that run's `usage.json`. Failed requests are never reused. Pass `--fresh` to `run` or `resume` to disable cross-run reuse; resume still preserves its own terminal outcomes.
- **Resume survives report changes.** The resume fingerprint covers only code that shapes requests or turns replies into outcomes. Editing `src/analysis/` or `src/cli.ts` does not block a resume. The scorer has its own hash: after a scoring change, start a new run; it reuses every reply, so rescoring costs nothing.
- **Prompt caching.** SOUL.md and the fixed protocol instructions come before the question on every request, allowing eligible prefixes to be cached. The Claude adapter sets an explicit breakpoint after the instructions. Cache eligibility and returned usage depend on the provider.
- **Dollar budget.** Set `maxUSD` in the experiment file to stop starting new requests once known spend reaches it. It requires `pricing` for every model. Requests already in flight can overshoot by about one per provider. Prices and `maxUSD` are not part of the fingerprint: raise the budget or correct a price, then `resume`.

Exit codes: `0` for success, `1` for command/configuration errors, `2` for a run with unusable or pending outcomes. Smoke tests may succeed without producing any theological scores.

## Results

Every run is stored locally under the git-ignored `results/<run-id>/`:

| Artifact | Contents |
|---|---|
| `manifest.json` | Resolved model/configuration, budgets, versions, content hashes, code/dependency fingerprint, timestamps |
| `dataset.json`, `SOUL.md` | Exact dataset and system-prompt snapshots |
| `responses.jsonl` | Append-only, synced start/finish records; sanitized requests, raw responses, errors, metadata, usage |
| `answers.jsonl` | Derived terminal model outcomes and normalized answers |
| `scores.json` | Full rankings and 14 axes for each complete repetition, plus aggregates |
| `report.md` | Coverage, response profile with silence warnings, side-by-side axis comparison, rankings, variation, usage, and provenance |
| `rankings.csv`, `axes.csv` | Aggregate scores and sample standard deviations |
| `coverage.csv`, `answer-frequencies.csv` | Every repetition's coverage and per-item choices/failures with explicit denominators |
| `response-profile.csv` | Per-model answered/silence/refusal/failure shares and cross-repetition stability |
| `usage.json` | Per-model and total tokens (input, cached, cache-write, output, reasoning), requests sent, answers reused, and cost in USD for priced models; the same table is in `report.md` under "Cost and tokens" |

Only complete pilot repetitions are scored. An explicit apathetic/hostile silence is a valid scored response under the original quiz. A refusal, missing answer, invalid response, truncation, or transport error makes that repetition unscorable. No failure is converted into a neutral theological position.

Reports give descriptive variation across complete repetitions, not confidence intervals. Native axis values stay on their original 0–100 scales; see [docs/methodology.md](docs/methodology.md) for pole direction and scoring limitations. Cost appears only for models with dated `pricing` in [configs/models.yaml](configs/models.yaml), using cache rates where configured. Costs are estimates from returned usage, not invoice totals.

Run artifacts include raw provider responses and request metadata. Keep them local unless reviewed for sensitive information; see [SECURITY.md](SECURITY.md) before sharing.

## Troubleshooting

| Problem | What to check |
|---|---|
| Missing API key | Fill the selected model's variable in `.env`, or export it in your shell. |
| HTTP 400/401/403/404 | Check model ID, account access, endpoint, and key region. Other models continue. |
| Invalid response, refusal, or truncation | Inspect the local run artifacts. These outcomes are terminal and are not silently reprompted. |
| Cannot resume after an edit | Restore the original request code/configuration/prompts/data, or start a new run to reuse matching saved replies. |
| Incomplete Standard/Deep mode | Use Quick; the missing source options/dimensions must be supplied before those modes can run. |
| Dollar budget reached | Raise `maxUSD` and resume, or keep the partial run. In-flight requests can overshoot the cap. |

## Development and publication

```bash
npm ci
npm run check                       # Publication file guard, TypeScript, offline tests
npm run data:prepare
npm run bench -- run --dry-run
npm audit --audit-level=moderate
```

[GitHub Actions](.github/workflows/ci.yml) runs these checks without model credentials, plus Gitleaks scans of history and the publication snapshot. Dependabot checks npm dependencies and pinned Actions weekly. Local file checks complement secret scanning; they cannot prove that no sensitive information exists.

See [CONTRIBUTING.md](CONTRIBUTING.md) for compatibility requirements, [SECURITY.md](SECURITY.md) for credential handling, and the [publication checklist](docs/publishing.md) for release steps and repository settings.

## Project layout

```text
configs/              Models, endpoints, and experiments
data/source/          Original questionnaire/scoring exports, unchanged
data/compiled/        Regenerable, git-ignored normalized dataset
src/dataset/          Parsing, validation, versioning, baseline compilation
src/scoring/          Pure, versioned extraction of the original API scoring
src/prompts/          Shared elicitation protocol and answer validation
src/providers/        Native HTTP adapters for six providers
src/runner/           Checkpoints, request budgets, locks, and resume
src/analysis/         Scoring, aggregation, Markdown and CSV reports
tests/                Offline tests and independent original-handler fixtures
reference/theocompass/ Original scoring oracle and upstream documentation
```

Only Quick mode is currently complete. Standard and Deep are rejected before calls because their source exports lack required answers and dimensions. The reference directory retains the unchanged original scorer and baseline compiler for independent parity tests. The unused web app, deployment setup, roadmap assets, and build scripts have been removed; see [reference/theocompass/README.md](reference/theocompass/README.md).

Read [docs/methodology.md](docs/methodology.md) and [docs/dataset-provenance.md](docs/dataset-provenance.md) before interpreting results. Alignment with TheoCompass's framework does not establish that an AI has personal beliefs or that its responses are free of bias.

## Attribution and licensing

Questionnaires, denomination baselines, and scoring behavior come from [TheoCompass/theocompass](https://github.com/TheoCompass/theocompass). The original scoring code and documentation are retained for provenance and independent compatibility checks; this benchmark is a separate project.

Original benchmark contributions are licensed under the [MIT License](LICENSE). Upstream code, data, documentation, and upstream portions of adaptations are excluded from that grant. No upstream license was found; this fork does not grant permission to redistribute or relicense that material. See [NOTICE.md](NOTICE.md) for scope and provenance.
