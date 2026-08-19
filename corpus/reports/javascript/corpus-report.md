# JavaScript corpus report (stage A)

## Manifest

`harness/languages/javascript.toml`. Every field that could have been guessed
was observed, not assumed.

| Field                  | Value                                                                              | How it was established                                                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grammar`              | `tree-sitter-javascript==0.25.0`                                                   | Live PyPI: the distribution name matches the orchestrator's `tree_sitter_javascript` guess, but the pin does not. `0.7.0` was the guess; the latest release is `0.25.0` (checked against the live index 2026-08-17).          |
| `grammar_module`       | `tree_sitter_javascript`                                                           | `uv run --with tree-sitter-javascript==0.25.0` then `import tree_sitter_javascript`. The hyphen-to-underscore swap is correct here.                                                                                           |
| `grammar_symbol`       | `language`                                                                         | The module exports `language()` (plus `HIGHLIGHTS_QUERY`, `INJECTIONS_QUERY`, `LOCALS_QUERY`, `TAGS_QUERY`). It returns a `tree_sitter.Language` capsule. No `language_javascript()`.                                         |
| `injection_aliases`    | `["javascript", "js"]`                                                             | `javascript` is canonical. `js` is the conventional fence spelling (GitHub linguist, prettier's own support-info aliases, the alias most fences actually use). Both vouched for. `jsx` is TypeScript's grammar, not this one. |
| `reference`            | `npx --yes prettier@3.9.6 --no-config --stdin-filepath x.js --print-width {width}` | Source on stdin, formatted source on stdout. `--stdin-filepath x.js` is required (no filepath and no parser: "No parser and no file path given, couldn't infer a parser"). `--no-config` is load-bearing (below).             |
| `reference_version`    | `3.9.6`                                                                            | Printed by `npx --yes prettier@3.9.6 --version`. Not assumed. Same pin as CSS/YAML; JSON is still on 3.6.2.                                                                                                                   |
| `reference_width`      | `flag`                                                                             | Ran the same input at 80 and 40 and diffed: collections, argument lists, operator chains and ternaries reflow; string/template interiors and comments do not. `{width}` is therefore real.                                    |
| `widths`               | `[80, 40]`                                                                         | 80 is prettier's own default, established by bisection: a 20-item number array (`const x = [0, …, 19];`, 81 chars) breaks unprompted and at `--print-width 80`, and stays flat at `--print-width 81`. 40 is the narrow width. |
| `gate3`                | `default`                                                                          | See "no override" below.                                                                                                                                                                                                      |
| `transparent_wrappers` | `["parenthesized_expression"]`                                                     | Established by running prettier over the corpus, not by reading the grammar (below).                                                                                                                                          |
| `equivalent_kinds`     | `[]`                                                                               | Nothing was renamed; every structural change was a `parenthesized_expression` added or removed around one child.                                                                                                              |

### `--no-config` is load-bearing

prettier walks cwd and ancestors for `.prettierrc` / `prettier.config.*` / a
`package.json` `"prettier"` key, and — because the command passes a filepath —
reads `.editorconfig` from that path. A planted config with `singleQuote: true`
and `semi: false` (options the command line does **not** name) silently requotes
and de-semicolons, and a planted `.editorconfig` with `indent_size = 8`
re-indents. All three channels are verified inert under `--no-config`. CLI
`--print-width` wins over a file `printWidth` (the taplo shape: the file fills
every option the CLI does not name). There is no `PRETTIER_CONFIG` env var; the
residual channel is an explicit `--config`, which cannot be combined with
`--no-config`. `gen_reference.py --check` is silent (exit 0); two runs of the
same stdin match.

### No gate3 override, and why the loader trap does not bite here

The generic default is selected. The round-1 lesson — that `tomllib` /
`json.loads`-style data loaders collapse the spellings a formatter must preserve
— does not apply to JavaScript the way it applied to TOML/YAML, because
**tree-sitter-javascript represents both quote styles as one `string` node**
with an anonymous quote token and a named `string_fragment`. prettier's quote
normalisation (`'hello'` → `"hello"`) therefore leaves the named tree unchanged,
so the generic default already accepts it. The gate is not weaker for it; it is
measuring the right thing. No data-model loader is involved.

`check_gate3.py --language javascript`: 28 reference outputs accepted, 56
destructive mutations rejected, 500 useful adversarial mutations (arm inert — no
override), 0 wrapper kinds beyond `parenthesized_expression`, 11 injection cases
checked.

### `transparent_wrappers` — prettier both adds and removes the parens

Running prettier over the corpus, gate 3 named `parenthesized_expression` in
five files, and every occurrence is the same shape: the wrapper appears or
disappears around **exactly one** named child. In JavaScript `(expr)` is always
the same expression as `expr`, so the wrapper is genuinely transparent (unlike
Scheme, where `(f)` is a call). The five:

- **removed, redundant**: `((1 + 2))` → `1 + 2` (`normalisation`), a nested
  ternary's parens (`control_flow`, `kitchen`).
- **added, clarifying**: `config ??= defaults` → `(config ??= defaults)` (same
  for `&&=` / `||=`, `modern`); mixed-bitwise
  `flags | mask & value ^ other << shift` →
  `flags | ((mask & value) ^ (other << shift))` (`operators`).

The additions are winnable by a package (the `paren`/`autoparen` opcodes exist
for exactly this); the deletions are **not** (FINDINGS entry 13 — no opcode
drops a token), so the one redundant-paren line in `normalisation.js` is a
deliberate, measured unwinnable divergence, the JS analogue of Go's
`redundant = ((1))`.

## The excluded-reference-behaviour inventory

The round-3 note says this is the most important thing I will write. Each row
below was established by running prettier 3.9.6 on a probe and diffing, not by
recalling what prettier does. "gate3" is whether the generic default (with
`parenthesized_expression` transparent) accepts the rewrite — the thing that
decides whether the construct may appear in the corpus at all.

| Rewrite                                                            | Class                                               | gate3              | In corpus?                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------- | ------------------ | ----------------------------------------------------------------------- |
| `'hello'` → `"hello"` (fragment unchanged)                         | anonymous-token text rewrite                        | **accepts**        | No — corpus uses double quotes; a package cannot change the quote token |
| `'it\'s'` → `"it's"`, `"say \"hi\""` → `'say "hi"'`                | named-leaf text rewrite (escape_sequence)           | **rejects**        | No                                                                      |
| `''` → `""` (empty string)                                         | anonymous-token rewrite of a no-named-child node    | **rejects**        | No                                                                      |
| `{ 'quoted': 1 }` → `{ quoted: 1 }` (unquote valid id)             | node-kind rename (`string` → `property_identifier`) | **rejects**        | No — bare keys                                                          |
| `{ 'hyphen-key': 1 }` → `{ "hyphen-key": 1 }`                      | anonymous-token rewrite                             | **accepts**        | Uses double quotes                                                      |
| `x => x` → `(x) => x` (arrow param parens)                         | structural (`identifier` → `formal_parameters`)     | **rejects**        | No — corpus writes `(x) => x`                                           |
| `(1 + 2)` → `1 + 2`, `((x))` → `x` (redundant parens)              | **deletion**                                        | accepts w/ wrapper | One line, measured unwinnable                                           |
| `a ??= b` → `(a ??= b)`, mixed bitwise parens                      | **addition** (paren policy)                         | accepts w/ wrapper | Yes — winnable                                                          |
| `0xFF`→`0xff`, `.5`→`0.5`, `1E10`/`1e+10`→`1e10`, `0B1`→`0b1`      | named-leaf text rewrite (`number`)                  | **rejects**        | No — canonical spellings                                                |
| missing `;` → `;` added                                            | **addition** (anonymous)                            | **accepts**        | No — corpus writes semicolons                                           |
| trailing comma on a broken collection/call/params                  | **addition** (trail policy)                         | **accepts**        | Yes — winnable                                                          |
| a run of 2+ blank lines collapses to one                           | whitespace-only (extras are anonymous)              | **accepts**        | Yes — `normalisation.js` (added at stage B review)                      |
| a source-expanded object stays expanded (`objectWrap`)             | layout, **source-sensitive** — not width            | **accepts**        | Yes — `objects.js` (added at stage B review)                            |
| JSX attribute layout: one attribute per line when it breaks        | layout, wraps the element in parens                 | **accepts**        | No — JSX is out of the corpus (below)                                   |
| JSX text is refilled and re-split into `jsx_text` nodes            | named-leaf rewrite + child-count change             | **rejects**        | No — JSX is out of the corpus (below)                                   |
| ``css`…` `` / ``html`…` `` / ``graphql`…` `` interiors reformatted | named-leaf text rewrite (`string_fragment`)         | **rejects**        | No — the corpus's only tagged template uses an unrecognised tag         |

The surprising column is the first: quote normalisation is **not** a
gate-3-rejecting rewrite in JavaScript the way it is in YAML (different node
kind) or Python (black rewrites the leaf). tree-sitter's uniform `string` node
hides it. That does not make it winnable — a package still cannot change an
anonymous quote token — but it does mean the corpus could have included
single-quoted strings without failing "the reference must pass gate 3". It chose
not to, to keep agreement measurable.

**Negative results worth recording** (prettier does _not_ do these, so the
corpus is free to use them): it does **not** convert template literals to
strings (`` `hello` `` stays a template), does **not** reorder imports or object
keys, does **not** rewrite numeric separators (`1_000` stays) or trailing `.0`
(`1000.0` stays), does **not** rewrite booleans / `null` / `undefined`, and does
**not** touch regex literals or bigint.

**One negative result was too broad and is corrected here** (stage B review).
"prettier does not touch template-literal interiors" holds only for
_unrecognised_ tags. `embeddedLanguageFormatting` defaults to `auto`, so
prettier reformats the interior of a template tagged `css`, `html` or `graphql`
— `` css`\n  .a {   color:red;   }\n` `` becomes properly indented CSS. That
rewrites a `string_fragment`, so gate 3 **rejects** it, and such templates must
stay out of the corpus. The corpus's one tagged template uses `tag`, which
prettier leaves alone; the claim was true of the corpus and false in general.
Worth noting for this project specifically: prettier does language injection
inside JS template literals, which is the same shape as the harness's own
injection machinery.

## What prettier's own options say it chose not to do

Added at stage B review; this section was missing. Every row is from
`prettier@3.9.6 --help` plus a probe, and it is the thing observing the output
alone cannot tell you — an absent behaviour and a deliberately-disabled one look
identical in a diff.

| Option                         | Default     | What the default decides                                                                                                                                            |
| ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `objectWrap`                   | `preserve`  | **The one that matters.** Object layout is _not_ a pure function of width. `collapse` — the behaviour a plain width-driven `group` implements — is the non-default. |
| `experimentalOperatorPosition` | `end`       | A broken binary chain keeps its operator at the end of the line. `start` exists and would move it to the front of the next line.                                    |
| `experimentalTernaries`        | off         | The classic ternary layout in `operators.js` / `control_flow.js` is the default one; the "curious ternaries" layout is opt-in.                                      |
| `embeddedLanguageFormatting`   | `auto`      | **On**, not off: prettier reformats `css`/`html`/`graphql` template interiors (above). `off` is the non-default.                                                    |
| `arrowParens`                  | `always`    | `(x) => x`. `avoid` is the non-default, and the corpus writes the default spelling.                                                                                 |
| `trailingComma`                | `all`       | Since 3.0. `es5` / `none` are the non-defaults; the `trail` policy targets the default.                                                                             |
| `quoteProps`                   | `as-needed` | Quoted-but-valid keys are unquoted. `preserve` would have kept them and made that rewrite disappear.                                                                |
| `semi`                         | on          | Semicolons inserted; `--no-semi` is the non-default.                                                                                                                |
| `bracketSameLine`              | `false`     | JSX/HTML only — moot while JSX is out of the corpus.                                                                                                                |
| `singleAttributePerLine`       | `false`     | JSX/HTML only — same.                                                                                                                                               |
| `useTabs` / `tabWidth`         | off / `2`   | Why the tab-indented block in `normalisation.js` is reindented to two spaces.                                                                                       |

`objectWrap: preserve` is the row a stage-C agent has to read. It means the
reference's decision to break an object depends on the **input's** line breaks,
not only on the width, and `objects.js` now carries a probe that isolates it:
`preservedBySource` fits flat at 80 and stays expanded, while
`collapsedBySource` — the same shape written as an array — collapses. A package
that models an object as a plain width group will collapse the first one and
lose that file at both widths.

## JSX is out of the corpus, and that is a decision, not an oversight

Added at stage B review; the stage-A report did not mention JSX at all, which is
the one thing a reader would notice missing from a JavaScript corpus.

The facts, each probed against the pinned grammar and prettier 3.9.6:

- **tree-sitter-javascript 0.25.0 parses JSX cleanly.** `jsx_element`,
  `jsx_opening_element`, `jsx_attribute`, `jsx_expression`, `jsx_text` — no
  `ERROR`, no `MISSING`. JSX is this grammar's, not tree-sitter-typescript's;
  the manifest's note about `jsx` concerns the fence _alias_, not the construct.
- **prettier formats JSX in a `.js` file** without a flag, wrapping a broken
  element in parens and putting one attribute per line.
- **Attribute layout passes gate 3.** The added parens are
  `parenthesized_expression`, already declared transparent. So a `jsx.js` probe
  would be fully comparable and would sit inside the agreement denominator.
- **JSX text does not.** prettier refills text content, which rewrites
  `jsx_text` leaves and changes the element's named child count (5 → 7 on the
  probe). That half is a gate-3 rejection and could only enter the corpus as a
  dedicated `[incomparable]` file.

So the honest statement is: JSX is a deliberate scope exclusion, not an
unwinnable one. Adding it is a scope decision for the orchestrator rather than a
reviewer's correction, because JSX layout is a large, bespoke prettier printer
and a `jsx.js` file would most likely land as a second classified design-limit
divergence alongside `chains.js`. Flagged rather than added.

## Corpus

Fourteen files in `corpus/src/javascript/`. Each is valid JavaScript: clean
under tree-sitter-javascript 0.25.0 (no `ERROR` / `MISSING`) and accepted by
prettier 3.9.6.

Required probes:

- `nesting.js` — arrays of arrays, objects of objects, calls inside calls,
  arrows inside arrows. `matrix` (array-of-arrays) explodes at **both** widths
  (prettier's array-of-arrays rule); `config` and `fits` break only at 40, and
  the inner containers that still fit (`[1, 2, 3, 4]`, `{ key: "value" }`) stay
  flat.
- `sequences.js` — the construct that overflows: a long number array (which
  **packs** — fill), a long identifier array and a long string array (one per
  line), a long argument list.
- `comments.js` — every position: file-level, trailing on a statement, own-line
  before a declaration, trailing on an item, own-line between items, inline
  block comment, comment before a closing bracket, a comment immediately after
  `[` (which prettier moves to the next line), a comment before a return.
- `strings.js` — double-quoted strings, escapes, unicode, astral scalars,
  template literals with and without substitution, a multi-line template, a
  tagged template, concatenation. String/template interiors never reflow.
- `normalisation.js` — wrong spacing, `f( )` / `[ ]` / `{ }` empty containers,
  padded brackets, tight braces, `((1 + 2))`, `if(x){...}else{...}`, runs of
  spaces before a trailing comment, tab-indented block, **a run of four blank
  lines** (added at stage B review — see below).
- `kitchen.js` — spread, arrow callbacks, filter/map/sort chains, an object
  literal inside a map, a for-loop.

Characteristic of JavaScript, one line each:

- `operators.js` — `+`/`*` chains (the `flatten` spine and its precedence stop),
  `&&`/`||` chains, ternaries including a nested one, comparison, bitwise.
- `functions.js` — declarations, defaults, rest, expression, arrows, object
  return, `async`/`await`, generators.
- `classes.js` — fields, methods, getters/setters, `static`, `extends`, private
  `#` fields and methods.
- `objects.js` — shorthand, spread, computed keys, methods, async method, nested
  objects, destructuring with defaults/rest/rename, and **the `objectWrap`
  pair** (added at stage B review): a source-expanded object that would fit flat
  and stays expanded, next to a source-expanded array that collapses.
- `chains.js` — method chains, which prettier breaks at the dots — a layout the
  IR cannot express (DESIGN.md "method chains at the dots"), so this file is a
  known, classified design-limit divergence, the JS analogue of `chains.py`.
- `control_flow.js` — `if`/`else if`/`else`, `for`, `for...of`, `while`,
  `switch` fallthrough, `try`/`catch`/`finally`, a parenthesised nested ternary.
- `modules.js` — default/named/namespace imports, a long named-import list,
  `export const`/`function`/`default`/`export { }`.
- `modern.js` — optional chaining, nullish coalescing, `??=`/`&&=`/`||=`, regex
  literal, bigint, `**`, dynamic `import()`.

**Comments.** 14 of 14 files carry at least one comment; gate 3's extras layer
is live on every file. Most are a one-line header describing the probe, which
doubles as a trailing/own-line comment the runtime must preserve.

**Injection.** The corpus files are whole modules, but they are built from
statement-level (imports, declarations, control flow) and expression-level
(arrow bodies, object literals, call arguments) constructs that a Markdown fence
will later wrap as fragments; nothing in the corpus assumes a `program` root.
`injection_aliases = ["javascript", "js"]` is declared so the injection
machinery (already proved against JSON) can select this grammar.

## Corpus-quality counts

From `./harness/corpus_stats.py --language javascript` against the committed
reference:

```
javascript  --  14 files, vs 3.9.6
  reference changes    14/14 at some width   (@80 10/14  @40 14/14)
  differs by width     12/14
  carries a comment    14/14
  reference overflow   @80 0  @40 6
```

Two independent `cmp` loops agree: 14 of 14 files differ from their input at
some width, and 12 of 14 differ between width 80 and width 40. Both counts are
the same as `corpus_stats.py` reports, so they are not hand-computed. The two
width-insensitive files are `comments` (comment placement is a width-independent
decision — prettier moves `[ // comment` onto the next line at any width) and
`normalisation` (pure token-level rewriting; no line sits in the 40–80 reflow
band). 12/14 is far above the one-third floor.

Re-run at stage B review after the two added probes: every line above is
unchanged. The blank-line run and the `objectWrap` pair are both
width-insensitive rewrites, so they raise what the corpus _probes_ without
moving what it _counts_ — which is exactly why counting alone does not find this
class of gap.

## Reference overflow

`@80 0  @40 6`. All six overruns are lines prettier **refuses** to break, not
corpus bugs:

| File            | Line                                                              | Cause                                              |
| --------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `classes`       | ``return `${this.#label} at (${this.x}, ${this.y})`;``            | template literal interior, never reflowed          |
| `comments`      | `const value = 1; // trailing comment on a statement`             | trailing comment ignored for width (entry 6)       |
| `comments`      | `const result = a + b; // trailing on an assignment`              | trailing comment ignored for width (entry 6)       |
| `normalisation` | `const trailingSpaces = 1; // lots of spaces before this comment` | trailing comment ignored for width (entry 6)       |
| `strings`       | ``const template = `a template with ${name} interpolated`;``      | template literal with substitution, never reflowed |
| `strings`       | ``const tagged = tag`tagged ${value} template`;``                 | tagged template, never reflowed                    |

`overflow_lines` exempts lines holding a token longer than the width, which is
why plain long string literals do not show up here; these six are lines whose
individual tokens are all short but which contain an unbreakable span.

## What prettier does that surprised me

### When a container breaks, the containers inside it do **not** break

Constructed and committed as `nesting.js`. At width 40 the outer `config`,
`fits` and `mixed` collections break, but the children that still fit —
`[1, 2, 3, 4]`, `{ key: "value" }`, `[1, 2, 3]`, `{ list: [4, 5, 6] }` — stay on
one line with room to spare. This is the opposite of taplo (which breaks nested
containers unconditionally, across inline-table boundaries). A package that
models each container as an independent group **matches** prettier here.

The one exception is the **array-of-arrays** shape: `matrix` explodes to one
inner array per line at **both** 80 and 40, even though it fits at 80 — the same
"all-children-are-collections" rule JSON's manifest documented. That is a group
whose break decision depends on the _kinds_ of its children.

**Corrected at stage D (2026-08-19): the IR does express this.** This paragraph
originally ended "which the IR cannot express (DESIGN.md, the JSON note)", and
that was wrong when written. `when` + the `all` predicate already encodes it:

```json
["when", ["all", "named", ["array"]], ["hard-branch"], ["group-branch"]]
```

`all` tests every selected child against a list of node types, which is exactly
"are all my children collections". JSON could have done this since round 1. The
note was inherited from DESIGN.md rather than tested, and it survived stage A
and stage B review because nobody built the expression. Stage D built it.

The lesson is narrower than "check your claims": an **inherited** negative claim
is the dangerous kind. A builder who writes "the IR cannot express X" from their
own failed attempt has evidence; one who copies it from a design note has none,
and the two read identically in a report.

### A trailing comment does not count toward its line's width

`const value = 1; // trailing comment on a statement` is 51 characters at width
40 and prettier leaves it flat; the statement itself fits, and the comment is
ignored for the break decision. Same for every trailing comment in `comments.js`
/ `normalisation.js`. prettier will not destroy a flat collection to make room
for a comment it cannot move — the opposite of taplo, and the same as YAML. This
project's own `fits` **does** count a trailing comment, so a package using a
plain `group` will break earlier than prettier on any line whose comment is what
pushes it over (FINDINGS entry 6).

### Token-level normalisation

As opposed to line-level reflow:

- One space after `,` and around binary operators; none inside `()` / `[]` /
  `{}`; one space inside `{ }` braces (`{ x: 1 }` pads, `[1, 2, 3]` does not —
  arrays and objects are not the same shape).
- Empty containers collapse: `f( )` → `f()`, `[ ]` → `[]`, `{ }` → `{}`, and a
  `[\n]` on its own lines → `[]`.
- Indentation is normalised to 2 spaces; a tab-indented block is reindented.
- Runs of spaces before a trailing comment collapse to one space; prettier does
  **not** align trailing comments (no sibling-width alignment in JS).
- Blank-line runs cap at one; zero is left alone. Probed from stage B review
  onward — `normalisation.js` now holds a run of four blank lines that collapses
  to one. Before that this line was a claim the corpus did not force: no corpus
  file had a blank-line run longer than one.
- Quote delimiters and their escapes are chosen to minimise escaping (`'hello'`
  → `"hello"`, `"say \"hi\""` → `'say "hi"'`) — the token rewrite the corpus
  omits, above.
- Object keys that are valid identifiers are unquoted; keys that are not keep
  their quotes and are double-quoted.
- A comment on the same line as `[` is moved to the next line
  (`const collapsed = [ // comment` → the comment on its own line). Comment text
  and order are preserved.
- A broken collection, call or parameter list gets a trailing comma added
  (`trailingComma: all`), which is exactly the `trail` policy — winnable.

### Operator chains, precedence, and the bitwise parens

A long `+` chain breaks at each `+` with no extra indent; a mixed chain
`alpha + beta * gamma - delta / epsilon` breaks at `+` and `-` but never `*` or
`/` — precisely the `flatten` precedence-stop behaviour. But `a && b && c` at 40
does something the IR cannot: prettier breaks the _assignment_
(`const logical =\n  a && b && c && d && e && f && g;`) and leaves the whole
27-char chain on the second line, because it fits there. And the bitwise chain
is not left as a chain at all: prettier **inserts** clarifying parentheses
around `(mask & value)` and `(other << shift)`, which the `paren` policy can
express but a bare `flatten` cannot.

### Method chains break at the dots, and that is unexpressible

`query.filter(x => x.active).map(x => x.name)` becomes
`query\n  .filter(...)\n   .map(...)`. The named tree is unchanged (the `.` is
anonymous), so gate 3 accepts it, but a node-type table cannot express "break
before a `.`" — this is DESIGN.md's method-chain limitation, and `chains.js` is
its JS instance. It is a classified design-limit divergence, not a corpus bug.

### Arrow param parens, and a real gate-3 trap I stepped around

prettier's `arrowParens: always` rewrites `x => x` to `(x) => x`, which changes
the tree from `identifier` to `formal_parameters`. This is **not** a
`transparent_wrappers` case and must **not** become an `equivalent_kinds` entry
— declaring `identifier` equivalent to `formal_parameters` would let a formatter
collapse `(a, b) => …` to `a => …` and pass. The corpus therefore writes every
arrow parameter with its parens, and the manifest declares no equivalence.

### Neither generator needed a change

`gen_trees.py` and `gen_reference.py` both worked from the manifest as written;
no harness script was edited. `./test.sh` is green with zero warnings:
javascript is reported `awaiting package` and excluded from scoring, the stage-0
fix.

## Files touched outside `corpus/` and `harness/languages/`

```
git diff --stat main -- . ':(exclude)corpus' ':(exclude)harness/languages'
```

(empty)

No `rust/`, no `runtime-js/`, no shared harness script. The grammar pin lives in
the manifest; nothing was added to any script's inline `dependencies`.

## Stage B review (Opus, 2026-08-18)

Verdict: **pass with fixes applied**. What was re-derived rather than read:

- **The reference output is genuinely prettier's.** Five files (`operators`,
  `normalisation`, `kitchen`, `chains`, `modern`) were regenerated at both
  widths by running the manifest's command by hand and diffing against the
  committed files: ten of ten byte-identical. `gen_reference.py --check` then
  matched all 28. Nothing was hand-edited.
- **The manifest is reproducible.** `npx --yes prettier@3.9.6 --version` prints
  `3.9.6`, the recorded value.
- **`widths = [80, 40]` is the reference's own default**, re-bisected: an
  81-char 20-item array breaks with no flag and at `--print-width 80`, and stays
  flat at `--print-width 81`.
- **The counts were re-run, not read.** `corpus_stats.py --language javascript`
  reproduces every line of the block above.
- **Trees regenerate byte-identically** and carry no `ERROR` / `MISSING`.
- **Nothing was touched outside `corpus/` and `harness/languages/`** — confirmed
  against `main`, and the diff is 14 sources, 28 reference files, 14 trees, one
  manifest, one report.
- **The excluded-behaviour inventory was spot-checked row by row** by running
  each construct through prettier and then through `gate3.signature`. All eleven
  original rows hold, including the counter-intuitive pair: `'hello'` →
  `"hello"` is **accepted** while `''` → `""` is **rejected** (the empty string
  has no named child, so the quote tokens become the leaf spelling). The
  negative results hold too, except the template-interior one, corrected above.

Three gaps were found and two were fixed in the worktree:

1. **Blank-line collapsing was claimed but not probed** — no corpus file had a
   run longer than one blank line. Fixed in `normalisation.js`.
2. **`objectWrap: preserve` was neither probed nor mentioned**, and it is the
   most decision-relevant fact about prettier's JS layout: object breaking is
   source-sensitive, not width-driven. Fixed in `objects.js` with a
   preserved/collapsed pair.
3. **JSX was not mentioned at all.** Not fixed — flagged as a scope decision,
   with the probe results, in its own section above.

## Template delta

The brief's round-3 framing was accurate and the guesses (grammar _name_
`tree-sitter-javascript`, width `[80, 40]`) were mostly right; the pin `==0.7.0`
was wrong (latest is `0.25.0`, corrected). One genuinely new fact belongs in the
brief's mental model of "what prettier rewrites": for JavaScript, **quote
normalisation is invisible to gate 3** because tree-sitter-javascript uses one
`string` node with an anonymous quote token, so the "prettier rewrites quote
style → gate 3 rejects → omit from corpus" chain that held for YAML/CSS does not
hold here. The correct instruction is "omit quote-style variation to keep
agreement measurable, but it is not a gate-3 failure in JS". The empty-string
and escaped-string cases **do** still reject, so "use double quotes" is still
the right corpus rule.

**Added at stage B review.** Two items belong in `templates/corpus-brief.md`:

- The excluded-behaviour inventory asks what the reference _rewrites_. It should
  also ask what the reference's **options** say it chose not to do — and
  specifically whether any default makes layout depend on the **input's** line
  breaks rather than on width alone. prettier's `objectWrap: preserve` is that
  case, and no amount of reading the output reveals it, because a preserved
  break and a width-driven break look identical.
- The counts (`corpus_stats.py`) cannot see a missing probe for a
  width-insensitive normalisation. Adding the blank-line run and the
  `objectWrap` pair moved none of the four numbers. The brief should say that
  passing the counts is a floor, and that each normalisation the report _lists_
  needs a corpus file that forces it.
