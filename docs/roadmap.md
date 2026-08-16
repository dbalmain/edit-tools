# Roadmap: what we are doing about the design review

A design review on 2026-08-15 raised eight points against the formatter as
built. This records the decision on each, with the reasoning, so a later agent
does not re-litigate a closed question or assume an open one is closed.

Status: **now** (in flight) · **next** (scheduled) · **later** (deliberate
defer, with the trigger that reopens it) · **closed**.

---

## 1. Black's habits were living in the runtime — **now**

The runtime owns comment attachment on purpose: getting it wrong loses code, so
no package decides it. But it also owned comment _style_: two spaces before a
trailing comment (PEP 8) and a two-blank-line ceiling next to a comment
(black's). Both are per-language facts, and seven of sixteen roster languages
reference prettier, which writes one of each.

Fixed as two header fields, `comment_gap` and `blank_cap`, defaulting to 1 with
`packages/python.json` setting 2. Counts rather than strings, so no package can
put arbitrary text in the output — the linearity invariant as a schema decision.

**Expect this list to grow.** Every prettier-referenced language in rounds 2–4
is a chance to find another runtime constant that is really a language fact. The
test is: _could a package have wanted it different, and is it safe to let one?_
Style is safe; anything that can drop or reorder a token is not, and stays in
the runtime where the invariant can see it.

## 2. `Doc::forced()` is recomputed in Rust and cached in JS — **closed**

`DESIGN.md` described this as idiom. It is a complexity difference: `forced()`
walks its whole subtree on every call, from both `print` and `fits`, once per
group. JS computes the same fact once per node at construction.

Offloaded with the measurement demanded _before_ the fix, and a committed
benchmark so the claim stays checkable. If the numbers say it does not matter at
realistic sizes, the correct outcome is to fix the sentence and change no code.

The general lesson is the one worth keeping: the corpus is fifteen small files
per language, so **no performance claim in this project is currently backed by a
measurement.** "Good performance" is an untested goal.

**Answered, and the half that was wrong is the useful half.**
`harness/bench_break_propagation.py` re-runs it. Flat size was already linear in
both runtimes and did not move (8,192 nodes: Rust 7.97 → 8.11 ms). **Depth** was
the axis: at depth 56 Rust went 1.060 → 0.186 ms, from 1.8× slower than JS to
2.7× faster.

Two things to keep from it. First, the guess named the right defect and the
wrong axis, which is exactly why the brief demanded measurement before the fix.
Second, **both runtimes are still superlinear in depth**, because `fits` rescans
— the fix removed Rust's extra penalty, not the shared one. That is now a
measured number rather than an assumption, and it is the thing to watch if a
deeply-nested real file ever gets slow.

The fix is a printer-local prepass rather than a cached field on the `Doc` enum:
a field can be left stale by direct variant construction, and a prepass over the
finished tree cannot be forged. Worth remembering as a pattern — it is the same
instinct as the linearity invariant, which is enforced by making the wrong thing
unreachable rather than by discipline.

## 3. Packages are silently coupled to a grammar version — **later**

A package's rule table is written against one grammar's node-kind inventory. The
manifest pins the grammar for the _harness_, but the shipped package carries no
record of what it expects, so a grammar bump surfaces as a refusal on an
innocent file with no hint that package and tree disagree about the grammar.

Deferred: nothing downloads packages yet, so the failure has no victims.

**Trigger to reopen:** the first time a package is served to something that did
not build it, or the first grammar bump on a merged language — whichever comes
first. Not later than that, because the fix (a grammar stamp in the header, name
plus version or a hash of the kind inventory) is cheap now and a format-version
migration afterwards.

## 4. "Kept honest by differential fuzzing" is kept honest by 30 files — **later**

`docs/design.md` names the Doc renderer as one of the two places divergence risk
concentrates, and it is the one that exists today. It is also cheaply fuzzable
with no parser and no corpus: generate random well-formed Docs, or random
well-typed rule expressions over random toy trees, and assert both printers emit
the same bytes.

Deferred in favour of adding languages, which is the better use of the same
hours: every language is an independent probe of the same runtime, and rounds
1–2 have already produced findings a fuzzer would not.

**Nothing is being done that forecloses it**, which was the condition. The two
runtimes have no shared code, the Doc IR is small and total, and the toy-package
fixtures in both suites are already the shape a generator would emit into.

**Trigger to reopen:** the scanner VM (the other named risk), or the first
Rust/JS divergence found by a language round rather than by a test — that would
be direct evidence the corpus is not dense enough.

## 5. The "cannot do" list mixes three different costs — **next**

`DESIGN.md` lists what the design cannot do, which is the most valuable section
in it. But the entries are not the same _kind_ of limit, and lumping them
together makes cheap wins look as expensive as the expensive ones. There are
three piles, not one.

### Pile A — a static test on the node, with a static answer

Cheap. `when` already exists; the only predicate is `["count", sel, n]`. Some
"cannot do" entries need nothing more than a second predicate.

**Worked example — both JSON divergences.** Prettier prints an array whose
elements are _all_ arrays or objects one-per-line regardless of width, so
`"matrix"` explodes at width 88 where we keep it flat and it fits. That is not a
layout choice needing measurement; it is a property of the children, known
before printing. With one predicate — say `["all", sel, [kinds]]`, true when
every `sel` child's type is in `kinds` and there is at least one — the rule is
ordinary:

```json
"array": ["when", ["all", "named", ["array", "object"]],
  ["seq", ["tok", "["],
    ["indent", ["hard"], ["each", "named", ["seq", ["tok", ","], ["hard"]]]],
    ["hard"], ["tok", "]"]],
  <the current width-driven rule>]
```

`hard` instead of `line`/`soft` is the whole difference: always broken rather
than broken-if-it-does-not-fit. No printer change, no new opcode class, and the
predicate is as inspectable as `count`.

**Reopened by `fill`, but deliberately not folded into that slice.** The
predicate now buys something measurable beyond the `matrix` house-style choice:
it is the only honest way to select numeric-only arrays for fill. Applying fill
to every JSON array fixed `long_flat_array` but regressed the mixed
`scalars.json`, taking agreement from 4/6 to 2/6. With `all`, the package can
choose numeric fill, container explosion, and the ordinary array rule without
guessing from corpus-specific counts. That is a separate local feature and a
separate decision.

Pile A remains the right _classification_ — these limits are cheap to lift when
we want them lifted. What changed is the assumption that cheap therefore means
now.

### Pile B — `fill` — **built**

A printer primitive, well understood, linear cost, and the thing prettier uses
to put several numbers on a line rather than one per line (the second JSON
construct, `long_flat_array`). Built on 2026-08-17 after CSS priced it: **+365 B
gzip** across the hand-written JS runtime, with a byte-identical Rust mirror.
The opcode is `["fill", sel, sep]`, parallel to `each`; its separator chooses
flat or break independently per line. CSS opted in on 2026-08-17: declaration
`font-family` lists and hanging space-separated call lists, behind existing
`count` tests. Agreement 11/30 → 18/30; 7 of 19 accepted divergences resolved.
Stage D's 9/21 was optimistic — `calc`'s last `minmax()` and `--list`'s
comma-groups are not this fill. JSON still cannot opt in: its grammar uses one
array node type for numeric, string, mixed and container arrays, and the current
predicate set cannot prove that every element is numeric.

### Pile C — trying two layouts and picking one

`conditionalGroup`. Genuinely expensive: it makes printing potentially
superlinear and it is the one that has to be got right in two runtimes
identically. This is where "wrap the RHS in parens only if wrapping makes it
fit" lives (`strings.py@88`), and `kitchen.py@60`, where black breaks into a
call's arguments and we parenthesise the whole condition.

**Keep refusing it** until a language round produces evidence that a
majority-case construct needs it. Two Python files at one width is not that.

**Action:** split the `DESIGN.md` list into these three piles and reclassify
each entry. The reclassification is the deliverable — pile A entries are then a
normal backlog item rather than a documented limitation.

## 6. Markdown, and languages that contain languages — **next**

Markdown was missing from the roster and is now the most important language on
it, because of the requirement that JavaScript inside a ` ```javascript ` fence
be formatted and highlighted as JavaScript.

Designed in `injection.md`. The short version: one optional `language` field on
a node, a package _map_ instead of a single package, `indent` carrying its own
column count instead of the printer taking one global `tab`, and **no new
opcodes**. Degradation for unparseable or unsupported snippets lives in the
harness and the package (`verbatim`), so the runtime keeps its refuse-rather-
than-guess rule intact.

The two runtime slices have landed: `Indent` carries its own amount, and the
formatter now takes a language-to-package map with optional `language`
boundaries on nodes. Each boundary binds a formatter to that region's package,
so nested switches restore the enclosing package without mutable language state.
The CLIs load every language named by the tree.

A missing formatter package is a refusal that names the language. This is
deliberately opposite to the highlighter, which degrades to empty tables so it
can keep walking and resume painting at a nested known language. Layout bytes
cannot be guessed safely; missing colour can. Unsupported or unparseable
formatter regions still degrade one layer out, by the harness declining to stamp
`language` and the package using `verbatim`.

Harness splicing has now landed too. Guest info-string aliases and host
node/info/content shapes live in manifests; `gen_trees.py` parses clean embedded
regions, rebases every byte offset onto the outer source, replaces the host
content node with the guest root, and stamps that root. Unsupported and dirty
regions stay ordinary host content. `probe_injection.py` proves the policy with
markdown + JSON through both runtimes without adding markdown to scoring.

The gates now cross the boundary too, and the check that established this is the
reason the order changed. Gate 3's generic signature was **blind to the inside
of a fenced code block**: tree-sitter-markdown's block grammar gives
`code_fence_content` one empty `block_continuation` per line and no leaf holding
the text, so replacing a JSON body with `TOTAL GARBAGE, NOT JSON AT ALL` scored
as identical. Non-destruction now means the _guest_ language's notion of
meaning, checked by the guest's own gate 3 through the same manifest routing the
splicer uses; an unroutable region falls back to exact bytes, because that is
what `verbatim` promised. Gate 2's second pass calls `gen_trees.parse_doc()`
instead of a private reparse, so idempotence across a boundary is idempotence.

Remaining for this point: the ordinary markdown onboarding round—its real
manifest, package and corpus—landing on gates that can now see what it does.

## 7. Is the tree interface actually independent of tree-sitter? — **closed, yes**

The plan of record for Aven (no tree-sitter grammar, round 6) is to have its own
parser emit a tree the runtime consumes. That rests on an untested assumption,
and it was scheduled _last_ — after fifteen languages of decisions have piled on
top of whatever the answer is. A late "no" is the most expensive possible
timing.

Pulled forward as a side experiment: hand-roll a JSON parser that is not
tree-sitter, feed the unmodified `packages/json.json` through both runtimes, and
require byte-identical output against the committed tree-sitter path. The
deliverable is the report — specifically, the list of things the runtime
requires that a parser author would not guess, which is a specification that
does not currently exist anywhere.

**Answered: yes.** [tree-interface-probe.md](tree-interface-probe.md) has the
evidence, and `./harness/probe_tree_interface.py` re-runs it. A hand-rolled
parser produced byte-identical trees and byte-identical output through both
unmodified runtimes and the unmodified JSON package. **No runtime change was
required**, and the runtime names no tree-sitter concept — `named` is the
package's `tokens` list, not tree-sitter's flag.

Three things leak, two of them harmlessly: punctuation whose type is its own
spelling, and whitespace as gaps rather than child nodes. Both are conventions a
bespoke parser can simply honour. Two guesses in the brief were wrong — children
need **not** tile their parent (gaps are exactly how whitespace is represented),
and field names elsewhere are package vocabulary rather than a runtime
requirement.

The silent one is worth remembering when Aven arrives: **a parser that carries
comments as trivia rather than as children loses them, and the runtime does not
complain.** Gate 3 catches it; nothing earlier does.

### What the probe found on its way past: `flatten` hardcodes three field names — **closed**

`flatten` walks `left`, then consumes `left` / `operator` / `right`. Those three
strings are in `rust/src/eval.rs` and `runtime-js/bundle.js`, not in the
package. A grammar that calls them `lhs` / `rhs` / `op` is refused, and **no
package can fix it** — the probe demonstrated both halves.

This is the same defect class as point 1: a language fact living in the runtime
where no package can reach it. It is worth doing before thirteen more languages
land on the opcode, and the fix is the same shape — the names belong in the
package header next to `precedence`, which is already the home of the other
`flatten` input.

Deliberately **not** applied by the probe agent, which was right: a central
change has to be re-decided against the whole roster anyway, and a precise
description costs nothing to apply.

**Done.** `flatten_fields` sits in the package header next to `precedence`,
defaulting to today's names, so `packages/python.json` is unchanged.

The build agent rejected the more expressive alternative — three operands on the
`flatten` opcode — and the argument is worth keeping: operands only pay for
themselves if one package has **two left-nested spines with different labels**,
and nothing on the roster does. Python's `comparison_operator` looks like the
second shape and is not one; it is a flat operands list that `each` already
formats. The general rule it illustrates is that expressiveness nobody on the
roster needs is a cost, not a hedge.

`harness/probe_tree_interface.py` grew a third arm: the renamed `lhs`/`op`/`rhs`
tree is still refused by a package that stays silent, and formats identically in
both runtimes once the package declares the names. That arm is what
distinguishes "the runtime cannot express this" from "this package did not ask
for it", and it is the independent check that the fix works rather than merely
compiles.

## 10. Intentional divergence is not representable — **closed**

_Raised 2026-08-16 by the house-style decision, not by the review._

[house-style.md](house-style.md) makes some divergences from the reference
**deliberate**: the tie-break when we differ is readability and then consistency
across languages, because the product is a snippet in a box rather than a CI
formatter. That is a goals-level change and the harness cannot express it.

**The common case is not a house rule — it is declining to chase an edge case.**
`house-style.md`'s operative instruction is that a package should not grow
special cases to match a reference's quirks, because every rule costs bytes, a
concept, and a place for a bug. That decision produces divergence, and the
divergence is correct.

Today the scorer reports one agreement number and `review-brief.md` sets a 70%
floor with an instruction to be suspicious of a package that beats its
reference. **So the scoreboard actively pressures a stage-C builder toward
exactly the edge-case rules we are telling them not to write**, a stage-D
reviewer following the brief would file that restraint as a defect, and nothing
records the reasoning, so the next agent re-litigates it.

Needed: divergence declared per language with a reason, reported separately by
`score.py`, with the 70% floor applying to unexplained divergence only — plus a
staleness check, so a declaration that has quietly become true fails loudly
rather than rotting into a suppression list.

**"Not worth the bytes" must be a first-class, respectable reason there.** It
will be the most common one.

**Built.** `intentional_divergences` in the language manifest, at
**file-and-width** granularity — so a divergence at one width cannot hide
agreement at the other — with a mandatory non-empty reason. `score.py` now
reports three numbers: agreement, intentional, and unexplained. The merge bar in
`review-brief.md` applies to unexplained only, and stage-D reviewers are
directed to judge an intentional divergence on its stated reason.

Reasons stayed **free text**. A controlled vocabulary was rejected because
house-style rules have no stable identifiers yet, and minting them inside the
harness would create a second rule registry competing with
[house-style.md](house-style.md). Revisit if reasons start degrading into
"matches our style".

I tested the staleness guard in both directions rather than trusting it, because
this is the first mechanism here whose purpose is to make a number look better:
declaring a file that actually agrees fails with
`declaration for basic.json@88 is stale: output now agrees with the reference`
and exit 1; declaring the real `nested.json@88` moves it to intentional and the
per-width split tracks the two widths separately. Nothing is declared for the
current corpus — 0 intentional, 6 unexplained, agreement unchanged.

This file-and-width mechanism was later replaced by point 11's content-addressed
ledger. It remains here as the history of the weaker mechanism and why the
three-way reporting exists.

This is a central change and it belongs on `main` before round 2 opens — not
because every language will have house rules (they will not; the container rule
is deferred) but because every language will have places where matching the
reference costs more than it is worth, and there is currently nowhere to say so.

## 8. The highlighter is 0% derisked — **now, pilot in flight**

The project is named for two halves and only one exists. Everything built, and
everything the fifteen-language exercise measures, is the formatter.
`docs/design.md`'s own table argues the two halves have opposed requirements
(error tolerance, viewport-only, incrementality), which is exactly why formatter
progress transfers almost nothing.

It is also the half a web editor hits on every page load, where the formatter is
hit on save.

**Decision: design before delegating.** A highlight package format is a new data
format that fifteen languages will inherit; committing one to a cheap builder
before it has a design is how the gate-3 trap in round 1 happened, one layer up.
The scoping questions to answer first:

- One package per language or two? `docs/design.md` calls this open. Injection
  (point 6) argues for one _tree_ representation shared by both; it says nothing
  about one _download_, and the download question has a real trade-off (two
  requests versus wasted bytes for viewers who never format).
- Is a highlight package a capture table (`node type → scope`), and is node type
  alone enough — or does highlighting need the context that formatting
  deliberately does without?
- What is the differential-testing story? Byte-identical output is the
  formatter's bar; the highlighter's equivalent is an identical span stream, and
  the corpus and scorer already exist to carry it.
- Error tolerance is the hard one. The formatter refuses a tree with an `ERROR`
  node. A highlighter must colour it anyway, and no part of the current design
  says how.

A pilot over JSON and Python, both already merged, would answer all four without
touching the roster.

**Designed: [highlight-design.md](highlight-design.md).** Two packages per
language, one tree, no query engine. `et-highlight/1` is a leaf table plus an
ordered context list keyed on parent and field, first match wins.

The load-bearing answer is that **type-only dispatch does not survive contact
with `identifier`** — 632 occurrences in **56** distinct `(parent, field)` roles
across the Python corpus, with `assignment/left`, `call/function` and
`attribute/attribute` all wanting different colours and all being the same node
type. Checked against the committed trees rather than taken on trust. A query
engine is not the fix; Lezer showed the middle, and because our CST carries
fields, its paths collapse to a table.

There is **no reference highlighter, and the paper argues there should not be
one**: Helix, nvim, the grammar repos and Lezer already disagree, so adopting
one is adopting a taste rather than a ground truth. Gate 4's replacement is
Rust/JS span identity, committed goldens, and a partition invariant.

Two corrections to the framing above, both accepted:

- **Question 4 was the wrong question.** It is not "how does the evaluator skip
  `ERROR`" but "this evaluator is the wrong shape". Cursor, consumption, refusal
  and comment attachment all exist because a wrong layout byte is corruption; a
  wrong colour is not. One walker with a mode flag "will make the formatter
  timid and the highlighter precious".
- **Linearity does not transfer as consumption — the invariant behind it does.**
  The formatter's best idea is not "consume every child", it is _make the wrong
  thing unreachable, then test the invariant_. For spans the unreachable thing
  is an overlapping or mis-ordered span, and the merge rule is the test.

The 1 ms/keystroke budget was rejected as a package-format concern at all: there
is no parser and trees are frozen, so designing for incrementality now is how
this slice quietly becomes a parser project. That is a real fifth question, for
later.

### Pilot status — PRs 1–3 merged, the bet held

**The design's central bet survived its own falsification test.** `parent` +
`field` + `parent_field` is enough context to colour Python, with no new keys
and no per-name special-casing. The pair that does the work, resolved
first-match-wins:

```
{parent: attribute, field: attribute, parent_field: function} -> function
{parent: attribute, field: attribute}                         -> property
```

A called attribute and a plain one separate **structurally**, which is exactly
what a query engine was supposed to be needed for.

Verified independently of the builder's tests: both CLIs across all 15 corpus
trees, byte-identical spans, 15/15. `python__chains` yields 132 spans, 8
`function` and 10 `property`, and an independent partition check finds no
ordering or overlap violations. `highlight.js` is **1,576 B gzip** against the 2
KB budget — the first measured number for the walker, replacing an estimate.

One case nobody had specified turned out to matter: running the **Python**
package against a **JSON** tree emits 49 spans and exits 0. That is the
never-refuse rule holding under a deliberately wrong package, and it is the
behaviour that makes a highlighter safe to point at anything.

### PR 4 merged — and the golden review earned its keep

Two real packages, four hand-built dirty trees, 19 goldens, and
`harness/score_highlight.py` gating span identity, the partition invariant, and
golden equality. The package test constants are gone; both runtimes read the
shipped files, so there is one source of truth rather than two that agree today.

Two rules changed under review. JSON quotes now **inherit their content's
scope**, so a key is one `property` span instead of three spans disagreeing
about their own delimiters — done with leaf context rows on the `"` token, so
context matching stays leaf-only and Decision 5 holds. And an interior node can
act as a **background**, painting its extent minus its children's, without which
a Python string containing an escape painted only the escape.

The background rule shipped unconditioned and was wrong. It fired on any
leaf-table entry, and tree-sitter lets a named interior node share its spelling
with a token — Python's `lambda` node does, so it painted a bare space as
`keyword`, four times, in goldens that every gate reported green. Backgrounds
are now opt-in: a package author _stating_ that a type wraps its children,
rather than inheriting the claim from a keyword list. See point 11, which this
episode is the evidence for.

**Next: PR 5** (injection degrade). Not started.

### Original plan

**PRs 1–3 launched 2026-08-16** on `wt/hl-runtime`: the `et-highlight/1` loader,
the Rust walker, and the JS walker, taken as one slice because Rust/JS **span
identity** is the hard requirement and one agent holding both runtimes is how
that gets held. PRs 4 and 5 wait for it.

The slice carries an explicit **falsification gate**, and it is the reason PR 2
exists rather than being folded into PR 4. The design bets that `parent` +
`field` + `parent_field` + `ancestor` is enough context to colour Python. If the
`python__chains` walk cannot express `filter` / `order_by` as `function` and
`obj.attr`'s `attr` as `property` with those keys, **the bet has failed and that
is a successful result** — stop, report the case, do not invent a key in the PR
that found the hole. A design that names the experiment which would kill it is
worth more than one that does not.

### Both open questions are now answered

**Dirty trees live in `corpus/trees-dirty/`.** Dave's call, and it matches what
the paper proposed. Keeping them out of `corpus/trees/` means `gen_trees.py` can
stay strict — a tree with an `ERROR` node is still a generation failure for the
formatter — while the highlighter gets the fixtures it needs to prove it never
refuses. The two halves want opposite things from the same directory, so they
should not share one.

**`vici` has no scope vocabulary, and deliberately never will.** Checked: no tag
list, no theme names, no styles. Its README is explicit that it "owns the buffer
and nothing else. It has no rendering, no terminal", and every type in its own
table lists rendering as a non-concern. So there is nothing to rhyme with, and
that is the correct answer rather than a gap — spans are for the host, and vici
is not the host.

But the question has a better target, because **a vocabulary already exists one
repo over**. Aven's LSP legend (`crates/aven-lsp/src/semantic_tokens.rs`) is
eleven standard **LSP semantic token types**: `comment`, `string`, `number`,
`regexp`, `operator`, `variable`, `type`, `function`, `parameter`, `property`,
`keyword`.

Ten of those eleven are already in the paper's proposed Python scope list,
independently. That convergence is worth making deliberate:

- **Align on LSP semantic token type names wherever one exists.** Every modern
  editor already maps them, Aven already emits them, and it costs us nothing —
  we had picked the same words by accident.
- **`punctuation` and `error` are documented extensions.** LSP deliberately
  leaves punctuation to the grammar layer and has no analogue for `error`. Both
  are load-bearing here, so they stay, named as extensions rather than smuggled
  in.
- **`constant` is an extension too.** LSP would express it as `variable` plus a
  `readonly` modifier. Every other highlighting system in the prior art has
  `constant`, so keep the word, but record that it is ours.
- **Dotted scopes must be prefix-refinements of a scope in the same list** —
  `string.escape` is only legal because `string` is also there. That gives a
  host a total degradation rule (truncate at the dot until something is
  recognised) instead of an unknown-tag cliff, and it is checkable at package
  load, next to the existing "every emitted scope must be in `scopes`" check.

The last point is the only one that adds a rule rather than a note, and it is
the kind of rule this project likes: it makes the bad state unrepresentable at
load rather than asking package authors to be careful.

## 11. A difference nobody has looked at is not a decision — **ledger built; HTML next**

Both halves of this project produce differences that need a human verdict, and
neither currently records that the verdict happened.

**The formatter** has a reference, so a difference is measurable. Point 10 gave
it `intentional_divergences`: a file-and-width declaration with a mandatory
reason, three-number reporting, and a staleness check. That check has one hole.
It fires on exactly one transition — a declared divergence that now **agrees**
(`harness/score.py`, the `run.text == expected` arm). It does not fire when a
divergence _changes into a different divergence_. Our output can shift to
something new and the old reason keeps covering it, describing a layout that no
longer exists.

**The highlighter** has no reference by design (Decision 3 — Helix, nvim, the
grammar repo and Lezer already disagree, so picking one is picking a taste). The
golden _is_ the record. Its first draft is the walker's own output, which means
a golden approves whatever produced it.

### The evidence that this is not theoretical

Highlight PR 4 shipped goldens in which Python's `lambda` painted a bare space
as `keyword`, four times, because the interior-background rule fired on a named
node that shares its spelling with a keyword token. Every gate was green.
Identity, partition and golden match all reported 19/19 — the goldens matched
because they were generated from the walker that had the bug.

Two details make it worth remembering rather than just fixing:

- One of the four stray runs **merged into the adjacent legitimate keyword
  span** (`'lambda '`, with the trailing space), so it did not look like a stray
  span in the golden at all. Reviewing the span list against nothing but itself
  could not have found it.
- What did find it was an ad-hoc script comparing spans against the source text
  and printing any span that was entirely whitespace. Nobody had written that
  check. It cost about ten lines.

### The mechanism: a review ledger keyed by content hash

One record per reviewable item:

```
{ id, hash, verdict, reason, reviewed_by, reviewed_at }
```

- **Formatter divergence** — `id = language/file@width`,
  `hash = sha256(our_output + reference_output)`. Hashing **both** sides is the
  point: the judgement was about the pair, so a black or prettier version bump
  must invalidate it rather than silently carrying the old approval forward.
- **Highlight golden** — `id = tree name`, `hash = sha256(spans)`.

Each item is then in one of three states, the same triple both scorers already
report:

- **accepted** — the hash matches a recorded review
- **stale** — a review exists but the hash moved; re-evaluation required
- **unreviewed** — no review at all

Re-evaluation cost becomes proportional to change, which is the requirement. A
run that alters nothing reviews nothing.

**Gating: stale is a hard failure; unreviewed is a threshold**, mirroring the
30% unexplained merge bar. Stale is the dangerous state — it is approval
silently transferred to something nobody looked at, which is precisely what
happened above.

### `reviewed_by` is load-bearing, not bookkeeping

If the same agent generates a change and approves it, the ledger faithfully
records the model agreeing with itself. The hash makes that **auditable**; it
does not make it **true**. The `lambda` goldens would have carried a valid
signature from the author of the bug.

Recording the reviewer costs one field and lets a later rule say that reviews
signed by the agent that produced the diff do not count as coverage. Carry the
field from the start even while nothing enforces it.

### Three elements, not one

The ledger alone repeats the mistake at a higher level — it records that someone
looked, not that looking was capable of finding anything. The working shape is:

1. **The hash** says _what changed_.
2. **Mechanical suspicion reports** say _where to look_: whitespace-only spans,
   spans ending in whitespace, unpainted runs inside code, scopes that fire
   nowhere, divergences whose shape changed category. Advisory, never gates —
   `error` backfill legitimately stains whitespace and Python's `is not`
   legitimately contains it, so there is no invariant here, only attention
   direction.
3. **The reason** records _what was concluded_.

### The human surface: HTML, syntax-highlighted, with the ledger visible

Reading span JSON and unified diffs is why this went unreviewed. The review
surface should be a generated HTML page per run:

- **Formatter**: ours against the reference, side by side, diff-marked and
  syntax-highlighted.
- **Highlighter**: the source rendered _with our spans applied_, which is the
  only sane way to review a span stream.
- Each item carries its state (accepted / stale / unreviewed), and for anything
  previously reviewed, the prior verdict, reason, reviewer and date.

Approval writes to the ledger, and the ledger stays in git so a verdict arrives
as a reviewable diff rather than as state in a browser. Whether the page emits a
pasteable fragment for batch review or approval goes through a small CLI is
open; the page being a _review_ surface rather than a _storage_ surface is not.

**One constraint the `lambda` bug already proved.** A colourised rendering would
**not** have caught it: a space painted `keyword` shows no colour in a
foreground-only theme. The highlight view must make span _boundaries_ visible —
backgrounds, underlines, or a gutter — and not rely on foreground colour alone.
A review tool that renders the output beautifully is the easiest place to hide a
defect in the output.

**And note what this page is made of.** Rendering syntax-highlighted code in
HTML is the product. The review surface is the first real consumer of the
highlighter, which is good — it is dogfooding — and is also why the constraint
above matters: the tool inherits the bugs of the thing it is reviewing, and
renders them as though they were intended.

### Sequencing

After highlight PR 4 merges — it is the substrate, since the golden-match gate
is what the ledger attaches to. The ledger and the suspicion reports come first
and are worth having on their own; the HTML surface follows and is where the
human-review question gets answered properly. Do not build the page before the
ledger it is meant to display.

**Ledger slice built.** Records are one-per-line JSON in per-language files
under `harness/reviews/{formatter,highlight}/`: one verdict produces one stable
git diff and parallel language work does not collide in a shared ledger.
`harness/review_ledger.py` owns validation, persistence, and the three states;
each scorer owns its id and hash input. `harness/formatter_divergence.py` is the
structured pair consumed by both `score.py` and the terminal/JSON viewer in
`harness/review_formatter.py`, so the displayed outputs are the outputs hashed.
Formatter approval is restricted to a current viewer record and requires the
three-way classification, reason, and reviewer. Highlight approval is wired
through `score_highlight.py` and deliberately cannot be combined with
`--update`.

The old manifest declarations were removed rather than retained as a second,
content-blind approval mechanism. Stale reviews fail either scorer; unreviewed
coverage is reported against the 70% stage-D threshold. Existing highlight
goldens remain visibly unreviewed rather than being assigned fabricated
reviewers. The HTML surface and boundary-aware highlight rendering remain the
next slice.

---

## Not raised in the review, but now visible

**Closed 2026-08-16. Round 1's real finding was about briefs, not models.** Two of four builders
independently chose the same weak gate-3 override because the brief never said
an override must be strictly stronger than the default, and `check_gate3.py`
actively certified the weak one as equivalent. The checker now generates five
families of well-formed document mutations, keeps those the generic default
rejects as its oracle, and requires an override to reject every one. It reports
the useful count per language and fails loudly on zero.

The arm also disproved both overrides that motivated the old equivalence check.
Ordered `json.loads` accepted 19 numeric and 18 string respellings; Python's
`ast.dump` accepted 4 numeric and 57 string respellings. Both manifests now use
the generic default. **A checker that can certify a weaker replacement as
equivalent is a defect of the same class as the one it let through**; this one
now plants such a replacement in its unit suite and proves the run fails.
