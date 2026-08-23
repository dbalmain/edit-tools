# Review briefs — stages B and D

Issued to a **reviewer-lane agent** — see the lane table in `LEDGER.md`, which
is the authority. codex-Sol is the standing reviewer; DeepSeek and grok are
builder-lane; the Opus subagent's lane is central fixes and the final sweep, not
stage B or D. **A reviewer must never be the same family as the builder.**

This header used to read "issued to an Opus subagent", which contradicted that
table and was followed literally for all three round-3 stage-B reviews. If the
standing reviewer is unavailable, pick another lane deliberately and record it —
do not let the template pick for you.

The orchestrator does not read the code; your verdict is what it acts on, so
state it plainly and put the evidence under it.

Both reviews end with the same two required sections: a **verdict** and a
**template delta**.

---

## Stage B — review the corpus and harness entry for `{{LANG}}`

Worktree `{{WORKTREE}}`, branch `wt/lang-{{LANG}}`. Read
`corpus/reports/{{LANG}}/corpus-report.md`, then check it against the tree.

You are checking whether the **ground truth is honest**. Everything downstream
is measured against this, so a flattering corpus poisons the whole language.

Check, in roughly this order of importance:

1. **Is the reference output actually the reference formatter's?** Regenerate at
   least three files and diff. Hand-edited "reference" output is the failure
   that would invalidate every later number, and it is invisible to any gate.
2. **Is the manifest reproducible?** Does the recorded command run, and does the
   recorded version match what it prints? A `reference_version` that was assumed
   rather than observed is a defect.
3. **Does the corpus probe, or does it flatter?** A corpus of short, easily
   formatted files scores well and teaches nothing. Does it force breaking at
   the narrow width? Does it cover comments in every position? Is there anything
   characteristic of {{LANG}} that a person would notice missing?

   **The four counts are a floor, not the probe-quality test.** They are worth
   running and worth trusting as a floor — but a genuine missing probe passes
   them untouched, and round 5 made that three-for-three: Ruby's blank-line
   probe, Scheme's semicolon-count probe and Haskell's two import probes moved
   **no count at all**, because every one was a width-insensitive rewrite in a
   file that already changed and already carried a comment. The check that finds
   those is number 10, not this one. For an indent-only or otherwise
   width-insensitive reference, treat this check as necessary and nowhere near
   sufficient.

   **Run `./harness/corpus_stats.py --language {{LANG}}` yourself. Do not read
   the counts out of the report.** It prints all four -- how many files the
   reference changes, how many differ between the two widths, how many carry a
   comment, and the reference's own overflow -- and it replaces the hand-rolled
   `cmp` loops this check used to ask for. A shared implementation matters here:
   a reviewer re-deriving a number with a _different_ loop cannot tell a real
   disagreement from a methodology difference. How many files does the reference
   change at all, and how many differ between the two widths? A builder who
   omits one of the two numbers looks exactly like a builder who reports a good
   one, and TOML's stage B passed a corpus where the reference changed 6 of 14
   files — worse than the round-1 corpus that was scored as a defect for the
   same reason. The reviewer trusted a report that simply did not mention it.

   The consequence is not cosmetic. Byte-identical input and output means the
   corpus never probes **normalisation** — what the reference rewrites at token
   level, as opposed to what it breaks at line level. taplo normalises nine
   distinct things and the corpus probed one.

**Before ruling on any reference-shape question, grep the other manifests for
the same shape.** Round 5 asked Scheme's reviewer to decide two things — keep
emacs's tabs or pin `indent-tabs-mode nil`, and whether a corpus with no width
sensitivity can support a package — and both were already settled by
`harness/languages/go.toml`, which declares `reference_width = "fixed"`,
`widths = [80]` with nearly word-for-word the same rationale and has all sixteen
of its reference files tab-indented. The reviewer found the precedent and said
so, which is the right answer; the deliberation it displaced was the waste.
`grep -l 'reference_width = "fixed"' harness/languages/*.toml` costs nothing.

4. **Is `widths` the reference's own default, established by bisection?** This
   is the round-1 delta and it recurred at stage B: TOML's builder found taplo's
   default of 80, wrote it in a comment, and set `widths = [88, 60]` anyway
   because 88 "matches the other languages". 88 is black's, inherited through
   the python manifest. Agreement measured at a width no user of that reference
   ever sees is not agreement. Check the number, do not read it.
5. **Do the corpus files parse cleanly** — no `ERROR`, no `MISSING`? **And are
   they valid in the language?** These are different questions and the second one
   has now been missed. TypeScript's `annotations.ts` carried a rest parameter
   followed by a comma; tree-sitter parsed it happily, stage B passed it, and
   stage D found the compiler rejects it (TS1013, checked against 5.9.3) — after
   a stage-C builder had classified a divergence against it. **A divergence
   measured against invalid input measures nothing.** Where the language has a
   compiler or validator that the harness does not run, run it once over the
   corpus yourself; where it does not, say so.
6. **Is `gate3` right for this language?** If the builder took the default when
   a real semantic checker was available, say so. If it declared an override, is
   the override actually stronger?
7. **Is `reference_width = "fixed"` honest** where used — does the reference
   genuinely not honour a width, or did the builder waive a gate it found
   inconvenient?

   For a `fixed` language, **check 4 does not apply and this one replaces it**:
   the useful instruction is not "bisect the default" but **"prove the width is
   inert"**, and it is one command. Round 5 did it twice: Haskell rejected six
   different width flags and then showed a 266-character list staying on one
   line *and* a trivially-fitting broken list staying broken — inert in both
   directions, not merely "does not wrap". Scheme ran `fill-column` 40 against
   200 on a 100-column line and got byte-identical output. Either shape is
   enough; asserting `fixed` without one of them is not.
8. **What did the builder change outside `corpus/` and `harness/languages/`?**
   Every such edit needs a reason. Edits to `rust/` or `runtime-js/` at stage A
   are a strong smell.
9. **List the reference's options and their defaults.** Not what it does — what
   it _chose_, which the output cannot tell you. Two shapes, and the second is
   the one that bites:

   - **A behaviour that is off by default.** rustfmt's
     `struct_field_align_threshold` and `enum_discrim_align_threshold` both
     default to `0`, which is the entire reason `alignment: "go"` does not
     transfer to Rust (FINDINGS 18). Output alone shows their absence, never
     that the absence was deliberate.
   - **A behaviour that is on by default, whose _off_ setting is what a naive
     package would implement.** Call these out specifically. prettier's
     `objectWrap` defaults to `preserve`: an object literal whose source has a
     newline after `{` stays expanded **even when it fits flat**. The
     alternative, `collapse`, is exactly what a plain width-driven `group` does
     — so a package can model objects as a group, pass the whole corpus, and
     diverge on real input. A preserved break and a width-driven break are the
     same bytes, so no diff and no count can separate them.

   Above all, flag **any default that makes layout depend on the input's line
   breaks rather than on width alone.** The runtime has `srcline`, `srcsoft` and
   `srctrail` for that, and stage C needs to know it must reach for them. A
   reference with no such options is a valid answer.

10. **Does every normalisation the report claims have a corpus file forcing
    it?** Run the report-to-corpus direction, which nothing else checks.
    `corpus_stats.py` passing is a floor, not a probe audit: JavaScript's stage
    B added two missing probes and **all four counts stayed identical**, because
    both were width-insensitive rewrites. Counting cannot see them.
11. **Are incomparable files dedicated?** Every `[incomparable]` entry must name
    a file that exists, give a non-empty reason, and contain **only** the
    excluded construct. Mixing in otherwise comparable constructs hides them
    from the agreement denominator; the harness cannot detect that, so this
    check is yours. Omitting a construct the reference rewrites — rather than
    declaring a dedicated file — is the older failure this field exists to stop.
    The `kitchen` file must not be listed.

    **And a named rewrite is not an enumerated one.** Haskell's builder declared
    `imports.hs` incomparable for *sorting*, wrote a careful file dedicated to
    sorting alone, and never asked whether ormolu does anything **else** to
    imports. It does: it **collapses** repeated imports of one module, dropping
    an exact duplicate and merging two `Data.List` imports into one. That is the
    ktfmt `sortedAndDistinctImports` precedent — two exclusions wearing one name
    — landing in a second formatter, and it took three probe inputs to find. For
    every `[incomparable]` construct, ask whether the reference **reorders,
    deletes, merges or renames** on it, and record the negatives too.

You **may make small corrections yourself** in the worktree — a wrong pin, a
missing probe file, a stale number in the report — and re-verify. Anything
larger is a verdict of _rework_ with a specific diagnosis.

### Required output

- **Verdict**: `pass` | `pass with fixes applied` | `rework`
- If `rework`: the diagnosis, and the specific approaches you have **disproved**
  so the next attempt does not re-walk them. This text is pasted verbatim into
  the builder's next prompt, so write it for that audience.
- **Template delta** for `templates/corpus-brief.md`: what misled the builder,
  what was missing, what was noise. Nothing to say is a valid answer — do not
  manufacture one.

---

## Stage D — review the package for `{{LANG}}`

Worktree `{{WORKTREE}}`. Read `corpus/reports/{{LANG}}/report.md` and
`score.json`, then check them against the tree.

**Trust the builder's gates; do not re-run the full suite.** Re-running reloads
compiler and test output into context and throws away the whole point of the
offload. Verify a gate only when a signal directly contradicts the claim, and
then only that one gate.

**But verify the behaviour, not the gates.** Green gates say nothing about
whether the package is right. Budget your effort here:

1. **Reproduce the headline number.** Re-score the corpus once and confirm gate
   4 matches `score.json`. A stale report is the most common defect and the
   easiest to catch.
2. **Rust/JS parity on a file the builder did not highlight.** Parity is a hard
   requirement and a package can pass its own scoring while diverging on
   something unscored.
3. **Audit the divergence classifications.** This is the real review. Use
   `./harness/review_formatter.py {{WORKTREE}} --language {{LANG}}` for the
   exact output pairs. For each proposed ledger verdict, test its stated reason:
   does the difference actually improve readability or cross-language
   consistency enough to justify a house rule? Differing from the reference is
   not a defect by itself, but a vague or weak reason is not a licence to hide
   one.

   The four verdicts fall in two pairs, and the pair is the thing to get right.
   `design-limit` and `package-bug` say **we could not**; `reference-quirk` and
   `house-rule` say **we chose not to**. A _we could not_ mislabelled as a _we
   chose not to_ hides exactly the finding this whole exercise exists to
   produce, so take two or three of the second pair and check whether the
   package could actually have done it. Be sceptical of `reference-quirk`
   specifically: it claims the reference is being **arbitrary**, which is a
   strong claim and usually the wrong one. When we simply prefer our own layout
   — alignment being the standing example — the verdict is `house-rule`, and its
   reason must name the readability or cross-language-consistency argument, not
   assert one.

   **`package-bug` now fails the scorer** (Dave, 2026-08-21), the way a stale
   review does. It is not a softer thing to write than `design-limit` — it is
   the one verdict that stops a merge, because it says the defect is ours and
   fixable. Write it when that is true and expect the slice to come back; do not
   reach for it to avoid committing to a design claim you are unsure of. The
   pressure this creates runs the other way too: a genuine defect relabelled
   `design-limit` to clear the bar is the worse failure of the two, and it is
   what the "take two or three and check" instruction above is for. Record each
   accepted classification with the viewer's `--approve`, `--verdict`,
   `--reason`, and `--reviewed-by` flags; the resulting JSONL diff is part of
   the review.

   **A reason must account for every hunk in the diff, not the first one.** A
   divergence is one record and often several distinct causes; a reason that
   explains the hunk the builder noticed and is silent on the rest reads as
   settled and is not. Check the whole diff against the whole reason.

   **A classification can go stale with the package untouched.** A
   `design limit` naming a capability the runtime has since gained is no longer
   a limit, and a held branch accumulates these silently — TypeScript, unreviewed
   for one round, had three, and two of them came back for a one-word edit.
   Before accepting a `design limit` that names a missing opcode or policy, check
   `rust/src/pkg.rs` for whether it is still missing.

4. **Verdict each runtime edit**: `warranted` | `unnecessary` |
   `needs-redesign`. A verdict of `unnecessary` is a **retroactive freeze for
   this run**: revert the edit and require the package to be expressed without
   it. You hold that power directly and do not need to ask — it has been
   exercised, on CSS, and it worked. Do **not** recommend a standing freeze;
   Dave declined that in round 1 and the question here is always "was _this_
   edit warranted", never "should builders still be allowed to edit".

   Two checks, and the second is the one reviewers skip:

   - **Was it needed?** Would a package-level expression have done it? Test any
     workaround you propose at **one adversarially narrow width** as well as the
     scored one — a `group`-based composition can match a fixed-width reference
     perfectly at width 80 and still be wrong, because it is width-sensitive
     where the reference is not.

     For a `reference_width = "fixed"` language there is no second width, and
     the equivalent axis is an adversarial **source line structure**. Stage B's
     item 7 already knows fixed references need a different probe and says so;
     this section did not, until Haskell. For a source-driven predicate the
     sharpest test is **idempotence on off-corpus line structures** — a
     source-sensitive rule is exactly the shape that can oscillate where the
     corpus never shows it.
   - **Do the two runtimes mean the same thing by it?** Parity is a hard
     requirement measured **by the scorer over the corpus**, and the corpus can
     only check the bytes it contains. A new capability has branches no corpus
     file reaches — every refusal, every empty input, every out-of-range or
     malformed path — and those are exactly where two independently written
     implementations drift. **Diff the Rust and JS implementations by hand and
     construct an input for each branch of each condition.** This has now found
     two defects in two consecutive slices, both invisible to every gate: HTML's
     `srcgap` disagreed about whether vertical tab is whitespace, and Haskell's
     `source-multiline` disagreed about a node range running past the source,
     because **Rust's `slice::get` returns `None` where JS's `subarray` clamps**.
     That asymmetry is worth checking for by name; a third instance of it sits on
     `main` today in `Formatter.slice`, on a path no package currently takes.
     **Compare accepted numeric domains, not only branches.** A header validator
     is the case a branch-by-branch diff walks past: `tab_stop`'s two validators
     had identical conditions and different accepted ranges, because JS
     `Number.isInteger` admits values Rust's integer deserialisation rejects. A
     package that loads in one runtime and refuses in the other is a parity
     break, and it is invisible to every gate.
     **And prove byte-identity directly rather than inferring it from the
     scorecard.** Agreement counts can hold steady while output moves, because a
     file that diverged before and diverges differently now still counts as one
     divergence. Format every corpus tree at every width with the *parent*
     bundle and with the new one and diff the two sets: FINDINGS 30's review
     reported "442 identical, 26 diffs, all markdown", which is the claim
     itself rather than a proxy for it.

   - **Is its _shape_ right?** A warranted capability can still be implemented
     too broadly, and gates cannot see that: every gate passes either way. Read
     the predicate. YAML's semantic-gap bypass was warranted and searched the
     whole preceding subtree for its declaring token, so a `|+` buried anywhere
     inside an item uncapped a blank run belonging to the next sibling. Build
     the smallest input that separates the implemented predicate from the
     intended one and run it. Correcting the shape is part of the verdict, not a
     separate finding.

5. **A pickup another language priced is a hypothesis, not a measurement.** When
   a report says a limit is stale and names a second language that can now pick
   it up, that claim was verified against the *first* language's corpus. Run it
   on the second before repeating it. Twice in consecutive slices between
   TypeScript and JavaScript, a rule shared by both was clean in one only
   because that corpus never probed it: `decorators.ts` in one direction, and
   in the other a `fill` pickup that passes every gate in TypeScript and
   **destroys comments** in JavaScript (FINDINGS 33). Note also that "the opcode
   stopped refusing" is not "the opcode emits the reference's bytes" — a
   refusal hides the output until it is lifted, and Rust's `or_patterns.rs`
   pickup evaporated on exactly that (FINDINGS 23).

   **And a rule that reproduces the reference byte-for-byte can still be
   wrong.** JavaScript's bitwise-paren rule made `operators.js` identical at
   both measured widths with every gate green, and mis-parenthesised
   `a | b | c` — a construct no corpus file contains. For any rule that keys on
   a *set* (of operators, of node kinds), write the inputs the set is supposed
   to separate and run them against the reference directly. Corpus agreement is
   evidence about the corpus.
6. **Package edits must be surgical text edits.** The size metric gzips
   `packages/*.json` **as written on disk**, so loading a package and dumping it
   back reformats the whole file and charges the change for it. Measured:
   `javascript.json` went 16764 -> 34887 bytes on disk and the metric read +513
   B gzip for an edit that actually cost +114. If a diff touches lines the
   change did not, the number in the report is wrong.
7. **A corpus file added for a safety regression still needs its ledger reason
   to name every cause.** A hard-gate probe earns its place by failing the gate
   when the fix is reverted — check that by reverting, not by assuming. But it
   will usually diverge from the reference for reasons unrelated to the bug, and
   the reason recorded for it must account for those too. Before asking for a
   more isolated probe, check whether isolation is even available: for
   `comment_fill.ts` the smallest case that exercises the construct still trips
   FINDINGS 34, so no split would have produced a clean file.
8. **Read the package for what gates cannot see**: design fit, whether it reuses
   the existing concepts or invents parallel ones, whether the rule table reads
   like `packages/python.json` or like something bolted on.
9. **Is refusal being used to dodge?** Refusing a construct the package could
   have handled inflates gate 1–3 at the cost of usefulness.

### Merge bar

- The scorer's gates `0-coverage`, `2-idempotence` and `3-nondestruction`
  perfect. Rust/JS parity perfect. Both are hard.
- At each measured width, **unreviewed divergence at or below 30% of compared
  files** — equivalently, reference agreement plus accepted reviews at or above
  70%. Agreement, accepted, stale, unreviewed, and excluded remain separate
  numbers; do not call agreement and accepted review the same thing, and do not
  put excluded files back in the denominator. Any stale review is a hard failure
  regardless of the percentage.
- **Width is a measure, not a gate**, and it is comparative. The scorer prints
  the reference's own overflow count; references overrun their own width, taplo
  included. Do not reject a package for matching its reference's overflow. A
  package that beats it deserves inspection because it may be losing agreement,
  but judge an accepted divergence on its stated readability and consistency
  reason, not on the fact that it differs from the reference.
- Every accepted divergence has a defensible ledger reason and reviewer, and
  every unreviewed divergence is classified in the report. A weak verdict should
  be challenged; an unclassified divergence is an automatic _escalate_.

### Required output

- **Verdict**: `merge` | `merge after fixes` (state the fixes you applied and
  that you re-verified) | `escalate`
- **Runtime edits**: one verdict line each — `warranted` / `unnecessary` /
  `needs-redesign` — with its own gzip figure. `unnecessary` is a **retroactive
  freeze for this run**: say so, revert the edit, and require the package to be
  expressed without it. That is yours to decide; do not ask, and do not propose
  a standing freeze on future rounds (Dave declined one — see `LEDGER.md`).
- **Design findings**: the design limits this language exposed, stated as
  capabilities the IR lacks rather than as bugs. They are the point of the
  exercise. Read `docs/onboarding/FINDINGS.md` first and say, for each one,
  whether it is **an existing entry that this language also hits** — which is
  the more valuable answer, because it is what turns one language's complaint
  into evidence — or genuinely new. The orchestrator files them.
- If `escalate`: the diagnosis and the **disproved approaches**, written for the
  next agent's prompt.
- **Template delta** for `templates/package-brief.md`. Nothing to say is valid.

### Do not

- Do not rewrite the package yourself at stage D. If it needs rewriting, that is
  `escalate`. The ladder exists so the orchestrator can compare models, and a
  reviewer that quietly fixes everything destroys the comparison.
- Do not run `git push` under any circumstances.
