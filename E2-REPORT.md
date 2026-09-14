# E2 — A2 inline-grammar feasibility report

Status: measurement in progress. This document is deliberately committed before the experiments so that partial findings survive interruption.

## Executive summary: price and shape

- Scanner-port price: **9,130 B source / 462 B packed**, with no new VM opcode found; replay is green over 8,631 calls. Engineering-time conclusion still TBD.
- Inline grammar blob/runtime price: **450,325 B raw / 43,556 B gzip** for the transcoded blob including the 462 B scanner. Effective shipped-payload interpretation still TBD.
- Real A2 coverage: **TBD** (safe-only eligible paragraph count and percentage).
- Main hidden difficulty: **TBD**.
- Recommended slicing: **TBD**.

## Reproducibility

- Worktree: `/home/dave/w/editor-tools-wt/e2-a2-price`
- Branch: `spike/a2-price`
- Starting commit claimed by brief: `f281982` (`wt/prose-a1`); verified as full commit `f2819822fa033987e86db79143ab8ffecb900a35`.
- Repository/corpus commit measured: measurements begin at `f2819822fa033987e86db79143ab8ffecb900a35`; final report commit TBD.
- Commands, temporary inputs, and generated artifacts: **TBD**.
- Tracked files changed for measurement: this report initially; any later experimental changes will be listed here with purpose and commit.

## Brief fact check

Definitions: physical line counts use `wc -l`; byte sizes use `wc -c`; gzip measurements record the exact command and inputs.

| Claim | Claimed | Measured | Result / notes |
|---|---:|---:|---|
| `harness/ts_lr.mjs` physical lines | 2,585 | 2,585 | Matches (`wc -l`). |
| `harness/ts_scanner_vm.mjs` physical lines | 504 | 504 | Matches (`wc -l`). |
| block scanner `.program.js` bytes | 54,591 | 54,591 | Matches (`wc -c`). |
| block scanner `.svm` bytes | 20,842 | 20,842 | Matches (`wc -c`). |
| current gzipped shipped runtime bytes | 18,676 | 19,780 | **Diverges by +1,104 B** if the claimed artifact is `gzip -9 -c runtime-js/bundle.js`; artifact interpretation still being checked. Python `gzip.compress(..., 9)` gives 19,770 B. |
| inline scanner source physical lines | 397 | 397 | Matches for 0.5.1 sdist `tree-sitter-markdown-inline/src/scanner.c`. |
| A2 ceiling, paragraphs | 3,083 | TBD | Bucket definition/corpus TBD. |
| A2 ceiling, percent | 61.1% | TBD | Denominator TBD. |
| Rust crate exports `inline_language()` | yes | TBD | API/crate revision TBD. |
| browser harness lacks included-range second pass | yes | TBD | Driver/API inspection TBD. |

Every divergence from the brief will be called out explicitly here and in the relevant section.

## 1. Inline scanner port

### Pipeline audit: generic versus block-specific

The pipeline is reusable but not fully grammar-agnostic as checked out at `f281982`:

- `ts_scanner_build.mjs`, the assembler, packer, and VM are scanner-name/data driven. Once a `.program.js` exists, `ts_scanner_build.mjs markdown_inline` produced the `.svm` without runtime changes.
- The pipeline does **not** compile C automatically. A `.program.js` is a reviewed hand-port of `scanner.c`; that is the actual port cost. `ts_scanner_record.py` records the C oracle but does not produce VM bytecode.
- The recorder selected only the manifest's `grammar_symbol = "language"`, hence the block grammar. An experimental `--grammar-symbol inline_language` override was added for this spike.
- That override exposed a second assumption in `ts_grammars.wanted`: it understood `language_inline`, not the binding's real `inline_language` spelling. The spike teaches it both spellings.
- Replay originally equated scanner artifact name, trace-directory name, and corpus-directory name. Experimental `--trace-dir` and `--source-language` overrides were needed to replay `markdown_inline.svm` against traces generated from `corpus/src/markdown`.

Thus the VM/package format is grammar-agnostic, but the checked-out orchestration is one-grammar-per-manifest and therefore block-specific for Markdown. The plumbing repair is small; authoring/verifying the bytecode remains manual.

### Inline scanner source and build procedure

Source: PyPI sdist `tree-sitter-markdown==0.5.1`, fetched by the repository's `ts_grammars.py`; `harness/wasm/grammars.tsv` records upstream tag `v0.5.1` and tree hash `2dfd57f547f06ca5631a80f601e129d73fc8e9f0`. The fetched scanner is 397 physical lines and 15,883 bytes; generated `parser.c` is 2,259,663 bytes and declares ABI 15 / 15 external tokens.

The experimental hand-port is `harness/scanners/markdown_inline.program.js`; `node harness/ts_scanner_build.mjs markdown_inline` produced `harness/scanners/markdown_inline.svm`. Neither is wired into a manifest or shipped path.

### Artifact sizes

| Scanner | `.program.js` bytes | `.svm` bytes | Notes |
|---|---:|---:|---|
| Existing block scanner | 54,591 | 20,842 | Baseline; exact match to brief |
| Inline scanner | 9,130 | 462 | Experimental hand-port and its generated packed VM program |
| Delta | -45,461 (-83.3%) | -20,380 (-97.8%) | Inline versus block |

### VM capability gap

**No missing VM capability was found.** The inline scanner needs lookahead, `advance(false)`, `mark_end`, `eof`, indexed `valid_symbols`, branches/calls, integer comparison/add/subtract, bitwise AND/OR, token emit/fail, and four persistent `uint8_t` fields. Every operation already exists. `uint8_t` counter overflow is expressed as `ALUI AND 0xff`; the ASCII CommonMark punctuation test is one class table.

The C `malloc(sizeof(Scanner))` / `free` lifecycle does not require an opcode: VM registers are the scanner instance. Upstream serialisation is exactly four raw `uint8_t` values; the VM serialises the four persistent registers as signed LEB128. Bytes differ by design, but replay checks a bijection between upstream and VM states. All four values are bounded to 0..255, so the VM form is at most eight bytes, far below tree-sitter's 1,024-byte state cap. No stack, string buffer, recursion, libc classifier, range-start query, or new serialisation shape is required.

### Replay and verification results

| Check | Result | Scope and command | Failure, if any |
|---|---|---|---|
| `ts_scanner_replay.mjs` | PASS | 24 Markdown corpus files; 8,631 scan calls; 189 state observations | 0 mismatches |
| `ts_verify_lex.py` | PASS | 2,247 lexer states × 117 codepoint classes = 790,944 runs | 0 disagreements |
| `ts_verify_blob.py` | PASS | 83,595 table entries compared with compiled C memory | Every entry agrees |
| `ts_scanner_build.mjs --check` | PASS | Re-encode packed scanner | 462-byte artifact is current |

The recorder reported 17,451 trace records; replay's 8,631 figure counts scan calls, while 189 counts serialisations. The remainder are deserialisations and are still exercised by replay.

### Scanner-port estimate

**TBD:** separate measured facts from engineering estimate; state the smallest work needed for a production port and its principal uncertainty.

## 2. Inline grammar blob and browser runtime

### Transcode result and blob size

| Artifact | Raw bytes | Gzip bytes | Measurement command |
|---|---:|---:|---|
| Current shipped runtime baseline | TBD | 18,676 claimed / TBD measured | TBD |
| Inline grammar blob alone | 450,325 | 43,556 | `wc -c`; `gzip -9 -c ... | wc -c` |
| Runtime with inline grammar added | TBD | TBD | TBD |
| Increment | TBD | TBD | TBD |

The inline row is compact JSON from `ts_transcode.py`, generated from the 0.5.1 inline `parser.c` with `--scanner harness/scanners/markdown_inline.svm`; it therefore includes the 462-byte scanner as base64. It has 1,161 parse states, 2,247 lex states, no keyword lexer, and 15 external tokens. The like-for-like block blob is 469,172 B raw / 50,470 B gzip, so inline is 18,847 B raw / 6,914 B gzip smaller than block, not a small adjunct to it.

### Can `ts_lr.mjs` drive two grammars over one document?

**TBD:** document parser construction/data loading constraints and whether multiple grammar objects can coexist.

### Range / included-range second pass

**TBD:** trace how input position, byte offsets, rows/columns, EOF, and included ranges are represented. State whether an inline parse can be limited to the block pass's `inline` node ranges without copying, whether copying a substring is semantically equivalent, and what implementation/testing is missing.

### Cost of the second pass

**TBD:** price loader/runtime changes, range-aware lexer/parser work, tree/range mapping, scanner integration, error handling, and parity verification separately. Identify any cheaper correct route.

## 3. Corpus coverage

### Corpus identity and denominator

**TBD:** corpus path/source, repository commit, corpus revision if separate, paragraph denominator, and exact A1 refusal extraction procedure.

### Bucket definitions

Paragraph-level constructs will be multi-label unless explicitly stated otherwise. The final report will define exact inline grammar node/token mappings for:

- emphasis;
- strong emphasis;
- code span;
- inline link;
- autolink;
- each construct outside that safe subset;
- parse error / unclassified;
- `safe-only`: contains one or more of the five named safe constructs and no other meaning-bearing inline construct under the recorded policy;
- `genuinely hard`: exact operational definition **TBD**, with reasons separated rather than collapsed.

Whitespace, plain text, punctuation, escapes, and entities need an explicit policy before counting; **TBD**.

### Histogram across A1 `inline token` refusals

| Construct/reason | Paragraphs | Percent of `inline token` refusals | Multi-label notes |
|---|---:|---:|---|
| Emphasis | TBD | TBD | TBD |
| Strong emphasis | TBD | TBD | TBD |
| Code span | TBD | TBD | TBD |
| Inline link | TBD | TBD | TBD |
| Autolink | TBD | TBD | TBD |
| Other constructs (expanded in final) | TBD | TBD | TBD |
| Parse error / unclassified | TBD | TBD | TBD |

### Safe-only result and reachable coverage

- A1-eligible paragraphs: **TBD**.
- A1 refusals with reason `inline token`: **TBD**.
- Safe-only among those refusals: **TBD**.
- A2 reachable eligible total under the recorded safe-subset definition: **TBD**.
- Reachable percent of all paragraphs: **TBD**.
- Relationship to the 3,083 / 61.1% ceiling and the earlier 1,084 figure: **TBD**.

### Hard blockers

| Blocking construct/reason | Paragraphs | Why it is outside A2 / hard | Overlap policy |
|---|---:|---|---|
| TBD | TBD | TBD | TBD |

### Coverage caveats and validation

**TBD:** ambiguous constructs, malformed markup, grammar error nodes, sampled manual validation, and any discrepancy between byte-based A1 detection and inline-tree classification.

## 4. Native-side feasibility check

**TBD:** verify `language()` and `inline_language()` at the exact dependency revision, then inspect what `gen_trees.py` and downstream serialization would actually require. Explicitly test the claim that native support is "one call" and note range/offset implications.

## 5. Recommended A2 slices

**TBD:** propose ordered, independently testable slices based on measured scanner, runtime/range, and coverage costs. Each slice will state scope, payoff, dependency, and exit criterion. This is a recommendation only; the projection widening will not be implemented in this spike.

## 6. Risks, unknowns, and conclusion

**TBD:** identify the one issue most likely to make A2 harder than assumed, distinguish measured blockers from remaining uncertainty, and give the final price/shape judgment.

## Appendix A: command log

**TBD:** commands sufficient to reproduce every reported number.

## Appendix B: generated/experimental files

**TBD:** every generated file, whether tracked, why it exists, and whether it is a measurement artifact rather than shipped implementation.

## Appendix C: raw classifications

**TBD:** path to machine-readable output or embedded summary sufficient to audit all coverage buckets.
