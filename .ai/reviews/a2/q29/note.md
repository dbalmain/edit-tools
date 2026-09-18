# Q29 done-note

**Headline.** `attachSecondaries` holds the main thread for **354 ms
median / 399 ms max** on `docs/onboarding/FINDINGS.md` (199 KB, 594
ranges, 129 KB inline). ON `parse()` 807 ms vs OFF 448 ms (Δ 358 ms,
80% of OFF). 58/114 tracked markdown files have a stretch median over
one frame. Cost tracks inline bytes (~2.7 µs/byte), not range count.
`new Language(blob)` is 0.04 ms of that 354 ms — not the term.

**Controls held.** Negative (fenced block, no `inline`): Δ 0.004 ms.
Synthetic 1..1024 paragraphs: Δ increases, Pearson r=0.9999. Stretch/Δ
= 0.992 on large files. Four corpus files with no inline also Δ ≈ 0.
OFF never produced `secondary`; ON matched host `inline` count.

**Brief vs tree.** `web/gen.py` PARSE_LAYER is lines 88–89, not 92;
`shutil.copy` is still verbatim. The 150 ms timer **resets on every
changing key** (`markdown.js:497`); it runs after 150 ms of quiet, not
while someone types. `attachSecondaries` does not yield after `load()`
except one microtask on `await`. Total `parse()` is the wrong headline:
it yields between block parse, attach, and inject. The attach loop is
the new stretch; the block parse of FINDINGS.md is *longer* (433 ms)
and already existed. Language construction is inside the clock and
irrelevant.

**Browser run?** Node already closes the worst case. 354 ms of
byte-identical JS cannot become a frame in a browser. A browser run
would only refine the 5–16 ms band. That is not the go/no-go.

`./test.sh` once, exit 0, ~109 s.
