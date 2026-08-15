# editor-tools: design

A syntax highlighter and code formatter that run natively in both Rust and
JavaScript, sharing a downloadable, data-only language package format.

Sibling project to [`vici`](../../vici), which owns the buffer and nothing else.
`vici`'s `Effect::Edit` is already shaped for incremental reparsing; this
project is the thing on the other end of that shape.

## Goals

1. **Two idiomatic implementations, one package format.** Not one implementation
   wrapped in FFI, and not wasm-everywhere. Idiomatic Rust and idiomatic
   JavaScript, kept honest by differential fuzzing — the model that worked for
   `vici`.
2. **Minimal.** The JS runtime must be smaller than Lezer's (17.5 KB gzipped)
   and language packages must be competitive with Lezer's grammars (17–30 KB
   gzipped). See [Size budget](#size-budget).
3. **Packages download on demand.** A web editor pulls the package for the
   language it is about to show. Packages are data, not code, and are cacheable
   and versionable.
4. **Full reflow formatting.** Prettier/black semantics: the formatter owns line
   breaking against a width budget. This is a deliberate departure from Topiary
   — see [Why not Topiary's model](#why-not-topiarys-model).

5. **Readable output first, faithful output second.** The target is a snippet in
   a box — a blog editor on the web, an editing field in a TUI. Matching the
   canonical formatter is how we get a cheap external standard of readability,
   not the goal itself. Where we differ, the tie-break is readability and then
   **consistency across languages**: JavaScript coming out looking a little more
   like Kotlin than a JS developer expects is an acceptable price for a small
   runtime and one predictable layout discipline. See
   [house-style.md](house-style.md), which is where the concrete rules live.

## Non-goals

- **A drop-in replacement for the formatter a project runs in CI**, or for the
  one in your editor. Those are judged on leaving a clean diff against what a
  team already agreed; we are judged on whether the thing in the box reads well.
  This is why some divergences from the reference are the design working rather
  than defects.
- Being a general parser generator. If a language needs a bespoke parser, that
  is acceptable.
- Supporting every language on day one.
- Beating `tree-sitter` on parse throughput. Editor-scale latency is the bar.

## Landscape

Researched August 2026. The quadrant this project targets is empty, but the near
misses are instructive.

| System                                   | Cross-language?     | Minimal? | Real tree? | Reflow? |
| ---------------------------------------- | ------------------- | -------- | ---------- | ------- |
| tree-sitter + `web-tree-sitter`          | via wasm everywhere | no       | yes        | n/a     |
| Lezer                                    | JS only             | **yes**  | yes        | n/a     |
| TextMate (`syntect` / `vscode-textmate`) | **yes, genuinely**  | no       | no         | n/a     |
| Topiary                                  | Rust only           | no       | yes        | **no**  |
| dprint                                   | via wasm everywhere | no       | yes        | yes     |
| Prettier                                 | JS only             | no       | yes        | yes     |

Measured sizes, gzipped:

|                   | runtime                 | JS grammar | Rust grammar | Python grammar |
| ----------------- | ----------------------- | ---------- | ------------ | -------------- |
| `web-tree-sitter` | 80 KB wasm + 31 KB glue | 48 KB      | 115 KB       | —              |
| Lezer             | 17.5 KB (`@lezer/lr`)   | 30 KB      | 25 KB        | 17 KB          |

`syntect` and `vscode-textmate` are the existence proof that the shape works:
two independent, idiomatic implementations reading the same data packages. But
TextMate grammars are regex soup, line-oriented, produce no tree, and both sides
depend on Oniguruma — `syntect`'s `fancy-regex` backend already diverges from
`onig`, which is precisely the differential-testing failure mode we would be
signing up for. Unusable for the formatter regardless.

### The escape-hatch problem

Every serious incremental parsing system has a **per-grammar imperative escape
hatch**, and it is not optional:

- tree-sitter: `scanner.c`, an external scanner compiled into each grammar.
- Lezer: `ExternalTokenizer` / `ContextTracker`, hand-written JS per grammar.
  Verified in the shipped bundles: `@lezer/javascript` has 6 external tokenizers
  and 2 context trackers; `@lezer/python` has 5 and 2.

These exist because Python indentation, JS automatic semicolon insertion,
heredocs, raw strings, template literals and C++ `>>` are not expressible in a
parse table. **A data-only package interpreted by two runtimes cannot express
them.** Three ways out:

1. **Restrict the language set** to grammars that need no scanner — JSON, TOML,
   CSS, SQL, Go-ish. Real, but excludes Python, JS, Ruby.
2. **Define a scanner bytecode** in the package format that both runtimes
   interpret. Bounded work, genuinely novel, and the place where differential
   fuzzing earns its keep.
3. **Ship the scanner as wasm.** JS then needs a wasm engine anyway and the
   pure-JS size win evaporates.

(2) is the bet worth making, and it is the highest-risk part of the project.

**This constraint is deliberately out of scope for the first competition** (see
[competition.md](competition.md)), which cuts the parser out entirely so the
formatting model can be evaluated on its own.

## Highlighter and formatter: one repo, two packages

They share a parse tree and nothing else. Their requirements are opposed:

|                 | highlighter                            | formatter                            |
| --------------- | -------------------------------------- | ------------------------------------ |
| tree quality    | error-tolerant, partial, viewport-only | complete, correct, comments attached |
| latency budget  | ~1 ms per keystroke                    | ~50 ms on save                       |
| on syntax error | degrade gracefully                     | refuse to run                        |
| wrong output    | ugly colours                           | **corrupted source**                 |
| incrementality  | essential                              | irrelevant (whole file)              |

So: one repo, one shared parse layer, two packages on top. Not one library.

The genuine overlap worth exploiting is **auto-indent / format-on-type** —
"format one line at keystroke latency, off the incremental tree". That sits
directly next to `vici` and is the reason to keep both in one place. The other
reason is that the differential fuzz harness is shared machinery, and we want
one of those, not two.

Proposed layout:

```
crates/ + js/
  et-parse      grammar package format, parser runtime, scanner VM
  et-highlight  capture queries -> span stream            (thin)
  et-format     formatting rules -> Doc IR -> text        (thick)
  et-harness    differential fuzzer, corpus, scorer       (shared)
```

### Where the fuzzing risk actually is

Different from `vici`. A table interpreter has a far smaller divergence surface
than vi's semantics — the tables are the shared artifact and the runtimes are
thin. Risk concentrates in exactly two places:

1. the **scanner VM** (arbitrary imperative behaviour, two interpreters), and
2. the **formatter's IR renderer** (width measurement and break decisions, where
   an off-by-one silently changes output).

Point the fuzzer there. Table-driven parsing is comparatively self-checking.

## Formatter model

### Why not Topiary's model

[Topiary](https://topiary.tweag.io/) is the right idea — formatting rules as
tree-sitter queries, compiled to a flat stream of atoms (`Leaf`, `Space`,
`Hardline`, `IndentStart`/`IndentEnd`) which are then rendered. It is the only
serious "global formatting library" that exists.

But **Topiary has no line-width budget.** Its softlines expand to a newline "if
the node is multi-line" _in the input_, and to a space otherwise. It normalises
indentation and spacing while preserving the author's line breaks. That is a
defensible product choice — output is stable and diffs stay small — but it is
not what we want.

A flat atom stream structurally cannot do width-driven reflow: deciding whether
a group fits requires measuring the group's flat width _before_ committing to
its rendering, which means the IR must be a tree with grouping, not a stream.

### Doc IR

We want Wadler/Oppen, as used by Prettier's `doc` and `dprint-core`. Minimum
viable constructor set:

| Constructor     | Meaning                                                    |
| --------------- | ---------------------------------------------------------- |
| `text(s)`       | literal, never broken                                      |
| `concat([..])`  | sequence                                                   |
| `group(d)`      | render flat if it fits in the remaining width, else broken |
| `indent(d)`     | +1 indent level for line breaks inside                     |
| `line`          | space when flat, newline when broken                       |
| `softline`      | nothing when flat, newline when broken                     |
| `hardline`      | always a newline; forces enclosing groups to break         |
| `ifBreak(a, b)` | `a` when enclosing group is broken, else `b`               |

`ifBreak` is what expresses trailing commas, and `hardline` propagation is the
subtle part — a hardline anywhere inside a group must force every enclosing
group to break, which the naive fits-check gets wrong.

Deliberately deferred: `fill` (paragraph-style wrapping, needed for long boolean
chains and markdown), `lineSuffix` (trailing comments), and Prettier's
`conditionalGroup`/`breakParent` machinery. A submission may include them if it
argues they are load-bearing.

### The design space

The competition exists to choose among these. Each is a different answer to
"what is a formatting package, as data?".

**A. Query → Doc IR.** Topiary's front end, Wadler's back end. Queries in a
`.scm`-like language match nodes; matches emit Doc constructors. Package is a
compiled query table. Closest to prior art, most likely to work, largest runtime
(needs a query matcher _and_ a printer).

**B. Node-schema templates.** Package is a map from node type to a template
describing how to lay out that node's children — slots, separators, break hints.
No query engine; dispatch on node type. Much smaller runtime. Weaker at
cross-cutting rules that depend on context rather than node type.

**C. Formatting bytecode.** Package is bytecode for a tiny stack VM that emits
Doc ops. Smallest possible runtime, maximum expressiveness, but the authoring
language and its compiler become the bulk of the work, and two VMs must agree
exactly — the highest divergence risk and the best fuzz story.

**Note on C (August 2026).** All three Phase 1 proposals rejected bytecode.
Codex, asked directly afterwards, confirmed its rejection was **scoped to the
competition, not the real system** — the frozen 15-file corpus rewarded rapid,
inspectable coverage and gave no credit for a VM's verification and amortisation
properties. Treat C as open, with the following corrections to how it is usually
argued.

**"A VM is the smallest runtime" is too strong.** A VM replaces only the _rule
evaluator_. The Doc renderer, CST access, comment handling and token accounting
remain either way, so a specialised schema walker can be smaller than a
sufficiently _safe_ general VM. What C actually costs is scope, not bytes: an
authoring language and compiler, bytecode validation, diagnostics, resource
bounds and versioning, identical stack and control-flow semantics defined twice,
preserving the linearity invariant through arbitrary control flow, and testing
the compiler as well as both interpreters.

**There is no "not a VM" option.** Every proposal's JSON arrays are already an
interpreted instruction representation. The real axis is **constrained,
structurally validated instructions versus general control flow** — not
interpretation versus its absence. B, C and E are points on that axis, and
framing them as different kinds of thing was a mistake in the original design
space.

**Sharing with the scanner VM is real but not free.** Scanner programs operate
on characters, lexer state, lookahead and token emission; formatter programs on
CST values, selectors, comments and Doc construction. The host operations and
safety invariants genuinely differ, and the scanner instruction set should not
be distorted to force sharing. What _can_ be shared, if designed for
deliberately, is one small typed VM core: decoding, stack and control flow,
validation, instruction budgeting, package versioning, and the two-runtime
differential harness — with separate typed host-op sets on top. That makes a
formatter VM much cheaper than a from-scratch one, so once the scanner VM is
committed, "same execution core, separate host operations" becomes the default
candidate rather than a stretch.

**Fuzzability is a real advantage, and narrower than claimed.** Randomly
generated _well-typed_ bytecode is excellent at finding interpreter divergence.
Random bytes mostly exercise rejection paths, and interpreter agreement tests
neither compiler correctness, formatting policy, semantic preservation, nor
idempotence — so source-level differential and property tests remain necessary
regardless.

**Falsifiable conditions to adopt C**, from codex:

1. the scanner VM is already committed;
2. adding formatting costs no more than ~1 KB gzipped of additional runtime;
3. across eight representative languages, compiled bytecode saves at least 0.5
   KB gzipped per formatter package against schemas; and
4. CI differentially fuzzes well-typed bytecode in both interpreters, alongside
   end-to-end semantic-preservation and idempotence tests.

The economic test is
`language count x per-package saving > incremental shared runtime cost`,
adjusted for how many packages a client actually downloads — supporting thirty
languages does not mean any client fetches thirty, so client transfer cost
depends on usage even though CDN aggregate size does not.

**D. Constraint solver.** Encode layout as cost minimisation (Google's `rfmt`,
or "A Pretty Expressive Printer", POPL 2023). Provably optimal output; `O(n·w)`
and much heavier. Probably wrong for this project, but worth someone arguing.

**E. Hybrid.** B for the common case plus a C-style escape hatch where schemas
run out. Likely where a mature version lands; hard to justify before B's limits
are known.

Prior expectation: **A** is the safe baseline and most likely to produce a
working result. **B/E** is the higher-upside bet on size, which is the project's
actual differentiator. **C** is where the differential-fuzzing story is most
interesting. **D** is a long shot.

## Size budget

Targets for the JS side, gzipped, since that is where size is visible:

| Component                                             | Budget  |
| ----------------------------------------------------- | ------- |
| Doc IR printer                                        | ≤ 3 KB  |
| Rule interpreter (query matcher / schema walker / VM) | ≤ 7 KB  |
| Python formatting package                             | ≤ 15 KB |
| JSON formatting package                               | ≤ 2 KB  |

For reference, Prettier's Python-equivalent surface is measured in hundreds of
KB. Beating that is not impressive; beating Lezer-class numbers is the bar.

## Open questions

- Does the highlighter want the same package as the formatter (one download per
  language) or two? Two is cleaner but doubles requests; one wastes bytes for
  viewers who never format.
- Comment attachment: Prettier's algorithm (attach to preceding/following/
  enclosing node by heuristic) is notoriously fiddly and is a large fraction of
  any real formatter's complexity. Can it be expressed declaratively at all?
- Blank-line preservation is input-sensitive in every real formatter (black
  keeps up to 2). This is the one place a reflowing formatter still reads the
  original layout, and it needs to be in the IR, not bolted on.
- Error recovery for the formatter: refuse, or format the well-formed prefix?
