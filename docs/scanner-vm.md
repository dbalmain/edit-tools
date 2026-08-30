# The scanner VM: catalogue, ISA, and what it costs

The user's instruction was "consider packaging as a bytecode interpreter". This
prices it. Read `docs/parse-layer.md` for the six routes first, and
`docs/host-ctype-divergence.md` for a finding that came out of this work and
outranks it.

Status: **TOML is ported and verified against a recorded scanner-call trace.**
markdown-block is priced on paper, not built. Everything else here is design.

## 1. What the nine scanners actually need

Sources fetched at the pins in `harness/languages/*.toml`. Line counts match
`docs/parse-layer.md`'s table exactly, which is the evidence that the three
fetched from grammar repos (python, yaml, css — absent from their sdists) came
from the right tags.

### Lexer API surface

The whole host interface, across all nine files:

| API                     | Used by                                        |
| ----------------------- | ---------------------------------------------- |
| `lexer->lookahead`      | all nine                                       |
| `lexer->advance(l, false)` | all nine                                    |
| `lexer->advance(l, true)`  | css, javascript, kotlin, python, rust, yaml |
| `lexer->mark_end`       | all nine                                       |
| `lexer->result_symbol`  | all nine                                       |
| `lexer->eof`            | css, kotlin, markdown-block, markdown-inline, python, rust |
| `lexer->get_column`     | **none**                                       |

`get_column` is the significant one: it is the only lexer call with a
non-trivial implementation (it re-reads the line from the start of the token),
and **no scanner in this roster uses it.** YAML and markdown-block both need a
column and both track it themselves by counting in `advance`. So the VM's host
interface is five operations.

### State carried across tokens

| Scanner         | `serialize` output                                       | Shape                    |
| --------------- | -------------------------------------------------------- | ------------------------ |
| toml            | 0 bytes                                                   | stateless                |
| css             | 0 bytes                                                   | stateless                |
| javascript      | 0 bytes                                                   | stateless                |
| kotlin          | 0 bytes                                                   | stateless                |
| rust            | 1 byte                                                    | one `u8` counter         |
| markdown-inline | 4 bytes                                                   | four `u8` scalars        |
| markdown-block  | 5 + 4·blocks                                              | 5 scalars + `u8` stack   |
| python          | 2 + delims + 2·indents                                    | 2 scalars + 2 stacks     |
| yaml            | 10 + 4·depth                                              | 5 `i16` + 2 `i16` stacks |

Four of nine are stateless; the rest need scalars plus at most two stacks of
small integers. No scanner stores a string, a pointer, or anything the VM would
have to represent as a heap object.

Two upstream details a port must not copy blindly. **python and yaml truncate**
when the state exceeds tree-sitter's 1024-byte buffer, silently dropping the
top of their stacks — deep-nesting behaviour that no test in this repo covers.
**markdown-block does not truncate at all**: `sizeof(Block)` is 4 (a bare C
enum), so 255 open blocks overflow the serialization buffer. That is an upstream
bug, and it is the kind of thing a transcription reproduces by accident.

### C features used

| Feature                             | Scanners                                             |
| ----------------------------------- | ---------------------------------------------------- |
| `<wctype.h>` classification         | css, javascript, kotlin, rust, markdown-block        |
| dynamic array / stack               | python, yaml, markdown-block                          |
| `malloc`/`realloc`/`free`           | python, yaml, markdown-block, markdown-inline         |
| fixed char buffer + string compare  | kotlin (16 B), markdown-block (11 B)                  |
| function pointer (indirect call)    | yaml                                                  |
| self-recursion                      | markdown-block                                        |
| floating point                      | **none** (both matches are comments)                  |
| `get_column`                        | **none**                                              |

That list is the whole ISA requirement, and it is small. The allocation is only
ever "grow a stack of small integers"; nothing allocates a variable-length
object. The absence of floating point matters more than it looks — float is the
one datatype whose Rust/JS semantics genuinely differ in the corners, and it is
not needed at all.

**The outliers are outliers in size, not in kind.** YAML's 1,415 lines are 40
small `scn_*` functions over the same five lexer calls; markdown-block's 1,602
are three near-identical `parse_star`/`parse_plus`/`parse_minus` bodies plus a
long `scan`. Neither needs machinery the other seven do not, with two
exceptions, both cheap: yaml's function pointer (one indirect-call opcode) and
markdown-block's self-recursion (one opcode). This is the answer to the question
the brief asked to report honestly — a VM sized for the median does run all
nine, and the reason is that the outliers are repetitive rather than
sophisticated.

## 2. The ISA

Forty opcodes, one byte each, operands ULEB128 (indices) or SLEB128 (signed
immediates) or a fixed 2-byte little-endian absolute jump target. The full
listing is in `spike/scanner-vm/vm.js`; the groups are:

| Group             | Opcodes                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| lexer             | `ADVANCE` `SKIP` `MARK_END` `LOOKAHEAD` `EOF`                            |
| termination       | `EMIT` `EMIT_R` `FAIL` `EMIT_IF` `EMIT_IF_R`                             |
| lookahead tests   | `IF_CHAR` `IF_NCHAR` `IF_CLASS` `IF_NCLASS` `IF_EOF` `IF_NEOF`           |
| valid symbols     | `IF_VALID` `IF_NVALID` `IF_VALID_R` `IF_NVALID_R`                        |
| registers         | `CONST` `MOV` `ALU` `ALUI`                                               |
| register tests    | `IF_CMP` `IF_CMPI`                                                       |
| stacks            | `PUSH` `POP` `PEEK` `SETTOP` `LEN` `CLEAR` `GETIDX`                      |
| buffer + strings  | `BUF_CLR` `BUF_PUSH` `BUF_LEN` `IF_BUF_EQ`                               |
| control           | `JMP` `CALL` `RET` `CALL_R` `RECURSE`                                    |

**Tests are fused compare-and-branch.** Almost every line of every scanner is
"look at the character, decide where to go", so `IF_CHAR c, target` is one
instruction rather than a compare, a flag and a branch. That removes flag
lifetime as a concept, which is one fewer thing for two implementations to
disagree about.

### State model

32 registers of `i32`; 4 stacks of `i32`; one 32-byte scratch buffer; a call
stack. All sized from the catalogue, not from taste:

- **32 registers** because markdown-block's `parse_minus` holds 11 locals live
  alongside the six scalars its `Scanner` struct carries. 16 was the first
  guess and pricing markdown-block disproved it. A register operand is a whole
  byte either way, so the wider file costs zero encoded bytes.
- **4 stacks** because python and yaml each carry two, and markdown-block one.
- **32 bytes of buffer** because kotlin's word buffer is 16 and
  markdown-block's tag-name buffer is 11.
- **`GETIDX`** exists because markdown-block walks its open-block stack with
  `items[s->matched]` — an absolute index from the bottom — at three sites, and
  `PEEK` only reaches down from the top. Also found by pricing markdown-block.

The program header declares which registers and stacks are persistent. Those
survive between scans; everything else is zeroed on entry. That is the
partition upstream expresses by putting some things in `Scanner` and some in
locals, made explicit.

### `serialize` / `deserialize` are VM-defined, not scanner-defined

This is the design decision I would defend hardest. Upstream, every scanner
writes its own serializer, and two of the nine get it subtly wrong (§1). In the
VM the format is fixed by the header: persistent registers in index order as
SLEB128, then persistent stacks in index order as a ULEB128 length and SLEB128
elements. Over-long state drops elements from the *top* of the deepest stack,
which is the behaviour python and yaml already have.

So there is no per-scanner serialization code, and therefore no per-scanner
serialization bug. Nine chances to get it wrong become zero. Nothing reads
upstream's serialized bytes, so byte-compatibility with upstream is not
required — only self-compatibility across the two runtimes, which is what the
fixed format buys.

### What the VM cannot express

Stated plainly, because the interesting part of a design is its edges:

- **Unbounded scratch memory.** There is one 32-byte buffer and four stacks
  capped at 256. A scanner needing a growable string would not fit. None of the
  nine does.
- **Arbitrary-precision or floating-point arithmetic.** No `MUL`, no `DIV`, no
  floats. None of the nine uses any (both `float` matches in the catalogue are
  comments).
- **`get_column`.** Deliberately absent — no scanner uses it, and implementing
  it means re-reading the line, which is the one lexer call with a non-trivial
  cost. `0x06` is reserved and traps.
- **Reading the source buffer.** Same restriction upstream scanners have: the
  only view of the input is `lookahead` at the cursor.
- **Recursion deeper than 4**, calls deeper than 32, stacks deeper than 256.

**When a scanner needs something the VM lacks, the answer is to extend the ISA,
offline, once** — as happened twice while pricing markdown-block. The failure
mode to avoid is a per-language escape hatch, because that is exactly the
imperative-code-in-a-package that the route exists to eliminate.

### Instructions shaped by Rust/JS divergence

Every one of these is a place the two languages differ and the ISA closes:

| Hazard                    | What the ISA does                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| integer width, overflow   | Every value is `i32`, wrapping. JS applies `\| 0`; Rust uses `wrapping_*`. No other numeric type exists. |
| shift counts ≥ 32         | Masked to 5 bits in the instruction definition. JS masks silently, Rust panics; neither is left to chance. |
| logical vs arithmetic shift | Only arithmetic `SAR`. A logical shift is `AND` then `SAR`.                                            |
| `i32::MIN % -1`           | `MOD` traps on a non-positive divisor. Rust overflows there; JS does not.                              |
| division                  | Absent. Not needed, and a rounding-mode question nobody should have to answer.                         |
| character classification  | No `isw*`. Classes are sorted code-point ranges carried in the package. This is the fix for the libc divergence in `docs/host-ctype-divergence.md`. |
| case folding              | No fold instruction. ASCII-lowering is written out as a range test and a subtract, so no locale or Turkish-I question arises. |
| UTF-8 vs UTF-16           | `lookahead` is a Unicode scalar value; `ADVANCE` moves by the code point's UTF-8 length. A JS host must iterate code points, not code units. This is the single most important host-interface rule and where a naive JS port silently diverges on astral input. |
| string comparison         | The buffer is bytes and `BUF_PUSH` takes the low 8 bits explicitly. String-table entries are byte arrays. |
| undefined behaviour       | There is none. Every out-of-range index, bad opcode, empty pop, full push, budget exhaustion and unknown ALU op is a **trap**, defined as halting the scan as `false`. |

**Termination.** A scanner must terminate. Rather than a total instruction cap,
which would scale with file size, the VM caps instructions *between two
consecutive lexer advances* at 4,096. That bounds non-advancing loops — the
actual hazard — without bounding total work on a large file.

### How the parser drives it

`scan(lexer, valid_symbols) -> (emitted, symbol)`. The host supplies four
methods: `lookahead()`, `advance(skip)`, `markEnd()`, `atEof()`. That is the
entire interface, and it is five operations because the catalogue says
`get_column` is unused.

## 3. TOML: the result

tree-sitter-toml 0.7.0's 82-line scanner (63 code lines, 55 of them body)
hand-compiles to **137 bytes** of bytecode; the whole package section, with
header, class table and everything else, is **165 bytes**, 131 gzipped.

### The oracle

Not tree comparison. `spike/scanner-vm/record/` wraps the real `scanner.c` and
records **every invocation the parser makes** — entry offset, lookahead, the
valid-symbols vector, every `advance`/`skip`/`mark_end` in order, and the
verdict — by casting `TSLexer *` to tree-sitter's internal `Lexer *` and
swapping the lexer function pointers. Replay asserts the VM issues the
*identical call sequence* and returns the identical verdict.

That is stronger than comparing trees, which only sees the calls that survive
into the tree shape, and it is what let three separate weaknesses show up.

| Oracle                | Files | Scanner calls | Mismatches (JS) | Mismatches (Rust) |
| --------------------- | ----: | ------------: | --------------: | ----------------: |
| frozen TOML corpus    |    15 |           230 |               0 |                 0 |
| fuzz, incl. malformed | 3,039 |        30,684 |               0 |                 0 |
| incremental reparse   | 1,325 |        14,764 |               0 |                 0 |
| **total**             |       |    **45,678** |           **0** |             **0** |

**Both runtimes.** `spike/scanner-vm/rust/` decodes the same `toml.svm` blob and
replays the same traces. The project's central claim — one data artifact, two
runtimes, identical output — is demonstrated here rather than asserted.

### The frozen corpus is a weak oracle for this

Worth recording, because it generalises past TOML: **the 15 corpus files fire 3
of TOML's 5 external tokens, and 210 of 230 calls take the trivial path.** Two
token types never occur at all. A port that got the multiline-string delimiter
counting wrong would have passed.

The fuzz corpus fixes it — all five tokens, and 11,209 calls returning false,
which is error-recovery behaviour the frozen corpus **cannot** contain, because
`gen_trees.py` refuses to emit a tree containing `ERROR` or `MISSING`. This is
the oracle gap `docs/parse-layer.md` names, met for one scanner.

## 4. markdown-block, priced on paper

The worst case: 1,602 raw lines, 1,376 code lines. Split by what the VM
actually has to carry:

| Region                                  | Code lines | Becomes                        |
| --------------------------------------- | ---------: | ------------------------------ |
| enums, constants, tag tables, struct    |        175 | package **data** (classes, string table, valid-sets) |
| `serialize` / `deserialize`             |         46 | **free** — VM-defined          |
| `create` / `destroy` / ABI wrappers     |         33 | **free**                       |
| `push_block` / `pop_block` / `roundup_32` |       ~20 | **free** — VM stacks           |
| executable body                         |    **1,299** | bytecode                     |

### Does it fit?

Yes, after two ISA changes, both already made and retested: 32 registers
instead of 16, and `GETIDX`. Everything else maps directly:

- the `simulate` flag is a register, and the `if (!s->simulate)` guards are
  branches;
- `advance()`'s tab-stop arithmetic is `ALUI mod` by 4 — the reason `MOD` exists
  and the reason its divisor is restricted to a positive immediate;
- the 20-arm `switch (block)` collapses to three range tests, because the arms
  are contiguous enum runs;
- `is_punctuation` is a class;
- the 65 HTML tag names are a string table plus `IF_BUF_EQ`, with `towlower`
  written out as an explicit ASCII range test rather than a fold;
- `scan(s, lexer, paragraph_interrupt_symbols)` — the self-call with a literal
  valid-symbol vector — is `RECURSE`, which exists for exactly this;
- `parse_fenced_code_block(s, delimiter, ...)`'s char parameter is a register.

**Nothing is missing.** That is the honest answer to the brief's question, and
the reason is in §1: markdown-block is long because it repeats itself
(`parse_star`, `parse_plus`, `parse_minus` are near-identical), not because it
does anything the other eight do not.

### How many bytes?

Calibrated by hand-compiling two real markdown-block functions —
`advance()` and `match()`, 78 code lines, **193 bytes measured**, in
`spike/scanner-vm/mdblock.sample.js`, with tests so the figure cannot rot. That
is **2.47 bytes per body line**, on the hard scanner, not on TOML.

Two independent estimates:

- **Line rate**: 1,299 × 2.47 = **3,209 B**.
- **Construct count** (142 lookahead tests, 188 `if`s, 48 loops, 63
  valid-symbol tests, 106 advances, 43 case arms, …, costed per opcode):
  **3,151 B**.

They agree within 2%. And the rate, derived only from markdown-block, predicts
TOML at 136 bytes against an actual **137** — a 1% error on a scanner it was not
fitted to.

So: **~3.2 KB of bytecode, plus ~0.5 KB of tables** (65 strings / 336 bytes of
content, the interrupt valid-set, four classes) ≈ **3.7 KB raw** for the worst
scanner in the roster.

**Error bar: ±40%**, i.e. 2.2–5.2 KB. The agreement between the two methods
measures self-consistency, not accuracy — both are calibrated on code I compiled
myself in one style, and neither sample exercised the two constructs I expect to
be dearest (string-table matching and the valid-symbol dispatch that dominates
`scan`). A different porter, or a compiler rather than a person, would land
elsewhere in that band.

### All nine

Same rate applied to each scanner's body lines:

| Scanner         | Raw lines | Body lines | Est. bytecode |
| --------------- | --------: | ---------: | ------------: |
| toml            |        82 |         55 |  136 (**137 actual**) |
| css             |       100 |         71 |           175 |
| javascript      |       364 |        264 |           652 |
| rust            |       393 |        290 |           716 |
| markdown-inline |       397 |        276 |           682 |
| python          |       437 |        340 |           840 |
| kotlin          |       459 |        389 |           961 |
| yaml            |     1,415 |      1,163 |         2,873 |
| markdown-block  |     1,602 |      1,299 |         3,209 |
| **total**       | **5,249** |  **4,147** |    **~10 KB** |

**~10 KB of bytecode for the entire roster, raw**, spread across nine packages
that download independently. The marginal language costs 0.1–3.2 KB. Against
`docs/parse-layer.md`'s figure of 30–200 KB of grammar per language under route
A, the scanner half of an own-the-parser route is not where the bytes are — the
LR tables are, and that is the tables track's problem, not this one.

### What one port costs, and the number that matters

TOML took roughly half a day including building the trace recorder and the
replay harness — but the harness is a one-time cost, so the marginal port is
much less. The two markdown-block functions took about twenty minutes for 78
lines. Extrapolating at that rate, markdown-block's 1,299 lines is **2–4 days**
of careful work, and the nine together perhaps **3–4 weeks**, with the same ±40%
and a strong caveat: I ported the smallest scanner and 6% of the largest.

That number only means something against the alternative, and there is now a
real one to compare against.

**GoTreeSitter** (`github.com/odvcencio/gotreesitter`, MIT, pure-Go tree-sitter
runtime, 206 grammars) ships **119 hand-written Go external scanners**. Somebody
paid the port cost 119 times, in one language, and shipped it. So "hand-port the
scanners" is not impractical, and any argument for the VM that rests on the port
being too hard is wrong.

The argument that survives is about **which way the errors point**, and it is
the asymmetry the brief identified:

- **Hand-porting**: 9 scanners × 2 runtimes = **18 ports**. Each pair can
  disagree *with each other* on inputs neither the corpus nor the goldens
  contain. That is a silent, input-dependent divergence between runtimes — this
  project's established failure mode, and the one thing its whole test strategy
  is built to catch and would not catch here.
- **Compiling to bytecode**: 9 programs, **1 compilation each**. A bug is still
  possible, but both runtimes execute the same bytes, so a bug makes both
  runtimes wrong *in the same way*. The tree then differs from tree-sitter's and
  the corpus catches it on the next run.

GoTreeSitter is the right calibration for the first row and it does not have the
second problem, because it has **one** runtime. It is evidence that 9 ports is
affordable; it is not evidence that 18 ports agree. That distinction is the
entire case for this route, and it is worth being precise that the VM does not
buy less work — it buys work whose errors are *visible*.

## 5. What it costs to ship

All gzipped, `esbuild --minify` for JS, measured today in this worktree.

| Component                                  | Raw     | gz         |
| ------------------------------------------ | ------: | ---------: |
| `runtime-js/bundle.js` as shipped          | 59,842  | 16,501     |
| `runtime-js/bundle.js` minified            | 27,489  |  9,048     |
| **scanner VM, JS, minified**               |  7,876  |  **2,533** |
| both concatenated                          | 35,365  | 11,444     |
| **VM's marginal cost when bundled**        |         |  **2,396** |

| Rust                                | Machine code |
| ----------------------------------- | -----------: |
| scanner VM, `-O`                    |      8,581 B |
| scanner VM, `-C opt-level=s`        |      6,643 B |

So the VM is **~2.4 KB gz on the JS side** and **~8.6 KB of machine code on the
Rust side**, one time, for all languages. Against the brief's threshold — "a VM
that costs 15 KB per runtime changes what this project is" — it costs about a
sixth of that on the side where bytes are visible.

Per language, the scanner section is 0.1–3.2 KB raw against 30–200 KB of grammar
under route A. Gzipped, TOML's whole scanner section is **131 bytes**.

The Rust figure is machine code in a native binary, not a download, so gzip is
the wrong unit for it and I have not quoted one.

## 6. `ts_lex`: table or bytecode?

**Table for the DFA, VM for the scanners.** The split is stable, and the
evidence is now concrete rather than hypothetical: the tables track has a
working table-driven LR parser in JS that is byte-identical on the JSON corpus
(`ed8206e`), with the DFA represented as sorted intervals (`inRanges`);
GoTreeSitter independently reached the same representation
(`LexTransition{Lo, Hi rune; Next int; Skip bool}`); and the survey track
established that the construct set `ts_lex` can emit is **closed** across all 29
lexer bodies in the 18 pinned grammar variants.

Three reasons, in decreasing order of how much they'd have to change my mind.

**1. The DFA is the hot path; the scanner is not.** `ts_lex` runs on every
character of the file. The external scanner runs only at the handful of
positions where the parser asks for an external token — for TOML, 230 calls
across the entire corpus. Putting the per-character path through a general
bytecode interpreter means paying an interpretive dispatch per *branch* rather
than per *transition*: css has 437 lex states and emits long inline
range-comparison chains, so a single character could cost dozens of dispatches.
A transition table is one binary search. Spending the interpreter's overhead on
the cold path is free; spending it on the hot path is the whole cost.

**2. As bytecode, the DFA gets bigger, and it compresses worse.** A transition
is `(lo, hi, next, skip)` — four small fields, in a sorted, highly repetitive
array. As bytecode the same transition is a class-or-char test plus a 2-byte
absolute target, which is at least as many bytes and has far less exploitable
redundancy. The survey measured this effect directly in the C artifacts:
**code compresses about 4× worse than tables** (json 59% vs 25% of raw; go 40%
vs 15%), so `ts_lex` is 11.8% of go's gzipped payload against 4.6% raw. Turning
a table into instructions moves bytes the wrong way across exactly that line.

**3. One engine would be the complex engine.** `ts_lex` needs three lexer
operations and *no state at all* — no registers, no stacks, no valid-symbols, no
serialization. The scanner VM has all of those plus a trap surface. Unifying
means running the simple thing on the complex engine and importing its whole
failure surface into the hot path, for no reduction in what has to be verified.
The DFA interpreter is small enough (`inRanges` plus a state loop) that it is
*less* divergence risk standing alone than folded in.

**Why the split is stable rather than a temporary convenience.** The two halves
differ in kind, not degree, and the difference is structural:

| | `ts_lex` | external scanner |
| --- | --- | --- |
| state across tokens | none | up to two stacks + scalars |
| sees `valid_symbols` | no | yes, centrally |
| control flow | a DFA — closed construct set | arbitrary, open-ended |
| frequency | every character | a few positions per file |
| recoverable mechanically | yes, demonstrated twice | no — it is hand-written C |

Nothing about a future grammar moves a construct from one column to the other,
because the boundary is drawn by tree-sitter's own generator: what it can
express as a DFA goes in `ts_lex`, and what it cannot is precisely why
`scanner.c` exists.

**A qualification against my own point 3, added 2026-08-30.** I argued the DFA
interpreter is safer standing alone because it is simpler. A codex review of the
tables track's interpreter at `xhigh` found a real encoding defect that cuts
against that: a guard which is false in **both** EOF modes encodes identically to
one that is true everywhere, because an empty interval set short-circuits the
interpreter's range test. It is latent — no pinned grammar triggers it — but it
is a case where the table representation is not injective, so "the table is
simple and therefore safe" is weaker than I wrote. It does not move the
conclusion, because points 1 and 2 are about speed and size and are untouched,
and because the same class of encoding bug is available to a bytecode encoder
too. It does mean the split should not be defended on the DFA's simplicity
alone.

**The one measurement that would change this**: if a table-driven DFA turned out
to be slower than bytecode in practice — say because the interval binary search
thrashes cache on css's 437 states while a bytecode chain stays in a hot loop —
then the ranking on point 1 flips and points 2 and 3 are not enough on their
own. I did not benchmark either engine, and that gap is real.

**One genuine caveat against my own recommendation**: yaml 0.7.2's `ts_lex` has
**exactly two states** — every YAML token comes from the external scanner. For
YAML specifically, recovering the DFA as a table buys essentially nothing and
the scanner VM buys everything. If the roster were mostly YAML-shaped, one
engine would be the right answer. It isn't — css is 437 states and 57% of its
artifact is lexer code — but it shows the split is a property of this roster,
not a law.

## 7. What I did not verify

The load-bearing gaps, worst first.

**Scanner state across a resumption is untested against a real scanner.** This
is the gap the brief named and it is still open. TOML's scanner is *stateless* —
`serialize` returns 0 bytes — so all 45,678 calls say nothing about
serialization. The VM's serializer is covered only by unit tests I wrote against
my own format (`vm.test.js`): round-trip, sentinel restoration, top-drop
truncation. **No stateful scanner has been ported, so no serialized state has
ever been compared with tree-sitter's.** A port can be green on everything above
and wrong on resumption, and python or rust — 1 byte of state, the cheapest
stateful scanner in the roster — is the obvious next thing to build.

**Cross-runtime agreement is demonstrated for one scanner, on one shape of
program.** Rust and JS agree on 45,678 calls, but TOML exercises no stack, no
buffer, no recursion, no indirect call and no trap. The unit tests cover those
in JS only. The Rust VM's `PUSH`/`POP`/`RECURSE`/`CALL_R` paths have **never
executed**. They are transcriptions and they compile; that is all.

**Nothing but TOML was actually ported.** §4 is arithmetic on two hand-compiled
functions — 78 lines out of markdown-block's 1,299, about 6%. The ±40% band is
honest but it is a band around an extrapolation, not a measurement.

**No speed measurement of anything.** Not the VM, not the table DFA, not the
comparison in §6 that the recommendation partly rests on. §6's point 1 is an
argument from where the work happens, not from a benchmark.

**Error recovery is verified at the scanner-call level, not the tree level.**
The fuzz corpus drives 11,209 false-returning calls, which is far better than
the frozen corpus can do, but it compares scanner decisions rather than
resulting trees. The oracle track has since frozen a dirty corpus containing
`ERROR` and `MISSING` nodes; that is the right instrument for closing this and
it did not exist when this work started.

**My incremental oracle inherits tree-sitter's own inconsistency.** The oracle
track has found and minimised a **scratch-vs-incremental divergence inside
tree-sitter**. My replay asserts the VM matches tree-sitter call-for-call, so
where tree-sitter is inconsistent with itself, the VM faithfully reproduces
whichever behaviour was recorded. That is correct for measuring *fidelity* and
useless for measuring *correctness*, and the two should not be confused.

**Sizing limits are asserted from the catalogue, not proven.** 32 registers, 4
stacks, 256 deep, 32-byte buffer, recursion depth 4, the 4,096-instruction spin
budget. Every one is read off the nine scanners at their current pins. A
grammar bump can invalidate any of them, and the failure would be a trap — a
silent `false` — not a crash.

**The wasm rows in `docs/host-ctype-divergence.md` remain confounded** with
grammar version, as recorded there. Building `tree-sitter-css` 0.25.0 to wasm
would settle them.

## 8. Recommendation

**The bytecode VM is the right shape for the scanner problem, and the scanner
problem is not the one that decides the route.**

The brief asked whether packaging the scanners as bytecode works. It does, and
the numbers are better than the design's own fear of them:

- all nine scanners fit an ISA of 40 opcodes, with nothing missing;
- ~10 KB of bytecode covers the entire roster, 0.1–3.2 KB per language;
- the VM costs 2.4 KB gz in JS and 8.6 KB of machine code in Rust, once;
- two runtimes execute one artifact identically across 45,678 scanner calls.

So `docs/design.md`'s label for the scanner VM — "the bet worth making, and the
**highest-risk** part of the project" — should be **retired**. It is now the
best-understood part of an own-the-parser route and the cheapest to finish.
`docs/parse-layer.md`'s staging advice ("require byte-identical trees before
writing a line of scanner VM") was right when the scanner was the unknown and is
now backwards: the scanner is the known half, and every remaining unknown is in
the LR tables.

**But that does not make route C cheap, and I want to be blunt about it.** The
parse-layer document's own figure is that scanners are **0.4%** of what a grammar
is. I have made the cheap half cheaper and measured it honestly. It changes the
route's total cost by almost nothing. **The VM is worth building if and only if
the table half is built** — it has no standalone value, and building it
speculatively would be spending weeks on the 0.4%.

**What actually moved the board is not the VM.** It is
`docs/host-ctype-divergence.md`: route A was credited with *deleting* the
parse-layer's divergence risk, and it does not. Its Rust host and its wasm host
classify characters differently, by measurement. (My further claim that the
frozen corpus carried a third answer was wrong and is corrected in that
document; the corpus is locale-invariant, and the locale is now pinned on `main`
regardless.) The recommendation in `docs/parse-layer.md` leans on that credit,
so route A should be repriced whether or not anyone writes another line of VM —
and the cheapest item on the whole board is pinning `LC_ALL` in `gen_trees.py`,
which costs one line and makes the corpus reproducible.

That finding also happens to be the one place the VM wins on something other
than bytes: character classes as sorted code-point ranges in the package have no
libc, no locale and no host. The ambiguity is resolved once, offline, by whoever
writes the class, and it is recorded in the artifact. No other route on the
board can say that.

**Recommended order**, if an own-the-parser route is pursued at all:

1. ~~Pin the locale in `gen_trees.py`.~~ **Done** on `main` in `c110638`, which
   also fixed two locale-dependent encoding defects in `manifest.py` and
   `gen_trees.py` that were the more serious half of that finding.
2. Finish the LR tables for a scanner-free grammar and require byte-identical
   trees. That is still the load-bearing unknown; the tables track has JSON.
3. Port **python or rust** to the VM next — not markdown-block. Both are cheap
   and both have real serialized state, which is the one thing 45,678 green
   calls did not test.
4. Only then price the rest.

**The one fact that would change this recommendation**: if the LR-table half
cannot reproduce tree-sitter's trees byte-identically for a scanner-free grammar,
the scanner VM is worthless regardless of how well it works, and this document
describes a well-built component of a project that should not be started.
