# source_partitions / package format 3

Working note for the coverage-check slice.

## Verified against the brief (at `889c3ac`)

| Claim                                                                   | Verdict                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check_source` at `rust/src/eval.rs:1086`                               | Correct                                                                                                                                                                                           |
| `checkSource` at `runtime-js/bundle.js:1776`                            | Correct                                                                                                                                                                                           |
| `Fmt::node_current` at `rust/src/eval.rs:83`                            | Correct; leaf return is the first statement, `Ctx::new` follows rule lookup                                                                                                                       |
| `Formatter.nodeCurrent` at `runtime-js/bundle.js:1865`                  | Correct; same shape                                                                                                                                                                               |
| `whitespace_nodes` requires _exactly_ v2 at `pkg.rs:204`                | Correct; JS mirror at `bundle.js:438-440`                                                                                                                                                         |
| Neither loader sets `deny_unknown_fields`                               | Correct. `RawPackage` has no such attribute; JS `buildPackage` copies unknown fields through. DESIGN.md passage matches the brief, including the 2026-08-28 `gap_owner` / `tab_stop` measurement. |
| `both_runtimes_refuse_the_same_corrupt_verbatim_tree` at `eval.rs:2355` | Correct. JS analogue at `bundle.test.js:1095` shells out to `rust/target/release/docfmt` (needs `./build.sh` first).                                                                              |

Entry-point description is right: the check is at the start of `node_current` /
`nodeCurrent`, ahead of the leaf return and ahead of `Ctx::new` / `new Ctx`.

## What changed

- `rust/src/pkg.rs`, `runtime-js/bundle.js`: accept `et-doc-rules/3`;
  `whitespace_nodes` is a floor (v2 or later); `source_partitions` requires v3
  even as `[]`.
- `rust/src/eval.rs`, `runtime-js/bundle.js`: coverage check on node entry,
  after `check_source` / `checkSource` with operation `source_partitions`.
- Tests in `pkg.rs`, `eval.rs`, `bundle.test.js`. Discriminating hole trees in
  `testdata/source_partitions/`.
- `DESIGN.md` and `docs/prose-projection.md` record the shipped header. No file
  under `packages/` was touched.

## Malformed-declaration decision

Refuse at load when `source_partitions` is not a list of strings, overlaps
`comments`, or overlaps `whitespace_nodes`. Duplicates use set semantics (same
as `whitespace_nodes` / `comments`), not a load error.

Overlap with `whitespace_nodes` is refused because a non-empty trivia leaf is
childless and so cannot satisfy the partition rule; the combination is a package
mistake, not a useful dual role. Same reasoning as the existing
`whitespace_nodes`/`comments` disjointness check.

## Test counts

| suite                               | before (`889c3ac`) | after |
| ----------------------------------- | ------------------ | ----- |
| `cargo test -- --list` (all bins)   | 321                | 347   |
| `docfmt` tests                      | 132                | 145   |
| `rust/src/pkg.rs` `#[test]`         | 17                 | 19    |
| `rust/src/eval.rs` `#[test]`        | 85                 | 96    |
| `runtime-js/bundle.test.js` `test(` | 104                | 116   |

The +26 on the all-bins list is the +13 `docfmt` tests also compiled into
`bench_format`.

## Status

Implementation in; unit tests green in both runtimes; `./test.sh` not yet run.
