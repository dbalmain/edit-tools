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
`unreviewed`. Stale is a hard scorer failure. The 70% coverage result for
unreviewed items is printed as the stage-D merge threshold; it is not one of
the scorer's numbered correctness gates. This keeps an unreviewed baseline
honest without inventing signatures for it.
