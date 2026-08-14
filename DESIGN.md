# Bytecode formatter

**Do not ship this.** Shared-program bytecode is larger than the
schema on every artefact; the code array is only 40% of the Python
package gzip, and deleting it still loses. The VM is a good fuzzer
IR. The download wants the schema. Full verdict at the end.

The rule evaluator is a small stack VM. The authored form is still a
map from CST node type to a **layout kind** — a named algorithm plus
its parameters — in `authored/<lang>.json`. `build.sh` compiles that
into `packages/<lang>.json`: a string constant pool and a flat array
of integers. Both runtimes load only the compiled form.

This run exists to measure whether a VM is smaller than a schema
walker and whether two interpreters of one instruction stream can be
differentially fuzzed. Layout output is unchanged from the kinds
build; any baseline diff is a port bug.

## Size (gzip -9)

Two bytecode encodings against the same schema baseline. *Unrolled*
emits a full kind body per node type. *Shared* emits each kind
program once; node types hold a small operand vector and jump to
that program. `FORMAT` is the call — there is no `CALL`/`RET`.
Templates stay unrolled: the spec *is* the program.

|                        | schema raw | schema gzip | unrolled raw | unrolled gzip | shared raw | shared gzip | Δ gzip shared |
| ---------------------- | ---------: | ----------: | -----------: | ------------: | ---------: | ----------: | ------------: |
| `runtime-js/bundle.js` |      26351 |        6747 |        29032 |          7361 |      31717 |        7689 |          +942 |
| `packages/python.json` |       7038 |        1376 |        20000 |          4789 |      10618 |        3049 |         +1673 |
| `packages/json.json`   |        436 |         215 |         1908 |           764 |       1644 |         742 |          +527 |

Sharing closed about half the Python package gap (4789 → 3049 gzip)
and almost none of the JSON gap (the leftover is the seq/infix
programs plus the integer encoding, not copies). The runtime grew:
operand opcodes (`ARG`, `CTEXT`, `CPEEK`, …) are new interpreter
surface.

Shared-program bytecode is still clearly behind the schema. Python
is 2.2× gzip (was 3.5× unrolled). The schema's advantage is **not**
merely that it avoids duplication.

**Break-even.** Incremental shared-runtime cost is +942 gzip. Mean
per-package *saving* is **−1100** gzip (packages still grew).
Language count × per-package saving never exceeds the runtime cost:
shared-program bytecode **does not break even at any language
count**.

A compact kind-level opcode (`SEQ open close sep flags`) would
probably draw or win on gzip, because it is the schema with shorter
keys. Expanding kinds into a general instruction stream is the wrong
direction for the download. It is the right IR for a fuzzer. The
3049 is decomposed at the end; the code array is not most of it.

## ISA, in brief

Typed stacks (docs, nodes, i32 wrapping). One forward-only child
cursor per frame. `HALT` always finishes the cursor. A frame carries
an operand vector; shared programs read it with `ARG` / `ARGI` and
the `C*` ops (`CTEXT`, `CPEEK`, `CTOKEN`, …). Host ops are few:
`FORMAT` (recurse), `OPAQUE` (source span), `PAREN`, `BLANK_EXTRA`,
`HOST_CHAIN` (spine flatten; flags from the int stack),
`HOST_FROM_IMPORT`. Everything else — `seq`, `infix`, `fwd`,
`clause`, `template`, `body`, `comp`, `dot`, `sub`, `pfx`, `wrap` —
is compiled to cursor + doc ops.

No floats. No hash-map iteration. Jump targets are verified at load.

## Linearity

**Structural, with a caveat.** The ISA cannot express taking a child
twice or walking children out of order: there is one cursor, `TAKE` /
`SKIP` only advance, there is no rewind. `HALT` refuses leftovers, so
an unconsumed child cannot become output. The verifier proves ops,
immediates, jump targets, and that every path hits `HALT` or
`REFUSE`. It does **not** prove that a loop drains the cursor for
every tree — that refuse stays dynamic. Input-dependent checks (wrong
token, trailing comma on JSON, leaf with children) also stay dynamic.

Sharing programs does **not** weaken this. We share at kind level:
every `seq` type has the same child shape (open, items/seps, close)
and differs only in operand tokens. A shared program called from two
node types with *different* child shapes would be a real cost of
sharing; we do not do that. `pfx` has three modes (keyword, op
field, named fields) as branches of one program — each path still
consumes the cursor exactly once. `clause` is `TAKE_ALL` plus bag
lookup by operand field names, the same protocol for every clause.

`chain` flatten walks descendant fields of a node whose children were
already `TAKE_ALL`'d. That is not a second consume of the current
frame's cursor.

## Authoring

Edit `authored/<lang>.json`, not the compiled file. `build.sh` runs
`node tools/compile-package.js` then the Rust release build. JSON
does not use `template`.

## Package shape (authored)

## Package shape

```json
{
  "language": "json",
  "indent": 2,
  "comment_type": "comment",
  "opaque": ["string"],
  "steal_into_body": ["function_definition", "if_statement"],
  "blank": {
    "max": 2,
    "before_top": ["function_definition", "class_definition"]
  },
  "nodes": {
    "document": { "kind": "fwd" },
    "object": {
      "kind": "seq",
      "open": "{",
      "close": "}",
      "sep": ",",
      "trailing": "none",
      "flat_pad": true
    },
    "pair": { "kind": "infix", "op": ": " }
  }
}
```

Authored readable in `authored/`. Shipped as compiled bytecode:
a const pool, a code section of shared kind programs, an `entry`
map (type → pc), and an `args` map (type → operand vector).

| Field | Role |
| --- | --- |
| `indent` | columns per indent level (JSON 2, Python 4) |
| `opaque` | node types emitted as concatenated descendant leaf text; never reflowed |
| `comment_type` | node type the attach pass treats as a comment (absent → no comments) |
| `steal_into_body` | types whose comment-just-before-`block` is hoisted into that block |
| `blank` | extra hardlines around top-level defs (Python); unused for JSON |
| `nodes` | type → `{ kind, …params }` |

Unlisted types: if the type is in `opaque`, emit raw text; else if the
node has `text`, it is a `leaf`; else `fwd` into its one non-punctuation
child. Several significant children with no kind is a **refuse**, not a
guess.

## Kinds

| Kind | Formats | Parameters |
| --- | --- | --- |
| `leaf` | identifiers, numbers, keywords, punctuation | — |
| `fwd` | wrapper with one interesting child (`document`, `expression_statement`) | — |
| `seq` | bracketed comma-lists | `open`, `close`, `sep`, `trailing`, `singleton_comma`, `flat_pad` |
| `infix` | two-sided operators with fixed spacing | `op` or `op_field` |
| `body` | `module`, `block` | uses `blank`; `tight` skips extra blanks |
| `pfx` | keyword/operator then operand | `kw` or `op_field`, `sp`, `paren` |
| `wrap` | already-present brackets around one expression | `open`, `close` |
| `chain` | flatten-able operator trees | `already_flat`, `break` (`paren`) |
| `clause` | `keyword header:` + indented body + tails | `keyword`, `header`, `colon`, `body`, `tails`, `arrow` |
| `comp` | list/set/dict/generator comprehensions | `open`, `close` |
| `dot` | `obj.attr`, method spines | — |
| `sub` | `obj[index]` | — |
| `from_import` | `from … import …`, with or without existing parens | — |
| `template` | escape hatch | `doc` with `$` holes; `paren` |

JSON uses `fwd`, `seq`, `infix`, `leaf`, and `opaque`. The other kinds
exist so a Python package can be added without a runtime change.

### `seq`

Collect items (non-punctuation children). A comma immediately before
the closer is a *magic comma*: if `trailing` is `"magic"`, the group is
born with `shouldBreak: true`. `trailing: "none"` (JSON) forbids a
trailing comma and emits none. `singleton_comma` keeps `(lonely,)` even
when flat.

`flat_pad: true` uses `line` inside the group, so the flat form of a
JSON object is `{ "a": 1 }`. Without it (arrays, Python collections)
the flat form uses `softline` and prints `[1, 2, 3]`.

Empty is `text(open + close)`.

Broken `seq` with `trailing: "magic"` emits `ifBreak(",", "")` after
the last item, so a width-forced explode writes a sticky comma.

### `infix`

Operands joined by `op` (`": "`, `" = "`, `"="`). The operator token
in the tree is consumed and replaced by that string. `op_field` names
the field that holds the operator (`+=` on `augmented_assignment`).

### Linearity

Every kind walks the matched node's **direct children left to right**
and must consume each one exactly once. Comments are consumed by the
attach pass first; kinds see the rest. Unconsumed, missing, duplicated
or reordered children make the runtime **refuse** (exit 1) rather than
emit.

Token mutation is allowed only through two enumerated policies:

1. a trailing comma where it is semantically optional (`trailing:
   "magic"` / `singleton_comma`; never on JSON, never on a subscript);
2. a balanced parenthesis pair around one layout region when that
   region's group breaks (`break: "paren"` / `"paren": true`).

Anything else — dropping a child, inventing a keyword, reordering
keys — is a refuse.

## IR

`text`, `concat`, `group(d, {shouldBreak})`, `indent`, `line`,
`softline`, `hardline`, `ifBreak(a, b)`, `lineSuffix`.

- `group` is flat if it fits and `!shouldBreak` and no `hardline`
  inside; else broken. `shouldBreak` does **not** propagate to
  enclosing groups (a magic comma explodes its list, not its parent).
- `hardline` sets a `brk` bit that *does* force enclosing groups.
- `ifBreak` contents are not scanned for `hardline`.
- `lineSuffix` is a side buffer flushed before the next newline; it
  does not affect `fits`. Trailing comments live here.
- Width of `text(s)` is Unicode scalar values (`[...s].length` in JS,
  `s.chars().count()` in Rust). Never JS `.length`.

The printer is Wadler 2003 via Lindig, matching the reference loop
with those three additions.

Indent width comes from the package. `indent` means one level.

## Runtime / package split

| Runtime | Package |
| --- | --- |
| Wadler printer | indent width |
| Comment classify / steal / attach | `comment_type`, `steal_into_body` |
| Paren-insert combinator | `"paren": true`, `break: "paren"` |
| Kind implementations | which kind each type uses |
| Magic-comma detection | `trailing` |
| Operator-spine flattening | which types are `chain` |
| Blank-line insertion | `blank` |
| Opaque leaf concat | `opaque` |
| Refuse on linearity failure or unknown interior | — |
| | every bracket, separator, keyword, spacing string |

A new language that is seq/infix/fwd (JSON, a CSS-ish object language)
is a package. A language whose native layout is not one of the kinds
needs a runtime change — or a `template`, which cannot measure and
cannot look at a grandparent.

## Adding a language

1. Write `authored/<lang>.json`.
2. Mark string-like nodes `opaque`.
3. For each interior type, pick a kind and fill in brackets.
4. If the tree has comments, set `comment_type` and, if the grammar
   leaves comments as siblings of `block` (tree-sitter-python), list
   those parents in `steal_into_body`.
5. `./build.sh` compiles the package. Run both `fmt-rust` and
   `fmt-js` on a tree at two widths. They must agree byte-for-byte;
   a mismatch is a runtime bug, not a package bug.

JSON is the existence proof: four node entries, no steal list, no
templates.

## What this cannot do

- Overflow where the language leaves no break (a long identifier, an
  opaque string, a Python attribute-only chain that black also leaves
  long).
- Change quote styles or rewrite string contents. `string` is opaque.
- Format expressions inside f-string interpolations (also opaque).
- Express a layout that is not a kind and not a template.
- Honour the author's line breaks as a preference, except via a magic
  trailing comma.
- Handle a language whose layout is not seq/body/clause/chain without
  a new kind.

## What changed from the Phase 1 proposal

- **Linearity is a hard runtime check**, not an implicit property of
  careful kinds. Each kind uses an ordered child cursor and refuses
  if anything remains or a required token is missing.
- **`trailing: "none"` refuses a trailing comma** rather than
  silently dropping it. Dropping a token is not one of the two
  sanctioned mutations.
- **A singleton tuple's comma is syntactic**, not magic. `(lonely,)`
  stays flat; the comma is kept. Treating it as `shouldBreak` exploded
  a one-element tuple at every width.
- **Opaque nodes read `source[start:end]`**, not concatenated
  descendant leaves. tree-sitter-python's `string_content` omits
  unescaped text and only lists `escape_sequence` children, so leaf
  concat turned `"line one\nline two\ttabbed"` into `"\n\t"`.
- **A chain inside an existing `wrap` shares that group's mode.**
  A nested group stayed flat inside a broken wrap (pass 2 hugged
  what pass 1 exploded). Returning the inner doc without a new
  group keeps `fmt(fmt(x))` stable.
- **Attribute `paren` is suppressed when the parent is `pfx`.**
  Wrapping `query.limit` without its `(100)` produced
  `(query.limit)(100)` — a meaning change. Calls own the parens.
- **Blank-line recovery counts whitespace-only lines in the
  source gap**, not raw newline counts. Counting comment lines as
  blanks added a new blank on every pass.
- **`template` and `from_import` shipped.** The proposal allowed
  deferring `template`; lambda, ternary, imports, and a handful of
  one-offs needed it. It still cannot measure or look at a
  grandparent.

## Fuzzer

`harness-of-your-own/fuzz.js` compiles random well-typed packages
(shared kind programs), drain-then-emit primitive streams, and
shared-entry streams that hit `ARG`/`ARGI`/`CTEXT`/`CPEEK`. Raw
styles also include an astral fit-probe and a HALT-without-drain
leftover probe (see mutation tests). The load-time verifier
accepts every stream; then `fmt-rust` and `fmt-js` run on a fixed
tree.

| seeds | tree | width | agreed ok | agreed refuse | div | seeds/s |
| ----: | --- | ----: | --------: | ------------: | --: | ------: |
| 1–400 | `json__scalars` | 88 | 251 | 149 | 0 | 20.9 |
| 1000–1199 | `python__misc` | 60 | 136 | 64 | 0 | 20.7 |
| 5000–5399 | `python__statements` | 88 | 266 | 134 | 0 | 20.5 |
| 1–200 | `json__basic` | 88 | 132 | 68 | 0 | 20.2 |
| 1000–1199 | `python__strings` | 60 | 133 | 67 | 0 | 20.7 |
| 3000–3199 | `python__collections` | 88 | 136 | 64 | 0 | 20.2 |
| 2000–2199 | `json__nested` | 88 | 128 | 72 | 0 | 19.3 |

**1800 seeds, 0 divergences** (1182 agreed output, 618 agreed
refuse, 34%). About **20.5 seeds/s** (two process spawns per
seed). A one-minute CI slot is ~1200 seeds; five minutes ~6000.

### Mutation tests

A fuzzer that has never caught anything and a fuzzer that cannot
catch anything print the same summary. Each row is one bug planted
in **one** runtime, the standard 1000-seed campaign (or the first
tree, if that was enough), then a revert. Nothing planted was
committed.

| Mutation | Surface | Detected? | Seed / seeds needed | Kind |
| --- | --- | --- | --- | --- |
| JS `EQ`: `a === b + 1` | comparison | yes | 36 / 36 | output |
| JS `ARG` reads `args[i+1]` | operand table | yes | 2 / 2 | output |
| JS `ADD`: `a + b + 1` | arithmetic | yes | 5079 / 680 | refuse-mismatch |
| Rust verify: jump target `t <= 0` | load-time verifier | yes | 1 / 1 | refuse-mismatch |
| JS `widthOf = s.length` | printer width | **no**, then yes | missed 2000+ (incl. astral trees); after probe: **25 / 25** | output |
| JS `HALT` skips leftover-child refuse | runtime validity | **no**, then yes | missed the 1000; after probe: **10 / 10** | refuse-mismatch |

EQ / ARG / ADD / verify-jump were measured on the drain-then-ASCII
generator. The two probes were added only after width and leftover
HALT survived; those after-numbers are against the new styles.

**Width.** This is the bug that really shipped in the reference
implementation (gate 1: UTF-16 `.length` vs scalar count). The
original generator emits ASCII `TEXT` and the campaign widths
(60 / 88) never sit on a one-column fit boundary. Swapping in
`json__basic` and `python__strings` — the trees that contain `🙂`
— still agreed, even at width 75.

The *real* packages on the frozen corpus, with `widthOf = s.length`
planted in JS and compared against rust, only diverge here:

| file | astral scalars | `.length` detectable at | 60? | 88? |
| --- | ---: | --- | --- | --- |
| `json__basic` | 6 | 324–329 | no | no |
| `python__strings` | 10 | 74–77 | no | no |
| every other corpus file | 0 | — | no | no |

**No corpus file detects a `.length` bug at either scored width.**
The 30 baselines are 60 and 88, so a submission can ship exactly
this bug and pass gate 1.

`python__strings` is `astral_call`: the flat form is 74 scalars /
78 UTF-16 units, so the argument-list group flips at 74–77. At 60
both already break; at 88 both already fit. The `astral = "🙂…"`
assignment is 74 / 80 but has no interior break, so it never
changes layout. `json__basic` only decides at the whole-object
group (324 scalars / 330 UTF-16); at 60 and 88 that group is
already broken.

A fuzzer that does not *construct* a group whose fit decision is
that one column is not a Unicode-width test. The scored corpus
has the same hole. A case that lands the boundary on 88 (or 60)
belongs in `corpus/contrib/`.

After adding `group(text(pad+🙂) + line + "z")` sized to `width`
(scalar columns = width → fits; UTF-16 = width+1 → breaks), seed
25 caught it: rust prints `…🙂 z`, js prints `…🙂\nz`.

**HALT leftover.** Drain-then-emit never reaches `finish()`'s
unconsumed-child check; compiled random kinds refuse on explicit
token / leaf-has-children errors instead. The agreed-refuse
statistic did **not** cover the structural-linearity check. A
`HALT` without `drain` catches a skipped leftover refuse at seed
10 (`unconsumed array in document` vs js exit 0).

`ADD + 1` needed 680 seeds (the whole scalars + misc ranges, then
80 of statements) because only compiled kind programs execute
`ADD`, and most random kinds refuse before they get there. Slow
is still a catch; it is a coverage note.

### What the fuzzer does not cover

It tests **interpreter agreement** on verifier-accepted streams.
It does not test compiler correctness, formatting policy, or
semantic preservation. In particular:

- `compile-package.js` bugs that both interpreters share
- hugging, quote style, black agreement, comment attach / steal
- whether an authored kind means what the language needs
- `HOST_CHAIN` / `HOST_FROM_IMPORT` (opaque to the stream)
- stack discipline on `CONCAT_DYN` / `BAG_FIELD` (height is
  data-dependent)
- pretty-printer decisions that both sides get wrong the same way

"0 divergences" means the two interpreters agree on these random
streams, and that a one-sided bug of the kinds in the table is
now visible. It does not mean the formatter is correct.

## Bytecode experiment — what is weak

- **Size still lost after sharing.** See the table. Unrolling was
  maybe half the Python gap; the rest is a general instruction
  stream versus named algorithms with short keys. The download
  wants the schema.
- **Two host ops remain.** `HOST_CHAIN` and `HOST_FROM_IMPORT` are
  still kind implementations, not compiled streams. Flattening a
  left-associative spine walks descendants by field; `from_import`'s
  paren/comma policy is a one-off. Both are fuzz-surface that the
  verifier cannot see into.
- **Stack typing is dynamic.** `CONCAT_DYN` / `BAG_FIELD` have
  data-dependent height, so the verifier does not prove stack
  discipline. Underflow is a refuse both interpreters share.

## What is weak (layout, unchanged from the schema build)

- **No method-spine flattening.** `query.filter(...).order_by(...)`
  breaks inside argument lists, not before `.`. Black does the
  latter at width 60. Meaning is preserved; overflow is worse.
- **No hugging.** A broken `seq` puts every item on its own line.
  Black will keep `first_operand, second_operand, third_operand, fourth`
  on one wrapped line. We explode. Same for a sole dict argument
  of `append`.
- **Quote style is untouched.** `string` is opaque. `strings.py`
  will not match black.
- **Comment blanks at file edges.** The leading module comment
  eats the following blank; the EOF comment does not keep two
  blanks above it. Comments themselves are not dropped.
- **Bitwise mixed-precedence** paren-inserts each class separately,
  so `|` may wrap an already-parenthesized `&`/`^` inner. Legal,
  not black.

## Bytecode experiment — conclusion

30/30 baselines byte-identical on both runtimes. Sharing was the
right size change (Python 4789 → 3049 gzip). A denser encoding of
the code array was **not** tried: the decomposition says it cannot
rescue the verdict.

### Size

`gzip -9` of the named file (filename stored in the header). Same
numbers as the table above; no encoding column, because none landed.

|                        | schema raw | schema gzip | unrolled raw | unrolled gzip | shared raw | shared gzip | Δ gzip shared |
| ---------------------- | ---------: | ----------: | -----------: | ------------: | ---------: | ----------: | ------------: |
| `runtime-js/bundle.js` |      26351 |        6747 |        29032 |          7361 |      31717 |        7689 |          +942 |
| `packages/python.json` |       7038 |        1376 |        20000 |          4789 |      10618 |        3049 |         +1673 |
| `packages/json.json`   |        436 |         215 |         1908 |           764 |       1644 |         742 |          +527 |

Python is 2.2× the schema (was 3.5× unrolled). JSON is 3.5×.

### Decomposition of the 3049

`packages/python.json` is not "a bytecode array with a small
header." Content-only gzip (`gzip.compress(..., 9)` /
`gzip -9 -c`, no filename) is **3037**. The published **3049** is
that plus the 12-byte `python.json\0` filename in the gzip header.
Deltas below are of the content; they do not change if you measure
the named-file form.

**Method: ablation**, with isolated gzip as a cross-check. For each
part, replace it with the empty JSON equivalent (`[]` / `{}` / `""`),
serialize compactly, gzip-9, and report `gzip(whole) − gzip(ablated)`.
Isolated is gzip of just those keys as their own object. Gzip does
not decompose additively — the columns are not a partition of 3037
and must not be added up. Re-run with `python3 tools/decompose-package.py`.

| Part | Isolated gzip | Ablation Δ gzip | Share of 3037 |
| --- | ---: | ---: | ---: |
| schema-shaped header (`opaque`, `steal_into_body`, `blank`, `comment_type`, …) | 199 | 54 | 2% |
| string constant pool (`consts`) | 415 | 322 | 11% |
| per-type maps (`entry` + `args` + `kinds` + `defaults`) | 1380 | 1258 | 41% |
| shared code array (`code`) | 1171 | 1205 | 40% |

The header fields that still look like the schema — `opaque`,
`steal_into_body`, `blank`, `comment_type` — are **2%**. They are
not the confound.

The confound is the three maps from CST node-type name → payload
(`entry` pc, `args` operand vector, `kinds` layout-kind string),
plus the const pool. Ablation:

| Map | Isolated gzip | Ablation Δ gzip |
| --- | ---: | ---: |
| `entry` | 570 | 319 |
| `args` | 642 | 455 |
| `kinds` | 566 | 346 |
| `defaults` | 63 | 16 |

`kinds` is not dead weight: the host still keys paren-insert on
the parent layout-kind (`wrap` / `seq` / `pfx`). `entry` and
`args` *are* the bytecode calling convention. Together the
per-type maps slightly **outweigh** the code array (1258 vs
1205). Node-type names are written three times; gzip of the 72
names once is already 450.

**Punchline.** Empty the code array, leave everything else:
**1832 gzip**. The entire schema Python package is **1364**
content-only (1376 named-file). The non-code remainder already
exceeds the schema by 468 bytes. Re-encoding the code section —
varint, base64, anything — cannot flip the comparison. The
package is mostly not bytecode, and the bytecode part was never
the problem.

JSON is the same shape, just smaller: code ablation 364 of 732
(~50%), remainder-without-code 368 vs schema 205. Still loses
with the code deleted.

### Break-even

The download breaks even when

`language count × per-package saving > incremental runtime cost`.

Both terms go the wrong way.

- Per-package *saving* is negative. Python **+1673** gzip, JSON
  **+527**. Mean about **−1100**. Adding a language makes the
  bytecode download *worse*, not better.
- Incremental runtime cost is positive: **+942** gzip for the VM
  against the schema walker.

`n × (negative) > positive` is false for every `n ≥ 0`. No
language count rescues it. The decomposition closes the obvious
objection — "but the code is JSON integers; pack them" — because
zeroing the code array still leaves a per-package loss (1832 vs
1364). The first term stays negative even under that fantasy.

A compact kind-level opcode (`SEQ open close sep flags`) would
probably draw or win on gzip, because it *is* the schema with
shorter keys. Expanding kinds into a general instruction stream
is the wrong direction for the download.

### What bytecode won

**Structural linearity.** The ISA cannot express taking a child
twice or walking children out of order: one cursor per frame,
`TAKE` / `SKIP` only advance, there is no rewind. `HALT` refuses
leftovers, so an unconsumed child cannot become output. Sharing
programs does not weaken this — we share at kind level, and every
`seq` (etc.) has the same child shape.

The load-time verifier proves opcodes, immediates, jump targets,
and that every path from an entry hits `HALT` or `REFUSE`.

These checks stay **dynamic** (the verifier does not prove them):

- a loop draining the cursor for every tree (the leftover-child
  refuse is at `HALT`, at runtime)
- input-dependent token checks (wrong keyword, missing bracket)
- JSON `trailing: "none"` refusing a trailing comma
- a leaf that arrived with children
- stack discipline on `CONCAT_DYN` / `BAG_FIELD` (height is
  data-dependent; underflow is a refuse both interpreters share)

Two host ops also stay outside the stream: `HOST_CHAIN` and
`HOST_FROM_IMPORT`. The verifier cannot see into them.

**The fuzzer.** `harness-of-your-own/fuzz.js`: 1800
verifier-accepted streams across seven trees, **0 divergences**,
~20.5 seeds/s. 1182 agreed on output; **618 agreed to refuse**
(34%). Mutation tests show that number is falsifiable: a
stricter rust jump check is a refuse-mismatch at seed 1, and
(after a leftover probe) a skipped `HALT` leftover refuse is a
refuse-mismatch at seed 10. Two independent runtimes voting the
same programs invalid is a property the 15-file corpus cannot
test at all. The fuzzer is why a bytecode IR is still worth
compiling in CI even though it must not ship. It is not a test
of the compiler, of formatting policy, or of semantic
preservation — and until the astral fit-probe, it could not see
the `.length` bug this project exists to catch.

### Ship recommendation

Ship the schema. Keep this VM, if at all, as a development-time
IR: compile the schema to bytecode in CI and keep running the
dual-interpreter fuzzer so refusal agreement stays a regression
net. Do not replace `packages/*.json` with the instruction
stream. The cost of that recommendation is carrying a compiler
and two interpreters that never go in the download — real
maintenance, paid for a property (cross-runtime refuse
agreement on random well-typed programs) the schema walker has
not given us another way to get. The cost of the other choice,
shipping the VM, is +942 gzip on the JS runtime and a
per-language tax that starts at +527 (JSON) and +1673 (Python)
and grows with every language; that cost is strictly larger at
every language count, and the decomposition says no encoding of
the code section changes it.
