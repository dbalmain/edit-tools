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
  approval initially timed out, then the existing pinned cache was approved.

### Integrated checkpoint

- `./harness/gen_trees.py --language markdown`: 24 formatter trees regenerated.
- `./harness/gen_reference.py --language markdown`: 48 pinned Prettier 3.9.6
  references regenerated; no reference bytes changed.
- `./harness/probe_prose.py`: green — 5,632 eligible paragraphs in 143 files
  (1 unparseable), 750 reflow/reparse checks, 3,505 inline-oracle checks,
  6,271 producer verdicts, and 84 cross-runtime/idempotence checks. Its no-op JS
  mutation control still fails.
- Selected after-counts with the baseline metric:
  - `prose_wrap@80`: 9 -> **0**, byte-identical to the reference.
  - `prose_wrap@40`: 16 -> **0**.
  - `sections@40`: 4 -> **0**.
  - `normalisation@40`: 5 -> **0**.
  - `normalisation@80`: 3 -> **0**.
  - `lists@40`: 4 -> **2** (`-2/+1`), solely Prettier moving the trailing
    inline HTML comment to its own line, the explicitly out-of-scope slice.
- `blockquotes@40` now differs only on the same inline-comment attachment.
- Focused Python suites: `test_prose` 56, `test_gate3_prose` 14,
  `test_manifest` 44, all green.
- Mirrored Rust/JS runtime tests cover marker-created extra lines, a bare quote
  marker on a blank line, nested quote/list prefixes, a two-digit ordered
  marker, a loose second paragraph, and source-backed continuation discard.

## Finished in the main thread, 2026-09-21

Codex hit its usage limit at 34 minutes and 384,692 tokens, with the slice
integrated but never gated: its own note says "Full gate: not run yet." The
worktree also had no `web/data/blobs/`, which are gitignored, so `./test.sh`
could not have run there at all -- it stops with "missing generated parse
table(s)". Seeding a worktree with those blobs is a prerequisite for any
offload expected to own the gate.

Four uncommitted Rust files were pure `cargo fmt` output with no semantic
change. Two of them, `align.rs` and `ts/doc.rs`, this slice never touched:
`main` is not `cargo fmt --check` clean and `test.sh` has no fmt step, so that
is pre-existing drift. Reverted rather than swept in.

### What the gate found

Two defects, both the same shape -- a rule still doing by hand what the prefix
scope now does for it.

- `table` collected every token child into a row lead and printed it before the
  row. That lead *is* the host's continuation, so a quoted table came out `> >`
  and a doubly quoted one `> > > >`. Now consumed and checked but not emitted;
  a `pipe_table` carries `block_continuation` children only inside a
  `list_item` or `block_quote`, verified across the corpus, and those are
  exactly the hosts that re-supply it.
- `list_item`'s trailing arm lost its `srcsoft` when its `child` became a
  `discard`, closing the blank line of a loose list. Restoring it then
  double-broke inside a quote, because the paragraph's `container_blank` arm
  was emitting a `hard` for the same line; that arm now discards without
  breaking and list_item owns the break. `container_blank` occurs in exactly
  one shape across the corpus -- block_quote > list > list_item > paragraph,
  all three instances -- so that is the whole of its contract.

The test pinning the old table contract was rewritten, not deleted: the table
alone asserts the leads are dropped, and a second mirrored test puts a real
`prefix` host around it and asserts the marker reaches every row. Deleting the
lead emission without a host passes the first and fails the second.

### Bookkeeping

Five stale ledger records all resolved the same way and were retired:
indented_code@40, nesting@40, normalisation@80/@40, tables_nested@40.

`probe_secondary_grammar`'s audited range set is derived from
`prose.CONTAINERS`, so it moved from 2,553 ranges to 3,747. Its corpus is
frozen at AUDIT_COMMIT, so the set could only grow -- and it was checked to
have done only that: all 2,553 earlier ranges still selected, 1,194 container
paragraphs added across 74 files. The digest the probe printed is not evidence
for itself; that subset check is.

### Final

`./test.sh` green. 292 harness tests, 423 reference outputs, 24/24 injection
parity, 3,747/3,747 secondary ranges, 0 stale, 0 unreviewed, 0 defect.

markdown 18 agreement / 28 comparable with 10 excluded, to **27 / 34 with 7**.
Eligible paragraphs 3,502 -> 5,639.

Our own overflow across the markdown corpus at widths 40 and 80 falls from 74
lines to 58. Note the scoreboard's "its own overflow" is `reference_overflow`
-- prettier's number, not ours -- and it moves when corpus membership changes;
it is not a measure of this formatter.

The three files still excluded wait on inline HTML-comment attachment, which
is a separate slice.
