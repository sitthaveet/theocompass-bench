# Publication checklist

## Release setup and upstream rights

- [x] License original benchmark contributions under MIT; see [LICENSE](../LICENSE) and its scope in [NOTICE.md](../NOTICE.md).
- [ ] Confirm redistribution and derivative-work permissions for the upstream TheoCompass code and data. Record any applicable license and notices in [NOTICE.md](../NOTICE.md).
- [x] Use [sitthaveet/theocompass-bench](https://github.com/sitthaveet/theocompass-bench) as the destination fork. Keep `TheoCompass/theocompass` as the upstream remote; inspect `git remote -v` before any push.

The MIT grant covers original benchmark contributions only. Upstream material retains its existing licensing status; this fork does not establish permission to redistribute or relicense it. Keep any obtained permission and required notices documented separately.

## Verify the exact content

```bash
npm ci
npm run check
npm run data:prepare
npm run bench -- run --dry-run
npm audit --audit-level=moderate
git diff --check
git status --short
git diff --cached --stat
```

Review the staged diff before committing. Confirm that the source, tests, lockfile, documentation, and `.github/` configuration are included. Confirm that `.env`, raw results, generated datasets, credentials, local editor/agent state, and scanner reports are absent. `.gitignore` does not protect files already tracked or files forcibly added.

## Scan secrets, including history

Install [Gitleaks](https://github.com/gitleaks/gitleaks) locally; CI pins version 8.30.1 and verifies its release checksum. Run:

```bash
gitleaks git . --log-opts=--all --redact --no-banner
```

This scans existing commits, not uncommitted edits. After committing the intended release locally, inspect and scan exactly the committed snapshot:

```bash
snapshot_dir=$(mktemp -d)
git archive HEAD | tar -x -C "$snapshot_dir"
gitleaks dir "$snapshot_dir" --config .gitleaks.toml --redact --no-banner
```

The scanner configuration permits only the SHA-256 `apiHash` provenance field in the original scoring fixture; default credential rules remain enabled. Keep reports private and redacted. If a real secret is found, revoke/rotate it, remove it from publication files, and coordinate history cleanup before pushing. Do not silently suppress a real credential.

## Destination repository settings

- Enable GitHub secret scanning/push protection and private vulnerability reporting where available.
- Require the `Offline checks` and `Secrets and history` CI jobs before merging.
- Enable dependency alerts and review Dependabot updates.
- Set the repository description and topics after choosing its final name. Suggested description: “Reproducible CLI benchmark of theological positions expressed by AI models using TheoCompass questionnaires and scoring.”
- Review existing branches and tags if publishing the original history: deleted files remain available in old commits.
- Run an optional live smoke test with your own keys, then review its failures before claiming model compatibility. Do not upload raw run directories automatically.

For shared benchmark results, include the model IDs and serving dates, experiment/protocol/scorer versions, dataset and SOUL hashes, option ordering/seed, coverage and refusals, and whether replies were reused. Review each artifact for sensitive data before sharing. Do not describe the output as a measurement of an AI's personal beliefs.
