#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""The corpus-quality numbers, computed once instead of by hand every time.

    ./harness/corpus_stats.py [--language NAME]

Stage A must report three things about its corpus, and stage B must check them.
Until now both did it with ad hoc `cmp` loops, because `score.py` filters out
any language without a package before it computes anything -- so the one number
the corpus brief tells a stage-A builder to read out of `score.py` ("its own
overflow: N") was structurally unavailable at stage A. Every round-2 builder
worked around it independently and one flagged it as a template defect.

Hand-rolled loops are also the wrong tool for the job. The failure they are
meant to catch is a builder reporting a flattering number or omitting one, and a
reviewer re-deriving it with a *different* loop cannot tell a disagreement from
a methodology difference. A shared implementation makes the number checkable.

What each one is for:

- **Reference changes** -- a corpus the reference leaves alone probes nothing.
  Round 1 had a corpus where 7 of 14 files were byte-identical input to output,
  so it tested what the reference *breaks* and never what it *rewrites*.
- **Differs between widths** -- the corpus must force layout decisions, not just
  accept whatever fits. Constructs the reference cannot break do not count, and
  a fixed-width reference (gofmt) makes this inapplicable rather than zero.
- **Carries a comment** -- gate 3's universal comment layer takes named extras
  and manifest-declared comment node kinds as its only input, so a file without
  one is a file where that layer is inert. One round-1 corpus had 9 of 14 files
  with no comment at all.
- **Reference overflow** -- references overrun their own target width, and all
  of them do. Without this number a stage-C agent reads an over-long reference
  line as a corpus bug and formats away from the reference to "fix" it.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "harness"))

import manifest as mf  # noqa: E402
from score import leaves, overflow_lines  # noqa: E402

SRC = ROOT / "corpus/src"
REFERENCE = ROOT / "corpus/reference"
TREES = ROOT / "corpus/trees"


def comment_count(root, comment_kinds: tuple[str, ...]) -> int:
    """Count named extras and grammar-specific comment node kinds."""
    total = 0
    stack = [root]
    while stack:
        node = stack.pop()
        if (node.is_named and node.is_extra) or node.type in comment_kinds:
            total += 1
        stack.extend(node.children)
    return total


def stats_for(m: mf.Manifest) -> dict | None:
    sources = sorted((SRC / m.name).glob(f"*{m.extensions[0]}"))
    if not sources:
        return None
    parser = mf.parser_for(m)

    changed: dict[int, int] = {w: 0 for w in m.widths}
    changed_any = 0
    width_sensitive = 0
    commented = 0
    overflow: dict[int, int] = {w: 0 for w in m.widths}
    missing: list[str] = []

    for source in sources:
        text = source.read_text()
        stem = source.stem
        outputs: dict[int, str] = {}
        for width in m.widths:
            path = REFERENCE / f"{m.name}__{stem}@{width}.txt"
            if not path.is_file():
                missing.append(path.name)
                continue
            outputs[width] = path.read_text()

        for width, out in outputs.items():
            if out != text:
                changed[width] += 1
        if any(out != text for out in outputs.values()):
            changed_any += 1
        if len(set(outputs.values())) > 1:
            width_sensitive += 1

        if comment_count(parser.parse(text.encode()).root_node, m.comment_kinds):
            commented += 1

        tree = TREES / f"{m.name}__{stem}.tree.json"
        if tree.is_file():
            import json

            tokens = leaves(json.loads(tree.read_text())["root"])
            for width, out in outputs.items():
                overflow[width] += overflow_lines(out, width, tokens)

    return {
        "files": len(sources),
        "changed": changed,
        "changed_any": changed_any,
        "width_sensitive": width_sensitive,
        "commented": commented,
        "overflow": overflow,
        "missing": missing,
        "incomparable": len(m.incomparable),
        "fixed": m.reference_width == "fixed",
        "widths": list(m.widths),
        "reference": m.reference_version,
    }


def report(name: str, s: dict) -> bool:
    n = s["files"]
    print(f"{name}  --  {n} files, vs {s['reference']}")
    if s["missing"]:
        print(f"  MISSING reference output: {', '.join(s['missing'][:6])}")
    if s["incomparable"]:
        print(f"  incomparable         {s['incomparable']}  "
              f"(gated; out of the agreement denominator)")

    per_width = "  ".join(f"@{w} {s['changed'][w]}/{n}" for w in s["widths"])
    print(f"  reference changes    {s['changed_any']}/{n} at some width   ({per_width})")

    if s["fixed"] or len(s["widths"]) < 2:
        print(f"  differs by width     n/a -- fixed-width reference, one width")
        width_ok = True
    else:
        share = s["width_sensitive"] / n
        mark = "" if share >= 1 / 3 else "   [BELOW one third]"
        print(f"  differs by width     {s['width_sensitive']}/{n}{mark}")
        width_ok = share >= 1 / 3

    share = s["commented"] / n
    mark = (
        ""
        if share > 0.5
        else "   [BELOW half -- gate 3's universal comment layer is inert there]"
    )
    print(f"  carries a comment    {s['commented']}/{n}{mark}")

    per_width = "  ".join(f"@{w} {s['overflow'][w]}" for w in s["widths"])
    print(f"  reference overflow   {per_width}")

    flat = s["files"] - s["changed_any"]
    if flat:
        print(f"  NOTE {flat} file(s) byte-identical input to output at every "
              f"width -- those probe no normalisation")
    print()
    return width_ok and share > 0.5


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--language", help="only this language")
    args = ap.parse_args(argv)

    manifests = mf.selected(mf.bootstrap(), args.language)
    any_seen = False
    for name, m in sorted(manifests.items()):
        s = stats_for(m)
        if s is None:
            continue
        any_seen = True
        report(name, s)
    if not any_seen:
        print("no corpus found")
    return 0


if __name__ == "__main__":
    mf.cli(main)
