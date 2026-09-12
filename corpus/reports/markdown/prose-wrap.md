# Prose wrap (roadmap step 2)

## Builder

Codex (`gpt-6-astra`, effort `xhigh`), 2026-09-09. Session cut off by a usage
limit before it could write this file itself; the measurements and diffs it had
already produced were recovered from the working tree and are reproduced here
unchanged, with the double-format check and gate run added afterward.

## 2026-09-12 gate-equivalence attempt

The block grammar makes `inline`, rather than its parent `paragraph`, the
first declaration boundary suggested by a flat paragraph. A paragraph has one
named `inline` child; the `inline` node has anonymous delimiter tokens and
retains ordinary prose in the untokenized gaps between them. Consequently
`_tokens` compares a soft line break byte-for-byte in the same tuple member that
protects its words.

That observation is true but insufficient. A production prototype declared
`prose_nodes = ["inline"]`, canonicalized soft ASCII whitespace in retained
gaps, kept every non-whitespace byte and delimiter exact, added a counted
dropped-word mutation, and regenerated the 24-file reference corpus with
`--prose-wrap always`. It was committed as `1c5d111` and then reverted by
`3857f81`; the live pin remains `preserve`.

| 24 files at both widths | `preserve` | `always` |
| --- | ---: | ---: |
| Raw byte agreement, no exclusions | 33/48 | 10/48 |
| Scorer agreement, four incomparable files excluded | 33/40 | 10/40 |
| Structural signature mismatches, including incomparable files | 8/48 | 32/48 |
| Check-1 failures after the four incomparable files are skipped | 0/40 | 24/40 |
| Check-1 failures after the prototype's safe gap normalization | — | 12/40 |

The 33/48 → 10/48 and 32/48 figures were re-derived at `a0735f8`, not copied
from the brief. They match its measurements exactly.

Two counterexamples stop the proposed narrowing from being the equivalence:

1. A direct parser probe found that `alpha  \nbeta` (a two-space hard break)
   and `alpha\nbeta` (a soft break) both reparse to the same
   `paragraph/inline` block tree. Blanket whitespace collapse would admit a
   semantic change that reparsing cannot detect. The separate inline grammar
   does distinguish both space- and backslash-authored hard breaks.
2. Of the 12 residual check-1 failures, nine add or remove named `block_continuation`
   children when prose wraps inside lists or quotes. Three move an inline HTML
   comment to the start of a continuation line; the block grammar then
   reclassifies it as `html_block`, changing the universal comment signature
   and the injected-region structure as well as the local prose leaf.

The second case cannot be repaired in `_tokens`, and changing `_extras` is
explicitly outside this slice. Naming `paragraph` instead of `inline` does not
help: the moved comment splits one source paragraph into paragraph, HTML block
and paragraph nodes. Ignoring named children or all whitespace would merely
hide the evidence and weaken the project's content-loss defence.

The correct gate shape is the block-and-inline projection already called for
below: reconstruct logical prose runs across declared container continuations,
parse them with `inline_language()`, compare ordered content, delimiter spelling,
comments and hard-break events, and permit only grammar-confirmed soft gaps to
move. It must also specify how an inline comment reclassified as an HTML block
participates in the universal layer. Until that larger design is implemented,
the reference cannot safely flip and no package or runtime change is justified.

## What was measured

`harness/languages/markdown.toml` pins the reference at
`npx --yes prettier@3.9.6 --no-config --stdin-filepath x.md --print-width {width}`,
which leaves `proseWrap` at its default, `preserve`. To find out what adopting
`--prose-wrap always` would actually cost, the reference command was run with
that flag added, against the unchanged 20-file corpus, without touching the
package or either runtime.

|                                         | `preserve` (live) | `always` (measured only) |
| --------------------------------------- | ----------------- | ------------------------ |
| Agreement, both widths                  | 27/32             | 8/32                     |
| Agreement @80                           | 13/16             | 7/16                     |
| Agreement @40                           | 14/16             | 1/16                     |
| Files where width changes the reference | 5/20              | 16/20                    |
| Overflow @40                            | 96                | 44                       |
| Gate 3 (reference outputs it rejects)   | 0                 | 20                       |

Switching only the flag regresses agreement from 27/32 to 8/32 and makes gate 3
reject 20 of the reference outputs it is asked to validate against — a much
larger and more structural change than "reflow some paragraphs." The live
manifest keeps `preserve`; the `always` numbers above are retained as measured
fact, not adopted as the reference.

## Why `fill` cannot express this today, even if the reference switched

`fill` (`DESIGN.md`) selects a sequence of already-built child Docs and picks
flat/break per separator between them. It does not tokenize a leaf's raw text.
Markdown's block grammar puts prose either in raw gaps between anonymous
delimiter tokens or inside one `inline` leaf; `paragraph` and `inline` both
currently use `verbatim`. Neither path exposes word-sized Docs for `fill` to
select over.

The obvious fix — splice in tree-sitter-markdown's separate `inline_language()`
grammar via an included-range second pass — fence injection already provides
related slice-parsing and splicing machinery — was checked directly and is **not sufficient
by itself**: that grammar supplies `emphasis`, `inline_link` and `code_span`
structure, but still no word-level nodes. Prose between and inside those spans
is still an unsplit run, and Prettier itself wraps _inside_ a long `emphasis`
span, so treating each markup subtree as one indivisible fill atom would also be
wrong.

So the real prerequisite is a word/protected-span projection over source ranges
— something between the current `verbatim` (whole-subtree, no splitting) and a
hypothetical new capability that can slice a validated leaf into fill atoms
while still refusing on stale offsets, the same way `verbatim` does today. A
delimiter-aware ad hoc splitter living only in the runtime was considered and
declined: it would make the runtime a second, partial markdown parser, which is
the shape this project has consistently avoided (see `whitespace_nodes` and
`quote_blocks`, LEDGER rows 22–23, for the same discipline applied to two other
markdown defects this session).

**No opcode, package field, or runtime capability was added in this step.** The
count stays 29 opcodes, three sanctioned mutations, unchanged.

## What the corpus gained

`corpus/src/markdown/prose_wrap.md` — a plain long paragraph, a paragraph mixing
emphasis/link/code-span across a wrap point, two list-indent depths, and a block
quote, all long enough to reflow at 80 and 40 if reflow existed. Because the
live reference is still `preserve`, its two reference files
(`corpus/reference/markdown__prose_wrap@{80,40}.txt`) are byte-identical to the
source — that is the current, correct, documented limit, not an oversight.

Double-format check (this project's standing rule, applied here): formatted the
fixture at 80 and at 40, formatted each output again, diffed pass 1 against
pass 2. Byte-identical at both widths. `./test.sh`: 417/417 corpus files
formatted at every width (up from 415/415), 796 destructive mutations rejected
(up from 792 — markdown's own share 38/32 → 40/34), zero warnings, exit 0.

## Where this leaves roadmap step 2

Quantified, not built. The number does not say "abandon this" — width
discrimination rises from 5/20 to 16/20 files, which is real coverage this project has
wanted elsewhere — but it does say the honest next unit of work is a parse-
layer design question (a source-range projection for words and protected spans,
plus the gate-3 equivalence prose reflow would need), not a package rule. That
is a separate, larger design task than this step's budget, and is recorded here
rather than forced into a partial fix.

The [2026-09-10 design follow-up](../../../docs/prose-projection.md) specifies
the proposed source partition, its composition from existing opcodes, the
additional coverage validation it would require, and the remaining parse/gate
work. It is a design proposal with a scratch Doc-composition probe, not shipped
prose reflow.
