# Prose projection: source ranges before layout

Design proposal, 2026-09-10. Codex, gpt-6-astra at medium effort.
**The projection itself is not a shipped opcode, parser feature or package
declaration.** The `source_partitions` check it asked for is.
It follows the [measured prose-wrap limit](../corpus/reports/markdown/prose-wrap.md).

## Decision

Build a formatter view of prose in the parse layer: an ordered partition of
source bytes into content atoms and explicitly classified whitespace gaps.
Use the existing `fill`, `verbatim` and `whitespace_nodes` mechanisms to render
that view. Do not add a raw-text tokenizer to either Doc evaluator.

There is one additional production requirement: validate that the partition
covers its entire source range. Existing source validation checks the children
that exist, but does not detect an omitted child and the newly exposed gap.
The preferred extension is a generic source-partition check, declared by the
package and mirrored in both runtimes, rather than a markdown-only emitter.
The `source_partitions` header and package format 3 now exist in both
runtimes; the projection itself does not. The spelling below is the shipped
schema for that check. The rest of this document remains a proposal.

This chooses where syntax interpretation belongs. It does not yet settle the
complete markdown break policy, container prefixes or gate-3 equivalence.

## Two slices: A1 without the inline grammar, A2 with it

Agreed with Astra, 2026-09-13, after this document was written. The four-step
plan at the end of this file names step 2 as a "words-plus-emphasis"
projection. Emphasis needs the inline grammar, and the inline grammar is not
free: `gen_trees.py` links native tree-sitter and would only need to select
`inline_language()`, but the browser parses through `ts_lr.mjs` and the scanner
VM, where an inline grammar means **an inline blob and a separate inline
scanner port**. Porting the block scanner does not supply it.

That cost is real and it is not A1's to pay. The slice is therefore cut in two:

**A1 — plain words only, block grammar alone.** Eligibility is decided from the
block CST that both producers already have. A paragraph qualifies only if
nothing in it can be inline syntax at all, so there is no emphasis, no code
span, no link, and no delimiter whose meaning depends on what is adjacent to
it. A1 establishes the projection, the partition, the two mirrored producer
implementations and their agreement; it does not change any corpus reference
and it does not make prose wrap visible to anyone.

**A2 — grammar-backed inline.** Adds `inline_language()` to the native path,
the inline blob and scanner port to the browser path, and widens eligibility to
emphasis and the rest of the safe inline subset. Prose wrap becomes a visible
policy here, not in A1.

A1 is worth building alone because it is where the *expensive* uncertainty
lives. The eligibility predicate, the atom/gap partition, the total-coverage
refusal, the reflow-survives-reparse property and — above all — **whether the
Python producer and the browser producer agree on a projection** are all
exercised in full by plain words. None of them gets easier once emphasis is
added; they simply get harder to debug. A2 inherits a projection that is
already known to agree.

### What A1 deliberately does not establish

A1's eligible subset is narrow enough that it is not a prose-wrap feature and
must not be reported as one. Measured with the shipped predicate over every
*tracked* markdown file in this repository -- 5,035 paragraphs in 102 files,
the same set `harness/probe_prose.py` gates on:

| | |
| --- | --- |
| Eligible paragraphs | **535 (10.6%)** |
| Share of prose *bytes* in them | **4.5%** (59,628 of 1,333,279) |

The two figures answer different questions and neither is the other: eligible
paragraphs are the short ones, so the count overstates the reach.

Where the other 89% goes is the roadmap:

| Refused because | Share |
| --- | --- |
| It holds a character that could open inline syntax | 50.5% |
| It is inside a list or a blockquote | 36.6% |
| It holds a non-ASCII byte | 1.4% |
| It would acquire a block, is one word, or has odd whitespace | 0.9% |

A2 buys the first row. The second needs no new grammar at all -- only the
retained-range map and continuation-prefix ownership this document defers -- so
it is a separate slice that could be taken before A2 rather than after, and at
a third of A2's cost.

Two corrections to earlier drafts of this section, both worth keeping because
both were confidently stated:

- It first reported **2.2%** and **7.9%**, from a hand-written predicate over a
  different set of files. Neither figure describes the predicate that shipped.
- It then reported containers as the *larger* half at 46.1% against 41.7%, and
  drew the conclusion that the usual framing is inverted. That was measured
  over a glob that swept untracked offload notes, which are unusually plain
  prose. On the tracked set the ordering is the ordinary one. The probe now
  reads `git ls-files`, so its input set is the commit's rather than whatever
  is lying in the checkout.

## Inputs and ownership

The projection takes the original UTF-8 source, its clean block CST, a clean
inline CST for one eligible paragraph, and the mapping from inline-parser
offsets to original source offsets. It takes **no print width** and produces
no formatted strings. Parsing and projection must run again after an edit;
rebasing a cached projection without reparsing does not establish validity.

The block CST supplies paragraph boundaries and container ownership. The inline
grammar supplies emphasis delimiters, escapes, entities, links, code spans and
hard breaks. A projection pass enumerates gaps the inline grammar leaves
implicit; it does not rediscover delimiter pairing with regular expressions.
Unknown or unhandled syntax makes the whole paragraph ineligible. Retain the
original subtree and its `verbatim` behavior; do not project just the easy words
around an unknown construct.

An eventual manifest declaration selects the inline grammar and projection
policy. Implement the same declaration in the native harness parse path
(`gen_trees.py`) and the JavaScript parse path (`ts_doc.mjs` and its callers).
There is no markdown-name branch in the formatter. A named markdown projection
policy in the parser would still be language-specific code: this proposal does
not disguise that fact or claim a general projection DSL has been designed.
Its cost and fit with downloadable parser data need review before shipping.

Keep the syntax tree for highlighting and syntax-aware editing. Derive a
separate formatter view, sharing source offsets, rather than inserting both
the syntax subtree and the projected atoms as siblings. Such siblings would
overlap and give two consumers ownership of the same text. The highlighter
benefits from the inline CST; it should not have to reconstruct emphasis from
the formatter's flattened atoms.

## The formatter view

For the source `alpha _beta gamma_ omega`, the projected content range is
`[0, 24)`. Offsets are half-open byte offsets, not character indices.

| Kind | Range | Source text |
| --- | --- | --- |
| atom | `[0, 5)` | `alpha` |
| gap | `[5, 6)` | one space |
| atom | `[6, 11)` | `_beta` |
| gap | `[11, 12)` | one space |
| atom | `[12, 18)` | `gamma_` |
| gap | `[18, 19)` | one space |
| atom | `[19, 24)` | `omega` |

An atom is the smallest **contiguous** source span between eligible gaps.
Opening and closing emphasis delimiters remain attached to their adjacent
words. They are not independent fill items. This lets a single fill cross the
emphasis span, without requiring nested fills to pack as one global sequence.

Protected syntax removes candidate boundaries inside its range. For example,
an entire code span, including its delimiters and internal spaces, stays in one
atom. Punctuation adjacent to it without an eligible gap stays in that atom
too. Links and images can initially be protected whole, trading some reference
agreement for less mechanism. Emphasis is deliberately not protected whole.
Escapes and entities must never be cut internally or decoded and re-encoded.

Each atom is an interior `prose_atom` with an exact source-backed leaf child;
each gap is a `prose_gap` leaf carrying its exact original whitespace. Even a
one-word atom uses the interior wrapper: leaf `text` bypasses rule dispatch in
both current runtimes, so putting a `verbatim` rule on a leaf would not invoke
its validator. The wrapper provides that validation path.

The `prose_run` contains every atom and gap, in alternating order. Its extent
starts at the first atom and ends at the last. Paragraph terminators and any
leading/trailing layout outside that extent remain explicitly owned by the
host; narrowing the run must not silently discard them. Empty content and
unsupported host shapes retain the original subtree.

The layout portion is expressible today:

```json
{
  "format": "et-doc-rules/2",
  "indent": 2,
  "tokens": [],
  "whitespace_nodes": ["prose_gap"],
  "rules": {
    "prose_run": ["fill", "t:prose_atom", ["line"]],
    "prose_atom": ["verbatim"]
  }
}
```

This fragment is not a complete production package. `whitespace_nodes` consumes
the declared gaps before `fill` sees its child sequence. It also validates the
containing subtree against source before consuming trivia. The content atoms
are consumed once by `fill`, and their source is emitted by `verbatim`.

## What source validation proves, and what it does not

Validate the original CST before projection, then validate the produced view.
All ranges must be within their parents, ordered, disjoint and on UTF-8 byte
boundaries; all leaf text must match the corresponding original source slice.
Do not put text from a prefix-stripped buffer in a leaf whose range still
includes the prefix in the original buffer.

The producer must additionally prove a total partition: the first child starts
at the run's start, each child starts at the previous child's end, and the last
child ends at the run's end. Each child is nonempty. There are no implicit
source gaps, not even whitespace gaps: classifying a gap must leave evidence
in the tree. A gap leaf contains only the whitespace the syntax policy admitted.

Repeat the source/range and total-coverage checks at the runtime boundary.
Producer-only validation would not protect a frozen projection edited or made
stale afterward. A `source_partitions: ["prose_run"]` package header requires
these checks **before leaf dispatch, trivia consumption or Doc construction**.
A childless declared node is accepted only when its range is empty; a childless
non-empty node refuses. Other node types retain their existing validation
behavior. Atom `verbatim` validation remains in place; this is an additional
coverage condition, not a relaxation of it.

This header requires package format version 3: older loaders ignore unknown
header fields, so version 2 plus a new field would silently omit the guarantee.
Both loaders and evaluators agree on malformed declarations and partition
refusals. There is no new Doc opcode in this design.

These checks prove byte provenance and coverage, **not markdown semantics**.
A malicious producer can still label meaningful whitespace as layout, just as
a package can misuse existing whitespace declarations. The grammar/projection
policy and independent gate 3 must establish that only valid break boundaries
were selected. A changed source that still matches all recorded slices is not
proof of an up-to-date parse; normal edit processing must reparse it.

## Safe gaps, not arbitrary whitespace

The first eligible subset should be top-level paragraphs containing ordinary
words and grammar-confirmed emphasis, with interior spaces and soft line breaks.
Restrict the lexical subset explicitly; do not claim support for all Unicode
line-breaking behavior merely because offsets are UTF-8-correct.

The eventual classifier must distinguish soft breaks from hard breaks and must
exclude code-span interiors, nonbreaking spaces, escape sequences and protected
syntax. Tabs, HTML/comments and multiline protected spans can initially make a
paragraph ineligible. A hard break cannot become a space. A blank line cannot
be treated as an interior prose gap. Do not use `strip()` or `split()` over the
entire source as a semantic classifier.

Each candidate newline must also preserve block syntax: a line beginning with
`#`, `>`, a list marker, a fence or a setext/thematic-break sequence may change
the parse. A boundary that would require inserting an escape is not eligible.
Coalesce the adjacent atoms where sufficient; otherwise preserve the paragraph.
Do not synthesize backslashes to make a greedy break legal.

Gap eligibility must survive reflow. Changing only the eligible soft whitespace
must reproduce the same atom texts and the same eligible boundaries on reparse.
That is a required property to test, not a consequence of source coverage.
Context-sensitive delimiter interpretation makes it unsafe to infer this from
one successful example.

Only original content slices reach text Docs. Gaps become existing whitespace
Docs. There is no delimiter, quote or token respelling and no invented escape;
therefore this does **not require a fourth sanctioned token mutation**.
Projection and partition validation are nevertheless new capabilities and must
be reviewed as such. Preserving non-whitespace bytes alone would not justify
changing rendering-significant whitespace.

## Containers and gate 3 are separate work

Start with a contiguous top-level paragraph. Existing fence injection parses
slices; it is not an included-range parser. Lists and quotes require a retained-
range map and explicit ownership of removed continuation prefixes. An atom
spanning disjoint retained ranges cannot be represented as one truthful leaf
with a contiguous source span. Initially, reject that shape for projection.

New quote lines also need new `>` prefixes. Existing `prefix` may contribute,
but emitting the first marker and reusing it as continuation indentation must
be reconciled with single consumption. List marker width, nested containers,
blank quoted lines and multiline protected spans need their own examples.
Do not claim ordinary `indent` or rebased offsets solve these cases.

Gate 3 must independently parse the output using the block and inline grammars.
For eligible paragraphs, compare inline structure, delimiter spelling, ordered
text, protected bytes and hard-break events, permitting only the admitted soft
whitespace changes. It must also retain block/container structure, comments and
injection checks. It must not compare only the formatter's atom stream: that
would repeat the classifier's mistakes and lose independent semantic evidence.

### Gate-equivalence probe, 2026-09-12

The proposed `_tokens` shortcut was implemented against the full 24-file
corpus, then reverted. Soft-whitespace normalization on declared `inline` nodes
reduced `--prose-wrap always` structural signature mismatches from 32/48 to
20/48. After the four existing incomparable files were skipped, check 1 still
failed on 12/40 comparisons:

- list and quote wrapping changes the number of named `block_continuation`
  children inside `inline`; these prefixes must be removed by a range-aware
  logical-prose projection, not treated as ordinary gaps;
- Prettier can move an inline HTML comment to the start of a continuation line,
  where the block grammar reclassifies the line as `html_block`. The equivalent
  content then spans paragraph / HTML-block / paragraph boundaries and changes
  the universal comment and injection signatures;
- the block grammar gives a two-space hard break and a soft line break the same
  `paragraph/inline` shape. Its separate inline grammar correctly emits
  `hard_line_break` for both the two-space and backslash forms.

Therefore step 3 below must operate on logical prose runs, not one `_tokens`
tuple or one block node at a time. Its design must include container-prefix
ownership and comment reclassification before the live reference moves from
`preserve`. The prototype commits (`1c5d111`, reverted by `3857f81`) retain the
exact experiment without weakening the live gate.

The existing generic gate rejects such reflow and an override cannot merely
weaken it unnoticed. Specify the declared equivalence and its adversarial
checks before changing either the generic path or override comparison. HTML
comment movement among the 20 rejected references is outside the first subset;
no promise is made that every Prettier rewrite will be accepted.

## Evidence and stopping point

A scratch **Doc-composition probe**, not an end-to-end parser prototype, built
the view for this controlled paragraph:

```text
alpha _beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron_ omega
```

It used a temporary package via `FMT_PACKAGES`, the two existing CLIs, and no
runtime changes. Projection split spaces/soft newlines only for this known
example; it did not implement markdown syntax classification. At width 12:

```text
alpha _beta
gamma delta
epsilon zeta
eta theta
iota kappa
lambda mu nu
xi omicron_
omega
```

At widths **12, 40 and 80**, JS and Rust matched, and formatting, rebuilding the
controlled projection from output, and formatting again produced byte-identical
outputs (89 bytes each). Changing either an atom's cached text or a gap's cached
text caused both runtimes to refuse through `whitespace_nodes` source validation.
Deleting the first atom and gap from the view was **accepted by both**. That last
counterexample is why the proposal requires total-coverage validation.

The probe was `/tmp/prose-projection-composition.py`; its temporary tree and
package directory was `/tmp/prose-projection-composition`. It is not installed
as an alternate markdown loader. No corpus fixture, reference, package, parser
or runtime is changed by this design-only commit.

Validation of the unchanged implementation: `./test.sh` exited 0 with no
warnings, all four corpus gates at 417/417, and 796 destructive mutations
rejected (the same count as the baseline checked before this work). Additionally,
`uv run --quiet --with tree-sitter python /tmp/markdown-double-format.py prose_wrap`
reparsed and double-formatted the existing `corpus/src/markdown/prose_wrap.md`
in JS and Rust at 80 and 40. All four pairs were byte-identical (1,019 bytes).
This confirms the current preserve behavior, not projected markdown support.

Medium effort was sufficient to establish this composition and its missing
guarantee. It did not establish a safe complete boundary classifier or prose
equivalence, so no production or end-to-end prototype is claimed. The next
bounded implementation should:

1. Add mirrored generic partition validation and version negotiation, with
   malformed/stale/omitted/overlapping-range tests and a one-atom control.
2. Implement and differentially test a declared top-level words-plus-emphasis
   projection from real grammar output, including soft-line reparsing. Check
   exact source coverage before and after serialization.
3. Define the independent gate equivalence over logical prose runs, including
   container-continuation ownership and inline-comment/block-comment
   reclassification as well as changed words, delimiters, code bytes, hard
   breaks and newly created block syntax.
4. Exercise one fixture through parse, projection, both runtimes, reparse and
   projection again at 80 and 40. Keep the live `preserve` reference until the
   full corpus's reference-policy change has an honest green boundary.

Containers, HTML/comments, broader inline syntax and Unicode break policy are
later slices. Whether the generic validation/header cost and parser-specific
projection are worth adopting remains a reviewable judgment, not a claim that
the existing closed DSL already handles prose end to end.
