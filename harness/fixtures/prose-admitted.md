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
> The admitted-fixture assertion selects top-level paragraphs. Explanatory
> block quotes are still projected in production; they are outside this
> fixture's eligibility inventory rather than relying on the old container
> boundary.

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

## A Latin-1 letter

> The paragraph `prose-refused.md` used to hold for "a non-ASCII letter".
> Dropping the ASCII decode without walking scalars would put the gap after
> `á` on the wrong byte.

alpha beta gámma delta epsilon zeta eta theta

## CJK ideographs, wrapping as scalars

> One scalar, one column, as `docs/a23-width-parity.md` recorded. A walk that
> admitted Latin-1 but not three-byte UTF-8 would miss this.

alpha 東京 beta gamma delta epsilon zeta eta theta

## A non-BMP scalar

> Discriminates a UTF-16 code-unit walk: `𝄞` is one scalar and two UTF-16
> units. Latin-1 and CJK would not catch that.

alpha 𝄞 beta gamma delta epsilon zeta eta theta

## A no-break space, which is content this layer must not treat as a gap

> `gamma` and `delta` are one atom. A walk that classified Unicode Zs as a
> gap would split them and could wrap where the author joined the words.
> `gate3._prose` excludes non-ASCII from its whitespace class for the same
> reason.

alpha beta gamma delta epsilon zeta eta theta

## A line separator is not a markdown line ending

> U+2028 is Unicode Zl. The pinned grammar does not treat it as a line
> break (`alpha` then U+2028 then `- word` stays a paragraph). A walk that
> used Unicode line breaks as gaps would split this atom and could turn a
> following `-` into a list.

alpha beta gamma delta epsilon zeta eta theta

## A zero-width space is not a gap

> U+200B is Cf, not Zs. The Zs case above would not catch a walk that
> treated Unicode line-break opportunities as gaps.

alpha​beta gamma delta epsilon zeta eta theta

## A combining mark stays on its base

> The partition splits only on ASCII space and newline, so it cannot land a
> break between `e` and U+0301 unless the source already had one.

alpha café beta gamma delta epsilon zeta eta

## A fullwidth asterisk is not a list marker

> Checked against tree-sitter-markdown 0.5.1: `＊ word` is a paragraph, not
> a list. An unpaired ASCII `*` still refuses as an inline construct; this
> is the lookalike that must not.

alpha ＊ beta gamma delta epsilon zeta eta theta

## An Arabic-Indic digit is not an ordered-list marker

> Python `\d` matches `١`; CommonMark and the pinned grammar do not. Both
> producers use `[0-9]`, or they disagree on whether the gaps around `١.`
> coalesce.

alpha ١. beta gamma delta epsilon zeta eta theta
