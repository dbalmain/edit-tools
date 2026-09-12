# REVIEW.md — editor-tools review notes

Repo-specific review guidance, accumulated by the review-craft skill. The skill
reads **Standing checks** before every review and appends to the **Findings
log** when a review uncovers a durable lesson. Keep entries terse.

## Standing checks

Mandatory extra criteria every review applies here (promoted from recurring
findings). Each should name the guard that will eventually retire it.

- **A new source-byte read is a new `parity_fuzz.py` site.** Any change that
  reads `node.start`/`node.end` or a child's range in either runtime must add a
  generator to `all_cases()` in `harness/parity_fuzz.py`. That tuple is
  hand-maintained, so a missing entry is invisible. *Retired by:* a test that
  asserts the generator count against the site count named in the docstring.
  Still prose as of 2026-09-12; the count is now 13.
- **A changed runtime rule must be mirrored, and the refusal text must match
  byte for byte.** Assert the exact message in both suites, not `contains`.
  *Retired by:* the shared-fixture table in `harness/fixtures/`.
- **An offload's done-note is not a repo file.** Check for a stray `*.md` at the
  repo root addressed to the orchestrator rather than to the reader.

- **A test generator can share the blind spot of the thing it tests.** Before
  trusting a green mutation/fuzz count, check what the generator *enumerates*.
  `check_gate3.py`'s `adversarial_mutations` walks `node.is_named` nodes only,
  so it could never generate the anonymous-token or untokenised-gap mutations
  that `_generic` was blind to — 804 destructive mutations stayed green over
  `a + b` == `a - b` in four languages. A count is evidence about the generator
  before it is evidence about the code. The cheap proof, once a generator is
  extended: revert the thing under test and confirm the count *fails*. Zero →
  95 is a guard; 8,428 useful mutations on its own is not.
- **Grep `docs/onboarding/FINDINGS.md` before writing an offload brief.** An
  agent briefed on a problem the repo has already analysed re-derives the
  analysis and bills for it. Search the finding, not just the code.

## Findings log

### 2026-09-13 — the non-destruction gate did not compare operators

- **What:** `_generic` recursed into named children only, so every anonymous
  token and every untokenised gap under a node with a named child was invisible
  to gate 3. `a + b` == `a - b` in python, javascript, go and rust; `a and b`
  == `a or b`; and in markdown a two-line list item's whole signature was
  `('inline', (('block_continuation', '  '),))`, holding none of its prose, so a
  deleted word on a continuation line passed.
- **Why missed:** it was *not* missed — `FINDINGS.md` entry 5 recorded it, open,
  reported by YAML's builder, and prescribed the fix that was eventually
  implemented. It was missed by *me*, twice reported to Dave as a new finding,
  because I briefed an agent before searching the findings log. What was new is
  narrower: entry 5 sweeps deletions, so it never saw that respellings are the
  larger class, and untokenised gaps are outside its framing entirely.
- **Guard:** applied. Anonymous tokens and non-whitespace gaps are compared by
  default; `optional_tokens` and `equivalent_tokens` declare the permitted
  transformation classes per language, each derived from a sweep of what
  actually differs rather than guessed. Closed the same day on the generator
  side: three anonymous-token mutation families (`token-respell`, `token-swap`,
  `token-drop`) and a third destructive mutation, `respell_a_token`, which the
  gate must reject for every reference output. Mutation-tested by reverting
  `gate3.py` to the pre-fix signature — 95 failures across 10 languages, exit 1,
  where before the whole suite stayed green. Promoted to a Standing check above.
  One branch stays defensive rather than generated: no reference output in the
  corpus holds an untokenised gap that survives a valid parse (measured: zero,
  every language), so there is nothing to mutate.

### 2026-09-13 — a declaration reachable from only one branch

- **What:** `layout_leaves` silently stopped applying. `_layout` was reached
  only from `_generic`'s no-named-children branch, so once anonymous children
  became visible `pipe_table_delimiter_cell` — which holds anonymous `-` tokens
  — routed into the recurse branch and had the ruler dashes compared that
  `_layout` exists to reduce. Self-inflicted, in the same change.
- **Why missed:** the condition `if not kids` was doing two jobs — "is this a
  leaf" and "should this use the layout reduction" — and only the first was
  named. A declaration whose reachability depends on an unrelated branch test
  will be dropped by the next edit to that test.
- **Guard:** `layout_leaves` is now checked before the children test, with the
  reason in a comment at the site. A stronger guard, not yet applied: a test
  asserting every declared layout leaf in every manifest actually routes to
  `_layout`, which would have failed loudly instead of silently widening the
  gate.

### 2026-09-11 — rustfmt churn rides along with every Rust slice

- **What:** the `source_partitions` slice carried ~14 pure-`cargo fmt` hunks in
  `rust/src/eval.rs`, tripling its reviewable surface, and left `align.rs` still
  drifting — so the repo is now formatted inconsistently.
- **Why missed:** no earlier review looked, because `cargo fmt` is in neither
  `build.sh` nor `test.sh` and nothing declares whether the repo uses it. An
  agent reaching for the obvious tidy-up is behaving reasonably.
- **Guard:** decide once, centrally — either `cargo fmt --check` joins `test.sh`
  (after a separate commit fixing `align.rs`), or `docs/onboarding/WORKFLOW.md`
  says rustfmt is not used here. Not applied.

### 2026-09-11 — a new top-level directory with no route to it

- **What:** `testdata/source_partitions/` was added as an eleventh top-level
  directory. The repo already had a convention for hand-written non-corpus
  trees — `corpus/trees-{dirty,injected,edited}/<lang>__<stem>.tree.json`,
  read through `corpus_in()` / `readTreeIn()`, with the flat-naming rule at
  `docs/onboarding/WORKFLOW.md:233`. Fixtures now live in
  `corpus/trees-partition/`.
- **Correction to this entry:** it first cited `WORKFLOW.md:29-31` as "the
  routing table" and proposed `harness/test_manifest.py` as the guard's home.
  Both were wrong — those lines are the A–C pipeline, not a directory
  inventory, and `test_manifest.py` holds TOML injection-manifest tests.
- **Guard:** `harness/test_repo_layout.py` pins the top-level directory set.
  **Applied.**

### 2026-09-11 — source-byte checks added without a fuzz site

- **What:** `check_source_partition` reads node ranges and refuses on stale
  ones, making it a thirteenth format-path source-byte site.
  `harness/parity_fuzz.py` exists precisely to sweep those, its docstring claims
  "the 12 format-path source-byte sites", and `all_cases()` gained nothing.
- **Guard:** promoted to a Standing check above; the real fix is making the site
  count checkable rather than prose. `partition_cases()` **applied**; the
  count-vs-docstring assertion is not.

### 2026-09-12 — `contains` hid a live twin-runtime parity split

- **What:** applying the "assert refusal text byte-for-byte" standing check
  uncovered a divergence that had shipped: the unknown-package-format refusal
  read ``expected `et-doc-rules/1`…`` in Rust and `expected "et-doc-rules/1"…`
  in JS. The tests asserted it with `contains` and a prefix regex, so neither
  suite could see it. Unified on the Rust spelling.
- **Why missed:** every earlier review read the two implementations as
  mirrored because the *logic* mirrored. The message is part of the contract
  and nothing compared it.
- **Guard:** the standing check found this on its first application, which is
  the evidence it should stay. The durable fix is the shared-fixture table in
  `harness/fixtures/` covering refusal text, not just trees. Not applied.

### 2026-09-12 — a gate that reads another tool's human output

- **What:** `test_javascript_lexer_tests_pass` scrapes `ℹ pass N` from Node's
  test reporter, so it fails whenever `FORCE_COLOR` is set in the environment.
  `NO_COLOR=1` does not help — Node prefers `FORCE_COLOR`. Two separate agent
  runs hit it and each worked around it, which is the reasonable move and also
  how a broken gate survives.
- **Guard:** parse `node --test`'s machine-readable output (`--test-reporter
  tap` or `--test-reporter json`) instead of its human reporter. Not applied.
