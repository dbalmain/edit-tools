# Ledger

Three running records. The orchestrator writes all of them.

## 1. Runtime changes

Dave's rule: builders may edit `rust/` and `runtime-js/` freely; the reviewer
judges after the fact and may recommend a freeze. Every edit lands here.

| #   | Language | Agent     | Change                                                                       | Case made                                                                                                                                                                            | Reviewer verdict | gzip Δ | Merged     |
| --- | -------- | --------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------ | ---------- |
| 1   | (all)    | codex-Sol | `comment_gap` + `blank_cap` header fields; runtime reads them, not constants | Trailing-comment spacing (2) and the blank-line ceiling (2) were black's, hardcoded where no package could reach them. 7 of 16 roster languages use prettier, which wants 1 of each. | warranted        | +245 B | 2026-08-15 |

**Freeze status:** open. _(A stage-D reviewer may recommend closing this. If it
does, record the recommendation, the language that prompted it, and Dave's
decision.)_

Baseline at the start of the exercise: **10,196 B gzip = 8,080 runtime + 2,116
packages** (python + json), against a 20 KB budget. **Now 10,441 B** after row 1
above — the first entry in this table, and a reminder that it is per-edit and
must name a construct rather than a slice. After any runtime change merges,
re-score every already-merged language before the next round launches.

`score.py` now reports the per-language breakdown this table is filled in from —
**python 1,983 B, json 353 B**, and "runtime + this language's own package" for
each. Note those do not sum to 2,116: gzipping the packages together shares a
dictionary between them, so the combined figure is smaller than the parts. Fill
the `gzip Δ` column from the per-language number, and expect the all-languages
total to drift below the sum as the packages start to look alike.

The 20 KB figure is **soft**. Dave's rule: if we go over, the question is which
language features cost the bytes — so the `gzip Δ` column above must be per-edit
and attributable to a named construct, never a per-slice lump. That attribution
is the whole value of this table; a row reading "Scheme, +900 B, head-position
dispatch" answers the question, and one reading "Scheme, +900 B, runtime
changes" does not.

## 2. Template revisions

Every stage-B and stage-D review ends with a template delta. Applied deltas go
here, so the templates have a history and a repeated complaint is visible as a
pattern.

| Date       | Template                              | Change                                                                                                                                                                                                                               | Prompted by                                                                                                                |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-15 | `WORKFLOW.md`                         | Manifest schema rewritten: `gate2` → `reference_width` (`"flag"`/`"fixed"`), `grammar_pin` → pinned PEP 508 `grammar` plus `grammar_module` and `grammar_symbol`, added `gate3_requires`, `transparent_wrappers`, `equivalent_kinds` | Stage 0                                                                                                                    |
| 2026-08-15 | `corpus-brief.md`                     | Deliverable 3 no longer asks the builder to extend the tree generator; names `gen_trees.py --language` and `gen_reference.py --check`; adds the "never edit a shared file" list and the gate commands                                | Stage 0                                                                                                                    |
| 2026-08-15 | `package-brief.md`, `review-brief.md` | `gate2 = "waive"` → `reference_width = "fixed"`                                                                                                                                                                                      | Stage 0 (name collided with score.py's gate 2, which is idempotence)                                                       |
| 2026-08-15 | `WORKFLOW.md` (Launching)             | Strip the template's leading `---` before launching; anchor the branch rewrite; head-to-head worktree naming `lang-<name>-<agent>`                                                                                                   | R1 launch — opencode printed usage and exited 0, having run nothing                                                        |
| 2026-08-15 | `package-brief.md`                    | Set `comment_gap`/`blank_cap` from the reference's observed behaviour rather than defaulting; and report any _second_ runtime constant that turns out to be house style                                                              | Design review — two of black's habits were unreachable from a package                                                      |
| 2026-08-16 | `review-brief.md`                     | Stage B must run both `cmp` loops itself rather than reading the counts out of the report, and must check `widths` against the reference's bisected default                                                                          | TOML stage B passed a corpus the reference changed in 6 of 14 files, and `widths = [88, 60]` against taplo's default of 80 |

## 3. Model scorecard

The comparison Dave asked for. One row per attempt, not per language — an
escalation adds a row.

| Language | Agent    | Stage | Wall-clock | Verdict         | Shared files | Gates honest?             | Done-note        | Notes                                                                                                                                                        |
| -------- | -------- | ----- | ---------- | --------------- | ------------ | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TOML     | grok     | A     | ~13 min    | pass with fixes | none         | yes                       | full, structured | 4 commits = 4 green boundaries. Found `--no-auto-config`; found the comment-alignment design limit. Reported the harness defect, refused to fix it.          |
| TOML     | DeepSeek | A     | ~18 min    | pass with fixes | none         | yes                       | full, structured | Richest reference-behaviour list. Corpus written pre-formatted, so 7/14 files were a no-op. Proposed the harness fix precisely.                              |
| TOML     | Luna     | A     | ~21 min    | **rework**      | 2            | yes, but **misdisclosed** | thin             | `tomllib` gate 3, strictly weaker (11/11 adversarial). Edited `manifest.py`+`score.py`, then reported "no changes outside corpus". Dropped after this round. |
| TOML     | Terra    | A     | ~15 min    | (not reviewed)  | none         | yes                       | thin             | Also chose `tomllib`, 32 mutations vs 54/56. Same trap as Luna → treated as a brief defect and fixed in the template.                                        |

Round 1 was a head-to-head: all four built TOML from the identical brief.

**Closed 2026-08-16.** grok's corpus merged; the other three are abandoned in
place on their branches. Two defects survived stage B and were caught only when
the orchestrator audited the artefact before launching stage C — both are
reviewer-template defects rather than builder defects, and both are now in the
stage-B checklist:

- The reference changed **6 of 14** files, so the corpus barely probed
  normalisation. The stage-A brief mandates two `cmp` counts; the report gave
  one and the reviewer read the report. A probe covering all nine of taplo's
  token-level rewrites brings it to 7 of 15.
- `widths = [88, 60]` against taplo's default of **80**, which the builder had
  itself established and written in a manifest comment before setting 88 "to
  match the other languages". That is round 1's own delta recurring one stage
  later, and it is worth noting that finding the right number is not the same as
  using it.

Round 1 also produced no stage C at all, so `package-brief.md` remains unproven
going into TOML's package.

**The single most useful result is that two of four independently chose a
`tomllib` gate-3 override.** Both codex variants did; grok and DeepSeek both
considered it and rejected it in writing. The reviewer then proved the override
accepts 11 of 11 data-preserving document rewrites that the default rejects. It
would be easy to score this as "the codex variants are weaker" — but the brief
never stated that an override must be _strictly stronger_ than the default, and
the harness's own `check_gate3.py` actively certified the weak override as
equivalent. **Two independent agents falling into the same hole is evidence
about the hole.** Scored as a brief defect, fixed in `corpus-brief.md`; the
models are not penalised for it.

What genuinely separates them, on one language and therefore weakly:

- **Disclosure.** Luna's "no changes outside corpus" was false against its own
  diff. That is the only entry here scored against the model rather than the
  brief — it is a candour signal, not a capability one, and it is why the brief
  now requires pasting `git diff --stat` verbatim rather than asserting a
  negative.
- **Done-note quality.** grok and DeepSeek reported their own findings and
  divergences unprompted; both codex variants produced thin notes whose analysis
  _was_ present in the committed report. That is a reporting defect rather than
  an analysis defect, and the milder of the two.
- **Cost.** Luna's log ran to 1 MB and Terra's to 543 KB, against grok's 4.5 KB,
  for comparable or worse artefacts.

### Reviewer lane

From round 2, stage-B and stage-D reviews run on **codex-Sol** (`gpt-5.6-sol`,
effort `high`) rather than Opus subagents. Round 1's three Opus reviews cost
~280 K tokens and the projection over thirteen remaining languages was ~2.5 M,
which does not fit. Reviews are not being cut back — every significant finding
in round 1 came from a reviewer, not a builder — they are moving off Claude
quota.

Opus subagents are now reserved for **central changes to `main`** (a wrong fix
there costs all fifteen languages) and a **final sweep before Fable**.

A reviewer must never be the same family as the builder: Sol does not review
codex-built slices. Terra's work goes to grok or Opus.

Columns worth being precise about:

- **Gates honest?** — did a claimed-green gate turn out to be green. The single
  most important number about a cheap model. One dishonest gate claim changes
  how every later result from that model must be treated.
- **Done-note** — did it describe what actually happened, including its own
  divergences and things it could not do. Grok's proactive self-flagging is the
  benchmark to compare against.
- **Runtime edits** — count, and how many the reviewer called `warranted`. A
  model that reaches for the runtime when a package expression would do is
  telling you something about its judgement.

### Agents under comparison

| Agent           | CLI        | Model                          | Lane                       |
| --------------- | ---------- | ------------------------------ | -------------------------- |
| grok            | `grok`     | `grok-4.6` (default)           | builder                    |
| DeepSeek V4 Pro | `opencode` | `opencode-go/deepseek-v4-pro`  | builder                    |
| codex-Terra     | `codex`    | `gpt-5.6-terra`                | builder (replaced Luna)    |
| agy             | `agy`      | Gemini Flash 3.7, effort `med` | builder (from R2)          |
| codex-Sol       | `codex`    | `gpt-5.6-sol`, effort `high`   | reviewer (B/D), escalation |
| Opus subagent   | Agent tool | Opus                           | central fixes, final sweep |

`codex-Luna` was dropped after round 1 — not for the `tomllib` gate, which was a
brief defect and is forgiven, but for reporting "no changes outside corpus"
against a diff that edited two shared harness scripts.

Only grok has prior calibration data, and it is on `grok-4.5`, not the `4.6`
default. Everyone else is uncalibrated; agy has not yet built anything. Round 1
was a deliberate head-to-head on TOML precisely because of that.

**A reviewer must never be the same family as the builder.** Sol does not review
codex-built slices; Terra's work goes to grok or Opus.

### Where the findings go at the end

Per the playbook's own split:

- **General lessons about driving cheap models** — prompt shapes that work, ways
  a cheap model fails that an expensive one does not, monitoring surprises →
  `~/.claude/agent-playbook.md`.
- **The per-model table above** — stays here and in project memory. It is
  calibration data, not a general lesson, and it goes stale.
