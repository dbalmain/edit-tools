# Scheme package report (stage C)

**Builder:** Claude (Opus 5), orchestrator session.

```
gate 1 idempotence      pass    (15/15 scheme; 235/235 corpus-wide)
gate 2 width            waived  reference_width = "fixed"; 0 overflow lines either side
gate 3 non-destruction  pass    (method: default, plus comment_kinds from the manifest)
gate 4 agreement        2/15 @80   (literals.scm, strings.scm)
rust/js parity          identical
refusals                none
size                    package 447 B gzip; runtime 13610 B gzip; delta vs main 0 B
```

No edit outside `packages/scheme.json` and this report. `./test.sh` green.

## The number is 2/15, and it is the measurement this language exists to produce


`LANGUAGES.md` flagged Scheme as "the sharpest possible test" of node-type
dispatch and `FINDINGS` 10 repeated it. It is. **308 of the 320 branch nodes in
this corpus are `list`**, the grammar parses code as lists on purpose, and every
layout decision emacs makes keys off something inside the node rather than the
node's type. The package therefore has one rule for every form in the language,
and one uniform indent, and the interesting output is not the 2 — it is which
lines the uniform rule gets right and why the rest are unreachable.

### File agreement is the wrong resolution for an indent-only reference

`indent-region` rewrites leading whitespace and nothing else, so a single wrong
column fails a whole file. Two files match exactly; a third (`nesting.scm`)
gets **every column right** and fails on whitespace *spelling*. Measured at line
resolution, with tabs expanded to 8-column stops:

```
line agreement   248/369 = 67.2%      exact files 2/15
```

Per file, lines whose column is wrong after expanding tabs:

| File | wrong / total | File | wrong / total |
| --- | --- | --- | --- |
| `literals` | **0** / 12 | `macros` | 7 / 20 |
| `strings` | **0** / 16 | `bindings` | 10 / 29 |
| `nesting` | **0** / 21 (tab spelling only) | `control` | 13 / 38 |
| `define` | 1 / 19 | `kitchen` | 17 / 31 |
| `lambda` | 1 / 21 | `comments` | 23 / 36 |
| `heads` | 2 / 17 | `long_sequences` | 34 / 42 |
| `quote` | 2 / 14 | `calls` | 6 / 23 |
| `normalisation` | 5 / 21 | | |

### The uniform indent was chosen by measurement, not by argument

Two uniform rules are expressible. `lisp-body-indent` (2 columns, what a
def-form's body gets) and the nil-property default when the first argument
starts a line (1 column past the open paren). Both were built and scored:

| Uniform rule | line agreement | exact files |
| --- | --- | --- |
| **+2, `lisp-body-indent`** | **248/369 = 67.2%** | **2** |
| +1, the nil-property default | 169/369 = 45.8% | 1 |

+2 wins because `define`, `let` and `lambda` bodies dominate real Scheme, and
the package ships it. Neither is right for the language; this is picking the
better of two wrong answers, which is what a node-type table can do here.

## Why the other five sixths are unreachable

Five separate limits, in descending order of how many lines they cost.

### 1. The indent column depends on the head symbol — `FINDINGS` 10

Stage A found four distinct rules and all four apply to the same `list` node:
an exact property on the head symbol, a `def`-prefix rule, the cadr shape for
named `let`, and whether the first argument shares the head line. The package
sees `list` for all of them.

`heads.scm` is the two-line proof and it costs 2 lines of 17: `(cons a / b)`
and `(list a / b)` want a tab, `(let ((a 1)) / a)` wants 4, `(define (f x) / x)`
wants 2 — one node type, three columns.

**Scheme adds nothing new to the argument for entry 10; it adds the size of the
bill.** CSS's version was one node kind under two parents. Here it is the whole
language: with head dispatch the package would be a table of maybe twenty heads,
and without it there is no second-best that reaches 3/15.

### 2. The continuation column is relative to the paren, not the indent level

This is the single largest cause of wrong lines and it is **not** head dispatch.
For a form whose first argument starts the next line, emacs indents every
continuation to **one column past the open paren** — the paren's *actual*
column, wherever the form happens to start. The IR's `indent` is relative to
the enclosing indent level. When a form begins at the current indent the two
coincide; when anything shifts it — a quote mark, a form that starts mid-line,
a deeper nest — they differ by exactly that shift.

`quote.scm` is the smallest case: a `` ` `` before the paren moves the column by
one and every continuation line under it is one column out. `long_sequences.scm`
is the largest: 34 of 42 lines, almost all of them this.

The runtime already exposes the source's line structure to *breaks* —
`srcline`, `srcsoft`, `srcbreak` — which is exactly the information this needs,
and exposes nothing equivalent to *indent*. **There is no `srcindent`.** That
is the precise shape of the missing capability, and it is worth separating from
entry 1 (sibling-width alignment): entry 1 asks for a column computed from a
sibling's rendered width, which is expensive; this asks for the column a
delimiter already occupies, which the printer knows when it emits it.

### 3. Own-line comments are placed by semicolon count — `FINDINGS` 9

`;` goes to `comment-column` (40), `;;` to the code indent, `;;;` to column 0,
at every depth. The runtime places every attached comment at the code indent,
so the package gets `;;` right and the other two wrong wherever they appear.
`comments.scm` costs 23 lines of 36, and stage B built the `semis` block
specifically so this could not hide. Nothing about it is expressible: the
package never sees the comment.

### 4. Indentation is a column rendered as tabs-then-spaces

`indent-tabs-mode` is `t` in scheme-mode, so emacs writes column 8 as one tab
and column 9 as a tab plus a space. The runtime's indent is a repeated unit —
`indent` spaces, or one tab per level under `tab_indent`. gofmt is one tab per
level so Go's `tab_indent` matches it exactly; emacs's is a *rendering of a
column*, which neither setting can produce.

**`nesting.scm` is the clean demonstration and it is worth more than a passing
file:** every column in it is right, and it fails on nothing but the spelling.
A `tab_indent` that meant "render the final column as tabs to the nearest 8 then
spaces" would flip that file with no change to any rule.

### 5. Intra-line spacing is preserved by the reference and canonical in the IR

emacs rewrites leading whitespace only. `(define( packed x )( + x 1 ))` comes
back unchanged; we emit `(define (packed x) (+ x 1))`. A run of spaces before a
trailing comment is likewise preserved by emacs and collapsed to `comment_gap`
by us. Both are the linearity invariant working as designed — no opcode emits
arbitrary text — and `normalisation.scm` is where they are billed, 5 lines of
21. This is not a defect and it is not fixable without a whitespace-preserving
opcode, which would be a much worse trade than the 5 lines it buys.

## The two gate failures on the way, because both were destruction

Neither was visible by reading the output.

**Leaving `comments` undeclared commented out a closing paren.** With comment
nodes treated as ordinary children — which is what they are in this grammar,
`extras: []` — a `;` comment that ends a line was followed by the form's `)` on
the same line: `(+ a b) ; trailing on a body form)`. Gate 3 caught it as
"output does not parse". Declaring `comments: ["comment", "block_comment"]`
hands them to the runtime, which defers a suffix comment past the closer.

**Pulling the closer onto the previous line moved a comment between nodes.**
The obvious fix for a second problem was to let `)` follow the last form
directly. That produces `(+ a b)) ; trailing`, which parses, keeps every
comment, and still fails gate 3: the comment leaves the `define` and becomes a
child of `program`, so `program` has 15 named children where the source had 14.
**The comment survived and the tree did not**, and only the ordered structural
comparison sees the difference. This is the strongest argument I have seen for
gate 3 comparing structure rather than just token content.

## `blank_cap: 0` is a workaround, and here is what it works around

A form whose `)` sits on its own line needs `srcsoft` before the closer to keep
it there. When the last thing before that closer is an own-line comment, **two
breaks are emitted for one line ending**: the package's `srcsoft`, and the
runtime's own flush of the pending comment, which prepends its own `Hard`. That
produces one blank line — and the blank is then in the source on the next pass,
so `blank_cap` preserves it and a second appears. It grows by a line per pass
and fails idempotence.

`blank_cap: 0` pins it: the spurious blank stays at exactly one and the output
is stable. That is a workaround for a real gap, and the gap is that **a rule
cannot tell that a comment is pending at the cursor**. `FINDINGS` 7 is the
nearest entry — a rule cannot tell a comment-forced break from a width-forced
one — and this is the same blindness one step earlier: not why the break
happened, but whether one is about to be emitted for me. Entry 7 currently has
one language and says "decide when a second language genuinely hits it". Stage D
should rule on whether this counts as that second language or wants its own
entry; I have deliberately not decided it here.

## What I would ask for, if one thing

**`srcindent`** — limit 2 above. It is the largest single cause, it is not
entry 10, and unlike head dispatch it is a small, local capability the printer
already has the information for. Head dispatch is the bigger prize and the much
bigger build; this one would move `long_sequences`, `quote`, `calls` and part of
`bindings` without touching the dispatch question at all.

## Template delta

**The stage-C brief's gate list assumes a reflowing reference and gives a
`fixed`-width language nothing to aim at.** Gate 4 is "byte-identical to the
reference, per corpus file, floor 70% of files" — for an indent-only reference a
single wrong column fails the file, so the floor is unreachable for reasons that
have nothing to do with package quality, and the number it produces (2/15) does
not distinguish "the package is close" from "the package is nowhere". The brief
should tell a `reference_width = "fixed"` builder to report **line-level
agreement as well**, and say that file agreement is expected to be low. Go is
the only other `fixed` language and its reference is a full formatter, so this
has not bitten before.

**Second:** the brief says to test package-level workarounds at "one
adversarially narrow width". For a `fixed` language there is no other width, and
the equivalent check is a different axis: an adversarial *source line
structure*. Both destruction bugs above were found that way and neither would
have been found by varying the width.

**Third, and the same one Ruby's report raises:** `DESIGN.md` does not document
`srcline`, `srcsoft`, `srcbreak`, `srctrail`, `drop`, `cell` or `cellblock`.
This package is built almost entirely out of `srcline` and `srcsoft`. A builder
who reads what the brief points at cannot discover the opcodes this language
needs most.
