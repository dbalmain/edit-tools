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

## Stage 0 — prerequisites (landed)

Two things in the harness made fifteen languages impossible. Both are fixed;
this section is now the description of what a builder is working against.

1. **One file per language.** `gen_trees.py`'s `LANGUAGES` dict is gone, and so
   are `score.py`'s `PARSERS`, its global `WIDTHS`, its `semantics()` and its
   `black_agreement()`. Every per-language fact lives in
   `harness/languages/<lang>.toml`. A builder **adds a file** and never edits a
   shared one.

   The same rule had a second half that was easy to miss. The harness scripts
   are `uv run --script` files, and their grammar dependencies used to live in
   an inline `dependencies = [...]` block — which is _also_ a shared file. The
   scripts now declare only `tree-sitter` and re-exec themselves under
   `uv run --with <pinned grammar>` computed from the manifests. Adding a
   grammar is a line in the new language's own manifest.

2. **A generic gate 3**, in `harness/gate3.py`, in two layers.

   **Universal, no opt-out, every language:** the reparse must contain no
   `ERROR` and no `MISSING` node, and the sequence of the grammar's **extra**
   nodes — which is where `comment` lives in every grammar checked so far — must
   be unchanged. Order is compared, not just the multiset; the ordered check is
   strictly stronger and black passes it on the whole corpus, so there was no
   reason to accept the weaker one. This layer sits _underneath_ any override,
   which closes a real hole: ordered `json.loads` cannot see a comment at all,
   so JSON could previously drop every comment in a file and pass gate 3.

   **Structural, per language:** either the generic default — the tree of
   **named** nodes, kind plus leaf text, ignoring anonymous punctuation and
   extras — or a stronger checker the manifest names. `gate3 = "python"` loads
   `harness/languages/python_gate3.py`, which must define
   `signature(text) -> object | None`. An override is a file of its own, so
   declaring one is still adding a file.

   **The naive named-node comparison does not work, and this is the important
   part.** Black — a correct formatter, therefore the oracle — parenthesises an
   expression when it wraps it, and the raw comparison rejects black on **7 of
   the 26** python corpus runs for exactly that reason. This project's own
   contract sanctions the same move ("a balanced parenthesis pair around one
   layout region when its group breaks"), so a gate that rejects it is not
   strict, it is wrong.

   Eliding paren-wrappers by heuristic is worse: in Scheme parentheses _are_ the
   structure, `(f)` is a list containing `f`, and the heuristic would let a
   formatter turn a call into a bare symbol and pass. So paren transparency is
   **declared per language, by node kind**, and the default is the strict end. A
   language that declares nothing gets a gate that rejects its own correct
   output the first time the formatter wraps something — loudly, with the node
   kind named. Over-strict is a message; under-strict is corrupted source.

   `harness/check_gate3.py` pins all of this as a gate rather than a claim, and
   runs in `./test.sh`. It proves three things: the reference formatter passes
   for every language; the generic default reaches the **same verdict** as every
   stronger override on the same input; and the gate still **rejects** a dropped
   comment and a dropped token. The third matters most — a gate that accepts
   everything passes the first two perfectly.

   As measured today: 0 disagreements between the generic default and both
   `ast.dump` and ordered `json.loads`, over 30 reference outputs, with 36
   destructive mutations rejected.

### The manifest schema

```toml
# harness/languages/toml.toml   —   the filename must match `name`
name = "toml"
extensions = [".toml"]

# A pinned PEP 508 requirement, not a bare name: the committed trees are ground
# truth and a silent grammar bump rewrites them. An unpinned `grammar` is a load
# error. Non-PyPI grammars go here too: `tree-sitter-x @ git+https://…`.
grammar = "tree-sitter-toml==0.7.0"
grammar_module = "tree_sitter_toml"   # importable module — NOT derived from the above
grammar_symbol = "language"           # optional, defaults to "language"

# Exact fenced-info names that may select this language as an embedded region.
# Empty opts out; aliases are unique across all language manifests.
injection_aliases = ["toml"]

# Optional host shapes. The node has direct info/content children of these types.
# Markdown will declare this when it onboards; ordinary guest manifests omit it.
# [[injections]]
# node = "fenced_code_block"
# info = "info_string"
# content = "code_fence_content"

# Shell command. Source on stdin, formatted source on stdout. `{width}` is
# substituted. Note that some references need a fake filename to infer the
# language from stdin (`--stdin-filepath x.toml`), and that nothing is installed
# globally — use a pinned runner.
reference = "nix run nixpkgs#taplo -- fmt -o column_width={width} --stdin-filepath x.toml -"
reference_version = "taplo 0.10.0"    # observed, not assumed
reference_width = "flag"              # "flag" honours {width} · "fixed" has no width knob

widths = [60, 80]                     # narrow, and the reference's own default

gate3 = "default"                     # or a named override → languages/<name>_gate3.py
gate3_requires = []                   # extra pins the override needs, e.g. ["pyyaml==6.0.2"]

# Used only by gate3 = "default". Both default to empty, which is the strict end.
transparent_wrappers = []             # node kinds the formatter may add or remove
                                      # around one child, e.g. parenthesized_expression
equivalent_kinds = []                 # kinds that are the same thing under a different
                                      # name, e.g. [["pattern_list", "tuple_pattern"]]
```

`injection_aliases` is required because info-string spelling is a language fact,
not a list in `gen_trees.py`; `injections` is optional and describes a host
grammar's extraction shape. `harness/languages/python.toml` and `json.toml` are
the two worked examples and carry the reasoning for each field they set. Every
field is validated on load:
an unknown key, an unpinned grammar, a `name` that does not match the filename,
a `{width}` placeholder that a `"fixed"` reference would never use, and a
`"fixed"` reference with more than one width are all one-line errors naming the
file and the field.

### Field names that changed from the first sketch of this doc

- **`gate2` is now `reference_width`, with values `"flag"` / `"fixed"`.** The
  old name collided head-on with `score.py`, where gate **2 is idempotence** and
  has nothing to do with widths. Three numbering schemes for "gate N" already
  exist in this repo; the manifest now describes the reference formatter instead
  of pointing at one of them.
- **`grammar` / `grammar_module` / `grammar_symbol` replace `grammar` +
  `grammar_pin`.** The distribution name, the importable module and the accessor
  are three independent facts. `tree-sitter-typescript` exposes
  `language_typescript()` and `language_tsx()`; `tree-sitter-xml` exposes
  `language_xml()` and `language_dtd()`. Both are on the roster, and neither
  works with a hardcoded `.language()`.
- **Reference output is generated once and committed** to
  `corpus/reference/<lang>__<stem>@<width>.txt` by `harness/gen_reference.py`.
  The scorer reads those files; it never runs a reference formatter. Running
  fifteen references live would put a network fetch and a few hundred process
  spawns inside `./test.sh`, and `build.sh` promises to be hermetic.
  `gen_reference.py --check` reports drift when a reference changes under us.
- **Trees stay flat**, `corpus/trees/<lang>__<stem>.tree.json`. The name already
  namespaces by language, so there is no shared file and no conflict.

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
  manifest sets `reference_width = "fixed"` and a single width; gate 4 is
  agreement with gofmt's one fixed output. This is the first real stress on the
  template and is deliberately placed early.
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

Current: 10,441 B gzip = 8,312 runtime + 2,129 packages (python + json), against
a 20 KB budget.

Fifteen packages will dominate a single total, and that would punish language

# 15 for arriving late. So the reported number is \*\*runtime + this language's own

package\*\*, measured against 20 KB. The all-languages total is reported too, as
information.

**20 KB is a soft budget, not a gate.** Dave's rule: going over is not a
failure, it is a question — _which language features cost the extra bytes?_ So
the accounting must be **attributable**, and that is the real requirement here.
Every runtime edit records its own gzip delta in `LEDGER.md` against the
language and the construct that forced it, so that when the total crosses 20 KB
we can answer "Scheme's head-position dispatch cost 900 bytes, Ruby's block-form
selection cost 400" rather than "it got bigger".

A builder must therefore report the size delta of each runtime edit separately,
not one lump figure for the slice. A lumped figure is a stage-D fix, not a
reject — but it makes the ledger useless, so ask for it every time.

## Merge bar (stage D)

**Read the scorer's numbering, not this document's history.** `score.py` has
gates `0-coverage`, `1-agreement`, `2-idempotence`, `3-nondestruction`, and then
_measures_ starting at `4-overflow-lines`. The four "gates" this workflow was
first written around were a different numbering, and the mismatch has already
produced one wrong instruction (below) and one wrong manifest field name
(`gate2`, renamed to `reference_width` in Stage 0). When in doubt, the scorer is
authoritative and this file is not.

- **Coverage, idempotence and non-destruction are hard** — the scorer's gates 0,
  2 and 3. A formatter that loses code is not a formatter.
- **Width compliance is _not_ a gate.** It is measure `4-overflow-lines`, and it
  is **comparative, not absolute**: the scorer prints the reference formatter's
  own overflow count for each language precisely because references overrun
  their own target width. taplo overruns on 8 line-runs across the TOML corpus,
  one of them _manufactured_ — it pads a 66-character line out to 107 to align a
  comment. An earlier version of this bullet demanded perfect width compliance,
  which would have had stage-D reviewers rejecting packages for matching their
  reference. **Match the reference and report the number; do not chase zero.**
- **Reference agreement is reported, with a floor.** Measured at both widths,
  floor of **70% of corpus files**. Every divergence must be named and
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

**Strip the template's leading `---` before launching.** The briefs in
`templates/` open with a `---` rule separating the "this is a template" header
from the body, and the substitution step slices from that line. grok and codex
take the prompt as a file or on stdin and do not care. `opencode` takes it as an
**argv positional**, and yargs reads a leading `---` as a malformed option — it
prints its usage text and exits 0, having run nothing. Exit 0 plus a log that
grows to a few KB looks exactly like a launch that worked. Generate the prompt
with `sed -n '/^---$/,$p' | tail -n +2`.

Two more substitution traps, both found the hard way:

- **Anchor the branch rewrite.** The worktree path contains the branch name as a
  substring (`editor-tools-wt/lang-toml`), so a bare `s|wt/lang-toml|…|g`
  rewrites the path too and points the agent at a directory that does not exist.
  Substitute the backticked form.
- **Substitute `{{WORKTREE}}` after any branch rewrite**, not before.

Worktrees: `/home/dave/w/editor-tools-wt/lang-<name>/` on `wt/lang-<name>`,
based on `main`. One language per worktree, one agent per worktree, always.

For a **head-to-head round**, where several agents build the same language, the
worktree and branch take an agent suffix: `lang-<name>-<agent>` on
`wt/lang-<name>-<agent>`. The rule that matters is unchanged — one agent per
worktree, never two writers in one tree.

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
