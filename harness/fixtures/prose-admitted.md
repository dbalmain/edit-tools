<!-- Every top-level paragraph below must be ELIGIBLE, and must survive reflow. -->

# Paragraphs the projection must admit, and reflow safely

> `harness/probe_prose.py` requires this file to yield **no refused top-level
> paragraph**, and sweeps it through the same phases as everything else: the
> reflow-and-reparse invariant, the inline-grammar oracle, the producer
> comparison, and the two runtimes at both widths.
>
> It is the mirror of `prose-refused.md`, and it exists because that file
> cannot hold these. A refusal fixture detects a change in **eligibility**, and
> every paragraph here is eligible both before and after the mutations worth
> worrying about -- what would change is the **partition**, which gaps came
> back breakable. `harness/test_prose.py` asserts the partition on hand-built
> models; this asserts that the same shapes survive the *real* parser, the real
> secondary grammar and both real runtimes.
>
> Most of these entries were near misses in `prose-refused.md` under A1 and
> became eligible at A2.1. They moved here rather than being deleted, so the
> transition cases keep a hand-written real-parser fixture.
>
> As in the refusal fixture, every explanatory paragraph is a block quote, so
> this commentary can never itself become an entry.

## A code span, protected whole

alpha beta `gamma delta` epsilon zeta eta theta

## A code span holding whitespace a gap flip must never reach

> The double space and the newline inside this span are not gaps. Outside one
> they would be a `whitespace run` refusal and an ordinary break.

alpha beta `gamma  delta
epsilon` zeta eta theta

## A code span holding characters the byte whitelist refuses

alpha beta `gamma ~ delta * epsilon` zeta eta theta

## An inline link, protected whole

alpha beta [gamma delta](http://example.com/a) epsilon zeta eta

## A URI autolink, protected whole

alpha beta <http://example.com/a> epsilon zeta eta theta

## Emphasis, with its interior gaps still breakable

alpha beta *gamma delta epsilon zeta* eta theta iota

## Underscore emphasis, with the same delimiter attachment

alpha beta _gamma delta epsilon zeta_ eta theta iota

## Strong emphasis, whose two-character delimiters stay attached

alpha beta **gamma delta epsilon zeta** eta theta iota

## Nested emphasis and strong delimiter runs

alpha beta ***gamma delta epsilon zeta*** eta theta iota

## Mixed nested emphasis

alpha *beta **gamma delta** epsilon zeta* eta theta iota

## A protected code span inside reflowable emphasis

alpha *beta `gamma  delta` epsilon zeta* eta theta iota

## Emphasis beside punctuation

alpha beta (*gamma delta epsilon zeta*) eta theta iota

## Emphasis at the first atom

_alpha beta gamma delta epsilon_ zeta eta theta iota

## An indented line start inside a span, which is not a fence

> The discriminating case for the fence rule. This has an embedded line start
> indented four spaces and is admitted; the entries in `prose-refused.md` are
> the same shape with a backtick run after the indent. If the fence rule ever
> widens to indentation alone, this entry refuses and the probe fails.

alpha ``beta gamma
    delta`` epsilon zeta eta theta

## A word that would become a list item at a line start

> A1 refused this as `block acquisition`. A2.1 protects the gap on both sides
> of the `-`, so it cannot reach a line start alone.

alpha beta gamma - delta epsilon zeta eta theta

## A word that would become an ordered list item at a line start

alpha beta gamma 1. delta epsilon zeta eta theta

## A two-dash atom that would become a setext underline

alpha beta -- gamma delta epsilon zeta eta

## A GFM delimiter row spelling, away from the last atom

> As the **last** atom this refuses, because it would make the preceding line a
> table header; `prose-refused.md` carries that case. Mid-paragraph it is
> coalesced and safe.

alpha beta :- gamma delta epsilon zeta eta

## The centre-aligned spelling, mid-paragraph

alpha beta :-: gamma delta epsilon zeta eta

## The right-aligned spelling, mid-paragraph

alpha beta -: gamma delta epsilon zeta eta

## Adjacent hazards, which must cascade into one component

alpha -- :- beta gamma delta epsilon zeta eta

## A hazardous first atom, repaired by the right gap alone

--- alpha beta gamma delta epsilon zeta eta theta
