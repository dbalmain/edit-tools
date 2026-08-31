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
