# A2.0 running done-note

## 2026-09-17: reading and design checkpoint

Read, in order:

1. `docs/prose-projection.md`
2. `/home/dave/w/editor-tools-wt/e2-a2-price/E2-REPORT.md`
3. `harness/probe_prose.py`
4. `/home/dave/style-guide/common.md`

The shipped A1 projection is deliberately independent of the inline grammar.
A2.0 must preserve that boundary: parse and retain an inline CST, but do not
call or widen `harness/prose.py` / `harness/prose.mjs`, alter package rules, or
make the browser formatter consume the new tree yet. The block CST must remain
the document's formatter tree so A2.1 can check candidate gaps against both
grammars.

The existing grammar VM and blob format are reusable. The missing abstraction
is a manifest-declared parse companion: a named grammar artifact, the binding
symbol that constructs it, and the host block-node kind whose contiguous byte
range it parses. Proposed schema:

```toml
[[secondary_grammars]]
name = "markdown_inline"
grammar_symbol = "inline_language"
within = "inline"
```

`name` is the globally unique artifact/scanner/grammar-source identity and
therefore replaces the spike's trace-directory override. The containing
manifest supplies the source/corpus language and therefore replaces its
source-language override. `grammar_symbol` replaces the recorder override and
selects the native binding. `within` is the block-CST range selector. The
secondary grammar inherits the manifest's pinned distribution and importable
module; duplicating those fields would allow the two declarations to drift.
The blob stays `markdown_inline.blob.json`, separate from `markdown.blob.json`,
so browser shipping policy remains configuration rather than architecture.

Expected runtime shape: parse the block document exactly as today; walk its
original CST for every declared `within` node; parse `source[start:end]` with a
cached secondary parser/blob; reject a secondary root with any ERROR or MISSING;
convert its nodes with the one constant `start` rebase; retain the resulting
secondary roots in a sibling document field rather than splice them into or
replace the block tree. The precise public field name/shape remains to be fixed
after tracing every frozen-tree and formatter consumer. Refusal diagnostics
must be produced by one mirrored contract and tested byte-for-byte.

Initial spike facts accepted only as hypotheses pending local regeneration:
inline scanner 9,130-byte source / 462-byte packed artifact; inline blob
450,325 raw / 43,110 gzip; 8,631 replayed scan calls; 2,553 slice/rebase pairs;
no required VM opcode. The report itself already records a stale formatter
baseline (18,676 claimed versus 19,770 measured) and a commit-relative A2
ceiling difference (3,083 at `3dbf9d3`, 3,089 at `f281982`).

Hardening plan: review the hand port line by line against upstream 0.5.1,
generate committed adversarial scanner inputs that cover malformed/unclosed
spans, delimiter flanking, delimiter runs including uint8 wrap boundaries, CR,
LF, tabs, punctuation and serialized-state continuation, then run the real C
recorder/replay plus lexer/table oracles through manifest selection. A positive
control must establish that malformed secondary roots actually reach the new
refusal check in both producers.

Untouched by rule: `harness/score.py`, corpus sources/references, packages, and
the A1 eligibility implementations.

## 2026-09-17: manifest, scanner and dual-parse implementation

Implemented `[[secondary_grammars]]` with three required fields: globally
unique artifact `name`, native binding `grammar_symbol`, and contiguous host
node `within`. Markdown declares `markdown_inline` / `inline_language` /
`inline`. Primary and secondary parser construction, grammar-source selection,
scanner recording/replay, transcoding and web generation now all derive their
identities from that declaration; the spike-only grammar-symbol, trace-dir and
source-language overrides are gone.

The native producer and browser producer attach rebased inline CSTs in a
top-level `secondary` array. They do not replace or become children of the block
CST. Every entry names its grammar and host kind and repeats the exact host byte
range, which leaves the block tree directly available to A2.1. The browser blob
is generated/fetched as `markdown_inline.blob.json`, separate from the block
blob; `secondaries.json` is the configuration switch that makes the asset
required, so lazy-load, eager-load and browser-disabled policies do not require
changing the parser or blob format.

Dirty inline roots are hard refusals. Native uses `root_node.has_error`; the
table interpreter uses root `errorCost`, which includes ERROR and invisible
MISSING descendants. Both emit the exact message `<file>: secondary grammar
markdown_inline refused dirty inline range <start>..<end>`. The committed
`secondary-dirty.md` fixture contains a missing latex delimiter and reaches
this branch in both producers; the clean control reaches attachment.

Scanner review against upstream 0.5.1 found the hand translation faithful: the
token ordering, four persistent uint8 fields, leaf-delimiter lookahead,
close-before-open emphasis precedence, mark-end placement, and punctuation
class all correspond. Adversarial recording did expose a defect in the oracle
rather than the port: `trace_scanner.c` silently truncated lexer-operation logs
at 65,535 bytes. Its buffer now grows instead of truncating, so long lookahead
cannot manufacture a replay mismatch or a false pass.

Committed scanner inputs cover every ASCII punctuation byte on both emphasis
flanks, space/tab/newline flanks, mixed delimiters, run lengths through 31, and
dedicated unclosed/mismatched code and latex spans. Native recording now sees
43,283 records across 29 files; VM replay covers 20,629 scan calls and 2,025
state observations with zero mismatches. The `.program.js` remains 9,130 bytes
and packed `.svm` remains 462 bytes: no new VM opcode was needed.

Regenerated/verified inline blob facts exactly match the spike: 450,325 bytes
raw, 43,110 deterministic gzip; 2,247 lexer states x 117 codepoint classes =
790,944 runs with zero disagreement; 83,595 compiled table entries agree. The
ABI-15 zero-reserved-word and sibling-scanner verifier fixes from the spike are
retained because the actual inline oracles require them.

`probe_secondary_grammar.py` reconstructs the immutable A1 target set from
commit `f2819822fa033987e86db79143ab8ffecb900a35` instead of committing the
spike's 60k-line classification JSON. It proves 2,553/2,553 complete rebased
inline CSTs are byte-identical across native and browser production paths, then
checks the clean and identically-refused dirty controls. This independently
reproduces the spike's 2,553 count.
