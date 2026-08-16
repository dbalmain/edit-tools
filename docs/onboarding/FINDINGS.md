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
  what gofmt output _looks like_. If it is inexpressible, Go's agreement number
  has a floor set by how much alignment the corpus contains.

Why it is global, not local: alignment is a width computed across a group of
siblings **after** each has been laid out, then fed back as padding. That is a
second pass. Wadler/Oppen has one.

The cheap partial: a `column` opcode that aligns within a single parent's
immediate children, computed during the parent's own layout. It would cover
trailing comments and struct fields — probably most of the real demand — without
a general constraint solver. Nobody has costed it.

**Decide when:** Go's stage D lands. Go is the language that makes this
expensive to decline.

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

## 4. The reference rewrites token text, so the corpus cannot contain the case

**Status:** open · **Cost:** measurement, not IR · **Languages:** YAML (three
constructs), CSS (three more), Python (dodged by flag)

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
- **YAML** cannot dodge it. prettier rewrites `'hello'` to `"hello"` and
  reindents block scalars, and has no flag to stop either. Stage A therefore
  **left both constructs out of the corpus** and wrote the block scalars
  pre-indented.

That was the correct call under the current rules and the builder reported it
plainly. But the consequence is that YAML's agreement number will be measured
over a corpus chosen partly for being winnable. Every language where the
reference does something we forbid will quietly do the same.

Three options, none taken yet:

1. **Accept it, and say so per language.** Each manifest names the constructs
   its reference rewrites and its corpus omits. Cheapest, and at least the
   omission stops being invisible.
2. **Let the corpus hold them as declared non-comparisons.** A manifest field
   marking files the reference is known to mangle; `check_gate3.py` exempts them
   from "the reference must pass", and the scorer counts them as neither
   agreement nor divergence. Honest, and it makes the count visible instead of
   absent.
3. **Relax linearity.** Not seriously proposed. It is the invariant the whole
   highlighter/formatter split rests on.

Option 2 is the one worth costing. It converts a silent corpus-selection bias
into a reported number, which is what the rest of this harness does everywhere
else.

**Decide when:** before YAML's stage B signs off, because stage B is where the
corpus is judged and this changes what "a good corpus" means.

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
trailing-comma and parenthesis behaviour the gate must tolerate. The plausible
shapes are a per-language list of anonymous tokens that may not be dropped
(honest, and yet another per-language list), or a rule that distinguishes
_structural_ punctuation from _separator_ punctuation without one.

How much does it matter? Dropping `---`/`...` where the document boundary is
otherwise unchanged is close to cosmetic, and the destructive case — merging two
documents — is already caught. So this is a small hole, correctly reported. It
is recorded because it is the **permissive** direction, where the failure mode
is corrupted source rather than a loud build error, and because the next
language may find a wider member of the same class.

**Decide when:** a language finds an anonymous token whose loss actually
destroys meaning. Not before — a per-language list bought for `...` is a bad
trade.

---

## Closed

Nothing yet.
