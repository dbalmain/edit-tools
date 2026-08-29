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
