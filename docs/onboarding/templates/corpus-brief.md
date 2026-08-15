# Stage A brief — corpus and harness entry for `{{LANG}}`

Template. The orchestrator substitutes `{{LANG}}`, `{{GRAMMAR}}`,
`{{REFERENCE}}`, `{{WIDTHS}}`, `{{WORKTREE}}` and appends any language-specific
notes from `LANGUAGES.md` under "Known stresses" before launching.

---

You are adding **{{LANG}}** to a differential-testing harness for a formatter.
Your working tree is `{{WORKTREE}}`, on branch `wt/lang-{{LANG}}`, based on
`main`. Everything you need is in that tree.

## What this project is

A formatter and syntax highlighter with **two idiomatic implementations** — one
Rust, one JavaScript — kept honest by differential testing rather than by
sharing code through FFI or wasm. A _package_ is a table from CST node type to a
Doc-building expression; the runtime walks a tree-sitter parse tree and
evaluates that table. Read `DESIGN.md` in the tree before you start. It is the
authoritative description and it is short.

This slice does **not** write a package. It builds the ground truth the package
will later be measured against.

## Read first

- `DESIGN.md` — the design and the gates
- `docs/onboarding/WORKFLOW.md` — where this slice sits
- `harness/languages/python.toml` and `harness/languages/json.toml` — the two
  worked examples of the manifest you are writing
- `corpus/src/python/` — the shape of a corpus that already works
- `~/style-guide/common.md` plus the relevant language file

## Deliverables

### 1. `harness/languages/{{LANG}}.toml`

The manifest. Schema is in `WORKFLOW.md`. Fields you must establish rather than
guess:

- `grammar` — the tree-sitter grammar package. The orchestrator's guess is
  `{{GRAMMAR}}`; **verify it, and correct it if wrong.** Pin the version.
- `reference` — the exact command that runs the canonical formatter, and
  `reference_version` — the version string you actually observed. Nothing is
  installed globally on this machine; use the pinned-runner pattern
  (`npx --yes pkg@ver`, `uvx pkg==ver`, `nix run nixpkgs#pkg`) that the python
  manifest already demonstrates. Record the command that worked, not the one you
  hoped would.
- `widths` — `{{WIDTHS}}`. If the reference formatter has no width setting, or
  ignores it, **say so and set `gate2 = "waive"`** rather than inventing a width
  it does not honour.
- `gate3` — `"default"` unless {{LANG}} has a real semantic checker available (a
  loader that round-trips, an AST dumper). If it does, use it and say why it is
  stronger than the default.

### 2. `corpus/src/{{LANG}}/` — 12 to 16 source files

Each file is named for the single thing it stresses and contains **only** that
thing. This is not a sample application; it is a probe set. Model it on
`corpus/src/python/`.

Every corpus must include, adapted to {{LANG}}'s actual syntax:

- a nesting probe — containers inside containers, deep enough to force breaking
  at the narrow width
- a long-sequence probe — the construct that most often overflows a line
- a comment probe — comments in every position the language allows: own-line,
  trailing, inside a delimited construct, before a closing delimiter
- a string/literal probe — including whatever escaping or multi-line form the
  language has
- a `kitchen` probe — several constructs interacting, the one file allowed to be
  messy

Plus 7–11 files covering what is _characteristic_ of {{LANG}} — the constructs a
person would notice were formatted wrongly. Choose these yourself; justify them
in one line each in the report.

**Corpus files must be valid, meaningful {{LANG}}** and must parse with no
`ERROR` node. Check that before committing them.

### 3. `corpus/trees/{{LANG}}/` and reference outputs

Generated, not hand-written. Extend the tree generator to read manifests, and
generate:

- the parse tree for each corpus file
- the reference formatter's output for each corpus file at each width in
  `widths`

Commit both. They are the ground truth; if regenerating them is not
deterministic, that is a finding — report it.

### 4. Whatever harness change this needs

You may change anything in `harness/`. Prefer adding a file over editing a
shared one — other agents are onboarding other languages in parallel worktrees
right now, and a shared-file edit becomes a merge conflict.

You may also change `rust/` and `runtime-js/`, but you almost certainly should
not need to for _this_ slice. If you do, every such edit must appear in your
report with the case for it.

## Gates

Run the project's gates and get them green with zero warnings before you claim
anything: `./build.sh`, `./test.sh`, and the harness's own checks. Fix until
green. Do not claim a gate for code you have not run.

## Report

Write `corpus/reports/{{LANG}}/corpus-report.md`:

- the manifest, and how you established each field you had to discover
- the corpus file list, one line each: what it stresses and why it is
  characteristic of {{LANG}}
- **anything the reference formatter does that surprised you** — this is the
  most valuable section. Cases where it does not reflow, where its output
  depends on something other than the input line, where two inputs format the
  same, where it makes a choice a node-type table could not express.
- every file outside `corpus/` and `harness/languages/` that you changed, and
  why
- **template delta** — what in this brief misled you, what was missing, what was
  noise. If nothing, say nothing.

## Working rules

- **Do not run `git push` under any circumstances.**
- Commit at each green boundary, not one commit at the end. A commit boundary
  survives a cut-off; a dirty tree costs someone an hour of forensics.
- `git add` named paths. Never `git add -A` — it commits whatever tooling left
  lying around.
- Give me a **done-note**, not a transcript: what you established, what you
  built, what you decided and why.

## Pushback is wanted

If this brief's framing is wrong for {{LANG}} — if the corpus shape does not
suit it, if the reference formatter is the wrong choice, if the manifest schema
cannot express what this language needs — **say so and propose the better
shape** rather than forcing it. A correct "this is actually X" is worth more
than an implementation of my guess.

Treat the specifics in this brief as intent, not gospel. The grammar package
name is a guess. The width list is a guess. If a snippet or a name here is
wrong, flag it; do not bend the work to match it.
