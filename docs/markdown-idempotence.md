# Markdown idempotence residual, 2026-09-10

This is the classification after carrying injection layout policy to the
browser and routing Markdown's top-level section separator through `blank`.
The sweep formats through `ts_doc.mjs`, `ts_inject.mjs`, and the JavaScript
runtime at width 80. It formats each input twice and records a difference
between those two outputs; it is not a comparison with Prettier.

The first post-fix run found nine paths. Four were two API documents vendored
in two repositories; their shared JSON package bug was then fixed. The final
run found five paths, representing four documents because the Mailhog README is
byte-identical in two repositories.

| Cause | Affected documents | Class | Second-pass drift | Disposition |
| --- | --- | --- | ---: | --- |
| Comment-only JSON container | OAuth/OIDC object-shape document; managed-object schema document, each vendored twice | Package bug | -30 bytes; -22 bytes | Fixed and covered in the JSON corpus |
| Whitespace-only continuation after a nested fence | Mailhog README, vendored twice | Design limit | -1 byte | Documented; no spelling-specific rule |
| YAML fence ending in `---` | `kb/SCHEMA.md`; `lab/plan.md`; `compaction.md` | Design limit | +1; +2; +1 bytes | Documented; no cross-package break capability added |

## Comment-only JSON containers — fixed

Minimal Markdown input, 29 bytes:

````markdown
```json
{"x": {
/*c*/
}}
```
````

Its lengths are 29 bytes in the source, 34 after pass one, and 32 after pass
two; pass three remains 32. On the first pass the comment is the only named
content of the inner object. The runtime's comment attachment leaves it
dangling, while the JSON empty-object rule immediately prints `{}`. The result
places the comment before the empty object. Reparsing that output attaches the
comment at the parent level, where it becomes a suffix, removing one line and
its indentation.

This is a JSON package bug. `object` and `array` now declare that leading
comments descend into them, activating the runtime's existing comment-only
container path. Their empty rules include an empty `indent` seam: it prints
nothing for a genuinely empty container, but flushes a parked comment inside
the delimiters at the correct depth. `json_comment_containers.md` exercises
object and array forms through Markdown injection and `format()` in both
runtimes at both Markdown widths, and agrees with the reference.

## Whitespace after a nested fence — design limit

Minimal input, 35 bytes. The apparently empty line before the second item
contains one ASCII space.

````markdown
1. x

    ```
    y
    ```
 
1. z
````

The lengths are 35 bytes, then 34, then 33; later passes remain 33. Pass one
moves the blank line's space in front of the following `1. z`; pass two removes
that indentation. No content byte is lost, but one layout byte drifts.

tree-sitter-markdown makes the space a trailing `block_continuation` child of
the fenced block. The same node type and position carry meaningful quote and
list continuation prefixes, so the Markdown package cannot discard the child
by type. The closed DSL can test whether some path in the enclosing node has an
exact spelling, but it cannot select the current continuation by spelling and
consume arbitrary whitespace. Enumerating one-, two-, and three-space `drop`
branches would encode parser spellings rather than the language fact.

Ledger-style reason:

> Only hunk: one space from a whitespace-only line after a nested closing fence
> appears before the following ordered item on pass one, then is removed on
> pass two. tree-sitter-markdown reports that space as a trailing
> `block_continuation`, the same shape used for meaningful container prefixes;
> the package cannot distinguish the current child's spelling without a new
> general trivia/current-item capability. A list of exact whitespace spellings
> is not worth the package bytes.

## YAML `---` at a fence end — design limit

Minimal input, 25 bytes:

````markdown
```yaml
---
x: y
---
```
````

The lengths are 25 bytes, then 26, then 27; later passes remain 27. The second
pass therefore adds one blank line before the closing fence. `lab/plan.md` has
two instances and grows by two bytes; the other two documents have one each.

In YAML, the final `---` starts a second empty document; it is not an end
marker. The YAML document rule emits a hard break after that marker, and the
Markdown injected-fence branch emits its own hard break before the closer.
After pass one exposes a blank line inside the fence content, the YAML stream's
trailing `blank` preserves it up to its cap on pass two. The cap makes pass
three stable.

Neither package can ask whether the other package's already-built document
ends in a hard break. Removing either break globally regresses ordinary guests
or standalone YAML, and the Markdown corpus already records the same guest
closer seam for nested Markdown. A clean fix needs an explicit cross-package
trailing-break policy. That is a DSL/runtime design decision, so this slice
does not add an opcode or an equivalent hidden capability.

Ledger-style reason:

> Only hunk: a YAML fence whose body ends in `---` gains one blank before its
> closing delimiter on pass two, then settles. YAML parses the marker as a
> second empty document and emits its line ending; Markdown also emits the
> injected guest's closing break, and the reparse preserves the resulting
> trailing blank. Neither package can observe that the other package's document
> already ends in a hard break, so fixing this requires a cross-package
> trailing-break capability rather than a YAML-marker special case.
