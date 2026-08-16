# JavaScript corpus report (stage A)

## Manifest

`harness/languages/javascript.toml`. Every field that could have been guessed
was observed, not assumed.

| Field                  | Value                                                                    | How it was established                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grammar`              | `tree-sitter-javascript==0.25.0`                                         | Live PyPI: the distribution name matches the orchestrator's `tree_sitter_javascript` guess, but the pin does not. `0.7.0` was the guess; the latest release is `0.25.0` (checked against the live index 2026-08-17).                              |
| `grammar_module`       | `tree_sitter_javascript`                                                 | `uv run --with tree-sitter-javascript==0.25.0` then `import tree_sitter_javascript`. The hyphen-to-underscore swap is correct here.                                                                                                               |
| `grammar_symbol`       | `language`                                                               | The module exports `language()` (plus `HIGHLIGHTS_QUERY`, `INJECTIONS_QUERY`, `LOCALS_QUERY`, `TAGS_QUERY`). It returns a `tree_sitter.Language` capsule. No `language_javascript()`.                                                              |
| `injection_aliases`    | `["javascript", "js"]`                                                   | `javascript` is canonical. `js` is the conventional fence spelling (GitHub linguist, prettier's own support-info aliases, the alias most fences actually use). Both vouched for. `jsx` is TypeScript's grammar, not this one.                      |
| `reference`            | `npx --yes prettier@3.9.6 --no-config --stdin-filepath x.js --print-width {width}` | Source on stdin, formatted source on stdout. `--stdin-filepath x.js` is required (no filepath and no parser: "No parser and no file path given, couldn't infer a parser"). `--no-config` is load-bearing (below).                                  |
| `reference_version`    | `3.9.6`                                                                  | Printed by `npx --yes prettier@3.9.6 --version`. Not assumed. Same pin as CSS/YAML; JSON is still on 3.6.2.                                                                                                                                         |
| `reference_width`      | `flag`                                                                    | Ran the same input at 80 and 40 and diffed: collections, argument lists, operator chains and ternaries reflow; string/template interiors and comments do not. `{width}` is therefore real.                                                          |
| `widths`               | `[80, 40]`                                                                | 80 is prettier's own default, established by bisection: a 20-item number array (`const x = [0, …, 19];`, 81 chars) breaks unprompted and at `--print-width 80`, and stays flat at `--print-width 81`. 40 is the narrow width.                        |
| `gate3`                | `default`                                                                 | See "no override" below.                                                                                                                                                                                                                            |
| `transparent_wrappers` | `["parenthesized_expression"]`                                            | Established by running prettier over the corpus, not by reading the grammar (below).                                                                                                                                                                |
| `equivalent_kinds`     | `[]`                                                                      | Nothing was renamed; every structural change was a `parenthesized_expression` added or removed around one child.                                                                                                                                     |

### `--no-config` is load-bearing

prettier walks cwd and ancestors for `.prettierrc` / `prettier.config.*` / a
`package.json` `"prettier"` key, and — because the command passes a filepath —
reads `.editorconfig` from that path. A planted config with `singleQuote: true`
and `semi: false` (options the command line does **not** name) silently
requotes and de-semicolons, and a planted `.editorconfig` with `indent_size = 8`
re-indents. All three channels are verified inert under `--no-config`. CLI
`--print-width` wins over a file `printWidth` (the taplo shape: the file fills
every option the CLI does not name). There is no `PRETTIER_CONFIG` env var; the
residual channel is an explicit `--config`, which cannot be combined with
`--no-config`. `gen_reference.py --check` is silent (exit 0); two runs of the
same stdin match.

### No gate3 override, and why the loader trap does not bite here

The generic default is selected. The round-1 lesson — that `tomllib` /
`json.loads`-style data loaders collapse the spellings a formatter must
preserve — does not apply to JavaScript the way it applied to TOML/YAML,
because **tree-sitter-javascript represents both quote styles as one `string`
node** with an anonymous quote token and a named `string_fragment`. prettier's
quote normalisation (`'hello'` → `"hello"`) therefore leaves the named tree
unchanged, so the generic default already accepts it. The gate is not weaker
for it; it is measuring the right thing. No data-model loader is involved.

`check_gate3.py --language javascript`: 28 reference outputs accepted, 56
destructive mutations rejected, 500 useful adversarial mutations (arm inert —
no override), 0 wrapper kinds beyond `parenthesized_expression`, 11 injection
cases checked.

### `transparent_wrappers` — prettier both adds and removes the parens

Running prettier over the corpus, gate 3 named `parenthesized_expression` in
five files, and every occurrence is the same shape: the wrapper appears or
disappears around **exactly one** named child. In JavaScript `(expr)` is always
the same expression as `expr`, so the wrapper is genuinely transparent (unlike
Scheme, where `(f)` is a call). The five:

- **removed, redundant**: `((1 + 2))` → `1 + 2` (`normalisation`), a nested
  ternary's parens (`control_flow`, `kitchen`).
- **added, clarifying**: `config ??= defaults` → `(config ??= defaults)` (same
  for `&&=` / `||=`, `modern`); mixed-bitwise `flags | mask & value ^ other << shift`
  → `flags | ((mask & value) ^ (other << shift))` (`operators`).

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

| Rewrite                                                    | Class                                         | gate3       | In corpus?                                                            |
| ---------------------------------------------------------- | --------------------------------------------- | ----------- | --------------------------------------------------------------------- |
| `'hello'` → `"hello"` (fragment unchanged)                 | anonymous-token text rewrite                  | **accepts** | No — corpus uses double quotes; a package cannot change the quote token |
| `'it\'s'` → `"it's"`, `"say \"hi\""` → `'say "hi"'`        | named-leaf text rewrite (escape_sequence)     | **rejects** | No                                                                    |
| `''` → `""` (empty string)                                | anonymous-token rewrite of a no-named-child node | **rejects** | No                                                                    |
| `{ 'quoted': 1 }` → `{ quoted: 1 }` (unquote valid id)    | node-kind rename (`string` → `property_identifier`) | **rejects** | No — bare keys                                                         |
| `{ 'hyphen-key': 1 }` → `{ "hyphen-key": 1 }`             | anonymous-token rewrite                       | **accepts** | Uses double quotes                                                    |
| `x => x` → `(x) => x` (arrow param parens)                | structural (`identifier` → `formal_parameters`) | **rejects** | No — corpus writes `(x) => x`                                          |
| `(1 + 2)` → `1 + 2`, `((x))` → `x` (redundant parens)     | **deletion**                                  | accepts w/ wrapper | One line, measured unwinnable                                      |
| `a ??= b` → `(a ??= b)`, mixed bitwise parens             | **addition** (paren policy)                   | accepts w/ wrapper | Yes — winnable                                                       |
| `0xFF`→`0xff`, `.5`→`0.5`, `1E10`/`1e+10`→`1e10`, `0B1`→`0b1` | named-leaf text rewrite (`number`)      | **rejects** | No — canonical spellings                                              |
| missing `;` → `;` added                                    | **addition** (anonymous)                      | **accepts** | No — corpus writes semicolons                                          |
| trailing comma on a broken collection/call/params          | **addition** (trail policy)                   | **accepts** | Yes — winnable                                                         |

The surprising column is the first: quote normalisation is **not** a
gate-3-rejecting rewrite in JavaScript the way it is in YAML (different node
kind) or Python (black rewrites the leaf). tree-sitter's uniform `string` node
hides it. That does not make it winnable — a package still cannot change an
anonymous quote token — but it does mean the corpus could have included
single-quoted strings without failing "the reference must pass gate 3". It
chose not to, to keep agreement measurable.

**Negative results worth recording** (prettier does *not* do these, so the
corpus is free to use them): it does **not** convert template literals to
strings (`` `hello` `` stays a template), does **not** reorder imports or
object keys, does **not** rewrite numeric separators (`1_000` stays) or
trailing `.0` (`1000.0` stays), does **not** rewrite booleans / `null` /
`undefined`, and does **not** touch template-literal interiors, regex
literals, or bigint.

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
  spaces before a trailing comment, tab-indented block.
- `kitchen.js` — spread, arrow callbacks, filter/map/sort chains, an object
  literal inside a map, a for-loop.

Characteristic of JavaScript, one line each:

- `operators.js` — `+`/`*` chains (the `flatten` spine and its precedence stop),
  `&&`/`||` chains, ternaries including a nested one, comparison, bitwise.
- `functions.js` — declarations, defaults, rest, expression, arrows, object
  return, `async`/`await`, generators.
- `classes.js` — fields, methods, getters/setters, `static`, `extends`, private
  `#` fields and methods.
- `objects.js` — shorthand, spread, computed keys, methods, async method,
  nested objects, destructuring with defaults/rest/rename.
- `chains.js` — method chains, which prettier breaks at the dots — a layout the
  IR cannot express (DESIGN.md "method chains at the dots"), so this file is a
  known, classified design-limit divergence, the JS analogue of `chains.py`.
- `control_flow.js` — `if`/`else if`/`else`, `for`, `for...of`, `while`,
  `switch` fallthrough, `try`/`catch`/`finally`, a parenthesised nested ternary.
- `modules.js` — default/named/namespace imports, a long named-import list,
  `export const`/`function`/`default`/`export { }`.
- `modern.js` — optional chaining, nullish coalescing, `??=`/`&&=`/`||=`,
  regex literal, bigint, `**`, dynamic `import()`.

**Comments.** 14 of 14 files carry at least one comment; gate 3's extras layer
is live on every file. Most are a one-line header describing the probe, which
doubles as a trailing/own-line comment the runtime must preserve.

**Injection.** The corpus files are whole modules, but they are built from
statement-level (imports, declarations, control flow) and expression-level
(arrow bodies, object literals, call arguments) constructs that a Markdown
fence will later wrap as fragments; nothing in the corpus assumes a `program`
root. `injection_aliases = ["javascript", "js"]` is declared so the injection
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

## Reference overflow

`@80 0  @40 6`. All six overruns are lines prettier **refuses** to break, not
corpus bugs:

| File            | Line                                                                 | Cause                                            |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| `classes`       | `` return `${this.#label} at (${this.x}, ${this.y})`; ``              | template literal interior, never reflowed        |
| `comments`      | `const value = 1; // trailing comment on a statement`                 | trailing comment ignored for width (entry 6)     |
| `comments`      | `const result = a + b; // trailing on an assignment`                  | trailing comment ignored for width (entry 6)     |
| `normalisation` | `const trailingSpaces = 1; // lots of spaces before this comment`     | trailing comment ignored for width (entry 6)     |
| `strings`       | `` const template = `a template with ${name} interpolated`; ``        | template literal with substitution, never reflowed |
| `strings`       | `` const tagged = tag`tagged ${value} template`; ``                   | tagged template, never reflowed                  |

`overflow_lines` exempts lines holding a token longer than the width, which is
why plain long string literals do not show up here; these six are lines whose
individual tokens are all short but which contain an unbreakable span.

## What prettier does that surprised me

### When a container breaks, the containers inside it do **not** break

Constructed and committed as `nesting.js`. At width 40 the outer `config`,
`fits` and `mixed` collections break, but the children that still fit —
`[1, 2, 3, 4]`, `{ key: "value" }`, `[1, 2, 3]`, `{ list: [4, 5, 6] }` — stay
on one line with room to spare. This is the opposite of taplo (which breaks
nested containers unconditionally, across inline-table boundaries). A package
that models each container as an independent group **matches** prettier here.

The one exception is the **array-of-arrays** shape: `matrix` explodes to one
inner array per line at **both** 80 and 40, even though it fits at 80 — the
same "all-children-are-collections" rule JSON's manifest documented. That is a
group whose break decision depends on the *kinds* of its children, which the
IR cannot express (DESIGN.md, the JSON note).

### A trailing comment does not count toward its line's width

`const value = 1; // trailing comment on a statement` is 51 characters at
width 40 and prettier leaves it flat; the statement itself fits, and the
comment is ignored for the break decision. Same for every trailing comment in
`comments.js` / `normalisation.js`. prettier will not destroy a flat collection
to make room for a comment it cannot move — the opposite of taplo, and the
same as YAML. This project's own `fits` **does** count a trailing comment, so
a package using a plain `group` will break earlier than prettier on any line
whose comment is what pushes it over (FINDINGS entry 6).

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
- Blank-line runs cap at one; zero is left alone.
- Quote delimiters and their escapes are chosen to minimise escaping (`'hello'`
  → `"hello"`, `"say \"hi\""` → `'say "hi"'`) — the token rewrite the corpus
  omits, above.
- Object keys that are valid identifiers are unquoted; keys that are not keep
  their quotes and are double-quoted.
- A comment on the same line as `[` is moved to the next line
  (`const collapsed = [ // comment` → the comment on its own line). Comment
  text and order are preserved.
- A broken collection, call or parameter list gets a trailing comma added
  (`trailingComma: all`), which is exactly the `trail` policy — winnable.

### Operator chains, precedence, and the bitwise parens

A long `+` chain breaks at each `+` with no extra indent; a mixed chain
`alpha + beta * gamma - delta / epsilon` breaks at `+` and `-` but never
`*` or `/` — precisely the `flatten` precedence-stop behaviour. But `a && b && c`
at 40 does something the IR cannot: prettier breaks the *assignment* (`const
logical =\n  a && b && c && d && e && f && g;`) and leaves the whole 27-char
chain on the second line, because it fits there. And the bitwise chain is not
left as a chain at all: prettier **inserts** clarifying parentheses around
`(mask & value)` and `(other << shift)`, which the `paren` policy can express
but a bare `flatten` cannot.

### Method chains break at the dots, and that is unexpressible

`query.filter(x => x.active).map(x => x.name)` becomes `query\n  .filter(...)\n
  .map(...)`. The named tree is unchanged (the `.` is anonymous), so gate 3
accepts it, but a node-type table cannot express "break before a `.`" — this
is DESIGN.md's method-chain limitation, and `chains.js` is its JS instance. It
is a classified design-limit divergence, not a corpus bug.

### Arrow param parens, and a real gate-3 trap I stepped around

prettier's `arrowParens: always` rewrites `x => x` to `(x) => x`, which changes
the tree from `identifier` to `formal_parameters`. This is **not** a
`transparent_wrappers` case and must **not** become an `equivalent_kinds` entry
— declaring `identifier` equivalent to `formal_parameters` would let a
formatter collapse `(a, b) => …` to `a => …` and pass. The corpus therefore
writes every arrow parameter with its parens, and the manifest declares no
equivalence.

### Neither generator needed a change

`gen_trees.py` and `gen_reference.py` both worked from the manifest as
written; no harness script was edited. `./test.sh` is green with zero
warnings: javascript is reported `awaiting package` and excluded from scoring,
the stage-0 fix.

## Files touched outside `corpus/` and `harness/languages/`

```
git diff --stat main -- . ':(exclude)corpus' ':(exclude)harness/languages'
```

(empty)

No `rust/`, no `runtime-js/`, no shared harness script. The grammar pin lives
in the manifest; nothing was added to any script's inline `dependencies`.

## Template delta

The brief's round-3 framing was accurate and the guesses (grammar *name*
`tree-sitter-javascript`, width `[80, 40]`) were mostly right; the pin
`==0.7.0` was wrong (latest is `0.25.0`, corrected). One genuinely new fact
belongs in the brief's mental model of "what prettier rewrites": for
JavaScript, **quote normalisation is invisible to gate 3** because
tree-sitter-javascript uses one `string` node with an anonymous quote token,
so the "prettier rewrites quote style → gate 3 rejects → omit from corpus"
chain that held for YAML/CSS does not hold here. The correct instruction is
"omit quote-style variation to keep agreement measurable, but it is not a
gate-3 failure in JS". The empty-string and escaped-string cases **do** still
reject, so "use double quotes" is still the right corpus rule.
