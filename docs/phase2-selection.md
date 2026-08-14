# Phase 2: selection

Three proposals, all revised against the corrected contract. This is the
analysis behind which get implemented.

## They are three points on one axis, plus one orthogonal idea

Nobody proposed queries (A), a constraint solver (D), or bytecode (C). All three
independently converged on schema-style dispatch, which is a real result: two of
the five options in `design.md` are dead, and the design space is narrower than
it looked.

What separates the three is **how much layout knowledge lives in the runtime
versus the package**:

|                                        | The package says                                                                                  | The runtime owns                   | Escape hatch                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| **grok** — layout kinds                | which algorithm, plus parameters: `{kind: seq, open: "(", close: ")", sep: ",", trailing: magic}` | every layout algorithm             | `template`                         |
| **codex** — linear layout schemas      | which of four schemas, plus weak selectors and policies                                           | four schemas + a linearity checker | ordered local cases                |
| **claude** — Doc program per node type | the layout itself, compositionally (~14 opcodes)                                                  | evaluator + printer only           | the opcode language _is_ the hatch |

Grok is the most declarative: smallest package, least flexible. Claude is the
least: most expressive, largest package, most room to be wrong. Codex sits
between.

That axis is worth three worktrees because it is the project's actual open
question — **how declarative can a package be before it needs an escape hatch,
and what does the hatch cost?** Had the three been variations on named layout
algorithms with different key names, one would have been enough.

## The linearity invariant should be a requirement, not a differentiator

Codex's runtime requires that the children a rule consumes form a **disjoint,
ordered partition** of the matched node's direct children. Unconsumed,
duplicated or reordered tokens make it refuse the file. Token mutation is then
confined to two enumerated, audited policies: `mutableTrailing` (a trailing
comma only where it is semantically optional — single-element tuples and
subscripts excluded) and `continuation` (a balanced paren pair around one layout
region when its group breaks).

This makes **gate 3 hold by construction rather than by testing**, and that is
the best single idea in any of the three proposals. Non-destruction is the one
failure mode where being wrong means corrupted source, and the corpus is 15
files — the same "you cannot earn that guarantee from 15 files" argument grok
used to reject a bytecode VM applies here with equal force.

Neither grok's design nor claude's has such an invariant. A mis-written rule can
silently drop a child, and only the corpus would notice.

**Recommendation: require it of all three implementations.** Otherwise codex
wins gate 3 for a reason unrelated to the axis under test, and the competition
measures the wrong thing. Each design may satisfy it however it likes; what is
required is that the runtime _refuse_ rather than emit when the invariant is
violated.

## What each still admits it cannot do

Worth recording, because these are the claims the implementations will test:

- **grok** — attribute-only chains, a long augmented assignment, and opaque
  strings still overflow at width 60; black leaves those too. Lambda parameters
  cannot take parentheses, which is Python syntax rather than a design limit.
- **codex** — linear local schemas cannot express layout alternatives whose
  regions overlap; no `conditionalGroup`, so hugging a sole collection argument
  is approximated.
- **claude** — no ability to try two layouts and pick one; dispatch on node type
  alone, so "format differently inside a `return`" needs a duplicated node type.

All three defer `fill` and `conditionalGroup`. That is a shared bet, and if it
is wrong, it is wrong for everyone — which the corpus should reveal in
`calls.py` and `kitchen.py`.

## Cost note

Grok's proposal is 1060 lines against codex's 464 and claude's 173. Length is
not quality: the blind evaluators must read all three, and a proposal six times
the length of another distorts attention. For the implementation phase the
submissions are code and the scorer is arithmetic, so this matters less — but
the evaluation prompt should say explicitly that length is not a merit.
