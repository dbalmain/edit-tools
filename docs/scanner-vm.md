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
