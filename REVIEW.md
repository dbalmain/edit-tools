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

## Findings log

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
