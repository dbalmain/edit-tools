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
  directory. `docs/onboarding/WORKFLOW.md:29-31` is the routing table builders
  read, and `harness/fixtures/` already exists; neither mentions it.
- **Guard:** a test in `harness/test_manifest.py` asserting the set of
  top-level directories against a list in `WORKFLOW.md`, so adding one without
  routing to it fails. Not applied.

### 2026-09-11 — source-byte checks added without a fuzz site

- **What:** `check_source_partition` reads node ranges and refuses on stale
  ones, making it a thirteenth format-path source-byte site.
  `harness/parity_fuzz.py` exists precisely to sweep those, its docstring claims
  "the 12 format-path source-byte sites", and `all_cases()` gained nothing.
- **Guard:** promoted to a Standing check above; the real fix is making the site
  count checkable rather than prose. Not applied.
