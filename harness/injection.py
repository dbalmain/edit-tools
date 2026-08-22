"""Find and parse manifest-declared embedded language regions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import manifest as mf


@dataclass(frozen=True)
class Region:
    content: Any
    source: bytes
    guest: mf.Manifest | None


def _direct(node, kind: str):
    return next((child for child in node.children if child.type == kind), None)


def region_for(
    node,
    source: bytes,
    host: mf.Manifest,
    aliases: dict[str, mf.Manifest],
) -> Region | None:
    """Return a declared content region, routed when its info string is known."""
    site = next((site for site in host.injections if site.node == node.type), None)
    if site is None:
        return None

    content = node if site.content is None else _direct(node, site.content)
    if content is None:
        return None
    info = _direct(node, site.info) if site.info is not None else None
    words = (
        source[info.start_byte : info.end_byte].decode("utf-8").split()
        if info is not None
        else []
    )
    guest = aliases.get(site.guest) if site.guest is not None else None
    if guest is None and words:
        guest = aliases.get(words[0])
    return Region(
        content,
        source[content.start_byte : content.end_byte],
        guest,
    )


def parse(region: Region, parsers: dict[str, Any]):
    """Return a clean guest root, or None when the region must stay verbatim."""
    if region.guest is None:
        return None
    parser = parsers.get(region.guest.name)
    if parser is None:
        return None
    root = parser.parse(region.source).root_node
    stack = [root]
    while stack:
        node = stack.pop()
        if node.type == "ERROR" or node.is_missing:
            return None
        stack.extend(node.children)
    return root
