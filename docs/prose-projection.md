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
block CST that both producers already have. A paragraph qualifies only if it
holds no syntax whose meaning a gap flip could change, so there is no emphasis,
no code span, no link, and no delimiter whose meaning depends on what is
adjacent to it. That is weaker than "no inline syntax at all", and the
difference has a name: a GFM extended autolink (`www.example.com`,
`https://example.com`) *is* inline syntax and an eligible paragraph may contain
one. It survives because it holds no space, so it lies inside a single atom and
no gap flip can reach into it -- see `harness/probe_prose.py`, which is where
that argument is made and tested. A1 establishes the projection, the partition, the two mirrored producer
implementations and their agreement; it does not change any corpus reference
and it does not make prose wrap visible to anyone.

**A2 — grammar-backed inline.** Adds `inline_language()` to the native path,
the inline blob and scanner port to the browser path, and widens eligibility to
emphasis and the rest of the safe inline subset. Prose wrap becomes a visible
policy here, not in A1.

A1 stops one line short of the browser. `web/js/lang.js` parses and splices but
does not call the projection, because that call is the moment prose wrap becomes
visible in an editor buffer. `harness/prose.mjs` is the browser path's
implementation and is proven to agree with `harness/prose.py` on every tracked
markdown file; it is simply not wired in. "The two producers agree" is a weaker
claim about a function one producer never runs, and A1 should be read with that
in mind.

A1 is worth building alone because it is where the *expensive* uncertainty
lives. The eligibility predicate, the atom/gap partition, the total-coverage
refusal, the reflow-survives-reparse property and — above all — **whether the
Python producer and the browser producer agree on a projection** are all
exercised in full by plain words. None of them gets easier once emphasis is
added; they simply get harder to debug. A2 inherits a projection that is
already known to agree.

### What A1 deliberately does not establish

A1's eligible subset is narrow enough that it is not a prose-wrap feature and
must not be reported as one. Measured **at `3dbf9d3`** with the shipped
predicate over every *tracked* markdown file in this repository -- 5,048
paragraphs in the 102 of 103 tracked files that parse cleanly
(`docs/parse-survey.md` does not), the same set `harness/probe_prose.py` gates
on. That set includes this document, so writing plain prose here moves the count
by a paragraph or two; the percentages are the stable half, and the commit is
named because these figures have gone stale unannounced twice.

| | |
| --- | --- |
| Eligible paragraphs | **536 (10.6%)** |
| Share of prose *bytes* in them | **4.5%** (59,736 of 1,337,207) |

The byte figure counts the **`paragraph` node's own source range**, summed over
every paragraph the walk reaches, eligible over all. Counting the `inline`
node's range instead moves both numbers by a few hundred bytes and neither
percentage.

The two figures answer different questions and neither is the other: eligible
paragraphs are the short ones, so the count overstates the reach.

Where the other 89% goes, as **first-match** refusal reasons:

| Refused because | Share |
| --- | --- |
| It holds a character that could open inline syntax | 50.5% |
| It is inside a list or a blockquote | 36.6% |
| It holds a non-ASCII byte | 1.4% |
| It would acquire a block, is one word, or has odd whitespace | 0.9% |

**Those shares are not what a slice buys, and reading them as though they were
is the mistake this section has now made twice.** A container paragraph is
refused before it is examined at all, so most of that 36.6% would simply be
refused for inline syntax the moment containers were allowed. Measured at
`3dbf9d3` by actually relaxing each rule -- "containers allowed" means
descending into `block_quote`/`list`/`list_item` and applying the same
predicate to the paragraphs inside; "inline allowed" means treating the
`inline token` verdict as eligible and changing nothing else, which is a
**ceiling** rather than a reach, since A2 still has to handle each construct it
admits:

| | Eligible | Change |
| --- | --- | --- |
| A1 today | 536 (10.6%) | |
| Containers allowed | 616 (12.2%) | **+80** |
| Inline allowed (A2's ceiling) | 3,083 (61.1%) | **+2,547** |
| Both | 4,352 (86.2%) | **+3,816** |

So A2 is worth **thirty times** what the container slice is worth, which is the
opposite of the ordering the refusal table suggests.

An earlier version of this table published 674 / 1,084 / 1,290 for these three
rows. Those came from a scratch script whose relaxation definitions were never
written down and could not be reproduced, so they are withdrawn rather than
silently replaced -- which is the whole reason the definitions are spelled out
above. The inline row is a ceiling besides, since a real inline grammar admits shapes this
approximation cannot. And both together still leave three paragraphs in four
refused, which is the number to weigh before any of this becomes a visible
prose-wrap policy.

Two corrections to earlier drafts of this section, both worth keeping because
both were confidently stated:

- It first reported **2.2%** and **7.9%**, from a hand-written predicate over a
  different set of files. Neither figure describes the predicate that shipped.
- It then reported containers as the *larger* half at 46.1% against 41.7%, and
  concluded that the usual framing is inverted. That was measured over a glob
  that swept untracked offload notes, which are unusually plain prose. On the
  tracked set the ordering is the ordinary one. The probe now reads
  `git ls-files`, so its input set is the commit's rather than whatever is
  lying in the checkout.
- Corrected again, and this is the interesting one: even with the right file
  set, it read refusal *shares* as though they were what a slice would buy.
  They are first-match counts. Relaxing the rules one at a time gives the table
  above, and it says A2 is worth four times the container slice rather than a
  third of it.

### A2 is five slices, and Unicode is the last of them

Agreed 2026-09-18. The figures are the A2 pricing spike's, measured at
`f2819822fa033987e86db79143ab8ffecb900a35` -- the same commit
`harness/probe_secondary_grammar.py` audits, so the two sets are the same 102
files and the same 5,065 paragraphs. That denominator is not the 5,048 above,
which was measured at `3dbf9d3`; the percentages are the comparable half. The
spike's own write-up is `docs/a2-inline-price.md`, which carries the histogram,
the bucket definitions and the block-safety diagnostic this table compresses;
the per-paragraph classifications stay on `archive/spike/a2-price` as
`E2-COVERAGE.json`, being 1.2 MB of generated measurement. Everything this
section relies on is restated here, so neither has to be read to use the table.

The ceiling in the table above held. Of the 2,553 first-match `inline token`
refusals, **2,532 hold nothing outside the safe inline subset**, so a real
inline grammar reaches 3,068 paragraphs where treating every `inline token`
verdict as eligible predicted 3,089 -- an approximation that overshot by 21.

| Slice | Scope | Eligibility ceiling |
| --- | --- | --- |
| A1 today | plain words, block grammar alone | 536 (10.6%) |
| **A2.0** | parse and retain an inline CST beside the block tree; nothing reads it | 536, deliberately unchanged |
| **A2.1** | code spans, links and autolinks, each protected whole; ASCII only | 1,372 (27.1%) |
| **A2.2** | emphasis and strong, delimiters attached to adjacent atoms; ASCII only | 2,163 (42.7%) |
| **A2.3** | non-ASCII atom content; ASCII space and newline stay the only gaps | 3,068 (60.6%) |
| A2.4 | escapes, entities, images, reference links, strikethrough | +17, and it should not delay the others |

**This table is the pricing spike's, and no implemented measurement belongs in
it.** Every figure above came from one diagnostic, over one corpus, under one
definition of the walk, and its value is that the rungs are comparable *to each
other*. A number produced by a different program over a different corpus is not
a better version of a cell here; it is a different quantity. Putting the two in
one cell invites exactly the comparison that warning is trying to prevent, so
A2.1's measured eligibility is recorded separately under **What A2.1 actually
admits**, further down, and these cells are left as the historical record they
are.

Making the two genuinely comparable would take a rerun of **both** policies over
one frozen corpus with one walk definition. Nobody has done that, and this slice
did not need it -- what A2.1 had to establish was that what it admits is safe,
which is a property of the implementation and not of the ceiling.

**A2.3 is the decision this ladder records.** 900 of the 2,532 safe-only
paragraphs contain non-ASCII text, and five more have no isolated ASCII gap
outside a protected range. So Unicode is not a detail inside "add the inline
grammar": it is 18 percentage points, more than the whole of A1, and it is the
single largest step on the ladder.

Nothing in the refusal table earlier in this document says so -- non-ASCII is a
1.4% first-match share there. That is the same misreading this section has
already made twice, wearing its third hat: a paragraph that holds both a
non-ASCII byte and an emphasis delimiter is counted against inline syntax and
never examined for Unicode, so the share is a measure of what is refused
*first*, not of what admitting Unicode would buy.

It goes last anyway, and that is a judgement rather than a measurement. A2.3 is
the only rung that adds no new syntax: it widens what an atom may contain while
the gaps stay exactly the ASCII space and newline A1 already recognises. Taking
it earlier would mean proving UTF-8 atom boundaries agree across both runtimes
before there is a single emphasis delimiter to prove them against, and the 900
paragraphs are a uniform tax on the eventual reach rather than a blocker to
anything A2.1 or A2.2 has to demonstrate. **The fact that would change it is a
corpus whose prose is mostly not ASCII** -- this repository's is not, but a
consumer's may be, and for them A2.3 is the slice that decides whether any of
this is usable at all.

### A2.0 is built

`harness/languages/markdown.toml` declares it, `gen_trees.secondary_trees` and
`harness/ts_secondary.mjs` implement it for the two producers, and
`harness/probe_secondary_grammar.py` gates their agreement on all 2,553 audited
ranges. Every reference output and every frozen block tree is byte-identical
across it, and the only change to a committed tree is the added `secondary`
field.

**It is invisible now. It was not when this section first claimed it.** A
secondary parse that found an ERROR or MISSING used to *throw*, and
`web/js/lang.js` calls the attachment on the browser format path -- so a
document whose block parse was clean but whose paragraph text the inline grammar
refused stopped formatting, where before A2.0 it formatted. That contradicted
this section's own claim, and it contradicted the policy
`harness/ts_inject.mjs` has always stated for guest languages: a region that
will not parse stays verbatim and the document is unaffected.

Paragraph text now gets the same treatment, through a **total outcome table**.
Every host range the declaration matches gets exactly one record --
`outcome: "clean"` carrying a rebased tree, or `outcome: "dirty"` carrying none
-- so a dirty range costs that range and nothing else. Totality is the part
worth keeping: it lets a reader tell *no host range here* from *a range I could
not parse* from *a range with no record at all*, and only the third is a
producer bug. Omitting dirty ranges instead would have collapsed the first two,
and A2.1's whole question is per-paragraph. Infrastructure still throws -- a
missing parse table means the declared pipeline could not run, which is a
different claim from one untrustworthy paragraph -- and both producers publish
the complete array or nothing. `harness/fixtures/secondary-mixed.md` holds a
clean-dirty-clean document proving the middle range neither erases the outcome
before it nor stops the walk reaching the one after.

How reachable is it? **Once in 459,888.** Sweeping every `inline` range of every
markdown file under `~/w` that parses cleanly as a block -- 10,346 files -- the
inline grammar refuses exactly one, and it is
`harness/fixtures/secondary-dirty.md`, which was hand-built to be refused. Nor
is the half-typed buffer a route: every one of the 137 prefixes of a
construct-dense test paragraph parses clean, the inline grammar having no
required closers. So this is a correctness defect on a path that real input
appears never to take -- which is an argument about urgency and none at all
about whether to fix it. A state that occurs once in 459,888 is precisely the
one that will be untested and wrong when it does occur.

**What is not established is what it costs to run.** Secondary attachment sits
on the browser's *general* parse path: `web/js/lang.js:99` is reached from
`web/js/markdown.js`, which schedules a reparse when the editor opens and again
after 150 ms of editing quiet. So every inline range in the buffer is parsed on
every reparse, while the rendering caller still consumes only the block tree --
work with no consumer, repeated as the user types. The pricing spike measured
80-300 ms for the candidate ranges of larger files and says in terms that this
is **not** evidence about per-keystroke reparsing; the shipped path is wider
still, covering every matching range rather than the candidates.

No regression has been measured, so this is not a defect yet -- it is the one
claim in A2.0 with nothing behind it. The measurement that would settle it is
incremental main-thread time and input delay with attachment on versus off
during real editing, not another agreement sweep. Worth taking before A2.1
adds a consumer, because after that the cost stops being optional and the
baseline is gone.

> **Corrected, 19 September.** It has been measured, and it is a defect.
> On `docs/onboarding/FINDINGS.md` (199 KB, 594 ranges) `attachSecondaries`
> holds the main thread for **354 ms median / 399 ms max** in one
> uninterrupted synchronous stretch; `parse()` goes 448 ms → 807 ms. 58 of
> 114 tracked markdown files have an attach stretch over one frame. Nothing
> reads the result, and the editor reparses after 150 ms of typing quiet, so
> this is a third-of-a-second stall after every pause for a consumer that
> does not exist. The browser's `parse()` now defaults attachment off.
> `{ secondaries: true }` or `?secondaries=1` opts in, so the attached
> baseline stays reproducible for the measurement. The harness producers
> still attach unconditionally -- that is what keeps
> `secondary grammar: 2553/2553` a measurement of agreement rather than of
> a flag that defaulted into them. `harness/lang_parse.test.mjs` is the gate
> that would fail if the flag stopped working in either direction. A2.1
> turns the flag on when it has a consumer.

Its exit criterion was the browser payload, and the answer is that the inline
table ships as its own asset, fetched only by a document that holds an `inline`
node -- 43 KB gzipped against the 50 KB of markdown's own block table, so
bundling them would have very nearly doubled what every markdown page loads.
`web/README.md` records the measurement and `harness/ts_secondary.test.mjs`
holds the loader to it, because the probe compares the CSTs the two producers
build and cannot see a fetch that does not happen.

### A2.1's three decisions, and the two checks that overturned them

Agreed 18 September, after counting rather than reasoning. Each question was put
with a recommendation and a named fact that would change it; two of the three
facts held, and changed it.

**Code spans and links go in together.** The argument for deferring links was
that a link has interior structure -- `link_label`, `link_destination`,
`link_title` -- and a destination that must never break at a gap. That argument
is wrong: protecting a link whole is the *identical* operation to protecting a
code span whole. One contiguous range from the secondary CST becomes one atom
and the walk does not descend, which is the same line of code for both. Links
are 22 of the 836 candidates, so the payoff was never the question.

What the measurement did find is a capability A2.1 needs regardless. A1's
widest atom across the whole repository is **24 bytes**, and not one exceeds
40, so an unbreakable atom wider than the wrap has never occurred. Code spans
introduce it -- 5 of 2,352 exceed 80 columns, the widest 111 bytes -- and links
introduce it at a hundred times the rate: **5 of 21, with a median width of 56
against a code span's 12**. So the over-width atom is forced by code spans
whether or not links are admitted, and admitting links is what makes the case
common enough to design against instead of discovering later.

| Protected range | Count | Median | p90 | Max | Over 80 cols |
| --- | ---: | ---: | ---: | ---: | ---: |
| A1 atom (today) | 10,216 | 5 | 9 | 24 | 0 |
| `code_span` | 2,352 | 12 | 26 | 111 | 5 |
| `inline_link` | 21 | 56 | 102 | 118 | 5 |
| `uri_autolink` | 1 | 126 | 126 | 126 | 1 |

**What the hazard counts are, and are not.** Every figure in this subsection
comes from the pricing spike's *diagnostic*, not from a predicate. It reflows
each candidate paragraph on its own under six gap patterns, reparses it
standalone, and records whether the block CST changed. So it counts **observed
standalone block-shape hazards**, and it has the GFM blind spots
`docs/a2-inline-price.md` names: a paragraph is judged outside the document that
contains it, and only against shapes tree-sitter models. It is a sound lower
bound on where reflow is dangerous and a fair basis for comparing rungs to each
other, which is all it is used for below. It is **not** the set an implemented
A2.1 `refusal()` rejects -- nobody has written that predicate yet, and its
refused set will be measured, not predicted. Read every count here as pricing a
decision, not as a commitment about eligibility.

**Block safety moved into `partition()`, and the heading that said otherwise
is corrected in place below.** A1 answered this question by refusing: `_ACQUIRES`
refuses a paragraph when any atom could open a block, and that cost 30
paragraphs. The alternative was to bind a hazardous atom to its predecessor
inside `partition()`, which would buy those 30 back along with something close
to the 35 hazards A2.1 carries -- at the price of giving the one function that
reads nothing but bytes a dependency on block-parse knowledge, mirrored
byte-exactly in two runtimes.

**A2.1 took the second option, in a stronger form, and the original wording of
this heading -- "Block safety stays in `refusal()`, not in `partition()`" -- was
wrong.** It is left visible rather than deleted because the paragraphs under it
are the record of how the cost was priced, and because the same question will be
asked again at A2.2. What shipped:

- `partition(inline, source, breakable_gaps)` emits maximal source spans
  **between the breakable gaps**, so a gap nobody proved safe stays exact text
  inside an atom. The polarity matters: under a `protected_gaps` argument a
  hazard nobody classified becomes layout by default.
- Two policies, one partition. The **inline** policy marks every gap inside a
  `code_span`, `inline_link` or `uri_autolink` non-breakable, from the secondary
  CST. The **block** policy marks the gaps flanking an `_ACQUIRES` hit, from the
  atom text alone. They are separate functions feeding one set union; the union
  is what makes adjacent hazards a single connected component rather than
  overlapping pairwise merges.
- Refusal did not go away. It is now the fallback for the two hazards gap
  protection provably cannot repair, both recorded below.

**Predecessor-only binding is not enough, and this is the counterexample that
settled it.** At width 80, a paragraph whose protected code span is itself
over-width, followed by a source newline and `--`:

```
source                          merged atom (predecessor-only)   output
`xxx...90 chars...xxx`          "`xxx...xxx`\n--"  " "  "beta"   `xxx...xxx`
-- beta                                                          --
                                                                 beta
```

One paragraph in; a **setext h2 plus a paragraph** out. Binding the source
newline does not move the opener off a line start, it *preserves* it there; the
merged item is indivisible but is not one physical line, and because its first
physical line is over width, `fill` decides the following separator must break
-- which isolates the marker and completes the construct. Reproduced through
both runtimes at `43aa3b9`.

**Bilateral protection repairs it**: both gaps around a hazardous atom, giving
`` `xxx...xxx`\n-- beta ``. The formatter may still break after `beta`, but the
marker line keeps its trailing word and cannot become a setext underline. A
hazardous **first** atom has no preceding gap and fails independently -- `---`
and an over-width word format as a thematic break plus a paragraph -- so the
rule is "both flanking gaps, where they exist", and there is no first-atom
exception. Measured: the right-gap half alone restores the source tree.

**The first-atom policy, stated because nothing stated it.** A hazardous first
atom is *not* refused. `refusal()` has always refused a match in any atom
including the first, so there was no exception to preserve; A2.1 replaces that
with the right-gap half of the bilateral rule, and the paragraph stays eligible
whenever a breakable gap survives elsewhere. Where none does, the verdict is
`single atom`.

> **That cost was overstated, and the correction is recorded here rather than
> quietly applied.** Coalescing needs no *parse* knowledge A1 does not already
> have. The knowledge is `_ACQUIRES`, a lexical check over whitespace-split
> atoms, already used by `refusal()` and already mirrored at
> `harness/prose.mjs:47`. It reads no CST. Both options consult the same rule
> and differ only in what they do with it -- refuse the paragraph, or bind the
> atom to its predecessor. What coalescing *does* cost is a representation:
> `partition()` emits strictly alternating atom/gap children and the runtime
> checks they abut, so a gap that must never break has no shape in the package
> format or either runtime. That is real work, and a different objection from
> the one this paragraph made.
>
> An earlier wording here called `_ACQUIRES` a *byte* regex. It is not: it is
> compiled from a `str` with `re.UNICODE`, raises `TypeError` on a `bytes`
> input, and its `\d` matches Unicode `Nd`, so `١.` matches. That is
> unreachable today only because the ASCII decode and the `SAFE` walk run
> first. It is also **prefix-matching**, not anchored: `1.2`, `-foo` and
> `0.5.1,` all match, so version numbers and ordinary sentence-final figures
> count as block-openers. Neither fact changes the argument above -- the check
> is still lexical -- but both inflate any count taken from it.

> **Contradicted, 19 September, and left open rather than papered over.** This
> heading and `docs/a2-inline-price.md` specify *opposite* mechanisms for the
> same slice. The pricing report scopes A2.1 as "select only gaps which also
> preserve the block parse, **coalescing across hazardous ones**", and calls
> block-safe coalescing "already required here". This section says block safety
> stays in `refusal()` and defers coalescing to A2.2. Both statements landed in
> the same thirteen commits, and a review reading them against each other is how
> it was found.
>
> It is load-bearing, not cosmetic: the ceiling above -- A2.1 at 1,372 / 27.1%
> -- keeps the 35 hazardous paragraphs under coalescing and loses them under
> refusal. That is why the column is headed *ceiling* and not *total eligible*.
>
> **The honest state is undecided.** The measurement that appeared to settle it
> does not discriminate between the two mechanisms: the diagnostic counts
> standalone block-shape hazards, and both refusing a paragraph and coalescing
> its gap remove exactly the same hazards from the output. A2.1 should build the
> predicate first, measure what it actually refuses, and settle this against
> that number. If it lands near 35, refusal is right and cheap; if it lands much
> larger, `partition()`'s lexical purity is being bought at a price nobody has
> priced.
>
> **Resolved, 19 September, in favour of coalescing -- the pricing report was
> right and this section was wrong.** The predicate exists now, and the number
> it was to be settled against was never the deciding one. What decided it was
> a counterexample: refusal and coalescing do *not* remove the same hazards,
> because refusing is unconditional while coalescing has cases it cannot repair,
> and finding them is what the slice was. See the corrected heading above for
> the mechanism, and the two subsections below for the two hazards that still
> refuse.
>
> The measured refusals, over 3,421 top-level paragraphs in 119 tracked files at
> `43aa3b9`: `delimiter row` 3, `fence opener` 1. Not 35, and not 30 either --
> the hazard the pricing diagnostic counted is now mostly *coalesced* rather
> than refused, which is exactly the outcome the ceiling column was hedging.

**The format-pass benchmark that priced Option C was retired with A2.1.**
`harness/bench_format_pass.{py,mjs}` measured a counterfactual postcheck --
admit the hazardous paragraphs, format, rescan line starts, re-project and
format again -- and found the document-level trip rate to be 0/114 at width 80
and 0/114 at width 40. A2.1 settled that question a different way: bilateral
gap protection makes the hazardous paragraph safe *before* layout, so there is
no second pass to price. The harness went with it, because its positive-trip
control depended on the `block acquisition` verdict A2.1 retires -- the control
source now classifies as `single atom`, so the benchmark could no longer reach
its own report, and a benchmark whose control cannot pass reads as coverage it
does not provide.

The measurements are not lost: `.ai/reviews/a2/q30/report.md` carries the full
write-up, the controls and the raw numbers, and it is tracked. Rebuild rather
than resurrect if A2.2 needs a format-pass clock; its arms would be different
ones.

The fact that would have changed it was A2.2's hazard rate: if emphasis pushed
it to roughly a fifth of the slice, a predicate rule would be one written to be
deleted. It does not. Emphasis is **10.5% hazardous** on its own increment (83
of 791) and **7.3%** cumulatively (118 of 1,627), and the rate then *falls* to
5.5% once A2.3 admits non-ASCII. Two and a half times A2.1's rate is a real
rise and not a reason to build the harder mechanism first. Revisit it at A2.2
with the same count, not earlier.

**The corpus cannot gate this, and adding files to it would not help.** This is
the one that inverted completely. The recommendation was to harvest real hazard
paragraphs into `corpus/src/markdown` so those 35 would acquire a prettier
reference, since only 11 of the 836 candidates are in the gated corpus at all
and none of the 35 is.

The reference does not exist to acquire. `harness/languages/markdown.toml` pins
`prettier@3.9.6` with no `--prose-wrap` flag, so the reference is generated at
prettier's default `proseWrap=preserve` -- and the generated
`markdown__prose_wrap@40.txt` is byte-identical to its source, as is
`markdown__links@40.txt`. A reference
that reproduces its input cannot say whether a reflow is correct. Worse, every
paragraph A2.1 reflows would register against it as a divergence needing a
ledger entry, so harvesting hazards into the corpus manufactures exactly the
accepted-divergence rows the manifest already carries one of. Flipping the pin
to `always` is not the escape: roadmap step 2 measured it at 27/32 agreement
falling to 8/32, with gate 3 rejecting 20 reference outputs.

## What A2.1 actually admits

Measured by `harness/probe_prose.py` over the tracked, cleanly-parsing markdown
files in this repository, **at commit `019b79b`** -- 140 tracked files, 139 of
them parsing. **Not comparable to the ceiling table above**, for the reasons
given there: different corpus, different program, different walk.

The commit stamp is load-bearing. The corpus is `git ls-files '*.md'`, so every
commit that lands a markdown file moves every row, and an undated table here is
wrong by the next merge rather than by the next quarter. Re-measure with
`./harness/probe_prose.py`, whose summary line carries the eligible count and
the file count; the full histogram is the same walk over `prose.reasons`.

**This file is itself in the corpus, so the stamp names the commit the figures
were taken at rather than the commit that carries them.** Restamped at
`019b79b`, where eleven tracked review notes joined the corpus: the file count
moving 128 to 140 is the kind of discrepancy the last paragraph says to
explain rather than excuse, and that is the explanation.

An earlier version of this paragraph claimed there was no fixed point to
reach, which is **false** and was corrected on 2026-09-20. Measured: replacing
`1,543` with `9,999` in this file and reparsing left its own histogram at 43
eligible and 52 `inline construct` exactly -- **replacing the numeric cells of
this table preserves its histogram.** That is the narrow claim and the only one
the measurement supports; editing the prose around the table can and did change
eligibility. So the numbers here can be brought current whenever someone runs
the probe, and the stamp records when that last happened rather than an
impossibility.

Any discrepancy against a fresh run is therefore a real measurement, and it
wants explaining rather than excusing -- most often by markdown files landing
since the stamp, which the file count will show.

| Verdict | Paragraphs |
| --- | ---: |
| `inline construct` -- A2.2 and A2.4 shapes | 1,775 |
| eligible | 1,601 |
| `non-ascii` -- A2.3 | 360 |
| `byte` | 24 |
| `single atom` | 23 |
| `fence opener` | 6 |
| `whitespace run` | 4 |
| `delimiter row` | 3 |
| `edge whitespace` | 2 |
| `dirty inline parse` | 2 |
| **total reaching the walk** | **3,800** |

The figure that matters for safety is not 1,601 but **9**: the paragraphs
refused by the two hazards coalescing cannot repair, `fence opener` and
`delimiter row`. Everything admitted survives phase A's reflow-and-reparse
invariant.

**`fence opener` moved 1 -> 6 when seven done-notes joined the corpus**, which
is the most useful thing this re-measurement says. The refusal was found on a
single real paragraph and could have been read as a curiosity of one file; five
more arrived in the next seven markdown files to land, all of them prose about
fenced code. It is a shape that ordinary technical writing produces, not an
adversarial one.

At the previous stamp (`a14f19c`'s corpus, 119 files, before A2.1's own fixture
and these notes) the same walk read 1,442 eligible of 3,430, with `fence
opener` at 1 and `single atom` at 21. A1's predicate measured **566** there
against the ceiling table's 536 -- that gap, on the one rung where both numbers
purport to describe the same shipped thing, is the cleanest illustration of why
the two scales are not one scale.

### Is the non-prefix hazard class closed?

The two refusals above are both instances of one class: a block construct whose
interpretation depends on something other than the line's **prefix**, so that
protecting the gaps around an atom cannot control it. Bilateral protection is
sound exactly against prefix hazards. The question A2.1 has to answer is whether
any member of that class is left unhandled.

**For A2.1's admitted set, yes -- closed.** Enumerated against CommonMark and
GFM, a block opener can depend on:

- **The preceding line.** Setext headings and GFM tables. Setext is modelled by
  the pinned block parser, so such source never arrives as a paragraph. GFM
  tables are the real blind spot -- the delimiter row converts its predecessor
  into a header -- and the pipeless one-column case is `_DELIMITER_ROW`.
- **The remainder of its own line.** Fences, thematic breaks, ATX headings, list
  markers, HTML block starts, link reference definitions. Thematic breaks are
  neutralised by coalescing or already parsed in the source. `#`, `>`, `+`, `*`
  and `_` are refused or disjoint from the three admitted constructs. Lists are
  caught conservatively through their marker. Link definitions cannot interrupt
  a paragraph, and their `[` shape is disjoint from an admitted `inline_link`.
  **Fences are the only admitted shape whose invalidating suffix can be
  removed**, and they are `_FENCE`.
- **Later lines or parser state.** HTML block termination, fence closing, list
  continuation and tightness. None can newly *start* from A2.1's boundary set.
- **Blank lines and indented code.** One space/newline flip cannot manufacture a
  blank line, and whitespace runs are refused outright.

**This is not a theorem, and it expires.** It is a closure argument over *the
shapes A2.1 admits*, and it must be re-audited the moment A2.2 admits new
protected shapes -- emphasis and strong delimiters change which characters can
reach a line start, and the enumeration above assumes they cannot. Treat the
list as a checklist to re-walk, not as a result to cite.

The fence entry is worth one further note, because it is the one the argument
got wrong first. `_FENCE` was originally anchored at column zero on the
reasoning that a line start inside a verbatim atom was a line start in the
source. That is true of the prefix and false of the line: an indented fence
opener is still a fence. The fix is not CommonMark's three-space bound either
-- measured against the pinned grammar, four or more spaces corrupts as an
`indented_code_block` instead -- so the rule refuses the run at any indent, and
`prose-admitted.md` carries the discriminating case that keeps it from becoming
a rule about whitespace.

So A2.1 is proved the way A1 was, by the repository sweep in
`harness/probe_prose.py` -- which is where 98.7% of the evidence lives anyway.
Corpus files would still earn gates 0 through 3, which are reference-free and
compare the two runtimes to each other rather than to prettier; what they cannot
earn is an agreement number. That distinction is worth stating because the
scoreboard everyone reads is the agreement one, and for prose it is structurally
silent.

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

Each atom is a `prose_atom` **leaf** carrying its exact source text; each gap is
a `prose_gap` leaf carrying its exact original whitespace.

An earlier version of this document required an interior wrapper around every
atom, reasoning that leaf `text` bypasses rule dispatch so a `verbatim` rule on
a leaf would never invoke its validator. That reasoning is sound and the
conclusion was still wrong, which a measurement settled: `source_partitions`
runs its recursive source check on entering `prose_run`, *before* leaf dispatch,
so a leaf atom whose `text` does not match its range is rejected anyway. The
wrapper bought nothing, and A1 ships leaves. See the A1 implementation note
below.

The `prose_run` contains every atom and gap, in alternating order. Its extent
starts at the first atom and ends at the last. Paragraph terminators and any
leading/trailing layout outside that extent remain explicitly owned by the
host; narrowing the run must not silently discard them. Empty content and
unsupported host shapes retain the original subtree.

The layout portion is expressible today:

```json
{
  "format": "et-doc-rules/3",
  "indent": 2,
  "tokens": [],
  "source_partitions": ["prose_run"],
  "whitespace_nodes": ["prose_gap"],
  "rules": {
    "prose_run": ["fill", "t:prose_atom", ["line"]]
  }
}
```

This fragment is not a complete production package. `whitespace_nodes` consumes
the declared gaps before `fill` sees its child sequence. `source_partitions`
validates the run against source -- every descendant leaf, and the exactness of
the partition -- before either happens. The content atoms are consumed once by
`fill` and emitted as their own text; there is **no `prose_atom` rule**, because
a leaf needs none.

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
Do not synthesize backslashes to make a greedy break legal.

**"Coalesce the adjacent atoms where sufficient; otherwise preserve the
paragraph" stood here, and was too vague to implement.** It is replaced rather
than deleted, because it was broad enough to be true and an implementer
following it could not derive the answer. What "sufficient" means, as shipped:

- Coalesce **both** gaps flanking the hazardous atom, never only the preceding
  one. Predecessor-only binding preserves the opener at a line start instead of
  moving it off one; the counterexample is above.
- Coalesce by removing gaps from **one set**, so adjacent hazards become one
  connected component.
- "Otherwise preserve the paragraph" is the right fallback, and it is reached in
  exactly two cases, neither of which coalescing can repair:
  - a **last atom** spelling a GFM one-column delimiter row, which makes the
    *preceding line* a table header -- a line still set by gaps further left;
  - a **fence opener** at any line start the output can produce, because a
    fence's validity depends on the rest of its line, so truncating a line can
    turn a non-opener into an opener.

The second was found by `probe_prose.py`'s phase A on a real corpus file, not by
this list, and it is the counterexample to the tempting argument that a line
start inside a verbatim atom is safe because it was a line start in the source.
Its prefix is safe. Its line is not.

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
