# Q30: gate browser secondary attachment

## Mechanism

Per-call option on `parse(text, name, options)`, default off.

- `{ secondaries: true }` attaches; `{ secondaries: false }` does not.
- If the key is omitted, the browser honors `?secondaries=1` on
  `location.search`, read per call. `language.js` used to rewrite the query
  to just `lang`+`case`, which would have silently dropped the flag; it now
  preserves other params.
- Why this shape: tests can flip both directions without mutating module
  state; Q29 can reproduce the attached baseline without editing source;
  there is one `parse()` path, not a build-time fork the gates only see in
  one state.

A module setter and a build-time constant were the other two shapes. The
setter leaks across tests. A constant requires a rebuild to flip, which
breaks the Q29 baseline.

A flag is the right mechanism. Removing the call until A2.1 would also
stop the stall, but Q29 could not turn it back on without editing source.

## What the brief got right / wrong

- `web/js/lang.js` `parse()` is the only browser parse wrapper. Its two
  callers are `formatText` (lang.js) and `markdown.js` `scheduleReparse`.
  Line numbers in the brief matched this tree at `406cf85` (`parse` 88,
  attach 99, `formatText` 122, reparse delay 150 / call 307).
- **Guess that the browser is the only path paying this: mostly right.**
  Harness producers (`gen_trees.py`, `ts_check_trees.mjs`,
  `probe_secondary_driver.mjs`) call `attachSecondaries` directly and never
  go through `lang.js.parse()`. They stay unconditional. `formatText` is
  *not* the 150 ms typing-quiet path — it is `:w` / `\F` in
  `language.js:172` and `markdown.js:536`. The stall is `scheduleReparse`
  only. Both still go through `parse()`, so both are off by default.
- **Guess that attachment is all-or-nothing: right, and not this slice.**
  `attachSecondaries` walks every host `inline` node in one stretch. Cheap
  per-paragraph laziness is A2.1's eventual design (eligibility is already
  per-paragraph). Not built here.

## Corpus gates

Unchanged path: they do not call `parse()`. The new gate is
`harness/lang_parse.test.mjs`, reached via `harness/test_lang_parse.py` so
`test.sh` does not have to list it. Five tests: helper matrix, flag off
(no field, no fetch), flag on (clean tree + fetch), flag on + fence-only
(lazy intact), URL opt-in with explicit false still winning. Floor is 5,
so a suite that stops collecting cannot read as green.

## Flag-off fetch

Measured by `harness/lang_parse.test.mjs` against a paragraph that *does*
hold an `inline` node (`hello **world**`):

- default `parse()`: fetches `markdown.blob.json` (and `injections.json`
  afterwards); does **not** fetch `secondaries.json` or
  `markdown_inline.blob.json`; `doc.secondary` is absent.
- `{ secondaries: true }`: fetches both `secondaries.json` and the 43 KB
  inline blob; attaches a clean `markdown_inline` tree.
- `{ secondaries: true }` on a fence-only buffer: fetches `secondaries.json`
  (the declaration), still does **not** fetch the inline blob. Lazy-asset
  behaviour is intact.

So the visible half of the win is real: flag off means the 43 KB table is
not asked for at all, even on a document that would have needed it.

## Docs

Dated corrections in `docs/prose-projection.md`, `docs/a2-inline-price.md`,
and `docs/web-editor.md` (the 81 ms figure was the block parse; that path
now has a 354 ms attach unless the flag is off). `web/README.md` is the
live guide: the flag exists because nothing reads the second parse and it
cost 354 ms median on FINDINGS.md.

## `test.sh`

Green, ~79 s on a warm tree.

```
secondary grammar: 2553/2553 audited ranges agree; clean fixture parses, dirty fixture is recorded dirty without a tree, mixed fixture keeps clean outcomes either side of a dirty one
```

Did not drop to 0/0. `injection tree parity: 24/24`. Prose projection
still 564 eligible / 114 files.

Commits: `e41875d` (flag + gate), `5a781d5` (docs). Detached at those,
parent `406cf85`. Not pushed.
