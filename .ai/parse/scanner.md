# Scanner VM integration — running notes

Worktree `wt/parse-scanner`, based on `main` at `51231a7`. Updated as the work
proceeds rather than written at the end, because the first green boundary is
hours out and a session limit is roughly two.

## Status

Investigation complete; integration in progress. Nothing integrated yet.

## Baseline, measured before any edit

`./test.sh` green from the worktree root, 1m18s wall:

| Suite                                      | Count            |
| ------------------------------------------ | ---------------- |
| `python3 -m unittest discover -s harness`  | **126** tests OK |
| `cargo test` (three suites)                | **116 / 22 / 8** |

These match the brief exactly. A drop in any of them is a failure, not a
refactor.

## What the brief got right

- **15 TOML fixtures.** `corpus/trees/toml__*.tree.json` is exactly 15 files.
- **Both named files do refuse scanners.** `ts_transcode.py` raises
  `Unrecognised("external scanner: out of scope for this spike")` on
  `EXTERNAL_TOKEN_COUNT != 0`; `ts_lr.mjs` throws
  `Unsupported("external scanner state reached")` when
  `externalLexState(parseState) != 0`.
- **The spike contains what it says it contains** — `vm.js`, `pack.js`,
  `asm.js`, `lexer.js`, `toml.program.js`, `toml.svm`, `rust/`, `traces/`
  (15 `.jsonl`, one per corpus file), `record/`, `replay.js`.

## Was the spike's TOML program complete? Yes.

This was the brief's explicit worry — "the spike ported the *smallest* scanner,
and 'smallest' may still mean 'not all of it'". It does not. I diffed
`spike/scanner-vm/toml.program.js` against tree-sitter-toml 0.7.0's real
`scanner.c` (82 lines) statement by statement:

- both `scan_multiline_string_end` call sites (`"` and `'`), with the correct
  argument triples and the correct short-circuit order;
- all four returns inside that helper, including the one that deliberately does
  *not* `mark_end` (the token ends one delimiter in, where the first `mark_end`
  put it);
- the `valid_symbols[LINE_ENDING_OR_EOF]` guard, the `[ \t]` skip loop, the
  `lookahead == 0 || '\n'` accept, and the `\r` then `\n` accept;
- all **five** external tokens are reachable, in upstream's enum order.

One upstream statement is not transcribed, harmlessly: upstream sets
`lexer->result_symbol = LINE_ENDING_OR_EOF` *before* the skip loop, so it is set
even on paths that then return false. `result_symbol` is only read when `scan`
returns true, so the port setting it at the emit instead is unobservable.

The port also correctly preserves a subtlety worth naming: upstream tests
`lexer->lookahead == 0`, **not** `lexer->eof()`, so a literal NUL byte in the
source ends a line. The port uses `IF_CHAR 0`, not `IF_EOF`. A port that
"cleaned this up" would diverge on input no fixture contains.

## Where the brief is wrong, and it changes this slice

### 1. `get_column` is not why row/column tracking is needed — nothing uses it

The brief says: *"Upstream has exactly two consumers of line extents:
`get_column`, used by external scanners, and error-cost-per-line, used by error
recovery. You need the first."*

I need neither, for TOML:

- `docs/scanner-vm.md` §1 records — and the nine `scanner.c` files confirm —
  that **no scanner in the roster calls `get_column`.** The VM therefore
  deliberately cannot express it: opcode `0x06` is reserved and traps.
- TOML's scanner specifically touches only `lookahead`, `advance`, `mark_end`
  and `result_symbol`. It does not even call `eof()`.
- The frozen trees carry **byte offsets only** (`start`/`end`), no row/column,
  so row/column state cannot move the acceptance bar in either direction.

So row/column tracking is **not load-bearing for toml 15/15**. I am still
implementing it, for two reasons that are not the brief's reason: upstream's
`ts_lexer__do_advance` maintains the extent unconditionally on every advance, so
a faithful port carries it anyway; and the error-recovery agent needs the
*interface* to exist. It is landing first and on its own commit so that merge is
cheap, but it should be understood as speculative for this slice rather than as
a dependency of it.

### 2. The scanner hazard for TOML is not character classification

`docs/host-ctype-divergence.md` warns that seven grammars call `isw*` from
libc. TOML is **not** one of them — its only character test is the literal pair
`' '` and `'\t'`, which the port carries as class 0 = `[\t\t, \x20\x20]`, sorted
code-point ranges with no libc and no locale. The hazard is real for the other
eight scanners and inert here.

## A real gap I found: the JS runtime has never read the artifact

This is the one worth acting on, because it is divergence-shaped in exactly the
way this route exists to prevent.

`docs/scanner-vm.md` §3 says: *"`spike/scanner-vm/rust/` decodes the same
`toml.svm` blob and replays the same traces. The project's central claim — one
data artifact, two runtimes, identical output — is demonstrated here rather than
asserted."*

Only half of that is true.

| Side | Reads                                        |
| ---- | -------------------------------------------- |
| Rust | `toml.svm`, via `main.rs::decode_program`    |
| JS   | the in-memory object from `toml.program.js`  |

`replay.js` calls `build()` and hands the resulting **JavaScript object** to
`ScannerVM`. There is no `.svm` decoder in JS anywhere in the repo —
`pack.js` has an `encode`, and no matching `decode`. So the two runtimes have
never executed the same bytes; they have executed one program expressed twice,
and the encoder sits on only one of the two paths.

Worse, `pack.js::encode` has **no caller in the repo at all**. The committed
165-byte `toml.svm` was produced by a command that was never checked in, so it
cannot currently be regenerated or verified against its source program.

Both holes are silent: an encoder bug, or drift between `toml.program.js` and
the committed `toml.svm`, would leave every one of the 45,678 replayed calls
green while Rust and JS ran different programs.

**Consequence for this slice:** the parser must drive the VM from the *packed
bytes*, not from `build()`. That means writing the missing JS decoder as the
mirror of `pack.js`, and a round-trip test pinning `encode(build()) ==
toml.svm`. Doing it any other way would add a third expression of the same
program and make the divergence surface bigger, not smaller.

## Plan, in landing order

1. **Row/column tracking in `ts_lr.mjs`** — narrow interface, own commit, first.
2. **JS `.svm` decoder + regeneration of `toml.svm` from a checked-in command**,
   closing the gap above.
3. **External-token interface**: `ts_transcode.py` stops refusing scanner
   grammars and emits `externalTokenCount`, `externalScannerSymbolMap`,
   `externalScannerStates`; `ts_lr.mjs` grows the `ts_parser__lex` external
   branch, `lastExternalToken` on stack heads, and the `canMerge` /
   token-cache external-state equality checks upstream has.
4. **serialize/deserialize** across GLR forks — VM-defined, per
   `docs/scanner-vm.md`. Note TOML serializes to **0 bytes**, so TOML alone
   cannot test this; see the honest-limits section when it is written.

## Remaining eight scanners

Not yet estimable — I have integrated none. Deferred until piece 3 lands.
