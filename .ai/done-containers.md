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
- The projection must preserve truthful, contiguous source partitions while
  removing owned prefix ranges. The straddling-atom case will be tested through
  the real projection and both runtimes before choosing refusal versus a
  range-aware representation.

## Validation log

- Full gate: not run yet.
- Exact `prose_wrap.md@80` comparison: not run yet (release binary pending).
