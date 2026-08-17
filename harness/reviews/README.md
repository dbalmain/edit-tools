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
the future HTML review surface. They are stored with spaces to match the stage-C
vocabulary.

Four formatter verdicts, in two pairs. Two say **we could not**:

- `design-limit` — the IR cannot express the reference's layout.
- `package-bug` — it could, and this package gets it wrong.

Two say **we chose not to**:

- `reference-quirk` — the reference is being arbitrary here.
- `house-rule` — the reference is defensible and we differ anyway, for
  readability or cross-language consistency. State which, and why, in
  `--reason`; "it looks better" is not a reason.

The split is not cosmetic. A `house-rule` output changing is a regression in
something we decided on purpose; a `design-limit` output changing may just be
the limit moving. See FINDINGS entry 16.

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
safety property: a record may only be dropped when what it described is gone. A
divergence that merely moved must be re-judged with `--approve` -- deleting one
is exactly the failure the content hash exists to catch. The 70% coverage result
for unreviewed items is printed as the stage-D merge threshold; it is not one of
the scorer's numbered correctness gates. This keeps an unreviewed baseline
honest without inventing signatures for it.
