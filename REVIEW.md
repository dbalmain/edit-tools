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
- **A whitelist cannot be validated by sweeping real data.** Real inputs vary
  on everything at once, so widening a predicate by one character usually
  changes nothing measurable and the unsafe edit looks free. Measured here: of
  ten deliberately unsafe edits to `harness/prose.py`, only four changed which
  paragraphs were eligible across 209 real markdown files, and the sweep passed
  for the other six. The guard is a **fixture of near misses** — one file whose
  every entry is admissible except in the single respect it is named for, which
  the probe requires to yield zero matches. `harness/fixtures/prose-refused.md`
  took the same battery from 4/10 to 12/13. *Retired by:* nothing; a
  corpus-derived predicate should ship with its refusal fixture in the same
  commit.
- **A reparse only detects damage its grammar models.** "Reparse and compare"
  reads like a total check and is bounded by what the parser represents.
  Markdown's block grammar makes a paragraph's contents one opaque `inline`
  node, so a reflow sweep built on it caught 1 of 10 unsafe edits — emphasis,
  code spans and links were mangled invisibly. Name the grammar a round-trip
  check actually exercises, and reach for an independent oracle (here, the
  package's separate *inline* grammar) for the layer it cannot see. *Retired
  by:* nothing; the habit is to ask "what would this reparse NOT notice?"
- **A measured zero needs a positive control.** A sweep that finds nothing and a
  sweep that runs on nothing are the same output. Before recording a zero, make
  the probe report what it *visited* — files opened, nodes walked — and check
  that number against something independent. Caught here when a reviewer
  contradicted a figure marked VERIFIED: the probe globbed
  `corpus/reference/<lang>/` and that directory is flat, so it opened zero files
  and the true answer was 2,219. *Retired by:* nothing yet; the habit is to
  print the denominator.

## Findings log

### 2026-09-13 — a mutation battery driven by `sed` reported zero survivors

- **What:** the first mutation check of `harness/prose.py` ran its edits through
  a shell `for`/`sed` loop and reported 0 failing tests for two of three
  mutations — read at the time as "the tests do not catch this". The patterns
  contained quotes and slashes that the shell mangled, so `sed` matched nothing
  and the unmutated file was tested. Re-run from a Python mutator, all five
  mutations failed tests as they should.
- **Why missed:** a mutation that does not apply and a mutation that is not
  caught produce the same output. This is "a measured zero needs a positive
  control" one level up — the control belongs on the *mutator*, not only on the
  thing being measured.
- **Guard:** proposed, not applied — have the mutator assert the file changed
  (`text != original`) before running the suite, and fail loudly on a
  non-matching anchor. The Python mutator used afterwards does print
  `ANCHOR MISSING`, which is the same idea done by hand.

### 2026-09-13 — the one producer-agreement gate reported success on zero files

- **What:** `harness/probe_injection_parity.py` is the only check comparing the
  Python parse path against the browser parse path — a *producer* surface, not
  the runtime surface `fmt-rust`/`fmt-js` agreement covers. It returned `0`
  after printing SKIP whenever a generated web blob was missing, and `test.sh`
  runs it unconditionally. Agreement and absence were indistinguishable in the
  output.
- **Why missed:** it reports `24/24` today because the blobs happen to be
  present, so the skip path had never been seen. This is the playbook's "a gate
  that ran zero tests is not a gate" with the exit status, rather than the test
  count, as the tell.
- **Guard:** **applied.** Missing prerequisites now fail; `--allow-missing` is
  an explicit opt-out for working without generated blobs, and `test.sh` uses
  the required mode. Verified by removing `json.blob.json`: required mode exits
  1, `--allow-missing` skips and exits 0.
- **Still open, and it is the larger half:** the required blob set is derived
  from `language` keys in the produced document, so a producer dependency that
  is not an injected language is never required and never missed. Markdown's
  inline grammar would be exactly that if the prose projection used it. A new
  producer dependency has to be *declared* in this probe, not discovered.
  Recorded at the top of the file.

### 2026-09-13 — a probe that swept nothing reported zero, and I believed it

- **What:** I recorded "no reference output contains an untokenised gap that
  survives a valid parse (measured: zero across every language)" in a commit
  message, a module docstring and this file, marked VERIFIED, and used it to
  justify *not* writing a mutation family. The probe globbed
  `corpus/reference/<lang>/` as a directory; `corpus/reference/` is flat
  (`<lang>__<stem>@<width>.txt`), so every language hit `continue` and the sweep
  visited no files. True count: **2,219 gaps across ten languages** — Markdown
  prose, the digits of a CSS number before its named `unit`, TOML and YAML
  string interiors, Rust comment bodies.
- **Why missed:** zero was the answer I expected, so it read as confirmation
  rather than as the signature of an empty sweep. Worse, I discovered the flat
  layout fifteen minutes later while fixing a *different* script, and did not go
  back. An offloaded reviewer contradicted the figure; I re-ran it and the
  reviewer was right.
- **Guard:** promoted to a Standing check above. Concretely applied: the gap
  families now exist (`gap-shorten`, `gap-rewrite`, and a `damaged-gap`
  destructive mutation), and reverting `gate3.py` to the pre-fix signature
  fails 24 of them — the check that "nothing to mutate" had made impossible.

### 2026-09-13 — 50 destructive checks were vacuous by construction

- **What:** the destruction arm mutates the *formatted* reference and compared
  the mutant's signature against `before`, the **source's** signature. For a
  file listed in `incomparable`, `before != after` by definition, so a mutant
  the gate failed to reject still differed from `before` and the check passed
  having tested nothing. 50 of 1,010 destructive mutations, exactly the
  incomparable set across seven languages.
- **Why missed:** the arm was written when `before == after` held for every
  scored file, and `incomparable` was introduced later as an exemption from
  check 1 only. Nothing re-read the destruction arm in that light.
- **Guard:** compare against `after`. **Applied**; all 50 now run and pass, so
  the vacuity hid no live defect. Found by an offloaded reviewer, not by a gate
  — the general shape ("a gate that ran zero tests is not a gate") is in
  `~/.claude/agent-playbook.md` and deserves a repo-local check that every
  destruction mutation is compared against a signature it could actually equal.

### 2026-09-13 — spelling-keyed token declarations cannot express a trailing separator

- **What:** `optional_tokens` / `equivalent_tokens` are keyed on spelling alone,
  with no parent kind, slot or cardinality. Declaring `,` free for a language's
  trailing separators also frees it in positions where it is load-bearing.
  Accepted today: `[1, 2]` vs `[1, , 2]` (js/ts array hole), `g!(a, b)` vs
  `g!(a,, b)` (rust macro arm selection), `x = ",\n"` vs `x = "\n"` (python
  `string_content`, via the gap path). Two independent reviewers found these
  from different directions.
- **Not a regression:** verified by replaying every generated mutation of every
  reference output against both signatures — 1,395 mutants newly rejected,
  10 verdict changes the other way, all of them a trailing `,` before a closing
  bracket in YAML flow collections, which is the declaration doing its job. The
  gate accepted all three counterexamples before it compared anonymous tokens
  at all.
- **Why missed:** `FINDINGS.md` entry 5 prescribed *named transformation
  classes*; I implemented the compare-by-default half and then reached for a
  per-language spelling list, which is the shape entry 5 argued against. The
  justifying comment I wrote in ten manifests — that reparsing still catches a
  load-bearing separator — is false in general, and I asserted it rather than
  constructing the counterexample that would have shown it.
- **Guard:** the false claim is corrected at its source (`manifest.py`, on the
  field) and the ten manifests point there. The mechanism itself is an open
  decision, on the board. Note that the destructive arm **cannot** find this
  class: `respell_a_token` skips any token the manifest declares free, so an
  unsound declaration suppresses the probe that would expose it. A declaration
  audit has to be a separate check that does not consult the declaration it is
  testing.

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
