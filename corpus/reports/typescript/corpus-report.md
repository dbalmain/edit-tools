# TypeScript corpus report (stage A)

**Builder:** grok-4.6 via the grok CLI.

## Manifest

`harness/languages/typescript.toml`. Every field that could have been guessed
was observed, not assumed.

| Field                  | Value                                                                               | How it was established                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grammar`              | `tree-sitter-typescript==0.23.2`                                                    | Live PyPI: the distribution name matches the orchestrator's `tree_sitter_typescript` guess, but the pin does not. `0.7.0` was the guess; the latest release is `0.23.2` (checked against the live index 2026-08-21). JavaScript's sibling is on `tree-sitter-javascript==0.25.0`; the TypeScript grammar lags.                                                               |
| `grammar_module`       | `tree_sitter_typescript`                                                            | `uv run --with tree-sitter-typescript==0.23.2` then `import tree_sitter_typescript`. The hyphen-to-underscore swap is correct here.                                                                                                                                                                                                                                          |
| `grammar_symbol`       | `language_typescript`                                                               | The module exports **only** `language_typescript` and `language_tsx`. There is no `language()`. Both return a `tree_sitter.Language` capsule. Pick below.                                                                                                                                                                                                                    |
| `injection_aliases`    | `["typescript", "ts"]`                                                              | `typescript` is canonical. `ts` is prettier's own alias, GitHub linguist's, and the conventional fence spelling. Both vouched for. `tsx` / `typescriptreact` belong to `language_tsx`. `javascript` / `js` are taken.                                                                                                                                                        |
| `reference`            | `npx --yes prettier@3.9.6 --no-config --stdin-filepath x.ts --print-width {width}`  | Source on stdin, formatted source on stdout. `--stdin-filepath x.ts` is required (below). `--no-config` is load-bearing (below). `--parser typescript` is an alternative that produces byte-identical output and is omitted as redundant.                                                                                                                                   |
| `reference_version`    | `3.9.6`                                                                             | Printed by `npx --yes prettier@3.9.6 --version`. Not assumed. Same pin as JavaScript/CSS/YAML; JSON is still on 3.6.2.                                                                                                                                                                                                                                                       |
| `reference_width`      | `flag`                                                                              | Ran the same input at 80 and 40 and diffed: arrays, type-parameter lists, unions, type literals and argument lists reflow; string/template interiors and comments do not. `{width}` is therefore real.                                                                                                                                                                       |
| `widths`               | `[80, 40]`                                                                          | 80 is prettier's own default, established by bisection (below). 40 is the narrow width; it forces the union, generic-parameter and type-literal decisions 80 lets a package dodge. Same pair as JavaScript, re-bisected here rather than inherited.                                                                                                                          |
| `gate3`                | `default`                                                                           | See "no override" below.                                                                                                                                                                                                                                                                                                                                                     |
| `transparent_wrappers` | `["parenthesized_expression", "union_type"]`                                        | Established by running prettier over the corpus, not by reading the grammar (below). `union_type` is the TypeScript-only addition.                                                                                                                                                                                                                                           |
| `equivalent_kinds`     | `[]`                                                                                | Nothing was renamed. Every structural change was a single-child wrapper added or removed.                                                                                                                                                                                                                                                                                    |

### `language_typescript`, not `language_tsx`

The two functions are not aliases. Parsed the same snippets through both:

| Construct              | `language_typescript` | `language_tsx` |
| ---------------------- | --------------------- | -------------- |
| `const x: number = 1`  | clean                 | clean          |
| `const x = <number>v`  | clean                 | **ERROR**      |
| `const f = <T>(a: T) => a` | clean             | clean          |
| `const el = <div/>`    | **ERROR**             | clean          |
| interfaces, enums, `satisfies`, overloads, decorators | clean | clean |

Picking `language_typescript` is the TypeScript grammar: angle-bracket assertions are in the corpus (`assertions.ts`), JSX is not. Picking `language_tsx` would have inverted that — JSX in, angle assertions out — and would have made `tsx` a legitimate injection alias. JavaScript already treated JSX as a scope exclusion; repeating it under a TSX grammar would have been a different language. The generic-arrow form `<T>(a: T) => a` parses on both, so it does not decide.

### `--stdin-filepath x.ts` is required; `x.typescript` is not a filename

Without a filepath and without `--parser`: `"No parser and no file path given, couldn't infer a parser."` The brief's example `--stdin-filepath x.typescript` also fails: `"No parser could be inferred for file …/x.typescript"`. `--stdin-filepath x.ts` works. `--parser typescript` with no filepath also works and is byte-identical to `--stdin-filepath x.ts` on the probes; it is omitted because the filepath is what prettier's sibling manifests use, and because the filepath is also the path editorconfig would read if `--no-config` were dropped.

`--stdin-filepath x.js` on TypeScript source is a SyntaxError (`Unexpected token` at the `: ` of a type annotation). The extension is not decorative.

### `--no-config` is load-bearing

prettier walks cwd and ancestors for `.prettierrc` / `prettier.config.*` / a
`package.json` `"prettier"` key, and — because the command passes a filepath —
reads `.editorconfig` from that path. Method: planted a config that sets
options the command line does **not** pass (`singleQuote: true`, `semi: false`,
`tabWidth: 4`), then diffed.

| Channel                         | Without `--no-config`                         | With `--no-config` |
| ------------------------------- | --------------------------------------------- | ------------------ |
| `.prettierrc` in cwd            | requotes, de-semicolons, re-indents           | inert              |
| `.prettierrc` in an ancestor    | same (search walks up)                        | inert              |
| `package.json` `"prettier"` key | requotes, de-semicolons                       | inert              |
| `.editorconfig` `indent_size=8` | re-indents to 8                               | inert              |
| `PRETTIER_CONFIG` env var       | does not exist; no effect                     | n/a                |

CLI `--print-width` wins over a file `printWidth` (a planted `printWidth: 20`
did not wrap an 80-flat array when the CLI passed 80). The file fills every
option the CLI does not name — the taplo shape. `--no-config` also kills
editorconfig; `--no-editorconfig` is therefore redundant and is not in the
command. There is no residual env channel. An explicit `--config` cannot be
combined with `--no-config`. `gen_reference.py --check` is silent (exit 0);
two runs of the same stdin match.

### Widths, by bisection not by `--help`

prettier `--help` and `getSupportInfo()` both say 80, but the brief forbids
trusting that. A 19-item number array (`const x = [0, …, 18];`, 77 chars) stays
flat unprompted; a 20-item one (81 chars) breaks unprompted. `--print-width 80`
matches the unprompted output byte-for-byte on that boundary; `--print-width 81`
keeps the 20-item array flat. A typed array `const x: number[] = […];` bisects
at the same column, just a few items earlier because of the annotation. 40 is
the narrow width.

### No gate3 override

The generic default is selected. tree-sitter-typescript, like
tree-sitter-javascript, represents both quote styles as one `string` node with
an anonymous quote token (and string-literal types the same way), so prettier's
quote normalisation (`'hello'` → `"hello"`, `"hello" \| "world"` for a
string-literal union) leaves the named tree unchanged. A data-model loader
would collapse `1_000` vs `1000` and the quote spellings a formatter must
preserve. No override, no loader.

`check_gate3.py --language typescript`: 30 reference outputs accepted, 60
destructive mutations rejected, 496 useful adversarial mutations (arm inert —
no override), 11 injection cases checked.

### `transparent_wrappers` — prettier adds and removes two wrappers

Left empty to start. `check_gate3.py` then named two kinds, and only those two,
on ten of the thirty reference runs:

- **`parenthesized_expression`**, around exactly one named child.
  **Removed:** `((1 + 2))` → `1 + 2` (`normalisation`); a nested ternary's
  parens once the ternary itself breaks (`kitchen@40`).
  **Added:** `a + b as number` → `(a + b) as number` (`assertions`). In
  TypeScript that parse is `(a + b) as number`; the parens are clarifying,
  not a meaning change. Same wrapper JS already declared, same justification:
  `(expr)` is `expr`.

- **`union_type`**, around exactly one named child. This is the TypeScript-only
  one. A leading `|` on a broken union is not anonymous decoration hanging off
  an existing node: tree-sitter-typescript wraps the first member in an extra
  unary `union_type`:

  ```
  A | B | C        →  union(union(A, B), C)
  | A | B | C      →  union(union(union(|, A), B), C)
  ```

  The unary node has one named child (`A`), so declaring `union_type`
  transparent elides it and the two trees match. A binary `union_type` has two
  named children and is **not** elided, so this does not let a formatter drop
  `| B` from `A | B`. prettier both inserts the unary wrapper (a one-line union
  that overflows) and deletes it (a source-broken union that fits collapses and
  loses the leading `|`). Same add-and-remove shape as `parenthesized_expression`.

No other kind was named. `equivalent_kinds` stays empty.

## The excluded-reference-behaviour inventory

Each row was established by running prettier 3.9.6 on a probe and diffing, then
where it matters running the result through the generic signature. "gate3" is
whether the generic default (with the two wrappers above) accepts the rewrite.

| Rewrite                                                            | Class                                               | gate3              | In corpus?                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------- | ------------------ | -------------------------------------------------------------------------- |
| `'hello'` → `"hello"` (fragment unchanged)                         | anonymous-token text rewrite                        | **accepts**        | No — corpus uses double quotes; a package cannot change the quote token    |
| `'hello' \| 'world'` as a string-literal type → double quotes      | same, on `string` / `string_fragment`               | **accepts**        | No — same reason; type-level quotes are the same node                      |
| `''` → `""` (empty string)                                         | anonymous-token rewrite of a no-named-child node    | **rejects**        | No                                                                         |
| `'it\'s'` → `"it's"`                                               | named-leaf text rewrite (`escape_sequence`)         | **rejects**        | No                                                                         |
| `x => x` → `(x) => x`                                              | structural (`identifier` → `formal_parameters`)     | **rejects**        | No — corpus writes `(x) => x`                                              |
| `((1 + 2))` → `1 + 2`                                              | **deletion**                                        | accepts w/ wrapper | One line, measured unwinnable (`normalisation`)                            |
| `a + b as number` → `(a + b) as number`                            | **addition** (paren policy)                         | accepts w/ wrapper | Yes — winnable                                                             |
| leading `\|` on a broken union (`A \| B` → `\| A \| B`)            | **addition** of a unary `union_type`                | accepts w/ wrapper | Yes — see surprises; a package cannot add a leading `\|` only when broken  |
| `.5` → `0.5`, `0xFF` → `0xff`, `1E10` → `1e10`                     | named-leaf text rewrite (`number`)                  | **rejects**        | No — canonical spellings                                                   |
| `1_000`, `1000.0`                                                  | unchanged                                           | —                  | Fine to use                                                                |
| `Array<string>` ↔ `string[]`                                       | unchanged                                           | —                  | Both used; prettier does not convert                                       |
| `<number>value` ↔ `value as number`                                | unchanged                                           | —                  | Both used; prettier does not convert                                       |
| `import type { Foo }` ↔ `import { type Foo }`                      | unchanged                                           | —                  | Both used; prettier does not convert                                       |
| imports reordered                                                  | does not happen                                     | —                  | Free to use out-of-order imports                                           |
| missing `;` → `;` added                                            | **addition** (anonymous)                            | **accepts**        | No — corpus writes semicolons                                              |
| trailing comma on a broken collection / call / type params         | **addition** (trail policy)                         | **accepts**        | Yes — winnable                                                             |
| a run of 2+ blank lines collapses to one                           | whitespace-only                                     | **accepts**        | Yes — `normalisation.ts`                                                   |
| a source-expanded type literal stays expanded (`objectWrap`)       | layout, **source-sensitive** — not width            | **accepts**        | Yes — `nesting.ts`                                                         |
| enums always expand, even one member that fits                     | layout, **not width**                               | **accepts**        | Yes — `enums.ts`                                                           |
| a one-member interface always expands                              | layout, **not width**                               | **accepts**        | Yes — `interfaces.ts` (`Named`)                                            |
| `` css`…` `` interiors reformatted                                 | named-leaf rewrite                                  | **rejects**        | No — no tagged-template interiors prettier knows                           |

**Negative results** (prettier does _not_ do these, so the corpus is free to
use them): it does not convert template literals to strings, does not rewrite
`as` to angle-brackets or the reverse, does not rewrite `Array<T>` to `T[]`,
does not sort imports, does not rewrite numeric separators or trailing `.0`,
does not touch regex literals or bigint, does not rewrite `satisfies` to `as`.

Quote normalisation is invisible to gate 3 for the same reason it is in
JavaScript. The corpus still uses double quotes so agreement stays measurable.

## What prettier's own options say it chose not to do

Same table as JavaScript, re-checked against `prettier@3.9.6 --help` plus a
TypeScript probe, because a default that makes layout depend on the input's
line breaks is not visible in a diff of already-broken output.

| Option                         | Default     | What the default decides in TypeScript                                                                                          |
| ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `objectWrap`                   | `preserve`  | Applies to **object literals and type literals**. An object/type whose source has a newline after `{` stays expanded even when it fits. Interfaces and enums ignore it (they always expand). |
| `experimentalOperatorPosition` | `end`       | Value-level binary chains keep the operator at the end of the line. **Unions do not use this option** — they lead with `\|` when they break, regardless. Intersections follow `end` (`&` at the end of the line). |
| `experimentalTernaries`        | off         | Conditional types use the classic nested-ternary indent, not "curious ternaries".                                               |
| `embeddedLanguageFormatting`   | `auto`      | On. No recognised tagged template is in this corpus.                                                                            |
| `arrowParens`                  | `always`    | `(x) => x`. The corpus writes the default spelling.                                                                             |
| `trailingComma`                | `all`       | Includes type parameters: a broken `<T, U>` gets a trailing comma.                                                              |
| `semi`                         | on          | Semicolons inserted; interfaces use `;` between members even when the source used `,`.                                          |

`objectWrap: preserve` is load-bearing for type literals the same way it is for
JavaScript objects. The corpus's own source layout is therefore load-bearing:
`PreservedBySource` in `nesting.ts` is written with a newline after `{` on
purpose.

## Corpus

Fifteen files in `corpus/src/typescript/`. Each is valid TypeScript: clean
under tree-sitter-typescript 0.23.2 with `language_typescript` (no `ERROR` /
`MISSING`) and accepted by prettier 3.9.6. This is not JavaScript-plus-colons.

Required probes:

- `nesting.ts` — nested type literals, nested object values, nested generics
  (`Promise<Map<…>>`), calls inside calls. At 40 the outer containers break
  but children that still fit (`{ key: string }`, `[1, 2, 3, 4]`,
  `deeper(first, second)`) stay flat. Also the `objectWrap` pair: a
  source-expanded type literal that would fit and stays expanded, next to a
  source-expanded tuple that collapses at 80 and breaks at 40.
- `sequences.ts` — the overflow constructs: a long number array (which
  **packs** — fill), a long identifier array (one per line), a long argument
  list, a named tuple, a function type, a long `import type` list.
- `comments.ts` — every position, including type-level ones: file-level,
  trailing on a statement, own-line before a declaration, inside an interface,
  mid-union block comment, trailing on a union member (prettier moves it onto
  the leading `\|` line), on a type parameter, inside type arguments, after
  `[`, inside an enum, JSDoc, before a closing brace, at end of file.
- `strings.ts` — double-quoted strings, escapes, unicode, astral scalars,
  templates with and without substitution, a multi-line template, a tagged
  template, concatenation, plus string-literal types and template-literal
  types. Interiors never reflow.
- `normalisation.ts` — wrong spacing around operators, colons and type
  arguments, `f( )` / `[ ]` / `{ }` / `type T = { }` / `interface I { }` /
  `type T = [ ]` / `function f( )` empty containers, padded brackets, tight
  braces, `((1 + 2))`, `if(x){...}else{...}`, runs of spaces before a trailing
  comment, tab-indented block, a run of four blank lines. The empty containers
  include the type-level ones whose nodes (`object_type`, `interface_body`,
  `tuple_type`, `arguments`, `array`, `object`, `formal_parameters`) have no
  named children. Gate 3 accepted prettier's collapse of all of them; the
  round-2 empty-container defect does not reproduce here.
- `kitchen.ts` — `import type`, an interface, `satisfies`, a generic function
  returning an indexed access, a type-predicate filter, `as` inside a map,
  `implements`, a union alias, a for-loop.

Characteristic of TypeScript, one line each:

- `annotations.ts` — the everyday bindings a wrong format would show: vars,
  optional/rest/`this` parameters, return types, type predicates, `asserts`,
  parameter properties, `keyof typeof`, indexed access.
- `generics.ts` — long type-parameter lists with constraints and defaults,
  `const` type parameters, the generic arrow `<T>(value: T) => value` that
  only the TypeScript grammar (not TSX) is being asked to hold, explicit type
  arguments on calls.
- `unions.ts` — unions that overflow (leading `\|`), a union that fits (no
  leading `\|`), intersections (trailing `&`, no leading), a union inside a
  generic that stays flat at 80 and leads with `\|` at 40, a constrained type
  parameter, a nested conditional type, a union of function types.
- `interfaces.ts` — members including `readonly`/`?`, `extends` lists that
  break, call/construct/index signatures, `this` parameters, getters/setters.
  A one-member interface expands even when it fits; that is not `objectWrap`.
- `enums.ts` — numeric, string, const, computed, a one-member form. prettier
  expands every enum at every width; written compact so the rewrite is probed.
- `decorators.ts` — class, property, parameter, method, and a factory whose
  argument object reflows at 40.
- `assertions.ts` — `as`, double `as unknown as`, angle-bracket assertion
  (the construct that forbade `language_tsx`), `as const`, `satisfies`,
  `a + b as number` (prettier inserts parens), non-null, `as const satisfies`.
- `overloads.ts` — function, constructor, and method overload signatures; the
  implementation is the last one and the only one with a body.
- `mapped.ts` — mapped types with `readonly`/`?`/`-readonly`/`-?` modifiers,
  `infer` in a nested conditional, template-literal types, recursive
  `DeepPartial`.

**Comments.** 15 of 15 files carry at least one comment; gate 3's extras layer
is live on every file. Most are a one-line header describing the probe.

**Injection.** `injection_aliases = ["typescript", "ts"]`. The corpus files are
whole modules built from statement-level and type-level constructs a Markdown
fence will later wrap as fragments; nothing assumes a `program` root beyond
what the grammar requires.

**Empty containers.** Written with a space inside, including the type-level
ones. Gate 3 accepted prettier's output on every one. Not a finding.

## Corpus-quality counts

From `./harness/corpus_stats.py --language typescript` against the committed
reference:

```
typescript  --  15 files, vs 3.9.6
  reference changes    15/15 at some width   (@80 13/15  @40 15/15)
  differs by width     14/15
  carries a comment    15/15
  reference overflow   @80 0  @40 8
```

Two independent `cmp` loops agree: 15 of 15 files differ from their input at
some width, and 14 of 15 differ between width 80 and width 40. The one
width-insensitive file is `enums` — prettier expands every enum the same way
at any width, so the two reference outputs are byte-identical (and both
differ from the compact source). 14/15 is far above the one-third floor.

The two files unchanged at 80 (`decorators`, `overloads`) reflow at 40, so
they still discriminate the two widths. They are not the "already formatted"
trap: they probe constructs prettier leaves alone at its default and breaks
when asked to be narrower.

## Reference overflow

`@80 0  @40 8`. All eight overruns are lines prettier **refuses** to break,
not corpus bugs. `overflow_lines` exempts lines holding a token longer than
the width (header comments, the long string literal); these eight are lines
whose individual tokens are all short but which contain an unbreakable span.

| File            | Line                                                              | Cause                                              |
| --------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `comments`      | `const value: number = 1; // trailing comment on a statement`     | trailing comment ignored for width                 |
| `comments`      | `  second: string; // trailing on a member`                       | trailing comment ignored for width                 |
| `comments`      | `  \| Alpha // trailing on the first member`                      | trailing comment ignored for width                 |
| `comments`      | `  const result = x as unknown as U; // trailing on an assignment`| trailing comment ignored for width                 |
| `comments`      | `  Promise</* inside type arguments */ string>;`                  | inline block comment ignored for width             |
| `normalisation` | `const trailingSpaces: number = 1; // lots of spaces before this comment` | trailing comment ignored for width     |
| `strings`       | ``const template: string = `a template with ${name} interpolated`;`` | template literal with substitution, never reflowed |
| `strings`       | ``const tagged: string = tag`tagged ${value} template`;``         | tagged template, never reflowed                    |

Same two causes JavaScript already reported: trailing comments do not count
toward the break decision, and template interiors never reflow.

## What prettier does that surprised me

### When a container breaks, the containers inside it do **not** break

Constructed and committed as `nesting.ts` and `unions.ts`. At width 40 the
outer `Nested` / `config` / `call` / `Promise<Map<…>>` break, but the children
that still fit — `{ key: string }`, `{ key: "value" }`, `[1, 2, 3]`,
`[1, 2, 3, 4]`, `deeper(first, second)`, `Set<ReadonlyArray<number>>` — stay
on one line with room to spare.

The same fact at the type level, which is the one a TypeScript package will
get wrong if it copies taplo: at width 80, `Promise<` breaks around
`VeryLongAlpha | VeryLongBeta | VeryLongGamma | VeryLongDelta | VeryLongEpsilon`
and that inner union **stays flat** (it is exactly 80 characters). At width 40
the inner union then breaks, with a leading `|`. A parent breaking is not a
signal to break the child. A package that models each container as an
independent group **matches** prettier here.

`kitchen@40` is the same observation on a union that is the RHS of a broken
assignment: `type Result =\n  Success | Failure | Pending;` — the alias
breaks, the union does not, and there is no leading `|` because the union
group itself stayed flat.

This is the opposite of taplo (which breaks nested containers unconditionally)
and the same as JavaScript prettier.

### A trailing comment does not count toward its line's width

`const value: number = 1; // trailing comment on a statement` is 59 characters
at width 40 and prettier leaves it flat; the statement itself fits, and the
comment is ignored for the break decision. Same for every trailing comment in
`comments.ts` / `normalisation.ts`, including trailing comments on interface
members and on a leading-`|` union member. prettier will not destroy a flat
type or array to make room for a comment it cannot move. This project's own
`fits` **does** count a trailing comment, so a package using a plain `group`
will break earlier than prettier on any line whose comment is what pushes it
over (FINDINGS entry 6). The eight overflow lines at 40 are mostly this.

### Token-level normalisation

As opposed to line-level reflow:

- One space after `,` and `:` in types (`a:number` → `a: number`); one space
  around binary operators; none inside `()` / `[]` / `<>` type arguments
  (`identity< string , number >( 1 )` → `identity<string, number>(1)`); one
  space inside `{ }` braces in both object literals and type literals
  (`{ x: 1 }`, `{ x: number }`) — arrays and tuples do not pad (`[1, 2, 3]`,
  `[number, string]`).
- Empty containers collapse, value-level and type-level: `f( )` → `f()`,
  `[ ]` → `[]`, `{ }` → `{}`, `type T = { }` → `type T = {}`,
  `interface I { }` → `interface I {}`, `type T = [ ]` → `type T = []`,
  `function f( )` → `function f()`.
- Indentation is normalised to 2 spaces; a tab-indented block is reindented.
- Runs of spaces before a trailing comment collapse to one space; prettier
  does not align trailing comments.
- Blank-line runs cap at one; zero is left alone. `normalisation.ts` holds a
  run of four blank lines that collapses to one.
- Interface members always use `;`, even when the source used `,`.
- A comment on the same line as `[` is moved to the next line. Comment text
  and order are preserved. A trailing comment on `Alpha |` is moved onto the
  leading-`|` line (`| Alpha // trail`).
- A broken collection, call, parameter list or type-parameter list gets a
  trailing comma (`trailingComma: all`), which is the `trail` policy —
  winnable, including on `<T, U,>`.

### Unions lead with `|`; intersections do not lead with `&`

This is the layout a TypeScript package will spend its time on.

A union that overflows becomes

```
type LongUnion =
  | VeryLongTypeNameAlpha
  | VeryLongTypeNameBeta
  | VeryLongTypeNameGamma
  | VeryLongTypeNameDelta;
```

The leading `|` on the **first** member is a token prettier adds only when
the union group breaks, and removes when the union fits (`FitsUnion` stays
`Alpha | Beta | Gamma`; a source-broken `| Alpha | Beta` that fits collapses
and loses the pipe). Subsequent `|` sit at the start of the line, which is
the opposite of `experimentalOperatorPosition: end` and is **not controlled
by that option**.

An intersection that overflows keeps `&` at the end of the line and, at 40,
hangs the continuations one indent deeper:

```
type LongIntersection =
  VeryLongTypeNameAlpha &
    VeryLongTypeNameBeta &
    VeryLongTypeNameGamma &
    VeryLongTypeNameDelta;
```

No leading `&`. A `flatten` of `intersection_type` with the operator in the
separator matches the 80-column shape (operator at end, one indent). The
union shape needs a leading `|` on the first member when the group breaks,
which is the `trail` policy inverted — add a token at the **front** when the
group opens. There is no such opcode. Gate 3 accepts the rewrite because of
the unary `union_type` wrapper; agreement at stage C will not, unless the
corpus writes unions already in the broken-with-leading-pipe form (which then
fails to probe the collapse at 80, where `FitsUnion` must stay unbeaten).
This is a classified design-limit candidate, not a corpus bug. The file stays
in the agreement denominator.

Conditional types already break at 80, with the nested `: T extends number`
branch indented one step further than the outer `?` — prettier's nested
ternary indent applied to types.

### Enums always expand; interfaces always expand; type literals honour `objectWrap`

`enum Singleton { Only }` becomes four lines at **both** widths. There is no
width at which an enum stays on one line. Interfaces with any member are the
same: `interface Named { name: string }` in the source is a one-liner and
prettier expands it at both 80 and 40. Type literals do **not** always
expand: `type T = { a: number }` stays inline, and a source-expanded type
literal that would fit stays expanded (`PreservedBySource`). Tuples follow
arrays, not objects: `CollapsedBySource` collapses at 80.

A package that models `object_type` and `interface_body` as the same
bracketed group will agree with prettier on one and diverge on the other. The
split is in the corpus so stage C can classify it.

### Angle-bracket assertions survive, and `as` binds looser than `+`

`<number>raw` is unchanged. prettier does not rewrite it to `as`. `a + b as
number` becomes `(a + b) as number` — prettier inserting the parens the
`paren` policy exists for. That addition is winnable. The deletion of
redundant parens in `normalisation.ts` is not (FINDINGS entry 13).

### Neither generator needed a change

`gen_trees.py` and `gen_reference.py` both worked from the manifest as
written, including installing `tree-sitter-typescript==0.23.2` and calling
`language_typescript`. No harness script was edited. The empty-container
probes passed gate 3; the round-2 `_tokens` fix is holding.

## Files touched outside `corpus/` and `harness/languages/`

```
git diff --stat main -- . ':(exclude)corpus' ':(exclude)harness/languages'
```

(empty)

No `rust/`, no `runtime-js/`, no shared harness script. The grammar pin lives
in the manifest; nothing was added to any script's inline `dependencies`.

## Template delta

- The brief's example fake filename `--stdin-filepath x.typescript` does not
  work for prettier. prettier infers from a real extension; `.typescript` is
  not one. The working filename is `x.ts`. The same trap is waiting for any
  language whose canonical name is not its file extension (`x.javascript` is
  actually in prettier's JS extension list; `x.typescript` is not). The
  instruction "use `x.<language>`" is the guess that has to be verified, not
  the command to copy.
- The grammar pin `==0.7.0` is still the orchestrator's guess and is still
  wrong; TypeScript's latest is `0.23.2`, not JavaScript's `0.25.0`.
- `union_type` as a transparent wrapper is a new shape for the brief's mental
  model of that field. It has so far been "the parenthesised-expression
  node". TypeScript's leading `|` is a unary node of the **same kind as the
  binary construct**, elided only because the gate already requires exactly
  one named child. Worth a sentence in the wrapper paragraph so the next
  language with a leading-operator-when-broken form (Kotlin's trailing
  commas are not this; a leading `|` in CRDT-style grammars would be) does
  not reach for an override.
