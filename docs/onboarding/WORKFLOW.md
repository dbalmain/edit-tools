# Language onboarding workflow

How a new language gets a corpus, a harness entry and a doc-rules package —
built by cheap foreign agents, reviewed by Opus, merged by the orchestrator.

The point is not fifteen formatters. The point is to find where the design
breaks. A language that refuses to fit is a better result than one that fits
quietly, provided we learn why.

## Roles

| Role             | Who                                   | Does                                                                  |
| ---------------- | ------------------------------------- | --------------------------------------------------------------------- |
| **Orchestrator** | main thread                           | launches, monitors, merges, revises templates, keeps the ledger       |
| **Builder**      | grok / codex-Luna / opencode-DeepSeek | corpus + harness entry (stage A), package + report (stage C)          |
| **Reviewer**     | Opus subagent                         | reviews stage A (stage B) and stage C (stage D); may fix small things |
| **Escalation**   | codex-Sol, then an Opus subagent      | re-attempts a language the builder could not land                     |

The orchestrator **does not read the code**. It reads reports, review verdicts
and `score.json`. Everything else is delegated. This is the whole reason the
main thread survives fifteen languages.

## Pipeline

Stages A–D run per language. A and C are the same builder in the same worktree,
sequentially. Different languages run in parallel, one worktree each.

```
  A  builder: corpus + harness entry           →  corpus/src/<lang>/, harness/languages/<lang>.toml
  B  reviewer: is the corpus honest?           →  verdict + template delta
  C  builder: doc-rules package + test run     →  packages/<lang>.json, corpus/reports/<lang>/
  D  reviewer: is the package mergeable?       →  verdict + template delta
  E  escalate to codex-Sol, back to D
  F  escalate to an Opus subagent, back to D
  G  escalate to Dave
```

Stage D's verdict is one of:

- **merge** — orchestrator merges the worktree into `main`
- **merge after fixes** — reviewer makes the fixes in the worktree itself and
  re-verifies, then merge. Reserved for changes a reviewer can make without
  re-deriving the design: a wrong delimiter, a missing rule, a stale number in
  the report.
- **escalate** — anything larger. Go to E, then F, then G.

An escalated attempt starts from `main`, not from the failed worktree, unless
the reviewer says explicitly that the failed work is a useful base. The value
carried forward is the reviewer's **diagnosis and list of disproved
approaches**, pasted into the escalation prompt — not the failed diff. A cold
start with a good diagnosis beats a warm start with a wrong frame.

## Stage 0 — prerequisites (must land before round 1)

Two things in the current harness make fifteen languages impossible, and both
are the orchestrator's to fix (via an Opus subagent) before any builder runs:

1. **`harness/gen_trees.py` hardcodes a `LANGUAGES` map.** Three builders each
   appending to one dict is a three-way conflict every round. Replace it with
   one declarative file per language, `harness/languages/<lang>.toml`, so a
   builder **adds a file** and never edits a shared one.

2. **`harness/check_gate3.py` is Python- and JSON-specific.** It compares
   meaning via `ast.dump(ast.parse(...))` and ordered `json.loads`. Neither
   generalises. Stage 0 must add a **generic default** that works for any
   tree-sitter grammar:

   - reparse the formatted output with the same grammar
   - the tree of **named** nodes — kind plus leaf text, ignoring anonymous
     punctuation and extras — must be identical to the original's
   - the reparse must contain no `ERROR` or `MISSING` node
   - the **multiset of comment texts** must be unchanged (position may move,
     content may not)

   A language may override this with something stronger when a real semantic
   checker exists — Python `ast.dump`, JSON/YAML/TOML round-trip through their
   own loaders. The override is declared in the language's manifest. The default
   is what lets fifteen languages start at once.

Stage 0 also freezes the manifest schema the templates depend on:

```toml
# harness/languages/<lang>.toml
name        = "toml"
extensions  = [".toml"]
grammar     = "tree_sitter_toml"        # PyPI package
grammar_pin = "0.7.0"
reference   = "nix run nixpkgs#taplo -- fmt --stdin-filepath x.toml -"
reference_version = "taplo 0.9.3"       # observed, recorded for reproducibility
widths      = [60, 80]                  # narrow, and the reference's own default
gate2       = "measure"                 # or "waive" — see Go, below
gate3       = "default"                 # or a named override
```

## Reference formatters

Almost nothing is installed globally on this machine. Every reference is invoked
through a pinned runner and both the command and the observed version string go
in the manifest, so regenerating the corpus is reproducible and a version bump
shows up as a diff.

| Language                | Reference           | Invocation                                  |
| ----------------------- | ------------------- | ------------------------------------------- |
| Rust                    | rustfmt             | on PATH                                     |
| Go                      | gofmt               | on PATH                                     |
| Aven                    | `aven fmt`          | on PATH (`~/.local/bin/aven`)               |
| Python                  | black               | `uvx black==<ver>` (already in the harness) |
| JS/TS/CSS/HTML/XML/YAML | prettier            | `npx --yes prettier@<ver>`                  |
| TOML                    | taplo               | `nix run nixpkgs#taplo`                     |
| Haskell                 | ormolu              | `nix run nixpkgs#ormolu`                    |
| Kotlin                  | ktfmt               | `nix run nixpkgs#ktfmt`                     |
| Ruby                    | syntax_tree         | `nix run nixpkgs#rubyPackages.syntax_tree`  |
| Scheme                  | emacs `scheme-mode` | `nix run nixpkgs#emacs -- -Q --batch …`     |

Three of these need a note in the brief, because they break the "reference
reflows to a width" assumption the python corpus was built on:

- **gofmt has no width setting.** Go is tab-indented and does not reflow. Its
  manifest sets `gate2 = "waive"` and a single width; gate 4 is agreement with
  gofmt's one fixed output. This is the first real stress on the template and is
  deliberately placed early.
- **ormolu has a fixed style**, similarly non-negotiable.
- **emacs `indent-region` only re-indents; it does not re-flow lines.** So
  Scheme's gate 4 is honestly _indentation_ agreement, not layout agreement. Say
  so in the report rather than overclaiming. If that proves too weak,
  `nix run nixpkgs#racket` → `raco fmt` is the fuller alternative.

## Rounds

Three builders in parallel, one language each, one worktree each.

**Round 1 is a head-to-head: all three builders get the same language.** TOML —
small, complete, unambiguous reference. This is the only clean three-way model
comparison the whole exercise offers, and it exercises the template three times
at the moment the template is most likely to be wrong. Two of the three results
get thrown away; that is the price and it is small.

Rounds 2 onward assign one language per builder, rotating so each builder sees
each difficulty tier.

| Tier | Shape                 | Languages                                |
| ---- | --------------------- | ---------------------------------------- |
| T1   | data / regular        | TOML, YAML, CSS (JSON already in)        |
| T2   | C-family, curly-brace | Go, Rust, Kotlin, JavaScript, TypeScript |
| T3   | markup                | XML, HTML                                |
| T4   | unusual shape         | Ruby, Scheme, Haskell, Aven              |

Aven goes last on purpose: it is the only language with no guaranteed
tree-sitter grammar (stage A must locate or build one from
`~/w/clex/aven-lang/editors/`), it is layout-sensitive, and it supports
user-declared custom operators. It deserves the most mature template.

## Runtime changes

Dave's decision: builders may edit `rust/` and `runtime-js/` freely. The
reviewer judges **after the fact** whether the change was warranted, pushes back
if not, and may recommend freezing the runtime from that point on.

Mechanically that means:

- Every runtime edit appears in the report with the case for it: what the
  package could not express, what was tried first, what the size cost is.
- The stage-D reviewer verdicts each edit **warranted / unnecessary /
  needs-redesign**, and states whether it now recommends a freeze.
- Runtime edits **land as their own commit**, sequenced by the orchestrator
  between rounds — not merged silently with a language package.
- After any runtime change merges, **every already-merged language is
  re-scored** before the next round launches. Otherwise size stops being
  comparable and later languages inherit an unreviewed runtime.
- If two builders change the runtime in the same round, the orchestrator merges
  one and re-runs the other's package against it. The reviewer flags the clash.

### Size accounting

Current: 10,196 B gzip = 8,080 runtime + 2,116 packages (python + json), against
a 20 KB budget.

Fifteen packages will dominate a single total, and that would punish language
# 15 for arriving late. So the reported number is **runtime + this language's own
package**, measured against 20 KB. The all-languages total is reported too, as
information. _(Orchestrator assumption — flag to Dave if the budget was meant as
a single hard total.)_

## Merge bar (stage D)

- **Gates 1–3 are hard.** Idempotence, width compliance and non-destruction must
  be perfect. A formatter that loses code is not a formatter.
- **Gate 4 is reported, with a floor.** Reference agreement measured at both
  widths, floor of **70% of corpus files**. Every divergence must be named and
  classified as **design limit**, **package bug**, or **reference quirk**. An
  unclassified divergence is an automatic escalate — the classification is the
  actual deliverable.
- **Refusal parity** counts as agreement only when _both_ runtimes refuse.
- Both runtimes must produce byte-identical output on every corpus file at every
  width. A Rust/JS divergence is a stage-D reject regardless of gate scores.

## Monitoring builders

Playbook rules, no exceptions:

- Capture the **PID at launch**; poll `/proc/<pid>`. Never a `pgrep -f` pattern
  — it self-matches, or matches nothing and declares success by absence.
- Liveness is **log growth** (`wc -c` against the last value _this watcher_ saw)
  or a new commit in the worktree. Never log mtime.
- Staleness timers start from a change the watcher itself observed, not from
  wall-clock.
- Declare a stall only after ~8 minutes with neither log size nor
  `git rev-parse HEAD` moving _and_ the PID still alive.
- A live process is not a running agent. Confirm idleness with a CPU delta
  (`ps -o time=` twice, ~15s apart).

## Prompt invariants

Every builder and escalation launch, without exception:

- One reviewable slice; files, names and expected outputs stated concretely.
- Style guides referenced **by path**, never pasted.
- Pushback invited in writing: _"if the framing is wrong, say so and propose the
  better shape — a correct 'this is actually X' is worth more than an
  implementation of my guess."_
- Disproofs stated as disproofs; evidence marked as evidence, guesses as
  guesses.
- Gates green with zero warnings, fixing until green.
- **"Do not run `git push` under any circumstances."**
- Commit at each green boundary, not one commit at the end.
- Named `git add` paths, never `git add -A`.
- A **done-note**, not a transcript.
- Orchestrator redirects output to a log itself.

## Launching

```sh
# grok
grok --cwd <worktree> --prompt-file <abs-prompt> \
  --always-approve --no-subagents > <abs-log> 2>&1

# codex (Luna for builders, Sol for escalation)
codex exec -C <worktree> -s workspace-write --skip-git-repo-check \
  -m gpt-5.6-luna -o <abs-done-note> - < <prompt> > <log> 2>&1

# opencode (DeepSeek V4 Pro)
opencode run --dir <worktree> -m opencode-go/deepseek-v4-pro --auto \
  "$(cat <prompt>)" > <log> 2>&1
```

Worktrees: `/home/dave/w/editor-tools-wt/lang-<name>/` on `wt/lang-<name>`,
based on `main`. One language per worktree, one agent per worktree, always.

## The revision rule

Every stage-B and stage-D review ends with a **template delta**: what in the
brief misled, what was missing, what was noise. The orchestrator applies deltas
to `templates/` _before the next round launches_ and records the change in
`LEDGER.md` against the language that prompted it.

If a run surfaces nothing, the delta section says nothing. Do not manufacture an
improvement.

## Records

- `LANGUAGES.md` — roster and status board; the orchestrator's single source of
  truth for what is in flight.
- `LEDGER.md` — runtime-change ledger, template revisions, and the per-model
  scorecard.

At the end of the exercise the **general** lessons about driving cheap models go
into `~/.claude/agent-playbook.md`; the **per-model calibration table** stays in
`LEDGER.md` and project memory, per the playbook's own split.
