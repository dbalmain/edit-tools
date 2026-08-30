# C3's lexer question, settled: `ts_lex` recovers as data

`docs/parse-layer.md` names one unverified step in route C3:

> The unverified step is the lexer: tree-sitter emits `ts_lex` as generated C
> _code_ — a switch-based DFA — not as a table, so it must either be recovered
> from that code or regenerated from `grammar.json`'s token rules. C3 is a
> sketch, not a measurement, and the lexer question is the thing to settle
> before it is a plan.

It is settled, in the direction the hypothesis predicted. `ts_lex` recovers from
the generated C mechanically and completely, and a table-driven parser
interpreting the recovered blob reproduces the frozen corpus **byte for byte**:

| Language                  | Corpus files | Result                   |
| ------------------------- | -----------: | ------------------------ |
| tree-sitter-json 0.24.8   |            3 | **3/3 byte-identical**   |
| tree-sitter-scheme 0.24.7-1 |         15 | **15/15 byte-identical** |
| tree-sitter-go 0.25.0     |           16 | **16/16 byte-identical** |

Three grammars, 34 files, two ABI versions (json and scheme are ABI 14, go is
ABI 15). Scheme was added after a review suggested it and is **a third
scanner-free grammar**: `EXTERNAL_TOKEN_COUNT 0` and no `scanner.c` at the
pinned commit `9338837`. `docs/parse-layer.md` says "Only JSON and Go do not"
have a scanner; that table predates scheme's onboarding, and the count is at
least three of sixteen.

Byte-identical means the bytes of `corpus/trees/<lang>__<stem>.tree.json`, not a
normalised comparison: `json.dumps(indent=1, ensure_ascii=False)` and
`JSON.stringify(x, null, 1)` agree on this shape, which was checked before
anything else was built.

Reproduce:

```sh
# fetch a pinned grammar's parser.c (see "Getting parser.c" below)
./harness/ts_transcode.py path/to/parser.c -o /tmp/json.blob.json
./harness/ts_check_trees.mjs /tmp/json.blob.json json
```

**This document's most important section is
[What this does not verify](#what-this-does-not-verify).** A green corpus here
is evidence about clean full parses of thirty-four files and nothing else.

## What was built

All harness, none of it on any shipped path.

| File                           | What it is                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `harness/ts_transcode.py`      | `parser.c` → one JSON blob: every static table, plus the lex DFA recovered from code |
| `harness/ts_lr.mjs`            | the parser: GLR stack, table-driven parse loop, subtree summarisation, node API      |
| `harness/ts_check_trees.mjs`   | the acceptance bar — parse the corpus sources, compare bytes                         |
| `harness/ts_differential.py`   | the wider oracle — compare against real tree-sitter over arbitrary source            |
| `harness/ts_mutation_sweep.py` | how much of the blob the corpus actually exercises                                   |
| `harness/test_ts_transcode.py` | 24 unit tests over the recoverer and its interval algebra                            |
| `harness/ts_lr.test.mjs`       | 6 unit tests over the lexer, shelled out to by the Python suite                      |

The two test files reach `./test.sh` through
`python3 -m unittest discover -s harness`, which it already runs — the Python
suite shells out to `node --test`, so neither needed an edit to `test.sh`, a
file four other tracks are also touching.

`ts_lr.mjs` is a port of tree-sitter 0.26.0's `lib/src`, which is the version
that produced the frozen corpus — confirmed by regenerating the corpus with the
current toolchain and getting a clean `git status`.

## The lexer, which was the whole question

`ts_lex` is a `switch` over lexer states. Each `case N:` is a DFA state whose
body is an ordered sequence of guarded transitions, and every guard is a boolean
expression over exactly two things: the `eof` flag and the `lookahead`
codepoint. Both are cheap to model as data — `eof` is one bit, and a predicate
over an int32 is a set of intervals. So a recovered state is an ordered op list:

```
[0, sym]                             ACCEPT_TOKEN(sym)
[1, [char, target, ...]]             ADVANCE_MAP(...)
[2, eofMode, ranges, act, target]    if (<cond>) <action>
[3, act, target]                     unconditional <action>
[4, ranges, eofRanges, act, target]  if (<cond>) <action>, eof-split
```

Two decisions in there are load-bearing.

**The domain is the whole int32 line, not the Unicode range.** `lookahead` is 0
at EOF and `-1` (`TS_DECODE_ERROR`) on invalid UTF-8, so `lookahead != 0` is
true for the decode-error value. Complementing over `[0, 0x10FFFF]` would
silently disagree with C on malformed input — input the corpus does not contain.

**Guards are recovered as branch predicates, not as token character sets.** This
sidesteps the trap `docs/parse-survey.md` §3d names: when a positive character
set contains `char::MAX`, the generator negates the set and emits it in negative
form, so a recoverer that reads `&&`-joined `!=` atoms as exclusions inverts the
meaning of every such state. Evaluating the C expression symbolically cannot
make that mistake, because it never tries to reconstruct what the set "meant".

### Every construct, across every pinned grammar

The generator's construct set is closed, and `docs/parse-survey.md` §3
enumerates it from `render.rs`. The transcoder handles all of it and **raises on
anything else** — there is no skip-and-continue path in the file, because a
silently dropped arm is a lexer that is wrong on precisely the inputs the corpus
does not contain.

That claim is checked rather than asserted. `--lex-only` recovers `ts_lex` from
grammars whose tables are out of scope because they have an external scanner, so
all 18 `parser.c` files the 16 pins name can be swept:

```sh
for f in $(find <sdists> -name parser.c); do ./harness/ts_transcode.py --lex-only "$f"; done
```

All 18 recover clean. And the totals agree exactly with the survey's
independently derived classification, which is the real check:

|                          | This transcoder | `parse-survey.md` §3 |
| ------------------------ | --------------: | -------------------: |
| lex states recovered     |      **10,227** |           **10,227** |
| transition ops recovered |      **19,473** |           **19,473** |

Two methods — symbolic recovery here, statement classification against
`render.rs` there — over the same 18 files, landing on the same two numbers.
Nothing was dropped.

### Two defects that sweep found, neither reachable from the corpus

Both would have shipped green.

1. **The `TSCharacterRange` tables are `static const` in tree-sitter 0.25 and
   plain `static` in 0.23/0.24.** The regex required `const`, so haskell,
   kotlin, typescript and xml failed on sets they do declare. json and go are
   both 0.24/0.25-era in a way that did not expose it.

2. **tree-sitter-python 0.25.0 emits a guard whose two clauses disagree about
   EOF**: `if ((!eof && lookahead == 00) || lookahead == '\n')`. A model of "one
   interval set plus an eof flag" cannot represent that, and the parser
   correctly refused rather than guessing which half wins. The fix is the right
   generalisation: a guard is _two_ interval sets, one for EOF and one for not,
   which is total because `eof` is a single boolean. Op 2 is the collapsed form
   for the three cases covering all but those two lex states; op 4 carries the
   split.

(The `lookahead == 00` in that line is a real tree-sitter generator bug — the
survey traced it to a fall-through in `add_character_range_conditions`. It is
harmless in C, where `00` is octal zero, and this transcoder reads it
correctly.)

A third defect in the same encoding came out of review rather than out of any
corpus, and it is the one worth remembering. A guard that is **false in both EOF
modes** — `lookahead < 0 && lookahead >= 0` — collapses to an empty interval
set, and the interpreter was testing the set only when non-empty:

```js
if (ranges.length && !inRanges(ranges, lookahead)) continue;  // wrong
```

The short-circuit skipped the test and took the branch unconditionally, which
inverts the predicate. No pinned grammar emits a contradictory guard, so nothing
was ever wrong — but it falsified the encoding's own claim to be as expressive
as the C, and the mutation sweep below says the corpus could not have caught it.
Op 2 now always tests the set; a genuinely unconditional action is op 3, and the
full domain has an explicit non-empty representation, so the fix cost nothing.
It is the first case in `harness/ts_lr.test.mjs`, verified discriminating by
reverting the fix and watching exactly one test fail.

## Sizes

`gzip -9`, measured 2026-08-30.

| Artifact                               |     raw |     gz |
| -------------------------------------- | ------: | -----: |
| json blob (tables + lex DFA)           |   6,465 |  1,465 |
| scheme blob (tables + lex DFA)         |  88,350 |  8,806 |
| go blob (tables + lex DFA)             | 372,506 | 35,847 |
| `ts_lr.mjs`, one-off, esbuild --minify |  19,664 |  6,316 |

Laid beside the figures already in `docs/parse-layer.md`, all gz:

| Route                  | runtime, one-off |           json |         scheme |               go |
| ---------------------- | ---------------: | -------------: | -------------: | ---------------: |
| **C3, measured here**  |       **6.3 KB** |     **1.5 KB** |     **8.6 KB** |      **35.0 KB** |
| web-tree-sitter        |           111 KB | ~6–8 KB (est.) |              — | ~31–43 KB (est.) |
| native grammar (proxy) |                — |          11 KB |              — |            57 KB |
| Lezer                  |          17.5 KB |              — |              — |                — |

**The per-language number is a wash; the runtime is where C3 wins.** Go's data
blob at 35.0 KB lands in the middle of the wasm estimate for the same grammar,
which should not be surprising — it is the same tables. What C3 replaces is the
111 KB wasm runtime, with 6.3 KB.

Treat 6.3 KB as a floor, not a quote. It buys clean full parses only. Lezer's
17.5 KB includes error recovery and incremental reparse, and adding those here
would move the number toward Lezer's, not away from it.

Two measurements worth recording so nobody re-derives them:

- **Base64-packing the integer tables makes gzip _worse_** — go goes 35.9 KB →
  41.7 KB. gzip does better on runs of decimal digits than on the base64 of the
  bytes they encode. The naive JSON encoding is already a good one; there is no
  easy win sitting there.
- **Two tables in the blob are never read**: `publicSymbolMap` and `aliasMap`.
  `node.type` resolves through the alias sequence and the symbol-name table;
  `public_symbol_map` is only used by `ts_node_symbol` and `alias_map` only by
  `ts_language_aliases_for_symbol`, both query APIs. `primaryStateIds` and the
  supertype maps are not transcoded at all for the same reason. This was found
  by the mutation sweep, which scored both at 0%.

## How strong is "byte-identical", really?

Weaker than it sounds, and this is the number to carry alongside the green tick.

### The corpus exercises 44% of the blob

`harness/ts_mutation_sweep.py` perturbs one table entry at a time and re-runs
the acceptance bar. A mutation the corpus _catches_ is one the bar would have
noticed; a mutation it _survives_ is an entry those files never reach, where a
transcoder bug would have produced a green run.

Exhaustive over the JSON blob — every one of its 853 mutable sites:

| Table                | sites | caught |    rate |
| -------------------- | ----: | -----: | ------: |
| `fieldMapEntries`    |     6 |      6 |    100% |
| `smallParseTableMap` |    25 |     25 |    100% |
| `symbolMetadata`     |    25 |     22 |     88% |
| `symbolNames`        |    25 |     18 |     72% |
| `parseActions`       |    51 |     32 |     63% |
| `smallParseTable`    |   360 |    187 |     52% |
| `lex`                |    84 |     42 |     50% |
| `lexStates`          |    32 |     16 |     50% |
| `fieldMapSlices`     |     4 |      2 |     50% |
| `aliasSequences`     |     8 |      3 |     38% |
| `parseTable`         |   175 |     20 |     11% |
| `publicSymbolMap`    |    25 |      0 |      0% |
| `reservedWordSetIds` |    32 |      0 |      0% |
| `aliasMap`           |     1 |      0 |      0% |
| **total**            |   853 |    373 | **44%** |

Read that as a **lower bound on the bar's strength**, not as a claim that 56% of
the blob is silently wrong-able. Much of the surviving fraction is semantically
dead: `publicSymbolMap` and `aliasMap` are never read at all (above);
`reservedWordSetIds` is all zeros because JSON is ABI 14, which has no reserved
words; and `parseTable`'s 11% is mostly error entries for symbols that cannot
appear in their state — with `largeStateCount` 7 and `symbolCount` 25, most of
those 175 cells are unreachable by construction. Separating dead from
merely-unexercised needs reachability analysis this does not do.

### Go is bigger, and the corpus covers proportionally less of it

Sampling 30 sites per table (the go blob has 77,718 of them, which is too many
to sweep exhaustively at ~1.5 s a mutant):

| Table                |      sites |   tried |  caught |    rate |
| -------------------- | ---------: | ------: | ------: | ------: |
| `keywordLex`         |        147 |      30 |      24 |     80% |
| `symbolNames`        |        219 |      30 |      22 |     73% |
| `symbolMetadata`     |        219 |      30 |      18 |     60% |
| `fieldMapEntries`    |        636 |      30 |      16 |     53% |
| `smallParseTableMap` |      1,413 |      30 |      10 |     33% |
| `parseActions`       |      1,571 |      30 |       9 |     30% |
| `fieldMapSlices`     |        222 |      30 |       8 |     27% |
| `lex`                |        334 |      30 |       7 |     23% |
| `aliasSequences`     |        999 |      30 |       3 |     10% |
| `lexStates`          |      1,442 |      30 |       2 |      7% |
| `parseTable`         |      6,206 |      30 |       2 |      7% |
| `smallParseTable`    |     62,444 |      30 |       2 |      7% |
| `publicSymbolMap`    |        219 |      30 |       0 |      0% |
| `reservedWordSetIds` |      1,442 |      30 |       0 |      0% |
| `reservedWords`      |        200 |      30 |       0 |      0% |
| `aliasMap`           |          5 |       5 |       0 |      0% |
| **total**            | **77,718** | **455** | **123** | **27%** |

Per-table rates at n=30 carry wide error bars; the shape is what matters. Go's
blob is 90× JSON's while its corpus is 5× JSON's, so coverage falls from 44% to
27% — the same point, sharper. `reservedWords` at 0/30 is the one that would
worry me if reserved words were load-bearing anywhere the packages look:
tree-sitter-go has eight reserved-word sets, and sixteen files never make
membership in one decisive.

The honest summary: **thirty-four files cannot carry a 372 KB table blob.** That
is the argument for the differential below being worth more than either corpus.

### Agreement with real tree-sitter over the Go standard library

The frozen corpus is thirty-four files. `harness/ts_differential.py` widens the
oracle to any source lying around, comparing this interpreter's document against
`gen_trees.convert()` over the real grammar:

```sh
find $(go env GOROOT)/src -name '*.go' |
  uv run --with tree-sitter==0.26.0 --with tree-sitter-go==0.25.0 \
    ./harness/ts_differential.py --language go --module tree_sitter_go --blob go.blob.json
```

Results, all against tree-sitter 0.26.0 with the pinned grammars:

| Corpus                                  |   Files | Agree | Skipped as unclean |
| --------------------------------------- | ------: | ----: | -----------------: |
| Go standard library, `go1.26.7`         |   7,710 | **7,654 / 7,654** |     56 |
| JSON: this repo's 234 frozen trees, packages, highlight data, grammar `*.json` | 281 | **281 / 281** | 0 |
| Scheme: the grammar's own `*.scm`       |       6 | **5 / 5** |                  1 |

That is 7,940 files against 34 in the frozen corpus, and the JSON number matters
most: JSON's acceptance bar is three files, and the frozen trees are large,
deeply nested, and full of escapes and astral-plane text.

It found **three** defects the corpus could not, which is the whole argument for
having built it.

**1. A stack overflow on the largest real file.** `x86asm/tables.go`, a single
~10,000-element generated literal, blew the JavaScript stack. `visibleChildren`
descended into invisible nodes recursively, and a `repeat` rule nests one aux
level per element. That bug is instructive about what skipping upstream
machinery costs: `ts_parser__balance_subtree` rotates same-symbol invisible
repeat nodes, and this interpreter skips it on the correct argument that
rotation preserves leaf order and so cannot change the visible tree. What the
argument missed is that balancing _also_ bounds depth. The reasoning still
holds; the consequence did not. Traversals now carry their own stack, as
tree-sitter's own `ts_node__child` does.

**2. `"\0"` is the empty string.** tree-sitter-go names its EOF terminator token
`"\0"`. As a C string literal that is the _empty_ name — the NUL terminates it —
so `ts_language_symbol_name` returns `""` and the node's type is `""`. The
transcoder was decoding the literal faithfully and producing a one-character
name, so the node came out typed `"\u0000"`. It surfaces only on a Go file with
**no trailing newline**, which no corpus file is.

**3. `gen_trees.check_clean` does not see invisible MISSING nodes.** This one is
a defect in the repo's oracle, not in this spike. `check_clean` walks
`node.children` — the _visible_ children — so a MISSING node whose symbol is
invisible is invisible to it too. tree-sitter-go inserts exactly that, a MISSING
`aux_sym_source_file_token1`, for a Go file with no trailing newline, and
`check_clean` reports the tree as clean while `root_node.has_error` is `True`.
Five stdlib files reached the comparison as error-recovery results that the
corpus's own filter would have frozen. This interpreter was right to refuse
them; `gen_trees.py`'s stated guarantee — "refuses to emit a tree containing
ERROR or MISSING" — is narrower than it reads, and holds only for _visible_
ones. Not fixed here: the frozen corpus is the oracle for four other tracks and
is not this track's to change. `harness/ts_differential.py` consults
`has_error`.

Note the differential is still only evidence about **clean full parses** — files
tree-sitter itself cannot parse without ERROR or MISSING are skipped, exactly as
`gen_trees.py` intends to.

## Two facts about the route that were not known before

### The GoTreeSitter flag is falsified for JSON

GoTreeSitter (`github.com/odvcencio/gotreesitter`, a pure-Go tree-sitter with
206 grammars) lists seven grammars that needed hand-written token sources
instead of the recovered DFA: `authzed, c, cpp, go, java, json, lua`. Two of the
three grammars in this spike are on that list, and its README gives a reason for
go and **none for json**.

For json, that flag does not hold. `tree-sitter-json 0.24.8`'s `ts_lex` recovers
completely — 44 states, 84 ops, no unrecognised construct — and drives a
byte-identical parse of the whole JSON corpus. Whatever put json on that list,
it was not a capability limit of DFA recovery.

### Go's automatic semicolons are inside `ts_lex`, not around it

For go, "automatic semicolons" is checkable rather than mysterious, and the
answer is that they are entirely in scope. Go's statement terminator `\n` is a
real token (`aux_sym_source_file_token1`) produced by `ts_lex`. What makes it
interesting is that whether it _is_ a token depends on the lex mode, and the lex
mode depends on a parse state the grammar is genuinely ambiguous about.

`_ = a.b` followed by a newline is the minimal case. `a.b` forks: one version
reduces toward `selector_expression`, the other toward `qualified_type`, with
tree-sitter's dynamic precedence (`REDUCE(sym__simple_type, 1, -1, 1)`)
eventually deciding. Those two versions sit in parse states with **different lex
modes** — state 863 lexes at `lex_state` 0, where `\n` is whitespace to skip;
state 494 lexes at `lex_state` 1, where `\n` is the terminator. The
expression-version cannot proceed and is _paused_; the type-version consumes the
newline and continues; `condense` drops the paused one.

This cost the spike its only real parser bug. Seven of sixteen Go files failed
with "no action for X in state N", and the fix came from reading tree-sitter's
own parse log for the minimal repro rather than from re-reading my code: it
reaches the identical dead end and answers with `detect_error` →
`ts_stack_pause`, not with error recovery. I had conflated "this version is
stuck" with "the parse has failed". They are not the same thing, and under GLR
the first is routine.

The practical consequence for anyone pricing C3: **a table interpreter for Go is
not an LR interpreter.** It needs the graph-structured stack, version merging,
dynamic precedence, and `ts_subtree_compare` as a tie-break. That is most of
`stack.c` and a good half of `parser.c`, and it is why the interpreter is 6.3 KB
rather than 2 KB.

## The price of the two things route A gets for free

Route A is credited with error recovery and incremental reparse "for free", and
they are the two things this spike does not have. This section prices them. It
is a price with an error bar, not an implementation.

### What the interpreter does today on broken input

`corpus/trees-edited/` (the oracle track's frozen fixtures: four clean bases per
language, four single-edit states each, with tree-sitter's answer including
ERROR and MISSING) covers all three grammars here — 44 fixtures. Running this
interpreter over their `source` fields:

| Outcome                                        | Count |
| ---------------------------------------------- | ----: |
| refused — needs error recovery                 |    33 |
| parsed, and **byte-identical to the oracle**   |    11 |
| parsed, but diverged                           |     0 |

So a single random edit needs recovery **three times in four**, and where it
does not, this interpreter is already exactly right. The refusals split cleanly
along the two upstream mechanisms:

- **26× no parse action** for the lookahead in the current state, with every
  stack version paused — upstream's `ts_parser__handle_error` → `__recover`.
- **7× no token at all** from the lexer — upstream's `skipped_error` path in
  `ts_parser__lex`, which emits an ERROR leaf holding the unrecognised
  character.

### The size of the missing code, measured

Function-body line counts in tree-sitter 0.26.0's `lib/src`, against what this
port already covers:

| Subsystem                       | C lines | Status                     |
| ------------------------------- | ------: | -------------------------- |
| ported (parse, lex, stack, node) |   1,906 | done — 1,244 JS code lines |
| **error recovery**              | **657** | not started                |
| **incremental reparse**         | **1,032** | not started              |

Error recovery is `ts_parser__handle_error`, `__recover`, `__recover_to_state`,
`__do_all_potential_reductions`, the two `__breakdown` paths and
`__better_version_exists` (535 in `parser.c`); the stack summary machinery
`ts_stack_record_summary` / `resume` / `pop_pending` / `pop_error` (79); and the
error and missing subtree constructors (43). Incremental is
`get_changed_ranges.c` in full (558), `ts_subtree_edit` / `balance` / `compress`
(199), `ts_parser__reuse_node` and friends (146), `reusable_node.h` (96), and
`ts_tree_edit` (33).

At the port ratio actually observed here — 1,244 JS code lines from 1,906 lines
of C, or **0.65** — that is roughly **430 JS lines for recovery** and **670 for
incremental**, so about **1,100 lines**, call it 6–8 KB gz on top of the current
6.3 KB. Doubling the runtime still lands under Lezer's 17.5 KB.

**Lines are the cheap half and the number I trust least.** The expensive half is
being right, and this spike has a defect density to reason from: 1,244 JS code
lines produced four real defects found after the first green run — the GLR pause
conflation, the stack overflow, the `"\0"` name, and the empty-interval
inversion. That is one per ~310 lines, and **two of the four were invisible to
the corpus**; they needed the differential and a review.

Recovery should be worse than that rate, not better, for a reason specific to
it: correctness is not "produces a tree" but "produces *upstream's* tree", and
recovery is where upstream makes the most arbitrary-looking choices — which
version to resume, how far back to recover, what error cost to charge. Every one
of those is a coin the port can flip the wrong way while staying plausible.

So: **1,100 lines, and a fortnight of getting them to agree, with the tail risk
in recovery rather than in incrementality.** I would not quote tighter than
that, and the thing that would move it is running the oracle track's
`harness/parse_oracle.py` sweep against a first cut — which is exactly the
instrument that did not exist when `docs/parse-layer.md` called this gap
unpriceable.

### But the bar is lower than "match tree-sitter"

Two measurements from the other tracks, which I did not make and am relaying
rather than restating as my own:

- The **wasm track** measured route A's own error recovery **diverging between
  its native and wasm hosts on 8 of 922 broken-input cases.** So "byte-identical
  recovery" is not a property route A itself has across its two runtimes, and
  demanding it of C3 would hold this route to a standard the incumbent fails.
- The **oracle track** measured route A's incremental reparse giving markdown a
  **1.4× speedup (30.4 ms → 22.1 ms)** against the highlighter's stated ~1
  ms/keystroke requirement, which route A misses outright on five of sixteen
  languages.

If both hold, the honest framing changes shape. Incrementality is not a
free win route A hands over; it is a 1.4× constant factor on a target that is
missed either way, and a from-scratch parse of a viewport-sized region may be
the better engineering answer for both routes. And error recovery does not need
to be byte-identical, because upstream's own two hosts are not — it needs to be
*good*, against the frozen dirty corpus as a diffable oracle rather than as an
equality assertion.

That does not make the work small. It makes it a normal engineering project with
a testable target, instead of an open-ended chase after an oracle that turns out
to disagree with itself.

## What this does not verify

What this interpreter supports is one projection: **byte offsets, and the
visible tree of a clean full parse.** The precise guarantee is narrower than
"anything unsupported throws" — it is that **unsupported behaviour which can
affect that projection is rejected**. Error recovery and external scanners
throw, because reaching them would change the tree. Repeat rebalancing is
skipped silently and cannot change the visible tree by construction. Row and
column state is simply never tracked, because nothing in this projection reads
it. Incremental reparse has no entry point at all rather than a throwing one.

Everything below is out of scope. Each is a place where a table-driven
reimplementation is green on the corpus and wrong in production. `docs/parse-layer.md`'s section "The gate in front of any
own-the-parser route" said this before the spike started; the spike is evidence
for its comfortable half only.

- **Error recovery.** Not implemented. `ts_parser__handle_error`, `__recover`,
  `__recover_to_state`, `ts_subtree_new_error`, `RECOVER` actions, and
  error-cost accumulation in `summarizeChildren` all throw. `gen_trees.py`
  refuses to freeze a tree containing ERROR or MISSING, so by construction no
  corpus file exercises any of it — and the highlighter's stated contract is to
  degrade gracefully on broken input. This is the single largest hole.
- **Incremental reparse.** Not implemented. No old-tree reuse, no
  `ReusableNode`, no `ts_parser__breakdown_top_of_stack`, no
  `ts_parser__reuse_node`. The token cache _is_ implemented, because it affects
  which subtree object a full parse produces; node reuse is not. Nothing in this
  repo edits a buffer and reparses, so nothing measures it — and the oracle
  track has since found a scratch-versus-incremental divergence in tree-sitter
  itself, which this interpreter has not been near.
- **External scanners.** The transcoder _refuses_ a grammar with a scanner
  rather than emitting a half-blob. Eight of ten grammars this project depends
  on have one. Nothing here is evidence about the scanner VM, which
  `docs/design.md` calls the highest-risk part of the project, and no scanner
  state serialization exists to be wrong.
- **Repeat rebalancing.** Skipped deliberately, argued above. The argument is
  about the _visible tree_ and I believe it; it is not a proof, and the stack
  overflow is a reminder that "cannot change the output" is not the same as
  "cannot change anything".
- **Row and column tracking.** Not implemented — only byte offsets reach the
  output. The two consumers of extents are `get_column` (external scanners only)
  and error-cost-per-line (error recovery only), so this is consistent with the
  two holes above rather than independent of them. Any grammar whose scanner
  calls `get_column` — Python's, for one — needs it.
- **Invalid UTF-8.** The decoder returns `TS_DECODE_ERROR` on malformed input
  and the interval domain models it, but no test feeds it any. Every corpus file
  and every stdlib file is valid UTF-8.
- **Four static tables are not transcoded at all.** `primary_state_ids`,
  `supertype_symbols`, `supertype_map_slices`, `supertype_map_entries` and the
  language `metadata` struct are omitted, because parsing and `node.children`
  never read them; they serve query analysis and the supertype API. So "every
  static table" — which an earlier draft of this document and the transcoder's
  own docstring both claimed — is wrong, and the omission would matter to
  anyone growing this into query support. Two more, `public_symbol_map` and
  `alias_map`, are transcoded but never read by the interpreter (the mutation
  sweep scored both at 0%, which is how they were found).
- **The 0.26.0 pin.** The interpreter is a port of one runtime version. ABI 13,
  ABI 15's supertype maps, and any future change to the parse algorithm are
  untested. The transcoder handles ABI 14 and 15 only.
- **Rust.** The brief asked for one interpreter, in JS. The second runtime is
  unwritten, and "byte-identical across two runtimes" — which is what this
  project actually requires — is therefore not demonstrated by this spike.

## Getting `parser.c`

`uv pip download` does not exist on the installed `uv` (0.11.21) — the
subcommand was removed. Fetch the sdist from the PyPI JSON API:

```sh
curl -sSL https://pypi.org/pypi/tree-sitter-json/0.24.8/json |
  python3 -c 'import sys,json;d=json.load(sys.stdin);print(next(u["url"] for u in d["urls"] if u["packagetype"]=="sdist"))' |
  xargs curl -sSLO
tar xzf tree_sitter_json-0.24.8.tar.gz
```

`docs/parse-survey.md` §1 records the rest of the packaging traps, including
which sdists ship no headers.

## Verdict

The hypothesis in the brief was:

> `parser.c` is almost entirely static data … the only _code_ is `ts_lex` and
> `ts_lex_keywords`, and those are switch-based DFAs whose every arm is
> mechanically recoverable into a transition table. If that holds, then
> transcoding tree-sitter's own generated tables into a data blob, and writing
> one LR interpreter per runtime, gives byte-identical trees **by
> construction**.

It holds, with one correction and one caveat.

**The correction:** "one LR interpreter" understates it. Go needs GLR — a
graph-structured stack, version merging and dynamic precedence — because its
grammar is genuinely ambiguous and tree-sitter resolves that at parse time, not
at table-generation time. That is not an implementation detail; it is a
different-sized component, and it is what the second (Rust) runtime would have
to reproduce exactly.

**The caveat:** "by construction" is true of the _tables_ and false of the
_algorithm_. The tables are tree-sitter's own, so they cannot disagree. The
interpreter is a hand port, and a hand port of 4,000 lines of C can disagree
anywhere — as it did, twice, in ways the corpus caught only because Go's corpus
is bigger than JSON's, and once in a way no corpus caught at all until the
differential ran.
