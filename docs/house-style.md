# House style: what we optimise for when we differ

Stated by Dave on 2026-08-16. This is a **goals-level** document. It changes
what a stage-C package should spend its complexity on, and what the scorer
should count as a failure.

## The product this is for

Blog editing tools on the web. Editing fields in TUIs. Somewhere a person is
looking at a snippet in a box.

It is **not** a drop-in replacement for the standard formatter a project runs in
CI, and it is not a replacement for the formatter in your editor. Those tools
are judged on whether they leave a clean diff against what a team already
agreed. We are judged on whether the thing in the box reads well.

## Matching the reference is a means, not the end

We measure agreement with black, prettier, taplo and the rest because a
canonical formatter is a **cheap, honest, external standard of readability**
that we did not get to invent. High agreement means we are producing something a
practitioner would recognise as well-formatted. That stays the default, and it
is right far more often than not.

But when we differ, the tie-break is **readability first, fidelity second** —
and after readability, **consistency across languages**. If keeping the runtime
small means JavaScript comes out looking a bit more like Kotlin than a JS
developer expects, that is a good outcome. A person editing a snippet benefits
more from one predictable layout discipline across every language than from
fifteen faithful reproductions of fifteen communities' historical arguments.

## The operative rule: do not over-weight edge cases

This is the part that changes day-to-day decisions.

**A package should not grow special cases to chase a reference formatter's
quirks.** Every rule costs bytes, costs a concept the next reader has to hold,
and costs a place for a bug to live. A rule that fires on one construct in one
corpus file is a bad trade even when it buys a point of agreement.

Small packages are this project's actual differentiator — that is the whole
argument in `design.md`'s size budget. Agreement is a proxy for readability;
package economy is a goal in itself. When they conflict, prefer the general rule
that is right most of the time over the specific rule that is right always.

The failure mode to watch for is a stage-C builder discovering a reference's
one-off behaviour and encoding it faithfully, because the scoreboard rewards
that and nothing currently pushes back. **The 70% agreement floor actively
pressures builders toward exactly the edge-case rules this document is telling
them not to write.** That tension is real and it is why the scorer needs the
change described below.

## Candidate rules, deliberately not implemented yet

These are readability opinions worth testing, **not decisions**. They are
recorded so they are not lost and not re-derived, and deferred because the
evidence to evaluate them does not exist yet.

### Containers do not share a line

The idea: never put a data structure on one line with another data structure
inside it. Possibly with a narrow exception for an object whose only container
children are arrays of scalars — `{"one": [1, 2, 3], "two": [8, 3]}`.

**Why it is deferred.** It was going to be implemented immediately, on the
strength of an argument that it fixes `matrix` in `corpus/src/json/nested.json`
and therefore improves the score. **That argument was wrong.** `matrix` and
`deep` are in the same file, and we currently match prettier on `deep` byte for
byte. The rule trades one divergence for another inside one file, so agreement
stays at 4/6 and the change buys nothing measurable today.

Two things worth keeping from that:

- **Scoring is per file, not per construct.** A rule that is right in every
  individual case can register as zero improvement, or as a regression, purely
  because of which file the affected constructs share. Never argue for a layout
  rule from a score delta without checking what else lives in the file.
- **Two languages is not enough evidence to change a layout rule for fifteen.**
  JSON and Python is a sample that cannot distinguish "this reads better
  everywhere" from "this happens to suit JSON".

**The trigger to revisit:** a corpus spanning enough languages to actually test
it — YAML, CSS, TOML and Go at minimum, since they are container-heavy and use
three different references between them. At that point the question is
answerable with evidence rather than taste: implement it behind the intentional-
divergence machinery, measure the cost across every language at once, and keep
or drop it on the numbers.

Cost when it is time: one predicate. `roadmap.md` point 5 calls this "pile A" —
a static test on the children needing no printer change and no layout
backtracking. Prettier's own rule is the same predicate with a different
quantifier (`all children are containers`, where this would be `any`), which is
itself a useful datum: the reference already thinks in this shape.

## What the scorer has to learn

Under this document some divergences are **deliberate** — either a house
readability rule, or, far more often, a decision that matching the reference is
not worth the package complexity. The harness cannot say either.

Today `score.py` reports one agreement number and `review-brief.md` sets a 70%
floor. So a package that correctly declines to chase an edge case **scores worse
for being right**, a stage-D reviewer would file that restraint as a defect, and
nothing records the reasoning, so the next agent re-litigates it.

Needed: divergence declared per language with a reason, reported separately from
unexplained divergence, with the floor applying to the unexplained kind only —
and a staleness check, so a declaration that has quietly become true fails
loudly instead of rotting into a suppression list. That is `roadmap.md` point
10, in flight.

**"Not worth the bytes" must be a first-class, respectable reason there.** It is
the most common one this document will generate.

## How to apply this at stage C

- **Default to the reference.** It is right far more often than not.
- **Weigh every divergence-closing rule against its cost.** Ask what else the
  rule buys. One construct in one file is not enough.
- **Prefer the rule that generalises across languages** over the one that
  matches this language's reference most exactly.
- **A divergence you chose is a finding; a divergence you did not notice is a
  bug.** Say which one it is.
- **Never trade away a safety property.** The linearity invariant,
  refusal-rather-than-guess, and non-destruction are not style. This document is
  about layout only.
