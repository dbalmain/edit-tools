# Review briefs — stages B and D

Issued to an **Opus subagent**. The orchestrator does not read the code; your
verdict is what it acts on, so state it plainly and put the evidence under it.

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

   **Run both `cmp` loops yourself. Do not read the counts out of the report.**
   How many files does the reference change at all, and how many differ between
   the two widths? A builder who omits one of the two numbers looks exactly like
   a builder who reports a good one, and TOML's stage B passed a corpus where
   the reference changed 6 of 14 files — worse than the round-1 corpus that was
   scored as a defect for the same reason. The reviewer trusted a report that
   simply did not mention it.

   The consequence is not cosmetic. Byte-identical input and output means the
   corpus never probes **normalisation** — what the reference rewrites at token
   level, as opposed to what it breaks at line level. taplo normalises nine
   distinct things and the corpus probed one.

4. **Is `widths` the reference's own default, established by bisection?** This
   is the round-1 delta and it recurred at stage B: TOML's builder found taplo's
   default of 80, wrote it in a comment, and set `widths = [88, 60]` anyway
   because 88 "matches the other languages". 88 is black's, inherited through
   the python manifest. Agreement measured at a width no user of that reference
   ever sees is not agreement. Check the number, do not read it.
5. **Do the corpus files parse cleanly** — no `ERROR`, no `MISSING`?
6. **Is `gate3` right for this language?** If the builder took the default when
   a real semantic checker was available, say so. If it declared an override, is
   the override actually stronger?
7. **Is `reference_width = "fixed"` honest** where used — does the reference
   genuinely not honour a width, or did the builder waive a gate it found
   inconvenient?
8. **What did the builder change outside `corpus/` and `harness/languages/`?**
   Every such edit needs a reason. Edits to `rust/` or `runtime-js/` at stage A
   are a strong smell.

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
   one. For unreviewed divergences, a **design limit** mislabelled as a
   **reference quirk** hides exactly the finding this whole exercise exists to
   produce. Take two or three "reference quirk" labels and check whether the
   reference is actually being arbitrary or whether the package simply cannot do
   it. Be sceptical of that label specifically. Record each accepted
   classification with the viewer's `--approve`, `--verdict`, `--reason`, and
   `--reviewed-by` flags; the resulting JSONL diff is part of the review.
4. **Verdict each runtime edit**: `warranted` | `unnecessary` |
   `needs-redesign`. Ask whether a package-level expression would have done it.
   State whether you now recommend **freezing** the runtime against further
   builder edits — you have the authority to recommend that, and the
   orchestrator will act on it.
5. **Read the package for what gates cannot see**: design fit, whether it reuses
   the existing concepts or invents parallel ones, whether the rule table reads
   like `packages/python.json` or like something bolted on.
6. **Is refusal being used to dodge?** Refusing a construct the package could
   have handled inflates gate 1–3 at the cost of usefulness.

### Merge bar

- The scorer's gates `0-coverage`, `2-idempotence` and `3-nondestruction`
  perfect. Rust/JS parity perfect. Both are hard.
- At each measured width, **unreviewed divergence at or below 30% of compared
  files** — equivalently, reference agreement plus accepted reviews at or above
  70%. Agreement, accepted, stale, and unreviewed remain separate numbers; do
  not call agreement and accepted review the same thing. Any stale review is a
  hard failure regardless of the percentage.
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
  capabilities the IR lacks rather than as bugs. The orchestrator forwards
  these; they are the point of the exercise.
- If `escalate`: the diagnosis and the **disproved approaches**, written for the
  next agent's prompt.
- **Template delta** for `templates/package-brief.md`. Nothing to say is valid.

### Do not

- Do not rewrite the package yourself at stage D. If it needs rewriting, that is
  `escalate`. The ladder exists so the orchestrator can compare models, and a
  reviewer that quietly fixes everything destroys the comparison.
- Do not run `git push` under any circumstances.
