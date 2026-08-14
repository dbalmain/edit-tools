# Proposal 1: Linear layout schemas

## Summary

Ship a symbolic JSON program that describes how each concrete-syntax node is
partitioned into a small number of layout families: sequence, delimited list,
operator chain, and statement suite. The program may insert Doc structure and
whitespace, but it consumes syntax children linearly. Every input token is
therefore emitted exactly once and in source order unless the package explicitly
declares that token as a mutable trailing delimiter. Comments are likewise kept
at their original token boundary rather than being moved onto an arbitrary AST
node.

I call this a **linear layout schema**. It is closest to design B, but the
linearity check and boundary-anchored comments are the important differences.
It also has a small, declarative escape hatch: an ordered local case can inspect
the current node, its direct children, its parent kind and field, but it cannot
execute loops or arbitrary code. Repetition is available only through the
built-in list and chain schemas.

This takes Topiary's best property—rules describe local CST structure—without
accepting its flat atom output. Topiary serialises query results to atoms and its
input softlines reproduce breaks from the input; that cannot measure a whole
candidate layout against a new width ([pipeline](https://topiary.tweag.io/book/reference/formatting-pipeline.html),
[vertical spacing](https://topiary.tweag.io/book/reference/capture-names/vertical-spacing.html)).
Here, each schema builds a nested Doc. The renderer can therefore make the same
fit-or-break decision as Wadler's printer ([Wadler 2003](https://homepages.inf.ed.ac.uk/wadler/papers/prettier/prettier.pdf))
and Prettier's documented IR ([technical details](https://prettier.io/docs/technical-details)).

## The package format

The shipped artifact is UTF-8 JSON. JSON is already available in JS, is easy to
load in Rust, compresses repeated node and constructor names well, and remains
inspectable after download. It has:

- a format version and required-runtime feature list;
- language constants such as indentation and final-newline policy;
- named node classes and reusable predicates;
- ordered rules keyed by CST node type; and
- comment, blank-line and mutable-token policies.

Selectors are deliberately weak. They can select a direct child by field, kind,
text or ordinal; recognize a delimited or punctuated direct-child sequence;
count items; test for a final separator; and inspect the immediate parent kind
and field. They cannot search arbitrary descendants. A rule recursively prints
a selected child, prints an input leaf, or invokes one of four schemas:

1. `sequence`: fixed children with fixed or breakable gaps;
2. `delimited`: opener, punctuated items, closer and an optional trailing token;
3. `chain`: alternating operands and operators; and
4. `suite`: a header followed by an indented statement list.

Rule structure and branch consistency are validated when the package loads. At
format time, selected syntax children must form a disjoint, ordered partition
of each matched node's direct children. `delimited` and `chain` do that
partitioning themselves. Unconsumed, duplicated or reordered tokens make the
runtime refuse the file. A rule can declare a subtree `verbatim`, but only then
is the subtree collapsed; its leaf texts are concatenated in order and still
checked against the input token stream. An uncovered interior node is an error,
not an invitation to guess.

The only operation allowed to change the token sequence is a package-declared
`mutableTrailing` policy. Python permits this only in grammar contexts where a
trailing comma is semantically optional; JSON declares no mutable token. A
single-element tuple and a subscript are deliberately excluded. This is a safe
subset of the scorer's broader normalisation and makes non-destruction
substantially easier to audit.

### Concrete package fragment

Every symbolic operation is a JSON array whose first item is its opcode.
`["field", "function"]`, `["token", ":"]` and
`["kinds", "pair", "dictionary_splat"]` are selectors;
`["child", selector]` recursively formats the one selected child. A `shape` is
an ordered list of selectors, except for the dedicated `delimited` recognizer.
The following is package data, with whitespace retained for explanation. The
shipped file may be minified. `children` in a `delimited` schema means direct
non-comment children between the named delimiters, split on the separator.
Comments do not disappear; the boundary-comment pass described below supplies
them to the same schema.

```json
{
  "format": "et-linear-layout/1",
  "language": "python",
  "requires": ["line-suffix", "verbatim"],
  "style": { "indent": 4, "finalNewline": true },
  "mutableTrailing": [
    {
      "nodes": ["argument_list", "parameters", "list", "dictionary", "set"],
      "text": ",",
      "before": [")", "]", "}"]
    }
  ],
  "rules": {
    "call": [
      {
        "shape": [["field", "function"], ["field", "arguments"]],
        "layout": [
          "sequence",
          ["child", ["field", "function"]],
          ["child", ["field", "arguments"]]
        ]
      }
    ],
    "argument_list": [
      {
        "shape": ["delimited", "(", ")", ","],
        "layout": [
          "delimited",
          {
            "open": "(",
            "close": ")",
            "separator": ",",
            "items": "children",
            "group": "arguments",
            "edge": "softline",
            "between": "line",
            "indent": 1,
            "force": ["and", ["inputTrailing", ","], ["countAtLeast", 2]],
            "trailing": { "flat": "omit", "broken": "ensure" },
            "comments": "boundary"
          }
        ]
      }
    ],
    "dictionary": [
      {
        "shape": ["delimited", "{", "}", ","],
        "layout": [
          "delimited",
          {
            "open": "{",
            "close": "}",
            "separator": ",",
            "items": ["kinds", "pair", "dictionary_splat"],
            "group": "dictionary",
            "edge": "softline",
            "between": "line",
            "indent": 1,
            "force": ["and", ["inputTrailing", ","], ["countAtLeast", 2]],
            "trailing": { "flat": "omit", "broken": "ensure" },
            "comments": "boundary"
          }
        ]
      }
    ],
    "pair": [
      {
        "shape": [
          ["field", "key"],
          ["token", ":"],
          ["field", "value"]
        ],
        "layout": [
          "sequence",
          ["child", ["field", "key"]],
          ["token", ":"],
          ["text", " "],
          ["child", ["field", "value"]]
        ]
      }
    ]
  },
  "comments": {
    "kinds": [{ "node": "comment", "linePrefix": "#" }],
    "endOfLine": ["lineSuffix", ["text", "  "], ["commentText"]],
    "ownLine": [["hardline"], ["commentText"], ["hardline"]],
    "insideDelimited": { "forceGroup": true }
  }
}
```

`argument_list` formats this real construct from
`corpus/src/python/calls.py` at width 60:

```python
value = compute_the_weighted_average(
    first_operand,
    second_operand,
    third_operand,
    fourth,
)
```

The schema emits the input `(` and `)`, recursively formats each item, puts
`text(",") + line` between items, and wraps the interior in one indent and the
whole result in one group. `broken: ensure` inserts a virtual final comma only
in the broken branch. That insertion is legal because the package manifest and
the scorer both declare this exact token position mutable.

The dictionary rule also handles the magic trailing comma in the real `config`
literal from `corpus/src/python/comments.py`:

```python
config = {
    # comment before the first key
    "host": "localhost",
    "port": 8080,  # trailing on a pair
}
```

When finding the final syntax item, `inputTrailing` ignores boundary comments.
It therefore sees the comma after `8080` even though a comment lies between that
comma and `}`. Because there are two items, the existing trailing comma forces
the `dictionary` group to break at every width. This is Black's magic-comma
rule: an input trailing comma requests one-item-per-line layout even when the
literal would otherwise fit ([Black style](https://black.readthedocs.io/en/stable/the_black_code_style/current_style.html#the-magic-trailing-comma)).
The `countAtLeast` guard prevents the syntactically necessary comma in
`(lonely,)` from exploding a single-element tuple. The tuple rule, not shown,
uses `flat: preserve` when its item count is one; tuple and subscript commas are
absent from `mutableTrailing`, so the runtime cannot erase their meaning.

The fragment is not intended to imply one rule body per node type. The corpus
actually contains 77 Python interior-node kinds, despite the design document's
“roughly 15 node types” description. Aliases let `argument_list`, `parameters`,
list, set, tuple and imports share one delimited body while retaining different
trailing-token policies. I expect roughly 20–30 distinct layout bodies.

## The Doc IR

The runtime IR is:

| Constructor | Meaning |
| --- | --- |
| `nil` | Empty document. |
| `text(s)` | Literal text containing no line break. |
| `concat(ds)` | Ordered concatenation. JSON arrays are shorthand for this. |
| `group(d, force)` | Flatten if it fits, unless forced; otherwise break. |
| `indent(d)` | Add one package-defined indent after breaks in `d`. |
| `line` | Space when flat, newline when broken. |
| `softline` | Empty when flat, newline when broken. |
| `hardline` | Always newline and statically forces enclosing groups. |
| `ifBreak(broken, flat)` | Choose by the lexically enclosing group. |
| `lineSuffix(d)` | Buffer `d` until just before the next newline. |
| `verbatim(s)` | Emit opaque source text exactly, including internal newlines. |

This is the design document's minimum set plus `nil`, `lineSuffix`, and
`verbatim`. `nil` is merely convenient. `lineSuffix` is load-bearing for
trailing comments; Prettier documents it for exactly that purpose
([Doc commands](https://raw.githubusercontent.com/prettier/prettier/main/commands.md)).
`verbatim` is required because the corpus's triple-quoted string contains
newlines inside a `string_content` leaf. Treating that as ordinary `text` makes
fit measurement and indentation wrong.

`verbatim` containing a newline forces every enclosing group and updates the
column to the number of Unicode scalar values after its last newline. Ordinary
width is also defined in Unicode scalar values: Rust `char` and JS code-point
iteration agree, unlike Rust `chars().count()` versus JS `string.length` for
astral characters. This is deterministic but not full terminal display width;
that limitation is explicit below.

`lineSuffix` accepts only concatenations of text in version 1. An `ifBreak`
branch may not contain a `hardline` or multiline `verbatim`. These restrictions
remove two subtle sources of break-propagation disagreement. A hardline has the
effect of Prettier's hardline plus `breakParent`, so a separate `breakParent`
constructor is unnecessary.

There is no `fill`: Black-style comma lists and operator chains use
all-or-nothing groups, not paragraph filling. There is no `conditionalGroup`:
Prettier describes it as a last resort with exponential behavior when nested.
There is also no general optimal-choice operator. *A Pretty Expressive Printer*
offers strictly greater expressiveness and a configurable, provably optimal
objective, but that buys machinery this corpus and size target do not justify
([paper](https://arxiv.org/abs/2310.01530)). Incidentally, the design document
mislabels it as POPL 2023; it appeared in OOPSLA2 2023
([publication record](https://2023.splashcon.org/details/splash-2023-oopsla/71/A-Pretty-Expressive-Printer)).

The renderer is the bounded lookahead Wadler/Oppen family, with an explicit
stack in both languages. Oppen's original algorithm is linear with a buffer
bounded by line width ([Oppen 1980](https://doi.org/10.1145/357114.357115));
the smaller Wadler-style fit loop in the reference is sufficient here provided
the implementation caches `willBreak` and never recursively flattens a Doc.

## Runtime/package split

The JS and Rust runtimes contain only mechanisms that have identical meaning
for every language:

- package parsing, version checks and linearity validation;
- direct-child selectors and the four schema evaluators;
- the boundary-comment classifier and anchor representation;
- Doc construction and rendering; and
- token-accounting checks and actionable refusal diagnostics.

The runtime contains no switch on `python`, `json`, or a language node name.
Indent width is package data. So are punctuation, spacing, precedence families,
which nodes form suites, which trailing tokens are mutable, when a magic token
forces a group, comment spelling, and top-level blank-line policy.

The package pins the CST schema it expects, ideally with a grammar name and
node-types hash. Although parsing is excluded here, a downloadable formatter
package that silently accepts a different tree-sitter grammar revision is not
safe. The runtime refuses an unknown schema fingerprint.

The package is interpreted directly. A friendly YAML or DSL could later
compile to this JSON, but that compiler is authoring tooling and is neither
downloaded nor trusted at formatting time. dprint demonstrates downloadable
formatter plugins, but its plugins are Wasm or processes containing code rather
than shared data interpreted by two runtimes ([dprint plugin development](https://dprint.dev/plugin-dev));
putting language branches into the runtime would collapse this proposal back
into that model.

## Size estimate

The checked-in reference bundle is 4.3 KB raw and 1.35 KB under `gzip -9`; it
contains both the basic Doc renderer and hardcoded JSON rules. That gives a
more useful baseline than line counting.

| Component | Estimated gzip | Basis |
| --- | ---: | --- |
| Doc renderer with `ifBreak`, suffixes and verbatim | 2.0–2.5 KB | Reference printer plus three bounded cases and code-point counting. |
| Schema evaluator, selectors and token accounting | 2.3–3.0 KB | Four small evaluators over JSON arrays; no query parser or VM. |
| Comment anchors, validation and diagnostics | 1.0–1.5 KB | One ordered tree pass and compact error paths. |
| JS runtime total | **5.3–7.0 KB** | Leaves 3 KB of the 10 KB target as risk margin. |
| Python package | **8–11 KB** | About 45–65 KB symbolic JSON before gzip; repeated node names and schema keys compress strongly. |
| JSON package | **0.7–1.2 KB** | Five interior kinds and no comments or trailing-token mutation. |

The scorer gzips all files under `packages/` together, despite the prose listing
separate Python and JSON limits. Expected measured package size is therefore
roughly 9–12 KB, and expected runtime plus packages is 14–19 KB. Both the 10 KB
runtime target and the effective 17 KB package target have margin. These remain
estimates: the proposed risk spike must gzip the real Python table before the
design is funded fully.

Rust executable and dependency sizes are not scored. Rust should still use an
idiomatic enum for Docs and typed deserialization for packages rather than
transliterating JS objects; differential fixtures keep the semantics aligned.

## Comment attachment

Comments are not attached by mutating an AST node. Each comment is attached to
the **token boundary** where the CST placed it: the ordinal of the preceding
non-comment leaf, the ordinal of the following non-comment leaf, and their
lowest common ancestor. A run of comments at one boundary retains its input
order. The package then classifies each as:

- end-of-line: render as a two-space `lineSuffix`, followed by a forced break;
- own-line: render as opaque comment text between hardlines at the enclosing
  suite or delimited-list indentation; or
- inline/block: unsupported by Python v1, but reserved in the format.

This anchor cannot cross either neighboring syntax token. A bad comment policy
can choose ugly whitespace, but it cannot silently move `# type: ignore` across
code or change the non-whitespace token order. The package may use the anchor's
preceding/following token kinds, enclosing node, parent field and whether the
boundary is inside delimiters. It may not inspect the comment's prose.
When a boundary contains comments, its comment layout replaces the ordinary
gap Doc from `sequence`, `delimited`, `chain` or `suite`; it is not appended to
that gap. This prevents doubled spaces and hardlines.

For `comments.py`, this gives the intended cases directly: the module comment
has a start boundary; the import and statement comments are end-of-line; the
comment before `return` is an own-line boundary in a suite; `# first` and
`# second` are end-of-line boundaries after commas; the next list comment is
own-line; the first dictionary comment is a dangling boundary after `{`; and
the final block and file comments are own-line end boundaries. A hardline from
any comment forces the containing delimiter group to break. Comment text is
always `verbatim` and is never wrapped.

Correctly deciding “end-of-line” requires the original source, as Prettier's
own attachment API explicitly does: it distinguishes own-line and end-of-line
comments from surrounding source text and passes that text to language hooks
([Prettier plugin comments](https://prettier.io/docs/plugins#handling-comments-in-a-printer)).
The competition tree stores byte offsets but not row/column or intervening
whitespace. `source_file` makes the source available on the first invocation,
so the CLI reads it and the library API accepts source text alongside the tree.

There is a scorer defect here: `as_tree_doc` removes `source_file` during the
idempotence invocation. Offsets alone cannot distinguish `x  # comment` from
some equal-length combination of newline and indentation. For the fixed scorer,
source-less mode accepts only this formatter's canonical, prefix-free comment
gaps: two spaces means end-of-line; own-line gaps are one newline at column zero,
three newlines where two top-level blank lines are required, or one newline plus
four-space indentation. Structural context resolves start/end boundaries. This
is enough to recognize the runtime's own output, but it is not presented as a
general solution. The real interface must receive source bytes, or the tree
format must retain points or whitespace slices.

Blank lines use canonical structural rules rather than input preservation:
two between top-level definitions, one around the relevant top-level comment
groups, none at the start/end beyond the final newline, and none gratuitously
inside suites. That makes the first result a fixed point without relying on
source provenance.

## What this design cannot do

First, the scorer's “non-destruction” gate is token identity, not semantic
non-destruction. It permits only trailing-comma changes. Black legitimately
adds parentheses to create implicit-continuation regions, removes redundant
parentheses, and normalizes string spelling. A gate-passing formatter therefore
cannot match Black or reflow when those operations are necessary.

The scorer's statement that every comma immediately before a closer “carries
no meaning” is also false for Python: the comma in `(lonely,)` creates the tuple,
and a trailing comma in a subscript can create a tuple key. Its normalizer would
miss either semantic change. The package's context-specific mutable-token list
is intentionally stricter than the gate.

Concrete consequences:

- `python__operators.tree.json` has long unparenthesized arithmetic, boolean and
  comparison expressions. Breaking them requires parentheses or backslashes,
  either of which changes the token stream.
- `python__statements.tree.json` has long `if`, `elif` and `while` headers with
  the same problem.
- `python__chains.tree.json` has unparenthesized attribute and method chains;
  a legal break before `.` needs a continuation context.
- `python__imports.tree.json` has long unparenthesized `from` imports; Black
  adds parentheses, which gate 3 forbids.
- `python__misc.tree.json` asks Black to remove redundant parentheses and has
  long unparenthesized lambda/operator expressions.
- `python__strings.tree.json` contains a single-quoted string. Preserving leaf
  token text conflicts with Black's default quote normalization.

The proposal chooses the disqualifying gate over Black agreement and accepts
avoidable-looking overflows in these files. The harness should not interpret
those misses as evidence that the Doc model cannot reflow: its token gate has
forbidden the syntax needed to make the reflow legal. This also puts a hard
ceiling below 100% on measure 6.

Second, linear local schemas cannot express layout alternatives whose regions
cross CST subtrees, column alignment across sibling statements, a global cost
function, or “try these three aesthetically different shapes.” `conditionalGroup`
and PrettyExpressive-style choice are intentionally absent. `python__comprehensions.tree.json`
and the nested mixtures in `python__kitchen.tree.json` are the hardest remaining
tests of the local schema model; their regions are nested, but the desired
decision sometimes depends on an ancestor's role.

Third, version 1 has no embedded-language boundary, no block-comment reflow, no
string splitting or quote normalization, no tabs, and no display-width table.
Unicode scalar count disagrees with terminal columns for combining marks, East
Asian wide characters and emoji sequences. Verbatim multiline strings can
overflow and are never reindented. Syntax errors are refused. Formatting
packages are coupled to a pinned CST schema.

Finally, boundary anchoring preserves comment order, not comment meaning.
Language-specific directives such as `# fmt: off`, pragmas and type-checker
comments need explicit package rules. Without source text, arbitrary comment
attachment is information-theoretically ambiguous; the scorer-only canonical
decoder recognizes only this formatter's output.

## Riskiest assumption and smallest decisive experiment

The riskiest assumption is that source-aware boundary comments plus local
linear schemas are expressive enough for real Python without growing an
imperative Python escape hatch. Comments are where local layouts interact with
group forcing, separators, suites, blank lines and idempotence all at once.

The smallest decisive experiment is a JS-only vertical slice for
`python__comments.tree.json`, plus five tiny variants: one-space and two-space
trailing comments, a comment before a closer with no final item, consecutive
own-line comments, and an EOF suite comment. Implement only `sequence`,
`delimited`, `suite`, comment anchors and the Doc renderer. Format at 88 and 60,
reparse through the harness, delete `source_file` exactly as `as_tree_doc` does,
and format again. Require byte idempotence, unchanged comment-token order, and
no Python-kind branch in the runtime. Gzip the slice as well.

If the source-less second pass cannot recognize the canonical comment gaps, or
if expressing these cases requires arbitrary descendant queries or a handwritten
Python callback, the design's central simplification is false and the proposal
should be withdrawn. If it passes, add `comprehensions.py` and `kitchen.py` next
to test contextual grouping; only then is a Rust port worth funding.
