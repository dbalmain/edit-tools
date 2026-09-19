# Spike: a sub-width cap on `group`

Branch `spike/rust-subwidth`, based on `wt/lang-rust`. This is a measurement,
not a merge. Dave decides afterwards.

## Shape

A leading number on `group` is a fraction of the printer width:

```json
["group", 0.18, ["tok", "{"], ["indent", ["line"], …], ["line"], ["tok", "}"]]
```

The group breaks unless its flat form is **both** within the remaining columns
**and** within `round(max * width)` of its own span. No number means the old
test only.

Rejected alternatives:

- **`{ "max": 0.18 }`.** The IR is positional everywhere else. An object in
  the operand stream is a new JSON type for one field.
- **A separate opcode.** This is a group. Duplicating the constructor and the
  printer's `fits` walk would cost more than a leading number.
- **A package-header table of named thresholds.** Three numbers do not pay for
  a lookup, and `$` holes already let a `defs` body take the fraction as an
  argument (`["group", ["$", 2], …]`).

The printer change is local. `print` already asks `fits` for the group's own
flat span plus the rest of the line. The cap is a second `fits` of the group
alone against `round(max * width)`, with an empty stack so a trailer cannot
trip it. No sibling measurement, no ancestor state, no second pass. Wadler /
Oppen's single pass carries a second width just fine. Entry 17's "local" cost
profile is right.

## 1. What it buys

Before, on record and re-measured after the runtime-only commit: **17/32**.
After applying three knobs on `packages/rust.json`: **19/32**.

| width | before | after | closed |
| --- | ---: | ---: | --- |
| 100 | 10/16 | 11/16 | `nesting.rs` |
| 60 | 7/16 | 8/16 | `nesting.rs` |
| pairs | 17/32 | 19/32 | both `nesting` pairs |

`nesting.rs` is byte-identical to rustfmt at both widths. The three `Branch { … }`
literals that `struct_lit_width` 18 opens are now open.

`widths.rs` does **not** close. The planted struct literal, call, and array now
match rustfmt at width 100 (at width 60 they already broke from remaining
columns). The method chain is still flat (FINDINGS 11) and the `Config` /
`aligned_arms` comments are still unaligned (FINDINGS 18). File-level
agreement cannot see a three-hunk fix inside a five-hunk file.

No previously-matching file moved. Gates 1–3 stay green (34/34 idempotence,
34/34 non-destruction, rust/js identical 34/34). Overflow lines unchanged at
38 (rustfmt 39).

## 2. What it costs

gzip of `runtime-js/bundle.js`, `score.py`'s compressor (level 9):

| | before | after | Δ |
| --- | ---: | ---: | ---: |
| `runtime-js/bundle.js` | 13,695 B | 13,923 B | **+228 B** |
| `packages/rust.json` | 2,505 B | 2,548 B | **+43 B** |
| combined | 16,200 B | 16,471 B | **+271 B** |

Main's runtime on this ancestry is 13,695 B. Landing this on main is +228 B
on the budget number, plus +43 B on the rust package that is not on main yet.
Alignment was +2,627 B. `fill` was +365 B. This is cheaper than both.

Parity was not the expensive part. The JS print/eval/validate changes are a
mechanical mirror of the Rust ones. Gate 1 was green on the first joint run.
That matches the standing assumption; the alignment spike's "JS was cheap
because the pass was pure text" does not generalise as a warning here.

## 3. What it costs everyone else

Nothing, measured. After the runtime commit and **before** `packages/rust.json`
named a fraction, every language was re-scored with the operand undeclared:

| language | agreement |
| --- | --- |
| css | 18/30 (12 accepted) |
| go | 12/16 (4 accepted) |
| json | 6/6 |
| python | 20/24 (4 accepted) |
| rust | 17/32 |
| toml | 23/30 (7 accepted) |
| yaml | 12/32 (20 accepted) |

Rust staying 17/32 on the runtime-only commit is the sharp check: the same
printer, the same package, no fraction in sight. Other packages never pass a
number, so they take the old `Group` arm. Applying the rust knobs cannot
move them.

## 4. How many knobs are actually needed

Three knobs are expressible as a group cap. One of them buys the corpus.

| knobs on the package | agreement | what moves |
| --- | --- | --- |
| none | 17/32 | — |
| `struct_lit` 0.18 only | **19/32** | `nesting.rs` at both widths |
| `fn_call` 0.6 + `array` 0.6, no struct | 17/32 | hunks inside `widths.rs` only |
| all three | **19/32** | nesting + the same `widths.rs` hunks |

`struct_lit_width` is the only knob that closes a scored file. `fn_call` and
`array` do the right thing — `widths.rs@100`'s `combine(…)` and `[alpha, …]`
match rustfmt — but FINDINGS 11 and 18 keep that file in the unreviewed list.

`chain_width` is **not this feature**. A method chain is an alternating
`field_expression` / `call_expression` spine. There is no group around it,
so there is nothing to cap. The 69-file wild count from entry 17 is FINDINGS
11, not entry 17.

Of rustfmt's nine thresholds, the ones that are a group's own span:

| knob | fraction | this spike | wild files (entry 17, n=147 of 400) |
| --- | ---: | --- | ---: |
| `struct_lit_width` | 0.18 | applied | 83 |
| `fn_call_width` | 0.60 | applied | 56 |
| `array_width` | 0.60 | applied | 8 |
| `chain_width` | 0.60 | needs FINDINGS 11 | 69 |
| `attr_fn_like_width` | 0.70 | not applied; `arguments` would give them 0.60 | 12 |
| `single_line_if_else_max_width` | 0.50 | different question (`if` is a `seq` of hard blocks) | 12 |
| `struct_variant_width` | 0.35 | enum defs are already `hard` | 0 |
| `single_line_let_else_max_width` | 0.50 | not in the package | 0 |
| `short_array_element_width_threshold` | — | not this feature (per-element `fill`) | 18 |

Two knobs get most of the *expressible* benefit: `struct_lit` and `fn_call`.
`array` is almost free at this cost structure (same runtime, a `0.6` on an
existing def). `chain` is the second-largest wild knob and is a different
capability.

## 5. What it does not fix

13 divergences remain, down from 15. The original 7-of-15 (46.7%) "sub-width
as a necessary cause" splits like this:

| pair | after the spike |
| --- | --- |
| `nesting.rs` @100 and @60 | **closed** — only cause was `struct_lit_width` |
| `widths.rs` @100 and @60 | **partial** — struct / call / array match; chain (11) and comment alignment (18) remain |
| `closures.rs` @100 and @60 | unchanged — FINDINGS 11, plus rustfmt inserting `{ }` on a broken closure body |
| `kitchen.rs` @60 | unchanged — FINDINGS 11, plus `{` on the next line after a long `=>` |

The other 8 were never sub-widths:

| pair | needs |
| --- | --- |
| `comments.rs` @100 and @60 | FINDINGS 9 (mid-expression `/* */`), 7 (comment cannot force a width break), 18 |
| `generics.rs` @100 | FINDINGS 3 (`trail` pins a source comma) |
| `normalize.rs` @60 | FINDINGS 6 (`fits` counts a trailing comment) |
| `patterns.rs` @60 | FINDINGS 3 (one-item `trail` will not add a comma) |
| `strings.rs` @60 | chosen — a `let` group rewrote `sequences.rs` |
| `structs.rs` @100 | FINDINGS 18 |
| `structs.rs` @60 | FINDINGS 18 + one-item `trail` |

Hitting 12/16 at either width still needs FINDINGS 11 or 18 on top of this.
`11/16 @100` and `8/16 @60` stay under the floor. The file-agreement ceiling
without a second new capability is 19/32.

## What surprised me

**rustfmt does not scale thresholds below `max_width` 100.**
`WidthHeuristics::scaled` uses ratio 1.0 whenever `max_width <= 100`, and
only then `round(default * ratio)` above. Measured with rustfmt 1.9.0:

- A 18-column field list stays flat at `max_width` 60 and 100; a 19-column
  list breaks at both. The threshold is the absolute 18, not `0.18 * 60 ≈ 11`.
- At `max_width` 200 the 19-column list goes flat (threshold 36). Entry 17's
  "26-column body stays broken at 100 and goes flat at 200" is right, and
  does not generalise downward.

A true fraction is the right IR: one package, every width, no magic 100.
It is *not* rustfmt-identical near the default absolute thresholds at width
60. The corpus does not sit there — `Leaf { id: 1 }` is 5 columns of fields,
`Branch { … }` is 36 — so both scored widths agree with rustfmt anyway.

**The cap measures the group, including delimiters.** rustfmt's
`struct_lit_width` is the fields only. `{ leaves: …, label: "north" }` is 40
columns; the fields are 36. A 15-column field list (whole group 19) stays
flat in rustfmt at width 100 and would break under a 0.18 cap on the brace
group. Same 2-column story for `fn_call` and the parens. Not visible on this
corpus. A package that wanted rustfmt's interior would have to wrap only the
fields, and then the outer brace group would stay flat while the inner one
broke — hugging the wrong way — unless something forced the outer open.
BreakParent would do that and would also open enclosing calls. I did not
add that. The IR cap is "the group's own span"; rustfmt's interior is a
package-shaping problem the current `group` cannot state.

**One planted file did not move the agreement numerator.** `widths.rs` was
written to show four knobs and it does, hunk by hunk. File agreement is a
blunt instrument for a multi-cause file.

## Recommendation

**Land.** Not because 2 corpus files are a lot — they are not — but because
the price is the smallest of the three local capabilities on the register
(+271 B, against `fill` +365 and alignment +2,627), the algorithm did not
have to change shape, the capability is opt-in by measurement, and 44.8% of
real rustfmt-clean files are unreachable at any line width without it.

Decline would be the right answer if this had needed a second pass, or if
parity had been the expensive part, or if the only buyer were two planted
pairs. None of those happened. The 12/16 floor is a different bill —
FINDINGS 11 and 18 — and attaching that bill to this one would repeat the
alignment-spike mistake of bundling the hard part with the cheap part.

A reduced version (runtime + `struct_lit` only) is 19/32 at about +20 B less
package. I would not. `fn_call` is the third-largest wild knob and the
runtime is already paid for.

If it lands, correct FINDINGS 17: the thresholds are fractions of
`max_width` **at or above 100**, and constants below; `chain_width` is not
this feature; the 44.8% is a rustfmt-vs-itself count, not an agreement
prediction for a package that still cannot flatten a method chain.

## Harness

No harness change was required. None made.

Proposed, not done:

- `harness/probe_rust_subwidth.py` should say that `scaled()` does not shrink
  below 100, so a width-60 subtraction is not a second independent
  measurement of the same fraction.
- Stage C's `subwidth_divergences` counter in `score.json` is a hand count.
  After this, 2 of those 7 pairs are gone and 2 are partial; the field will
  rot unless someone recounts it.
- Nothing in `harness/languages/rust.toml` wants a new key. The fractions
  live in the package.
