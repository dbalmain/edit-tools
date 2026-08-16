# Review ledgers

Reviews are stored as one JSON object per line in:

```
harness/reviews/formatter/<language>.jsonl
harness/reviews/highlight/<language>.jsonl
```

Each line has exactly `id`, `hash`, `verdict`, `reason`, `reviewed_by`, and
`reviewed_at`. There is one file per language so parallel language branches do
not contend on a shared ledger. JSONL makes one verdict one stable diff line:
adding or replacing a record does not sort, reflow, or rewrite its neighbours.

Do not write hashes by hand. For formatter differences, inspect the paired
outputs and unified diff, then approve that exact record:

```sh
./harness/review_formatter.py . --language python
./harness/review_formatter.py . \
  --approve python/chains.py@60 \
  --verdict design-limit \
  --reason 'The IR cannot express this break condition.' \
  --reviewed-by 'reviewer@example.com'
```

Use `--json` on the first command for the machine-readable records consumed by
the future HTML review surface. Formatter verdicts are `design-limit`,
`package-bug`, or `reference-quirk`; they are stored with spaces to match the
stage-C vocabulary.

Highlight goldens use the existing scorer as the approval path. Updating and
reviewing are deliberately separate commands:

```sh
./harness/score_highlight.py . --update --language python
./harness/score_highlight.py . \
  --approve python__misc \
  --verdict accepted \
  --reason 'Scopes and boundaries match the source.' \
  --reviewed-by 'reviewer@example.com'
```

A matching hash is `accepted`, a moved hash is `stale`, and an absent record is
`unreviewed`. Stale is a hard scorer failure.

A divergence that is **fixed** is a different situation from one that
**changed**, and only one of them is a review task. When our output starts
agreeing with the reference, the verdict has no subject left, so it is retired
rather than re-judged:

```sh
./harness/review_formatter.py . --retire toml/nested.toml@60
```

That refuses to run while the case is still a divergence, which is the whole
safety property: a record may only be dropped when what it described is gone.
A divergence that merely moved must be re-judged with `--approve` -- deleting
one is exactly the failure the content hash exists to catch. The 70% coverage result for
unreviewed items is printed as the stage-D merge threshold; it is not one of
the scorer's numbered correctness gates. This keeps an unreviewed baseline
honest without inventing signatures for it.
