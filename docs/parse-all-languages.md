# Every language but Aven: what the parse layer still costs

**Goal, set 2026-09-06:** the route-C3 parse layer parsing all sixteen
tree-sitter languages in the corpus. Aven is out of scope by instruction, and
would be out of scope anyway -- it has no tree-sitter grammar and its plan of
record (`docs/roadmap.md`) is its own parser.

Where it stands: **15 of 16 parse byte-identically** (json 3/3, scheme 15/15,
go 16/16, toml 15/15, css 15/15, xml 15/15, html 16/16, python 12/12,
rust 19/19, javascript 14/14, typescript 16/16, kotlin 16/16, ruby 15/15,
yaml 16/16, markdown 15/15\*). **Only haskell is left.**

\* markdown's number is against the *host grammar*, not against
`corpus/trees/`, and the difference is a property of the fixtures rather than
of the port -- see "markdown's clean fixtures cannot judge markdown" below.

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
| typescript |          13 |       360 |        10 | stateless *(done)*        |
| javascript |         364 |       364 |         8 | stateless *(done)*        |
| rust       |         393 |       393 |        10 | one `u8` *(done)*         |
| xml        |         270 |       425 |        11 | tag-name strings *(done)* |
| python     |         437 |       437 |        12 | 2 stacks + a flag *(done)* |
| kotlin     |         459 |       459 |        11 | stateless *(done)*        |
| html       |         362 |       747 |         9 | tag types + names *(done)* |
| ruby       |       1,107 |     1,107 |        30 | literals + heredocs *(done)* |
| yaml       |       1,415 |     1,415 |       113 | 5 `i16` + 2 stacks *(done)* |
| markdown   |       1,602 |     1,602 |        47 | 5 scalars + block stack *(done)* |
| haskell    |       3,471 |     5,975 |        49 | scalars + stacks + tables |

**13,466 lines of C across the thirteen**, of which twelve are done. haskell
-- 3,471 lines, or 5,975 counting its generated `unicode.h` -- is what is
left.

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
| html     |               747 |       673 | 0.90x |
| python   |               437 |       613 | 1.40x |
| rust     |               393 |       510 | 1.30x |
| javascript |             364 |       484 | 1.33x |
| typescript |             360 |       411 | 1.14x |
| kotlin   |               459 |       668 | 1.46x |
| ruby     |             1,107 |     1,567 | 1.42x |
| yaml     |             1,415 |     2,197 | 1.55x |
| markdown |             1,602 |     1,699 | 1.06x |
| total    |             7,491 |     9,701 | 1.30x |

An earlier revision of this section put css at 147 lines and drew 1.6x from it.
That was wrong -- `css.program.js` has been 182 lines since it landed -- and the
correction matters less than what the later datapoints say: **the ratio falls
sharply as the scanner grows, and html is the first port that is smaller than
its C.** The expansion is per *construct*, not per line: each ported `if`
carries its C beside it in a comment, and a large scanner has more repeated
shape amortising the same header and the same plumbing. html goes further,
because its bulk is *tables* -- a 126-entry name map and a 385-line `tag.h` --
and tables become package data rather than code. Its 126-way lookup is eight
lines of generator emitting 252 instructions.

**But ruby says the ratio does not simply fall with size**, and yaml and
markdown settle why. ruby is the second-largest ported and came out at
**1.42x**; yaml, the third-largest, came out at **1.55x** -- the *highest* of
the twelve. markdown, larger than both, came out at **1.06x**. Size explains
none of that.

What does explain it is how much of a scanner is **data rather than
branches**. html is 0.90x because its bulk is a 126-entry name map and a
385-line `tag.h` that become package data; markdown is 1.06x because its
`match` switches and block enums collapse into range tests; yaml is 1.55x
because 113 external tokens against a spec-defined character grammar is almost
entirely branching, with an `ifValid` chain per token and nothing to hoist. The
earlier reading -- "the ratio falls sharply as the scanner grows" -- had the
correlation and the wrong cause.

**That reframes option 1's volume.** At the blended 1.30x haskell's remaining
3,471 lines of logic come to roughly 4,500, and its 2,504 lines of generated
bitmaps come to none at all, because they are data. The objection to
hand-compiling was never really the line count; it is four separate
correctness arguments. But the line count was the number on the page, and it
is now one language.

Every port since toml has landed **byte-identical on the first run**, on the
clean corpus and on the deliberately-broken one, and all replay the recorded
C-scanner calls with no mismatches -- **15,325 calls and 2,086 state
transitions across ten languages**. Ten grammars in, the pipeline --
transcode, port, trace differential -- generalises past the one it was built
on.

### markdown's clean fixtures cannot judge markdown

markdown's port replays its recorded C-scanner calls with no mismatches (3,127
calls, 674 state transitions) and passes `--edited` 6/6, and then
`ts_check_trees.mjs` reports **9 of 15** on the clean corpus. The six that fail
-- `comments`, `fences`, `kitchen`, `long_sequences`, `nesting`,
`normalisation` -- are exactly the six whose frozen tree contains more than one
`"type": "document"`.

That is `gen_trees.py`'s **injection splice**: it reparses a fenced region with
the guest grammar and substitutes the guest's tree for the host's
`code_fence_content` leaf. The table interpreter has no included-range second
pass, so it cannot produce that shape from one parse and never will. The
mismatch is a property of the fixture, not of the port.

`parse_oracle.py` already turns injections **off**, deliberately and for the
same reason -- "a candidate parse layer parses one language, so the oracle it
should be measured against is the host grammar's own recovery, not a splice of
two grammars" -- which is why `corpus/trees-edited/` needs no equivalent and
why `--edited` is clean.

So the clean half needed its own check, and `harness/ts_check_hostonly.py` is
it: parse each corpus file with the real grammar and no injection pass,
serialise it in `gen_trees.py`'s shape, and require our `--write-dir` output to
equal it byte for byte. markdown is **15/15**.

```sh
./harness/ts_transcode.py .grammars/markdown/tree-sitter-markdown/src/parser.c \
  --scanner harness/scanners/markdown.svm -o /tmp/md.blob.json
./harness/ts_check_trees.mjs /tmp/md.blob.json markdown --write-dir /tmp/md-ours
./harness/ts_check_hostonly.py markdown /tmp/md-ours
```

It is weaker than the frozen-fixture check in one way and stronger in another:
weaker because it re-derives its oracle from a live grammar rather than from a
committed artifact, stronger because it is the only comparison an injected
language's clean corpus admits at all. **Which of those two should be the
committed bar for markdown is an open decision**, and it is on the board:
splice injections into `ts_check_trees.mjs`, freeze a second host-only fixture
set, or leave this script as the gate.

Two other things markdown settled. `sizeof(Block)` is **4, not 1** -- the
brief guessed one byte from `memcpy(&buffer[size], s->open_blocks.items, ...)`
and `docs/scanner-vm.md` already had the right figure, `5 + 4*blocks`. The
three padding bytes carry no distinctions, so a VM stack of those integers is
relation-compatible with the raw `memcpy`. And markdown is the first port to
use `RECURSE`: `scan(..., paragraph_interrupt_symbols)` is upstream calling
itself with a different valid-symbols vector, which is the instruction's only
reason for existing and had never been exercised.

### yaml: the VM cannot seed a register, and that is a state distinction

The brief said yaml's five `int16_t` scalars are five persistent registers.
Two of them are not, and the reason generalises. `deserialize` initialises
`blk_imp_row` and `blk_imp_col` to **-1**, not 0, and `(row=0, col=0,
imp_row=0, imp_col=0)` is a *reachable, distinct* state -- `MAY_UPD_IMP_COL`
produces it at the start of a file. The VM zeros persistent registers on reset
and has no `registerInit`, so putting those two in registers would collapse
"never set" onto "set to zero" and fail the bijection.

`stackInit` is the only way to seed a non-zero persistent value, so each of the
two lives as a **single-element stack**, loaded into a working register at
entry and written back on every halt -- because `MAY_UPD_IMP_COL` mutates them
even on scans that return false. Four persistent stacks and three persistent
registers, for what upstream writes as five scalars.

The general form: **the ISA can express any state whose reset value is zero,
and needs a stack for every other one.** A `registerInit` alongside `stackInit`
would be a small addition and is the obvious thing to want. haskell will meet
the same wall: its empty-state `deserialize` sets `newline.state = NResume`,
which is 3 in `enum NewlineState`, so it needs either the same
single-element-stack trick or an encoding that biases the enum so the reset
value is zero.

yaml is also the port with the most state transitions by a factor of three
(**1,464**, against ruby's 493), which is what a scanner tracking row and
column in its persistent state looks like: nearly every token changes it.

### What ruby added: a FIFO, and a class that cannot be a class

Two things worth carrying forward.

**Upstream's `open_heredocs` is a queue, not a stack.** New heredocs are
appended and `array_erase(&open_heredocs, 0)` removes the *front* -- index 0 is
the one that content and whitespace scans always look at. The ISA has `GETIDX`
and `SETTOP` but no `SETIDX`, so erasing or mutating the front costs a spill to
the transient stack and back. That is the first port where the VM's stack
discipline and upstream's data structure genuinely disagree, and it cost a
stack rather than an instruction: three persistent (packed literals, packed
heredoc headers, flat word bytes) plus one transient, which is all four.

**`is_iden_char` is not expressible as a class table.** It truncates to `char`
before testing, so U+0100 fails (its low byte 0 is in `NON_IDENTIFIER_CHARS`)
while U+0101 passes. A class table answers membership on the code point; this
predicate answers it on the low byte. The port reproduces the truncation
explicitly rather than approximating it -- the same shape as html's `towupper`
finding, and the second time a scanner's *host* arithmetic, not its logic,
decided which characters are equivalent.

`has_leading_whitespace`, which the survey listed as serialized scalar state,
is not: `scan()` zeros it and `serialize` omits it. A persistent register for
it would have made the port strictly finer than upstream and split states
tree-sitter merges -- exactly the failure the bijection exists to catch, found
by reading rather than by the gate.

Ports also price the tables concretely: css's program is **173 bytes of code
and 4,312 bytes packed**, because `iswalnum` is 4.1 KB of it. xml packs to
**8,941 bytes** and html to **11,009**, and in every case the character and
case tables are most of it. This is the dominant cost of a port, and it is
data, not code.

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
3. ~~**Do the cheap ones, defer the expensive four.**~~ **Overtaken by events.**
   The cheap band is *done* -- all nine of it -- so this option no longer names
   a different piece of work from option 1. What is left is ruby, yaml, markdown
   and haskell, and the question is only how those four get produced.
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

### kotlin: the hardest C to read was not the hardest to port

kotlin has the most tangled control flow of the twelve -- four `goto`s that jump
*into* the middle of later blocks, one of them backwards to re-enter a switch
that a preceding declaration must not re-initialise. In C that is the kind of
thing a reviewer has to trace by hand.

In the VM it costs nothing. Every label is a jump target, there is no block
structure to violate, and a `goto` into the middle of a block is an ordinary
`jmp`. The one place it needed care was placing the buffer clear *above* the
re-entered label rather than inside it, which is exactly what the C's
declaration-before-label placement says.

Its `scan_words` is what the buffer opcodes were designed for and had never been
used by: fifteen alphabetic characters into a 16-byte buffer, then `strncmp`
against two tables of zero-padded 16-byte entries -- which is `BUF_PUSH` and
`IF_BUF_EQ` against a string table, exactly. The port also reproduces an
upstream hang (`while (!iswspace(lookahead)) skip;` never terminates at EOF,
because `iswspace(0)` is false) rather than guarding it, because a guard would
be a divergence and no corpus file reaches it.

**With kotlin the cheap band is finished.** Nine scanners ported, nine
byte-identical on both corpora, and everything left is one of the four the
decision was always about.

### javascript needed a *sixth* lexer call, which the host-interface table missed

`docs/scanner-vm.md` states the VM's host interface is five operations, and
discusses exactly one omission -- `get_column`, deliberately absent because no
scanner calls it. javascript calls a sixth: `is_at_included_range_start`, inside
its automatic-semicolon scan. That table surveyed javascript.

So the VM gained `IF_RANGE_START`. The instructive part is *where the answer
lives*: for a whole-document parse there is one included range starting at byte
zero, so the question reduces to "are we at the start" -- but that is a fact
about the host's ranges, not about the VM. The reduction sits in the host, and a
host that parses injected ranges answers differently without the bytecode
changing.

Together with `MAP`, that is **two additions in eleven languages, both of them
the same kind of miss**: the design survey catalogued what the scanners *compute*
and under-catalogued what they *call out to*. Worth expecting one more in the
four that remain rather than being surprised by it.

### Sharing a header bought two functions, not a scanner

typescript's `scanner.c` is a 13-line shim over a `common/scanner.h` it shares
with tsx, and an earlier revision of this document already corrected "typescript
is free once javascript is done" to "call it 40% of a fresh port". Porting both
puts a number on it, and the number is lower than 40%.

`scan_template_chars` and `scan_jsx_text` are character-for-character identical.
**Every other function differs**: `scan_whitespace_and_comments` returns a bool
rather than a tri-state, takes no `consume` flag, tracks no block newline and
stops its line comment at `\n` only; `scan_automatic_semicolon` has no `/` arm,
no `is_at_included_range_start`, and a `}` arm that skips trailing space looking
for `:` so `type F = ({a}: {a: number}) => number` is not cut in half; the switch
moves `:` and `.` to the reject list and makes `{`, `(` and `[` conditional on
valid symbols; `scan_ternary_qmark` rejects `?.` as well as `??`, consumes
whitespace with *advance* rather than skip, and rejects `:`, `)` and `,`.

**The general lesson for the four left: a shared header is evidence of a shared
shape, not of shared code.** Two of the four -- markdown's block and inline
scanners -- are the next place to apply it.

### rust closes the audit `docs/scanner-vm.md` opened, at the cheap end

python was the hard end of the serialization argument; rust is the trivial one
-- a single `uint8_t opening_hash_count`, which is one persistent register and
no stacks at all. **46 state transitions, bijection clean.** Between the two,
the relation-compatibility claim now has both ends of its range measured.

It is also the language `docs/host-ctype-divergence.md` is written about: its
float rule is the one place across four constructed candidates where the host's
`isw*` actually changes a tree (`1.é` is a field access under a UTF-8 locale and
a float plus ERROR under `LC_CTYPE=C`). That divergence is closed by
construction here, because the port reads `iswalpha` from the pinned table.

Two upstream oddities the port reproduces rather than tidies: an unterminated
block comment returns **true**, deliberately, because otherwise nothing above an
unclosed `/*` could be highlighted; and `char first = (char)lexer->lookahead` is
truncated to a signed char before every comparison, which is equivalent to
masking the low byte only because every target is ASCII.

### python is the case `docs/scanner-vm.md` said a faithful port would get wrong

That document reasons its way to an obligation it could not measure: what a port
must reproduce is not upstream's *serialization format* but the **equivalence
relation** that format induces on scanner states, because that relation is what
`external_scanner_state_changed`, `ts_stack_can_merge` and the token cache
decide on. It names python as the counter-example -- a serializer lossy in three
separate ways, where a faithful port would be *strictly finer* than upstream and
would distinguish states tree-sitter merges.

python is ported, and all three are bounds rather than bugs:

- **`indents[0]` is a sentinel.** `deserialize` pushes a 0 before reading and
  `serialize` starts at `iter = 1`, so the bottom entry exists and is defined not
  to matter. It is also provably never popped: DEDENT needs
  `indent_length < current`, and with only the sentinel left `current` is 0. A
  constant carries no distinctions, so keeping it in the VM's stack is free.
- **`delimiter_count` clamps to UINT8_MAX**, so 255 and 300 open delimiters are
  equal upstream and distinct here. Deepest in the corpus: two.
- **Truncation drops from the tail of `indents` specifically**, while the VM
  drops from the top of its deepest stack. For indents the top *is* the tail, so
  the two agree unless `delimiters` is the deeper stack -- hundreds of nested
  f-strings. Deepest recorded python state: **11 bytes** against 1024.

**411 state transitions, bijection clean, first run.** So the argument survives
contact with the scanner it was written about: relation-compatibility is the
right obligation, it is weaker than byte-compatibility, and it is checkable
mechanically rather than by the porter's care.

One thing the port could drop and did not: `advanced_once` is provably still
false everywhere below the escape-interpolation branch, because both exits of
that branch return. It is carried anyway. Being wrong about a proof like that
is a silent divergence, and a register costs nothing.

### html forced the ISA's first new instruction, and it is a libc call

`docs/scanner-vm.md`'s design claim was that nine scanners need no instruction
the VM does not have. html needs one, and it is worth being precise about what
kind of thing it is: not a control-flow shape, not a data structure -- a **call
into libc**.

tree-sitter-html stores `towupper(lexer->lookahead)` rather than the character,
so which two tag names count as the same is decided by the host process's case
mapping, exactly as `docs/host-ctype-divergence.md` shows whitespace is. It
cannot be approximated: ASCII-only folding gets `<DIV>` right and gets U+017F
(LATIN SMALL LETTER LONG S, which glibc upper-cases to plain `S`) wrong,
silently. It cannot be spelled with class tables, which answer membership
questions rather than computing functions. And it cannot be branches -- glibc
moves 1,477 code points.

So the VM gained `MAP k, rd, rs` over sorted `[lo, hi, delta]` runs, and
`harness/ts_ctype_tables.py` gained a `maps` section: **1,477 moved code points
compress to 690 triples**, generated from the same glibc that froze the corpus,
agreed by all three UTF-8 locales, and checked against four discriminating
controls. Fifteen lines in each runtime.

The generalisation worth carrying into D5: **`isw*` was not the whole of the
libc surface, and nothing had checked what the rest of it was.** A C-to-VM
compiler meets the same wall and needs the same answer.

### And it found a bug in the table interpreter, not in the port

html's `IMPLICIT_END_TAG` is a **zero-width** external token -- it pops a tag
and marks no bytes. It is the first one any port has produced, and on the
broken corpus the parse allocated until the heap was gone. `<ul><li>a/li></ul>`
is the smallest input that does it.

The port was right; `harness/ts_lr.mjs` was missing one of `ts_parser__recover`'s
three halts:

```c
if (did_recover && ts_subtree_has_external_scanner_state_change(lookahead)) {
    ts_stack_halt(self->stack, version); return;
}
```

Error recovery's second strategy wraps the lookahead in an ERROR and stays in
the error state. If the lookahead is a zero-width external token that *changed
the scanner's state*, skipping it again at the same offset is not a new
situation -- it is the same one with a different scanner state, forever.

What makes this the interesting kind of bug: `hasExternalScannerStateChange` was
already being recorded on the leaf and propagated through parents. The data was
transcribed and the **behaviour** was not, so it sat dead through five languages
and every existing test. Nothing in the corpus could reach it, because nothing
in the corpus had a zero-width external token.

Two habits it argues for. Port a grammar that exercises a *shape* the others do
not, rather than the cheapest next one -- that is why xml and html went before
rust. And re-run the full `--edited` corpus after every port, not just the clean
one: this was invisible on 16/16 clean and fatal on the same 16 broken.

**Both paid off immediately: python found a second one, in the same function.**
Its `_indent` is zero-width too, and `def f):\n    pass\n` looped the same way
with the same symptom. Different line, though. `ts_parser__recover`'s strategy 2
-- wrap the lookahead in an ERROR and stay in the error state -- ends with

```c
ts_stack_push(self->stack, version, error_repeat, false, ERROR_STATE);
if (ts_subtree_has_external_tokens(lookahead)) {
    ts_stack_set_last_external_token(
        self->stack, version, ts_subtree_last_external_token(lookahead));
}
```

and the second half was missing. A version's last external token is where the
next scan *resumes the scanner from*; skipping a token during recovery still
consumed whatever state change it made, so a version that forgets it asks the
scanner the same question from the same state forever. python re-pushed the same
INDENT until the heap was gone.

The two bugs are siblings and neither would have caught the other: html's is
halted by the guard that only fires when strategy 1 recovered, and python's is on
the path where strategy 1 found nothing and strategy 2 ran. **Two zero-width
external tokens, two consecutive ports, two separate omissions in one upstream
function** -- which says the thing to check next is not "are there more bugs like
this" but "which other upstream functions were transcribed while no grammar could
reach them".

**That audit was run, and it is clean.** Two passes:

- *Written but never read*, which is html's signature exactly. One field in
  `ts_lr.mjs` qualifies, `lookaheadChar` -- and upstream never reads it either
  outside `ts_subtree__write_char_to_string`, which is debug printing. No
  methods are defined and never called except `getColumn`, which is unreachable
  by design (no scanner in the roster calls it and the VM has no opcode).
- *Every upstream site that touches external-scanner state*, which is python's
  signature. There are eleven across `parser.c` and `stack.c`: the deserialize
  and serialize in `ts_parser__lex`, the empty-token guard, the two fields
  stamped on the leaf, the token cache's key and setter, `shift`, the two in
  `ts_parser__recover`, and `copy_version` / `can_merge` in the stack. All
  eleven now have counterparts. The twelfth, the reusable-node check in
  `ts_parser__get_lookahead`, belongs to incremental reparse, which this file
  documents as out of scope.

So the class is closed rather than assumed closed. What the audit cannot reach
is the same question for functions with no external-scanner involvement at all;
those are exercised by the nine languages already parsing byte-identically on
both corpora, which is a weaker argument but not a vacuous one.

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
