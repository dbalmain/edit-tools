# Loader range validation

Completed 2026-08-29 on `wt/loader-validate`.

## Outcome

Both format runtimes now refuse malformed node byte ranges before formatting.
The fresh-binary parity sweep moved from 33 BREAK cases across the seven shapes
to zero:

```text
before: [FAIL] parity-fuzz  33 BREAK  0 SOFT   4 COSMETIC  66 MATCH
after:  [PASS] parity-fuzz   0 BREAK  0 SOFT  12 COSMETIC  91 MATCH
```

The full score is unchanged where required: gates 0–3 are 405/405, reference
agreement is 251/384, and stale, unreviewed, and package-bug counts are all
zero.

## Validation and refusal policy

Rust loads formatter trees through `TreeDoc::load` in `rust/src/tree.rs`.
Serde continues to own `usize` conversion, including rejection of missing,
negative, float, null, boolean, and string offsets. A single recursive pass
then checks every node for:

- `start <= end`;
- `end <= source.len()` (which also bounds `start` after the ordering check);
- a UTF-8 character boundary at both edges.

JavaScript runs the equivalent walk at the start of `format`, after encoding
the source and before constructing the formatter. `Number.isSafeInteger` plus
non-negativity supplies the explicit `usize`-equivalent scalar check. UTF-8
boundaries are checked in O(1) by rejecting continuation bytes; Rust uses
`str::is_char_boundary`, also O(1). Semantic range errors name the node kind,
range or edge, and source length. Rust's serde-owned scalar errors retain the
existing `malformed tree` value/type and line/column diagnostics.

I chose refusal rather than clamping. These offsets are part of the tree/source
interface, not a layout preference. Clamping would preserve several distinct
JavaScript coercions (including negative-from-end indexing) and would continue
to make malformed input depend on the downstream slice site. This deliberately
supersedes the earlier `newlines` clamp precedent; its regression tests now pin
load-time refusal.

## Checklist correction

The proposed node-local list was sufficient for 32 of the 33 initial BREAK
cases, but not complete for `srcgap/reversed`. That case derives a gap from two
individually valid, overlapping sibling ranges. A global no-overlap loader rule
would reject the harness's `comment_text/well_formed` driver, so the loader
cannot enforce this relation without broadening the tree contract. Rust already
refused it when `slice::get(from..to)` failed; JavaScript now explicitly refuses
`from > to` at the one point where `srcgap` forms the derived range. This is the
only downstream guard added.

## Cost measurement

Measured on the three largest committed trees by node count:

| tree | nodes | Rust load before | Rust load after | delta | JS format before | JS format after | delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `typescript__kitchen` | 448 | 254.029 us | 260.243 us | +6.214 us (+2.45%) | 544.720 us | 569.218 us | +24.498 us (+4.50%) |
| `python__kitchen` | 445 | 266.258 us | 274.714 us | +8.456 us (+3.18%) | 455.529 us | 481.570 us | +26.041 us (+5.72%) |
| `kotlin__nesting` | 424 | 232.839 us | 241.155 us | +8.316 us (+3.57%) | 456.545 us | 475.940 us | +19.395 us (+4.25%) |

Each figure is the median of seven in-process batches after warm-up. Rust used
2,000 deserialize/load operations per batch; JavaScript used 500 public
`format` calls per batch. Standalone validation used 100,000 passes per Rust
batch and 20,000 per JavaScript batch:

| tree | Rust validation only | JS validation only |
| --- | ---: | ---: |
| `typescript__kitchen` | 1.994 us | 13.094 us |
| `python__kitchen` | 1.994 us | 12.439 us |
| `kotlin__nesting` | 2.020 us | 7.447 us |

The relative cost is visible and is reported rather than rounded away, but the
stated O(nodes) pass itself costs about 2–13 us once per loaded tree on the
largest corpus inputs. I do not consider that material enough to send the fix
back into twelve slice sites.

## Runtime byte cost

Using `gzip -9 -c` before and after fresh release builds:

- JavaScript formatter runtime: 16,052 B -> 16,501 B, **+449 B**.
- Rust formatter binary: 276,672 B -> 277,837 B, **+1,165 B**.

The scorer's deterministic header-free gzip measure reports the same JavaScript
delta: 16,042 B -> 16,491 B (+449 B).

## Regression coverage

Equivalent Rust and JavaScript loader tests pin:

- one well-formed multibyte range;
- reversed and past-end ranges;
- negative, float, null, boolean, string, and missing offsets;
- UTF-8 splits at the start edge and end edge.

Both formatter suites also pin the derived reversed `srcgap`, load-time refusal
for the former `source-multiline` and `newlines` clamp cases, and loader refusal
before `verbatim`. One existing synthetic list fixture claimed byte 9 as its end
for an 8-byte source; both mirrors were corrected to byte 8.

## Final gates

- `./build.sh`: pass, zero warnings.
- `cargo test`: pass (8 + 116 + 116 + 22 tests).
- `cargo clippy --all-targets -- -D warnings`: pass.
- `node --test runtime-js/bundle.test.js runtime-js/highlight.test.js`: 99/99.
- `./harness/parity_fuzz.py`: pass, 0 BREAK.
- `./harness/score.py .`: pass with the unchanged required scores above.

No harness, package, corpus, or sibling-worktree files were changed. Nothing
was pushed.
