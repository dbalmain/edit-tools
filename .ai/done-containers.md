# Container-prefix ownership — running done-note

## Initial verification at `0e42048`

- The checkout is clean on `wt/containers`; `HEAD` and the merge-base with
  `main` are both `0e42048c4d5d5012fa093298a1c75dd1cba25688`.
- `rust/src/attach.rs::whitespace_node` accepts only undelegated leaf nodes
  whose text is entirely ASCII whitespace. A `block_continuation` containing
  `>` therefore cannot disappear merely by adding its kind to
  `whitespace_nodes`; source syntax is deliberately rejected on that path.
- `corpus/trees/markdown__blockquotes.tree.json` has the stated 28
  `block_continuation` nodes. The committed tree has **five** distinct byte
  spellings, not seven: 8 `>`, 15 `> `, 1 `>   `, 1 `> >`, and 3 `> > `.
  Two continuation nodes are descendants of `inline` nodes (ranges 44..112
  and 119..146), as stated.
- The unconsumed-child refusal is currently at `rust/src/eval.rs:103`, not
  line 100. The source-partition checks begin at line 1094 and enforce
  non-empty, abutting children plus full range coverage, as stated.
- The requested release binary was absent in this fresh worktree, so the
  before-output measurement awaits a release build. Empty redirected files
  from that failed attempt were not treated as baseline evidence.

## Design questions in progress

- Continuations need syntax-aware ownership, not whitespace classification.
- The competing "ordinary prose gap" hypothesis is only half right. A
  continuation between ordinary atoms can belong to one breakable logical gap,
  but a continuation inside a protected code span/link cannot: making it a fill
  separator would split the protected atom. The source-backed representation
  therefore uses an interior `prose_atom`, with exact `prose_segment` leaves
  separated by owned `prose_continuation` ranges. Those continuations render as
  hard breaks inside the one fill item. The design doc's warning is correct for
  the straddling case; it was too broad for between-atom gaps.
- `prose_gap` is no longer attachment whitespace. It is an exact source-backed
  range consumed explicitly by the rule before `line`; in a container it can
  cover `newline + block_continuation + normalised leading spaces`. This keeps
  `source_partitions` total without pretending `>` is whitespace.
- Prefix indentation now has two package-declared modes in addition to the
  existing source mode: `spaces` derives a hanging indent from a list marker's
  display width, and `marker` retains a trimmed marker on blank lines. The Doc
  printer composes blank prefixes through nested indent units.

## Baseline differing lines

Metric: for each non-equal `difflib.SequenceMatcher` block, count the larger of
the reference/output side; this avoids counting a replacement twice.

- `prose_wrap@80`: 9 (`-9/+3`), exact byte comparison fails.
- `prose_wrap@40`: 16 (`-16/+3`).
- `sections@40`: 4 (`-4/+2`).
- `normalisation@40`: 5 (`-5/+3`).
- `normalisation@80`: 3 (`-2/+3`).
- `lists@40`: 4 (`-4/+2`).

## Validation log

- Full gate: not run yet.
- Exact `prose_wrap.md@80` comparison: fails at the baseline, 9 differing lines.
- `python3 -m unittest discover -s harness -p test_prose.py`: 56 tests green
  after the Python projection change.
- Rust runtime/package changes compile; JS runtime and projection parse.
- Real-parser `probe_prose.py`: dependency fetch needed; sandbox-network
  approval timed out before the probe ran.
