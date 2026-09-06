# Every language but Aven: what the parse layer still costs

**Goal, set 2026-09-06:** the route-C3 parse layer parsing all sixteen
tree-sitter languages in the corpus. Aven is out of scope by instruction, and
would be out of scope anyway -- it has no tree-sitter grammar and its plan of
record (`docs/roadmap.md`) is its own parser.

Where it stands: **4 of 16 parse byte-identically** (json 3/3, scheme 15/15,
go 16/16, toml 15/15). This document is what the remaining twelve cost, measured
rather than guessed.

## What is already done

**Every grammar's source is fetched and verified.** `harness/ts_grammars.py`
resolves each pin from `harness/languages/*.toml`, fetches it, and completes it
-- six of the sixteen sdists cannot build the scanner they describe. See that
file's docstring; the short version is that css, python and yaml ship no
`scanner.c` at all, and typescript and xml ship a stub delegating to a
`common/scanner.h` they also omit.

**Every grammar's tables transcode.** All sixteen, in seconds each; the largest,
kotlin's 22 MB `parser.c`, takes 12s. Two constructs had to be added
(`a221745`): positional lex-mode initializers, and casts that wrap, which is
what makes `(TSStateId)(-1)` the 65535 both runtimes already compare against.

**Both runtimes already implement everything the tables need** -- GLR, error
recovery, row/column tracking, and the scanner-VM call path.

## The finding that shapes the rest

**The tables alone are worth nothing without the scanner.** Transcoding all
twelve remaining grammars with a scanner that declines every token -- a 23-byte
`.svm` that does nothing but `fail` -- produces an ERROR on the *first corpus
file of every one of them*. There is no language here that limps along on its
tables and merely loses an edge case.

So the remaining work is not twelve parsers. It is **twelve external scanners**,
and nothing else.

## What the twelve scanners are

Line counts are of the actual source, after completing the sdists.

| Language   | C lines | Externals | Serialized state          |
| ---------- | ------: | --------: | ------------------------- |
| toml       |      82 |         5 | stateless *(done)*        |
| css        |     100 |         3 | stateless                 |
| xml        |     270 |        11 | stack of tag-name strings |
| html       |     362 |         9 | stack of tag-name strings |
| javascript |     364 |         8 | stateless                 |
| typescript |     347 |        10 | stateless                 |
| rust       |     393 |        10 | one `u8`                  |
| python     |     437 |        12 | 2 scalars + 2 stacks      |
| kotlin     |     459 |        11 | stateless                 |
| ruby       |   1,107 |        30 | scalars + stacks          |
| yaml       |   1,415 |       113 | 5 `i16` + 2 `i16` stacks  |
| markdown   |   1,602 |        47 | 5 scalars + `u8` stack    |
| haskell    |   3,471 |        49 | scalars + stacks + tables |

**10,327 lines of C across the twelve.** haskell alone is 34% of it.

Two corrections to `docs/scanner-vm.md`, whose roster was nine scanners for ten
languages and predates haskell, html, ruby, typescript and xml being surveyed:

- **"No scanner stores a string" is false.** html and xml both serialize a
  *stack of tag names*, matched by content on close. The VM's `bufPush` /
  `ifBufEq` opcodes look like they can carry it, but a stack of variable-length
  strings is a shape the ISA has never been exercised on.
- **typescript is not free from javascript.** Its scanner is a 13-line shim over
  a shared `common/scanner.h`, and that header differs from javascript's
  `scanner.c` in 145 of 364 lines -- two extra token types and a different
  whitespace-scan signature. Call it 40% of a fresh port, not 0%.

## The C subset, measured

Counted across all twelve, because it is what decides whether these are ported
by hand or compiled.

| Construct              | Scanners using it                     |
| ---------------------- | ------------------------------------- |
| `union`                | **none**                              |
| function pointers      | haskell (2)                           |
| `goto`                 | kotlin (5)                            |
| floating point         | haskell, kotlin, rust (1-3 each)      |
| `switch`               | haskell 33, ruby 8, kotlin 6, rest 0-3|
| static lookup tables   | haskell 5, markdown 1                 |
| `malloc`/`realloc`     | 7 of 12, always for one growable stack|
| `isw*` classification  | 9 of 12                               |

**Eleven of the twelve sit in a narrow, regular subset.** haskell is the outlier
on every axis at once -- 33 switches, five static tables, two function pointers,
a float, and 3,471 lines.

## The open decision

How the twelve scanners get produced. `docs/scanner-vm.md`'s route is
hand-compilation to VM bytecode: toml's 82 C lines became 153 lines of assembler
in `spike/scanner-vm/toml.program.js`, a 1.9x expansion, with the upstream C
reproduced in comments because "that is the only review this port gets".

At that ratio the remaining twelve are **roughly 19,000 lines of hand-written
assembler**. That number is the reason this is a decision and not a task.

The options, and what each costs, are on the decisions page -- see
`docs/parse-layer.md` for the routes that got us here. In brief:

1. **Hand-compile all twelve.** Proven; no new machinery. ~19,000 lines of
   assembler, each line reviewable only by eye against the C beside it.
2. **Write a C-to-VM compiler** for the measured subset. One artifact to review
   instead of twelve; every scanner then gets the same correctness argument. The
   subset is narrow for eleven of twelve, and the risk is concentrated in
   haskell.
3. **Do the cheap seven, defer the expensive five.** css, xml, html, javascript,
   typescript, rust, python, kotlin are 2,732 lines; ruby, yaml, markdown and
   haskell are 7,595. Gets to 12 of 16 languages for a quarter of the work.
4. **Scanner-only wasm.** Tables stay JSON, so the 6.3 KB interpreter win
   stands, and only the scanners ship as wasm. Reintroduces a wasm dependency
   for the browser, and the two runtimes stop executing the same artifact.

## What every option needs, and now has

Two pieces of groundwork that no answer to the decision above can waste. Both
are built.

### The scanner-call oracle, for all thirteen

`harness/ts_scanner_record.py` records every call each grammar's real C scanner
makes over the corpus: entry offset, lookahead, the valid-symbols vector, every
`advance`/`mark_end` in order, and the verdict -- plus every `serialize` and
`deserialize`, which the toml-only original did not need and eight of the twelve
remaining scanners do. **Thirteen languages, 50,522 scanner calls**, frozen into
`corpus/scanner-traces/` the way `corpus/trees/` is, so the oracle is available
without a compiler or the network.

It confirms itself on the one language with a published figure: toml records
**230 scan calls with 26 failures**, which is exactly what `docs/scanner-vm.md`
reports for the working port.

### Character classification, pinned as data

`harness/ts_ctype_tables.py`. Nine of the twelve scanners call `isw*`, and those
are a property of the host process rather than of the grammar -- the finding in
`docs/host-ctype-divergence.md`. The generated table reproduces that document's
glibc-UTF-8 column exactly, and its four control rows discriminate in both
directions: the C locale answers `False` for U+2003 and U+3000, musl/emscripten
answers `True` for U+00A0.

It settles one unstated assumption and creates one new cost:

- **`gen_trees.pin_ctype`'s three-locale fallback is safe.** `C.UTF-8`,
  `en_US.UTF-8` and `en_AU.UTF-8` produce byte-identical tables for all twelve
  classes, so the frozen corpus does not depend on which one the generating
  machine had. Nothing had checked that.
- **`alnum` is 802 ranges, 3,492 bytes gzipped** -- against a 6.3 KB
  interpreter, not a rounding error. `space` is 8 ranges and 65 bytes. Nine
  scanners want classification, so **embedded per blob the tables cost roughly
  31 KB gz across the language set, and hoisted into the shared runtime they
  cost one copy.** That belongs with the decision above rather than with
  whoever ports the first scanner.

## Not in scope here

Incremental reparse (~670 JS lines, unrevised), the grammar stamp in the package
header, and the two known cross-runtime accidents: `newError` passing seven
arguments so `dependsOnColumn` coerces to `false`, and the JS computing a
`reservedWordSetId` it never reads.
