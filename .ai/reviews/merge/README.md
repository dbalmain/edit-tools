# The merge campaign's reviews

Three rounds with codex-Sol and three with codex-Astra, on the campaign that
took `main` from 26 unmerged branches to 16 over 2026-09-20. Prompts and notes
only; the transcripts were 900 KB each and are not worth keeping.

| Round | Reviewer | Verdict |
| --- | --- | --- |
| `codex/note-01.md` | gpt-5.6-sol, high | needs work -- five findings |
| `codex/note-02.md` | gpt-5.6-sol, high | one blocker, then closed |
| `astra/note-01.md` | gpt-6-astra, medium | clean with refinements -- three |
| `astra/note-02.md` | gpt-6-astra, medium | not done: three defects in the guard added between rounds |
| `astra/note-03.md` | gpt-6-astra, medium | clean, campaign done |

The prompts are kept because they are where the claims being checked were
stated, and several of them were wrong. Reading a note without its brief loses
that.

**What the reviews found that the gates could not.** Every finding in all six
notes was invisible to `./test.sh`, which was green throughout except once:

- a test that renamed a real tracked `packages/json.json` aside and restored it
  in `finally`, so a SIGKILL would leave the checkout missing a language;
- a canonical `docs/onboarding/FINDINGS.md` entry contradicted, in three
  particulars, by a note this campaign merged;
- six done-notes opening in the present tense about a repository that had moved
  under them;
- two documentation sentences of mine that were simply false, each disproved by
  a probe rather than an argument -- one conflating construct protection with
  block-hazard protection, one claiming a table could not report its own tree;
- three defects in the route guard I added *between* rounds, including a test
  that read `refs/heads/` and was therefore green only for its author.

The last of those is the one worth remembering. `REVIEW.md`'s first standing
check is that a gate must not be green only for whoever wrote it, and I read
that file the same day I broke it.

**The sixteen are now `archive/`.** On 2026-09-20 every branch the campaign
declined was renamed under an `archive/` prefix, keeping its original name
beneath it -- `spike/a2-price` became `archive/spike/a2-price`, and so on. They
were kept rather than deleted because tracked prose routes readers to three of
them by name, and this campaign spent two commits repairing routes that
dead-ended for exactly that reason.

The prompts and notes in this directory were written before the rename and
still spell the old names. That is deliberate: they are a record of what was
claimed at the time, and rewriting them would make the record agree with a
present it did not see. The tracked documents that route a live reader --
`docs/a2-inline-price.md`, `docs/prose-projection.md`, `docs/onboarding/*.md`,
`REVIEW.md` -- were updated instead.
