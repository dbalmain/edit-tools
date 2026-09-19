# test.sh is not hermetic; say so, and fail early

## Contract

Most of `./test.sh` is local: reference outputs are committed
(`harness/gen_reference.py` is not on the path), and `web/js/host.test.js`
runs before `web/gen.py` has written `vendor/`. Two probes are not:

- `harness/probe_injection_parity.py` reads `web/data/blobs/`
- `harness/probe_secondary_grammar.py` reads
  `web/data/blobs/markdown.blob.json` and `markdown_inline.blob.json`

Those tables are written by `./web/gen.py` and gitignored on purpose
(sixteen grammars, 22.9 MB raw). `gen.py` itself exits unless a vici
checkout sits at `~/w/vici/js/src`. `test.sh` does not run `gen.py`.

## Check

`test.sh` stats the two markdown blobs after `cd` and before `./build.sh`.
Missing files print the path, `./web/gen.py`, the size reason, and the
two probes, then `exit 1`. It does not skip.

Fresh worktree with no `web/data/` and no `web/vendor/`: 6 ms, exit 1,
named both paths. Did not reach cargo.

## Why not the other shapes

- **Do not run `gen.py` from `test.sh`.** It always `vendor()`s first, so
  it needs vici even when the probes only need blobs. Transcoding also
  needs gitignored `.grammars/` (a network fetch). The previous commit
  already refused this: putting `gen.py` on the default suite makes it
  environment-dependent.
- **Do not move the probes out.** A skip that leaves the suite green
  with those surfaces silent is the defect `node_suite.assert_passed`
  exists to prevent. `probe_injection_parity.py --allow-missing` is
  already the deliberate opt-out; the default path must fail.

## Brief vs tree

Line numbers matched at `c36aee7` (not only at `406cf85`):
`test.sh:10`, `probe_injection_parity.py:46`,
`probe_secondary_grammar.py:28-29`, `web/gen.py:19` and `:101-102`.

Divergence:

- Both probes already *fail* on a missing blob. The secondary probe
  checks first; injection parity names `./web/gen.py` too, but only
  after parsing the host corpus. The defect was the ten minutes of
  `test.sh` *before* either probe, not a silent skip.
- `gen.py` also needs `.grammars/` (gitignored). The brief named vici;
  that is sufficient to fail `gen.py`, but not the only extra input.
- `REVIEW.md` does not claim hermeticity. `docs/competition.md:232` and
  `docs/onboarding/WORKFLOW.md:248` say `./test.sh` stays hermetic
  about *committed reference output*, which is still true; left them.
  `README.md`, `DESIGN.md`, and `web/README.md` omitted the
  prerequisite; those now state it. `web/README.md` also notes the
  suite does not need `vendor/`.

## Green path

`./test.sh` with `web/data/` present, exit 0 in 107 s after `cargo clean`
(this worktree's `rust/target` had `CARGO_MANIFEST_DIR` baked from
`/tmp/q30-flag-clean`; not a blob issue, not a source change):

```
injection tree parity: 24/24 corpus files identical
secondary grammar: 2553/2553 audited ranges agree; ...
```

Vendor was present here and unused by the suite. The empty-worktree
run had neither directory.
