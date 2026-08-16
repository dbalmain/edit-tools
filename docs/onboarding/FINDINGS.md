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

**Status:** **leaning build** (Dave, 2026-08-17) · **Cost:** global ·
**Languages:** Go (6 of its 10 divergences), TOML (3 of its 7)

**Go is merged and this is now a measured number, not an estimate.** Stage D
verified every one of the six claimed cases hunk by hunk rather than sampling:
`alignment`, `iota`, `kitchen`, `nesting`, `strings` and `structs` are alignment
padding and nothing else.

> **Go's agreement ceiling without alignment is 10/16 — 62.5%.**

Two independent methods agreed on the fraction before that: stage B's GOROOT
proxy scan (2,733 of 5,957 files showing alignment-like padding) and stage C's
per-hunk count (6 of 16 corpus files, 37.5%). Different evidence, same answer.

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

### Rust priced it far lower, and that reshapes the entry

Rust's stage A (2026-08-17) is the third independent price, and it is the first
one that argues *against*:

- **2 of 15 files (13.3%)** show observable alignment — `structs.rs` aligns
  field comments, `comments.rs` aligns an own-line comment with the preceding
  trailing-comment column.
- **1 of 15 files** shows true sibling-width *field* alignment.

Against Go's 6 of 16 (37.5%), that is roughly a third of the rate, and most of
what Rust does have is trailing-comment alignment rather than the field-and-
value alignment that makes gofmt output recognisable.

So the honest summary changed shape: **alignment is largely a Go cost, not a
general one.** Go 37.5%, TOML 3 of 7 accepted divergences (all comment columns),
Rust 13.3%. That does not weaken Go's case — 40–45% of real Go files would
diverge permanently — but it does mean the global-cost feature buys one language
most of its value, and the register should say so rather than implying every
aligning reference pays equally.

### The spike answered it, and the answer is not the one this entry framed

Built on `spike/alignment` (2026-08-17), measured rather than argued. **The
recommendation is to decline this entry as an IR capability and handle Go as a
named exception.** Awaiting Dave.

**What it buys:** Go **6/16 → 12/16**. All six alignment files agree —
`alignment`, `iota`, `kitchen`, `nesting`, `strings`, `structs`. That is Go's
ceiling; the remaining four are entries 2 and 10 and have nothing to do with
alignment. Every other language is **byte-identical**, verified by re-scoring
with the mode removed from `packages/go.json` as the baseline rather than
assuming opt-in meant inert.

**What it costs:** runtime **10,680 → 13,307 B, +2,627 B**. The floor is about
2,400 B — measured, not guessed: deleting two of the three quote-aware scanners
outright saves only 255 gzip bytes, because gzip already deduplicates
near-identical text. That is **13% of the 20 KB budget for one language**, with
nine still to onboard.

**What it did not cost:** the layout algorithm, and this is where the entry was
wrong. This is not a second pass inside Wadler/Oppen — it is a text post-pass
that runs after `print()` returns and never touches the printer. The JS mirror
was also *cheap*, which contradicts the standing assumption that parity is the
expensive part: the pass is pure `String → String` with no shared types, no IR
and no evaluator state, so it transliterates mechanically. Gate 1 was green
first try. Idempotence holds by construction — the pass re-splits on
whitespace, discarding prior padding — and was confirmed on all 4,816 GOROOT
files.

### Why "no cheap middle, so build the real thing" pointed at the wrong thing

**The hard part is where the columns start and stop, not how wide they are.**
Half the work was reproducing policy that has nothing to do with widths:
`keepTypeColumn`, `DiscardEmptyColumns`, formfeed placement, `extraTabs`, and
the rule that a row with *fewer cells terminates the column* so the rows below
start a fresh one — `err error` with no comment splits the comment column in
two; an embedded field splits the type column. Read out of `go/printer/nodes.go`
and `text/tabwriter`, not inferred.

A general `column` opcode in the IR would have landed at roughly the first row
of the table below and stopped. The rejected cheap partial and the general
feature fail for the *same* reason, which is why this entry's binary framing was
misleading: it offered "build the real thing" as the safe answer, and the real
thing would not have worked either.

**Decide when:** now. Recommendation on the table: build the narrow, opt-in,
explicitly Go-specific post-pass; **decline** sibling-width alignment as an IR
capability; and refuse the same trade for the second language that asks. TOML's
three comment-column divergences and Rust's two stay accepted — at ~2,400 B per
language-specific mode, the second is unaffordable and the third absurd.

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

**Status:** open · **Cost:** local · **Languages:** TOML (2), CSS (2), YAML (4)
— 8 accepted divergences

The IR's only break-only separator policy also pins a group when it consumes an
existing comma, so a rule cannot consume a source comma without pinning the
group open. TOML's `arrays.toml` diverges at both widths because of it.

The reviewer accepted it as consistent with the cross-language magic-trailing-
comma policy, which is a real argument: prettier and black both treat an
existing trailing comma as an instruction to stay broken. So this may be a
**feature** rather than a gap, and the entry exists to make that a decision
rather than an accident.

**Two more languages want the opposite behaviour, and said why.** CSS's builder
went as far as extending `opt` in the runtime to escape it — the edit the
reviewer reverted (LEDGER row 4), which does not make the underlying want less
real, only the workaround unnecessary. YAML's reviewer states it plainly:
`trail` is the only policy that may consume the source comma and it pins the
group; replacing it with `opt` collapses the group but leaves the comma behind
and loses break-only commas everywhere else.

So the "feature, not a gap" reading is now the minority one. Three languages,
eight divergences, and the magic-trailing-comma argument only ever justified the
_pinning_ — never the fact that consuming a separator and pinning a group are
welded together in one opcode.

**Decide when:** with entry 6, whose fix touches the same group-fit machinery.

## 4. The reference rewrites the source, so the corpus cannot contain the case

**Status:** **decided — option 2, probe files** (Dave, 2026-08-17) · **Cost:**
measurement, not IR · **Languages:** YAML (five constructs), CSS (three), Go
(one), JavaScript (nine, inventoried), Python (dodged by flag)

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
3. **Add a third sanctioned token policy.** Originally written here as "relax
   linearity — not seriously proposed". **Dave asked for it on 2026-08-17, and
   the framing was wrong, not the request.** See entry 14.

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

**Partly decided, 2026-08-17.** Dave: _"I do want to rewrite quotes. You're
right that sorting of imports should be out of scope."_ That splits this entry
cleanly along the line Go's stage D drew:

- **Token-text rewrites** (quotes, and by the same machinery number spellings)
  become a capability to build — entry 14.
- **Token reordering** (gofmt's import sorting) stays out of scope permanently.
  It keeps its place here as a declared, measured omission.

Options 1 and 2 above are therefore still live, but for a smaller residue than
this entry was originally sized against.

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

**YAML's stage D produced them: five of its twenty accepted divergences cite
this entry** (`comments@40`, `keys@40`, `nested@40`, `kitchen@40`, `tags@40`).
The reviewer's reason is the same each time and is worth quoting once: removing
the pair `group` fixes those scalar lines and regresses every broken flow
collection, so the package has a choice between two wrong answers and no way to
ask for the right one.

**Decide when: now — this is the cheapest open entry with real evidence behind
it.** A local opcode, both modes proven necessary by two references pulling in
opposite directions, and five divergences in one language waiting on it. It is
the second thing to build after `fill` (entry 8), and arguably before.

## 7. A rule cannot tell a comment-forced break from a width-forced break

**Status:** open · **Cost:** contextual · **Languages:** CSS (**not** YAML — see
below)

prettier uses a **different** layout depending on _why_ the group broke: a break
forced by an interior comment is laid out differently from one forced by width.
A rule sees only that its group broke.

### This entry was wrong when written, and YAML disproved it

It was opened on YAML stage B's report and marked "needs stage-C confirmation".
Stage C, with an actual package to test against, refuted it:

> prettier's _broken_ flow layout is the same whether a comment or the width
> forced it; what differs is whether the collection breaks at all.

Stage D confirmed the refutation against prettier 3.9.6 directly. So YAML never
had this problem; stage B misread its own evidence.

The entry survives only because **CSS independently reported the same gap** at
its stage D, on separate evidence. Languages: CSS, and the count is one.

Worth keeping visible rather than quietly editing, because it is the register's
first false entry and it says something about how the register should be read: a
finding reported from _corpus_ observation is a hypothesis about the reference,
and only a package makes it a claim about the IR. That is exactly why "needs
stage-C confirmation" exists, and it earned its place on the first use.

**Decide when:** a second language genuinely hits it. One divergence in one
language does not buy an IR feature, and this entry has already been overcounted
once.

## 8. `fill` — pack as many items per line as fit

**Status:** **built** (2026-08-17), **CSS opted in** (2026-08-17), **`all`
unblocked JSON** (2026-08-17) · **Cost:** local, **+365 B gzip** `fill`
runtime then **+86 B gzip** `all`, **+133 B gzip** JSON package, **+17 B
gzip** CSS package on top of the earlier **+44 B** ·
**Languages:** CSS (measured), JSON (measured, 6/6)

The IR breaks a group all-or-nothing: every separator breaks, or none does.
Neither reference does that. prettier packs short items onto a line and wraps to
the next, and it decides per line rather than per group.

**This is the best-evidenced request in the register, and the cheapest.** It was
asked for by CSS's stage-C builder, corroborated independently against JSON
before any reviewer saw it, and then costed at CSS's stage D.

JSON's only outstanding file exposes two gaps, and the combined diff gets both
directions wrong at once:

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

Implementation corrected the diagnosis: these are two prettier behaviours, not
one. `fill` accounts for packing the numeric literals in `long_flat_array`.
`matrix` is the separately deferred static test from `docs/roadmap.md` pile A:
all of an array's children are arrays or objects. It needs an all-child-kind
predicate and an always-broken package branch, not a different fill algorithm.
That predicate is also required to opt JSON into fill safely: prettier does not
fill a mixed scalar array after its first overlong string. Applying fill to all
arrays fixed `long_flat_array` at both widths but regressed `scalars.json` at
both, moving JSON from **4/6 to 2/6**. The experiment was reverted.

Stage D's costing, which is what makes this decidable:

| Question                        | Answer                                             |
| ------------------------------- | -------------------------------------------------- |
| Same construct in CSS and JSON? | Yes for per-line packing; `matrix` is a second shape |
| Divergences it contributes to   | **13 of 21** (CSS, stage-D estimate)               |
| Divergences it fully resolves   | **9 of 21** estimated; **7 of 19** measured        |
| Cost on this register's scale   | **local**                                          |
| Effect on merged packages       | CSS 11/30 → 18/30; JSON 4/6 → 6/6 once `all` landed |

Local is the important word. It needs a new Doc node and one printer case using
the width state the runtime already carries: no sibling measurement, no second
pass, no ancestor state. Wadler/Oppen has a fill combinator already, so this is
a known quantity rather than a research problem — the exact opposite of entry 1,
which is global and was just proved to have no cheap partial.

Checked against the other merged languages before recording this, so the
two-language count is not inflated: python's four divergences are
operator-precedence breaking, a different gap, and TOML's seven are entries 1, 2
and 3.

The shipped shape is `["fill", sel, sep]`, deliberately parallel to `each`.
The evaluator already has exactly the information needed to build alternating
content and separator Docs, and the printer makes the three ordinary Wadler
fill choices per line. Hard breaks and `BreakParent` propagate through it, and
both runtimes retain scalar-value width counting.

### CSS measured it, and the 9/21 estimate was optimistic

CSS is the language that asked for `fill` and where stage D costed it. The
package now uses it in two places, both behind predicates the IR already had:

- Comma-separated declaration values that contain a `string_value` (`font-family`).
- Space-separated declaration values that contain a `call_expression`, hanging
  after the colon (`1px solid color-mix(...)`).

Agreement moved **11/30 → 18/30** (7→10 at @80, 4→8 at @40). **7 of the 19**
accepted divergences resolved: `nested@80`, `nesting@80`, `nesting@40`,
`normalisation@40`, `values@80`, `values@40`, `custom_properties@40`. No
previously-agreeing file moved. The CSS package grew 1,194 → 1,238 B gzip.

The stage-D "fully resolves 9 of 21" figure counted two constructs `fill`
cannot actually match:

- **`calc` both widths.** Hanging fill packs the first two `minmax()` calls
  and wraps the third *flat*. prettier starts the third *broken* on the
  current line (`minmax(` then the args). The printer decides from the next
  item's flat form, so it will not open a group-valued item in broken mode
  on the remaining width.
- **`custom_properties@80`.** prettier fills comma-groups (`0 1px 2px
  rgba(...)` as one item). Our items are named CST children, so filling the
  list packs past the last comma and explodes the last `rgba()`.

Those are why 9/21 became 7/19, not a package that refused to try. Applying
`fill` to every comma list — the JSON-shaped opt-in — fixed `font-family`
and spoiled `box-shadow` / `transition` in the same file, leaving
`values.css` divergent and making `custom_properties` and `kitchen` worse.
The `string_value == 0` guard was the existing-predicate way around that
wall. `["all", "named", ["property_name", "string_value", "plain_value",
"important"]]` replaced it: declaration has no value field, so `all named`
has to list `property_name` and `important` or the predicate never fires.
No corpus file moved (still 18/30). An unquoted-only family list now takes
the branch; the corpus does not contain one.

JSON used the same predicate to opt in. `all named [number]` selects fill
for `long_flat_array` without regressing mixed `scalars.json`. `all named
[array, object]` plus a `count == 1` fallback explodes `matrix` on this
corpus (prettier also wants "parent is not an array", which is ancestor
context and was not built). Agreement **4/6 → 6/6**; both `nested.json`
reviews retired.

## 9. Comment placement cannot see the surrounding syntax

**Status:** open, **promoted** · **Cost:** contextual · **Languages:** CSS,
YAML, Go — and TOML retrospectively

**Three languages have now needed a runtime change to comment attachment, and a
reviewer has identified the shared root cause.** That makes this the
best-corroborated entry after alignment, and unlike alignment it has never been
costed.

The symptoms looked unrelated, which is why it took three:

| Language | Symptom                                                                                                        | Fix               |
| -------- | -------------------------------------------------------------------------------------------------------------- | ----------------- |
| TOML     | a comment absorbed the closing `]`, producing invalid source                                                   | stage E, +242 B   |
| CSS      | comments escaped a descend node with no named host                                                             | `51ea32e`, +149 B |
| Go       | `statement_list`'s range swallows the trailing newline, so an own-line comment before `}` attached as a suffix | `93338c9`, +180 B |

Go's stage D named the common cause: **runtime-owned comment attachment depends
on grammar-shaped node ranges.** Comments are trivia the runtime places, and
where it places them is decided by byte ranges each grammar draws differently.
So every new grammar is a fresh chance to place one wrongly, and the failure is
found by a corpus rather than by a rule.

That reframes 571 B of runtime growth: it is not three bug fixes, it is one
architectural gap paid for three times. A fourth language should be expected to
pay it again.

The original CSS observation — that a rule cannot say which neighbour a comment
belongs to, because prettier decides from surrounding syntax — is the same gap
seen from the package side rather than the runtime side.

**Decide when:** before round 3. Three languages and 571 B is past the point
where "fix it again next time" is the cheaper option, and Markdown in round 4 is
a comment-dense language whose whole premise is nesting other grammars.

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

**Status:** open · **Cost:** contextual · **Languages:** CSS, Go, YAML

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

**Two more languages hit it in round 2, so the "two languages" bar is already
passed — three times over.** Go's stage D reassigned mixed-precedence spacing,
index-expression tightness and conditional-parenthesis handling here (the
builder had filed them under entry 2). YAML hit it hardest: **eight of its
twenty accepted divergences cite this entry**, because tree-sitter-yaml wraps
every value in a `flow_node`/`block_node` and a `pair` rule therefore cannot see
what kind of value it holds.

YAML also shipped **the first partial answer, and it is worth reading as a
warning**: a `child-count` predicate (LEDGER row 10, +58 B) that tallies a
selector's children one level down, so
`when (child-count f:value t:block_scalar 1)` can peer through the wrapper. It
works, it is cheap, and it composes with the existing `count` family — but it is
a one-level, count-only special case standing in for a dispatch question. The
risk is obvious: each language adds its own one-level peephole, and by round 5
there are six of them and still no answer for Scheme, where layout is driven by
the head of a form at arbitrary depth.

**Decide when: before round 3 launches.** This was previously "before Scheme
(round 5)". Three languages, eight accepted divergences and one shipped
workaround have moved it up.

## 11. Two smaller CSS findings, recorded but not yet argued

**Status:** open · **Cost:** unknown · **Languages:** CSS, Python, JavaScript
(first bullet); CSS (second)

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

**The first bullet is no longer a single sighting, and should be split out.**
Reviewing the stage-0 python baseline found `chains.py@60` to be exactly it:
black treats `a.b().c().d()` as one flat chain that breaks at every dot, and the
chain is left-nested *alternating* `attribute` and `call` nodes, so `flatten` --
which requires same-type, same-tightness -- cannot collect it. `DESIGN.md`
already names "method chains at the dots" as a known limit, which means this was
understood before the register existed and simply never got an entry.
JavaScript's stage A reports prettier doing the same thing, making three
languages.

So this is a **heterogeneous-chain `flatten`**: the existing opcode generalised
from "same type, same tightness" to a declared alternating spine. Probably local,
since `flatten` already walks a left-nested spine and the change is to what it
accepts rather than to when it runs -- but nobody has costed it.

The second bullet (source-break-sensitive layout for `grid-template-areas`) is
still a single CSS sighting, though Go's `srcline` work is a close relative.

**Decide when:** the first bullet now -- three languages and a `DESIGN.md`
acknowledgement is well past this register's bar, and it should get its own
entry number the next time this file is edited. The second when a second
language hits it.

## 12. Semantic content can live in the whitespace _between_ two nodes

**Status:** open · **Cost:** gate change, per-language · **Languages:** YAML

**This is the most serious entry in the register, because it is the only one
where the gate reported success while the formatter destroyed data.**

Formatting `block_scalars.yaml` at width 80 changes the loaded value:

```
key 'keep':  before 'keep blanks\n\n\n'
             after  'keep blanks\n\n'
```

`|+` is YAML's _keep_ chomping indicator — every trailing newline is part of the
scalar's value. Gate 3 reported 32/32 non-destruction anyway. Found by YAML's
stage-D reviewer with a real YAML loader; confirmed here on the real corpus
artefact, and then located exactly:

```
block_mapping_pair   [0,22)  'keep: |+\n  keep blanks'
  block_scalar       [6,22)  '|+\n  keep blanks'      <- node ends here
block_mapping_pair   [25,32) 'next: 1'
gap between pairs:           '\n\n\n'
```

The bytes carrying the value are **not inside the `block_scalar` node**. They
are a whitespace-only gap between two sibling pairs, and the generic default
drops whitespace-only gaps as layout — which is correct in every other language
and for every other YAML construct.

So this is **not** the same as the closed entry below. That one was untokenised
source _inside_ a node's range, and was fixable generically. This is outside
every node's range and is genuinely whitespace; no amount of care in the generic
default can distinguish it from indentation without knowing what `|+` means.

### What it costs the gate's promise

Gate 3 is the guarantee that a package cannot corrupt source. That guarantee now
has a stated exception: **it holds only where meaning lives inside node
ranges.** Every language should be asked whether it has such a construct, and
the honest answer for most is no — but nobody was asking, and YAML found it by
losing data rather than by anyone checking.

### The fix, and the rule it establishes

A per-language `gate3` override, composed as **`default AND extra`** rather than
as a replacement oracle.

That composition rule is the durable lesson. Two overrides have been tried and
removed — `tomllib` for TOML and `ast.dump` for python — and both were _weaker_
than the default, because both were **replacements**: data-model loaders that
collapse exactly the spelling distinctions a formatter must preserve. An
override built as "the default, and additionally X" **cannot** be weaker, by
construction, which is a much better guarantee than an adversarial run that
merely fails to find a counter-example.

So the corpus brief's advice should sharpen from "expect to stay at `default`"
to: _if you need an override, extend the default rather than replace it._

**Decide when:** YAML's stage E, which is building exactly this. The register
entry stays open until some language other than YAML is asked the question and
answers it.

**Stage E shipped it, and it holds.** `gate3 = "yaml"` is
`(generic_signature(text), chomp_evidence)`. The pre-fix verification is the
part worth keeping: the generic gate accepted the old, data-destroying output
(`True`); the override rejected it (`False`, "keep-chomping trailing newline run
differs"). The gate checker then found 524 useful mutations, 0 blind spots and 0
generic/override disagreements. The composition rule did its job — the override
could not be weaker, and it demonstrably caught the one case the default missed.

The runtime side cost +341 B (LEDGER row 9): `blank` gained a third operand
naming the leaf spellings after which the source gap is semantic, plus an EOF
escape from trailing-newline normalisation. **The first shape of that bypass was
over-broad** and the reviewer narrowed it (LEDGER row 11) — it searched the
whole preceding subtree for the declaring leaf, so a `|+` buried anywhere inside
an item uncapped the blank run after that item. The rightmost-spine test is both
correct and smaller. Worth recording as a general shape: _a predicate about "the
gap after X" must ask whether X **ends** the thing the gap follows, not whether
X appears in it._

**Go was the first asked, and answered no**, which is the outcome to expect from
most languages: semicolon insertion changes the reparse structure so gate 3
catches it, and a raw string literal's interior sits inside a protected CST node
and is emitted verbatim. A negative from a language that plausibly could have
had one is worth recording — it is what stops this entry becoming a vague fear.

## 13. A package cannot delete a token the reference deletes

**Status:** open · **Cost:** local · **Languages:** Go

gofmt removes redundant parentheses and statement semicolons. Gate 3 permits it
— the reparse is unchanged and the tokens are anonymous — but **no opcode can
express the deletion.** A rule either emits a token or refuses at the cursor;
there is no declared consume-without-emit.

Found at Go's stage D. It is the mirror image of the linearity invariant: the
formatter may not _invent_ token text, and everyone has internalised that, but
nothing said it may not _drop_ a token the grammar marks as removable — and the
IR happens not to let it.

Worth separating from entry 4, which it superficially resembles. Entry 4 is
about rewrites we have decided a package may **never** perform, so the corpus
omits them. This is a rewrite a package **may** perform — gate 3 says so — and
simply cannot. The first is a measurement decision; this is a missing opcode.

Cheap, if it is wanted: a `drop` that advances the cursor past a named token
without emitting. The risk is obvious and is why it needs deciding rather than
just building — an opcode that deletes source is one typo away from destroying
it, and its only protection would be gate 3, which this round has caught out
three times.

**Decide when:** a second language wants it. Go can live without it; the
divergences it causes are a small part of the 10.

## 14. A third sanctioned token policy, for respelling

**Status:** **decided — build it** (Dave, 2026-08-17) · **Cost:** contextual,
plus a narrow gate change · **Languages:** JavaScript, YAML, CSS, Python, TOML

Dave: _"I do want to rewrite quotes."_ This entry exists because the register
had that filed under "relax linearity — not seriously proposed", and **that
framing was wrong.**

### Linearity was never "do not touch tokens"

`DESIGN.md` states it as: a rule's consumed children must be a disjoint, ordered
partition, and **token mutation is allowed only through enumerated policies**.
There are already two, and both mutate tokens:

- `trail` adds a separator the source did not have.
- `autoparen` adds parentheses the source did not have.

So respelling is a **third enumerated policy**, not a broken invariant. The
architecture already has the shape; what it lacks is the third entry in the
list. That is a much smaller claim than the one this register was making, and it
is why the request is reasonable.

`DESIGN.md`'s stated reason for declining still stands as the thing to answer,
not to dismiss: _"a formatter that can rewrite a token can corrupt one."_ The
protection has to be real, and it has to be gate 3.

### What it costs, from JavaScript's stage-A inventory

JavaScript's stage A established each rewrite by experiment. The column that
matters is whether the generic gate already accepts it:

| Rewrite                                    | gate 3      | What is missing              |
| ------------------------------------------ | ----------- | ---------------------------- |
| `'hello'` → `"hello"`, fragment unchanged  | **accepts** | only the opcode              |
| `{ 'hyphen-key': 1 }` → `{ "hyphen-key" }` | **accepts** | only the opcode              |
| `'it\'s'` → `"it's"` (re-escaping)         | **rejects** | opcode **and** a gate change |
| `''` → `""` (empty string)                 | **rejects** | opcode **and** a gate change |
| `0xFF`→`0xff`, `.5`→`0.5`, `1E10`→`1e10`   | **rejects** | opcode **and** a gate change |

Two useful consequences fall out of that table:

- **The simple quote swap needs no gate work at all in JavaScript**, because
  tree-sitter-javascript represents both quote styles as one `string` node with
  an anonymous quote token. The blocker there is purely the missing opcode.
- **Re-escaping is the hard half.** prettier picks the quote that minimises
  escaping, which means counting occurrences and re-escaping the body — and that
  is _logic_, not data. A data-only package cannot carry it. It has to live in
  the runtime, per language family, which is the real cost and the reason this
  is `contextual` rather than `local`.

Number canonicalisation is the same machinery pointed at a different token, and
should be built with it rather than as a second entry later.

### The gate change, and why it must not be a loader

For the rejecting rows, gate 3 has to compare a **decoded value** rather than a
spelling — and that is exactly the shape that was tried twice and removed
(`tomllib` for TOML, `ast.dump` for python), because a data-model loader
collapses every spelling distinction at once and is therefore _weaker_.

The composition rule from entry 12 is the guard: an override must be
`(default_signature, extra)` and so cannot be weaker. Respelling breaks that
rule by construction — it is a deliberate _weakening_, for one declared class of
token. So it must be scoped the narrow way round:

> the generic default still compares token text exactly, **except** for node
> kinds a manifest explicitly declares respellable, where it compares the
> decoded value.

Narrow, declared per language, and auditable by reading one manifest field. Not
a loader, and not a blanket relaxation.

### What is explicitly out of scope

Dave, same message: _"You're right that sorting of imports should be out of
scope."_ **Token reordering stays forbidden permanently.** gofmt's import
sorting keeps its place in entry 4 as a declared, measured omission. The line is
now: a policy may respell a token in place; nothing may move one.

**Sequence:** after `fill` (entry 8), which is cheaper and unblocks JSON
completely. Land it before round 3 reaches stage C, so its packages are written
against the final policy list rather than retrofitted.

## 15. The IR commits to one layout per group; the references choose among candidates

**Status:** open · **Cost:** local for the verified case, contextual in general ·
**Languages:** Python (2 divergences)

A Wadler group has exactly two states: flat if it fits, broken if it does not.
`fits` is asked once, about the flat form. **The references do not work that
way** — they generate candidate layouts and pick one, which lets them decline a
break that would not help, and prefer one break site over another.

Found while reviewing the stage-0 python baseline, which nobody had ever
classified. Two faces, both verified against committed reference output.

### (a) Do not break if breaking does not help

black wraps a too-long assignment RHS in parentheses **only when the wrapped
form actually fits**. Measured on `strings.py`, all six data points agreeing:

| line          | flat | wrapped @ indent 4 | black @88 | black @60 |
| ------------- | ---- | ------------------ | --------- | --------- |
| `long_string` | 95   | 85                 | **wraps** | leaves it |
| `formatted`   | 82   | 74                 | flat fits | leaves it |
| `astral`      | 74   | 69                 | flat fits | leaves it |

At 88 the wrap buys something (85 ≤ 88) so black takes it. At 60 nothing fits
either way, so black leaves the line long rather than adding parentheses that do
not help. Our `autoparen` cannot express that: its `IfBreak` fires whenever the
flat form misses, regardless of whether the broken form lands.

**This was verified by experiment, not inferred.** Adding `string` to python's
`optional_parens` fixes `strings.py@88` exactly as predicted — and breaks
`strings.py@60` exactly as predicted, wrapping all three lines in parentheses
that still overflow. Net agreement unchanged at 20/24: one divergence traded for
another. The experiment was reverted.

### (b) Prefer one break site over another

`kitchen.py@60`, where **both** layouts fit and black picks the other one:

```
black                              ours
if on_error is None or not on_error(   if (
    record, error                          on_error is None
):                                         or not on_error(record, error)
                                       ):
```

black splits the trailing call bracket in preference to splitting the top-level
boolean operator. Ours breaks the outermost group first, which is what
Wadler/Oppen does. This is a *preference order over candidates*, not a fit
question — which is why it belongs with (a) rather than being its own entry.

### What it would take

For (a) specifically, the change is small and local: a group mode that breaks
only if the broken form fits, otherwise stays flat. The runtime already computes
both measurements; it simply never compares them.

The general form — prettier's `conditionalGroup`, a list of candidate layouts
tried in order — is **contextual**, because it means laying out a candidate,
measuring it, and discarding it. That is speculative work the single-pass
printer does not do today.

**Do not build the general form to fix (a).** The verified case needs one
comparison; the general case is a different and much larger decision that only
(b) argues for, and (b) is one divergence in one language.

**Decide when:** (a) with `fill` (entry 8), which touches the same fit
machinery. (b) when a second language wants it.
## 16. A 16-file corpus cannot see a 14%-of-the-world bug

**Status:** open, **methodological** · **Cost:** a harness gate ·
**Languages:** Go, but the lesson is not language-specific

This came out of the alignment spike and it is about **this register's own
evidence**, so it outranks most of what is above it.

The spike built a fixpoint probe: feed **4,814 gofmt-clean non-test GOROOT
files** through the alignment pass alone. Because the input is already gofmt
output, *any* change is a disagreement with gofmt — no false positives, no
judgement calls.

| version                                                          | real files mangled  |
| ---------------------------------------------------------------- | ------------------- |
| first working cut                                                | **682 / 4814 = 14.17%** |
| + real tabwriter column blocks, merged name lists                | 205 = 4.26%         |
| + go/printer cell model, `keepTypeColumn`, `DiscardEmptyColumns`  | 67 = 1.39%          |
| + block comments, `}{` closers, tag/comment slot                 | 49 = 1.02%          |
| + continuation lines are not siblings                            | **10 = 0.21%**      |

> **All 16 Go corpus files are clean at every single row of that table.** The
> version that mangles one real Go file in seven scores exactly the same
> **12/16** as the final one.

The corpus is not bad — it was reviewed twice and it is the reason six alignment
divergences were found and priced at all. It simply cannot see this *class* of
bug, because a hand-written 16-file corpus has no way to contain the long tail
of shapes that a language's real code contains.

### What this does and does not undermine

It does **not** undermine agreement as a measure of *whether a capability is
needed*. Six files diverging on alignment is a real signal and it was right.

It **does** undermine agreement as a measure of *whether an implementation is
correct*. Those are different questions and this exercise has been using one
number for both.

### The fix, and why it should be a gate

A fixpoint probe is cheap and unusually sharp: take a large sample of files the
reference has already formatted, run our formatter, and diff. Idempotence of the
reference makes every difference a real defect. It needs no hand-written
expectations and no review.

The spike's probe was a throwaway script in `/tmp`. Shipping the Go post-pass
properly means committing it as a **harness check with a vendored sample**,
because the corpus provably cannot replace it.

Worth asking whether every language should have one. Most references are
idempotent, and most languages have a large corpus lying around —
`node_modules` for prettier languages, the standard library for Go and Python.
The cost is repository weight and runtime, not design.

**Decide when:** with the alignment decision, since the Go probe is the first
instance and the two ship together.
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
