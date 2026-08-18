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
  comments; it probes Rust's attachment and comment-column behavior. Extended at
  stage B with the rest of Rust's comment lexicon: `/* */`, inline and trailing
  block comments, `///`, `//!`, and `/** */`.
- `enums.rs` — enum variants, destructuring match arms, guards, and block arms;
  exhaustive pattern matching is a defining Rust construct.
- `generics.rs` — generic parameters, bounds, `Result`, and a `where` clause;
  explicit bounds are characteristic Rust API syntax.
- `kitchen.rs` — async generic processing combining traits, closures, guards,
  matches, nested calls, and comments; the one intentionally interacting probe.
- `macros.rs` — `macro_rules!` definitions, invocations, and a vector macro;
  declarative macros and token-tree calls are Rust-specific.
- `modules.rs` — nested modules, visibility, paths, imports, and a `Display`
  impl; Rust's module/item organization is distinctive. Extended at stage B with
  the braced, aliased, `self`- and glob-`use` forms, whose layout rustfmt breaks
  on width like any other list.
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
  reference overflow   @100 0  @60 39
  NOTE 3 file(s) byte-identical input to output at every width
```

The overflow line read `@60 30` when this section was written. It is `39` after
the stage-B additions to `comments.rs` and `modules.rs`; every other number is
unmoved. See "Stage B review" at the end.

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

---

## Stage B review

Reviewer: Claude Opus 5. Verdict **pass with fixes applied**. Every number below
was re-run by the reviewer rather than read out of the sections above.

### Re-verified, and it held

- **The reference output is rustfmt's.** Six files regenerated by hand at both
  widths — `widths`, `structs`, `comments`, `normalize`, `nesting`, `kitchen` —
  byte-identical to what is committed, and `gen_reference.py --check` is silent
  across all 32.
- **The manifest is reproducible.** `rustfmt --version` prints `rustfmt 1.9.0`,
  which is what `reference_version` records. The command runs as written.
- **`widths = [100, 60]` is rustfmt's own default, bisected.** A `let a + b;`
  probe swept at every line length from 96 to 105 columns: unprompted rustfmt
  keeps 100 flat and breaks 101, matching `max_width=100` exactly and
  distinguishable from 99 and 101. Independently, the unprompted output of all
  16 corpus files is byte-identical to the committed `@100` reference. The
  round-1 defect — inheriting another language's width — did not recur here.
- **`reference_width = "flag"` is honest**; the two widths produce different
  output on 11 of 16 files.
- **No `ERROR` and no `MISSING` node** in any of the 16 trees, rechecked after
  the stage-B edits.
- **Nothing changed outside `corpus/` and `harness/languages/`.** The reviewer
  ran the same `git diff --stat` and it is empty, as claimed.
- **`gate3 = "default"` is right.** Rust has no data-model loader to be tempted
  by, so the trap the brief warns about does not arise. The one declared wrapper
  is real: at width 60 `closures.rs` line 8 shows rustfmt wrapping the closure
  body `format_record(index, payload)` in a `{ }` block that the source does not
  have. It is the minimum declaration that admits that output.
- **`widths.rs` does what it claims.** All four `sub_widths` constructs fit
  `max_width=100` flat and break anyway; all four `under_every_threshold`
  controls stay flat; `aligned_arms` splits rather than collapsing at 60. The
  reviewer also bisected `struct_lit_width` independently and got 18, measured
  on the body between the braces, and `fn_call_width` 60, measured on the
  argument span.

### Corrected in the worktree

1. **Two of the four arithmetic notes in `widths.rs` were wrong.** The struct
   literal's body is 36 columns and its line 65, written as 43 and 61; the chain
   is 61 columns and its line 79, written as 62 and 74. The call (64 of 91) and
   array (63 of 82) notes were right. Each note now also names the threshold it
   crosses. The constructs themselves were correct — only the commentary was.
2. **`comments.rs` probed one of Rust's five comment spellings.** There was no
   `/* */` and no doc comment anywhere in the corpus, so `block_comment`,
   `doc_comment`, `inner_doc_comment_marker` and `outer_doc_comment_marker`
   never appeared in a tree. Gate 3's universal extras layer takes comments as
   its only input, so those are precisely the kinds it was never asked about.
   Added.
3. **`modules.rs` had two single-path `use` statements**, so `use_list`,
   `scoped_use_list`, `use_as_clause` and `use_wildcard` were absent too.
   rustfmt breaks a braced use group on width like any other list — comparable
   layout, not the sorting linearity forbids — and nothing in the corpus asked
   it to. The new group is 85 columns: flat at 100, broken at 60. Written in
   rustfmt's own sibling order, as `imports.go` is.

Corpus node kinds went 144 → 156. `./test.sh`, `./harness/score.py .`,
`check_gate3.py --language rust` (456 useful adversarial mutations, 0
disagreements) and `check_width.py . 20 120` are all green with zero warnings
after the change.

### The reference's own overflow, attributed

All 39 counted overflow lines at width 60 are comment text:

- 37 are comment lines rustfmt declines to split;
- 2 are code lines whose own tokens fit and whose attached trailing comment
  pushes them over — `normalize.rs` line 2 at 74 columns and `structs.rs` line 4
  at 66. This is the same behaviour as the report's "a trailing comment does not
  count toward the decision to break", seen from the overflow side.

`strings.rs` has a third physically over-width line, the 122-character literal,
excluded by the harness because it is a single over-long leaf token. At width
100 that literal is the only over-width line and the count is 0.

The cause is two defaulted-off options, which is the useful part: the overflow
is not rustfmt failing to fit, it is rustfmt declining to try.

### Which of rustfmt's behaviours are off by default (brief check 9)

Every option below was set against the whole corpus at width 100 and diffed
against the default run. `--config` applies unstable options on stable rustfmt
1.9.0, so these are all observable, not merely documented.

| Option (default)                     | Turning it on changes | What the default suppresses                 |
| ------------------------------------ | --------------------- | ------------------------------------------- |
| `wrap_comments = false`              | 1/16                  | reflowing comment text — the overflow above |
| `format_strings = false`             | 1/16                  | splitting a long string literal             |
| `struct_field_align_threshold = 0`   | 4/16                  | column-aligning field types (FINDINGS 18)   |
| `enum_discrim_align_threshold = 0`   | 0/16                  | aligning `=` discriminants                  |
| `normalize_comments = false`         | 1/16                  | rewriting `/* */` to `//`                   |
| `imports_granularity = Preserve`     | 1/16                  | merging `use` paths into one group          |
| `group_imports = Preserve`           | 1/16                  | regrouping std / extern / crate             |
| `where_single_line = false`          | 1/16                  | collapsing a one-bound `where` clause       |
| `match_block_trailing_comma = false` | 3/16                  | a comma after a block match arm             |
| `struct_lit_single_line = true`      | 3/16                  | (on) keeping a small struct literal flat    |
| `use_small_heuristics = Default`     | Max 2/16, Off 4/16    | the master switch over the four sub-widths  |

Zero-effect on this corpus, so recorded as unobservable rather than absent:
`condense_wildcard_suffixes`, `format_macro_matchers`, `hex_literal_case`,
`overflow_delimited_expr`, `reorder_impl_items`, `normalize_doc_attributes`,
`format_code_in_doc_comments`, `use_try_shorthand`, `use_field_init_shorthand`,
`fn_single_line`, `force_multiline_blocks`, `inline_attribute_width`,
`empty_item_single_line`.

Three consequences worth carrying into stage C:

- `wrap_comments` and `format_strings` together are the entire overflow story. A
  stage-C agent that reads an over-width comment as a corpus bug is wrong twice
  over: rustfmt not only permits it, it has an option to stop and leaves it off.
- `enum_discrim_align_threshold` changes **nothing** on this corpus because no
  file has an enum discriminant at all. The negative half of FINDINGS 18 —
  rustfmt declining to align discriminants — is therefore recorded but not
  demonstrated here. Not worth a file on its own; worth knowing it is untested.
- `use_small_heuristics = Max` changes exactly `nesting.rs` and `widths.rs`.
  That is independent confirmation that `widths.rs` is diagnostic: it and one
  other file are the only places the sub-widths are observable.

### A second unmeasured exclusion, not previously recorded

The report records import sorting as reference behaviour that linearity forbids,
which matches the Go precedent and the standing decision in FINDINGS 4 that
token **reordering** stays permanently out of scope.

There is a second one and it is a **deletion**, not a reordering.
`match_arm_leading_pipes` defaults to `Never`, so rustfmt _removes_ a leading
`|` from a match arm:

```text
match x { | 1 => 1, | 2 | 3 => 2, _ => 0 }   ->   1 => 1,  2 | 3 => 2,
```

A package may not delete a source token, so this is excluded on the same footing
as import sorting. No corpus file has a leading-pipe arm, so it is silently
unmeasured. Recorded here rather than fixed: adding the construct would need a
dedicated `[incomparable]` file, and whether excluded constructs get probe files
or only a written record is the open half of FINDINGS 4 (options 1 and 2), which
is Dave's call and not a reviewer's.

Bounding the import exclusion, which the report leaves open-ended: with
`imports_granularity` and `group_imports` both `Preserve`, rustfmt sorts
siblings **within** a contiguous group and does not merge paths or regroup them.
That is the whole of it.

### Caution for stage C: `block` is transparent, but not unconditionally

`transparent_wrappers = ["block"]` is correct for the case that motivated it —
rustfmt adding `{ }` around a closure's expression body — and rustfmt only ever
_adds_ such a block, never removes one, so the gate is not currently exposed.
But a Rust `block` is not transparent in general: `{ x; }` evaluates to `()`
while `x` evaluates to `x`, and both are one-child blocks by the grammar. If a
future package ever removes a block rather than adding one, this declaration
would let it change a value into a unit and still pass gate 3. Same shape as the
`(*p).y` caution in `go.toml`: a stage-C caution, not a gate defect.

### Defect in the report itself

The brief requires the report to name **which agent built it**, in the first
section, next to the pins. This report does not, so the status board cannot
attribute it and the scorecard cannot credit it. The reviewer cannot supply the
name without inventing it. Round 3 lost this on all three reports; it is now
four.

Two smaller overstatements, corrected here rather than in the text above:
`macros.rs`'s macro _definition_ is unchanged at both widths — only the `vec!`
invocation is reformatted at 60, so the claim that "the macro definition and
macro invocation are formatted at the narrow width" is half right. And the
15-file overflow figure of 16 quoted in "Corpus counts" belongs to a corpus that
no longer exists; the live number is in the 16-file block above it.
