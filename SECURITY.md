# Security

## Credentials and local runs

Store provider keys in the ignored `.env` file or process environment. `.env.example` contains empty key placeholders. Never add keys to model configuration, issues, screenshots, or pull requests. CI uses offline tests and needs no provider credentials.

Requests send the SOUL instructions, question text, and answer options to the configured provider endpoint. Review endpoint and model configuration before running. Local run artifacts contain prompts, raw provider responses, metadata, and usage; inspect them separately before sharing. Do not assume all provider-supplied text is safe to publish merely because known keys are redacted.

`npm run check:publication` rejects local/credential files and checks publication candidates against configured API-key values. Gitleaks in CI scans the repository snapshot and all fetched Git history. These are complementary checks, not a guarantee that every secret can be detected.

## Reporting a vulnerability

Use the destination repository's **Security → Report a vulnerability** feature when available. Do not post credentials or exploit details in a public issue. If private reporting is unavailable, ask a maintainer for a private channel without including sensitive details.

If a credential was exposed, revoke or rotate it with the provider first. Removing the current file does not remove old Git objects, forks, or previously downloaded copies. Coordinate any history cleanup with the repository owner.

This is a local CLI, not a hosted service. The original API code under `reference/` is retained only for offline scoring tests and should not be deployed.
