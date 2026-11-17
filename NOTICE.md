# Attribution and licensing status

This benchmark derives its questionnaire, denomination baselines, and scoring behavior from [TheoCompass/theocompass](https://github.com/TheoCompass/theocompass).

The compatibility fixture records upstream commit `eb97951020d4a819c11c678f2259b80271eaa1dc`. Original material is retained in:

- `data/source/`: six original questionnaire and scoring exports.
- `reference/theocompass/`: unchanged original API source, baseline compiler, and upstream documentation.
- `tests/fixtures/scoring-original.json`: original scoring outputs and provenance hashes.
- `src/scoring/` and the baseline compilation logic: adaptations of the original scoring behavior.

The upstream README is preserved as [UPSTREAM_README.md](reference/theocompass/UPSTREAM_README.md). This benchmark is a separate project; no upstream endorsement is claimed.

## MIT license for original contributions

The benchmark contributors' original code and documentation are available under the [MIT License](LICENSE).

That license applies only to the contributors' original contributions. It excludes the upstream code, data, documentation, and upstream portions of adaptations identified above, as well as third-party dependencies, which retain their own licensing terms.

No upstream license file was found in the supplied repository or its GitHub license metadata. Permission to redistribute or relicense upstream material has not been established here. This fork's MIT license and attribution do not grant those permissions or relicense upstream material. Record any subsequently obtained upstream permission or license here.
