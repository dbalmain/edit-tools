# Porting recovery onto the `Length` representation

Working note, updated as the work proceeds. Branch `wt/parse-length`, cut from
`main` at `84f47ff` (the parse-rust merge, one commit past the `5ce9924` that
`merge-scanner-into-main.md` names — that note is otherwise accurate).

## Baseline, measured on the fresh worktree before any change

- `json` 3/3, `scheme` 15/15, `go` 16/16 (clean)
- `json --edited` 12/12, `scheme --edited` 16/16, `go --edited` 16/16 = **44/44**
- `./test.sh`: 126 harness tests, Rust 8 / 116 / 116 / 22 / 27
- blobs re-transcoded into `/tmp/lenwork/`; scheme's `parser.c` fetched from
  `raw.githubusercontent.com/6cdh/tree-sitter-scheme/9338837/src/parser.c`

## Plan

Per `merge-scanner-into-main.md`: cherry-pick `cc77079` (row/column `Length`
plumbing, landed in isolation on `wt/parse-scanner` for exactly this), fix the
recovery fallout with `--edited` as the gate, then merge the rest of the
scanner branch.

## Log

- (in progress)

### The cherry-pick of `cc77079`

Four conflicts in `ts_lr.mjs` (not eight — the full merge's other four come from
the scanner slice's later commits) and one in `ts_lr.test.mjs`:

- two header-prose hunks: rewritten so row/column is no longer listed as
  unimplemented, and recovery is named as the reason `rowsIn` exists;
- `StackNode` ctor: union — `subtreeErrorCost(subtree)` and
  `lengthAdd(this.position, subtree.totalSizeLength)`;
- paused-version handling: take recovery's resume wholesale. The note's
  "cuts a method mid-body" trap is real here, but taking HEAD entire happens to
  balance: HEAD's block ends inside the `else`, and the three post-conflict
  braces close `else`, `for` and the `if (stack.versionCount > 0)` wrapper.
- the test-file conflict *is* the mid-body cut, both sides. Union needs a `});`
  appended to recovery's last test and a fresh `// ---` box opener before the
  row/column section.

### The seam sites

The note's four, all confirmed necessary, plus **a fifth it had not found** —
which is almost certainly why `json --edited` still hung:

5. `insertMissingToken` does `this.lexer.reset(position)` with
   `position = stack.position(version)`, a **byte count**. After the port
   `reset` reads `position.bytes`, so it got `undefined`, wrote `undefined`
   into `lexer.pos/row/column`, and `markEnd` then set `tokenEnd = undefined`,
   making the missing leaf's padding `NaN`. Fixed by seeking with
   `stack.positionLength(version)` and taking the padding as
   `lengthSub(lexer.tokenEndPosition(), positionLength)`.

Note the shape: this is not an arithmetic site, so the note's grep for
`- + === < >` around `position`/`padding`/`size` would never have found it. The
seam runs through **argument passing** as well as arithmetic; the set of
functions whose parameter type changed (`newLeaf`, `Lexer.reset`,
`Lexer.gotoPos`) is the other half of the search.

Gate after the five: json 3/3 + 12/12, scheme 15/15 + 16/16, go 16/16 + 16/16
= 44/44, and 16 unit tests in `ts_lr.test.mjs`.
