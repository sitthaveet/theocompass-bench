# Dataset provenance

The benchmark uses the original TheoCompass v2.0 exports supplied in this repository. The six consumed CSV/TSV source files are preserved unchanged in `data/source`; the TSV denomination export is authoritative for baseline compilation. The unused duplicate denomination CSV and roadmap assets have been removed.

The source commit and exact original API/precompute hashes are recorded in `tests/fixtures/scoring-original.json`, together with the six consumed source-file hashes and the baseline output hash. `reference/theocompass` retains the original API source and baseline compiler unchanged so parity tests can execute them as an independent oracle. Unused application code, deployment configuration, and scripts have been removed.

## Consumed exports

| Export suffix | Purpose |
|---|---|
| `QUESTION_MASTER.csv` | Question IDs, original wording, priority, category |
| `Hidden Dimensions.csv` | Question relevance weights for the 12 primary axes |
| `Unified Answer Scoring Matrix.csv` | Stable option IDs, wording, context, labels, coordinates |
| `Denominations & Doctrines_EXPORT.tsv` | Denomination metadata and accepted doctrine branches |
| `QUIZ_SEQUENCE.csv` | Included questions and display order for each mode |
| `FAMILIES.csv` | Family metadata and source provenance |

The exports contain 123 question definitions, 222 answer options covering 32 questions, 32 dimension rows, and 230 denominations. Quick includes 30 fully supported questions. Standard includes 58 questions, 26 lacking options/dimensions; Deep includes 123, 91 lacking options/dimensions. The compiler preserves all source definitions; execution validates the requested mode and rejects incomplete questionnaires before any provider calls.

The existing exports also contain duplicate Deep display orders and 30 unmatched doctrine entries among questions with answer options. Stable sorting retains source order for ties. Unmatched doctrine entries retain the original precompute's apathetic fallback; they are listed, rather than silently repaired, in the compiled dataset's diagnostics.

## Rebuild and versioning

Run `npm run bench -- prepare` to regenerate `data/compiled/dataset.json`. No Python, SQL generation, database, cache service, or archived application build is needed.

Each consumed source has a SHA-256 digest. The compiled dataset uses a deterministic SHA-256 over its schema version, source hashes, normalized records, mode lists, baselines, metadata, and diagnostics. It contains no build timestamps. Per-run snapshots preserve the exact compiled data; report/scoring commands verify the snapshot digest and recorded scorer before using it.

Source data changes are intentional benchmark-version changes. Keep the original provenance fixture as the compatibility record; add separately versioned fixtures when updating the questionnaire or scoring. The reference directory preserves upstream attribution in `UPSTREAM_README.md` and the original scoring/quiz documentation. No additional license or redistribution permission is inferred.

## Provider references

Adapter shapes and model IDs were checked against the providers' official documentation during implementation:

- [OpenAI Responses and GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)
- [Gemini generateContent structured output](https://aistudio.google.com/docs/structured-output?generate-content=true)
- [Anthropic structured output](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [DeepSeek models and model-version mapping](https://api-docs.deepseek.com/quick_start/pricing/)
- [Qwen structured output](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output)
- [Qwen OpenAI-compatible regional endpoints](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)
- [Grok 4.7 Responses API](https://docs.x.ai/developers/grok-4-7)

Documentation checks do not prove account access. Live smoke-test responses are stored locally as their own auditable runs; unavailable models are reported without substitution.
