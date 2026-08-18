# Kotlin package report (stage C)

```
gate 1 idempotence      pass   (16/16)
gate 2 width            waived (reference_width = "fixed"; overflow 0 at measurement width 100)
gate 3 non-destruction  pass   (16/16, method default)
gate 4 agreement        14/15 @100
rust/js parity          identical (16/16 at 100; also 1 and 40, measured)
refusals                none
review                  0 accepted, 0 stale, 1 unreviewed
size                    package 2354 B gzip; runtime 13695 B gzip; delta vs main 0
```

Measured with `./test.sh` (exit 0) and `./harness/score.py . --language kotlin`.

## Agreement

14/15 comparable files at the single measurement width. Matching:

`annotations.kt`, `chains.kt`, `classes.kt`, `comments.kt`, `control_flow.kt`,
`functions.kt`, `generics.kt`, `kitchen.kt`, `long_sequences.kt`, `nesting.kt`,
`normalisation.kt`, `strings.kt`, `trailing_lambdas.kt`, `when.kt`.

`imports.kt` is excluded (manifest `[incomparable]`); ktfmt sorts and a linear
walk cannot. It is not a package bug.

## Divergences

| case | hash | classification | why |
| --- | --- | --- | --- |
| `kotlin/collections.kt@100` | `bb803fd4975528eefb2543395f360b37528a7ecaa9d45a9c481389a702227254` | design limit | `trail` is black's magic comma: a source trailing comma pins the group open. ktfmt COMPLETE *removes* the comma on a fitting `listOf(1, 2, 3,)`. `srctrail` would strip it (closer on the same source line) but then would not *add* a comma when a long source-flat list width-breaks, which is how `long_sequences.kt` / `nesting.kt` match. The IR has no "add when the layout breaks, drop when it stays flat" policy independent of the source comma. Same limit TOML already accepted on `arrays.toml`. Chose `trail`. |

That is a divergence I chose. One construct in one file; closing it with `srctrail`
would trade three overflow files for this one.

## Runtime edits

None. The comment-span recovery from `0fd9f1d` is already on the branch; Kotlin
`line_comment` / `block_comment` are leaves with `text`, so it was not needed
here. `character_literal` (`'x'`) has only the quote tokens as children and
the body in the span — `verbatim` covers it, no runtime change.

No second house-style constant. ktfmt's comment gap is 1 and its blank cap next
to a comment is 1 (observed: every reference trailing comment is one space;
no file has a 2-blank run). Both match the runtime default; the package sets
them explicitly. Indent 4 is `--kotlinlang-style` and is the package `indent`.

## Harness edits

None. Nothing under `harness/` was touched.

## What was hardest

tree-sitter-kotlin 1.1.0 exposes **no field names** and marks **every** node
named, including punctuation. `named` is defined only by the package `tokens`
list. Dispatch cannot say `f:body`; every optional piece is an `opt` on the
cursor type.

The worst shape is `function_value_parameters`: a default value is a *sibling*
of the `parameter` (`param, param, =, call`), and `vararg` / use-site
annotations sit in `parameter_modifiers` between the comma and the next
parameter. `each t:parameter` with an `opt t:=` in the separator is the whole
rule. Fields would have made this a normal list.

`flatten` cannot run: it walks `left` / `operator` / `right` and this grammar
has none. Binary expressions in this corpus are short three-child nodes, so
the loss is unmeasured.

## What I would want from the design

A trailing-separator policy that keys off the *printed* break, not the source
comma or the source line of the closer. `trail` pins when the source has a
comma; `srctrail` adds only when the closer is already on a new source line.
ktfmt COMPLETE is "comma iff the layout is broken". TOML paid for the same
gap; Kotlin is the second language.

Fields on this grammar would have been the bigger win for the package, but
that is a parser fact, not an IR fact.

## Template delta

- "Apply these first, commit" referred to stage-B fixes already on `main`.
  Doing them again would have been a shared-file collision.
- The corpus report's "the package cannot delete a comma (FINDINGS 13)" is
  slightly stale: `srctrail` *can* strip a same-line trailing comma. The real
  hole is the layout-driven COMPLETE described above, which is FINDINGS 3 /
  the TOML `arrays.toml` case, not 13.
- tree-sitter-kotlin's no-fields / all-named shape was not in the brief. Query
  the trees; do not print them.
- No second house-style constant turned up.

## Width 1

The trailing-lambda assignment rule (`val built = buildList {` stays together)
was checked at width 1. It overflows that line rather than rewriting spacing.
That is not the Go `struct{` / `struct {` trap: no token text changes with
width. Rust and JS were byte-identical at widths 1, 40, and 100 on every
corpus file.
