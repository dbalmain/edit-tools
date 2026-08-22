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

The stage-C slice consists of `packages/scheme.json`, this report and
`score.json`. `./test.sh` green.

## The number is 2/15, and it is the measurement this language exists to produce

`LANGUAGES.md` flagged Scheme as "the sharpest possible test" of node-type
dispatch and `FINDINGS` 10 repeated it. It is. **308 of the 320 branch nodes in
this corpus are `list`**, the grammar parses code as lists on purpose, and every
layout decision emacs makes keys off something inside the node rather than the
node's type. The package therefore has one rule for every form in the language,
and one uniform indent, and the interesting output is not the 2 — it is which
lines the uniform rule gets right and why the rest differ.

### File agreement is the wrong resolution for an indent-only reference

`indent-region` rewrites leading whitespace and nothing else, so a single wrong
column fails a whole file. Two files match exactly; a third (`nesting.scm`)
gets **every column right** and fails on whitespace *spelling*.

Stage D re-derived the line measure independently and found the original
`248/369` accounting was not reproducible: it counted a phantom terminal empty
record for every file and its numerators did not match the shipped package.
The corrected primary measure expands tabs to 8-column stops, compares physical
line positions where the two files have the same structure, and content-aligns
the one file (`comments.scm`) where the formatter removes two blank lines and
inserts one. Inserted output lines remain denominator slots, so the alignment
cannot flatter the result:

```
line agreement   246/355 = 69.3%      exact files 2/15
```

A literal line-number zip gives `238/354 = 67.2%`; its lower numerator is the
expected shift artefact in `comments.scm`. The original rounded percentage was
therefore right only by coincidence.

Per file, nonmatching lines after expanding tabs:

| File | wrong / total | File | wrong / total |
| --- | --- | --- | --- |
| `literals` | **0** / 28 | `macros` | 7 / 19 |
| `strings` | **0** / 16 | `bindings` | 10 / 28 |
| `nesting` | **0** / 11 (tab spelling only) | `control` | 11 / 37 |
| `define` | 1 / 18 | `kitchen` | 15 / 30 |
| `lambda` | 1 / 20 | `comments` | 15 / 36 aligned slots |
| `heads` | 2 / 16 | `long_sequences` | 34 / 41 |
| `quote` | 2 / 13 | `calls` | 6 / 22 |
| `normalisation` | 5 / 20 | | |

### The uniform indent was chosen by measurement, not by argument

Two uniform rules are expressible. `lisp-body-indent` (2 columns, what a
def-form's body gets) and the nil-property default when the first argument
starts a line (1 column past the open paren). Both were built and scored:

| Uniform rule | line agreement | exact files |
| --- | --- | --- |
| **+2, `lisp-body-indent`** | **246/355 = 69.3%** | **2** |
| +1, the nil-property default | 170/355 = 47.9% | 1 |

+2 wins because `define`, `let` and `lambda` bodies dominate real Scheme, and
the package ships it. Neither is right for the language; this is picking the
better of two wrong answers, which is what a node-type table can do here. A
literal physical-line zip (`238/354` versus `166/354`) reaches the same A/B
decision.

## Why the other thirteen files diverge

Five separate limits, in descending order of how many lines they cost.

### 1. The indent column depends on the head symbol — `FINDINGS` 10

Stage A found four distinct rules and all four apply to the same `list` node:
an exact property on the head symbol, a `def`-prefix rule, the cadr shape for
named `let`, and whether the first argument shares the head line. The package
sees `list` for all of them.

`heads.scm` is the two-line proof and it costs 2 lines of 16: `(cons a / b)`
and `(list a / b)` want a tab, `(let ((a 1)) / a)` wants 4, `(define (f x) / x)`
wants 2 — one node type, three columns.

**Scheme adds nothing new to the shape of entry 10; it adds the size of the
bill.** CSS's version was one node kind under two parents. Here it is the whole
language: with head dispatch the package would be a table of maybe twenty heads.
Stage D found one shape-specific quasiquote branch that could reach 3/15, but it
does not generalise the list rule and was rejected as a one-file special case.

### 2. The continuation column depends on source structure and the current column

This is the largest visible cluster of wrong lines, but Stage D found that its
count overlaps head dispatch and cannot honestly be subtracted from entry 10.
When the first argument starts on the next line, ordinary forms indent relative
to the open paren's *actual* column; when it shares the head line, continuations
align to the actual first-argument column. The IR's `indent` is relative to the
enclosing indent level and a rule cannot select an indent anchor from the source
line break.

`calls.scm` is the decisive case: the same `list` head wants column 8 when its
first argument shares the head line and column 3 when the argument starts the
next line, so a head table alone cannot solve it. `long_sequences.scm` is the
largest manifestation at 34 of 41 lines, but a head table could also hard-code
the two corpus heads (`+` and `list`), so those 34 lines are evidence for both
capabilities rather than an exclusive bill for this one.

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
`comments.scm` also contains opener-relative indentation and the `blank_cap`
trade described below; stage B built the `semis` block specifically so the
semicolon distinction could not hide. Nothing about that distinction is
expressible: the package never sees the comment.

### 4. Indentation is a column rendered as tabs-then-spaces

`indent-tabs-mode` is `t` in scheme-mode, so emacs writes column 8 as one tab
and column 9 as a tab plus a space. The runtime's indent is a repeated unit —
`indent` spaces, or one tab per level under `tab_indent`. gofmt is one tab per
level so Go's `tab_indent` matches it exactly; emacs's is a *rendering of a
column*, which neither setting can produce.

**`nesting.scm` is the clean demonstration and it is worth more than a passing
file:** every column in it is right, and it fails on nothing but the spelling.
A `tab_indent` that meant "render the final column as tabs to the nearest 8 then
spaces" would flip that file with no change to any rule. Stage D applied exactly
that leading-whitespace transform and confirmed byte identity.

### 5. Intra-line spacing is preserved by the reference and canonical in the IR

emacs rewrites leading whitespace only. `(define( packed x )( + x 1 ))` comes
back unchanged; we emit `(define (packed x) (+ x 1))`. A run of spaces before a
trailing comment is likewise preserved by emacs and collapsed to `comment_gap`
by us. Both are the linearity invariant working as designed — no opcode emits
arbitrary text — and `normalisation.scm` is where they are billed, 5 lines of
20. This is not a defect and it is not fixable without a whitespace-preserving
opcode, which would be a much worse trade than the 5 lines it buys.

## One chosen divergence: `quote.scm`

Stage D rejected the proposed `design limit` verdict for this file. A
package-only `child-count` branch can add one indent when the quasiquoted list
has no direct list child; that makes `quote.scm` exact and changes no other
corpus output. The branch is nevertheless a shape-specific rule firing in one
file, exactly the kind of score-chasing exception house style says not to add.
The accepted verdict is therefore **house rule**: uniform +2 is the deliberate
economy/consistency choice, not an IR impossibility.

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
nearest entry, but Stage D ruled that Scheme does **not** become its second
language. Entry 7 is a print-time choice between layouts based on why a group
broke. Scheme's condition is already known while the evaluator walks attached
comments: `srcsoft` needs to coalesce with a pending comment break. That is a
separate, cheaper capability (or a narrower correction to the source-break
opcodes), not width-versus-comment break provenance.

The workaround has a package-wide cost. A focused source-structure probe put an
own-line comment before a closer and, separately, an attached leading comment
with an intentional blank below it. At `blank_cap: 1` the closer blank grew on
pass two; at `blank_cap: 0` the output was idempotent but the intentional blank
after the other comment was deleted. The corpus already contains both symptoms
in `comments.scm`, but the combined probe establishes that they cannot be tuned
independently.

## What I would ask for, if one thing

**Source-line-sensitive current-column indentation** (`srcindent`, if that is
the chosen opcode) — limit 2 above. `calls.scm` proves it is distinct from entry
10, because the head is identical and only the source line structure changes.
It would move `calls`, `long_sequences` and part of `bindings`, but the bills
overlap: head dispatch could also hard-code the known heads in
`long_sequences`. Stage D also showed that `quote.scm` alone is package-
expressible with a `child-count` branch, so it is not evidence for this opcode.

## Template delta

**The stage-C brief needs a defined metric before asking a fixed, indent-only
language for line agreement.** Gate 4 is byte-identical per file, so its 2/15
does not distinguish "close" from "nowhere" here. An optional line measure is
useful, but the template must name a shared implementation or specify terminal
newline handling, tab expansion and insertion/deletion alignment. Asking each
builder for an ad-hoc loop recreates the measurement error Stage D found here.

**Second:** the brief says to test package-level workarounds at "one
adversarially narrow width". For a `fixed` language there is no other width, and
the equivalent check is a different axis: an adversarial *source line
structure*. Both destruction bugs above were found that way and neither would
have been found by varying the width.

The opcode-documentation drift is the same already-confirmed Ruby template
delta and is not a new Scheme finding.
