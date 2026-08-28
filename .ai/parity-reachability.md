# Byte-range parity: reachability

**12 of 12 format-path source-byte sites are reachable from `./fmt-rust` /
`./fmt-js` by a hand-written tree.** None of them sit behind a range
validator. The sweep is worth its wall-clock: the known `prefix` instance is
not a singleton, and the class is not sealed off at load.

This is a static tracing result, written before any CLI probe. Dynamic
confirmation is the sweep that follows.

## How the number was derived

A naive grep for `.get(`, `subarray`, `from_utf8`, `TextDecoder`, `.slice(`,
and `src[` is the ~42 / ~29 the brief quoted. Most of those hits are not this
defect class:

- `HashMap::get` / `items.get(cursor)` / package-JSON lookups
- printer and aligner `.slice` on already-decoded Doc IR
- definition-cycle `stack.slice` in JS
- highlighter `tree.source[i..]` in `hl_eval.rs` (a different CLI)

The class is a range `(start, end)` taken from the tree, applied to the source
**byte** buffer. Pairing every such operation in `rust/src/{eval,attach}.rs`
with its twin in `runtime-js/bundle.js` gives **12 sites**. Cursor/map lookups
and IR string slices are listed under Unreachable so the split is auditable,
not so they get probed.

There is no tree-level range validator. Rust load is `serde` onto `usize`; JS
load is `JSON.parse`. A hand-written `.tree.json` with adversarial
`start`/`end` is admitted and evaluated. `harness/gen_trees.py` is what keeps
the corpus well-formed; it is not on the runtime path.

Shipped packages already exercise every site (json/markdown `verbatim`,
markdown `prefix`, html/markdown `srcgap`, haskell `source-multiline`, rust
`line_comment` without `text`). A toy package via `FMT_PACKAGES` reaches the
same `format()` entry and isolates an opcode; that is still the CLI surface.

## The 12, all reachable

Ranges are against this worktree. Each row is one (Rust, JS) pair.

| # | site | Rust | JS | CLI driver |
| --- | --- | --- | --- | --- |
| 1 | `Fmt::slice` | `eval.rs:99` `src.get(start..end)` + `from_utf8` | `bundle.js:1616` `subarray` + `TextDecoder` | `verbatim` (json `string`, markdown `paragraph`, …). `check_verbatim` runs first, so inverted / past-end die at #2–#3; a UTF-8-splitting range that passes the walk still reaches here. The review-brief's "path no package currently takes" is the dead inverted/past-end arm of slice, not verbatim itself. |
| 2 | `check_verbatim` inverted | `eval.rs:892` `start > end` | `bundle.js:1556` | same `verbatim` node |
| 3 | `check_verbatim` past-end | `eval.rs:896` `end > src.len()` on the root only | `bundle.js:1558` | same. Children are checked against the parent, not the buffer, so a child cannot outrun a root that passed. |
| 4 | `check_verbatim` leaf bytes | `eval.rs:902` `src.get` vs `text.as_bytes()` | `bundle.js:1562` `subarray` vs `TextEncoder` | `verbatim` node carrying `text`. After #2–#3 the `get` `None` arm is dead for `usize` ranges; this site compares bytes, it does not decode. |
| 5 | `prefix` marker | `eval.rs:483` `src.get` + `from_utf8` | `bundle.js:1349` `end > length` then `subarray` + decode | markdown `fenced_code_block` else-branch (`count` of `code_fence_content` ≠ 1) consuming `t:block_continuation`. JS refuses only `end > length`; reversed and UTF-8-splitting ranges are the 2026-08-28 instance. |
| 6 | `srcgap` | `eval.rs:391` `src.get(from..to)` + `from_utf8` | `bundle.js:1307` `subarray` + decode | html `document` / `inline_element`; markdown fence `srcgap` arm. `from`/`to` are sibling `end`/`start` (or the parent's), so adversarial child ranges drive it without the parent being inverted. |
| 7 | `source-multiline` | `eval.rs:669` `get(start..end.min(len))` | `bundle.js:1240` `subarray` | haskell `bracketed`, haskell `record`. Rust already clamps `end`. Reversed still takes `get` (returns `None` → predicate false); JS reversed `subarray` is empty → also false. Byte search, no decode. |
| 8 | `comment_text` | `attach.rs:50` `src.get` then `from_utf8.unwrap_or("")` | `bundle.js:836` `subarray` + decode | rust `line_comment` / `block_comment` with no `text` field (the corpus already uses this shape). Rust **swallows** both `None` and invalid UTF-8 as `""` rather than refusing — opposite polarity to #1 and #5. |
| 9 | `comment_content_end` | `attach.rs:61` `end.min(src.len())` then `src[end-1]` | `bundle.js:828` **unclamped** `bytes[end-1]` | helper of #8. JS bracket access on a `Uint8Array` is `undefined` past the end (and at negative indexes), not from-the-end; the while-condition then stops. Trailing CR/LF stripping therefore disagrees with Rust on a past-end comment range. |
| 10 | `content_end` | `attach.rs:104` clamp then `src[at-1]` | `bundle.js:865` same clamp | every `split` of a node with children. Direct index is guarded. Feeds blank-line counts. |
| 11 | `deep_end` | `attach.rs:97` recurse to #10 | `bundle.js:857` | markdown `gap_owner.list = [list_item]` (and any other declared owner). |
| 12 | `newlines` | `attach.rs:123` clamp `to`, `0` if `from >= to`, then `src[from..to]` | `bundle.js:877` `Math.max(from,0)` / `Math.min(to, len)` | every `split`. Fifth instance of the class; Rust was changed to clamp, matching JS. JS additionally floors `from` at 0 (negatives). |

## Loader, not a slice site, but it gates the class

Rust `Node.start` / `Node.end` are `usize`. Negative, missing, fractional, and
non-numeric values fail `serde` with `malformed tree` (exit 1) before any site
above runs. JS `JSON.parse` keeps JSON numbers as `number` and hands them to
`subarray`, whose `ToInteger` truncates fractions and treats **negatives as
from-the-end**.

That last point is a correction to the brief. `Uint8Array.subarray(a, b)`
does clamp reversed and past-end ranges to empty / to `length`, but a
negative `a` or `b` is `length + n`, not clamp-to-zero. `newlinesBetween`
(`Math.max(from, 0)`) is the one JS site that does clamp negatives. The
loader therefore splits the "negative `start`/`end`" case off the slice
class: Rust never reaches the slice; JS indexes from the tail. That is a
BREAK of its own, at parse, if the tree is admitted at all.

## Unreachable from `fmt-rust` / `fmt-js`

These matched the naive grep and are not this sweep.

| site | why |
| --- | --- |
| `hl_eval.rs` `tree.source[after..]` and friends | highlighter CLI (`hl-rust` / `hl-js`), different binary |
| `doc.rs` / JS `print` / `alignCells` `.slice` | Doc IR strings, not the source buffer |
| `align.rs:147` `cells.get` | alignment cells, not source |
| `pkg.rs` / JS `loadPackage` `.get` | package JSON |
| `eval.rs` `items.get(cursor)` / JS `this.items[i]` | cursor, not a source range |
| JS `stack.slice` in definition-cycle errors | names, not bytes |
| `eval.rs:33` `tree.source[suffix..]` (semantic-eof) | derived from `trim_end_matches` on the source `String`, not from tree offsets |

No format-path source-byte site is internal-only. Cursor state cannot hide a
range the tree did not supply.

## Framing notes (before the sweep)

- Sites #7 and #12 already chose JS's clamp. A sweep of those is a
  regression check, not a hunt.
- Site #8's Rust path is "accept as empty" rather than "refuse". A UTF-8
  split there is both-emit-and-differ, still BREAK, but the polarity is the
  opposite of `prefix`.
- Site #1's inverted/past-end arms are unreachable because of #2/#3. The
  live arm is UTF-8. That is still the class (`from_utf8` vs `TextDecoder`).
- Vertical tab in `srcgap` is a different primitive pair (Rust
  `u8::is_ascii_whitespace` vs JS's explicit byte set). JS comments claim
  both exclude U+000B; the sweep will record whatever the binaries do, but
  it is not `slice::get` vs `subarray`.
- Production trees from `gen_trees.py` never hit any of this. Dirty and
  injected corpus trees still carry well-formed ranges. The class is
  reachable from the CLI, not from the committed corpus.
