# Route A, measured

`docs/parse-layer.md` closes with four deliverables, of which the fourth is
"measure the real thing once, end to end… every number in this document about
wasm is a proxy or an estimate". This is that measurement: `web-tree-sitter`
plus one grammar wasm per language, run against the frozen corpus, on the
sixteen grammars this repo pins.

It reports three things, in the order they should change your mind:

1. **Tree identity holds on clean input.** All 234 frozen trees reproduce
   byte-identically through wasm.
2. **It does not hold on broken input**, and route A's stated reason for
   existing — that a shared grammar version makes divergence impossible — is
   false as written. Three distinct mechanisms, only one of which is the locale
   bug found elsewhere.
3. **The sizes are close to the estimate; one of the timings is not.**
   `web-tree-sitter`'s runtime figures are exactly right. The 0.55–0.75× grammar
   extrapolation holds for 6 of 16. And incremental reparse — one of the two
   things route A is credited with buying — misses the stated 1 ms/keystroke
   budget on five languages, including Markdown.

Everything here is reproducible from `harness/wasm/`. Nothing in this document
was carried over from another document; where a figure agrees with a prior
estimate that agreement is stated as a result.

## What was measured, and with which grammar

The pins are `harness/languages/*.toml`. Getting wasm for exactly those versions
was the hard part, and the route is a deliverable in its own right.

| Component                    | Version                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| Grammar wasm                 | Built from the pinned source; commits in `harness/wasm/grammars.tsv` |
| `web-tree-sitter`            | 0.26.13, and 0.26.0 for the version-controlled comparison            |
| Native side (for comparison) | py-tree-sitter 0.26.0 with the pinned wheels                         |
| tree-sitter CLI (build only) | 0.26.8                                                               |
| Node                         | 24.19.0                                                              |

**Every grammar measured matches this repo's pin.** No version was bumped and no
mismatch was smoothed over. That claim is backed by a source diff rather than by
the tag name: for thirteen of the sixteen, the git tag's `src/parser.c` is
byte-identical to the PyPI sdist's. The three exceptions are each recorded
rather than waved through:

- **rust** — the tag's generated header stamps
  `.minor_version = 23, .patch_version = 3` and the sdist's stamps 24/0, a
  difference of 43 bytes in a 6.4 MB file and confined to the version stamp; the
  LR tables are identical. Built from the **sdist** `parser.c` so the wasm
  carries the pinned stamp.
- **scheme** — pinned as a git URL, so there is no sdist to diff against. Built
  from the pinned tag.
- **kotlin** — the PyPI project is published from
  `tree-sitter-grammars/tree-sitter-kotlin`, not the `fwcd` repo that a search
  finds first; `fwcd` has no `v1.1.0` at all, its tags stop at 0.3.8. Both
  `parser.c` and `scanner.c` at the correct repo's `v1.1.0` are byte-identical
  to the sdist.

### The build route, since it is on the "could not measure" list elsewhere

Three obstacles, and what got past each.

**`tree-sitter build --wasm` does not use emscripten or docker.** On CLI 0.26.8
it downloads a wasi-sdk toolchain to `~/.cache/tree-sitter` and invokes its
`clang` directly. That binary is dynamically linked against a generic-linux
loader and will not start on NixOS:

```
Error: wasi-sdk clang command failed: Could not start dynamically linked
executable: /home/dave/.cache/tree-sitter/wasi-sdk/bin/clang
```

The fix is a container, and it is there **for the glibc, not for emscripten**.
It must be Debian trixie or newer: `tree-sitter-cli` 0.26.8 needs `GLIBC_2.39`
and bookworm ships 2.36, which fails as `version 'GLIBC_2.39' not found`.
`harness/wasm/build_grammars.sh` bakes the wasi-sdk download into the image so
each rebuild is not a 114 MB fetch.

**Three sdists ship `parser.c` without `scanner.c`.** `tree-sitter-css`,
`tree-sitter-python` and `tree-sitter-yaml` all have external scanners, and all
three sdists omit the scanner source. The published wheels — the artifact this
repo actually pins — are built in CI from the git checkout and do include it.
Building from the sdist would therefore have produced a scanner-less parser and
a quietly wrong tree for three languages, with every gate still green. The git
tag is the source of truth here, and `grammars.tsv` records the commit.

**`tree-sitter build --wasm` regenerates from `grammar.js`.** It does not
compile the shipped `parser.c`. This is why provenance had to be established by
diffing `parser.c` against the sdist rather than assumed from the tag: the check
is that the tag's _committed_ `parser.c` matches the pin, and separately that
the regenerated tables produce the pinned tree — which is what the corpus result
below actually proves.

`tree-sitter-wasms@0.1.13` was not used. It is reported elsewhere to fail on
`web-tree-sitter@0.26.13` outright (legacy `dylink` section where the loader
asserts `dylink.0`), and it would not have carried the pinned versions anyway.

## 1. Tree identity: 234/234

```sh
harness/parse_wasm.js --check
```

| Language   |   Files | Identical | Mismatched |
| ---------- | ------: | --------: | ---------: |
| css        |      15 |        15 |          0 |
| go         |      16 |        16 |          0 |
| haskell    |      16 |        16 |          0 |
| html       |      16 |        16 |          0 |
| javascript |      14 |        14 |          0 |
| json       |       3 |         3 |          0 |
| kotlin     |      16 |        16 |          0 |
| markdown   |      15 |        15 |          0 |
| python     |      12 |        12 |          0 |
| ruby       |      15 |        15 |          0 |
| rust       |      19 |        19 |          0 |
| scheme     |      15 |        15 |          0 |
| toml       |      15 |        15 |          0 |
| typescript |      16 |        16 |          0 |
| xml        |      15 |        15 |          0 |
| yaml       |      16 |        16 |          0 |
| **TOTAL**  | **234** |   **234** |      **0** |

**No files were skipped.** The six markdown trees carrying an embedded subtree
are included; `harness/parse_wasm.js` reimplements `harness/injection.py`'s
region routing rather than skipping them, because they are the one structurally
interesting case and dropping them would have cut the bar to 228.

Identity here is stronger than structural equality: all 234 also re-serialize
byte-identical to the committed file, so `JSON.stringify(doc, null, 1)` lands on
the same text as Python's `json.dumps(indent=1, ensure_ascii=False)`.

### The one thing that had to be got right

`web-tree-sitter`'s `startIndex`/`endIndex` are **UTF-16 code-unit indices into
the JS string, not byte offsets**, while `gen_trees.py` works entirely in bytes.
The `.d.ts` comment describing the parse argument as "UTF8-encoded text"
describes the runtime's internals, not its return values. Verified rather than
assumed: `{"kéy": "vàl", "b": [1,2]}` is 26 UTF-16 units and 28 UTF-8 bytes, and
its `document` node comes back `[0,26]`. `harness/wasm/runtime.js` holds the
conversion. Any consumer that skips it is wrong only on non-ASCII input, which
is the failure mode this project already knows it is bad at noticing.

## 2. Divergence

> "with the same grammar version behind native and wasm, the parse layer cannot
> diverge between runtimes, so the fuzzer only has to watch the Doc renderer" —
> `docs/parse-layer.md`, route A

That sentence is load-bearing for the recommendation, and it is false. Three
separate mechanisms produce different trees, and they have different causes,
different blast radii and different fixes. Reporting them as one number would be
the mistake.

### Mechanism 1 — locale-dependent libc in external scanners

Native only; wasm is a fixed reference point. `harness/wasm/locale_probe.js`.

Generated `ts_lex` classifies characters with codepoint ranges compiled into
`parser.c`, so `é = 1` is locale-proof in every grammar. Hand-written external
scanners are not: **seven of the sixteen** pinned grammars include `<wctype.h>`
in `scanner.c` and call `isw*` on `lexer->lookahead` — css, html, javascript,
kotlin, markdown, ruby, rust. glibc answers those according to `LC_CTYPE`;
compiled against wasi-libc there is no locale and the answer is a fixed Unicode
table.

Presence of the call is not enough — it has to be on the decision path. Of four
constructed candidates only Rust discriminates (css, ruby and kotlin route the
equivalent input through `ts_lex`). The Rust site is `scanner.c`'s float rule,
which distinguishes `1.max(2)` from `1.0`:

```c
if (lexer->lookahead == '.') { advance(lexer);
    if (iswalpha(lexer->lookahead)) return false;
```

So `fn f() { let x = 1.é; }`, same bytes, three parses:

|                                | Tree                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------- |
| native, `LC_CTYPE=en_AU.UTF-8` | `field_expression(integer_literal, field_identifier)`                           |
| native, `LC_CTYPE=C`           | `float_literal` + `ERROR(identifier)`                                           |
| **wasm**                       | agrees with the UTF-8 locale, and does not move when the ambient locale changes |

**No corpus file can reach this.** Every non-ASCII character in `corpus/src`
sits inside a string literal, where the lexer consumes it without asking whether
it is a letter. The case has to be constructed.

One trap worth naming: CPython's PEP 538 coercion silently rewrites `LC_CTYPE=C`
to `C.UTF-8`, so the first run of this probe reported no divergence and was
wrong. `PYTHONCOERCECLOCALE=0` and `PYTHONUTF8=0` are load-bearing, and the
probe now asserts the locale it actually got.

### Mechanism 2 — error recovery differs native vs wasm, same core, same grammar

`harness/wasm/divergence_*`. 1,156 cases: the 234 corpus files in five variants
each — unmodified, truncated at 60%, last closing bracket deleted, a stray `}`
injected at 40%, one middle line removed. 539 contain `ERROR` or `MISSING`
nodes, which is the point: `gen_trees.py` refuses such trees, so **no corpus
file has ever exercised error recovery**.

Differences are classified, because merging them destroys the finding:

- **shape** — different grammar symbol, span, child count, field or flag. A real
  parse divergence.
- **type** — same node by symbol and span, different `type` string. Costs the
  same here, because dispatch is `node.type` with no fallback.
- **grammar** — only the grammar's internal name for a hidden rule differs.
  Nothing reads it. Counted and set aside.

With the tree-sitter core version **held equal at 0.26.0 on both sides**:

| Mutation         |    Cases | Identical | shape |  type | grammar-only |
| ---------------- | -------: | --------: | ----: | ----: | -----------: |
| clean            |      234 |       183 | **0** | **0** |           51 |
| truncate60       |      234 |       189 |     2 |     2 |           41 |
| drop_last_closer |      223 |       176 |     1 |     0 |           46 |
| inject_closer    |      234 |       185 |     1 |     0 |           48 |
| drop_middle_line |      231 |       177 |     2 |     0 |           52 |
| **TOTAL**        | **1156** |   **910** | **6** | **2** |      **238** |

Clean input is **0 material differences**, consistent with the 234/234 result
above. Broken input is 8. Every one of those eight cases is **pure ASCII**, so
this is not mechanism 1 in disguise. Four disagree on the type of the _root_
node, and neither runtime is uniformly the more tolerant one:

| Case                                    | wasm                              | native                   |
| --------------------------------------- | --------------------------------- | ------------------------ |
| `ruby__control_flow__truncate60`        | `program`                         | `ERROR`                  |
| `rust__kitchen__drop_middle_line`       | `ERROR`                           | `source_file`            |
| `scheme__nesting__truncate60`           | `ERROR`                           | `program`                |
| `yaml__keys__drop_last_closer`          | `stream`                          | `ERROR`                  |
| `javascript__kitchen__drop_middle_line` | loses a top-level `for_statement` | keeps it                 |
| `typescript__kitchen__inject_closer`    | 6 children                        | 7, with an extra `ERROR` |

The two **type** differences are one root cause: `web-tree-sitter` reports
`"ERROR"` for a symbol with no public name where py-tree-sitter reports the
hidden name or `""`. Same node, same symbol id 4, same zero-width span — a Go
automatic-semicolon token — under two different names. It reaches `grammarType`
too, which is where the 238 immaterial differences come from.

### Mechanism 3 — tree-sitter core version drift

Same grammar, same input, native side unchanged; only the `web-tree-sitter`
patch version moves.

| Pairing                      | clean | broken: shape | broken: type |
| ---------------------------- | ----: | ------------: | -----------: |
| py 0.26.0 vs wts **0.26.0**  |     0 |             6 |            2 |
| py 0.26.0 vs wts **0.26.13** |     0 |        **12** |            2 |

Thirteen patch releases of the core library **double** the error-recovery
divergences. This is the mechanism most relevant to shipping, because route A
puts a `libtree-sitter` in the Rust binary and a different build of it in the
browser, and nothing today pins them together.

### What is clean

**Incremental reparse agrees.** 0 material differences across 16 files, and each
runtime's incremental result matches its own fresh parse 16/16. The correctness
of `tree.edit()` is not in question; only its speed is, below.

### The comparison can fail

A result from a comparison that has never failed is not evidence. `--control`
swaps in a deliberately wrong grammar version: tree-sitter-python **0.23.6**
wasm against the pinned **0.25.0** native gives **60/60 cases differing**,
including all 12 clean ones, first difference `assignment.sym: 199 vs 198`.

### What was controlled

| Variable       | Held                                                               |
| -------------- | ------------------------------------------------------------------ |
| Grammar source | Identical; commit pinned in `grammars.tsv`                         |
| Input bytes    | Identical; written to disk once, neither side normalizes its own   |
| Comparison     | Identical; symbol id, span, field, named/missing/extra, both names |
| Edit           | Identical; one inserted space at the same character                |
| Core version   | Varied _deliberately_, as its own row                              |

**Not exercised, and so not claimed either way**: the wasm stdlib symbol
whitelist, and the scanner heap cap. Those are reported elsewhere and this work
neither confirms nor contradicts them.

## 3. Bytes

`harness/wasm/bench.js`. Real `gzip -9` on stdin.

### Runtime — once per page, cached across every language

| Component                   |     Raw |                     gz |
| --------------------------- | ------: | ---------------------: |
| `web-tree-sitter.wasm`      | 201,535 |             **80,412** |
| `web-tree-sitter.js` (glue) | 153,666 |             **31,137** |
| **Total**                   | 355,201 | **111,549** (108.9 KB) |

`docs/design.md` says "80 KB wasm + 31 KB glue". **Exactly right**, at a version
measured months later. That figure needs no revision.

### Grammars — one per language, downloaded lazily

| Language   |        Raw |                      gz | `Language.load` ms (median) |  p90 |
| ---------- | ---------: | ----------------------: | --------------------------: | ---: |
| json       |      6,272 |                   2,522 |                        0.21 | 0.41 |
| html       |     20,405 |                   7,245 |                        0.30 | 0.85 |
| toml       |     26,161 |                   7,859 |                        0.39 | 0.85 |
| xml        |     50,001 |                  16,339 |                        0.38 | 0.68 |
| scheme     |    124,071 |                  18,015 |                        0.83 | 1.26 |
| css        |    149,699 |                  21,547 |                        1.14 | 2.14 |
| yaml       |    194,475 |                  34,116 |                        0.53 | 1.14 |
| go         |    218,901 |                  37,455 |                        0.63 | 1.19 |
| javascript |    416,499 |                  49,730 |                        0.68 | 1.05 |
| markdown   |    421,585 |                  61,445 |                        1.49 | 2.25 |
| python     |    460,119 |                  65,182 |                        0.54 | 1.17 |
| rust       |  1,116,077 |                 115,673 |                        1.30 | 2.40 |
| typescript |  1,418,221 |                 134,738 |                        1.63 | 3.44 |
| ruby       |  2,126,200 |                 164,753 |                        2.64 | 3.48 |
| haskell    |  3,813,093 |                 286,423 |                        4.06 | 5.56 |
| kotlin     |  3,486,599 |                 295,687 |                        4.14 | 5.89 |
| **All 16** | 14,048,378 | **1,318,729** (1.29 MB) |                             |      |

`Language.load` is compile-and-instantiate with the file already in page cache —
it is the latency a lazy per-language download pays _after_ the bytes arrive,
not the download. It is small enough to ignore next to the transfer: even Kotlin
is 4 ms against ~290 KB on the wire.

### Did 0.55–0.75× hold?

`docs/parse-layer.md` estimated wasm gz at 0.55–0.75× the native gz it measured.
Both measured here, same `gzip -9`, native being the pinned wheel's built
extension module:

| Language   | native gz | wasm gz |    ratio |
| ---------- | --------: | ------: | -------: |
| json       |    12,197 |   2,522 | **0.21** |
| html       |    33,796 |   7,245 | **0.21** |
| xml        |    67,944 |  16,339 | **0.24** |
| toml       |    24,066 |   7,859 | **0.33** |
| markdown   |   175,109 |  61,445 | **0.35** |
| typescript |   332,174 | 134,738 | **0.41** |
| yaml       |    84,092 |  34,116 | **0.41** |
| scheme     |    33,748 |  18,015 | **0.53** |
| javascript |    89,565 |  49,730 |     0.56 |
| css        |    35,352 |  21,547 |     0.61 |
| go         |    59,160 |  37,455 |     0.63 |
| python     |   100,405 |  65,182 |     0.65 |
| haskell    |   403,249 | 286,423 |     0.71 |
| rust       |   157,591 | 115,673 |     0.73 |
| ruby       |   201,420 | 164,753 | **0.82** |
| kotlin     |   330,923 | 295,687 | **0.89** |

**It held for 6 of 16.** Range 0.21–0.89, median 0.56.

The band was not arbitrary — it was calibrated on the two grammars
`docs/design.md` had measured both ways, and on those two it is excellent
(javascript 0.56, rust 0.73; and my builds land on 48.6 KB and 113.0 KB against
that document's 48 KB and 115 KB, which independently validates this build
pipeline). It simply does not generalise. The ratio tracks how much of the
native `.so` is fixed overhead: small grammars are dominated by ELF and Python
binding, so their wasm looks cheap; table-heavy grammars have little overhead to
shed and converge on 1.0.

The two extrapolations that mattered, checked:

- **Python ≈ 55–75 KB** → measured **63.7 KB**. Correct.
- **Kotlin ≈ 180–240 KB** → measured **288.8 KB**. **20–60% over**, and the most
  expensive language on the roster by download.

### The three-language editor, re-priced

`docs/parse-layer.md`'s worked example, JSON + Python + Markdown, all gz:

| Component                 | Estimated |                         Measured |
| ------------------------- | --------: | -------------------------------: |
| `web-tree-sitter` runtime |    111 KB |                     **108.9 KB** |
| Three grammar wasms       |   ~181 KB | **126.1 KB** (2.5 + 63.7 + 60.0) |
| Our formatter runtime     |    8.3 KB |                           8.3 KB |
| Our three packages        |     ~3 KB |                            ~3 KB |
| **Total**                 |   ~303 KB |                      **~246 KB** |

The estimate was **23% pessimistic**, entirely because Markdown's wasm is 60 KB
rather than the ~110 KB extrapolated. The conclusion it supports does not move:
the parse layer is **~21× everything this project has built** (measured),
against the 25× estimated. The spread between routes stays the same order.

## 4. Milliseconds

Median of 201 runs, p90 collected. "Cold" is a fresh `Parser` in a warm process:
no process start, no module instantiation, no download.

### Largest corpus file per language

As the brief asked. It is also a table about function-call overhead, because the
largest file in the whole corpus is 2,346 bytes.

| Language   | Bytes | Cold ms | Warm ms | Speedup |
| ---------- | ----: | ------: | ------: | ------: |
| json       |   547 |   0.092 |   0.013 |    7.3× |
| html       |   708 |   0.161 |   0.008 |   20.3× |
| markdown   |   766 |   0.371 |   0.226 |    1.6× |
| go         |   779 |   0.161 |   0.013 |   12.5× |
| xml        |   693 |   0.155 |   0.021 |    7.3× |
| kotlin     |   994 |   0.153 |   0.009 |   17.7× |
| haskell    | 1,025 |   0.397 |   0.099 |    4.0× |
| javascript | 1,032 |   0.215 |   0.031 |    6.9× |
| css        | 1,071 |   0.249 |   0.009 |   27.9× |
| scheme     | 1,091 |   0.117 |   0.015 |    8.0× |
| typescript | 1,123 |   0.146 |   0.009 |   16.8× |
| ruby       | 1,286 |   0.343 |   0.029 |   11.7× |
| toml       | 1,346 |   0.123 |   0.031 |    3.9× |
| yaml       | 1,375 |   0.157 |   0.025 |    6.3× |
| python     | 1,465 |   0.325 |   0.022 |   14.5× |
| rust       | 2,346 |   0.268 |   0.022 |   11.9× |

Every language parses its largest corpus file in under 0.4 ms and reparses in
under 0.23 ms. On this evidence route A is comfortably fast, and that conclusion
is an artifact of the corpus size.

### The same content repeated to ~64 KB

An editor buffer, not a fixture. Repetition is **not** a realistic document, and
this is a stress input rather than a simulation — but it is constructed
identically for all sixteen languages, so the column is comparable across them.

| Language   |  Bytes |  Nodes | Cold ms | Warm ms | Speedup | MB/s |
| ---------- | -----: | -----: | ------: | ------: | ------: | ---: |
| toml       | 65,954 |  7,841 |    6.16 |   1.711 |      4× | 10.7 |
| scheme     | 66,551 |  4,942 |    6.64 |   0.758 |      9× | 10.0 |
| yaml       | 66,000 | 13,108 |    7.81 |   1.231 |      6× |  8.5 |
| rust       | 65,688 | 11,117 |    7.88 |   0.683 |     12× |  8.3 |
| typescript | 66,257 | 10,739 |    8.22 |   0.337 |     24× |  8.1 |
| kotlin     | 65,604 | 11,089 |    9.12 |   0.143 |     64× |  7.2 |
| json       | 65,640 | 34,801 |   11.55 |   0.076 |    153× |  5.7 |
| css        | 66,402 | 22,197 |   12.37 |   0.247 |     50× |  5.4 |
| javascript | 66,048 | 20,289 |   13.05 |   1.846 |      7× |  5.1 |
| go         | 66,215 | 27,031 |   13.80 |   0.286 |     48× |  4.8 |
| html       | 65,844 | 26,692 |   15.17 |   0.110 |    138× |  4.3 |
| python     | 65,925 | 19,981 |   15.15 |   0.656 |     23× |  4.4 |
| ruby       | 65,586 | 15,148 |   16.73 |   0.099 |    168× |  3.9 |
| xml        | 65,835 | 19,667 |   17.82 |   4.006 |      4× |  3.7 |
| markdown   | 65,876 | 15,740 |   30.36 |  22.133 |      1× |  2.2 |
| haskell    | 65,600 | 22,876 |   34.18 |  19.149 |      2× |  1.9 |

Cold parse spans 6–34 ms, i.e. 2–11 MB/s. For a format-on-save or a
server-rendered snippet that is irrelevant. For a first paint it is a visible
but acceptable one-off.

**The warm column is the finding.** `docs/parse-layer.md` credits route A with
buying incremental reparse "for free", against the highlighter's stated "~1
ms/keystroke". At 64 KB:

- **Eleven of sixteen** are under 0.8 ms. For those the claim is simply true,
  and json/ruby/html at 0.08–0.11 ms are 100–170× faster than a full parse.
- **Five miss it**: toml 1.7 ms, javascript 1.8 ms, xml 4.0 ms, haskell 19.1 ms,
  **markdown 22.1 ms**.
- Markdown's 22.1 ms against its own 30.4 ms full parse is a **1.4× speedup** —
  incremental in name only.

Haskell and Markdown are exactly the two grammars whose scanners drive
whitespace-sensitive block structure, which is the same reason
`docs/parse-layer.md` already gives for their scanners being the two largest on
the roster. Markdown is that document's own headline requirement.

This does not sink route A — 22 ms is not a broken editor, and a real Markdown
document is not this document. But "incremental reparse for free" is not what
was measured, and goal 2's replacement should not be written as though it were.

## What this changes

Stated as claims about `docs/parse-layer.md`, since that is what the work was
for.

**Confirmed.**

- `web-tree-sitter` runtime at 80 KB wasm + 31 KB glue gz. Exact.
- The `docs/design.md` grammar figures for javascript and rust, independently
  reproduced from a different build pipeline (48.6 / 113.0 KB against 48 / 115).
- Route A's parse layer really does reproduce tree-sitter's trees for the merged
  packages: 234/234, byte-identical, injections included. The packages are safe
  under route A **on clean input**, which is the thing that would have been most
  expensive to discover late.
- The parse layer really is an order of magnitude larger than everything this
  project has built: ~21× measured, against ~25× estimated.

**Falsified or narrowed.**

- "The parse layer cannot diverge between runtimes." It can, three ways. Clean
  input is safe; error recovery is not; and the core library version is an
  uncontrolled shipping variable that doubles the effect.
- "0.55–0.75× native gz." True for 6 of 16, range 0.21–0.89. Kotlin is 20–60%
  over its extrapolation.
- "Incremental reparse for free" against ~1 ms/keystroke. True for 11 of 16 at
  64 KB; false for markdown and haskell by more than an order of magnitude.

**The consequence for the recommendation.** Route A remains defensible — its
sizes are roughly as advertised and its trees are right where the corpus can
see. But the sentence crediting it with _deleting_ divergence risk should be
struck. Under route A the fuzzer still has to watch the parse layer; it just has
to watch it on broken input, which is precisely what `docs/parse-layer.md`'s own
"gate in front of any own-the-parser route" section says the repo cannot
currently do. That gate is not a prerequisite only for route C. It is a
prerequisite for route A too, and this document is the evidence.

Two concrete follow-ons, neither of which needs a decision first:

1. **Pin the tree-sitter core version on both sides**, and add it to whatever
   roadmap point 3's grammar stamp becomes. Grammar version alone is not enough;
   13 patch releases of the core doubled the divergences.
2. **Pin `LC_CTYPE`** in the native runtime, or note the seven affected
   grammars. This is free and closes mechanism 1 outright.

## Reproducing

```sh
harness/wasm/build_grammars.sh          # ~14 MB of wasm; needs docker
cd harness/wasm && npm install && cd ../..

harness/parse_wasm.js --check           # tree identity: expect 234/234
harness/wasm/bench.js --runs 201        # sizes and timings
harness/wasm/locale_probe.js            # mechanism 1

W=$(mktemp -d)                          # mechanisms 2 and 3
harness/wasm/divergence_cases.py "$W"
harness/wasm/divergence_native.py "$W"
harness/wasm/divergence_wasm.js "$W"
```

`EDITOR_TOOLS_WTS=<dir>` points the JS tools at an alternate `web-tree-sitter`
installation, which is how the core-version row was produced.
