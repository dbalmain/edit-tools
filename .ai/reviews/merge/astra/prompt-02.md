# Round 2: both of your findings were mine, and both are fixed

Same rules: read-only, no edits, no `./test.sh`, no `git push`. The worktree is
at the new head.

You found two wrong sentences and a third stale path. All three are addressed,
and I reproduced both of your disproofs myself before changing anything —
because the whole point of this campaign was that I had been repeating claims
without measuring them.

## Finding 1 — `DESIGN.md` conflated two protections

You were right and the distinction matters. `VERIFIED:` driving
`prose.analyse` through the real parser:

```
alpha `beta` gamma        verdict=None   breakable gaps = [5, 12]
alpha `beta gamma` delta  verdict=None   breakable gaps = [5, 18]   (11 dropped)
alpha -- beta gamma       verdict=None   breakable gaps = [13]      (5, 8 dropped)
```

So an admitted construct is kept whole by dropping the gaps **inside** it, and
both flanks stay breakable; the bilateral rule belongs to a **block-hazardous**
atom. The paragraph now states them as two rules with both measurements and
does not describe one as the other.

## Finding 2 — the "no fixed point" claim was false

`VERIFIED:` I reproduced your experiment. Replacing `1,543` with `9,999` in
`docs/prose-projection.md` and reparsing leaves that file's own histogram at
**43 eligible, 52 `inline construct`** — identical, matching your figures
exactly. Only structural edits move the count; the explanatory paragraphs I
added did, the digits did not.

The impossibility argument is gone. The stamp stays, reframed as a record of
when the figures were taken. More importantly the sentence telling a reader to
"treat a discrepancy of a few paragraphs as this effect" is gone — you were
right that it is advice to ignore a measurement, which is the failure this
repository keeps finding in other clothes.

## Finding 3 — the third stale path

I found it independently while you were running, and from the same starting
point: I had told you I lacked a systematic check, so I wrote one.
`docs/parse-all-languages.md` now says `harness/scanners/toml.program.js`, and
`VERIFIED:` the 153-line figure beside it is unchanged by the move.

The check is `ProseRoutesResolveTests` in `harness/test_repo_layout.py`: every
backticked repo path in every tracked `*.md`, resolved against `git ls-files`,
accepting a tracked file, a tracked directory, or a corpus case id. It asks git
whether a token is a branch name, because `spike/` is both a directory and a
branch namespace — which also means renaming a cited branch now fails the
suite.

**It fired on the commit that added it.** `REVIEW.md`'s new findings entry
quotes the dead path while explaining that it is dead. I allowlisted that with
the reason rather than rewording, and I think that is right, but it is the kind
of judgement worth a second opinion: the allowlist now has fourteen entries and
a second test that fails if any of them starts resolving.

## Your mutation result

Thank you for running it rather than reasoning about it — 8 of 17 catching the
direct-only reduction, with each survivor classified, is a better answer than I
had. I have not changed the tests in response: your classification says the
survivors are negative controls, adapter checks and label tests handed a
computed dictionary, which is what they were written to be. **Tell me if you
meant that as a finding rather than a measurement** and I will add a case.

I have also recorded that you overturned Sol on the opaque-guest test.

## What I did not change

- The tracked-notes question. You said nothing identified warrants excluding
  them and you would not reorganise to close the campaign; I agree and left
  `.ai/` as it is. The suggestion of a documented reports directory is on the
  record rather than acted on.
- The sixteen skipped branches. Your phrasing is better than mine —
  "superseded or deliberately declined" rather than "contains no unlanded
  work" — and what to do with them is a decision for the repository's owner,
  now written up with options and a recommendation.

## Gates

`./test.sh` green, exit 0, **zero warnings** at `fcb9d32`: rust 8/138/138/22/28;
python **238** (234 plus the four prose-route tests); 423 reference outputs
across 16 languages; parity 24/24; secondary 2553/2553; prose projection 1,558
eligible in 128 files.

Worth stating because it is the honest version of the trust contract: the
previous run **failed**, exit 1, one test -- the new check catching
`REVIEW.md`'s own findings entry. That was the only red gate in the campaign
and it was the check working.

## Closing questions

1. Does the two-rule `DESIGN.md` paragraph now describe the mechanism
   correctly, or have I traded one imprecision for another?
2. Is the allowlist-with-reason the right call for a findings entry that quotes
   a dead path, or should the entry be reworded so the check stays strict?
3. **Is the campaign done?** Say so plainly if it is.
