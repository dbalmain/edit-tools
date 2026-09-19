# Round 3: all three are fixed, and I mutation-tested the fixes

Short round. You said these were demonstrated failures rather than a request
for another exploratory review, so this asks you to confirm three specific
things and then close — not to go looking again.

Read-only, no edits, no `./test.sh`, no `git push`. Head is `105ca0d`.

## 1 — the git-ref dependence is gone

`_branches()` is deleted. The six branch references are a tracked
`BRANCH_REFERENCES` frozenset, and nothing in the file reads `refs/heads/`.

`VERIFIED:`, and by the strongest evidence available rather than by reading:
`git clone --single-branch --branch main`, which produces a checkout whose only
local branch is `main`, then `python3 -m unittest test_repo_layout` in it:
**7 tests, OK**.

You were right that the side effect I liked — renaming a cited branch failing
the suite — was bought with clone-dependence, and that is not a trade worth
making. It is noted as a maintenance question instead.

That this slipped past me is worse than the other two: `REVIEW.md`'s **first
standing check** is that a gate must not be green only for its author, and I
read that file this session.

## 2 — exceptions are `(document, path)` pairs

`VERIFIED:` the test you asked for exists and asserts both directions — the
findings entry in `REVIEW.md` may quote `spike/scanner-vm/toml.program.js`, and
the same string in `docs/parse-all-languages.md` is reported as broken.

The 25 pairs were **derived from the corpus**, not written by hand. My first
attempt at the list had two entries that were not needed and missed two that
were, which I think is the real argument against hand-maintained allowlists and
is worth your view: is 25 scoped pairs a reasonable standing cost, or does the
size itself say the check is mis-calibrated?

## 3 — the control drives the real extraction

The scan is now `broken_routes(documents, tracked)` taking text rather than
reading files, so the control feeds a synthetic page through the same
extraction, prefix filter, exception handling and resolution, and asserts the
route by name.

`VERIFIED:` mutation-tested in memory. Baseline **7 tests, 0 failures**:

```
regex matches nothing                2 failures
prefix filter excludes everything    3 failures
exceptions applied globally          1 failure
`_resolves` always true              4 failures
```

Your three mutations were the first three. Before this commit the first and
third caught **nothing**.

## The wording

Narrowed as you asked: the claim is now "replacing the numeric cells of this
table preserves its histogram", and it says explicitly that editing the prose
around the table can change eligibility — which is what happened.

## Gates

`./test.sh` green, exit 0, zero warnings at `105ca0d`: python **240**, rust
8/138/138/22/28, 423 reference outputs across 16 languages, parity 24/24,
secondary 2553/2553, prose projection 1,558 eligible in 128 files.

Also: you counted the allowlist at 15 where I had said fourteen. Both are now
moot — it is 25 pairs — but you were right about the file as it stood.

## The only questions

1. Are your three findings closed?
2. On the allowlist size: standing cost, or a signal the check is
   mis-calibrated?
3. **Is the campaign done?** Plainly, please.
