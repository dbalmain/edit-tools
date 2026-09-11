# source_partitions / package format 3

Working note for the coverage-check slice. Updated as the work proceeds.

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

Entry-point description is right: the check belongs at the start of
`node_current` / `nodeCurrent`, ahead of the leaf return and ahead of `Ctx::new`
/ `new Ctx`.

## Discriminating cases

Copied from the 889c3ac repro into `testdata/source_partitions/`:

- `full.tree.json` — complete partition of `alpha beta gamma`
- `hole-lead.tree.json` — first atom and gap omitted
- `hole-mid.tree.json` — interior atom omitted

JS at HEAD formats the two hole trees as `beta gamma` and `alpha gamma`, rc=0.

## Malformed-declaration decision (intent)

Refuse at load when `source_partitions` is not a list of strings, overlaps
`comments`, or overlaps `whitespace_nodes`. Duplicates use set semantics (same
as `whitespace_nodes` / `comments`), not a load error.

Overlap with `whitespace_nodes` is refused because a non-empty trivia leaf is
childless and so cannot satisfy the partition rule; the combination is a package
mistake, not a useful dual role.

## Test counts at `889c3ac` (before)

- Rust: 321 tests listed by `cargo test -- --list`
- `rust/src/pkg.rs`: 17 `#[test]`
- `rust/src/eval.rs`: 85 `#[test]`
- JS `bundle.test.js`: 104 `test(` / 104 collected

## Status

Failing tests first. Production change not yet written.
