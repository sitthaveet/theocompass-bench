# Original scoring reference

This directory keeps the unchanged upstream code needed by `tests/helpers/original.ts` and the scoring parity tests:

- `scripts/build_precomputed.js`: independent denomination-baseline compiler.
- `theocompass-api/src/`: original scoring handler and its imported modules. The non-scoring routes remain because the unchanged handler imports them.
- `docs/`: original methodology and quiz explanations.
- `UPSTREAM_README.md`: original README, including upstream attribution. Its application and deployment instructions describe the former repository layout.

The web app, legacy client, roadmap data, deployment configuration, old test suite, and unused scripts were removed. These files are test references, not a separately installable or deployable application. Run the benchmark and all tests from the repository root.
