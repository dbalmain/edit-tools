# Go package report (stage C)

```
gate 1 idempotence      pass   (16/16)
gate 2 width            waived (reference_width = "fixed"; 6 overflow lines at measurement width 80)
gate 3 non-destruction  pass   (16/16, method default)
gate 4 agreement        6/16 @80
rust/js parity          identical (16/16)
refusals                none
review                  10 accepted, 0 stale, 0 unreviewed
alignment fraction      6/10 remaining divergences (60%); 6/16 corpus files (37.5%)
size                    package 2190 B gzip; runtime 9855 B gzip
```

## Agreement

6/16 raw, all at the single measurement width. The matching files are
`comments.go`, `composite_literals.go`, `control_flow.go`, `imports.go`,
`interfaces.go`, `long_sequences.go`.

The previous cut-off left `functions`, `imports` and `long_sequences` matching
and `packages/go.json` untracked. This run verified those three still match
after the CSS merge, then:

- **fixed** comments.go (runtime), plus package bugs on generics (type-only
  params, type-set `|` spacing) and structs (empty `struct{}`, compact
  one-field). functions.go *regressed* by one space when the one-field struct
  rule started mirroring compact form — see below.
- **classified** the remaining ten. None unreviewed.

Do not read `imports.go` as import-sorting coverage. gofmt sorts import specs;
gate 3 correctly rejects sibling reordering; the file is pre-sorted. That is
FINDINGS entry 4.

## Alignment fraction

**6 of the 10 divergences (60%) are alignment and nothing else.** They are
`alignment.go`, `iota.go`, `kitchen.go`, `nesting.go`, `strings.go`,
`structs.go`. Each was checked hunk-by-hunk against the reference; the
non-alignment bits on `structs.go` (empty `struct{}`, compact
`struct{ left, right int }`) were package bugs and are gone.

That is 6/16 corpus files (37.5%), which matches stage B's GOROOT-proxy
estimate that declining alignment costs about 40–45% of real Go files. The
corpus number is sharper than the proxy: every one of those six is *only*
alignment.

The other 4/10 (40%) are not alignment in costume:

| file | what it actually is |
| --- | --- |
| `operators.go` | mixed-precedence tightness (FINDINGS entry 2) |
| `generics.go` | tightness inside `[]`, plus one-field `struct{` vs `struct {` |
| `functions.go` | only the one-field `struct{` space |
| `normalisation.go` | tightness, if-condition parens, nested parens, semicolons |

## Divergences

Every remaining pair is a design limit. Hashes are the current content hashes.

| case | hash | classification | why |
| --- | --- | --- | --- |
| `alignment.go@80` | `b085d4b3e06c7659…7b81` | design limit | FINDINGS entry 1. Every hunk is sibling-width padding. |
| `functions.go@80` | `958037a1f6899ddf…f770` | design limit | One-field broken struct wants `struct {`; compact wants `struct{`. No opcode emits a space only when the body is source-broken. |
| `generics.go@80` | `cc9fba87b174fb39…e3db` | design limit | Same `struct{` space, plus `len(s.items)-1` tight inside `[]` (entry 2). Type-only params and `\|` spacing were fixed. |
| `iota.go@80` | `ee6bcbe46be4a0ba…d992` | design limit | FINDINGS entry 1. Only `_` padded to align with `KB`. |
| `kitchen.go@80` | `fccf785fbbbc2cc8…d366` | design limit | FINDINGS entry 1. Only `ID` padded to `Name`/`Tags`. |
| `nesting.go@80` | `8e917efb845f87a7…88f2` | design limit | FINDINGS entry 1. Only `Value` padded to `Children`. |
| `normalisation.go@80` | `0886f6692102fe6f…b1af` | design limit | Tightness (entry 2); if-condition and nested parens need ancestor context plus token deletion; semicolons need consume-without-emit. `srctrail ";"` strips mid-line semis but *inserts* them between later line-broken decls and fails idempotence. |
| `operators.go@80` | `66f14ae6711f2297…133e` | design limit | FINDINGS entry 2. gofmt spaces the loosest operators and writes tighter ones flush. flatten cannot change a tighter child's spacing. |
| `strings.go@80` | `1b9f6de4fe1ece5a…bce1` | design limit | FINDINGS entry 1. Only Model field/tag padding. |
| `structs.go@80` | `ef65966baa536da5…be4a3` | design limit | FINDINGS entry 1. Only field/tag alignment; empty and compact forms now match. |

## Runtime edits

Three commits, each measured as gzip of `runtime-js/bundle.js`. Isolated by
building with one, then both, then the attachment fix.

| commit | construct | gzip Δ | case |
| --- | --- | --- | --- |
| `0d5163e` tab indentation | gofmt tabs | **+39 B** (9165 → 9204) | House-style constant hardcoded where no package could reach it. Same class as `comment_gap`/`blank_cap` (ledger row 1). `Doc::Indent` now carries the resolved unit string so nested language regions concatenate their own. |
| `cdf012d` source-mirroring breaks | composite literals, arg/param lists | **+321 B** (9204 → 9525) | gofmt preserves the author's single-line vs broken decision and never reflows. Tried a fit-driven `group` first: it collapses a hand-broken list that still fits and splits a long single-line one — the opposite of gofmt. A package expression cannot inspect source line structure. `srcline`/`srcsoft`/`srctrail` are the opcodes that can. |
| `93338c9` own-line comments after trailing trivia | comment before `}` | **+180 B** (9675 → 9855) | tree-sitter-go's `statement_list` range includes the newline after the last statement, so an own-line comment before `}` looks adjacent if suffix detection uses `node.end`. A comment is a suffix only when it shares a line with the previous item's last child. Runtime bug exposed by Go, not a Go feature. `comments.go` now matches. |

The two edits that arrived as `efcf55b` were split: they are separable (tab
changes `Doc::Indent` and the printer; source-mirroring adds three opcodes and
`line_break` on `Item`). They are not inseparable.

They are genuinely both needed. Tab indent is the house-style constant. Source
mirroring is the construct that forced new opcodes: gofmt's line structure is
source-driven, not width-driven, and no composition of `group`/`line`/`soft`
reproduces "keep this list broken because the source was broken".

## `fill`

Go does **not** want `fill`. gofmt has no width and does not reflow; a
166-character call stays on one line. No corpus file would move if `fill`
landed. That is a data point against treating `fill` as universally demanded
just because CSS (and JSON) want it. Named files that would *not* be helped:
all sixteen.

## Cross-language

A runtime edit is charged to every language. After all three Go edits, the
already-merged languages still contribute what they did on `main`:

| language | agreement | accepted | unreviewed |
| --- | --- | --- | --- |
| json | 4/6 | 0 | 2 (pre-existing) |
| python | 20/24 | 0 | 4 (pre-existing) |
| toml | 23/30 | 7 | 0 |
| css | 11/30 | 19 | 0 |

58/90 non-Go, same as `main`.

## What was hardest

gofmt's line structure is source-driven and its operator spacing is
ancestor-driven. The first is now in the IR (`srcline`/`srcsoft`/`srctrail`).
The second is FINDINGS entry 2, paid for here with `operators.go`, the
index/slice forms in `generics.go`, and the mixed `+`/`*` in
`normalisation.go`. Alignment (entry 1) is the larger ceiling.

If I could ask for one thing it would **not** be `fill`. It would be a
consume-without-emit / skip for redundant parens and statement semicolons —
or exposing `ifBreak` so a one-field struct can write `struct{` when flat and
`struct {` when broken. I did not add either: one file (or two) is the
house-style bad trade.

## What the previous run got wrong

- Combined tab indent and source-mirroring in one commit, so the ledger
  attribution column would have been useless. Split, with separate gzip
  numbers.
- Left `packages/go.json` untracked. Committed at the first green boundary
  this run, then again at each later one.
- Type-only `parameter_declaration` prefixed a space (`( T,  bool)`).
- `type_elem` had no space before `\|`.
- Empty and one-field structs always used the broken form.
- The own-line-before-`}` comment was a runtime suffix bug, not a package
  rule.

It did **not** mislabel ordinary bugs as alignment. `iota.go` really is only
`_` padding; `kitchen.go` / `nesting.go` / `strings.go` really are only field
columns. The four non-alignment files were sitting in the unreviewed list
wearing their own names.

## Harness edits

None outside `harness/languages/go.toml` (already on the branch from stage A)
and `harness/reviews/formatter/go.jsonl` (the ledger this report classifies).

## Template delta

`srctrail` looks like consume-without-emit. It is not: when the next item is
source-broken it *inserts* the separator if the source has none. Using it to
strip Go statement semicolons made every later top-level decl grow a `;` and
failed idempotence. The brief should say that `srctrail` is a trailing-separator
policy, not a skip.
