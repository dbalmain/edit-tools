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
4. **Do the corpus files parse cleanly** — no `ERROR`, no `MISSING`?
5. **Is `gate3` right for this language?** If the builder took the default when
   a real semantic checker was available, say so. If it declared an override, is
   the override actually stronger?
6. **Is `gate2 = "waive"` honest** where used — does the reference genuinely not
   honour a width, or did the builder waive a gate it found inconvenient?
7. **What did the builder change outside `corpus/` and `harness/languages/`?**
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
3. **Audit the divergence classifications.** This is the real review. A **design
   limit** mislabelled as a **reference quirk** hides exactly the finding this
   whole exercise exists to produce. Take two or three "reference quirk" labels
   and check whether the reference is actually being arbitrary or whether the
   package simply cannot do it. Be sceptical of that label specifically.
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

- Gates 1–3 perfect. Rust/JS parity perfect. Both are hard.
- Gate 4 at or above **70% of files** at each measured width.
- Every divergence classified. An unclassified divergence is an automatic
  _escalate_.

### Required output

- **Verdict**: `merge` | `merge after fixes` (state the fixes you applied and
  that you re-verified) | `escalate`
- **Runtime edits**: one verdict line each, plus your freeze recommendation.
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
