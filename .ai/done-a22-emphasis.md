# A2.2 emphasis projection — running done-note

## Established before implementation

The proposed shape is consistent with the design but still needs to be checked
against the pinned reference: emphasis and strong emphasis must not be protected
whole. Their grammar-confirmed interior ASCII spaces and newlines become
candidate gaps, while each opening delimiter stays in the atom to its right and
each closing delimiter stays in the atom to its left. Nested emphasis therefore
needs a recursive range classification, not membership in the A2.1 protected
set.

The brief's documentation premise is stale at base commit `3c296d1`.
`docs/prose-projection.md` no longer leaves the A2.1 coalescing contradiction
open: it records a 19 September resolution in favour of coalescing and the
implementation already performs bilateral protection in `_block_safe`.
A2.2 inherits that one policy; it will not add a second coalescing mechanism.

## Mechanism and reference

The hypothesis was right. Prettier 3.9.6 with `--prose-wrap always` at width 40
breaks the live `prose_wrap.md` case after `_several` and again inside the
emphasized words. The committed references use `proseWrap=preserve`, so their
unchanged line cannot answer this question.

The implementation recursively descends through `emphasis` and
`strong_emphasis`, protects each `emphasis_delimiter` leaf, and leaves interior
ASCII space/newline gaps visible. Nested emphasis recurses; a code span, inline
link or URI autolink inside it still stops the walk and stays protected whole.
Malformed delimiter counts and every deferred nested construct refuse the
paragraph. Python and JavaScript use the same traversal and refusal text.

## Block-hazard closure

The A2.1 four-part checklist was re-walked. The new reachable line prefixes are
grammar-confirmed opening delimiter runs attached to immediate non-whitespace
content: `*word`, `_word`, `**word` and nested variants. They cannot be list
markers because `*` is not followed by whitespace, and cannot be thematic
breaks because the line contains non-marker content. Closing runs stay attached
on their left and cannot reach a line start alone. The preceding-line,
later-state, blank-line, fence and delimiter-row cases add no new member.

`_ACQUIRES` did not cover `_` and did cover `*`, but extending that asymmetry
was the wrong answer. Its `*` branch would coalesce the first interior gap and
prevent the reference break after the first emphasized word. A literal
unpaired delimiter refuses before block classification, while a paired one is
safe by attachment, so A2.2 removes `*` from `_ACQUIRES` and leaves `_` out.
The admitted fixture exercises both at adversarial line starts; unit tests pin
the actual atom boundaries.

## Coalescing decision

There was no open decision to make at this branch's base. Commit `3c296d1`
already documents the A2.1 resolution in favour of bilateral gap coalescing,
and `_block_safe` implements it. A2.2 retains that one pass. It adds neither a
second coalescer nor a format-pass clock.

## Measurement finding

The final live census is 3,868 paragraphs with 2,538 eligible. Replaying A2.1's
direct-child classifier on that same corpus gives 1,632 eligible, so A2.2's
implemented increment is **906**. It removes the construct-first refusal from
1,565 paragraphs, whose next verdicts are: 906 eligible, 607 `non-ascii`, 36
another `inline construct`, 12 `byte`, two `single atom`, and one each
`edge whitespace` and `whitespace run`.

The brief's 1,547 at `8100844` is consistent with the construct-first ceiling,
but its claimed eligibility near 3,151 is not: it counts the 607 paragraphs
that immediately reach A2.3's deliberately deferred non-ASCII refusal. The
mechanism is not causing that difference. The live construct ceiling is 1,565,
18 higher because this tracked Markdown corpus has moved since `8100844`.
`probe_prose_ceiling.py` now prints the transition by next verdict so the
ceiling cannot be mistaken for actual eligibility again.

## Verification so far

- `./harness/probe_prose.py`: green; 2,538 eligible, 732 reflow/reparse checks,
  2,538 inline-oracle checks, 3,868 producer verdicts and 64 runtime/idempotence
  checks. Both real-parser fixtures pass.
- `python3 -m unittest discover -s harness`: 279 tests, green.
- `./test.sh`: all 15 steps green with zero warnings; 279 harness tests, no
  count drop.

## Not settled by this slice

A2.3 non-ASCII atoms, A2.4's remaining inline constructs and punctuation,
container prefixes, the shipped Markdown package opt-in, and switching the live
reference to `proseWrap=always` remain separate decisions. This slice changes
only the harness projection pair and its evidence; no runtime, package or
manifest declaration changed.
