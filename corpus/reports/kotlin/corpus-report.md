# Kotlin corpus report (stage A)

## Manifest

`harness/languages/kotlin.toml`. Every field that could have been guessed was
observed, not copied.

| Field                  | Value                                           | How it was established                                                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grammar`              | `tree-sitter-kotlin==1.1.0`                     | Live PyPI (`https://pypi.org/pypi/tree-sitter-kotlin/json`, 2026-08-17). The distribution name matches the orchestrator's guess; the pin does not. The only releases are 1.0.0, 1.0.1 and 1.1.0; 0.7.0 does not exist.                                        |
| `grammar_module`       | `tree_sitter_kotlin`                            | `uv run --with tree-sitter-kotlin==1.1.0` then `import tree_sitter_kotlin`. The hyphen-to-underscore swap is correct.                                                                                                                                         |
| `grammar_symbol`       | `language`                                      | The module exports only `language()`. It returns a `tree_sitter.Language` capsule.                                                                                                                                                                            |
| `injection_aliases`    | `["kotlin", "kt"]`                              | `kotlin` is canonical. `kt` is the conventional short alias (highlight.js lists `kotlin`, `kt`, `kts`, `ktm`, `ktx`). `kts` is the script extension, not a fence tag I will vouch for; `ktm`/`ktx` are thinner still.                                         |
| `reference`            | `nix run nixpkgs#ktfmt -- --kotlinlang-style -` | See below.                                                                                                                                                                                                                                                    |
| `reference_version`    | `ktfmt version 0.63`                            | Printed by `nix run nixpkgs#ktfmt -- --version` (and `-v`). Observed, not assumed.                                                                                                                                                                            |
| `reference_width`      | `fixed`                                         | There is no CLI width flag. `--max-width`, `--print-width` and `--column-limit` are all rejected as `Unexpected option`. Ran the same file at two hoped-for widths: there is nothing to pass, and the output cannot differ. `{width}` is therefore forbidden. |
| `widths`               | `[100]`                                         | ktfmt's own default `maxWidth`, established by bisection (below). `"fixed"` requires exactly one entry.                                                                                                                                                       |
| `gate3`                | `default`                                       | See below.                                                                                                                                                                                                                                                    |
| `transparent_wrappers` | `[]`                                            | Gate 3 accepted ktfmt on 15/15 runs without naming a wrapper. ktfmt does not add or remove parentheses (`((1))` stays).                                                                                                                                       |
| `equivalent_kinds`     | `[]`                                            | Nothing was renamed. Trailing-lambda vs last-arg-lambda are different node kinds (`annotated_lambda` vs `lambda_literal`) and ktfmt preserves both, so they are not equivalents.                                                                              |

### Style: `--kotlinlang-style`, observed, not default

ktfmt 0.63 ships three styles. They are different formatters. Diffed on the same
input:

| Flag                    | Block indent | Continuation indent | Trailing commas | Notes                                                                                                    |
| ----------------------- | ------------ | ------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| (none) / `--meta-style` | 2            | 4                   | `ONLY_ADD`      | Default. A source trailing comma on a fitting `listOf(1, 2, 3,)` **forces a break** and keeps the comma. |
| `--google-style`        | 2            | 2                   | `COMPLETE`      | Same 2-space indent as meta; different continuation indent and comma policy.                             |
| `--kotlinlang-style`    | 4            | 4                   | `COMPLETE`      | Official Kotlin coding conventions.                                                                      |

`--kotlinlang-style` is the one named after the language, with the 4-space
indent Kotlin users write. It is not what `ktfmt` does if you pass no flag.
`--kotlinlang-style` is load-bearing: output without it is 2-space Meta style.

`-` is required for stdin. Without it ktfmt prints usage and writes nothing.
`--stdin-name=x.kt` (and `x.kotlin`) is a no-op on output — omitted.

`--do-not-remove-unused-imports` **does** change output (verified: an unused
`import kotlin.collections.List` is deleted without the flag and kept with it).
It is omitted because the corpus has no unused import, so the flag would be a
no-op on committed files. Unused-import deletion is therefore unmeasured, same
class as FINDINGS entry 4.

Import **sorting** has no disable flag at all (`sortedAndDistinctImports` always
runs). **Stage B added `imports.kt` for it and declared the file
`incomparable`.** Stage A identified the behaviour and then left it out of the
corpus, which is the omission the `incomparable` field exists to stop: ktfmt
reorders imports on every file it touches, so a package that never reorders
would have agreed with the reference on this corpus — the corpus had exactly one
import, already sorted — and diverged on essentially every real Kotlin file.
Verified: four used imports written out of order come back sorted, and gate 3
rejects the rewrite with `leaf text 'kotlin' became 'java'`. The declaration is
load-bearing, not decorative — `check_gate3.py --verbose` prints
`incomparable (reference rewrite skipped) kotlin__imports@100`, and without the
manifest entry that same case is a hard failure.

Two deletion constructs stay out, deliberately, because putting either in
`imports.kt` would make that file mixed. Unused-import removal (covered above)
has a disable flag. Import **de-duplication** — the `distinct` half of
`sortedAndDistinctImports` — has none, and fires only on a duplicate import
line, which no file here has. Both are deletions, not reordering — but not
FINDINGS 13's kind: entry 13 is about deletions gate 3 **permits** (anonymous
tokens, reparse unchanged), and dropping a duplicate import removes a *named*
node that gate 3 rejects. That is FINDINGS 4's territory,
so they are the wrong reason to mark `imports.kt` incomparable and are instead
left unmeasured.

### Width is 100, and there is no flag for it

ktfmt's internal `DEFAULT_MAX_WIDTH` is 100 for every style. Established by
bisection of unprompted `--kotlinlang-style` output, not from `--help` (there is
no width option) and not from reading the source first:

- A formatted assignment line of **exactly 100** characters stays flat
  (`val x = "A" * 86` under 4-space indent — stage A wrote 87, which is the
  first length that breaks; re-bisected at stage B, the threshold itself is
  unchanged).
- One more character breaks the assignment (`val x =\n        "A"…`).

A 14-argument `f(aaaa, …)` stays `val x = f(…)` at 97 characters; a 15th
argument breaks the assignment and leaves a 99-character `f(…)` line. Same
threshold.

So `widths = [100]` is ktfmt's own default, not an arbitrary measurement width
the way gofmt's 80 is. ktfmt really does target 100; it just will not take the
number on the command line. `--enable-editorconfig` plus a real file's
`max_line_length` can change it; that path is closed below.

### ktfmt does not read ambient config on this command

`--enable-editorconfig` is **opt-in**. Without it, a planted `.editorconfig`
with `max_line_length = 40` and `indent_size = 8` (options the command line does
**not** pass) is inert: in cwd, in an ancestor, on stdin, and on a real `.kt`
file. Output depends only on the source bytes and the style flag.

With the flag, editorconfig **overrides** `--kotlinlang-style` for indent and
width — but **only for a real file**. The same planted config is still inert on
stdin, with or without `--stdin-name=x.kt`. No `KTFMT_CONFIG` / `EDITORCONFIG`
environment variable applies a file.

The committed command reads stdin and does not pass `--enable-editorconfig`, so
no channel is open. Residual channel if someone added the flag: a real-file
invocation, not this command. What a discovered config can still supply (per the
README, confirmed on a real file): `max_line_length`, `indent_size` /
`tab_width`, `ij_continuation_indent_size`,
`ktfmt_trailing_comma_management_strategy`. CLI style does not win those keys;
the file does.

`gen_reference.py --language kotlin --check` is silent (exit 0).

### Why `gate3 = "default"`

The generic named-node comparison is the right oracle. A data-model loader (PSI
dump, kotlinc, kotlinx serialization) would collapse the spellings ktfmt itself
preserves (`1_000`, `0xdead`, both trailing-lambda shapes) and would be weaker
than the tree comparison.

Empty containers written with a space — `fun empty( )`, `listOf( )`, `mapOf( )`,
`setOf(  )` — are in `normalisation.kt`. ktfmt rewrites them to `()`; gate 3
accepts the rewrite. That is the no-named-child path. It did not fail.

`check_gate3.py --language kotlin` at stage A: 15 reference outputs accepted, 30
destructive mutations rejected, 273 useful adversarial mutations checked
(leaf-rewrite 60, number-respell 54, sibling-swap 58, string-respell 43,
subtree-duplicate 58), 0 wrapper kinds named, 0 generic/override disagreements.

Re-run at stage B with `imports.kt` and the widened `comments.kt`: 16 reference
outputs checked, 32 destructive mutations rejected, 291 useful adversarial
mutations checked (leaf-rewrite 64, number-respell 56, sibling-swap 64,
string-respell 43, subtree-duplicate 64), 0 generic/override disagreements, and
one `incomparable (reference rewrite skipped)`.

## Corpus

Sixteen files in `corpus/src/kotlin/` (fifteen at stage A, plus `imports.kt`).
Each is valid Kotlin: clean under tree-sitter-kotlin 1.1.0 (no `ERROR` /
`MISSING`, re-verified at stage B by live parse, not by reading the committed
trees) and accepted by ktfmt 0.63.

Required probes:

- `normalisation.kt` — input written the way a person writes it and ktfmt does
  not: spaces around `:`, `=`, operators and commas; padding inside
  `listOf( 1,2,3 )`; missing indent; a run of spaces before a trailing comment;
  explicit semicolons. `fun empty( )`, `listOf( )`, `mapOf( )` and `setOf(  )`
  are the empty-container probes.
- `nesting.kt` — `listOf` of `listOf`, `mapOf` of `mapOf`, a `Node` tree
  literal. Outer calls break; inners that fit stay flat (see surprises).
- `long_sequences.kt` — long parameter list, long argument list, long `listOf`,
  long named-argument call. The construct that overflows a line.
- `comments.kt` — file-level, KDoc (`/** … */`, already one line so ktfmt cannot
  reflow it), block, own-line, trailing on a signature and a statement, inside a
  list, before a closing brace, at end of file. **Stage B added
  `widthOfATrailingComment()`**: a pair of `listOf` assignments at exactly 100
  and exactly 101 columns _including_ the trailing comment. The first stays
  flat, the second breaks the assignment. That is the "a trailing comment counts
  toward its line's width" behaviour below, which stage A discovered on a
  scratch file and did not commit — the corpus asserted the width rule nowhere,
  and nothing would have caught a package that ignored comment width.
- `strings.kt` — double-quoted, escapes, `$name` / `${…}` templates, `${'$'}`,
  raw `"""…"""`, chars, unicode, astral, `1_000`, `0xdead`, `1L`, and one
  126-character unbreakable string.
- `kitchen.kt` — data class, `when`, trailing lambda, `buildList`,
  `filter`/`sortedBy` chain, a used import. The one file allowed to be messy,
  and never `incomparable`.
- `imports.kt` — four used imports written out of order. The one `incomparable`
  file: ktfmt sorts imports unconditionally and a linear formatter cannot
  reorder statements. Dedicated to sorting alone; the body is the two lines
  needed to keep every import used, so nothing comparable is hidden behind the
  exclusion.

Characteristic of Kotlin (one line each):

- `trailing_lambdas.kt` — `foo(x) { }` vs `foo(x, { })` is a layout decision
  driven by argument position (FINDINGS 10); ktfmt preserves both, and also
  preserves source-broken vs source-flat lambda bodies (FINDINGS 11).
- `when.kt` — subject and no-subject `when`, `is` / `in` / `!in`,
  comma-separated conditions. Kotlin's exhaustiveness-shaped dispatch.
- `classes.kt` — data class with a primary constructor, sealed hierarchy, enum,
  object, companion. The type-declaration surface.
- `generics.kt` — `out` / `in`, `reified`, `where`, star projection. More than
  Java-style type parameters.
- `functions.kt` — defaults, named (reordered) arguments, extension, infix,
  operator, vararg.
- `control_flow.kt` — `if` as an expression, labeled `for`/`continue`/`break`,
  `while`, `try`/`catch`/`finally` as an expression.
- `chains.kt` — safe-call / Elvis spine, and a method chain that ktfmt breaks at
  the dots (which this IR cannot do).
- `collections.kt` — `listOf` / `mapOf` / `buildList`, destructuring, COMPLETE
  trailing-comma add-and-remove.
- `annotations.kt` — stacked annotations and use-site targets (`@param:`,
  `@get:`). Written already attached; see surprises.

## Counts

From two `cmp` loops against `corpus/reference/kotlin__<stem>@100.txt`:

```sh
changed=0; total=0
for f in corpus/src/kotlin/*.kt; do
  stem=$(basename "$f" .kt)
  total=$((total + 1))
  if cmp -s "$f" "corpus/reference/kotlin__${stem}@100.txt"; then
    echo "identical $stem"
  else
    echo "changed   $stem"
    changed=$((changed + 1))
  fi
done
echo "changed $changed / $total"
```

**15 of 15 changed** (16 of 16 after stage B added `imports.kt`). No file is
byte-identical input to output.

**Differs between two widths: n/a.** `reference_width = "fixed"` and
`widths = [100]`. There is one output. A comparison over two independent
reference invocations is a determinism run, not two width settings.
`gen_reference.py --check` is that run; it is silent.

From `./harness/corpus_stats.py --language kotlin` (stage B, after the
`imports.kt` probe was added):

```
kotlin  --  16 files, vs ktfmt version 0.63
  incomparable         1  (gated; out of the agreement denominator)
  reference changes    16/16 at some width   (@100 16/16)
  differs by width     n/a -- fixed-width reference, one width
  carries a comment    16/16
  reference overflow   @100 0
```

**16 of 16 files carry a comment.** The extras layer is not inert.

### Reference overflow is 0

`corpus_stats.py` reports `reference overflow @100 0`. That is not a missing
count. ktfmt breaks every construct in this corpus that it can break, and
`overflow_lines` exempts lines that contain an over-long token. The one
deliberately over-long line is the 126-character string in `strings.kt`; it is
an unbreakable token, so it does not count. ktfmt does not manufacture overflow
the way taplo pads a comment out to 107. A stage-C agent that sees that
126-character line should treat it as an unbreakable string, not as a corpus bug
and not as a package failure.

## What ktfmt does that surprised me

### It has a width, and no flag for it

This is the first language on the roster whose reference **targets a width it
will not accept on the command line**. gofmt has no width at all. ktfmt has
`maxWidth = 100` and honours it (bisected), but the only way to change it is
`--enable-editorconfig` plus a real file. The honest manifest is
`reference_width = "fixed"` with `widths = [100]`. Agreement-at-two-widths is
structurally inapplicable.

### When a container breaks, the containers inside it do **not**

Constructed: a
`processRecords(listOf(1, 2, 3), options = mapOf(…), extra = listOf(eight names))`
whose outer call must break and whose inner `listOf(1, 2, 3)` and
`mapOf("timeout" to 30)` fit with room to spare. ktfmt keeps those inners flat.
Same for `listOf(listOf(1, 2, 3), …)` and `mapOf("primary" to mapOf(…), …)` in
`nesting.kt`. This is the opposite of taplo's cascade, and the same as gofmt. A
package that models each container as an independent group that inherits an
ancestor break (FINDINGS entry 2) would diverge on every nested call in
`nesting.kt`.

Broken lists and argument lists go **one element per line** with a trailing
comma (COMPLETE). Not fill (FINDINGS 8).

### A trailing comment **does** count toward its line's width

A 94-character `val xs = listOf(a00, …, a14)` stays flat. Adding `// xy` makes a
100-character line and still stays flat. Adding `// xyz` makes 101 and **breaks
the assignment**, leaving the comment on the `listOf(…)` line. A still-longer
`// trailing` explodes the list to one element per line, with the comment on the
closing `)`. Same direction as taplo, opposite prettier-on-YAML (FINDINGS 6).
ktfmt will destroy a perfectly good flat `listOf` to make room for a comment it
cannot move.

It does **not** align trailing comments into a column (FINDINGS 1: no).

### Token-level normalisation

At token level ktfmt rewrites aggressively, and that is the real job of
`normalisation.kt`:

- type-colon spacing (`a : Int` → `a: Int`) and comma spacing
- binary-operator spacing, uniformly (`a + b * 2`, not gofmt's precedence-tight
  `*`)
- `return(result)` → `return (result)` (space after `return`; the parens stay)
- padding inside calls and lists is removed (`listOf( 1,2,3 )` →
  `listOf(1, 2, 3)`; `fun empty( )` → `fun empty()`)
- a run of spaces before a trailing comment collapses to one space
- indentation is 4 spaces (`--kotlinlang-style`); tabs and extra spaces go
- explicit semicolons become newlines (`val semis = 1; val two = 2` → two
  statements)
- a single-line `if { } else { }` is expanded to a block per branch
- COMPLETE trailing commas: a fitting `listOf(1, 2, 3,)` **loses** the comma; a
  broken list **gains** one. The package cannot delete a comma (FINDINGS 13);
  `collections.kt` records the case

It does **not** respell `1_000`, `0xdead`, `1L`, quote style (Kotlin has no
single-quoted strings), or char vs string. It does **not** convert `foo(x, { })`
to `foo(x) { }`.

### Trailing lambdas are preserved, not chosen

`foo(x) { println(it) }` and `foo(x, { println(it) })` are different CST shapes
(`call_expression` + `annotated_lambda` vs a `lambda_literal` inside
`value_arguments`). ktfmt leaves both alone. A rule that dispatched only on
`lambda_literal` would miss the trailing form, and a rule that tried to pick one
based on argument position is FINDINGS 10. The corpus contains both so stage C
can see it.

Lambda **bodies** are source-break-sensitive (`preserveLambdaBreaks`): a DSL
written multi-line stays multi-line even when it would fit; a DSL written flat
stays flat. That is FINDINGS 11, and it is in `trailing_lambdas.kt` as
`App { SelectableCard { … } }` both ways.

### Method chains break at the dots

`items.filter { }.map { }.sortedBy { }.take(10).joinToString()` becomes one call
per line, broken before each `.`. DESIGN.md already says this IR cannot do that
(black's method-chain rule). `chains.kt` is the probe. Safe-call / Elvis spines
(`user?.profile?.address?.city ?: "unknown"`) stay flat when they fit and break
at `?.` when they do not.

### Own-line annotations attach — or do not — depending on context

**Corrected at stage B. The stage-A text here was wrong in both halves, and the
conclusion it reached was right for the wrong reason.**

```
@JvmStatic
@Throws(IOException::class)
fun demo(...)
```

The stage-A claim was that tree-sitter-kotlin 1.1.0 parses this as sibling
`annotated_expression` nodes **never** as modifiers, and that a _single_
own-line annotation _does_ attach. Neither is true. Measured on 1.1.0, dumping
`source_file`'s named children:

| Input                                                  | Parse                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| stack alone in the file                                | `function_declaration` (attached)                           |
| stack preceded by a line comment                       | `function_declaration` (attached)                           |
| stack, then any later declaration                      | `annotated_expression` + `function_declaration` (**split**) |
| stack, then only a trailing comment at EOF             | **split**                                                   |
| _single_ own-line annotation, then a later declaration | **split**                                                   |
| stack in last-declaration position, decl before it     | attached                                                    |

So the axis is not stacked-versus-single — a single own-line annotation splits
just as readily. It is context: the same three lines attach or split depending
on what surrounds them, which is a GLR ambiguity in the grammar rather than a
rule anyone can state cleanly. When it splits, the whole run of annotations is
swallowed into one `annotated_expression` and the declaration is left bare.

The consequence is unchanged: ktfmt joins an own-line run onto the declaration
line, so wherever the grammar splits, the join changes the named tree and gate 3
rejects the reference output. `annotations.kt` therefore stays written already
attached, and own-line annotations are unmeasured (FINDINGS 4). Stage B tried
the own-line form and reverted it — `check_gate3.py` failed with
`root/source_file: 6 named children became 5`, which is the same message shape
stage A reported, on an input stage A appears not to have varied.

Do not carry "stacked annotations parse as siblings" into a later JVM-language
brief; it would send the next builder after a `transparent_wrappers` fix for a
problem that is neither about stacking nor about wrappers.

### KDoc interiors are rewritten

ktfmt reflows `/** … */` bodies (joins wrapped description lines, inserts a
blank line before `@param`). Extras compare stripped comment text, so a dirty
KDoc fails gate 3. `comments.kt` uses a one-line
`/** Greet the caller by name. */` that cannot reflow. KDoc wrapping is
unmeasured (FINDINGS 4).

### Semantic whitespace between nodes: no

Asked because of FINDINGS 12. Multiline / raw string interiors sit inside
`multiline_string_literal`. There is no keep-chomping construct, and
identifier/string meaning does not live in a gap between siblings. Gate 3
default is sufficient; no override.

### Neither generator needed a change

`gen_trees.py` and `gen_reference.py` both worked from the manifest as written,
including installing the pinned grammar. No harness script was edited.
`gen_reference.py --language kotlin --check` is silent (exit 0).

## Files touched outside `corpus/` and `harness/languages/`

```
git diff --stat main -- . ':(exclude)corpus' ':(exclude)harness/languages'
```

(empty) at stage A. No `rust/`, no `runtime-js/`, no `packages/`, no shared
harness script. The grammar pin is in the manifest; it is not in anyone's inline
`dependencies` block. Verified independently at stage B.

Stage B added one shared-harness edit, `harness/test_manifest.py`:
`test_merged_languages_declare_none` asserted that **every** loaded manifest has
an empty `incomparable` table — a snapshot taken in the slice that introduced
the field ("This slice adds the field, not the files"). As written it makes the
first legitimate use of the field a test failure, for kotlin and for every
language after it. Narrowed to the six languages that predate the field (`css`,
`go`, `json`, `python`, `toml`, `yaml`), which keeps the original guarantee for
them and stops the assertion from forbidding the field outright. Renamed to
`test_the_six_languages_that_predate_the_field_declare_none`.

## Template delta

- **ktfmt has no width flag**, which the brief already asked as a round-3 note.
  The gotcha that is _not_ in the brief: it still _has_ a width (100). `"fixed"`
  plus `widths = [100]` is the honest pair, not `"fixed"` plus an arbitrary 80.
  The overflow count is then against the width the tool actually targets.
- **`--stdin-filepath x.kotlin` is the wrong shape.** ktfmt wants `-` for stdin;
  `--stdin-name` exists and does nothing to the output; the file extension is
  `.kt`, not `.kotlin`.
- **Own-line annotations** are a grammar attachment hole that gate 3 will reject
  after ktfmt joins them. Worth a sentence in the next JVM-language brief (Java,
  if it arrives) so the next builder does not spend a cycle on
  `transparent_wrappers`. Say it as _context-dependent_, not as "stacks split
  and singles attach" — that framing is wrong and is corrected above.
- **`nix run nixpkgs#ktfmt` works** (it runs ktfmt, unlike `nix run nixpkgs#go`
  which runs `go`). Same unpinned-nixpkgs caveat as Go: a channel bump changes
  the binary; `--check` is what would show it.

### Added at stage B

- **"Unmeasured, FINDINGS 4" is being used where `incomparable` is the answer.**
  Stage A named three constructs it left out — import sorting, unused imports,
  KDoc reflow — and filed all three under the same "unmeasured" label. Only two
  of them belong there. Import sorting is unconditional and has no flag, which
  is the template's own worked example of what `incomparable` is for, and the
  brief already forbids omitting such a construct. The report reads as diligent
  precisely because it lists the omission, so the label is doing the opposite of
  its job: it converts a corpus gap into a credit. The brief should say that
  naming an omitted construct is not a substitute for dedicating a file to it,
  and that a construct the reference performs **unconditionally** is never a
  candidate for "unmeasured".
- **A behaviour discovered on a scratch file is not in the corpus.** The
  trailing-comment width rule was found, measured to the column, and written up
  in prose — and no committed file exercised it. Worth one line in the brief: if
  a probe was constructed to establish a surprise, commit the probe.
- **Grammar-attachment claims need more than one input.** The stage-A annotation
  finding was reached from a single arrangement and stated as a general rule
  about stacking; it is context-dependent and the single/stacked axis is not the
  one that matters. Where a builder reports "the grammar does X", the brief
  should ask for the two or three inputs that were varied.
