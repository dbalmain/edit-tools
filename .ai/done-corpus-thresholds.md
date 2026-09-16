# Corpus-stat thresholds

Completed 2026-09-17 on `wt/corpus-thresholds`.

## Outcome

`harness/corpus_stats.py` is now a gate. It returns nonzero when any measured
language misses an applicable corpus-quality threshold, and also rejects a run
that measured no corpora. The default rules remain unchanged: at least one
third of files must differ between widths, and strictly more than half must
carry a comment.

## Declaration design

An optional manifest table narrows a default only by making the reference
formatter's constraint explicit:

```toml
[corpus_thresholds.width_sensitive]
minimum_files = 4
reason = "taplo 0.10.0 honours column_width for arrays only"
```

The only legal declarations are a positive `minimum_files` plus a non-empty
reason, or `inapplicable = true` plus a non-empty reason. Bare zeroes, missing
reasons, unknown metrics, and unexplained tables are rejected. This keeps the
declaration distinct from a list of excused language names: the manifest says
which reference behavior constrains the attainable count and the gate still
enforces the declared floor.

- JSON declares the comment threshold inapplicable because JSON has no comment
  syntax.
- TOML declares a four-file width floor because taplo 0.10.0 responds to
  `column_width` for arrays only.
- Markdown declares a five-file width floor because the pinned
  `proseWrap=preserve` policy leaves only guest code in fences responsive to
  print width.
- Every other applicable metric inherits the universal defaults. Existing
  `reference_width = "fixed"` manifests retain their established width n/a.

Markdown's declaration is deliberately guarded by a precise adjacent comment,
not a second policy field. `proseWrap=preserve` is currently Prettier's implicit
default rather than text in the command, so mechanically coupling the floor to
it would require duplicating formatter/version-specific CLI semantics in the
generic manifest parser. The comment says that the A2 change to
`proseWrap=always` must raise the floor even with no corpus change.

## Measurements and brief corrections

The four headline measurements in the brief reproduced exactly before the
change:

| language | width-sensitive | comments |
| --- | ---: | ---: |
| JSON | 1/3 | 0/3 |
| Markdown | 5/24 | 21/24 |
| Python | 11/12 | 3/12 |
| TOML | 4/15 | 14/15 |

The five Markdown width-sensitive files are `comments.md`, `fences.md`,
`kitchen.md`, `long_sequences.md`, and `nesting.md`; every width diff is inside
a formatted guest fence. `nesting.md` changes only the JSON array in its nested
fence. `prose_wrap.md`'s width-40 and width-80 outputs are byte-identical to
the source despite lines of 192, 245, 174, 167, and 192 characters.

The four TOML width-sensitive files are `arrays.toml`, `kitchen.toml`,
`nested.toml`, and `spelling.toml`; every diff is an array reflow. The brief's
diagnosis is right, but one supporting detail is not: the nine lines over 60 in
`normalisation.toml` are comments, not strings. Taplo leaves all nine overlong
and the width-80 and width-60 outputs are still byte-identical.

Python moved as follows after adding comments and regenerating artifacts:

| statistic | before | after |
| --- | ---: | ---: |
| carries a comment | 3/12 | 7/12 |
| reference changes at width 88 | 3/12 | 4/12 |

No other Python corpus-stat number moved: changed at some width stayed 11/12,
changed at width 60 stayed 11/12, width-sensitive stayed 11/12, reference
overflow stayed 0 at 88 and 4 at 60, and one file remains byte-identical at
both widths.

The new comments exercise four different formatter decisions:

- `calls.py`: a trailing comment follows a call Black wraps at both widths;
- `collections.py`: a trailing value comment lives inside a reformatted dict;
- `defs.py`: an own-line comment attaches before a decorated definition;
- `statements.py`: a trailing comment follows a loop header Black wraps.

`gen_reference.py`, `gen_trees.py`, `ts_scanner_record.py`, and the highlight
scorer's `--update` path regenerated the affected reference outputs, frozen
trees, scanner traces, and highlight spans. Nothing under `corpus/reference/`
was edited by hand.

## Positive controls and validation

Each mutation ran under its own restoration trap and asserted exit status 1
plus the named diagnostic:

- JSON's sole width-sensitive reference was flattened to 0/3: rejected by the
  inherited one-third width threshold while comments remained n/a.
- One Python comment was removed, taking it to 6/12: rejected by the inherited
  strict-majority comment threshold.
- One Markdown guest-fence width diff was removed, taking it to 4/24: rejected
  below the declared minimum of five.
- One TOML array width diff was removed, taking it to 3/15: rejected below the
  declared minimum of four. The arrays-only declaration therefore does not
  disable a real array-sensitivity regression.

Committed unit tests pin those decisions, aggregate failure propagation, and
zero-corpus rejection. Final validation:

- `gen_reference.py --language python --check`: no drift.
- Python gate 3: 24 reference outputs accepted and 56 destructive mutations
  rejected.
- `./test.sh`: exit 0; 178 harness tests, 423/423 formatter gates, 29/29
  highlight goldens, 24/24 injection-parity files, and all remaining probes
  passed.

No policy question remains open. The one intentionally non-mechanical future
check is Markdown's `proseWrap=preserve` comment described above.
