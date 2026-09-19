# Byte-range parity sweep

## Reachability

**12 of 12 format-path source-byte sites are reachable from `./fmt-rust` /
`./fmt-js`.** Derived by pairing every tree-offset range into the source
buffer in `rust/src/{eval,attach}.rs` with its twin in
`runtime-js/bundle.js`, then tracing each to a hand-written tree. Naive
grep of `.get(`/`subarray` is ~42/29 and is mostly `HashMap`, cursor, and
Doc-IR string slices — wrong primitive. There is no range validator on
load: Rust is `serde` onto `usize`, JS is `JSON.parse`. The committed
corpus never hits the class (`gen_trees.py` refuses ERROR/MISSING), but
the CLIs will evaluate whatever tree they are given. Full site list:
`.ai/parity-reachability.md`, committed before any probe.

## BREAK

Seven shapes. 33 fuzzer cases, four of them shipped-package witnesses.
None were fixed. One minimal tree per shape; `./harness/parity_fuzz.py`
regenerates the rest.

### 1. `prefix` reversed / start-past — known, 2026-08-28

JS checks only `end > length`. A reversed range has `end` in bounds, so
JS `subarray` yields empty and formats; Rust `src.get` returns `None`.

```json
{"language":"toy","source":"hello","root":{
  "type":"prefix_root","start":0,"end":5,
  "children":[
    {"type":"marker","start":4,"end":2},
    {"type":"word","start":0,"end":5,"text":"hello"}
  ]
}}
```

RUST: refuse(1) `` `marker` runs past the source ``
JS: emit `\nhello\n`

`start_past` (marker 8..2) is the same shape. `end_past` (0..15) **MATCH**:
JS's extra check fires. Shipped witness: markdown `fenced_code_block`
else-branch, `block_continuation` start=4 end=2, source `"hello"`. Same
refuse vs emit.

### 2. `prefix` UTF-8 split — known, 2026-08-28

Same site, different primitive: `from_utf8` vs `TextDecoder` (U+FFFD).
Source `"xéy"` is 4 bytes (`78 c3 a9 79`). Marker `0..2` splits `é`.

RUST: refuse(1) `` `marker` is not valid UTF-8: incomplete utf-8 byte sequence from index 1 ``
JS: emit `\nx�y\n`

Second edge (`2..4`) and both edges (`"éé"` `1..3`) likewise. Shipped
witness: markdown `block_continuation` 0..2 on `"xéy"`.

### 3. `verbatim` / `Fmt::slice` UTF-8 split — new

`check_verbatim` refuses inverted and past-end ranges, which is why the
review-brief called slice "a path no package currently takes". That is
true of those two arms. It is **not** true of UTF-8: the walk does not
decode. A splitting range that sits inside the buffer reaches `slice`,
and the two runtimes diverge. json's `string` rule is `verbatim`.

```json
{"language":"json","source":"xéy","root":{"type":"string","start":0,"end":2}}
```

RUST: refuse(1) `` `string` is not valid UTF-8: incomplete utf-8 byte sequence from index 1 ``
JS: emit `x�\n`

A well-formed child under a splitting parent still passes
`check_verbatim` (containment + leaf-text match) and then hits the same
decode. Inverted and past-end MATCH (both refuse at `check_verbatim`).

### 4. `srcgap` reversed / out-of-bounds — new

`from`/`to` are sibling `end`/`start` (or the parent's). Rust `get`
refuses; JS `subarray` of a reversed or past range is empty (or a
clamped whitespace suffix) and formats.

```json
{"language":"toy","source":"a  b","root":{
  "type":"srcgap_root","start":0,"end":4,
  "children":[
    {"type":"left","start":0,"end":3,"text":"a"},
    {"type":"right","start":1,"end":4,"text":"b"}
  ]
}}
```

RUST: refuse(1) `rule for srcgap_root wants a valid source gap but found right`
JS: emit `ab\n`

Whitespace-past is the other polarity of the same get/clamp:

source `"a  "` (3 bytes), gap `left.end=1 .. right.start=8`.
RUST: refuse `get` None.
JS: clamp to the two trailing spaces, emit `a  b\n`.

### 5. `comment_text` UTF-8 split — new, opposite polarity

A comment node with no `text` is sliced. Rust `from_utf8.unwrap_or("")`
**swallows** the error and emits an empty comment; JS emits U+FFFD.
Both format. Corpus rust `line_comment` already uses this shape (interior
node, no `text`).

source `"xéy"`, comment `0..2`, host word `"y"`.
RUST: emit `\ny\n` (empty comment + hard + y)
JS: emit `x�\ny\n`

### 6. `comment_content_end` past-end trailing CR/LF — new

Rust clamps `end` to `src.len()` then peels trailing CR/LF. JS does
**not** clamp: `bytes[end-1]` is `undefined`, the peel loop never runs,
`subarray` then clamps and keeps the terminator.

source `"x\n"`, comment `0..50`.
RUST: emit `x\nx\n` (comment body `"x"`)
JS: emit `x\n\nx\n` (comment body `"x\n"`)

Same split on source `"x\r"`: Rust peels the CR, JS keeps it.

### 7. Loader domain — new (tree, not package)

Rust `Node.start`/`end` are `usize`. Negative, missing, float, null,
bool, string: `malformed tree`, never reaches a slice. JS `JSON.parse`
keeps the JSON number and feeds it to `subarray`.

The brief said JS "silently clamps" negatives. It does not.
`Uint8Array.subarray` treats a negative as `length + n` (from-the-end),
the way `String.prototype.slice` does. Confirmed:

| input | JS `subarray` | JS emit (prefix + hard + `"hello"`) |
| --- | --- | --- |
| start=-1 end=2 | (4, 2) empty | `\nhello\n` |
| start=0 end=-1 | (0, 4) `"hell"` | `\nhellhello\n` |
| start=-2 end=-1 | (3, 4) `"l"` | `\nlhello\n` |
| verbatim start=-1 end=5 | (4, 5) `"o"` | `o\n` |

Float 1.5 truncates via `ToInteger`. Missing start is `undefined` → 0.
All BREAK: Rust refuses, JS formats.

## SOFT

None. Every refusal is exit 1 on both sides. No panic on a malformed
range: the unguarded `src[i]` sites in `content_end` / `newlines` clamp
first.

## COSMETIC

4 cases, same exit, different message. Three are `srcgap` where Rust
`get` is `None` ("a valid source gap") and JS clamps into a range that
then fails the whitespace scan ("only whitespace"). One is
`loader/u64_overflow`: Rust serde rejects the float, JS reaches prefix
and refuses `end > length`. Not a parity defect.

## `parity_fuzz.py`

`./harness/parity_fuzz.py [submission-dir] [--json] [--verbose] [--site NAME]`

103 cases across the 12 sites plus the loader. Toy package via
`FMT_PACKAGES` isolates each opcode; four cases replay the same shapes
through shipped `json` and `markdown`. Well-formed drivers must MATCH-emit
or the script exits 2 (fuzzer bug, not a runtime defect). Exit 1 on any
BREAK; SOFT would be reported and would not fail. Not wired into
`score.py` or `test.sh`.

Cannot reach: the highlighter CLI (`hl_eval.rs` source indexing),
printer/aligner slices of Doc IR, cursor/`HashMap` lookups. Those are
not this class.

Empty ranges at 0 / mid / `len`, well-formed CRLF and lone CR, and
vertical tab in `srcgap` all MATCH. `source-multiline` and `newlines` /
`content_end` / `deep_end` MATCH on every malformed range — those are
the sites that already chose JS's clamp.

## Decisions, including disagreements

- The `slice::get` vs `subarray` framing is right but incomplete. Three
  primitive pairs produce BREAK: (1) `get` None vs `subarray`
  clamp/from-the-end, (2) `from_utf8` vs `TextDecoder` U+FFFD, (3) serde
  `usize` vs JSON number. Sweeping only (1) would have missed 3, 5, 6, 7.
- Hand-written trees are **not** refused by a validator. If they had
  been, the four known instances would have been unreachable in
  production. They are reachable. The corpus is well-formed by
  construction; the runtime is not.
- The known `prefix` instance is not a singleton. `srcgap` is the same
  `get`/`subarray` shape on sibling offsets. `verbatim` UTF-8 is the
  live arm of `Formatter.slice`. `comment_text` is the same decode pair
  with inverted polarity (Rust accepts-as-empty, JS emits U+FFFD).
- Vertical tab in `srcgap` is MATCH. Both refuse it as non-whitespace.
  `u8::is_ascii_whitespace` does not include U+000B, matching the JS
  byte set. The suspected extra primitive pair is not a defect here.
- I drove sites with a toy package. That is still the CLI surface
  (`format()` plus `FMT_PACKAGES`, which both wrappers honour). Shipped
  json/markdown witnesses are in the table so the class is not an
  artefact of the toy language.
- I did not fix any BREAK. A parity fix changes runtime behaviour.
- `.ai/` is gitignored in this repo. The two reports were force-added
  because the slice asked for them on disk.

Score at this commit, unchanged from `main`: 405/405 gates 0–3,
251/384 reference agreement, 38121 B gzip, 0 stale, 0 unreviewed, 0
package bug.
