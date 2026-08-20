# Rust package report (stages C and D)

```
gate 0 coverage         pass   (34/34)
gate 1 rust/js parity   pass   (34/34 byte-identical)
gate 2 idempotence      pass   (34/34)
gate 3 non-destruction  pass   (34/34, method default)
measure 4 overflow      38 lines (rustfmt 39)
measure 5 size          package 2589 B gzip; runtime 13293 B gzip
measure 6 agreement     14/18 @ width 100,  8/18 @ width 60  =  22/36 (61.1%)
                        + 14 accepted = 100% review coverage, 0 stale,
                          0 unreviewed, 0 package-bug
refusals                none
```

`leading_pipes.rs` is excluded from the agreement denominator (token deletion —
FINDINGS 13); it still formats, is idempotent, and passes gate 3.

Two commits moved the headline number after stage C wrote it. The sub-width cap
on `group` (FINDINGS 17) took agreement from 17/32 to **19/32** by closing both
`nesting.rs` pairs. The cell node (FINDINGS 18) took the runtime from 13,695 B
to **12,322 B** and closed nothing here — see the stage-D section.

`STAGE_B_VERDICT` in the brief was an empty placeholder. Stage B's fixes were
already on the branch; nothing further to apply.

`comment_gap = 1` and `blank_cap = 1` are rustfmt's observed values (one space
before a trailing comment; at most one blank next to a comment).

## Entry 17: how much of the divergence is sub-widths

**7 of 15 scored divergences (46.7%) have a rustfmt sub-width as a necessary
cause.** Measured on this package, not inferred.

| pair | knob | only sub-width? |
| --- | --- | --- |
| `nesting.rs` @100 and @60 | `struct_lit_width` 18 | yes |
| `widths.rs` @100 and @60 | all four knobs | yes (plus alignment on the comment run) |
| `closures.rs` @100 and @60 | `chain_width` 60 | no — also FINDINGS 11 |
| `kitchen.rs` @60 | `chain_width` 60 | no — also FINDINGS 11 |

4 of 15 (26.7%) are *only* sub-widths: `nesting` at both widths, and the four
constructs in `widths.rs` (alignment on that file is a second, smaller hunk).
The other 3 need a second capability even if sub-widths landed.

`macros.rs@60` was on an earlier cut of this table (`array_width` on a
verbatim `vec!`). A comma-only `token_tree` walk now matches rustfmt there,
so it is no longer a divergence and is not in the 7.

That is the corpus number for entry 17. It is smaller than the 44.8% of real
rustfmt-clean files because this corpus is 16 comparable files, not 905, and
because `nesting` / `widths` were planted to make the knobs visible rather than
to sample their frequency. The package confirms the prediction's *shape*:
`group` keeps every one of those constructs flat at width 100, and rustfmt
breaks them anyway. No package-level expression reached the sub-width output.

**File-agreement ceiling without new IR: 17/32 (53%).** Every remaining pair
is a named finding (`trail` pin, one-item `trail`, `fits` vs trailing
comments, mid-expression `/* */`, heterogeneous chains, sub-widths,
alignment, `=> {` after a broken arm header). Sub-widths alone would win
`nesting.rs` (2 pairs) and still leave `widths.rs` on alignment, so 19/32
and 11/16 @100 / 8/16 @60 — still under the 12/16 floor. Hitting 70% of
*files* needs more than entry 17. Hitting 70% of *pairs after stage D
accepts the classified limits* is already how TOML closed.

## Agreement

Matching files: `async`, `enums`, `macros`, `modules`, `normalize@100`,
`patterns@100`, `sequences`, `strings@100`, `traits`, `generics@60`,
`kitchen@100`.

## Divergences

Every remaining pair is classified. Hashes are the current content hashes.

- `rust/closures.rs@100` `46383e8472adc162…3798e4` — **design limit**. Method
  chains are a left-nested alternation of `field_expression` and
  `call_expression`. `flatten` walks one type. A prettier-style soft-dot
  group staircased and still missed `chain_width` 60, so the package keeps
  the chain flat. FINDINGS 11 and 17.

- `rust/closures.rs@60` `c912c8165d1e9a64…03da893` — **design limit**. Same
  chain. At 60 rustfmt also wraps the last closure body in a `{ }` block; a
  package may not insert those tokens (and must not remove a `block` —
  `{ x; }` is `()`).

- `rust/comments.rs@100` `2e1895bc81cd5eb3…6c07e` — **design limit**. Three
  things, none expressible: the mid-expression `/* … */` is attached as a
  suffix of `=` (FINDINGS 9); identifier fill packs `first, second` because
  a comment cannot force a width break (FINDINGS 7); the comment before `]`
  / `}` is not column-aligned (FINDINGS 18).

- `rust/comments.rs@60` `09319ae841d8b211…f2211` — **design limit**. Same
  three, minus the fill-pack (the array is already one-per-line at 60).

- `rust/generics.rs@100` `850bcf405912d794…02080` — **design limit**. The
  source has a trailing comma in `parameters`, so `trail` pins the group
  open. rustfmt collapses the signature because it fits. FINDINGS 3. Not
  a package bug: dropping `trail` cannot delete the comma.

- `rust/kitchen.rs@60` `22d4cb3ad7db0f7a…7bf97a` — **design limit**. The
  trait-method signature now matches: `parameters` is ungrouped and the
  signature is one `group`, so rustfmt's Tall layout (break params when
  the whole line does not fit) falls out. Remaining hunks are the method
  chain (FINDINGS 11 / 17) and rustfmt putting `{` on the next line after
  a long `=>`. One rule cannot be "space before `{`" and "newline before
  `{` when the arm header broke".

- `rust/nesting.rs@100` `73496cc4a30dd73f…d8ec95` — **design limit**.
  `Branch { leaves: [1, 2, 3, 4], label: "north" }` fits `max_width` and
  rustfmt breaks it (`struct_lit_width` 18). FINDINGS 17. Chosen: `group`
  is the general rule.

- `rust/nesting.rs@60` `9b36c57c1547db8c…09042a` — **design limit**. Same
  `struct_lit_width`. The third `Branch` happens to overflow remaining
  width and breaks; the first two stay flat. rustfmt breaks all three.

- `rust/normalize.rs@60` `f31c8e7f58aad0e3…72977` — **design limit**.
  `[1, 2, 3, 4]` fits 60; the trailing comment does not. `fits` counts
  the comment, rustfmt does not. FINDINGS 6. Fill packs the broken form
  (`1, 2, 3, 4,`) rather than one-per-line; still not rustfmt's flat.

- `rust/patterns.rs@60` `f50435ec8fe4f7ed…d4eb9` — **design limit**.
  rustfmt adds a trailing comma on a one-item broken `parameters`. `trail`
  will not add a comma for one item (black's rule). FINDINGS 3's other
  face.

- `rust/strings.rs@60` `990c0381bb988d21…27610` — **chosen**. rustfmt
  breaks `let escaped =` before a long string. A `group` on `let` opens
  whenever the value's own group opens, which rewrote `sequences.rs` (a
  matching file) into `let total =\n    first + …`. One file is not
  worth that. The long literal itself is an over-long leaf.

- `rust/structs.rs@100` `82266bda9c75c01b…03c784` — **design limit**.
  Only sibling comment alignment on the four fields. FINDINGS 18. Do not
  set `alignment: "go"`.

- `rust/structs.rs@60` `373cc106696aa3af…835495` — **design limit**.
  Alignment on the last two fields, plus `String::from("default")`
  missing a one-arg trailing comma (`trail`'s one-item rule).

- `rust/widths.rs@100` `d5bef39d3e852861…695ed` — **design limit**. All
  four `sub_widths` constructs stay flat (`group` vs rustfmt's nine
  widths). The `Config` fields and `aligned_arms` comments are FINDINGS
  18. The `under_every_threshold` controls stay flat, as required.

- `rust/widths.rs@60` `af4713b3e3f12138…5afec0f` — **design limit**. Same
  four knobs (now also over `max_width` for the chain/call/array) plus
  the width-dependent alignment split. Entry 17 and 18 in one file.

`leading_pipes.rs` is not in this list. rustfmt deletes the leading `|`;
we keep it. The file is `[incomparable]`.

## Runtime edits

One, charged to rust comments.

| commit | construct | gzip Δ | case |
| --- | --- | --- | --- |
| `5c27edb` comment text from source | `line_comment` / `block_comment` | **+299 B** (13396 → 13695) | tree-sitter-rust comments are interior nodes with no `text`. Attach was emitting `""`. Slice `source[start..end]`; a doc comment's range includes the line ending, so that newline is stripped from the text and given back to the following gap (otherwise `//!` ate the blank before the next `//`). |

Tried first: leave comments out of `comments` and write rules. Trailing
comments then become siblings every parent must consume, and
`let x = /* c */ 2` cannot stay mid-expression anyway. The slice is the
smaller change that lets the existing attachment pass work.

`comment_gap` and `blank_cap` are the ones the brief named; rustfmt
wants 1 of each. The other house-style constants already in the runtime
are FINDINGS 3 (`trail` pins a source trailing comma, and will not add
one for a one-item list) and FINDINGS 6 (`fits` counts a trailing
comment). Both are black's answer; rustfmt disagrees. They are
classified on `generics.rs@100`, `patterns.rs@60`, `structs.rs@60`, and
`normalize.rs@60` rather than worked around.

## Harness edits

None. Not even `harness/languages/rust.toml`.

## What was hardest

Two things, and they are not the same.

**Sub-widths (entry 17).** `group` asks whether the flat form fits the
remaining line. rustfmt asks a different question per construct, against
that construct's own span, at a fraction of `max_width`. 7 of 15
remaining divergences (46.7%) have that as a cause. If I could ask for
one thing it would be a package-declared sub-width on `group` — a
percentage of `max_width`, measured on the group's own span. That is
what the register already sketches. I did not try to fake it with a
nested group: the output is unreachable at any line width.

`flatten` *can* indent operator continuations (`indent` around the
separator's `line`). That matched `sequences.rs` at both widths. It is
not a substitute for sub-widths.

**Method chains (FINDINGS 11).** Even with sub-widths, `a.b().c().d()`
is an alternating spine `flatten` cannot collect. Rust lives in method
chains. The staircase is honest and width-compliant and is not rustfmt.

A close third: `trail` vs rustfmt's "collapse if it fits, keep the comma
if it does not". That is FINDINGS 3, paid here with `generics.rs@100`
and the one-item lists in `patterns.rs@60` / `structs.rs@60`.

I did not add a heterogeneous flatten or a sub-width opcode. Other
stage-C builders are in the same runtime files. Both belong in the
register, not as an opportunistic rust-only edit.

## Template delta

- `{{STAGE_B_VERDICT}}` was not substituted. Stage B had already applied
  its fixes on the branch. The instruction to "apply these first, commit"
  had nothing to apply.
- The 405/905 (44.8%) figure is a *real-file* prediction. The corpus
  number is 7/15 divergences, and the brief already said that. Useful to
  say again next time so a builder does not try to make the corpus match
  44.8%.

## Stage D: alignment was the last hope, and it does not reach Rust

Stage D reviewed 15 divergences and marked six of them `package-bug` —
`structs.rs`, `comments.rs` and `widths.rs` at both widths — on the strength of
FINDINGS 18 closing. The premise was that `cell` / `cellblock` had made rustfmt
alignment expressible in the package for ~0 B.

That premise was tested at the point of writing the rules, and it is wrong.
**FINDINGS 22** has the three measurements; the short form:

1. A package-placed `["cell"]` before a trailing comment collects the
   tabwriter's pad *and* the suffix's own `comment_gap`, so every aligned row is
   one column wider than rustfmt. Alignment is reachable; rustfmt's alignment is
   not.
2. `comment_cells: true` never fires on a Rust struct field. tree-sitter-rust
   makes the separator comma a child of the **list**, so the comment's preceding
   sibling is a token, and the header skips tokens. `structs.rs` emits zero cell
   markers with the header on.
3. Where the header does fire it also aligns statement comments, which rustfmt
   leaves alone — and re-formatting our own output re-aligns it, so
   `rust__comments.tree` fails **gate 2 idempotence** at both widths.
   Disqualifying, not debatable.

The capability itself is sound: with the header on and a `["cellblock"]` around
`match_block`, `widths.rs`'s match arms are byte-identical to rustfmt. What is
missing is **scope** — gofmt wants comment cells everywhere, rustfmt wants them
inside list blocks only, and one package-wide boolean cannot say both.

All six are therefore `design-limit`, and the package is at **0 package-bugs,
0 unreviewed, 100% review coverage**. No file flipped in either direction from
any of the experiments: 19/34 with them, 19/34 without. `widths.rs` remains
multi-cause — entry 22 for the comment column, entry 11 for the method chain —
and file agreement cannot see a fix to one hunk of five.

`leading_pipes.rs` was reviewed at the same time. It is the corpus's dedicated
incomparable file for rustfmt deleting a redundant leading `|`, which makes Rust
the **second language to want the `drop` opcode** — the condition FINDINGS 13 set
for deciding it. Entry 13 has been updated to record that the trigger fired.

### Verdict

`merge`. Gates 0-3 perfect, rust/js parity perfect, both widths above the 70%
review-coverage floor (100%), no stale reviews, no package bugs. The remaining
13 accepted divergences are all named findings: 22 (alignment scope), 11
(heterogeneous chains), 3 (`trail` pinning and its one-item skip), 6 (`fits`
counts a trailing comment), 7 and 9 (comments), plus one house rule on
`strings.rs@60`.

## After entry 22 closed

The stage-D section above stands as written — it was true when written, and the
six divergences really were design limits at that moment. Entry 22 was then
built, and three of them moved.

`comment_cells` now takes a scope, so a package can ask for rustfmt's rule
(align list items, leave statements alone) rather than gofmt's. The package
declares `"comment_cells": "block"` and wraps three lists in `["cellblock"]` —
`field_declaration_list`, `enum_variant_list`, `match_block`. That is the whole
package change: three brackets and a header.

| file | before | after |
| --- | --- | --- |
| `structs.rs@100` | diverged on the comment column | **agrees** — record retired |
| `structs.rs@60` | column + one-item `trail` | one-item `trail` only (entry 21) |
| `widths.rs@100` | column + method chain | method chain only (entry 11) |
| `widths.rs@60` | column + method chain | method chain only (entry 11) |
| `comments.rs` both | entries 22, 9, 7 | entries 9 and 7 — the column was never its main cause |

Agreement 19 → **20/32**. Go is unchanged at 12/16, which is the check that
matters for the narrowed token exclusion: it was *any token* and is now closing
delimiters only, and Go is the language that would notice.

The cost is +958 B of runtime for one corpus file, and half of that (+471 B) is
the width-aware column, which buys no file at all — only hunks inside files that
diverge for other reasons. Kept on the `house-style.md` argument that a comment
overrunning the box is exactly the readability failure this product is for.

### Verdict, restated

`merge`, unchanged, on better numbers: 20 agreement, 12 accepted, 0 stale, 0
unreviewed, 0 package-bug, gates 0-3 perfect, rust/js parity perfect.

## The or-pattern probe, and what the leading-pipe file was hiding

`leading_pipes.rs` is the dedicated probe for rustfmt deleting a leading `|`.
It contains only **short** patterns, so it never exercised what happens when the
same construct has to break — and being declared incomparable, nothing it did
could have shown up in the agreement number anyway.

`or_patterns.rs` now carries the long case. It has **no** leading pipes, so it is
comparable and stays out of the incomparable table; mixing the two constructs in
one file is exactly what the stage-B brief calls a review reject.

It is a well-behaved probe: **it agrees at width 100 and diverges at width 60**,
so the construct is isolated to one width and the divergence has one cause.
That cause is FINDINGS 23 — `flatten` identifies the next node in a left-nested
spine by the `flatten_fields` names, and tree-sitter-rust gives `or_pattern`'s
children no fields, so the one opcode built for this shape cannot walk it.

Agreement moves 20/32 → **21/34**: the probe adds two pairs, one agreeing and one
accepted.

### The refusal, and the fix

Writing the probe turned up a second gap immediately. This is ordinary Rust:

```rust
matches!(tag, ShortOne | ShortTwo | ShortThree)
```

and the package refuses it:

```
rule for `token_tree` wants the token `,` but found `|`
```

`macro_patterns.rs` now carries this, plus a guard, a range and a path inside
`matches!`. The guard on the comma-list branch was the bug: it tested three
things known to go wrong — no `.`, no `!`, and every *named* child one of five
content kinds — and said nothing about the anonymous children, which is exactly
where a macro's separators live.

One `["all", "*", …]` guard over the whole child list replaces all three. Every
child must be content or list punctuation, and anything else goes to
`verbatim`. The package gets **22 B smaller**, `macros.rs` still agrees at both
widths, and the separators nobody had hit yet — `=>`, `;`, `..=`, `::` — are
covered by construction rather than by enumeration.

`macro_patterns.rs` agrees at width 100 and diverges at 60 on the opaque-leaf
rule `strings.rs@60` already records. That house rule cited a regression; it is
now measured, and larger than the citation said — a let-level group takes Rust
from 22/36 to **17/36**.
