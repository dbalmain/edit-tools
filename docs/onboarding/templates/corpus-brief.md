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
- `injection_aliases` — the exact info-string names that may select this
  language inside a host document. Use at least the canonical language name; add
  conventional aliases only when you can vouch for them. Aliases must be unique
  across manifests. A host language also declares its grammar-specific
  `[[injections]]` node, info-child and content-child types. Put those array
  tables after every root key; in TOML, later keys otherwise belong to the
  injection entry rather than the manifest root.
- `reference` — the exact shell command that runs the canonical formatter:
  source on **stdin**, formatted source on **stdout**, with `{width}` where the
  width goes. Nothing is installed globally on this machine; use the
  pinned-runner pattern (`npx --yes pkg@ver`, `uvx pkg@ver`,
  `nix run nixpkgs#pkg`) that the python and json manifests demonstrate. Several
  formatters infer the language from the filename and need a fake one for stdin.
  **Spell that fake name with your manifest's own `extensions` entry, not the
  language name** — `x.ts`, not `x.typescript`, which prettier rejects outright
  with "no parser could be inferred". The two differ for at least five of the
  ten languages already on the roster (`.py`, `.js`, `.kt`, `.rs`, `.ts`), so a
  template example written as `x.{{LANG}}` is wrong more often than it is right.

  Record the command that worked, not the one you hoped would — and **verify
  every flag actually changes something before keeping it.** `--stdin-filepath`
  does nothing at all for taplo, where it was kept anyway and would have been
  copied into fourteen more manifests unexamined. A flag that does nothing is
  noise that outlives you.

  It is also not unconditionally required for prettier, which this brief used to
  claim: it is required only where prettier is inferring the parser **from the
  filename**. Passing `--parser <name>` explicitly does the same job and does
  **not** open prettier's `.editorconfig` discovery channel, which
  `--stdin-filepath` does. Pick one deliberately and say which, rather than
  passing both because the examples do.

  **If the reference is prettier plus a plugin** — XML is the first, and will
  not be the last — pin the plugin's version as well as prettier's, and expect
  `--plugin @scope/name` **not to resolve**: prettier 3 resolves a plugin from
  the current working directory, not from the npx cache that supplied the
  binary. The form that works passes the plugin's own entry-point path resolved
  relative to the prettier binary npx produced. Prove it from a **cold cache**
  (point `npm_config_cache` at a scratch directory) before you commit ground
  truth generated from a warm one.

  **Establish whether the reference reads ambient config**, and disable it. The
  method matters: plant a config file that sets an option your command line does
  **not** pass, then diff — testing with the option you already pass is exactly
  what hides the effect. taplo searches cwd _and every ancestor_ for
  `.taplo.toml`. Record three things: which options a discovered config can
  still supply, whether your command-line options override it or merely fill
  gaps it leaves (for taplo, `-o` wins per key and the config fills the rest —
  two round-1 builders got this backwards), and any channel the disable flag
  leaves open (`--no-auto-config` suppresses the _search_; `TAPLO_CONFIG` still
  applies). A reference whose output depends on where it was run is not ground
  truth.

- `reference_version` — the version string you **observed the tool print**. A
  version that was assumed rather than observed is a defect the stage-B reviewer
  is told to look for.
- `reference_width` — `"flag"` if the reference honours `{width}`, `"fixed"` if
  it has no width setting at all (gofmt, ormolu). `"fixed"` requires exactly one
  entry in `widths`, and forbids `{width}` in the command. **Establish this by
  running the tool at two widths and diffing**, not by reading its `--help`:
  taplo's width knob is `-o column_width=N`, which is not where anyone looks
  first.
- `widths` — a narrow width, and **the reference's own default**, which you
  **establish by bisection**: find the line length at which the reference's
  unprompted output (no width flag) starts breaking. Report the number.
  `{{WIDTHS}}` is the orchestrator's guess and is only a fallback if you cannot
  determine the default. Round 1 shows why: every TOML builder inherited `88`,
  which is **black's** default carried over from the python manifest, while
  taplo's is **80** — so agreement was being measured at a width no taplo user
  ever sees. If the reference ignores width entirely, say so in the report and
  set `reference_width = "fixed"` rather than inventing a width it does not
  honour.
- `gate3` — **start at `"default"`, and expect to stay there.** An override must
  be **at least as strict as** the generic default, and you must _prove_ the
  one-way implication before declaring one: whenever the default rejects a
  candidate, the override rejects it too.

  Agreeing with the default on reference output proves nothing: both accept a
  correct formatter, which is what reference output is. The proof is
  adversarial. Take a committed reference output, rewrite it so the **loaded
  data is unchanged but the document is not** — respell a number (`1_000` →
  `1000`, `0xdead` → `57005`), swap quote styles, convert a dotted key to a
  header, reorder sibling entries — and show your override **rejects** it. The
  checker must report a non-zero useful count. If the override accepts any
  member of that oracle, it is weaker and cannot be selected.

  **If you do need an override, extend the default rather than replace it.**
  Compose it as `(default_signature(text), your_extra)` — an override built that
  way **cannot** be weaker than the default, by construction, which is a much
  better guarantee than an adversarial run that merely failed to find a
  counter-example. Both overrides tried before this rule existed were
  _replacements_ and both were weaker; the one that motivated the rule is
  YAML's, where `|+` chomping puts semantic newlines in the whitespace between
  two nodes and no generic rule can see them (`FINDINGS.md` entry 12).

  **Data-model loaders are almost always the wrong choice.** `tomllib`,
  `yaml.safe_load`, `json.loads` and friends collapse exactly the spelling
  distinctions a formatter must preserve — that is their job as loaders and it
  is fatal here. Two of the four builders in round 1 reached for `tomllib`; a
  reviewer then found **11 of 11** data-preserving rewrites that the override
  accepted and the generic default rejected, including every literal spelling in
  the file the builder's own report described as "TOML's literal spellings must
  survive formatting". Neither builder was careless; the bar simply was not
  written down. It is now.

  A related trap: if a loader forces you to add a canonicaliser (NaN handling is
  the usual one), notice that the default had no such problem — it compares leaf
  text, and `"nan" == "nan"`. Solving a problem your own override created is not
  evidence of strength.

  If you do declare one, put it in `harness/languages/{{LANG}}_gate3.py` as
  `signature(text) -> object | None`, set `gate3 = "{{LANG}}"`, and put the
  adversarial evidence in the report. Comments are **not** your override's
  problem: `gate3.py` compares the grammar's extras for every language, override
  or not — the exposure is structural rewriting that survives a data-level load.

- `transparent_wrappers` — used only by `gate3 = "default"`. The node kinds your
  formatter may legitimately **add or remove** around a single child, which in
  most languages means the parenthesised-expression node. Leave it empty to
  start and add a kind only when the gate rejects correct output and names it.
  **Do not add a kind whose parentheses are structural** — in a Lisp, `(f)` is a
  call and `f` is not, and declaring that node transparent would let the
  formatter destroy code and still pass.

  **There is a second shape, and it is not a parenthesis.** A grammar may insert
  a **unary wrapper for a leading operator that only appears when the construct
  breaks** — TypeScript's `union_type` is the worked example: `| A | B` parses
  as a unary `union_type` around the first member, while every real multi-member
  union is a chain of _binary_ `union_type` nodes. Declaring it transparent is
  sound for exactly the reason the one-named-child rule exists: the elision
  fires only on the unary node, so a formatter that dropped a real alternative
  still fails on the surviving binary one. If your reference adds a leading
  operator on break, look for this before reaching for a `gate3` override — and
  prove the arity claim by parsing both forms and dumping the tree, not by
  reading the grammar.

- `equivalent_kinds` — also default-only. Groups of node kinds that are the same
  construct under a different name, which is what happens when parenthesising
  something renames its node (`pattern_list` → `tuple_pattern` in Python). Same
  rule: add one only when the gate names it.

- `incomparable` — optional. A table of **filename = reason** for files the
  reference rewrites in a way linearity forbids (prettier turning `'hello'` into
  `"hello"`, gofmt sorting imports, prettier rewriting `.5` to `0.5`). A file
  with no reason is a manifest error; a name that does not exist is too. Do
  **not** leave the construct out of the corpus: put it in its own file and
  declare it.

  ```toml
  [incomparable]
  "quotes.yaml" = "prettier re-quotes to minimise escaping"
  ```

  The file still counts for gates 0–3 (coverage, Rust/JS parity, idempotence,
  non-destruction). It skips only the "reference output must itself pass gate 3"
  assertion, and it is out of the agreement denominator — reported as a fifth
  count, `excluded`. The name is a current measurement state, not a permanent
  exile: when the construct later becomes comparable (quote respelling will;
  import sorting will not), delete the line.

  **One excluded construct per file.** A file that also contains otherwise
  comparable constructs hides those from measurement. The harness cannot tell a
  mixed file from a dedicated one — do not treat a green `./test.sh` as evidence
  of purity. Stage B rejects a mixed file. The `kitchen` file is never
  incomparable.

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
- a **normalisation probe** — input written the way a person writes it and a
  formatter does not: wrong spacing around operators and delimiters, padding
  inside brackets, wrong or absent indentation, runs of spaces before a trailing
  comment. Every other probe here is structural and tests what the reference
  **breaks**; this one tests what it **rewrites**. Round 1 shows why it is
  mandatory: one builder wrote all fourteen files already in the reference's own
  spacing, so **7 of 14 were byte-identical input to output** and the corpus
  probed token-level normalisation not at all.

  Include an **empty container written with a space in it** — `f( )`, `{ }`,
  `[ ]`, whatever the language spells it. It looks like a triviality and it is
  not: it is the one shape whose node has no named children at all, so it is the
  only place the gate compares a _construct_ rather than a token. Round 2 found
  a gate-3 defect there that had been latent across every merged language, and
  found it twice independently, in Go and CSS, because those were the first two
  corpora to write one. If the gate rejects your reference's output on this
  case, **that is a finding — report it and stop.** Do not delete the probe and
  do not weaken the gate; both round-2 builders got this right.

- a `kitchen` probe — several constructs interacting, the one file allowed to be
  messy

Two properties the whole corpus must have, not any single file:

- **At least a third of files must produce different reference output at the two
  widths.** Constructs the reference cannot break — comments, string interiors,
  and whatever else it refuses to split — do not count toward this. One round-1
  corpus had **1 of 14** files that could tell the two widths apart, because
  every line in the discriminating band was unbreakable. If you cannot reach a
  third, that is a finding about the reference and belongs in the report.
- **Most files should carry a comment**, not one dedicated comments probe. The
  universal extras layer of gate 3 has comments as its _only_ input, so a file
  with no comment is a file where that layer is inert. In one round-1 corpus, 9
  of 14 files had no comment at all.

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

If a missing field or a harness defect **blocks one of the required gates**,
report it as a finding _and_ state the exact patch you would apply — field name,
type, default, and the shared-file lines — **without applying it**. A precise
proposal scores exactly as high here as a fix would, and it is the one thing
that survives three agents working in parallel. All four round-1 builders hit
the same harness defect; the two who described it precisely were more useful
than the one who fixed it, because the fix had to be re-decided centrally
anyway.

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
override — that every well-formed mutation rejected by the generic default is
also rejected by your override. It reports the useful count and fails rather
than claiming success when that count is zero. A disagreement is a real finding
about {{LANG}} and belongs in the report even when you remove the override.

## Report

Write `corpus/reports/{{LANG}}/corpus-report.md`:

- **which agent you are**, in the first section, next to the pins. One line —
  the model or CLI you are running as. Round 3's three reports all landed
  without it, so the status board cannot say who built them and the scorecard
  cannot credit them.
- the manifest, and how you established each field you had to discover
- the corpus file list, one line each: what it stresses and why it is
  characteristic of {{LANG}}
- **two counts, from two `cmp` loops**: how many corpus files the reference
  changes at all, and how many differ between your two widths. A corpus where
  most files are byte-identical input to output is not probing anything; report
  the number rather than making the reviewer compute it.
- **the reference's own overflow count** — run
  `./harness/corpus_stats.py --language {{LANG}}`, which prints it per width
  along with the three corpus-quality counts above, so none of them has to be
  computed by hand. (`score.py` also prints it as "its own overflow: N", but
  only once a package exists; at stage A it filters your language out before it
  computes anything.) Break the causes out in the report. **The reference is
  allowed to overrun its own target width, and they all do.** taplo overruns on
  8 line-runs across the TOML corpus, one of which it _manufactures_: it pads a
  66-character line out to 107 in order to align a comment. Without this number
  in the report, a stage-C agent reads a 107-character line at width 88 as a
  corpus bug and either "fixes" it away from the reference or files it as a
  package failure.
- **anything the reference formatter does that surprised you** — this is the
  most valuable section. Cases where it does not reflow, where its output
  depends on something other than the input line, where two inputs format the
  same, where it makes a choice a node-type table could not express.

  Three questions you must answer **explicitly**, because round-1 builders wrote
  good surprise lists and still missed these:

  - **When a container breaks, do the containers _inside_ it break too — even
    ones that would fit?** Construct a case where a child fits with room to
    spare and check. taplo: yes, unconditionally, and it crosses inline-table
    boundaries. A package that models each container as an independent group
    diverges on every nested one, so getting this wrong costs the whole stage-C
    design.
  - **Does a trailing comment count toward its line's width?** taplo: yes, and
    it will destroy a perfectly good flat array in a futile attempt to fit a
    comment it cannot move.
  - **What does the reference normalise at _token_ level** — spacing, delimiter
    padding, indentation — as opposed to line level?

- **everything you changed outside `corpus/` and `harness/languages/`.** Paste
  the output of
  `git diff --stat <base> -- . ':(exclude)corpus' ':(exclude)harness/languages'`
  verbatim, even when it is empty. The reviewer runs the same command and
  compares. A round-1 builder wrote "None" here while the slice edited two
  shared harness scripts; a mismatch is treated as a more serious defect than
  whatever edit it concealed.
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
