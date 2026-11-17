# Contributing

Use Node.js 24 or later. From the repository root:

```bash
npm ci
npm run check
npm run data:prepare
npm run bench -- run --dry-run
```

These checks require no API keys and make no provider calls. Live smoke tests and full runs incur provider charges; run them only with your own keys and budget. See the [README](README.md) for setup.

Keep changes focused. Explain the problem, the resulting behavior, and the checks you ran. Update usage instructions when commands or configuration change.

## Preserve benchmark compatibility

- Treat `SOUL.md`, prompt wording, option ordering, model settings, and source data as experimental conditions. Document changes in [the methodology](docs/methodology.md).
- Keep `data/source/` and `reference/theocompass/` unchanged for compatibility work. The original handler and baseline compiler provide an independent scoring oracle.
- Preserve upstream file bytes, including line endings. `.gitattributes` disables text normalization for the source exports and scoring references so provenance hashes survive clones on different platforms.
- Keep the original scoring fixtures. Add versioned fixtures for intentional scoring or questionnaire updates, with updated provenance.
- Use mocked HTTP responses in tests. Do not add live API calls or model credentials to CI.
- Request, configuration, dependency, and prompt changes can invalidate resume fingerprints. Report changes alone can be regenerated offline. Matching paid replies can be reused in a new run.

## Before opening a pull request

Run the checks above and inspect `git diff --cached`. Keep `.env`, raw results, generated datasets, credentials, and local editor/agent state out of the change. Run Gitleaks on the files and history as described in the [publication checklist](docs/publishing.md).

Do not submit confidential data or material you lack permission to contribute. Original benchmark contributions use the [MIT License](LICENSE). Preserve upstream attribution and keep upstream permissions separate; see [NOTICE.md](NOTICE.md).
