# Scanner VM integration — done-note

Branch `wt/parse-scanner`, based on `main` at `51231a7`.

## Nothing here needs fixing on `main`

The earlier note mentioned "a gap in the artifact story". It was a **missing
check, not a wrong artifact**, and the fix is on this branch. In full: JS had no
`.svm` decoder, `pack.js::encode` had no caller anywhere in the repo, and
`replay.js` ran the VM off the in-memory program object while only Rust read the
packed bytes. So nothing verified that the committed `toml.svm` was still the
encoding of `toml.program.js`. It **was** — byte for byte — so `main` is not
carrying a bad artifact. Take this branch and the hole is closed.

## Result

**toml 15/15 byte-identical through the VM.** json 3/3, scheme 15/15, go 16/16
unchanged. `./test.sh` green: 126 harness tests and Rust 116 / 22 / 8, both
identical to the baseline I measured before touching anything.

One number is worth more than the 15/15, because it is an independent oracle.
Instrumenting the parse over the whole corpus:

```
scan() 230   deserialize() 230   serialize() 204   non-empty states 0
```

The spike's recorded trace of **real tree-sitter** driving the **real
`scanner.c`** over the same 15 files is 230 calls with 26 returning false.
230 − 26 = 204. So this parser calls the scanner the same number of times, at
the same points, with the same number of failures as tree-sitter itself — not
merely producing the same tree.

## Was the spike's TOML program complete? Yes

The brief's explicit worry — "the spike ported the *smallest* scanner, and
'smallest' may still mean 'not all of it'". It does not. Diffed statement by
statement against tree-sitter-toml 0.7.0's `scanner.c`: both
`scan_multiline_string_end` call sites with the correct argument triples and
short-circuit order, all four of its returns including the one that
deliberately does *not* `mark_end`, the `valid_symbols` guard, the `[ \t]` skip
loop, the `lookahead == 0 || '\n'` accept and the `\r\n` accept. All five
external tokens are reachable, in upstream's enum order.

One upstream statement is not transcribed, harmlessly: upstream sets
`result_symbol = LINE_ENDING_OR_EOF` *before* the skip loop, so it is set even
on paths that return false. `result_symbol` is only read when `scan` returns
true.

The port also preserves a subtlety a tidier port would lose: upstream tests
`lookahead == 0`, **not** `eof()`, so a literal NUL byte ends a line. The
bytecode uses `IF_CHAR 0`, not `IF_EOF`.

## What serialize actually cost, and the answer to the design question

**Cost to implement: nothing. Cost to validate: everything, and it is unpaid.**

TOML's scanner is stateless — `serialize` returns 0 bytes. The plumbing runs
(230 deserializes, 204 serializes above) and carries **zero non-empty states**.
So the 15/15 says *nothing whatsoever* about serialization, exactly as
`docs/scanner-vm.md` §7 already warned. I did not add speculative serialize
code, because TOML cannot test a line of it.

### Does VM-defined serialize survive contact? Qualified yes — but the doc's stated reason is wrong

`docs/scanner-vm.md` defends the decision like this: *"there is no per-scanner
serialization code, and therefore no per-scanner serialization bug. Nine chances
to get it wrong become zero."*

**That claim is false, and the eight remaining ports inherit the mistake.**

The load-bearing observation the doc gets right is that the serialized bytes are
never interpreted — they are only ever compared for equality, in exactly three
places (`external_scanner_state_changed`, `ts_stack_can_merge`, the token
cache). I verified that against 0.26.0's sources. So byte-compatibility with
upstream genuinely is not required.

But what *is* required is not "a format", it is that the VM's format induce **the
same equivalence relation on scanner states** that upstream's per-scanner format
does. Where the relations differ, `state_changed` and `can_merge` differ, and a
different merge decision can produce a different tree. Upstream's serializers are
lossy in scanner-specific ways, and the loss is what defines the relation.

tree-sitter-python 0.25.0's `serialize` is the proof — three separate losses in
one 20-line function:

1. `delimiter_count` is **clamped to `UINT8_MAX`**, so 255 and 300 open
   delimiters serialize identically and upstream calls those states equal;
2. the indents loop starts at **`iter = 1`** — element 0 is deliberately never
   serialized, so it is state that exists and is defined not to matter;
3. truncation drops from the tail of **`indents` specifically**, whereas the VM
   drops "from the top of the deepest stack", which could pick `delimiters`.

A VM program that faithfully declares python's two stacks persistent would be
**strictly finer** than upstream on all three counts: it would distinguish states
tree-sitter merges. Rust's scanner has the same shape in miniature — it stores
`opening_hash_count` in one `char`, so 300 and 44 hashes are equal upstream and
distinct in the VM.

So the honest verdict:

- **Keep VM-defined serialize.** It is right that the format is fixed and shared,
  and it does remove one real class of bug (a hand-written serializer that
  disagrees with its own deserializer, or between the two runtimes).
- **Retire the "nine chances become zero" claim.** The per-scanner judgement does
  not disappear; it *moves* — out of a serializer and into the port's choice of
  which registers and stacks are persistent, and how the state is laid out. The
  porter of python still has to know that `indents[0]` is a sentinel and model it
  implicitly, and that the delimiter count saturates.
- **State the real obligation.** It is relation-compatibility, not
  byte-compatibility. That is weaker than matching upstream's bytes and strictly
  stronger than "both runtimes agree with each other", which is all the current
  document asks for.

None of this is measured. It is read off upstream's sources, because TOML gave
me no state to measure. The first stateful port — rust, one byte — settles it
for real, and `docs/scanner-vm.md` §8 already recommends rust or python next for
precisely this reason.

## What the brief got wrong

1. **`get_column` is not why row/column tracking was needed.** The brief said
   "Upstream has exactly two consumers of line extents: `get_column`, used by
   external scanners... You need the first." **No scanner calls `get_column`** —
   grepping all sixteen pinned `scanner.c` files returns zero, python's
   included, which is what `docs/scanner-vm.md` §1 independently recorded. The
   VM deliberately traps on it. And the frozen trees carry byte offsets only, so
   row/column cannot move the acceptance bar in either direction. TOML would
   have gone 15/15 without any of it.

   The false fact came from `docs/parse-tables-spike.md`, which claimed "Any
   grammar whose scanner calls `get_column` — Python's, for one — needs it". I
   corrected that document in `cc77079`.

   I built it anyway, first and on its own commit, for the two reasons that are
   not the brief's: upstream maintains the extent on every advance, so skipping
   it means diverging deliberately; and the error-recovery track needs the
   interface.

2. **The ctype hazard does not apply to TOML.** `docs/host-ctype-divergence.md`
   warns that seven grammars call `isw*`. TOML is not one — its only character
   test is `' '` and `'\t'`, carried as a sorted two-range class. The hazard is
   real for the other eight and inert here.

3. **"Six of seven function pointers are the scanner's five plus
   `keyword_lex_fn`"** — I did not verify this against `wasm_store.c` and did
   not need to; the data/code split it describes is what I implemented, and the
   two tables tree-sitter *does* express as data
   (`ts_external_scanner_symbol_map`, `ts_external_scanner_states`) are now
   transcoded. Treat the seven-pointer count as unchecked.

4. Everything else checked out: 15 toml fixtures, and both `ts_lr.mjs` and
   `ts_transcode.py` did refuse scanner grammars.

## What landed

| Commit    | What                                                              |
| --------- | ----------------------------------------------------------------- |
| `ef34650` | baseline, program completeness, the artifact gap                   |
| `cc77079` | row/column tracking in the lexer, on its own                       |
| `4a15b8d` | the missing JS `.svm` decoder; both runtimes now run one artifact  |
| `675c2a7` | WIP transcoder — external tables, not yet green                    |
| `b9b03d6` | the fix: the external token enum is a third namespace              |
| `3c52b54` | the parse loop drives the VM — **toml 15/15**                      |

Two subtleties worth carrying forward:

- **There are two columns and upstream gives them the same name.**
  `extent.column` counts *bytes* within the row; `ColumnData`/`get_column`
  counts *codepoints*. A port using one number for both agrees on ASCII and
  diverges on any multi-byte character. There is a test that fails only under
  that mutation.
- **Scanner state is per stack head, not per parser.** Two GLR versions can be
  mid-way through different constructs, so `lastExternalToken` rides on the
  head, is inherited by a fork, and is compared in `canMerge`.

Also fixed in passing: `ts_lexer_finish` omitted upstream's `+4` to the
lookahead end byte on `TS_DECODE_ERROR`.

## Honest estimate of the remaining eight

**The integration cost is now zero and was one-time.** Adding a scanner today is
`ts_transcode.py --scanner foo.svm`, then run the corpus. The parser, the
transcoder, the wire format and the GLR state plumbing are generic and done.
`docs/scanner-vm.md` priced the *compilation* of the nine scanners and never
priced this half at all; it was one session.

**I add no new evidence on the compilation cost**, and I want to be plain about
that: TOML's bytecode was already written when I arrived, so scanner-vm.md's
"3–4 weeks for nine, ±40%" still rests on one small port and 6% of the largest.
Nothing I did tightens that band.

What I *can* now say that the document could not:

- **Four of the eight are pure compilation** — css, javascript and kotlin are
  stateless like TOML (`serialize` returns 0 bytes), so they inherit a path that
  is now demonstrated end to end. For these I would believe scanner-vm.md's
  line-rate estimate: css ~175 B, javascript ~650 B, kotlin ~960 B.
- **Five carry an unpriced design question each** — rust, markdown-inline,
  markdown-block, python and yaml have real serialized state, and each needs its
  *equivalence relation* reproduced, not just its bytes. That is per-scanner
  judgement work the "serialize is free" line in scanner-vm.md's markdown-block
  table explicitly assumes away. It is small for rust (one byte, one register)
  and genuinely hard for python and yaml, where the loss is deliberate and
  undocumented.
- **The oracle does not generalise for free.** The trace recorder in
  `spike/scanner-vm/record/` is TOML-specific C. Each new scanner needs its own
  build against its own ABI. That is a real per-scanner cost the "one-time
  harness" framing hides.

So: **rust next, not markdown-block** — it is one byte of state and it converts
the serialize question above from analysis into measurement for the price of the
cheapest port in the roster. Until that is done, treat the VM-defined-serialize
decision as *argued* rather than *tested*, because 45,678 green calls and my
15/15 all ran with zero bytes of state.

## What this does not verify

- No stateful scanner has been through this path. Serialization is untested end
  to end, as §7 of `docs/scanner-vm.md` already said and still says.
- The corpus is 15 clean files. External scanning under error recovery is
  untouched; recovery still throws.
- Incremental reparse is still absent, so `dependsOnColumn` — which I now
  compute and propagate — has no consumer.
- Row/column is unchecked by any corpus, by construction: the trees carry byte
  offsets only. `harness/ts_lr.test.mjs` is the whole of the evidence.
