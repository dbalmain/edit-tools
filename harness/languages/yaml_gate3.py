"""YAML gate 3: the generic default plus keep-chomping line endings.

This is deliberately a conjunction, not a data-model replacement. The first
tuple member comes from gate3's own generic implementation, so this override
cannot accept any document rewrite the default rejects. The second member sees
the one YAML semantic fact outside that structure: for a block scalar whose
header carries `+`, trailing line endings are part of the loaded value even
when tree-sitter leaves them in the whitespace gap after the node.
"""

from __future__ import annotations

import re
from functools import cache
from pathlib import Path

import gate3
import manifest as mf


_MANIFEST = mf.parse(Path(__file__).with_name("yaml.toml"))
_LINE_BREAK = re.compile(rb"\r\n|\r|\n")
_LEADING_LAYOUT = re.compile(rb"[ \t\r\n]*")
_TRAILING_LINES = re.compile(rb"(?:[ \t]*(?:\r\n|\r|\n))+(?:[ \t]*)\Z")


@cache
def _parser():
    from tree_sitter import Language, Parser
    import tree_sitter_yaml

    return Parser(Language(tree_sitter_yaml.language()))


def _walk(node):
    yield node
    for child in node.children:
        yield from _walk(child)


def _kept_line_endings(node, source: bytes) -> tuple[bytes, ...]:
    header = next(
        (child for child in node.children if child.type in {"|", ">"}),
        None,
    )
    if header is None or b"+" not in source[header.start_byte : header.end_byte]:
        return ()

    # At EOF tree-sitter includes the terminal run in the scalar. Before a
    # sibling it ends at the final content byte and leaves the same run in the
    # following layout gap. Join those two shapes, then take only line endings;
    # indentation before the next sibling remains formatter-owned layout.
    after = _LEADING_LAYOUT.match(source[node.end_byte :]).group()
    tail = source[header.end_byte : node.end_byte] + after
    trailing = _TRAILING_LINES.search(tail)
    if trailing is None:
        return ()
    endings = tuple(_LINE_BREAK.findall(trailing.group()))

    # With an empty scalar, the first newline terminates the header and is not
    # content (`x: |+\n\n` loads as one newline, not two). Once body text exists,
    # the anchored trailing match necessarily begins after that header newline.
    first = _LINE_BREAK.search(tail)
    if first is not None and not tail[first.end() :].strip(b" \t\r\n"):
        return endings[1:]
    return endings


def chomp_part(root, source: bytes) -> tuple[tuple[bytes, ...], ...]:
    return tuple(
        _kept_line_endings(node, source)
        for node in _walk(root)
        if node.type == "block_scalar"
        and any(
            child.type in {"|", ">"}
            and b"+" in source[child.start_byte : child.end_byte]
            for child in node.children
        )
    )


def signature(text: str) -> object | None:
    root, source = gate3._reparse(text, _parser())
    if root is None:
        return None
    generic_part = gate3.generic_part_from_root(root, source, _MANIFEST)
    return (generic_part, chomp_part(root, source))


def describe(before, after) -> str:
    if before[0] != after[0]:
        return gate3._describe_generic(before[0], after[0])
    return "keep-chomping trailing newline run differs"
