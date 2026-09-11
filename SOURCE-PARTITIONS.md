# source_partitions / package format 3

## 1. What changed, by file

- `rust/src/pkg.rs` — accept `et-doc-rules/3`; `whitespace_nodes` is a floor (v2
  or later); new `source_partitions` field, present-vs-absent like
  `whitespace_nodes`, refused below v3 even as `[]`.
- `runtime-js/bundle.js` — the same load rules; `Formatter.sourcePartitions`;
  coverage check at the start of `nodeCurrent`.
- `rust/src/eval.rs` — coverage check at the start of `Fmt::node_current`, after
  `check_source` with operation `source_partitions`.
- `runtime-js/bundle.test.js`, `rust/src/pkg.rs` tests, `rust/src/eval.rs` tests
  — mirrored cases, including the 889c3ac hole trees.
- `testdata/source_partitions/{full,hole-lead,hole-mid}.tree.json` — the
  discriminating trees, copied from the repro.
- `DESIGN.md`, `docs/prose-projection.md` — format 3 and the shipped header. No
  file under `packages/` was touched.

## 2. Malformed-declaration decision

Refuse at load when `source_partitions` is not a list of strings, overlaps
`comments`, or overlaps `whitespace_nodes`. Duplicates use set semantics (same
as `whitespace_nodes` / `comments`), not a load error.

Overlap with `whitespace_nodes` is refused because a non-empty trivia leaf is
childless and so cannot satisfy the partition rule; the combination is a package
mistake, not a useful dual role. Same reasoning as the existing
`whitespace_nodes`/`comments` disjointness check.

## 3. Test counts

| suite                               | before (`889c3ac`) | after |
| ----------------------------------- | ------------------ | ----- |
| `cargo test -- --list` (all bins)   | 321                | 347   |
| `docfmt` tests                      | 132                | 145   |
| `rust/src/pkg.rs` `#[test]`         | 17                 | 19    |
| `rust/src/eval.rs` `#[test]`        | 85                 | 96    |
| `runtime-js/bundle.test.js` `test(` | 104                | 116   |

The +26 on the all-bins list is the +13 `docfmt` tests also compiled into
`bench_format`.

## 4. `./test.sh` tail

```
423 reference outputs checked across 16 language(s); 804 destructive mutations rejected
[PASS] 0-coverage           423/423
[PASS] 1-agreement          423/423
[PASS] 2-idempotence        423/423
[PASS] 3-nondestruction     423/423
```

Both counts unchanged. Clippy `-D warnings` clean. `./test.sh` exit 0.

(First run failed `test_javascript_lexer_tests_pass` because this session has
`FORCE_COLOR` set and the harness scrapes uncolored `ℹ pass N`. Reran with
`NO_COLOR=1`; that test is unrelated.)

## 5. Brief claims that were wrong

None of the checkable facts were wrong:

- `check_source` / `checkSource` line numbers, `node_current` / `nodeCurrent`
  entry points, `pkg.rs:204` exact-v2 check,
  `both_runtimes_refuse_the_same_corrupt_verbatim_tree` at `eval.rs:2355`, and
  the `deny_unknown_fields` DESIGN.md passage all matched.

`whitespace_nodes` at JS `bundle.js:438` was the exact-v2 twin of `pkg.rs:204`.

## 6. Unsettled before a package declares `source_partitions`

- When format 4 arrives, `source_partitions` must become a floor ("3 or later")
  the way `whitespace_nodes` just did. Today v3 is latest, so equality and floor
  coincide.
- A node with `language` set uses the _guest_ package's `source_partitions`,
  because `node()` switches package before `node_current`. Opaque nodes never
  reach the check.
- Refusal messages name the class of hole (leading / interior / trailing /
  zero-width / childless non-empty) but do not include byte offsets.
- A declared type cannot be a non-empty leaf: childless non-empty refuses. That
  is the spec; a package author who puts a word-leaf in the list will see it at
  format time, not at load.
