# Stage C brief — doc-rules package for `{{LANG}}`

Template. Substituted and appended-to by the orchestrator, same as the stage-A
brief. Issued to the **same builder, in the same worktree**, after stage B
passes. The orchestrator pastes the stage-B reviewer's verdict verbatim into the
"Corrections from review" section below.

---

Your corpus and harness entry for **{{LANG}}** passed review. Now write the
package: the table that turns a {{LANG}} parse tree into formatted output, in
both runtimes.

Worktree `{{WORKTREE}}`, branch `wt/lang-{{LANG}}`.

## Corrections from review

{{STAGE_B_VERDICT}}

Apply these first, commit, then start the package.

## What you are writing

`packages/{{LANG}}.json` — a table from CST node type to a Doc-building
expression. The opcode set, selectors and predicates are documented in
`DESIGN.md`; `packages/python.json` is the worked example and
`packages/json.json` is the small one. Read both.

**Set the header's comment-style fields from what you observed the reference
do**, rather than leaving them to default. `comment_gap` is the spaces before a
trailing comment and `blank_cap` is the ceiling on blank lines the runtime keeps
next to a comment. Both default to **1**, which is prettier's answer; black
writes **2** of each, which is why `packages/python.json` sets them explicitly.
They were runtime constants until a review pointed out that no package could
reach them, so if your reference disagrees with the default, that is now your
problem to fix and not a divergence to report.

If you find a **second** such constant — a piece of the runtime's output that is
your reference's house style rather than a safety property — that is a finding
worth more than a rule. Say so; do not work around it in the package.

The same package file drives **both** runtimes. There is no per-runtime package.
If Rust and JS disagree on any corpus file at any width, that is a bug in one of
the runtimes and it is a hard failure — report it rather than working around it
in the package.

## The gates you are being scored on

1. **Idempotence** — formatting formatted output changes nothing. Hard
   requirement.
2. **Width compliance** — no line exceeds the target width unless the package
   provably cannot break it. Hard requirement, unless your manifest set
   `reference_width = "fixed"`.
3. **Non-destruction** — the formatted output must mean the same thing. Method
   is whatever your manifest's `gate3` declares. Hard requirement. A formatter
   that loses code is not a formatter.
4. **Reference agreement** — byte-identical to the reference formatter, per
   corpus file, at each width. **Floor: 70% of files.** This one is measured and
   reported rather than demanded — but every divergence must be **classified**,
   and an unclassified divergence fails the slice outright.

Plus, always: **Rust and JS byte-identical on every file at every width.**

### Classifying a divergence

Each divergence goes in the report as exactly one of:

- **design limit** — the Doc IR or the package format genuinely cannot express
  what the reference does. Name the missing capability. This is the single most
  valuable output of the whole exercise; do not disguise one as a package bug.
- **package bug** — the design can express it, your table does not yet. Say what
  the fix would be.
- **reference quirk** — the reference formatter does something arbitrary or
  inconsistent that is not worth matching. Justify it; this label is easy to
  abuse.

## Refusal is a legitimate answer

The runtime **refuses** — non-zero exit, no output — when it cannot format
safely, rather than emitting something wrong. A shared refusal by both runtimes
counts as agreement. Preferring refusal to a guess is correct behaviour, but a
package that refuses most of its corpus has not done the job; say plainly which
constructs you chose to refuse and why.

## Changing the runtime

You may edit `rust/` and `runtime-js/`. Try hard not to: the runtime is shared
by every language, every byte counts against a 20 KB budget, and other agents
are working in parallel worktrees.

If {{LANG}} genuinely needs something the runtime does not have, add it — and
put the full case in the report: what you tried first, what the package could
not express, and why a package-level workaround is worse.

Measure the **gzip size delta of each runtime edit separately**, and name the
{{LANG}} construct that forced it. Not one lump figure for the whole slice. The
20 KB budget is soft — going over is a question ("which language features cost
the bytes?"), not a failure — but that question is only answerable if each edit
carries its own number and its own cause. A reviewer will judge each edit as
warranted / unnecessary / needs-redesign, and will push back on the ones that
were not needed.

Adding an opcode because it makes your table tidier is not warranted. Adding one
because the language is structurally beyond the current IR is exactly what this
exercise is for.

## Report — this is the artefact

Write `corpus/reports/{{LANG}}/report.md` **and** machine-readable
`corpus/reports/{{LANG}}/score.json`.

`report.md`:

```
gate 1 idempotence      pass | fail   (files failing)
gate 2 width            pass | fail | waived
gate 3 non-destruction  pass | fail   (method)
gate 4 agreement        N/M @ width W1,  N/M @ width W2
rust/js parity          identical | DIVERGENT (files)
refusals                files, and the construct that caused each
size                    package gzip bytes; runtime gzip bytes; delta vs main
```

then, in prose:

- **every divergence**, one line each: file, width, classification, one sentence
  of why
- **every runtime edit**, with its case
- **every harness edit** outside `harness/languages/{{LANG}}.toml`
- what about {{LANG}} was hardest to express, and what you would want from the
  design if you could ask for one thing
- **template delta** — what in this brief misled, was missing, or was noise. If
  nothing, say nothing.

`score.json` carries the same numbers as data; the orchestrator reads that one.

## Gates and working rules

Run `./build.sh`, `./test.sh` and the harness checks; green with zero warnings,
fixing until green. Do not claim a gate for code you have not run.

- **Do not run `git push` under any circumstances.**
- Commit at each green boundary, not one commit at the end.
- `git add` named paths, never `git add -A`.
- A **done-note**, not a transcript.

## Pushback is wanted

If the design is wrong for {{LANG}} — if a node-type table is the wrong
dispatch, if the Doc IR is missing something structural, if the corpus is asking
for something no package could deliver — **say so and propose the better
shape.** A correct "this is actually X" is worth more than an implementation of
my guess. Reporting "this language does not fit, here is precisely where" is a
successful outcome for this slice, not a failure.
