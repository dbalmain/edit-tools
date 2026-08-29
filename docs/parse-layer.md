# The parse layer: six routes, priced

Both runtimes consume frozen trees. Nothing on the shipped path parses.
`harness/gen_trees.py` does the parsing, with pinned tree-sitter grammars, and
writes `corpus/trees/*.tree.json`; `fmt-rust`, `fmt-js`, `hl-js` all take a tree
as their argument. So "editor-tools formats Python" currently means "given a
tree-sitter-python tree, editor-tools formats Python".

This document prices the ways out. It does not pick one — the numbers are here
so the pick is a decision rather than a drift.

## This is a deferred decision surfacing, not a defect

`docs/design.md` said all of it, in August 2026, before the competition ran:

- Goal 1 is "not one implementation wrapped in FFI, and **not
  wasm-everywhere**".
- Goal 2 is "the JS runtime must be smaller than Lezer's (17.5 KB gzipped) and
  language packages must be competitive with Lezer's grammars (17–30 KB)".
- Goal 3 is "packages download on demand… **packages are data, not code**".
- The proposed layout names `et-parse` — "grammar package format, parser
  runtime, scanner VM" — as a component nobody has written a line of.
- "The escape-hatch problem" names three ways to get a parser and calls the
  scanner VM "the bet worth making, and the highest-risk part of the project".
- And then: "**This constraint is deliberately out of scope for the first
  competition**, which cuts the parser out entirely so the formatting model can
  be evaluated on its own."

`docs/highlight-design.md` says the same thing from the other side: "Against
Lezer as a _language download_ (grammar + highlight), we are not yet in the same
product: **we have no parser package.**"

So the design never claimed a parser. What has happened is that three rounds of
language work — six merged packages, three more in stage B — have accumulated on
top of an unmade decision, and the thing that makes that expensive is in the
next section.

## What the tree-interface probe did and did not establish

`docs/tree-interface-probe.md` proved something real: a hand-rolled JSON parser,
no tree-sitter, fed both unmodified runtimes through the unmodified
`packages/json.json` and produced byte-identical output. The runtime names no
tree-sitter concept. The CST contract is general.

**Interface generality is not package portability.** Dispatch is `node.type`,
with no fallback, and every merged package is written against one grammar's
node-kind inventory — `document`, `pair`, `block_node`, `string_content`. Swap
the parser for a language and the package for that language is rewritten, not
re-pointed. The probe says so explicitly: it had to wear tree-sitter-json's
costume only because the slice forbade changing the package.

That is the cost of postponing: each merged package is a bet on one grammar's
vocabulary, and it is 6 packages today, 17 at the end of round 5. "We can swap
the parse layer later" is true of the runtime and false of the packages.

Roadmap point 3 (a grammar stamp in the package header, deferred because
"nothing downloads packages yet") is therefore not a separate item. **Every
route below fires its trigger**, because every route makes the package's grammar
assumption load-bearing on something other than the harness.

## Measurements

Native grammar sizes, measured today from the wheels this repo pins
(`harness/languages/*.toml`), gzip -9 of the built extension module. Not wasm —
these bundle parser tables, scanner, and the Python binding — so treat them as a
same-order proxy and a ranking, not as download figures:

| Grammar                  | raw     | gz     | external scanner? |
| ------------------------ | ------- | ------ | ----------------- |
| tree-sitter-json 0.24.8  | 39 KB   | 11 KB  | no                |
| tree-sitter-toml 0.7.0   | 78 KB   | 23 KB  | **yes**           |
| tree-sitter-css 0.25.0   | 179 KB  | 34 KB  | **yes**           |
| tree-sitter-go 0.25.0    | 289 KB  | 57 KB  | no                |
| tree-sitter-yaml 0.7.2   | 347 KB  | 82 KB  | **yes**           |
| tree-sitter-js 0.25.0    | 546 KB  | 87 KB  | **yes**           |
| tree-sitter-python 0.25  | 574 KB  | 98 KB  | **yes**           |
| tree-sitter-markdown 0.5 | 941 KB  | 171 KB | **yes**           |
| tree-sitter-rust 0.24.0  | 1234 KB | 153 KB | **yes**           |
| tree-sitter-kotlin 1.1.0 | 3545 KB | 323 KB | **yes**           |

Scanner presence is `nm -a` for `tree_sitter_*_external_scanner_scan` in the
built module. It detects presence, not size or difficulty — TOML's scanner is
surely not Kotlin's. Re-run it before betting on it:

```sh
# one grammar; substitute any pin from harness/languages/*.toml
uv run --with tree-sitter-python==0.25.0 python -c '
import pathlib, subprocess, tree_sitter_python as g
so = next(pathlib.Path(g.__file__).parent.glob("*.so"))
print(subprocess.run(["nm", "-a", str(so)], capture_output=True,
                     text=True).stdout.count("external_scanner_scan"))'
```

Note that `nm -D` (dynamic symbols only) reports **zero** for every grammar
including the ones that have a scanner: the scanner symbols are local, and the
first run of this check was wrong for that reason. `-a` is load-bearing.

**Eight of ten grammars this project already depends on have an imperative
external scanner.** Only JSON and Go do not.

### How big those scanners are, and the number next to them

Line counts at the pinned versions. `scanner.c` came from the sdists where it is
present and from the grammar repos at the version tag where it is not — **the
sdists for python, yaml and css ship `parser.c` without `scanner.c`**, so they
declare scanner symbols they do not define. `parser.c` is the generated tables,
and it is in the table for scale, not for interest:

| Grammar (pin)            | `scanner.c` | `parser.c` | `grammar.json` |
| ------------------------ | ----------: | ---------: | -------------: |
| tree-sitter-json 0.24.8  |        none |      1,061 |          12 KB |
| tree-sitter-toml 0.7.0   |          82 |      4,739 |          18 KB |
| tree-sitter-css 0.25.0   |         100 |     17,861 |          55 KB |
| tree-sitter-go 0.25.0    |        none |     61,521 |         193 KB |
| tree-sitter-js 0.25.0    |         364 |     94,268 |         170 KB |
| tree-sitter-rust 0.24.0  |         393 |    204,337 |         218 KB |
| markdown-inline 0.5.1    |         397 |     75,709 |         192 KB |
| tree-sitter-python 0.25  |         437 |    129,742 |         145 KB |
| tree-sitter-kotlin 1.1.0 |         459 |    677,644 |  not committed |
| tree-sitter-yaml 0.7.2   |       1,415 |     41,384 |         157 KB |
| markdown-block 0.5.1     |       1,602 |     59,787 |         155 KB |

**5,249 lines of C, in nine files across eight grammars** — markdown is two
grammars, block and inline, each with its own scanner. Median 397. The two that
are not like the others are YAML and markdown-block, and both are
whitespace-driven block structure, which is the same reason.

Against that, **1.37M lines of generated `parser.c`**. The scanners are 0.4% of
what a grammar is, which is the thing to hold on to when the hand-port looks
cheap: it is cheap, and it is the small half.

Two plumbing facts found on the way: `grammar.json` is in **no** sdist and is
not committed at all for kotlin, and it is not the source anyway — the source is
`grammar.js`, a JavaScript _program_ calling the DSL, so producing
`grammar.json` means running the tree-sitter CLI over each grammar.

Web figures already in `docs/design.md`, measured August 2026, gzipped:

|                   | runtime                 | JS grammar | Rust grammar |
| ----------------- | ----------------------- | ---------- | ------------ |
| `web-tree-sitter` | 80 KB wasm + 31 KB glue | 48 KB      | 115 KB       |
| Lezer             | 17.5 KB (`@lezer/lr`)   | 30 KB      | 25 KB        |

Against the two grammars measured both ways, wasm gz lands at 0.55–0.75× the
native gz above — so Python ≈ 55–75 KB and Kotlin ≈ 180–240 KB as wasm, which
are estimates and marked as such.

And what we ship today, measured, gzipped: **10.2 KB total** — 8,312 B formatter
runtime plus 2,129 B of packages, with the highlight walker a further 1,576 B
and per-language highlight data at 274–735 B.

### The ratio that is the whole problem

A three-language web editor (JSON, Python, Markdown), route A, all figures gz:

| Component               | Bytes                    |
| ----------------------- | ------------------------ |
| web-tree-sitter runtime | 111 KB                   |
| three grammar wasms     | ~6 + ~65 + ~110 = 181 KB |
| our formatter runtime   | 8.3 KB                   |
| our three packages      | ~3 KB                    |

The parse layer is **25× everything this project has built**, and the marginal
language costs 30–200 KB of parser against 1–2 KB of package. Under the best
imaginable data-only route (Lezer-class tables) the same editor is ~62 KB, so
the spread between the cheapest and the most expensive route is about 4–5×, not
100×. That number is the one to hold while reading the routes.

## The six routes

### A. tree-sitter everywhere — native in Rust, wasm in JS

Rust links the grammar; JS loads `web-tree-sitter` plus one grammar wasm per
language, lazily, cached across languages.

Buys: seventeen grammars available now, at the quality real editors ship.
Incremental reparse and error recovery **for free** — and those are not
conveniences, they are the highlighter's stated requirements (error-tolerant,
viewport-only, ~1 ms/keystroke), and route C would have to build both. It also
**deletes** one of the two places `docs/design.md` says divergence risk
concentrates: with the same grammar version behind native and wasm, the parse
layer cannot diverge between runtimes, so the fuzzer only has to watch the Doc
renderer.

Costs: goal 2 as written is dead — 111 KB fixed plus 30–200 KB per language is
not "smaller than Lezer". Goal 3 is halved: our packages stay data, but the
per-language artifact a client downloads is now mostly code. Goal 1's "not
wasm-everywhere" survives only in the sense that our own layer is not wasm.
Grammar version becomes a shipped compatibility surface (roadmap 3).

### B. tree-sitter in Rust, Lezer in JS

Buys the best JS numbers available without building anything: 17.5 KB runtime,
17–30 KB grammars, incremental and error-recovering, no wasm.

Costs: two grammars per language whose node vocabularies disagree, so every
merged package is rewritten or aliased — and then maintained against two
upstreams. The nine scanner files become nine `scanner.c`s **and** nine
hand-written JS `ExternalTokenizer`s that must agree, which is the scanner-VM
divergence risk with none of the scanner VM's leverage. A generator from
tree-sitter `grammar.json` to a Lezer grammar could at least fix node names by
construction, and cannot fix the scanners.

Verdict: worst maintenance shape on the board. Listed because its JS numbers are
the best and someone will propose it.

### C. Own the parse layer — data-only tables plus a scanner VM

The original `et-parse` plan. Package format grows a parse table; both runtimes
interpret it; imperative lexer behaviour lives in a bytecode VM that both
runtimes execute.

Buys: goals 1–3 as written, one downloadable data artifact per language, ~62 KB
for the three-language editor, and no code execution in the shipped package —
the strongest version of the project's actual thesis. `docs/design.md`'s note on
design C applies directly: once a scanner VM exists, a formatter VM is cheap
because the execution core is shared.

Costs: it is a parser-generator project. Table generation, error recovery,
incrementality, seventeen grammars, and a scanner VM whose necessity is now
measured at **8 of 10 languages** rather than assumed. It reintroduces the
divergence risk route A deletes, at the exact spot the design already flagged as
highest-risk. Three sub-variants matter, and they differ in which half they own:

- **C1, own grammar DSL.** Also owns seventeen grammars. Do not.
- **C2, generate tables from `grammar.json`.** Node types come out identical to
  what the merged packages already target, and the generator is offline harness
  code with zero ship cost. But `grammar.json` is pre-table: rules, precedences,
  declared conflicts, extras, inline, supertypes, keyword extraction. Getting
  from there to _tree-sitter's_ trees means reimplementing tree-sitter's table
  generation, its conflict resolution, and its per-state lexer, where the
  acceptance test is not "parses the language" but "same node inventory, same
  tree shape" — because every merged package and the whole frozen corpus depend
  on it. There is no partial credit: tables that differ anywhere produce trees
  that differ, and trees that differ break packages.
- **C3, transcode tree-sitter's own generated tables.** Run the tree-sitter CLI
  offline, then convert the LR tables out of `parser.c` into our compact data
  format and interpret _those_ in both runtimes. This deletes C2's hard half by
  construction: same tables, same algorithm, therefore the same trees. What it
  still owns is the table interpreter (twice), the scanner VM, and the
  transcoder. **The unverified step is the lexer**: tree-sitter emits `ts_lex`
  as generated C _code_ — a switch-based DFA — not as a table, so it must either
  be recovered from that code or regenerated from `grammar.json`'s token rules.
  The second is far more tractable than the LR tables. C3 is a sketch, not a
  measurement, and the lexer question is the thing to settle before it is a
  plan.

Staging that makes a "no" cheap: build the table half for **JSON and Go first**
— the two scanner-free grammars — and require byte-identical trees against the
frozen corpus before writing a line of scanner VM. That order matters because it
puts the load-bearing unknown first: if tree-sitter's trees cannot be reproduced
for JSON, the route is dead and no scanner was ever written.

The other thing to fix before starting is the acceptance bar, because C2 and C3
assume one and it is not the only one available:

- **Byte-identical to tree-sitter.** Keeps all merged packages and the corpus.
  Hardest bar; the generator must agree with upstream exactly.
- **Our own node vocabulary.** Frees the generator enormously — any correct
  parse will do — and rewrites every package, plus regenerates every frozen tree
  and every golden. Cheaper to build, much more expensive downstream.

These are different projects and the choice is upstream of everything else here.

### D. Restrict the roster to scanner-free grammars

`docs/design.md` option 1. **Priced and dead:** 2 of 10. It excludes Python and
YAML, which are merged, and Markdown, which is the headline requirement.

### E. Hand-write a parser per language, twice

What `harness/json_cst.py` did, promoted to the shipped path. Fine for JSON.
Multiplied by seventeen languages and two runtimes it is 34 imperative parsers,
it converts "add a language = write one JSON file" into "add a language = write
two parsers", and it maximises divergence risk.

Verdict: not a route for the roster. It **is** the route for Aven, which has no
grammar and whose own parser already produces a tree (`LANGUAGES.md` route 1) —
and the probe already showed that path is open.

### F. Do not parse on the client — the tree arrives from outside

Two shapes, and they are complementary rather than rival:

- **Server-side.** For the stated product — "a snippet in a box", a blog editor
  — the read path can be server-rendered (native Rust, native tree-sitter, zero
  client bytes) and format-on-save can be an API call. Only a live editing
  surface needs a client parser at all.
- **Host-provided.** In a host that already has a tree — CodeMirror has Lezer,
  VS Code has tree-sitter — adapt the host's tree to the CST contract and ship
  no parser. One adapter per host instead of one grammar per language.

Buys: the smallest possible client, immediately, and it is the only route where
our 10 KB is the whole download. Costs: the same package-portability wall as B —
a host's node vocabulary is not ours — plus the product constraint that offline
and no-server cases are out.

## Recommendation

**Ship A. Keep C2 as a named, triggered bet. Use F where the product allows it.
E is Aven's route and only Aven's.**

The argument is `DESIGN.md`'s own sentence, applied one layer down: "size is not
the binding constraint for any design in this space… the axis that matters is
whether the rules stay readable." If that is true of formatting packages it
cannot suddenly be false of the parse layer, and it is what makes a 4–5× byte
spread too small to justify a parser-generator project. What the project has
actually built — a data-only package format, two idiomatic runtimes
byte-identical across 30 files and 4 gates, one JSON file per language — is
unaffected by where the tree comes from. It was never the size story on its own;
per-language formatter data is 1–2 KB against Lezer's 17–30 KB of grammar for
the same language, which is the honest comparison and a good one.

Route A also buys the two things the highlighter cannot ship without and the
formatter cannot build cheaply: incremental reparse and error recovery.

What must change if A is chosen, and these are the deliverables:

1. **Rewrite goals 2 and 3 in `docs/design.md`.** Goal 2 becomes a claim about
   the layer above the parser, stated in per-language package bytes against
   Lezer's `styleTags` and grammar figures. Goal 3 becomes "format and highlight
   packages are data; the parser is not". Leaving "not wasm-everywhere" and
   "smaller than Lezer's runtime" in place while shipping 111 KB of wasm is the
   only outcome here that would be dishonest.
2. **Fire roadmap point 3.** Grammar name plus version, or a hash of the kind
   inventory, in the package header — under every route, not just this one.
3. **Promote `docs/tree-interface-probe.md` to a versioned CST contract with a
   conformance suite.** It is already 80% of the spec. The suite is what makes
   C2, E and F cheap later instead of speculative: any parse layer that passes
   it feeds both runtimes.
4. **Measure the real thing once, end to end.** `fmt-js` taking source plus a
   grammar wasm, on the corpus: bytes transferred, cold parse ms, warm reparse
   ms. Every number in this document about wasm is a proxy or an estimate, and
   goal 2's replacement should be written against a measurement.

**The trigger that reopens C2 or C3**: a product requirement that names a client
byte budget under ~100 KB for three languages, or a target with no wasm engine.
Not before, and not on aesthetics.

## The gate in front of any own-the-parser route

This is separate from the routes because it is a prerequisite to all of them,
and it is the reason "5,249 lines is not much" does not settle the question.

**The oracle this repo owns tests full parses of clean files.** Gate 0–3, the
frozen corpus, `probe_tree_interface.py` — all of them compare a complete tree
for a file that parses without ERROR or MISSING. A scanner's job is bigger than
that, and the parts the corpus cannot see are exactly where scanner bugs live:

- **Error recovery.** `gen_trees.py` refuses to emit a tree containing ERROR or
  MISSING, so by construction no corpus file exercises it. The highlighter's
  stated contract is to degrade gracefully on broken input, and nothing here
  measures that today.
- **Incremental reparse.** No test edits a buffer and reparses.
- **Scanner state serialization.** `serialize`/`deserialize` exist so a reparse
  can resume mid-file. A port can be perfect on full parses and wrong on
  resumption, and every gate would stay green.

So a green corpus after a scanner port would be evidence about roughly the
comfortable half of the behaviour. Before the first scanner line is worth
writing, the harness needs a differential fuzzer that makes random edits,
reparses, and compares against tree-sitter as the oracle, in both runtimes. That
is a real project sitting in front of the interesting one — and roadmap point 4
already says the differential-fuzzing claim is currently carried by 30 files.

The repo's own history is the argument for taking this seriously rather than a
theoretical worry: `docs/roadmap.md` records that a narrower measurement had
been flattering the black-agreement score until both widths were scored, and
`agent-playbook.md` records a change that compiled, read correctly, and had no
effect whatsoever. Silent, input-dependent divergence is this project's
established failure mode, and a hand-ported scanner is the purest form of it.

## What I did not determine

Whether `web-tree-sitter` grammar wasm for the pinned versions matches the
0.55–0.75× proxy (item 4 above settles it). Whether tree-sitter's generated
`ts_lex` DFA can be recovered as data, or must be regenerated from
`grammar.json`'s token rules — that is the open question in C3 and the one that
decides whether C3 is meaningfully cheaper than C2. Whether vici's editing
surface is the first shipping target or the web box is, which decides whether F
carries real weight or is a footnote.

Determined since the first draft: the scanner line counts above, which were
listed here as the measurement that could move an own-the-parser route from
"triggered bet" to "do it". They do not, and the reason is the 0.4% figure and
the oracle gap rather than the counts themselves.
