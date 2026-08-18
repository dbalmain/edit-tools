# Cell spike

Worktree `spike/cell-node`. The sketch was one `["cell"]` node. The shape
that holds Go at 12/16 is three pieces, and that is the finding, not a
failure.

## Shape

1. **`["cell"]`** — a column break. `print` emits a vertical tab (zero
   width). The package puts it where a column may break.
2. **`["cellblock", …]`** — a section. `print` emits a formfeed before and
   after the body. Inside a pair, the pass full-tabwrites every marked
   column. Outside, interior markers collapse to spaces and only a trailing
   comment cell participates.
3. **`comment_cells: true`** — trailing comments on *named* nodes become
   their own cell. Tokens (`}` / `)`) keep a one-space gap. Comments are
   runtime-attached; the package cannot write `["child", "comment"]`.

One language-independent pass then aligns contiguous same-indent runs over
markers: a shorter row terminates that column, an all-empty column is
discarded, a blank or unmarked line or indent change ends the run. A closer
whose first cell is `}` / `)` is excluded as a safety net.

`alignment: "go"` is gone, and so is the quote-aware scanner.

### Why not one node

`var_spec` / `const_spec` serve both `var (` groups and standalone
`var x = 1`. A rule cannot see its parent (FINDINGS 10). Always emitting
type/value cells over-aligns standalone names (`var first        = 1`).
Never emitting them drops grouped `=` alignment (iota, alignment.go).

The parent *can* wrap the grouped list. That is `cellblock`. Outside it,
the same spec rule is comment-column only — which is what gofmt does for
consecutive standalone `var`s.

So run semantics do **not** all fall out of cell placement. The algorithm
(tabwriter blocks, discard-empty, terminate-on-shorter, indent, blank)
does. The grouped-vs-standalone split has to be expressed, and comments
have to be opted in, because neither is visible where the package writes
cells.

## Results

### 1. Go agreement

|                    | main                         | cells                        |
| ------------------ | ---------------------------- | ---------------------------- |
| corpus             | 12/16                        | **12/16**                    |
| `--align-only`     | 10 / 4,814 (0.21%)           | **0 / 4,814 (0.00%)**        |
| full formatter     | (not the committed number)   | **297 / 1,291 (23.01%)**     |

The six alignment files still agree: `alignment`, `iota`, `kitchen`,
`nesting`, `strings`, `structs`. The other four are entries 2 and 10,
unchanged.

`--align-only` is now the wrong probe. gofmt output has no markers, so a
marker pass is a no-op by construction. That is a framing correction, not
a win: the 10/4,814 number cannot be reproduced for this shape.

Full formatter on the same 4,814: **3,523 refused, 1,291 compared, 297
mangled (23.01%)**. The refusals are missing node types
(`expression_statement`, short-var `if`, …), same as main — FINDINGS
already said the default probe is a different question from alignment.
Of a 16-file slice of the mangled set, 11 were byte-identical to main's
formatter (operator tightness, `struct{`, one-liners, composite-literal
columns we never aligned). One was a real cell regression — last spec's
comment stranded after the formfeed — and is fixed. Four are files main
*refuses* (typed `const` specs); we now consume `f:type` and format
them, with some extraTabs gaps (see policies). The 297 is not "we got
worse than 10"; it is the full formatter's known non-alignment
disagreements plus a handful of extraTabs misses on files main never
formatted.

### 2. Gzip

Against main's 13,923 B:

|                      | main    | cells   | Δ        |
| -------------------- | ------: | ------: | -------: |
| `runtime-js/bundle.js` | 13,923 B | 12,322 B | **−1,601 B** |
| `packages/go.json`   |  2,200 B |  2,314 B | +114 B   |

Removing the text pass subtracts the measured 2,593 B. The cell
machinery (Doc node, print markers, tabwriter, `cellblock`,
`comment_cells`, suffix-before-formfeed) adds about 992 B. **Net is
negative.** Say so plainly: this is cheaper than the mode it replaces.

### 3. Every other language

Re-scored, not read. **91/138** reference agreement, 0 stale, 0
unreviewed. Gates 0–3 are 138/138. Gate 1 (Rust/JS) is byte-identical.

Packages without `["cell"]` / `comment_cells` emit no markers; the pass
is a no-op.

### 4. Rust, sketched

rustfmt aligns trailing comments on **list items** only (FINDINGS 18).
With cells already in the runtime:

```json
"match_arm": ["seq", ["child", "pattern"], ["tok", "=>"], ["sp"],
              ["child", "body"], ["opt", "t:,", ["tok", ","]], ["cell"]],
"match_block": ["cellblock", ["use", "braced_list"]]
```

Do **not** set `comment_cells: true` on the package. That would align
statement comments, which rustfmt leaves alone. Put `["cell"]` only on
comma-terminated list items (and `{}` match arms). Wrap the list in
`cellblock` so a following `}` cannot join the column.

Runtime cost: **~0 B** — the pass is already there. Package cost: a
handful of `["cell"]` / `["cellblock"]` on array, tuple, call, and match
rules. The 270 B Rust lexer never exists.

What still does not fall out: rustfmt's width-dependent trigger
(FINDINGS 18). Cells will over-align some runs the 78 B "fits" rule of
the rust-mode prototype refused. Same ~76% of the reachable 1.4% of
files, unless someone later teaches the pass a cap. Do not build the
Rust package here.

### 5. Scheme, sketched

```json
"binding": ["seq", ["tok", "("], ["child", "name"], ["cell"],
            ["child", "value"], ["tok", ")"]],
"bindings": ["cellblock", ["indent", ["each", "t:binding", ["hard"]]]]
```

```scheme
(let ((a   1)
      (bcd 2))
  ...)
```

That is the generalisation: the package names the column, one pass pads
it. No Scheme lexer.

## Which gofmt policies fell out

| policy                         | where it lives                                      |
| ------------------------------ | --------------------------------------------------- |
| tabwriter column blocks        | the pass, for free                                  |
| `DiscardEmptyColumns`          | the pass, for free                                  |
| merged name lists (`r, w int`) | package: `each` names, then one `cell`              |
| struct tags                    | package: `cell` before `f:tag`                      |
| continuation lines             | no cells inside the expression; unmarked, for free  |
| block comments                 | no markers inside `/* */`; for free                 |
| group closers                  | tokens do not get `comment_cells`; closer exclude is a  safety net |
| `keepTypeColumn`               | package: empty type slot **when the spec has `=`**  |
| comment column                 | **`comment_cells` header** — not package placement  |
| grouped vs standalone specs    | **`cellblock`** — FINDINGS 10                       |
| extraTabs / comment slot       | **not fully**. Valueless rows omit empty slots, so a comment on `_EOF` and a comment on `_ token = iota` sit in different columns. Corpus does not see this. Typed-const files we newly format do. |

The 169 B `keepTypeColumn` function is gone. The package saying "always
leave a type cell if there is a value" is the same policy and is cheaper.
The 87 B extraTabs slot is the one that did not transfer cleanly; it is
also the one FINDINGS 1 said the corpus cannot see.

## What surprised me

- **One node is not enough**, and the reason is an entry we already have.
  The sketch assumed placement would imply run membership. Placement
  implies columns. Membership needs a parent-owned section because the
  child rule is shared.
- **`--align-only` dies with the scanner.** A marker pass cannot be
  tested on gofmt text. The committed probe is now blind. Propose:
  `--align-only` should go, or should run the full formatter and report
  refused/mangled separately. Do not treat 0/4,814 as agreement.
- **Net gzip is negative.** FINDINGS 1 said ~2,000 B is scanners the
  policies sit on. Deleting them and replacing the rest with a small
  tabwriter confirms it. 13% of the 25 KiB budget comes back.
- **Parity was cheap**, with one exception worth recording. The JS
  mirror of the pass is still mechanical. The exception is print-order:
  a `cellblock` formfeed must flush line suffixes first, or the last
  spec's comment lands after the section boundary and the tabwriter
  glues `1 << 1` to `// xV`. That is a printer invariant, not a
  policy, and both runtimes have to do it. Gate 1 caught it only after
  a GOROOT file showed it; the 16-file corpus did not.
- **Typed `const` specs were unconsumed on main.** Adding `opt f:type`
  for keepTypeColumn accidentally formats files the current package
  refuses. That is a package bugfix riding along, not a cell feature.

## Recommendation

**Land.**

It holds the only bar that matters (Go 12/16), it is cheaper than what
it replaces (−1,601 B runtime, +114 B `go.json`), and every other
language is byte-identical by re-score. The extra opcode and the header
are the honest price of FINDINGS 10 and runtime-owned comments. They
are not "a series of opcodes that costs more than the mode" — they cost
less, and they are the reason Scheme's `let` and rustfmt's list
comments can share a pass.

Land reduced (drop `cellblock`, keep only `cell`) fails alignment.go.
Decline is the wrong call: the scanners were the expensive part, and
they are gone.

### Proposed harness change (not done)

`harness/probe_alignment.py --align-only` should be retired or taught
to run the full formatter. A marker pass on gofmt text will always
print 0/4,814.
