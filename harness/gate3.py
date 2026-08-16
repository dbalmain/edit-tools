"""Gate 3, non-destruction: the output parses and means what the input meant.

Two layers, and the split is the whole point.

**Universal, every language, no opt-out.** The reparse must contain no `ERROR`
and no `MISSING` node, and the sequence of *extra* nodes -- which is where every
grammar we checked puts comments -- must be unchanged. Comments sit outside the
structural comparison because a formatter is allowed to move a comment to a
different parent; losing or duplicating one is real destruction. The old JSON
checker compared `json.loads` output, which cannot see a comment at all, so
dropping every comment in a JSON file passed gate 3. That hole is closed here.

**Structural, per language.** Either the generic default below, or an override
the language's manifest names. An override is a file of its own so a builder
never edits a shared one. `check_gate3.py` requires its accepted equivalence
class to be a subset of the default's: an override may reject more, never less.

At a manifest-declared injection site, the host signature masks the opaque
content node and records a recursive signature from the guest manifest and
parser. The host's extras walk stops at that boundary, so comments are checked
by the grammar that owns them. An unknown, unlabelled, or unparseable region is
recorded as exact bytes: that is the conservative match for the verbatim path.

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

With both declared, the generic default accepts black on 26/26 python runs.
Python's former `ast.dump` override agreed on all of those correct outputs, but
the adversarial arm in `check_gate3.py` then proved it weaker on quote and number
respellings. The generic default is selected; agreement on correct input was not
evidence of override strength.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

LANG_DIR = Path(__file__).resolve().parent / "languages"
sys.path.insert(0, str(LANG_DIR.parent))
import injection  # noqa: E402
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


def _extras(
    node,
    source: bytes,
    manifest,
    aliases: dict[str, _mf.Manifest],
    out: list[str],
) -> list[str]:
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
    region = injection.region_for(node, source, manifest, aliases)
    for child in node.children:
        if child.is_extra:
            if child.is_named:
                out.append(source[child.start_byte:child.end_byte].decode().strip())
        elif region is not None and child == region.content:
            # A routed guest contributes its own extras through its recursive
            # signature. An unroutable region is protected byte-for-byte.
            continue
        else:
            _extras(child, source, manifest, aliases, out)
    return out


# --------------------------------------------------------------------------
# the generic structural default


def _tokens(node, source: bytes) -> str | tuple[str, ...]:
    """The spelling of a node that has no named children, with the whitespace
    *between* its tokens dropped.

    A true leaf -- no children at all -- is its own text, and that text is
    significant down to the byte: a formatter may not respell `1_000` as `1000`
    or `"x"` as `'x'`.

    A node whose children are all anonymous is different. `parameter_list` in an
    empty Go signature holds `(` and `)` and nothing else, so its source span is
    `( )` or `()` depending only on how the author spaced it -- and the space
    between two punctuation tokens is layout, which is the formatter's to
    decide. Comparing the raw span rejected gofmt's own output, and the same
    rejection reproduces on `{ }` in JSON, `[ ]` in TOML, and `( )`, `[ ]`,
    `def f( )` in Python. Every language, latent since the default was written,
    and found only because Go's stage-A corpus was the first to write an empty
    container with a space in it.

    Dropping the gap is safe because gate 3 **reparses** the output. Whitespace
    that carries meaning is whitespace that separates tokens, and deleting it
    merges them: `not in` -> `notin` reparses as one identifier and the tree
    differs. So the token boundary is protected by the reparse, and pinning the
    span on top of it buys no strictness -- only a false rejection of correct
    layout.
    """
    if not node.children:
        return source[node.start_byte:node.end_byte].decode()
    return tuple(
        source[c.start_byte:c.end_byte].decode() for c in node.children
    )


def _generic(
    node,
    source: bytes,
    manifest,
    aliases: dict[str, _mf.Manifest],
    wrappers: frozenset[str],
    canon: dict[str, str],
):
    while node.type in wrappers:
        inner = [c for c in node.children if c.is_named and not c.is_extra]
        if len(inner) != 1:
            break
        node = inner[0]
    kind = canon.get(node.type, node.type)
    kids = [c for c in node.children if c.is_named and not c.is_extra]
    if not kids:
        return (kind, _tokens(node, source))
    region = injection.region_for(node, source, manifest, aliases)
    return (
        kind,
        tuple(
            ("injection_region", "")
            if region is not None and child == region.content
            else _generic(child, source, manifest, aliases, wrappers, canon)
            for child in kids
        ),
    )


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


def _region_signatures(
    node,
    source: bytes,
    manifest,
    aliases: dict[str, _mf.Manifest],
    parsers: dict,
    out: list[tuple],
) -> tuple:
    region = injection.region_for(node, source, manifest, aliases)
    for child in node.children:
        if region is not None and child == region.content:
            root = injection.parse(region, parsers)
            if root is None:
                out.append(("verbatim", region.source))
            else:
                guest = region.guest
                assert guest is not None
                guest_text = region.source.decode("utf-8")
                guest_signature = _signature_from_root(
                    guest_text,
                    root,
                    region.source,
                    guest,
                    aliases,
                    parsers,
                )
                if guest_signature is None:
                    out.append(("verbatim", region.source))
                else:
                    out.append(
                        (
                            "parsed",
                            guest.name,
                            guest_signature,
                        )
                    )
        else:
            _region_signatures(child, source, manifest, aliases, parsers, out)
    return tuple(out)


def _signature_from_root(
    text: str,
    root,
    source: bytes,
    manifest,
    aliases: dict[str, _mf.Manifest],
    parsers: dict,
    *,
    generic: bool = False,
) -> tuple | None:
    extras = tuple(_extras(root, source, manifest, aliases, []))

    if generic or manifest.gate3 == "default":
        structural = _generic(
            root,
            source,
            manifest,
            aliases,
            manifest.transparent_wrappers,
            _canon_map(manifest),
        )
    else:
        structural = _override(manifest.gate3).signature(text)
        if structural is None:
            return None
    regions = _region_signatures(root, source, manifest, aliases, parsers, [])
    return (manifest.name, structural, extras, regions)


def signature(
    text: str,
    manifest,
    parser,
    manifests: dict[str, _mf.Manifest] | None = None,
    parsers: dict | None = None,
) -> tuple | None:
    """A recursive meaning-preserving signature, or None if `text` does not parse.

    `manifests` and `parsers` enable manifest-routed embedded regions. Comparing
    two signatures for equality *is* gate 3.
    """
    root, source = _reparse(text, parser)
    if root is None:
        return None
    manifests = manifests or {manifest.name: manifest}
    parsers = {**(parsers or {}), manifest.name: parser}
    aliases = _mf.injection_map(manifests)
    return _signature_from_root(text, root, source, manifest, aliases, parsers)


def generic_signature(
    text: str,
    manifest,
    parser,
    manifests: dict[str, _mf.Manifest] | None = None,
    parsers: dict | None = None,
) -> tuple | None:
    """The generic default, regardless of what the manifest selects.

    Used by `check_gate3.py` to hold the default honest against the languages
    that have a stronger checker to compare it with.
    """
    root, source = _reparse(text, parser)
    if root is None:
        return None
    manifests = manifests or {manifest.name: manifest}
    parsers = {**(parsers or {}), manifest.name: parser}
    aliases = _mf.injection_map(manifests)
    return _signature_from_root(
        text,
        root,
        source,
        manifest,
        aliases,
        parsers,
        generic=True,
    )


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
    if before[3] != after[3]:
        return _describe_regions(before[3], after[3])
    if manifest.gate3 != "default":
        mod = _override(manifest.gate3)
        if hasattr(mod, "describe"):
            return mod.describe(before[1], after[1])
        return "parse tree differs"
    return _describe_generic(before[1], after[1])


def _describe_regions(before: tuple, after: tuple) -> str:
    if len(before) != len(after):
        return f"{len(before)} embedded regions became {len(after)}"
    for i, (old, new) in enumerate(zip(before, after), 1):
        if old == new:
            continue
        if old[0] != new[0]:
            return f"embedded region {i}: {old[0]} content became {new[0]} content"
        if old[0] == "parsed":
            if old[1] != new[1]:
                return f"embedded region {i}: language {old[1]!r} became {new[1]!r}"
            return f"embedded region {i} ({old[1]}): meaning or comments differ"
        return f"embedded region {i}: verbatim bytes differ"
    return "embedded regions differ"


def _is_spelling(value) -> bool:
    """`_tokens` returns a str or a tuple of str; a node's children are a tuple
    of `(kind, ...)` pairs. Both are tuples, so the elements decide."""
    if isinstance(value, str):
        return True
    return isinstance(value, tuple) and all(isinstance(v, str) for v in value)


def _describe_generic(a, b, path: str = "root") -> str:
    if a == b:
        return "identical"
    if isinstance(a, tuple) and isinstance(b, tuple) and len(a) == 2 == len(b):
        if a[0] != b[0]:
            return f"{path}: node kind {a[0]!r} became {b[0]!r}"
        ca, cb = a[1], b[1]
        if _is_spelling(ca) or _is_spelling(cb):
            return f"{path}/{a[0]}: leaf text {ca!r:.60} became {cb!r:.60}"
        if len(ca) != len(cb):
            return (f"{path}/{a[0]}: {len(ca)} named children became {len(cb)}"
                    f" ({[c[0] for c in ca][:6]} vs {[c[0] for c in cb][:6]})")
        for i, (x, y) in enumerate(zip(ca, cb)):
            if x != y:
                return _describe_generic(x, y, f"{path}/{a[0]}[{i}]")
    return f"{path}: tree differs"
