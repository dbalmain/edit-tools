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

The corpus probe pinning `audited == 2553` and `compared == audited` is
what would fail vanished attachment (`0/2553`, not `0/0`). This suite
does not substitute for that; it covers the browser default and fetch
behaviour, which the probe cannot see.

## Flag-off fetch

Measured by `harness/lang_parse.test.mjs` against a paragraph that *does*
hold an `inline` node (`hello **world**`):

- default `parse()`: fetches `markdown.blob.json` (and `injections.json`
  afterwards); does **not** fetch `secondaries.json` or
  `markdown_inline.blob.json`; `doc.secondary` is absent.
- `{ secondaries: true }`: fetches both `secondaries.json` and the inline
  blob; attaches a `markdown_inline` record.
- `{ secondaries: true }` on a fence-only buffer: fetches `secondaries.json`
  (the declaration), still does **not** fetch the inline blob.

The fetch log is `lang.js`'s own `blobFor` / `secondaryConfig`. The parse
layer behind it is stubbed (see below), so this is a wiring-and-fetch
claim, not CST agreement.

## Docs

Dated corrections in `docs/prose-projection.md`, `docs/a2-inline-price.md`,
and `docs/web-editor.md` (the 81 ms figure was the block parse; that path
now has a 354 ms attach unless the flag is off). `web/README.md` is the
live guide: the flag exists because nothing reads the second parse and it
cost 354 ms median on FINDINGS.md.

## Clean-checkout honesty (review round)

The first landing of the gate imported `web/js/lang.js` directly.
`lang.js` has module-level imports of `../vendor/ts_*.mjs` and
`../vendor/runtime.mjs`, and `web/vendor/` is gitignored output of
`./web/gen.py`. `test.sh` never runs `gen.py` — the comment two lines
above `node --test web/js/host.test.js` says so. The suite was green here
only because this worktree was already dirty with generated output.
Verified on a tree with `web/vendor/` and `web/data/` moved aside: the
old gate failed with `missing .../web/vendor/ts_secondary.mjs`.

`./web/gen.py` is not a portable fix. `vendor()` exits if vici is not
cloned at `~/w/vici/js/src`. Putting that in `test.sh` would make the
default suite environment-dependent. A skip is also not a fix:
`node_suite.assert_passed` rejects SKIP/TODO so a suite cannot go quiet.

The gate stays in `test.sh`. The unique claims — browser default, URL
opt-in, which URLs `parse()` fetches — belong there. What does not belong
is a gate that cannot run on a clean checkout. The test now remaps
`lang.js`'s four vendor specifiers to in-process stubs via
`module.registerHooks` before importing it, and answers `fetch` from
in-memory fixtures. No `web/vendor/`, no blobs, no vici.

That drops the "real tables, real CST" half of the original flag-on
assertion. CST agreement is `probe_secondary_grammar.py`; loader laziness
is `ts_secondary.test.mjs`. This file keeps the half nothing else covers.

The 0/0 rationale in the test comments was false (it came from the
brief). `harness/probe_secondary_grammar.py` pins `audited == 2553` and
requires `compared == audited`, so vanished attachment fails `0/2553`.
The comments now say what the tests actually guard.

## `harness/bench_secondary_cost.py:6`

Not in this tree. The file lives on `030fd61` (q29-cost) and on the
merge at `a2b-merge` (`165c29a`). Line 6 there still describes the ON arm
as "`parse(text, "markdown")` as `web/js/lang.js` ships it". After this
flag, that call is the OFF path. Not edited here.

## `test.sh`

Must be green from a tree where `web/vendor/` does not exist, not from
this one.
