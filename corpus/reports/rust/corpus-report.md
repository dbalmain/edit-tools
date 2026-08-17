# Rust corpus report

## Manifest and reference

`harness/languages/rust.toml` uses the pinned distribution
`tree-sitter-rust==0.24.0`. I verified the distribution, import, and accessor
with:

```text
uv run --with tree-sitter-rust==0.24.0 python -c 'import tree_sitter_rust as m; print(m.__name__); print([n for n in dir(m) if n.startswith("language")])'
tree_sitter_rust
['language']
```

Thus `grammar_module = "tree_sitter_rust"` and `grammar_symbol = "language"`.
The injection aliases are the canonical `rust` and conventional `rs`; the
manifest loader accepted them as unique.

The reference is:

```text
rustfmt --emit stdout --edition 2021 --config-path /dev/null --config max_width={width}
```

`rustfmt --version` printed `rustfmt 1.9.0`, which is the recorded
`reference_version`. `--emit stdout` is required to make stdin produce stdout;
`--edition 2021` is required for the corpus's async syntax (without it, rustfmt
reports that `async fn` is not permitted in Rust 2015). A width probe at 60 and
100 produced different layouts, establishing `reference_width = "flag"`.

I established the default width experimentally rather than relying only on help
text: a boundary `if` probe's unprompted output matched
`--config max_width=100`; `99` broke its condition earlier and `102` kept its
opening brace on the same line. The manifest therefore uses
`widths = [100, 60]`, with 60 as the narrow probe and 100 as rustfmt's own
default.

Rustfmt searches for `rustfmt.toml`/`.rustfmt.toml` ambient configuration. I
planted a `rustfmt.toml` with `max_width = 120` and `hard_tabs = true`, then ran
the command with `max_width=60`: the width command-line setting won, but the
unpassed `hard_tabs` setting still leaked into the output. Adding
`--config-path /dev/null` suppressed both the discovered config and its ancestor
search; the output then used spaces and the requested narrow layout. No
additional configuration channel was used by this invocation. The command line
therefore supplies the only formatting option and the explicit config path
closes the ambient-config channel.

Gate 3 starts at the generic default. The first run identified one legitimate
rustfmt-added wrapper: at width 60 an expression-bodied closure became a
one-child `block`. `transparent_wrappers = ["block"]` records exactly that
observed case. No equivalent-kind exception or override is needed. The
normalisation probe contains `[ ]`, `( )`, `{ }`, and `collect( )`; the
generated reference passed gate 3 on all of them, so there is no empty-container
finding.

## Corpus files

There are 16 valid Rust source files. `gen_trees.py` reported no `ERROR` or
`MISSING` nodes.

- `async.rs` — async functions, await points, loops, and `Result` layout;
  async/await is characteristic Rust control flow.
- `closures.rs` — iterator chains and closure bodies; Rust's closure syntax and
  method chains are common layout pressure points.
- `comments.rs` — own-line, trailing, inside-delimiter, before-closing, and EOF
  comments; it probes Rust's attachment and comment-column behavior.
- `enums.rs` — enum variants, destructuring match arms, guards, and block arms;
  exhaustive pattern matching is a defining Rust construct.
- `generics.rs` — generic parameters, bounds, `Result`, and a `where` clause;
  explicit bounds are characteristic Rust API syntax.
- `kitchen.rs` — async generic processing combining traits, closures, guards,
  matches, nested calls, and comments; the one intentionally interacting probe.
- `macros.rs` — `macro_rules!` definitions, invocations, and a vector macro;
  declarative macros and token-tree calls are Rust-specific.
- `modules.rs` — nested modules, visibility, paths, imports, and a `Display`
  impl; Rust's module/item organization is distinctive.
- `nesting.rs` — an outer array containing small flat arrays plus nested struct
  literals; it tests independent nested-container decisions.
- `normalize.rs` — deliberately wrong spacing, indentation, delimiter padding,
  trailing-comment spacing, and spaced empty containers; it tests token-level
  rewriting.
- `patterns.rs` — nested `Option`/`Result` patterns, guards, destructuring, and
  `if let`; Rust's pattern language is unusually rich.
- `sequences.rs` — a long operator chain, call argument sequence, and tuple;
  these are the constructs most likely to force vertical layout.
- `strings.rs` — escaped, raw, multiline, byte, character, and long literals;
  Rust's literal forms must remain token-opaque.
- `structs.rs` — derives, struct literals, impl methods, and aligned field
  comments; structs and field documentation are idiomatic Rust.
- `traits.rs` — associated types, supertraits, default methods, and a blanket
  impl; traits and bounds are central Rust abstraction mechanisms.
- `widths.rs` — four constructs that fit `max_width` and are broken anyway, one
  per sub-width, plus a control where all four stay flat, plus a width-dependent
  comment-alignment run. **Added by the orchestrator after stage A**, not by the
  corpus builder — see below.

### `widths.rs` was added after stage A, and why

The corpus as built probed rustfmt's sub-widths (FINDINGS 17) in **one file of
fifteen**, `nesting.rs`, and only for `struct_lit_width`. It did not exercise
`chain_width` or `fn_call_width` at all — which, with `struct_lit_width`, decide
**44.8% of real rustfmt-clean files**. A package built and scored against the
corpus as it stood would have looked healthy and been wrong about the single
largest source of Rust divergence.

That is FINDINGS 16's failure mode, caught one stage earlier than it has ever
been caught before, and only because the probe that measured 44.8% was run
before stage B rather than after stage C.

Each construct in `sub_widths` is inside `max_width=100` flat and broken by
rustfmt anyway; each construct in `under_every_threshold` is the same shape
inside its own threshold and stays flat. The pair is what makes the file
diagnostic rather than merely hard: a package that simply breaks more would fail
the second function.

`aligned_arms` carries the other half. At width 100 all three arms align; at
width 60 the third drops out and the first two align without it. That the run
_splits_ rather than collapsing is the width-dependence recorded in FINDINGS 18,
and it is now visible at both scored widths in the corpus rather than only in a
crates.io sample.

## Corpus counts

The first count came from this `cmp` loop, comparing each source with both
committed widths:

```text
cmp loop 1: reference changes at some width = 12/15
```

The second independently compared the two committed reference outputs:

```text
cmp loop 2: differs between widths = 10/15
```

`corpus_stats.py --language rust` gives the per-width detail: 5/15 files change
at width 100 and 11/15 at width 60. All 15/15 files carry comments. The three
files unchanged at both widths are `enums.rs`, `sequences.rs`, and `traits.rs`;
they are already in rustfmt's stable form rather than being comment-free probes.

**Restated for 16 files after `widths.rs` was added**, from
`./harness/corpus_stats.py --language rust`:

```text
rust  --  16 files, vs rustfmt 1.9.0
  reference changes    13/16 at some width   (@100 6/16  @60 12/16)
  differs by width     11/16
  carries a comment    16/16
  reference overflow   @100 0  @60 30
  NOTE 3 file(s) byte-identical input to output at every width
```

`widths.rs` is written in un-rustfmt'd form on purpose, so it moves the
"reference changes" count rather than padding the denominator. The three
byte-identical files are the same three named above.

The reference's own overflow count, from
`./harness/corpus_stats.py --language rust`, was, at 15 files:

```text
reference overflow   @100 0  @60 16
```

At width 60, the 16 counted overflows are comment lines: rustfmt keeps each
comment attached and does not split comment text. There is one additional
physical over-width line, the 122-character string literal in `strings.rs`, but
the harness deliberately excludes lines containing an over-long leaf token. At
width 100 that same literal is the only physical over-width line and is
excluded, producing the reported count of zero.

## Reference behavior and surprises

Nested containers do not inherit a parent's break unconditionally. In
`nesting.rs`, rustfmt breaks the outer `matrix` array while its ten two-element
child arrays remain flat (`[1, 2]`, `[3, 4]`, and so on). The nested `Branch`
struct literals break for their own struct-literal policy, while their small
leaf arrays remain flat. A package that assumes an expanded parent forces every
descendant open would diverge from rustfmt here.

A trailing comment does not count toward the decision to break the preceding
container. A direct probe with a flat `[one, two, three, four]` followed by a
long trailing comment stayed flat at widths 60, 80, and 100, even though the
complete physical line exceeded every target. Rustfmt preserves the attached
comment and permits the overrun; it does not destroy the flat array in an
attempt to fit the comment.

At token level, rustfmt rewrites spaces around operators and delimiters, removes
padding inside `[]`, `()`, and `{}`, normalises indentation, and aligns trailing
comments. `normalize.rs` demonstrates all of these, including `[ ]` → `[]`,
`( )` → `()`, `{ }` → `{}`, `len( )>0` → `len() > 0`, and the indentation of the
`if` body. It does not respell numbers or change string delimiters/escapes. The
long string, raw string, multiline string, byte string, and character literal
interiors remain opaque.

Rustfmt reorders imports. An adversarial stdin probe containing unsorted
`use std::...` and `use crate::...` entries was emitted in sorted crate-then-std
order. This is token reordering, which the linearity invariant forbids a package
from reproducing, so `modules.rs` is intentionally written in the reference's
order and the behavior is recorded as excluded reference behavior.

Rustfmt also aligns sibling-width trailing comments. The observable alignment
touches 2/15 files: `structs.rs` aligns field comments, and `comments.rs` aligns
an own-line comment before a closing delimiter with the preceding trailing
comment column. The specifically sibling-width field alignment is present in
1/15 files. This is an independent Rust price for FINDINGS entry 1, not a claim
that the Doc IR can reproduce it.

**Corrected after stage A, and the correction matters.** "Sibling-width" reads
as gofmt's alignment, and it is not the same thing. rustfmt aligns trailing
comments on **list items** only. It does not align struct field _types_, enum
discriminants, `const` values, or statement comments — and the two options that
would turn the first two on, `struct_field_align_threshold` and
`enum_discrim_align_threshold`, **both default to 0**, so their absence is a
deliberate choice by the reference rather than an omission. Measured directly
against rustfmt 1.9.0; see FINDINGS 18 for the consequence, which is that
`alignment: "go"` aligns precisely the lines rustfmt leaves alone.

The corpus did not expose a silent rustfmt fallback. The macro definition and
macro invocation in `macros.rs` are formatted at the narrow width, and the
generic/where-clause probe in `generics.rs` changes its signature layout. No
file is being presented as a layout probe that rustfmt declined to format.

The reference also makes choices that are not purely line breaking: closure
bodies gain a `block` wrapper when they break, trailing comments can trigger
alignment padding, and several local policies (`array_width`, function-call
layout, and struct-literal layout) cause nested constructs to break at both
widths. Comments and string interiors are not reflowed.

## Changes outside corpus and harness/languages

The required command was:

```sh
git diff --stat main -- . ':(exclude)corpus' ':(exclude)harness/languages'
```

Its output was empty.

## Template delta

None. The manifest schema and generic harness expressed this slice without a
shared-file edit or a language branch. No runtime, `rust/`, or `runtime-js/`
changes were needed.
