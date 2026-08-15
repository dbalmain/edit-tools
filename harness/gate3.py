"""Gate 3, non-destruction: the output parses and means what the input meant.

Two layers, and the split is the whole point.

**Universal, every language, no opt-out.** The reparse must contain no `ERROR`
and no `MISSING` node, and the sequence of *extra* nodes -- which is where every
grammar we checked puts comments -- must be unchanged. Comments sit outside the
structural comparison because a formatter is allowed to move a comment to a
different parent; losing or duplicating one is real destruction. The old JSON
checker compared `json.loads` output, which cannot see a comment at all, so
dropping every comment in a JSON file passed gate 3. That hole is closed here.

**Structural, per language.** The generic default below, *and* -- if the
language's manifest names one -- a second checker of its own (`gate3 = "python"`
loads `harness/languages/python_gate3.py`). An override is a file of its own so
a builder never edits a shared one.

**An override adds a conjunct; it never replaces the default.** It used to
replace it, and that was wrong in the one direction that matters. `check_gate3.py`
compared the two only on committed reference output -- which both accept, because
the reference formatter is correct -- so it reported perfect agreement while an
override was strictly weaker than the gate it had displaced. Driven adversarially
(see that file's check 2b), `ast.dump` accepts `8080` becoming `8_080` and
`"POST"` becoming `\"\"\"POST\"\"\"`, and ordered `json.loads` accepts `3.14159`
becoming `3.141590`. Every one of those rewrites a token's text, which this
project's linearity invariant forbids outright -- python's reference is run with
`--skip-string-normalization` for exactly that reason.

That is not a flaw in `ast`; it is a flaw in "instead of". A data-model loader
answers "is this the same *data*", and a formatter gate asks "is this the same
*document*". Conjunction gets both: the generic default holds the document line,
the override adds what only a real parser for the language can know -- that the
output is valid by more than tree-sitter's reading, and that two spellings the
default would call different really are the same program. An override that turns
out to be weaker everywhere still costs nothing.

The consequence for a builder: if the generic default rejects your reference
formatter's own correct output, an override will not rescue you and is not meant
to. Declare `transparent_wrappers` / `equivalent_kinds` instead -- that is the
mechanism for relaxing the default, and it is declarative, per node kind, and
visible in review.

## Why the generic default is not just "the named-node tree must match"

Measured, not guessed. Black -- a correct formatter, and therefore the oracle --
**inserts parentheses when it wraps a long expression**, and the raw named-node
comparison rejects it on 7 of the 26 python corpus runs, every one of them a
`parenthesized_expression` appearing in the output that was not in the input.
This project's own contract sanctions the same move ("a balanced parenthesis pair
around one layout region when its group breaks"), so a gate that rejects it is
not strict, it is wrong.

The obvious repair -- "elide any node that is parentheses around a single child"
-- is unsound for a whole tier of the roster. In Scheme parentheses *are* the
structure: `(f)` is a list containing `f`, and eliding it would let a formatter
turn a call into a bare symbol and still pass. So paren transparency cannot be a
universal heuristic. It is declared per language, by node kind:

    transparent_wrappers = ["parenthesized_expression"]

Empty by default, which is the strict end. A language that declares nothing gets
a gate that will reject its own correct output the first time the formatter wraps
something -- loudly, at build time, with the node kind named. That is the right
failure direction: over-strict is a message, under-strict is corrupted source.

The same move sometimes *renames* a node rather than wrapping it: in Python,
parenthesising an assignment target turns `pattern_list` into `tuple_pattern`.
That is the last black case the wrapper rule does not cover, and it is declared
the same way:

    equivalent_kinds = [["pattern_list", "tuple_pattern"]]

With both declared, the generic default accepts black on 26/26 python runs and
agrees with `ast.dump` everywhere -- see `harness/check_gate3.py`, which pins
that agreement as a gate rather than a claim.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

LANG_DIR = Path(__file__).resolve().parent / "languages"
sys.path.insert(0, str(LANG_DIR.parent))
import manifest as _mf  # noqa: E402

_overrides: dict[str, Any] = {}


class Gate3Error(_mf.ManifestError):
    """Subclasses ManifestError: every way to reach it is a bad `gate3` field,
    and `manifest.cli` should report it as the one-line message it is."""


# --------------------------------------------------------------------------
# universal layer


def _reparse(text: str, parser):
    source = text.encode("utf-8")
    root = parser.parse(source).root_node
    stack = [root]
    while stack:
        n = stack.pop()
        if n.type == "ERROR" or n.is_missing:
            return None, source
        stack.extend(n.children)
    return root, source


def _extras(node, source: bytes, out: list[str]) -> list[str]:
    """Named extras, in document order.

    Verified on tree-sitter-python 0.25.0 and tree-sitter-json 0.24.8: `comment`
    is a named node with `is_extra` set in both. Whitespace extras are anonymous
    and never appear as nodes, so "named extras" is "comments" in practice --
    but it is stated in terms of `is_extra` so a grammar with another kind of
    extra is covered without anyone having to notice.

    Order is compared, not just the multiset. The multiset is what the workflow
    doc specified; the ordered sequence is strictly stronger, and black passes it
    on every corpus file at both widths, so there is no reason to accept the
    weaker one. A formatter that reorders two comments has moved a comment past
    the code it documents, which is destruction by any reading.
    """
    for child in node.children:
        if child.is_extra:
            if child.is_named:
                out.append(source[child.start_byte:child.end_byte].decode().strip())
        else:
            _extras(child, source, out)
    return out


# --------------------------------------------------------------------------
# the generic structural default


def _generic(node, source: bytes, wrappers: frozenset[str], canon: dict[str, str]):
    while node.type in wrappers:
        inner = [c for c in node.children if c.is_named and not c.is_extra]
        if len(inner) != 1:
            break
        node = inner[0]
    kind = canon.get(node.type, node.type)
    kids = [c for c in node.children if c.is_named and not c.is_extra]
    if not kids:
        return (kind, source[node.start_byte:node.end_byte].decode())
    return (kind, tuple(_generic(c, source, wrappers, canon) for c in kids))


def _canon_map(manifest) -> dict[str, str]:
    out: dict[str, str] = {}
    for group in manifest.equivalent_kinds:
        rep = min(group)
        for kind in group:
            out[kind] = rep
    return out


# --------------------------------------------------------------------------
# per-language overrides


def _override(name: str):
    if name in _overrides:
        return _overrides[name]
    path = LANG_DIR / f"{name}_gate3.py"
    if not path.is_file():
        raise Gate3Error(
            f'gate3 = "{name}" but there is no {path.relative_to(LANG_DIR.parent)}. '
            f'Use gate3 = "default", or add that file with a '
            f"`signature(text) -> object | None` function."
        )
    spec = importlib.util.spec_from_file_location(f"_gate3_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    if not hasattr(mod, "signature"):
        raise Gate3Error(f"{path.name}: must define `signature(text) -> object | None`")
    _overrides[name] = mod
    return mod


# --------------------------------------------------------------------------
# the gate


def signature(text: str, manifest, parser) -> tuple | None:
    """A meaning-preserving signature, or None if `text` does not parse.

    Comparing two of these for equality *is* gate 3.
    """
    root, source = _reparse(text, parser)
    if root is None:
        return None
    extras = tuple(_extras(root, source, []))
    structural = _generic(
        root, source, manifest.transparent_wrappers, _canon_map(manifest)
    )

    if manifest.gate3 != "default":
        extra = _override(manifest.gate3).signature(text)
        if extra is None:
            return None
        structural = (structural, extra)
    return (manifest.name, structural, extras)


def generic_signature(text: str, manifest, parser) -> tuple | None:
    """The generic default, regardless of what the manifest selects.

    Used by `check_gate3.py` to hold the default honest against the languages
    that have a stronger checker to compare it with.
    """
    root, source = _reparse(text, parser)
    if root is None:
        return None
    return (
        manifest.name,
        _generic(root, source, manifest.transparent_wrappers, _canon_map(manifest)),
        tuple(_extras(root, source, [])),
    )


def override_signature(text: str, manifest) -> object | None:
    """What the manifest's own checker says, without the generic conjunct.

    Only `check_gate3.py` wants this: it reports how much of the gate an override
    is actually carrying. Nothing scores against it -- `signature` is the gate.
    """
    if manifest.gate3 == "default":
        return None
    return _override(manifest.gate3).signature(text)


def describe(before: tuple | None, after: tuple | None, manifest) -> str:
    if after is None:
        return "output does not parse"
    if before is None:
        return "input does not parse"
    if before[2] != after[2]:
        lost = [c for c in before[2] if c not in after[2]]
        gained = [c for c in after[2] if c not in before[2]]
        if lost:
            return f"comments lost: {lost[:3]}"
        if gained:
            return f"comments invented: {gained[:3]}"
        return "comments reordered"
    if manifest.gate3 != "default":
        (gen_b, own_b), (gen_a, own_a) = before[1], after[1]
        if gen_b != gen_a:
            return _describe_generic(gen_b, gen_a)
        mod = _override(manifest.gate3)
        if hasattr(mod, "describe"):
            return mod.describe(own_b, own_a)
        return "parse tree differs"
    return _describe_generic(before[1], after[1])


def _describe_generic(a, b, path: str = "root") -> str:
    if a == b:
        return "identical"
    if isinstance(a, tuple) and isinstance(b, tuple) and len(a) == 2 == len(b):
        if a[0] != b[0]:
            return f"{path}: node kind {a[0]!r} became {b[0]!r}"
        ca, cb = a[1], b[1]
        if isinstance(ca, str) or isinstance(cb, str):
            return f"{path}/{a[0]}: leaf text {ca!r:.60} became {cb!r:.60}"
        if len(ca) != len(cb):
            return (f"{path}/{a[0]}: {len(ca)} named children became {len(cb)}"
                    f" ({[c[0] for c in ca][:6]} vs {[c[0] for c in cb][:6]})")
        for i, (x, y) in enumerate(zip(ca, cb)):
            if x != y:
                return _describe_generic(x, y, f"{path}/{a[0]}[{i}]")
    return f"{path}: tree differs"
