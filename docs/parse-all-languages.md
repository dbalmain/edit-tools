# Every language but Aven: what the parse layer still costs

**Goal, set 2026-09-06:** the route-C3 parse layer parsing all sixteen
tree-sitter languages in the corpus. Aven is out of scope by instruction, and
would be out of scope anyway -- it has no tree-sitter grammar and its plan of
record (`docs/roadmap.md`) is its own parser.

Where it stands: **6 of 16 parse byte-identically** (json 3/3, scheme 15/15,
go 16/16, toml 15/15, css 15/15, xml 15/15). This document is what the
remaining ten cost, measured rather than guessed.

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

Counted over each scanner's **include closure**, not just its `scanner.c` --
five of the thirteen carry a local header that is compiled in, and counting
only the `.c` undercounts the set by 30%.

| Language   | `scanner.c` | + headers | Externals | Serialized state          |
| ---------- | ----------: | --------: | --------: | ------------------------- |
| toml       |          82 |        82 |         5 | stateless *(done)*        |
| css        |         100 |       100 |         3 | stateless *(done)*        |
| typescript |          13 |       360 |        10 | stateless                 |
| javascript |         364 |       364 |         8 | stateless                 |
| rust       |         393 |       393 |        10 | one `u8`                  |
| xml        |         270 |       425 |        11 | tag-name strings *(done)* |
| python     |         437 |       437 |        12 | 2 scalars + 2 stacks      |
| kotlin     |         459 |       459 |        11 | stateless                 |
| html       |         362 |       747 |         9 | stack of tag-name strings |
| ruby       |       1,107 |     1,107 |        30 | scalars + stacks          |
| yaml       |       1,415 |     1,415 |       113 | 5 `i16` + 2 `i16` stacks  |
| markdown   |       1,602 |     1,602 |        47 | 5 scalars + `u8` stack    |
| haskell    |       3,471 |     5,975 |        49 | scalars + stacks + tables |

**13,466 lines of C across the thirteen**, of which toml's 82 and css's 100 are
done.

### Two thirds of haskell's excess is data, not logic

haskell's `unicode.h` is **2,504 lines of generated codepoint bitmaps** --
twenty of them, behind twenty-four trivial `is_*_char(int32_t)` predicates.
That is not code to port. It is exactly what the VM's class tables already
hold, and converting it is the same mechanical extraction already done twice
for glibc's `wctype.h`. Measured: the bitmaps become **3,102 intervals**.

So the honest split is **10,962 lines of logic and 2,504 of data**, and
haskell's share of the logic is 32% rather than the 44% its raw line count
suggests.

It does carry a size consequence though. 3,102 ranges is roughly four times
glibc's `alnum` table, which is 802 ranges and 3.5 KB gzipped -- so haskell's
character classes alone are on the order of 12-14 KB gz. That is a data cost
specific to haskell, not a porting cost, and it lands on the same question as
the `isw*` tables: shared runtime, or per blob.

### The C-to-assembler ratio, on three datapoints, and it falls with size

Whole-file lines of the `.program.js`, which is what a reviewer actually reads:

| Language | C (incl. headers) | assembler | ratio |
| -------- | ----------------: | --------: | ----: |
| toml     |                82 |       153 | 1.87x |
| css      |               100 |       182 | 1.82x |
| xml      |               425 |       544 | 1.28x |
| total    |               607 |       879 | 1.45x |

An earlier revision of this section put css at 147 lines and drew 1.6x from it.
That was wrong -- `css.program.js` has been 182 lines since it landed -- and the
correction matters less than what the third datapoint says: **the ratio falls as
the scanner grows.** The expansion is per *construct*, not per line: each ported
`if` carries its C beside it in a comment, and a large scanner has more repeated
shape amortising the same header, the same class-table plumbing, the same
`return` conventions. At xml's 1.28x the remaining ten come to roughly 16,500
lines, which is the same order the 1.6x estimate gave; the decision does not
turn on it.

Both css and xml landed **15/15 byte-identical on the first run** (xml also
16/16 on the deliberately-broken corpus) and replay the recorded C-scanner calls
with no mismatches. Three grammars in, the pipeline -- transcode, port, trace
differential -- generalises past the one it was built on.

Ports also price the classification tables concretely: css's program is **173
bytes of code and 4,312 bytes packed**, because `iswalnum` is 4.1 KB of it. xml
needs both `iswalpha` and `iswalnum` and packs to **8,939 bytes** -- 8.6 KB of
which is two character tables. This is now the dominant cost of a port, and it
is data, not code.

Two corrections to `docs/scanner-vm.md`, whose roster was nine scanners for ten
languages and predates haskell, html, ruby, typescript and xml being surveyed:

- **"No scanner stores a string" is false.** html and xml both serialize a
  *stack of tag names*, matched by content on close. **Settled by porting xml:
  the ISA carries it with no new instruction.** Not with `bufPush`/`ifBufEq` --
  `ifBufEq` compares the buffer against a *constant* from the string table, and
  here both sides are dynamic. The shape that works is a stack of strings held
  as two parallel stacks: one holding every open tag's bytes concatenated flat,
  one holding a length per tag, with the comparison a `getidx` walk over both.
  A third, transient stack holds the name being scanned. html should reuse it.
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

### Serialized state is far smaller than the limit that would bite

The VM serializes state in its own format -- persistent registers, then
persistent stacks -- and the traces record *upstream's*. For a stateful scanner
those differ by construction, which matters because tree-sitter truncates
serialized state at 1024 bytes and python, yaml, xml and html all behave
differently once truncated. A format that packs differently truncates at a
different point.

Measured across every recorded trace, that cannot happen here:

| Language | max state | mean | Language | max state | mean |
| -------- | --------: | ---: | -------- | --------: | ---: |
| haskell  |        92 | 31.1 | python   |        11 | 3.2  |
| xml      |        35 | 16.1 | ruby     |         9 | 3.2  |
| yaml     |        26 | 15.1 | rust     |         1 | 1.0  |
| markdown |        21 |  8.1 | css, javascript, | | |
| html     |        16 |  5.6 | kotlin, toml, typescript | 0 | stateless |

**The largest state any scanner reaches is 92 bytes**, against a 1024-byte
limit -- 11x headroom at worst, and five of the thirteen are stateless
outright. So the VM may use its own format, and the replay's serialize
comparison stays meaningful for the stateless ports.

This is a fact about the corpus, not a guarantee. A file nesting a few hundred
tags deep would reach the limit; a port of xml or html should carry that as a
stated bound.

### The one ISA gap, and it is narrower than it looks

xml and html both keep a **stack of variable-length tag-name strings**, pushed
on an open tag and compared against on a close. The ISA has integer stacks and
exactly *one* scratch byte buffer, and `ifBufEq` compares that buffer only
against constants in the `strings` table -- there is no `bufGet(i)`, so the
scanned name cannot be compared against stored state directly.

It is still encodable without changing the ISA: keep the name bytes flat in one
integer stack with lengths in a parallel one, scan the incoming name into a
third, and compare with `getidx` and `len`. Clumsy, but nothing new is needed.
It is an argument on option 2's side below -- a compiler meets this shape once,
hand-porting meets it twice.

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
3. **Do the cheap ones, defer the expensive five.** html, javascript,
   typescript, rust, python and kotlin are the 2,307 lines left in that band;
   ruby, yaml, markdown and haskell are 7,595. Gets to 12 of 16 languages for a
   quarter of the work. css and xml are already done out of this band, which is
   the work option 3 shares with options 1 and 2.
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

### State, checked by correspondence rather than by bytes

xml is the first port that carries state across tokens, and it forced the
question `docs/scanner-vm.md` had only reasoned about: how do you check a port's
state when the VM's serialization format is deliberately *not* upstream's?

Not by comparing bytes -- that would fail a correct port. The check that works
is a **bijection**, rebuilt per parse: every time upstream serialized the same
bytes we must have serialized the same bytes, and vice versa. A port that forgot
to push something collapses two upstream states onto one of ours; a port that
carries junk splits one of theirs across two of ours. Replay then restores state
*through* that mapping, so a `deserialize` of bytes upstream never emitted is
itself a failure rather than a silent reset. `harness/ts_scanner_replay.mjs`
does this, and it is exactly the "relation-compatibility" obligation
`docs/scanner-vm.md` names -- mechanised, and now measured rather than argued.

**566 state transitions checked** across toml, css and xml. The count is floored
in `harness/test_ts_transcode.py` alongside the call count, because a replay can
stop checking state while still walking every call.

Two bounds fall out of it, and they are xml's, not the VM's:

- Upstream truncates at 1024 bytes and rebuilds the dropped tags as *empty*
  names; the VM keeps them. Beyond 1024 bytes of open-tag state the two stop
  agreeing. The deepest state in the corpus is **35 bytes**.
- The VM's stacks cap at 256 elements, so the port holds at most 256 bytes of
  open-tag names -- a *tighter* bound than upstream's, and the first place a
  scanner has come near an ISA limit. html will sit in the same band.

### The Rust twin had stopped covering the oracle

Found while landing xml: `spike/scanner-vm/rust/` could not replay it. Two
reasons, both silent.

`vm.rs` had no `serialize`/`deserialize` at all -- it never needed them, because
every port before xml was stateless. And `main.rs` read a *second, older* copy
of the toml traces under `spike/scanner-vm/traces/`, in the array-valued format
that predates the cross-language recorder, so it had not been reading the
canonical `corpus/scanner-traces/` for as long as those have existed.

Both fixed: `vm.rs` gained the two methods as a line-for-line transcription of
the JS, `main.rs` reads the canonical traces and runs the same bijection check,
and all three ports now replay in both runtimes with identical file, call and
state counts. The spike's own `replay.js` stays -- `run.sh`'s fuzz and
incremental-reparse steps generate old-format traces on the fly and nothing else
replays those -- but it now refuses a bit-string `valid` field loudly, because
every character of a JS string is truthy and feeding it one would have passed
every valid-symbol test and reported a confident green.

## Not in scope here

Incremental reparse (~670 JS lines, unrevised), the grammar stamp in the package
header, and the two known cross-runtime accidents: `newError` passing seven
arguments so `dependsOnColumn` coerces to `false`, and the JS computing a
`reservedWordSetId` it never reads.
