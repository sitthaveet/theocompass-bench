# Benchmark methodology

## What is measured

The benchmark records the theological position a model favors under the versioned SOUL-only protocol. It does not ask the model to imitate a denomination or claim personal faith. The system prompt asks which position the model's default response would express. It does not ask which option seems best supported. It asks the model not to select an option for its popularity, its place on a traditional/modern or orthodox/progressive axis, how cautious or decisive it is, or how socially acceptable or provocative it is. It also asks the model not to steer toward a neutral result, an extreme result, or any other alignment, and not to anchor certainty or tolerance at the midpoint or at either end. These instructions are an experimental condition, not proof that bias has been removed.

Each question is an independent conversation with no tools, search, history, denomination baselines, scoring weights, or theological-label metadata supplied. Original answer text and full context descriptions are included without rewriting. Options are labelled A, B, C… in display order; source option IDs are never shown, because their numbering reveals the canonical order. All models receive the same wording and answer order for a given repetition. Provider-specific native output controls are saved with the exact request.

The default run contains 30 Quick questions and three repetitions for each of six configured models. Option order is shuffled by default with a fixed seed, paired by question and repetition across models. This matters because the source lists options roughly from conservative to liberal: on the Quick questions the first option averages 23 on the question's relevant axes and the last averages 84. Under a fixed order, any primacy or recency preference would read as a theological lean. Shuffling turns that preference into noise that averages out over repetitions; the spread across repetitions therefore combines order sensitivity with generation variability and should not be described as pure sampling variability. Setting `shuffleOptions: false` restores the source order for a separate order-sensitivity experiment.

Provider-default reasoning and sampling are left unset rather than pretending different providers' effort/temperature scales are equivalent. The shared output ceiling and timeout still constrain generation. Request bodies, returned model IDs, finish state, and usage are retained; unreturned provider defaults are unknown, not inferred. Model aliases and serving infrastructure may change even when a configuration string is unchanged.

## Response contract

```json
{
  "status": "answered",
  "choice": "C",
  "certainty": 2,
  "tolerance": 2,
  "rationale": "A brief justification."
}
```

`status` is one of `answered`, `apathetic`, `hostile`, or `refusal`. An affirmed answer must give exactly one displayed option letter (case-insensitive); it is mapped back to the source option ID through the display order saved with each attempt, and the normalized answer stores that ID. Other statuses require `choice`, `certainty`, and `tolerance` to be JSON null. All fields are required; extra fields, arrays of selections, fenced JSON, invalid ranges, and empty/overlong rationales are rejected locally. The prompt requests one or two sentences; local validation caps rationale length at 2,000 characters and does not infer sentence boundaries.

Certainty is 0 Not Sure / 1 Leaning / 2 Pretty Sure / 3 Certain. It describes firmness of the expressed position, not factual knowledge or calibrated probability. Tolerance is 0 Salvation issue / 1 Opposed / 2 Discerning / 3 Charitable / 4 Extremely Accepting. It describes acceptance of alternative theological positions, not respect for people.

Apathetic silence means that, after comparing the options, the differences seem unimportant or none is closer to the model's default response than the rest. Being an AI or lacking personal faith is explicitly not a reason for silence (protocol v3); a model that declines on those grounds should report refusal, which is unscored and visible in coverage. In v1 smoke tests, three of six models chose apathetic silence on the first question for exactly that reason. Hostile silence rejects the question's framing or premises. The original scoring forces these to C=0/T=2 and C=3/T=1 respectively, so an AI-identity decline recorded as hostile silence would be scored as a firm exclusive stance. Protocol v3 tells the model to use refusal for that decline. Refusal is retained separately and never mapped to either silence or a midpoint answer. Provider-native refusal signals are retained even when no schema-shaped answer is returned.

## Scoring compatibility

Scoring version: `theocompass-api-v2-preserved-1`.

The baseline compiler reproduces the original precompute's longest-first exact-phrase matching of denomination doctrine strings, its split branches, and its missing-doctrine defaults. The pure scorer reproduces the quiz API's per-dimension similarity, priority/posture weighting, denomination-side split drag, rounding, family averages, and 14-axis fingerprint. The scorer retains legacy multi-select compatibility, although the benchmark response validator permits one selection.

Known discrepancies are deliberately pinned rather than corrected during extraction:

- API posture importance uses tolerance amplification `0.5 + (4 - T) / 2.5`; the original precompute uses `0.5 + (4 - T) * 2.5 / 4`.
- API dimensions are relevant at `>= 50`; precomputed denomination dimensions are present only at `> 50`. Missing branch coordinates therefore retain the API's neutral fallback.
- The API reads denomination tolerance using `T || 2`, so stored T=0 becomes T=2 in matching. Model-side T=0 remains zero.
- API fingerprint conversion treats an existing null option score as `Number(null) = 0`; matching uses a neutral 50 fallback for null.
- Silence contributes to denomination similarity but is excluded from primary fingerprint and certainty/tolerance averages. A wholly silent fingerprint falls back to 50.

The independent fixture records seven full Quick questionnaires evaluated by the unmodified original handler: first-option selections, last-option selections, extreme posture values, all apathetic, all hostile, mixed silence, and multi-select. Tests compare all denomination/family scores and every reported axis exactly. A separate hash pins the compiled per-question baselines for all 230 denominations. Tests also execute the archived handler through in-memory database/cache adapters without Cloudflare services.

Any mathematical correction must introduce a new scoring version and new expected results; do not update compatibility fixtures to disguise a changed formula.

## Axis direction

Values are native 0–100 coordinates, without frontend inversions.

| Axis | Low end | High end |
|---|---|---|
| theolconslib | Theological conservative | Theological liberal |
| socialconslib | Social conservative | Social liberal |
| counterpromodern | Counter-modernity | Pro-modernity |
| supernat | Supernatural | Natural |
| cultsepeng | Cultural separation | Cultural engagement |
| clericegal | Clerical | Egalitarian |
| divhumagency | Divine agency | Human agency |
| communindiv | Communal | Individual |
| liturgspont | Liturgical | Spontaneous |
| sacramfunct | Sacramental | Functional |
| literalcrit | Literal | Critical |
| intellectexper | Intellectual | Experiential |
| tolerance | Exclusive | Accepting |
| certainty | Unsure | Certain |

## Instrument neutrality

SOUL.md gives one selection criterion: closeness to the position the model's default response would express. Reasons not to pick an option are listed in symmetric pairs (traditional or modern, orthodox or progressive, majority or minority, cautious or decisive, socially acceptable or socially provocative) so that the debiasing instruction does not itself push in one direction. It also states that option order carries no meaning, and that neither a neutral nor an extreme overall result is a target.

## Missingness and aggregation

Only repetitions containing all 30 valid selections or explicit scored silences receive rankings. Refusals, invalid JSON, provider errors, truncations, and pending tasks remain in coverage/frequency reports. Incomplete repetitions are excluded from alignment aggregates without losing their diagnostics. Always read the complete-repetition count beside a model's aggregate; failure patterns can affect which repetitions are retained.

Each denomination's aggregate is the arithmetic mean of its original, rounded per-repetition match scores. Family matches retain the original arithmetic mean across member denominations, rather than selecting the closest member. Axis values are averaged across complete repetitions. Standard deviation uses the sample denominator `n - 1`, is absent for n=1, and is descriptive with three repetitions. No neutrality ranking, ground-truth correctness score, or confidence interval is inferred.

The report's response profile gives each model's answered, apathetic, hostile, refusal, and failure shares, and how many questions received the same option or silence type in every repetition. Models whose silence exceeds 25% of scheduled answers are flagged: TheoCompass scores silence as a position, so their denomination matches mostly reflect which denominations leave those doctrines unrecorded.

## Durability and replay

The manifest fingerprints the resolved experiment/models (except prices and the dollar budget, which only decide when to stop), dataset, SOUL, protocol/scoring versions, scorer source, request-shaping source code (everything under `src/` except `analysis/`, `scoring/`, and `cli.ts`), lockfile, package configuration, and TypeScript configuration. A new run copies completed replies to byte-identical requests (same repetition number) from earlier runs instead of resending them; copies are re-parsed with current code and marked with their source run and attempt, so a run that reuses replies is not an independent sample of the earlier one. `--fresh` disables reuse. Requests are journaled and synced before transmission; results are synced before they become terminal outcomes. Derived answer and score files can be rebuilt from the journal. A final partial journal line is discarded when execution resumes; malformed committed records cause an error.

Resume preserves terminal answers, silence, refusals, and errors. Started-but-unfinished calls consume an attempt and may be retried within the saved budget. A process crash or network timeout can therefore result in more than one billed request for an item; provider-side exactly-once execution is not claimed. A process lock prevents concurrent runners on the same run directory. Same-host dead-process locks are reclaimed; locks owned by another host require manual inspection.

Results are local and git-ignored. Authentication is attached only at transport time, authorization headers are never journaled, redirects are disabled, response headers are allow-listed, and known API-key strings are redacted before journal writes.
