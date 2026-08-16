# Design findings

The point of onboarding fifteen languages is not fifteen packages. It is this
register: **the capabilities the Doc IR does not have, each one paid for by a
language that could not express something without it.**

Every entry is a decision waiting to be made, and the decision is always the
same shape — _add this and the runtime grows; leave it out and these files never
agree with their reference._ Neither answer is automatically right. A 20 KB
budget and two hand-written runtimes are the reason the second answer is
allowed.

Entries are added by the orchestrator from stage-B and stage-D reviews, and from
anything a builder reports that a package could not reach. **Do not delete an
entry when a language works around it** — the workaround is evidence about the
cost, not a resolution. An entry closes only when the capability is added, or
when it is deliberately declined.

## How to read the cost column

- **Local** — one opcode, evaluated with what the runtime already has at that
  point in the walk.
- **Contextual** — the evaluator must carry state it does not carry today
  (ancestor decisions, a second pass).
- **Global** — the layout algorithm changes shape. Wadler/Oppen is one pass over
  a tree; anything needing measured siblings is not.

---

## 1. Sibling-width alignment

**Status:** open · **Cost:** global · **Languages:** TOML (3 accepted
divergences), Go (expected, stage A in flight)

A rule cannot inspect a sibling's _rendered_ width, so it cannot pad one node to
line up with another. The runtime deliberately exposes no way to do it.

What it blocks:

- TOML and every prettier language: aligning trailing comments into a column.
  Three of TOML's seven accepted divergences are exactly this, and the reviewer
  called the one-space fallback "compact and cross-language consistent" — a
  defensible house style, but a house style, not agreement.
- Go: gofmt aligns consecutive struct field types, consecutive `const` values,
  and trailing comments on consecutive lines. This is not a garnish in Go, it is
  what gofmt output _looks like_.

Why it is global, not local: alignment is a width computed across a group of
siblings **after** each has been laid out, then fed back as padding. That is a
second pass. Wadler/Oppen has one.

### Go priced it, which is what this entry was waiting for

Go's stage-B review produced the number, by method rather than by adjective:

- **6 of 16 corpus files (37.5%)** show observable alignment.
- A proxy scan of GOROOT non-test sources found alignment-like padding in
  **2,733 of 5,957 files**. Allowing for literal-content false positives,
  declining alignment caps real-world byte agreement at roughly **55–60%** — so
  about **40–45% of real Go files would diverge**, permanently.
- The probe is sharp in both directions: ignoring alignment fails loudly, and
  aligning every child uniformly also fails.

That is the largest single cost in this register, and it is concentrated in one
language rather than spread thinly.

### The cheap partial does not work, and Go is why

The `column` opcode this entry used to propose — align within a single parent's
immediate children, computed during that parent's own layout — was costed and
**rejected** at Go's stage B. Immediate-child scope cannot distinguish
consecutive alignment _runs_: in Go a **blank line resets the run**, so two runs
with different column widths sit under the same syntax parent. Getting it right
needs layout-aware run boundaries, plus independent column schemas for fields,
tags, assignments and comments — which is most of the way to the general
feature, not a cheap partial.

So the honest choice is now binary: build real alignment, or accept that Go and
every aligning reference has a hard agreement ceiling. There is no cheap middle.

**Decide when:** now, in principle — Go's stage C should be started with the
answer known, because a package written as if alignment might arrive later looks
different from one written to concede it.

## 2. Ancestor break context

**Status:** open · **Cost:** contextual · **Languages:** TOML (1 accepted
divergence)

Groups are node-local. A rule cannot ask "did an enclosing group break?", so an
inner construct cannot inherit an outer one's decision.

TOML: arrays inside inline-table pairs cannot inherit the outer array's break.
Stage E fixed the rest of `nested.toml` by moving the group to `pair`, and
explicitly could not fix this part.

This is the classic "expanded parent forces expanded children" rule, and several
formatters have it. It is contextual rather than global because the information
flows **downward** — the enclosing group's break is known before the child is
laid out. That makes it much cheaper than finding 1, and worth separating from
it for exactly that reason.

**Decide when:** a second language hits it. One divergence in one language does
not buy an IR feature.

## 3. A break-only separator pins its group

**Status:** open · **Cost:** local · **Languages:** TOML (2 accepted
divergences)

The IR's only break-only separator policy also pins a group when it consumes an
existing comma, so a rule cannot consume a source comma without pinning the
group open. TOML's `arrays.toml` diverges at both widths because of it.

The reviewer accepted it as consistent with the cross-language magic-trailing-
comma policy, which is a real argument: prettier and black both treat an
existing trailing comma as an instruction to stay broken. So this may be a
**feature** rather than a gap, and the entry exists to make that a decision
rather than an accident.

**Decide when:** a language wants the opposite behaviour and says why.

## 4. The reference rewrites the source, so the corpus cannot contain the case

**Status:** open, **decision needed** · **Cost:** measurement, not IR ·
**Languages:** YAML (five constructs), CSS (three), Go (one), Python (dodged by
flag)

**This is now the most-confirmed entry in the register, and it was confirmed by
languages that had no reason to agree.** Three of round 2's four builders hit it
independently, in two different languages, against the same reference. It is no
longer a YAML quirk.

This one is not a missing capability. It is a hole in **what the numbers mean**,
and it is the most important entry here.

The linearity invariant forbids a package from rewriting a token's text. Gate 3
enforces it, and `check_gate3.py` asserts the complementary rule: **the
reference formatter's own output must pass gate 3**, because a correct formatter
is the oracle. When a reference rewrites token text, those two rules collide and
the corpus loses:

- **Python** dodged it. black normalises quotes, so the manifest passes
  `--skip-string-normalization` — and says so, in the manifest, with the
  reasoning. Clean, because black has a flag.
- **CSS** cannot dodge it either. prettier rewrites `.5` to `0.5`, normalises
  hex-colour case, and changes quote style. Found at stage B, in a language
  picked as the round's _simplest_ — which is the strongest evidence here that
  this is structural rather than a property of hard languages.
- **YAML** cannot dodge it. Stage B enumerated prettier 3.9.6's unmatchable
  rewrites by experiment rather than by example:

  - quote delimiters and their escapes, chosen to minimise escaping, in values,
    keys, tagged and anchored values, and multiline quoted scalars — so
    `'hello'` → `"hello"` but also `"she said \"hi\""` → `'she said "hi"'`
  - block-scalar indentation reduced to the canonical parent-relative indent
  - block-scalar indicator order canonicalised: `|-2` → `|2-`
  - explicit mapping keys made implicit: `? key\n: value` → `key: value`
  - terminal block-scalar whitespace and chomping layout normalised

  It does **not** respell numbers, booleans, nulls, tags, anchors, ordinary
  escapes, or plain-vs-quoted status — a useful negative result, since it bounds
  the exclusion rather than leaving it open-ended.

- **Go** widens the entry beyond token _text_. gofmt **sorts import specs**,
  which is a token **reordering**, and gate 3 correctly rejects sibling
  reordering under the same linearity contract. `imports.go` was written
  pre-sorted, so the behaviour is unmeasured for exactly the same reason. The
  entry is not "the reference rewrites token text" but "the reference rewrites
  the source in a way linearity forbids".

That was the correct call under the current rules and every builder reported it
plainly. But the consequence is that these agreement numbers are measured over
corpora chosen partly for being winnable. Every language whose reference does
something we forbid will quietly do the same.

### How much it removes, measured

YAML's stage B sampled real YAML from `/home/dave/w` — 745 files discovered, 303
unique by content, 227 parse-clean:

| Construct            | Files          |
| -------------------- | -------------- |
| single-quoted scalar | 16 (7.0%)      |
| block scalar         | 31 (13.7%)     |
| **either**           | **46 (20.3%)** |

At node level it is 84 of 10,543 scalar nodes, about 0.8%. The reviewer flags
this as a Kubernetes/Helm-heavy local sample rather than a global estimate,
which is the right caveat — but **roughly one file in five** is the number to
argue with, and it is the first real one this entry has had.

### The options, and what the reviewer recommends

1. **Accept it, and say so per language.** Each manifest names the constructs
   its reference rewrites and its corpus omits. Cheapest, and the omission at
   least stops being invisible.
2. **Let the corpus hold them as declared non-comparisons.** A manifest field
   marking files the reference is known to mangle; `check_gate3.py` exempts them
   from "the reference must pass", and the scorer counts them separately.
3. **Relax linearity.** Not seriously proposed. It is the invariant the whole
   highlighter/formatter split rests on.

YAML's stage B argues for **option 2, refined**: one excluded construct per
dedicated probe file with a required reason, still counting for coverage,
idempotence, non-destruction and parity, but skipping the "reference passes gate
3" assertion, reported as a fifth count `excluded` alongside agreement /
accepted / stale / unreviewed, and **out of the agreement denominator**. Mixed
files that would hide otherwise comparable constructs are rejected.

Its argument against option 1 is the strong part: a manifest comment "neither
forces the omitted construct to exist nor quantifies the resulting measurement
hole". A comment decays; a probe file that must exist does not.

**Decision needed from Dave.** This is the one blocking round 2 — YAML's stage B
returned `rework`, and whether the reworked corpus carries non-comparison probes
changes what the builder is being asked to write.

## 5. Anonymous tokens are only compared when their parent has no named children

**Status:** open · **Cost:** gate change, not IR · **Languages:** YAML

Reported by YAML's builder, verified here. `_generic` recurses into **named**
children only, so an anonymous token is compared at all only when its parent has
no named children. prettier drops YAML's `...` document-end marker and gate 3
does not notice.

Measured, on the merged YAML grammar:

| Edit                         | Gate 3    |
| ---------------------------- | --------- |
| `...` document-end dropped   | **blind** |
| `---` document-start dropped | **blind** |
| flow trailing comma dropped  | **blind** |
| whole second document lost   | catches   |
| anchor `&x` dropped          | catches   |
| tag `!!str` dropped          | catches   |

The boundary is the interesting part, and it says this is **not simply a bug**:

- The trailing-comma row is blind **by design**. A formatter is allowed to add
  or drop one — that is the magic-trailing-comma policy every reference has —
  and `transparent_wrappers` exists for the same reason, because black inserts
  parentheses. Anonymous tokens are the formatter's to edit; that is the rule.
- The three "catches" rows are caught by the **named tree**, not by token
  comparison. Losing a document changes `stream`'s children; an anchor and a tag
  are themselves named nodes.
- What is left is a narrow tail: an anonymous token that is semantically
  meaningful, whose removal changes neither the named tree nor the parse. `---`
  and `...` are the first known members.

So a fix cannot be "compare all anonymous tokens" — that would reject the
trailing-comma and parenthesis behaviour the gate must tolerate.

### Stage B widened it, and proposed a better rule than a per-language list

A deletion sweep over all 42 YAML corpus files found clean, gate-equal loss of
the trailing commas (permitted), `...`, `---` in contexts that stay parseable,
and — new — the explicit-key `?` indicator. So the tail has four known members,
not two.

It also argued `...` is **not** cosmetic, which corrects the assumption above:
the YAML 1.2.2 specification defines it as the signal that a parser may resume
scanning for directives, so it can matter to a streaming consumer even when a
completed file loads identically. And the behaviour is **version-specific** —
prettier 3.6.2 drops the markers, 3.9.6 preserves them — which is its own small
lesson about pinning references.

The recommended shape avoids the per-language list this entry previously
expected: **compare anonymous tokens by default, and permit only named
transformation classes** — optional trailing separator, declared transparent
wrapper, explicit-key canonicalisation. That mirrors how the IR already
enumerates permitted mutations rather than enumerating forbidden tokens, and it
protects document markers by default instead of by remembering to list them.

It is the better design. It is also a real change to the gate's centre, and the
gate has now been wrong in both directions once each this round, so it deserves
its own slice rather than being folded into a language merge.

**Decide when:** as its own harness slice, before round 3. Round 2's languages
can merge without it — no package exists that would exploit the hole.

## 6. A group cannot fit itself while ignoring a trailing comment

**Status:** open · **Cost:** local · **Languages:** YAML, TOML (opposite
directions)

References disagree about whether a trailing comment counts toward the width a
group must fit in, and the IR has no way to say either.

- **taplo** counts it: it will break a TOML collection to make room for the
  comment.
- **prettier** does not: it will not break a YAML collection to fit one, and
  simply overruns.

Both are defensible, both are observable, and a package can express neither
choice — the group measures whatever it contains. This is a small, local opcode
(a group-fit mode that excludes suffix trivia) and the two references between
them prove both modes are needed, which is unusually clean evidence for adding
something.

**Decide when:** YAML or TOML stage C, whichever next produces a divergence that
turns on it. Cheap enough that it does not need a second language to justify it.

## 7. A rule cannot tell a comment-forced break from a width-forced break

**Status:** open · **Cost:** contextual · **Languages:** YAML, CSS

prettier uses a **different** flow-collection layout depending on _why_ the
group broke: a break forced by an interior comment is laid out differently from
one forced by width. A rule sees only that its group broke.

Reported at YAML stage B as a candidate needing confirmation, and **confirmed at
CSS stage D**, which hit the same thing independently. It is a close relative of
entry 2 — both are the evaluator withholding context from the rule — and the two
should be costed together rather than separately.

**Decide when:** with entry 2, once a third language hits either.

## 8. `fill` — pack as many items per line as fit

**Status:** open, **decision needed** · **Cost:** local · **Languages:** CSS,
JSON

The IR breaks a group all-or-nothing: every separator breaks, or none does.
Neither reference does that. prettier packs short items onto a line and wraps to
the next, and it decides per line rather than per group.

**This is the best-evidenced request in the register, and the cheapest.** It was
asked for by CSS's stage-C builder, corroborated independently against JSON
before any reviewer saw it, and then costed at CSS's stage D.

JSON's _only_ outstanding divergence is this gap, and it gets both directions
wrong at once:

```
ours                                   prettier
"matrix": [[1,2,3],[4,5,6],[7,8,9]]    "matrix": [
                                         [1, 2, 3],
                                         [4, 5, 6],
                                         [7, 8, 9]
                                       ]
"long_flat_array": [                   "long_flat_array": [
  100,                                   100, 200, 300, 400, 500, 600,
  200,                                   700, 800, 900, 1000, 1100, 1200
  ... one per line ...                 ]
]
```

Both lines are one prettier behaviour: fill when the elements are short
primitives, one-per-line when they are not. Having only all-or-nothing gives us
each case backwards.

Stage D's costing, which is what makes this decidable:

| Question                        | Answer                                             |
| ------------------------------- | -------------------------------------------------- |
| Same construct in CSS and JSON? | Yes — one generalised combinator, no second shape  |
| Divergences it contributes to   | **13 of 21** (CSS)                                 |
| Divergences it fully resolves   | **9 of 21** (CSS), and **2 of 2** (JSON)           |
| Cost on this register's scale   | **local**                                          |
| Effect on merged packages       | Additive — JSON opts in, TOML and python unchanged |

Local is the important word. It needs a new Doc node and one printer case using
the width state the runtime already carries: no sibling measurement, no second
pass, no ancestor state. Wadler/Oppen has a fill combinator already, so this is
a known quantity rather than a research problem — the exact opposite of entry 1,
which is global and was just proved to have no cheap partial.

Checked against the other merged languages before recording this, so the
two-language count is not inflated: python's four divergences are
operator-precedence breaking, a different gap, and TOML's seven are entries 1, 2
and 3.

**Decision needed from Dave.** It is the one entry here where the cost is small,
the benefit is measured, and two languages already want it.

## 9. Comment placement cannot see the surrounding syntax

**Status:** open · **Cost:** contextual · **Languages:** CSS

Comments are runtime-owned trivia. A rule cannot say which neighbour a comment
belongs to, and prettier decides that from the syntax around it: an own-line
comment inside a call is glued to the **following** argument, and a comment in a
selector list pins the list's layout. Our suffix comments flush at the next
newline instead, so `.lead /* after */ {` becomes `.lead { /* after */`.

Raised at CSS stage B as a candidate and **confirmed at stage D with a package
to test it against**.

Stage D was explicit that this is **not** entry 1, and the distinction is worth
keeping: this needs attachment and flush context around adjacent syntax, while
entry 1 needs _rendered widths_ and a second pass. They look alike because both
are "the rule cannot see its siblings", and filing them together would hide that
one is contextual and the other global.

**Decide when:** a second language hits it. TOML's comment divergences are entry
1, not this.

## 10. A rule cannot vary by where its node appears

**Status:** open · **Cost:** contextual · **Languages:** CSS

Dispatch is on `node.type` alone. CSS needs `binary_query` formatted one way
under `@media` and another under `@supports` — the same node kind, different
parent, different correct layout. Stage D disproved the obvious workarounds:
wrapping `binary_query` globally fixes `@supports` and breaks `@media`.

Stage D was again explicit that this is **not** entry 2. Entry 2 is inheriting
an ancestor's _break decision_ at layout time; this is selecting a _different
rule_ by call site, which is a dispatch question and could be answered without
any layout-time context at all.

This is also the entry the roster predicted. `LANGUAGES.md` flags Scheme as "the
sharpest possible test" of node-type dispatch, because a Lisp's layout is driven
by the head of a form rather than the node kind. CSS has arrived at a milder
version of the same problem three rounds early, which is useful: it means the
question can be settled before a language exists that cannot work around it.

**Decide when:** before Scheme (round 5), and sooner if a round-3 language hits
it. Two languages would make it the cheapest of the contextual entries to
justify.

## 11. Two smaller CSS findings, recorded but not yet argued

**Status:** open · **Cost:** unknown · **Languages:** CSS

Both from CSS stage D, both real, neither yet costed. They are kept together
because each is currently a single divergence in a single language, which is
below this register's bar for its own entry:

- **Anonymous heterogeneous-chain grouping.** Moving the selector group outward
  fixes `selectors.css@40` but forces breaks inside multi-selector lists, and
  the grammar supplies no fields for the existing `flatten` to work with.
- **Source-break-sensitive layout.** `grid-template-areas` needs to know where
  the author put newlines — its interior layout is meaningful — and no rule can
  reach preserved source breaks.

The second is a close relative of the block-scalar problem in entry 4: content
whose layout is data. If a third language wants it, it should probably become
one entry about **layout-as-content** rather than two per-language ones.

**Decide when:** a second language hits either. Recorded now so the first
sighting is not lost.

---

## Closed

### The generic default was blind to untokenised source

**Closed 2026-08-16, by fixing it.** Opened and closed inside round 2, which is
the only reason it is worth recording: it is the clearest evidence in this file
that the gate needs the same scepticism the packages get.

Fixing the over-strict empty-container defect (entry — see `LEDGER.md`) by
comparing a node's _child token texts_ silently discarded source the grammar
never tokenised. YAML's `block_scalar` is one anonymous `|` child with the whole
body an untokenised gap, so `d: |\n  hello` compared equal to `d: |\n  goodbye`
— a formatter could rewrite a block scalar's contents undetected.

Found by YAML's stage-B reviewer, which reported block-scalar bodies as
unprotected. The reviewer believed it was pre-existing; reproducing it against
`main` rather than against the builder's unmerged worktree showed the cause was
the fix earlier the same day. A gap is now dropped only when it is _entirely_
whitespace.

Two lessons worth keeping:

- **A strictness fix can trade a loud failure for a silent one.** The original
  defect rejected correct output — noisy, harmless. The regression accepted
  destroyed output. Those are not equally bad and a change that moves between
  them needs the destructive direction tested explicitly, which it was not.
- **Verify a reported defect against the tree the report is about.** The first
  reproduction used the builder's worktree, which had not merged the change, and
  said the hole did not exist.
