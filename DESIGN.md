# Layout kinds

A language package is a JSON object. It maps each CST node type to a
**layout kind** — a named algorithm the runtime already knows how to
run — plus the parameters that algorithm needs (brackets, separators,
whether a trailing comma is sticky). The package does not describe Doc
trees, match queries, or bytecode.

This is the inverted form of a node-schema template language. Templates
would have the package describe a Doc shape and the runtime render it.
Here the package *names an algorithm*; the runtime *is* those
algorithms. Magic trailing commas, comment attachment, flattening a
left-associative operator spine, and blank-line policy are algorithms.
Writing each once, in two languages, is cheaper than asking every
package to re-express them.

A `template` kind exists as an escape hatch for one-off nodes. JSON
does not use it.

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

Authored readable, shipped as this JSON. No compiler.

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

1. Write `packages/<lang>.json`.
2. Mark string-like nodes `opaque`.
3. For each interior type, pick a kind and fill in brackets.
4. If the tree has comments, set `comment_type` and, if the grammar
   leaves comments as siblings of `block` (tree-sitter-python), list
   those parents in `steal_into_body`.
5. Run both `fmt-rust` and `fmt-js` on a tree at two widths. They
   must agree byte-for-byte; a mismatch is a runtime bug, not a
   package bug.

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

- **Linearity is now a hard runtime check**, not an implicit
  property of careful kinds. Codex's invariant was made universal
  after Phase 1. Each kind uses an ordered child cursor and refuses
  if anything remains or if a required token is missing.
- **`trailing: "none"` refuses a trailing comma** rather than
  silently dropping it. Dropping it would be a token mutation that
  is not one of the two sanctioned policies (and would be invalid
  JSON if we also *added* one).
- Implementation is kinds-first as proposed; `template` is in the
  runtime for the hatch described above but is unused by JSON.

Python support, when added, is a package plus the remaining kinds
already listed — not a change to this document's shape.
