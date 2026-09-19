# Final review: a merge campaign, before it is considered done

You are the **last** reviewer on this work and the first with no prior context
on it. A previous reviewer (codex-Sol) ran two rounds and closed; its notes are
at `.ai/reviews/merge/codex/note-01.md` and `note-02.md`, and my briefs to it
are alongside. **Read them, but do not treat them as settled** — a second
reviewer agreeing with the first is worth less than a second reviewer checking
what the first assumed.

Read-only sandbox. Do not edit, do not run `./test.sh`, and do not run
`git push` under any circumstances.

## What this is

`main` was at `406cf85`. It is now at `2c13721`, fourteen commits later, and
the repository went from **26 unmerged branches to 16**.

```
2c13721  round 2: close the last stale sentence, and give the closure its own module
4310996  act on codex-Sol's merge review: five findings, four of them mine to fix
29e886c  docs: "(tracked)" meant a branch that is not this one
2bea4ee  merge rust-subwidth: the report a route on main already points at
09fda57  docs: the prose table cannot report the tree that contains it
53b796f  docs: three claims the merge campaign falsified, and a table that rots by design
80c7c9d  merge header-silence   \
19480e2  merge share-line        |  five notes-only merges:
9fcb8da  merge reason-rot        |  `git diff --stat c32b6c5 80c7c9d -- . ':(exclude).ai'`
6101644  merge ledger-audit      |  is empty
9a0996c  merge parity-sweep     /
c32b6c5  merge pending-guests   -- the only merge that changes code
d1b51ff  merge prose-partition  -- tree-identical to its first parent
a05ba4a  (fast-forward of 22 A2.1 commits; no merge commit)
```

## The claims worth attacking

I have marked what I measured. Figures in this brief are **mine** — do not
repeat them as verified unless you verify them.

### 1. The only code this campaign added is `wt/pending-guests` and what two reviews asked for

`VERIFIED:` `git diff --stat c32b6c5 80c7c9d -- . ':(exclude).ai'` is empty;
`2bea4ee` was made with `git merge -s ours` plus one file checked out, and its
non-`corpus/reports` delta against its first parent is empty; `d1b51ff` has
exactly its first parent's tree.

**Is that actually true of the whole range?** I checked the merges
individually. I did not check that the union of fourteen commits contains no
code change I have not accounted for. That is the shape of thing a
commit-by-commit review misses.

### 2. `pending-guests` is inert in production and that is fine

A host whose guest has no package is now pending. But every language in
`packages/` has a package, so the closure never fires outside its unit suite.
`VERIFIED:` `423 reference outputs checked across 16 language(s)` before and
after, and the gate-3 adversarial lines are byte-identical.

Sol judged the tests real (they drive `package_status.awaiting_package`, not a
restatement). **I want you to check that independently**, because this
repository's recurring defect is a gate that passes for a reason other than the
one it names. Concretely: if you reverted `awaiting_package` to the direct-only
version — `missing` with no transitive closure — which of the tests in
`harness/test_package_status.py` would still pass?

### 3. The `package_status.py` extraction is the right seam

Sol proposed it and I built it. `awaiting_package` now takes an
`available(name)` predicate rather than a submission path, so it is pure;
`roster_on_disk(submission)` is the adapter. Three callers — `score.py`,
`review_page.py`, `check_gate3.py` — and `manifest.py` still owns the graph.

The prior arrangement had `check_gate3` importing `score`, which I agree was
wrong. **Is this actually better, or is it a module invented to justify a
circular-import fix?** It has one public function and one adapter.

### 4. Six done-notes and one spike report were merged from five branches whose code had already landed

Each was an add/add conflict on a code file the branch originally introduced,
resolved to `main` because `main`'s copy is the evolved one. The notes now
carry snapshot headers naming branch, commit, date, and what has since been
falsified — I re-measured Sol's four rather than repeating them:
the ledger holds **140** records; `./harness/reason_rot.py` prints `0 hits in
140 records`; `rust/src/pkg.rs` accepts `et-doc-rules/` **1 through 3**;
`parity_fuzz.py` covers **13** sites.

**What I want checked:** these seven markdown files joined
`git ls-files '*.md'`, which is the prose projection's corpus, so they are now
swept by `harness/probe_prose.py` on every gate. Prose projection moved
1,457 in 120 files to **1,556 in 128**. Is there anything in those notes that
should not be in a corpus — and separately, is a done-note the right thing to
put under version control at all, given that `.gitignore:4` is `.ai/` and 22
files are force-tracked against it?

### 5. Three documentation claims were falsified and are fixed

- `DESIGN.md` said the projection covers the **A1** subset "decided from the
  block grammar alone", and separately called source-range projection future
  work that adds no header field. A2.1 reads the secondary inline CST and
  `source_partitions` is a header field at format 3.
- `docs/prose-projection.md`'s histogram was measured against a corpus that has
  since moved. Re-measured through `prose.reasons` and stamped with a commit,
  with a note that the file is itself in the corpus so the table cannot report
  the tree containing it.
- `docs/roadmap.md` listed markdown onboarding as remaining. It landed —
  `VERIFIED:` markdown scores 33 agreement, 7 accepted, 0 stale, 0 unreviewed,
  0 defect of 40.

**The one to attack is the second.** I claim the self-reference has no fixed
point and the honest fix is a stamp naming a parent commit. Is that right, or
is there a formulation of that table that is stable under its own edit?

### 6. `docs/onboarding/FINDINGS.md` entry 9 was wrong and a merged note proves it

`.ai/done-share-line.md` investigated the prescribed fix and stopped without
changing either runtime. The entry claimed the output is `a # c`, that
measuring from `content_end` fixes it, and that the change "can only ever flip
a *false* suffix to an own-line comment". The note disproves all three, the
third with a live `tree-sitter-toml==0.7.0` case. The entry now carries the
correction and the general rule the note establishes.

I did **not** re-run the note's experiments. I read them and judged them
sound. If you think the correction I wrote overstates what the note
establishes, say so — I would rather have a narrower true entry than a wide one.

### 7. Sixteen branches were skipped and I claim none carries unlanded work

Losing arms of A/B competitions (`wt/impl-*`, `wt/lang-toml-*`,
`wt/lang-yaml-*`, the two `*-proposal` branches, which each *delete*
`proposals/claude-1.md` and add their own), spikes whose production work landed
separately, one `backup/` snapshot, one `wip/` branch whose own commit message
reads "UNVERIFIED, agent killed mid-run", and `wt/md-stage-d`, whose ledger rows
are dated 2026-08-25 where `main`'s are 2026-09-08/10 and cite later work — so
merging it would move the ledger backwards.

Sol inspected these and agreed. Two artifacts were found missing from `main`
by this triage and merged or documented: `corpus/reports/rust/subwidth-spike.md`
(named in `docs/onboarding/FINDINGS.md` while living only on a branch) and
`docs/a2-inline-price.md`'s Appendix B, which labelled seven files "(tracked)"
when three stayed on `spike/a2-price`.

**Is there a third instance of that shape?** A tracked document naming a path
or a command that does not exist here. That is the class both found instances
belong to, and I have no systematic check for it.

## The gates

`./test.sh` green, exit 0, **zero warnings**, at every commit the campaign
added. At `2c13721`:

- rust `8 / 138 / 138 / 22 / 28`
- python **234** — 198 before A2.1, 225 after the merges, 226 after round 1's
  single new test, 234 after round 2's eight. Every move is accounted for.
- `423 reference outputs checked across 16 language(s)`
- `injection tree parity: 24/24`; `secondary grammar: 2553/2553`
- `prose projection: 1556 eligible paragraphs in 128 files`

The python count is the number to watch, not the exit status: a suite that
stops being collected also exits 0.

## Ground rules

- If any diagnosis above is wrong, say so and give the better account. A
  correct "this is actually X" is worth more than agreement.
- Read `REVIEW.md`'s standing checks and apply them.
- Where you agree with Sol, say only that; spend the effort on what it did not
  look at.

## Closing questions

1. **What is the single change here most likely to be wrong in a way none of
   the three of us has noticed?** Not the most severe — the least verified.
2. Is there a branch in section 7 you would not have skipped?
3. Should this campaign be considered done? Say so plainly if it should; I do
   not want another round for its own sake.
