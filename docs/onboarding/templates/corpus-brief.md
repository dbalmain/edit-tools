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

The manifest. The full annotated schema is in `WORKFLOW.md`, under "Stage 0";
`harness/languages/python.toml` and `json.toml` are the worked examples and
carry the reasoning for every field they set. Every field is validated on load,
so a typo is a one-line error naming the file and the field, not a traceback.

Fields you must establish rather than guess:

- `grammar` — a **pinned** PEP 508 requirement, e.g.
  `"tree-sitter-{{LANG}}==0.7.0"`. The orchestrator's guess at the distribution
  is `{{GRAMMAR}}`; **verify it, and correct it if wrong.** An unpinned grammar
  is rejected: the committed trees are ground truth and a silent grammar bump
  rewrites them.
- `grammar_module` — the **importable module name**, which is a separate fact
  from the distribution name and is not always the hyphen-to-underscore swap.
  Import it and check.
- `grammar_symbol` — the function on that module returning the language.
  Defaults to `"language"` and that is usually right, but not always:
  `tree_sitter_typescript` exposes `language_typescript()` and `language_tsx()`,
  `tree_sitter_xml` exposes `language_xml()` and `language_dtd()`. If you get it
  wrong the loader tells you which names the module actually exports.
- `reference` — the exact shell command that runs the canonical formatter:
  source on **stdin**, formatted source on **stdout**, with `{width}` where the
  width goes. Nothing is installed globally on this machine; use the
  pinned-runner pattern (`npx --yes pkg@ver`, `uvx pkg@ver`,
  `nix run nixpkgs#pkg`) that the python and json manifests demonstrate. Several
  formatters infer the language from the filename and need a fake one for stdin
  (`--stdin-filepath x.{{LANG}}`). Record the command that worked, not the one
  you hoped would.
- `reference_version` — the version string you **observed the tool print**. A
  version that was assumed rather than observed is a defect the stage-B reviewer
  is told to look for.
- `reference_width` — `"flag"` if the reference honours `{width}`, `"fixed"` if
  it has no width setting at all (gofmt, ormolu). `"fixed"` requires exactly one
  entry in `widths`, and forbids `{width}` in the command. **Establish this by
  running the tool at two widths and diffing**, not by reading its `--help`:
  taplo's width knob is `-o column_width=N`, which is not where anyone looks
  first.
- `widths` — `{{WIDTHS}}`. If the reference ignores width, say so in the report
  and set `reference_width = "fixed"` rather than inventing a width it does not
  honour.
- `gate3` — `"default"` unless {{LANG}} has a real semantic checker available (a
  loader that round-trips, an AST dumper). If it does, put it in
  `harness/languages/{{LANG}}_gate3.py` as `signature(text) -> object | None`,
  set `gate3 = "{{LANG}}"`, and say in the report why it is stronger than the
  default. Comments are **not** your override's problem: gate3.py compares the
  grammar's extras for every language, override or not.
- `transparent_wrappers` — used only by `gate3 = "default"`. The node kinds your
  formatter may legitimately **add or remove** around a single child, which in
  most languages means the parenthesised-expression node. Leave it empty to
  start and add a kind only when the gate rejects correct output and names it.
  **Do not add a kind whose parentheses are structural** — in a Lisp, `(f)` is a
  call and `f` is not, and declaring that node transparent would let the
  formatter destroy code and still pass.
- `equivalent_kinds` — also default-only. Groups of node kinds that are the same
  construct under a different name, which is what happens when parenthesising
  something renames its node (`pattern_list` → `tuple_pattern` in Python). Same
  rule: add one only when the gate names it.

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

### 3. Generated ground truth — trees and reference output

Both are generated, never hand-written, and both are committed. Once the
manifest and the corpus are in place:

```sh
./harness/gen_trees.py     --language {{LANG}}   # -> corpus/trees/{{LANG}}__<stem>.tree.json
./harness/gen_reference.py --language {{LANG}}   # -> corpus/reference/{{LANG}}__<stem>@<width>.txt
```

Neither script needs extending — they read your manifest, including installing
your pinned grammar. If either needs a change to work for {{LANG}}, that is a
finding: say so in the report rather than patching around it.

Then check the ground truth is actually reproducible:

```sh
./harness/gen_reference.py --language {{LANG}} --check   # must be silent and exit 0
```

A reference formatter whose output is not deterministic — or that depends on a
config file it found somewhere on this machine — is a finding, and an important
one. Report it; do not paper over it by committing one of the outputs.

### 4. Whatever harness change this needs

You may change anything in `harness/`. Prefer adding a file over editing a
shared one — other agents are onboarding other languages in parallel worktrees
right now, and a shared-file edit becomes a merge conflict. In particular:

- **do not** add your grammar to any script's inline `dependencies` block; it
  goes in your manifest's `grammar` field and the scripts install it from there
- **do not** add a branch on `{{LANG}}` to `score.py`, `gen_trees.py` or
  `gate3.py`. If you find yourself wanting to, the manifest schema is missing a
  field — say which, and why, in the report. That is a template delta and it is
  worth more than the workaround.

You may also change `rust/` and `runtime-js/`, but you almost certainly should
not need to for _this_ slice. If you do, every such edit must appear in your
report with the case for it.

## Gates

Run the project's gates and get them green with zero warnings before you claim
anything. Fix until green. Do not claim a gate for code you have not run.

```sh
./build.sh
./test.sh                                    # includes check_gate3.py and score.py
./harness/check_gate3.py --language {{LANG}}
./harness/check_width.py . 20 120 --language {{LANG}}
```

`check_gate3.py` is the one to read the output of rather than just the exit
code. It asserts that your reference formatter passes gate 3, that the gate
still rejects a dropped comment and a dropped token, and — if you declared an
override — that the generic default reaches the same verdict as your override on
every file. A disagreement there is a real finding about {{LANG}} and belongs in
the report even when you fix it.

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
