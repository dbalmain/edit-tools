#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter", "tree-sitter-markdown==0.5.1"]
# ///
"""What would gate 3 have to change to accept A2.1's reflow? Measured.

    ./harness/probe_prose_equivalence.py

A measurement, not a gate: `./test.sh` does not run it, and its numbers belong
in `docs/prose-projection.md` stamped with the commit they were taken at.

**The question.** `docs/prose-projection.md` says the gate-equivalence design
"must include container-prefix ownership and comment reclassification before
the live reference moves from `preserve`". That reading came from a prototype
(`1c5d111`, reverted by `3857f81`) measured against Prettier's
`--prose-wrap always`, which reflows inside lists and blockquotes too. A2.1's
projection is narrower: `prose.project` stops descending the moment it enters
a container, so a paragraph inside a quote is never offered to `refusal`.

So this re-wraps **only what A2.1 admits** and asks the *existing* gate whether
the result still means the same thing -- and when it does not, whether the
disagreement is about where lines break or about something structural.

**Why the classification can be trusted.** A classifier that called everything
soft would report the same headline, so the controls below drive the same
`normalised()` over changes that must come out structural: a deleted word, a
flattened hard break, and a reflow that crosses a quote prefix. The last two
are two of the three causes the document names, so a run that reports them as
soft has disproved itself.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import tree_sitter as ts
import tree_sitter_markdown as tsmd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "harness"))

import gate3  # noqa: E402
import manifest as mf  # noqa: E402
import probe_prose as pp  # noqa: E402
import prose  # noqa: E402

WIDTHS = (80, 40)

ASCII_WHITESPACE = re.compile(r"[ \t\n\r\f]+")


def prose_gap(text: str) -> str:
    """The reverted prototype's `_prose_gap`, so the two measurements compare.

    Two or more spaces before a newline is a Markdown hard break and stays a
    break; every other ASCII whitespace run becomes one space. Non-ASCII
    whitespace is content rather than a break opportunity, so it is not in the
    character class.
    """
    out: list[str] = []
    at = 0
    for match in ASCII_WHITESPACE.finditer(text):
        out.append(text[at : match.start()])
        whitespace = match.group()
        hard = len(re.findall(r" {2,}\r?\n", whitespace))
        out.append("\n" * hard if hard else " ")
        at = match.end()
    out.append(text[at:])
    return "".join(out)


def normalised(signature):
    """`signature` with prose whitespace canonicalised, recursively.

    Two signatures that disagree before this and agree after it disagreed
    **only** about where the lines break, which is what a declared prose
    equivalence would permit. Still disagreeing means structural, and
    structural is the half the document says needs a range-aware design.
    """
    if isinstance(signature, str):
        return prose_gap(signature).strip(" ")
    if isinstance(signature, (tuple, list)):
        return tuple(normalised(item) for item in signature)
    return signature


def rewrap(source: bytes, doc: dict, width: int) -> bytes:
    """Greedy re-wrap of every projected run, atoms kept whole.

    What a `fill` over `source_partitions` would emit for the runs the
    projection produced: each gap becomes one space or one newline, and no byte
    inside an atom moves. Byte length is deliberately *not* preserved -- that
    is what `probe_prose.reflow` holds fixed, and what has to vary here.
    """
    out = bytearray(source)
    edits: list[tuple[int, int, bytes]] = []
    for run in pp.runs(prose.project(doc)):
        atoms = [c for c in run["children"] if c["type"] == prose.ATOM]
        if len(atoms) < 2:
            continue
        line: list[str] = []
        lines: list[str] = []
        for atom in atoms:
            if line and len(" ".join(line + [atom["text"]])) > width:
                lines.append(" ".join(line))
                line = [atom["text"]]
            else:
                line.append(atom["text"])
        if line:
            lines.append(" ".join(line))
        edits.append((run["start"], run["end"], "\n".join(lines).encode("utf-8")))
    for start, end, text in sorted(edits, reverse=True):
        out[start:end] = text
    return bytes(out)


CONTROLS = {
    "a word deleted": (
        "An opening paragraph, so the section has a body and not\njust a heading.\n",
        "An opening paragraph, so the section has a body and\njust a heading.\n",
        "STRUCTURAL",
    ),
    "a hard break flattened": (
        "One line ending in a hard break,  \nand the line that follows it.\n",
        "One line ending in a hard break, and the line that follows it.\n",
        "STRUCTURAL",
    ),
    "reflow across a quote prefix": (
        "> A quoted paragraph long enough that a reflow would\n> move words between its lines.\n",
        "> A quoted paragraph long enough that a reflow would move words\nbetween its lines.\n",
        "STRUCTURAL",
    ),
    "a plain soft re-wrap": (
        "An opening paragraph, so the section has a body and not\njust a heading.\n",
        "An opening paragraph, so the section has a body and not just a\nheading.\n",
        "soft",
    ),
}

# The document's second named cause: Prettier can move an inline HTML comment
# to the start of a continuation line, where the block grammar reclassifies the
# line as `html_block`. `_ACQUIRES` does not list `<`, and the argument for
# leaving it out names `uri_autolink` as the only admitted `<`-initial atom --
# so whether a bare comment can be eligible is a question, not a given.
COMMENTS = {
    "a bare inline HTML comment": (
        "Some words <!-- a comment --> and more words here.\n",
        "inline construct",
    ),
    "a comment inside a code span": (
        "Some words `<!-- a comment -->` and more words here.\n",
        "eligible",
    ),
    "an autolink, for contrast": (
        "Some words <https://example.com/x> and more words.\n",
        "eligible",
    ),
}


def classify(before_text, after_text, manifest, parser, manifests, parsers) -> str:
    before = gate3.signature(before_text, manifest, parser, manifests, parsers)
    after = gate3.signature(after_text, manifest, parser, manifests, parsers)
    if before is None or after is None:
        return "DOES NOT PARSE"
    if before == after:
        return "accepted"
    return "soft" if normalised(before) == normalised(after) else "STRUCTURAL"


def main() -> int:
    parser = ts.Parser(ts.Language(tsmd.language()))
    inline = ts.Parser(ts.Language(tsmd.inline_language()))
    manifest = pp.markdown_manifest()
    manifests = mf.load_all()
    parsers = {"markdown": parser}
    failures: list[str] = []

    print("controls -- the classifier must disagree with itself here")
    for label, (before, after, want) in CONTROLS.items():
        got = classify(before, after, manifest, parser, manifests, parsers)
        print(f"  {label:30} {got:12} (want {want})")
        if got != want:
            failures.append(f"control {label!r}: {got}, wanted {want}")

    print("\nthe second named cause, against the predicate rather than a corpus")
    for label, (text, want) in COMMENTS.items():
        doc = pp.parse(parser, text.encode(), ROOT / "probe.md", inline)
        got = [reason for _, reason in prose.reasons(doc)] if doc else ["unparsed"]
        print(f"  {label:30} {got}")
        if got != [want]:
            failures.append(f"{label!r}: {got}, wanted [{want!r}]")

    counts = dict.fromkeys(
        ("files", "unparsed", "changed", "accepted", "soft", "structural"), 0
    )
    structural: list[str] = []
    for path in pp.markdown_files():
        source = path.read_bytes()
        doc = pp.parse(parser, source, path, inline)
        if doc is None:
            counts["unparsed"] += 1
            continue
        counts["files"] += 1
        text = source.decode("utf-8")
        for width in WIDTHS:
            after = rewrap(source, doc, width)
            if after == source:
                continue
            counts["changed"] += 1
            got = classify(
                text, after.decode("utf-8"), manifest, parser, manifests, parsers
            )
            counts[{"accepted": "accepted", "soft": "soft"}.get(got, "structural")] += 1
            if got not in ("accepted", "soft"):
                structural.append(f"{path.relative_to(ROOT)}@{width} ({got})")

    print(f"\ntracked markdown files parsed : {counts['files']}")
    print(f"unparseable                   : {counts['unparsed']}")
    print(
        f"re-wraps that changed bytes   : {counts['changed']} of "
        f"{counts['files'] * len(WIDTHS)}"
    )
    print(f"  gate 3 accepts unchanged    : {counts['accepted']}")
    print(f"  rejected, soft-wrap only    : {counts['soft']}")
    print(f"  rejected, STRUCTURAL        : {counts['structural']}")
    for name in structural:
        print(f"    {name}")

    if counts["changed"] == 0:
        failures.append("no re-wrap changed any bytes: the sweep measured nothing")
    if failures:
        print("\nthis measurement does not stand:")
        for failure in failures:
            print(f"  {failure}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
