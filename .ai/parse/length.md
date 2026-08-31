# Porting recovery onto `Length`, and merging the scanner slice

Branch `wt/parse-length`, cut from `main` at `84f47ff` — the parse-rust merge,
one commit past the `5ce9924` that `.ai/parse/merge-scanner-into-main.md`
names. That note is otherwise accurate. This is the done-note for the merge it
was written to make possible.

## Verdict on the recommended order: right, and by a wide margin

The note said convert recovery to `Length` first, then merge, and that the
merge would then be "nearly textual". That is what happened:

| Attempt | Conflicts in `ts_lr.mjs` | Outcome |
| ------- | ------------------------ | ------- |
| the note's two hand-merges | 8 | backed out, `json --edited` hung |
| this session, port first then merge | 4 (+1 in the test file) | green first try |

Four of the five were a plain union of one recovery field and one scanner
field. All of the type-seam work happened in the first stage, where the gate is
44 broken-input fixtures rather than a merge diff, so every mistake surfaced as
a named failing fixture instead of a hang.

**One correction to the recipe.** The note says cherry-pick `cc77079`. Do that,
but then record it as merged before merging the branch:

```sh
git merge -s ours --no-ff cc77079   # tree unchanged; it is already applied
git merge wt/parse-scanner
```

Without that second line the merge base is still `51231a7`, so git re-conflicts
every hunk of `cc77079` that the scanner slice's later commits also touched:
**17 conflicts instead of 5**. That is most of the difference between the
note's experience and this one, and it has nothing to do with the type seam.

## The seam sites

The note's four were all necessary and all correct as described. There was a
fifth, and it is the one that hung:

5. **`insertMissingToken` seeks the lexer with a byte count.**
   `this.lexer.reset(position)`, where `position = stack.position(version)`.
   After the port `reset` reads `position.bytes`, so it got `undefined`, wrote
   `undefined` into `lexer.pos` / `row` / `column`, and the following
   `markEnd()` set `tokenEnd = undefined` — making the inserted MISSING leaf's
   padding `NaN`. Fixed by seeking with `stack.positionLength(version)` and
   taking the padding as `lengthSub(lexer.tokenEndPosition(), positionLength)`.

**Why the note's grep could not have found it.** The suggested search — every
`-`, `+`, `===`, `<`, `>` whose operands are `position`, `padding`, `size`,
`tokenStart`, `startPosition` — looks for arithmetic. This site is an
*argument pass*. The seam runs through the signatures of the functions whose
parameter types changed as much as through operators, and that set is short and
enumerable: `newLeaf` (padding, size), `Lexer.reset`, `Lexer.gotoPos`. Grep
their call sites and check each argument's provenance. That is the other half
of the search, and it is the half that finds the hangs: a `NaN` from bad
arithmetic still flows through comparisons, whereas an `undefined` written into
`lexer.pos` derails the lexer loop directly.

Both mechanical traps the note records are real. The 3-way boundary cuts
mid-body in `ts_lr.test.mjs` on *both* sides — the union needs a `});` appended
to recovery's last test and a fresh `// ---` box opener before the row/column
section. In `ts_lr.mjs` the paused-version conflict also cuts a method, but
taking recovery's side entire happens to balance, because the three
post-conflict braces close `else`, `for`, and recovery's own
`if (stack.versionCount > 0)` wrapper.

## The one judgement call in the merge itself

`ts_stack_has_advanced_since_error` is new in the scanner slice and reads
`subtree.errorCost`. Upstream reads `ts_subtree_error_cost`. The difference is
exactly recovery's defect 1, in a site recovery never saw: a MISSING leaf
accumulates no cost of its own and is expensive anyway, so the raw field makes
an inserted token look free and the empty-external-token guard walks past it.
Merged as `subtreeErrorCost(subtree) === 0`, per the note's row 6.

No fixture distinguishes the two — TOML's scanner never returns an empty token
in a version that is already in error — so this rests on upstream fidelity, not
on a measurement.

## What the merged interpreter does and does not do

Does: clean full parses, error recovery, external scanners through the bytecode
VM, and row/column tracking including `get_column` with its cold-cache re-walk.
34/34 clean across json, scheme and go; 44/44 broken across the same three;
toml 15/15 through the VM.

Does not: incremental reparse (no entry point at all — nowhere to pass an old
tree), repeat rebalancing (skipped at parser completion, cannot change the
visible tree by construction), and a scanner with no packed program, which
still throws.

Implemented but exercised by nothing: `get_column`. No scanner in the pinned
roster calls it and the VM traps its opcode. It exists so that a scanner which
did call it would diverge loudly rather than silently. Its evidence is four
unit tests and nothing else.

## `rowsIn` is gone

Recovery predated extents, so its three per-line cost terms counted `\n` bytes
in the source buffer, and `buf` and `startByte` were threaded through
`newNode`, `newErrorNode` and `summarizeChildren` for no other purpose. The
code carried a TODO saying to undo that when row/column landed. It has landed,
so the three terms are now what upstream writes:

- the ERROR wrapper's own cost reads `self.sizeRow` (`size.extent.row`);
- the summary walk reads a row difference between two stack positions, so the
  stack summary keeps whole `Length`s rather than byte offsets;
- the skip cost reads `lookahead.totalSizeLength.row`.

**Which of the three the corpus actually checks**, by mutation:

| term zeroed | result |
| ----------- | ------ |
| ERROR wrapper (`self.sizeRow`) | json `--edited` fails |
| summary walk (row difference) | scheme `--edited` fails |
| skip cost (`lookahead.totalSizeLength.row`) | **all 44 still pass** |

Two of the three are load-bearing on the broken-input corpus; the third is not,
because no fixture's cost ordering is close enough to flip on it. Recorded
because "44/44 green" would otherwise read as evidence for all three.

## Two things that looked wrong; one fixed

**Fixed.** `test_ts_transcode.py`'s `InterpreterSuiteTest` shelled out to
`node --test harness/ts_lr.test.mjs` and asserted only `returncode == 0`.
`node --test` exits 0 on a file it collected no tests from, so if that suite
ever stopped being collected — a rename, a syntax error inside a dynamic
import, a stray name filter — the gate would read green forever. It now parses
`pass N` out of the reporter and asserts a floor of 19. Verified as a real
gate: raising the floor to 999 fails, restoring it passes.

That floor is why the test count is worth stating. `ts_lr.test.mjs` is 19 tests
= 6 base + 4 recovery + 6 row/column + 3 scanner, and none was lost to the
mid-body conflict cut. `./test.sh` still reports 126 harness tests, because the
whole node suite counts as one of those 126.

**Not fixed, flagged.** `newError` — the ERROR *leaf* the lexer emits, not the
recovery wrapper — calls `newLeaf` with seven arguments, so `dependsOnColumn`
arrives `undefined` and is coerced to `false`. That is correct today, since the
skip loop runs the internal DFA and never consults the codepoint column, but it
is correct by accident rather than by statement, and it is the same shape as
seam site 5. Worth an explicit `false` if anyone touches that function.

## Acceptance, measured on this branch

- `json` 3/3, `scheme` 15/15, `go` 16/16
- `json --edited` 12/12, `scheme --edited` 16/16, `go --edited` 16/16 = 44/44
- `toml` 15/15 with `--scanner spike/scanner-vm/toml.svm`
- `./test.sh`: 126 harness tests, Rust 8 / 116 / 116 / 22 / 27

Blobs are not vendored. To reproduce:

```sh
./harness/ts_transcode.py /tmp/vsrc/tree_sitter_go-0.25.0/src/parser.c -o /tmp/go.json
./harness/ts_transcode.py /tmp/vsrc/tree_sitter_json-0.24.8/src/parser.c -o /tmp/json.json
./harness/ts_transcode.py /tmp/vsrc/g/tree_sitter_toml-0.7.0/src/parser.c \
  --scanner spike/scanner-vm/toml.svm -o /tmp/toml.json
```

Scheme's `parser.c` is in no sdist; fetch it from
`raw.githubusercontent.com/6cdh/tree-sitter-scheme/9338837/src/parser.c` and
transcode that.
