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

| Language                | Corpus files | Result                   |
| ----------------------- | -----------: | ------------------------ |
| tree-sitter-json 0.24.8 |            3 | **3/3 byte-identical**   |
| tree-sitter-go 0.25.0   |           16 | **16/16 byte-identical** |

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
is evidence about clean full parses of nineteen files and nothing else.

## What was built

Three pieces, all harness, none of it on any shipped path.

| File                           | What it is                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `harness/ts_transcode.py`      | `parser.c` → one JSON blob: every static table, plus the lex DFA recovered from code |
| `harness/ts_lr.mjs`            | the parser: GLR stack, table-driven parse loop, subtree summarisation, node API      |
| `harness/ts_check_trees.mjs`   | the acceptance bar — parse the corpus sources, compare bytes                         |
| `harness/ts_differential.py`   | the wider oracle — compare against real tree-sitter over arbitrary source            |
| `harness/ts_mutation_sweep.py` | how much of the blob the corpus actually exercises                                   |

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

## Sizes

`gzip -9`, measured 2026-08-30.

| Artifact                               |     raw |     gz |
| -------------------------------------- | ------: | -----: |
| json blob (tables + lex DFA)           |   6,465 |  1,465 |
| go blob (tables + lex DFA)             | 372,512 | 35,853 |
| `ts_lr.mjs`, one-off, esbuild --minify |  19,356 |  6,212 |

Laid beside the figures already in `docs/parse-layer.md`, all gz:

| Route                  | runtime, one-off |           json |               go |
| ---------------------- | ---------------: | -------------: | ---------------: |
| **C3, measured here**  |       **6.2 KB** |     **1.5 KB** |      **35.0 KB** |
| web-tree-sitter        |           111 KB | ~6–8 KB (est.) | ~31–43 KB (est.) |
| native grammar (proxy) |                — |          11 KB |            57 KB |
| Lezer                  |          17.5 KB |              — |                — |

**The per-language number is a wash; the runtime is where C3 wins.** Go's data
blob at 35.0 KB lands in the middle of the wasm estimate for the same grammar,
which should not be surprising — it is the same tables. What C3 replaces is the
111 KB wasm runtime, with 6.2 KB.

Treat 6.2 KB as a floor, not a quote. It buys clean full parses only. Lezer's
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

The honest summary: **nineteen files cannot carry a 372 KB table blob.** That is
the argument for the differential below being worth more than either corpus.

### Agreement with real tree-sitter over the Go standard library

The frozen corpus is nineteen files. `harness/ts_differential.py` widens the
oracle to any source lying around, comparing this interpreter's document against
`gen_trees.convert()` over the real grammar:

```sh
find $(go env GOROOT)/src -name '*.go' |
  uv run --with tree-sitter==0.26.0 --with tree-sitter-go==0.25.0 \
    ./harness/ts_differential.py --language go --module tree_sitter_go --blob go.blob.json
```

<!-- DIFFERENTIAL-RESULT -->

It earned itself on the first run by finding a real defect the corpus could not:
`x86asm/tables.go`, a single ~10,000-element generated literal, **overflowed the
JavaScript stack**. `visibleChildren` descended into invisible nodes
recursively, and a `repeat` rule nests one aux level per element.

That bug is instructive about what skipping upstream machinery costs.
`ts_parser__balance_subtree` rotates same-symbol invisible repeat nodes; this
interpreter skips it, on the correct argument that rotation preserves leaf order
and therefore cannot change the visible tree. What the argument missed is that
balancing _also_ bounds depth. The reasoning still holds; the consequence did
not. Traversals here now carry their own stack, as tree-sitter's own
`ts_node__child` does.

Note the differential is still only evidence about **clean full parses** — files
tree-sitter itself cannot parse without ERROR or MISSING are skipped, exactly as
`gen_trees.py` refuses them.

## Two facts about the route that were not known before

### The GoTreeSitter flag is falsified for JSON

GoTreeSitter (`github.com/odvcencio/gotreesitter`, a pure-Go tree-sitter with
206 grammars) lists seven grammars that needed hand-written token sources
instead of the recovered DFA: `authzed, c, cpp, go, java, json, lua`. Both
grammars in this spike are on that list, and its README gives a reason for go
and **none for json**.

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
`stack.c` and a good half of `parser.c`, and it is why the interpreter is 6.2 KB
rather than 2 KB.

## What this does not verify

Everything below is out of scope, unimplemented, and unpriced. Each is a place
where a table-driven reimplementation is green on the corpus and wrong in
production. `docs/parse-layer.md`'s section "The gate in front of any
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
