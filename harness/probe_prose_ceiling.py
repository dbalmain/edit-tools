#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter", "tree-sitter-markdown==0.5.1"]
# ///
"""The prose-eligibility ceiling, priced on the live corpus.

    ./harness/probe_prose_ceiling.py

A measurement, not a gate: `./test.sh` does not run it. It answers the question
the A2 rungs leave open -- how much would each planned rung buy? -- and it
refuses to answer that question silently, because a census that stopped finding
paragraphs would print a clean, plausible, wrong table and nobody would notice.

**What it measures.** `prose.analyse` decides per top-level paragraph whether it
can be re-wrapped, refusing for one of nine reasons. The first half is the
refusal census: every top-level paragraph in every tracked markdown file,
grouped by reason, walked exactly the way `prose.project` walks -- skip any
node whose type is in `prose.CONTAINERS` or that carries a `"language"` key,
and never descend once one is hit. The second half prices the rungs. Each
paragraph refused as `inline construct` holds a **set** of blocking inline
kinds found by the same recursive walk as the projection: protected-whole nodes
stop, emphasis descends, and other nodes outside `SAFE_PUNCTUATION` block. A
rung frees a paragraph only when it admits **every** kind in that set, so the
per-paragraph set is the unit and a per-kind tally is the wrong answer. After
A2.2, it also retains A2.1's direct-child classifier as
a transition ruler: which construct refusals emphasis removed, and which real
A2.2 verdict each paragraph reached next. The remaining planned rungs are A2.4
(seven named kinds) and `punct` (every single-character non-alphanumeric
blocker, derived from the corpus because nobody has enumerated it).

**The price before implementation.** At commit `8100844`, the census found
3,807 top-level paragraphs, 1,604 eligible and 1,779 `inline construct`; the
A2.1 direct-child classifier said emphasis removed the first refusal from
1,547. That was a ceiling, not an eligibility delta: A2.2 proved that hundreds
then reach the deferred `non-ascii` check. The transition table below now makes
that distinction visible instead of silently treating every removed first
refusal as eligible.

**The controls, and the broken version each catches.** This repository has been
bitten repeatedly by gates that pass while checking nothing, so the probe fails
loudly in the four ways it can fail silently:

* **A census that finds nothing.** If the walk broke, a node type was renamed,
  or the corpus moved out from under `git ls-files`, the sweep would print a
  small, plausible table of mostly zeros. The paragraph floor
  (`MIN_PARAGRAPHS`) and the eligible floor (`MIN_ELIGIBLE`) catch it: the real
  census measures thousands of each, and a broken walk finds a handful.
* **A walk that no longer matches the projection.** The walk here is a copy of
  `prose.reasons`'s, so it is checked against the real function on every file:
  the `(start, reason)` lists must agree exactly. A copy that drifts -- skips a
  container class, stops descending -- fails here before it can corrupt the
  numbers.
* **A reason string or node type that went dead.** Synthetic paragraphs are
  parsed with the real block and inline grammars and driven through the real
  `prose.analyse`, each checked against its named verdict -- three eligible
  (plain, code span, emphasis; Latin-1 is eligible as of A2.3), and one
  refused case each for `byte`, `single atom` and `whitespace run`.
  `non-ascii` remains a decode-failure verdict and is unreachable through a
  Python `str` source, so it is not a synthetic here. And `LIVE_KINDS` pins
  the still-refused named kinds `prose.py` claims occur in this corpus's
  secondary trees, so a grammar rename of `image` cannot pass as a census
  change.
* **Blockers that stopped resolving.** Every `inline construct` refusal must
  yield a clean, non-empty blocker set. An empty set would let every rung free
  everything, which prints as triumph and is the census lying.

**What it does not say.** The `punct` rung is priced with the union of kinds
actually observed; a rung that admits punctuation the corpus never sees would
free the same paragraphs and cost more, and this file cannot see that from the
outside. A2.4's named kinds include `collapsed_reference_link`, which the
corpus does not refuse once today, so it is in the rung but deliberately absent
from `LIVE_KINDS`.
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import tree_sitter as ts
import tree_sitter_markdown as tsmd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "harness"))

import probe_prose as pp  # noqa: E402
import prose  # noqa: E402

# The transition and next planned rung as sets of inline kinds. A2.4's added
# kinds are prose.py's own list of the named constructs A2.2 refuses. `punct` is derived
# from the corpus in `main`, not fixed here, because it is *every*
# single-character non-alphanumeric blocker.
RUNG_A22 = frozenset({"emphasis", "strong_emphasis"})
RUNG_A24 = frozenset(
    {
        "backslash_escape",
        "entity_reference",
        "image",
        "shortcut_link",
        "full_reference_link",
        "collapsed_reference_link",
        "strikethrough",
    }
)

# Deliberate floors, not pins: the census measured 3807 top-level paragraphs
# and 1604 eligible at the writing commit, and a floor exists to notice the
# walk collapsing to nothing, not to forbid a smaller corpus. A broken walk
# finds a handful of paragraphs; a broken predicate finds zero eligible ones.
MIN_PARAGRAPHS = 1000
MIN_ELIGIBLE = 800

# Inline kinds the corpus refused at the writing commit. `prose.py` claims the
# named ones occur in the corpus's secondary trees, so the probe pins that
# claim: a node type renamed by the grammar, or a walk that stopped descending,
# makes one of these disappear and the census is caught lying before it is
# read. `collapsed_reference_link` did not occur, so it is deliberately absent.
LIVE_KINDS = frozenset(
    {
        "backslash_escape",
        "entity_reference",
        "image",
        "shortcut_link",
        "full_reference_link",
        "strikethrough",
    }
)

# The synthetic paragraphs driven through the real `prose.analyse`, with the
# verdict each must return. Each is parsed with the real block and inline
# grammars, so the control exercises the producer path end to end rather than a
# hand-built model of it. `None` is the eligible verdict.
VERDICTS = (
    ("plain prose", "alpha beta gamma\n", None),
    ("a code span, protected whole", "alpha `beta` gamma\n", None),
    ("emphasis admitted by A2.2", "alpha *beta* gamma\n", None),
    ("a lone tilde, refused by byte", "alpha ~beta gamma\n", "byte"),
    ("latin-1 atom content, A2.3", "alpha b\u00e9ta gamma\n", None),
    ("one word, no gap", "alpha\n", "single atom"),
    ("a double space", "alpha  beta\n", "whitespace run"),
)


# The verdicts `prose.analyse` can return, `None` spelled "eligible". Printed
# as a zero row when absent, so the table shows the whole decision space and a
# reason that stops occurring cannot hide inside an unprinted row.
ALL_REASONS = frozenset(
    {
        "paragraph shape",
        "no inline parse",
        "dirty inline parse",
        "inline construct",
        "non-ascii",
        "edge whitespace",
        "byte",
        "whitespace run",
        "delimiter row",
        "fence opener",
        "single atom",
    }
)


class Failed(Exception):
    """A control the census must pass no longer discriminates."""


def synthetic_doc(parser, inline, text: str) -> dict:
    """The real parse of one synthetic paragraph, or None if it will not parse."""
    return pp.parse(parser, text.encode(), ROOT / "probe_prose_ceiling.md", inline)


def first_paragraph(doc: dict) -> dict:
    """The document's single top-level paragraph, using the projection's walk."""
    stack = [doc["root"]]
    while stack:
        node = stack.pop()
        if node["type"] in prose.CONTAINERS or "language" in node:
            continue
        if node["type"] == "paragraph":
            return node
        stack.extend(node.get("children", []))
    raise Failed("a synthetic document produced no top-level paragraph")


def census_doc(
    root: dict, source: bytes, secondary: dict[tuple[int, int], dict]
) -> list[tuple[dict, str | None]]:
    """Every top-level paragraph the projection would consider, with its verdict.

    The walk is a copy of `prose.reasons`'s and is checked against the real
    function per file, so a drift here is caught rather than absorbed.
    """
    out: list[tuple[dict, str | None]] = []

    def walk(node: dict) -> None:
        if node["type"] in prose.CONTAINERS or "language" in node:
            return
        if node["type"] == "paragraph":
            out.append((node, prose.refusal(node, source, secondary)))
            return
        for child in node.get("children", []):
            walk(child)

    walk(root)
    return out


def blockers(node: dict, secondary: dict[tuple[int, int], dict]) -> frozenset[str]:
    """The inline kinds standing between this paragraph and eligibility.

    A mirror of `_protected`'s recursive refusal test. Protected-whole nodes stop
    the walk; emphasis descends through its delimiter leaves; anything else
    outside `SAFE_PUNCTUATION` is a blocker. `_protected` returns before reading
    text, so `record` is guaranteed clean and present here.
    """
    inline = node["children"][0]
    record = secondary.get((inline["start"], inline["end"]))
    if record is None or record.get("outcome") != "clean":
        raise Failed(
            f"an `inline construct` refusal has no clean inline record at "
            f"{inline['start']}..{inline['end']}"
        )
    found: set[str] = set()

    def visit(child: dict, in_emphasis: bool = False) -> None:
        kind = child["type"]
        if kind in prose.CONSTRUCTS:
            return
        if kind in prose.EMPHASIS:
            children = child.get("children", [])
            delimiters = [
                nested
                for nested in children
                if nested["type"] == prose._EMPHASIS_DELIMITER
            ]
            if len(delimiters) != prose._DELIMITER_COUNTS[kind]:
                found.add(kind)
                return
            for nested in children:
                visit(nested, True)
            return
        if in_emphasis and kind == prose._EMPHASIS_DELIMITER:
            return
        if kind not in prose.SAFE_PUNCTUATION:
            found.add(kind)

    for child in record["root"].get("children", []):
        visit(child)
    frozen = frozenset(found)
    if not frozen:
        raise Failed(
            f"an `inline construct` refusal at {inline['start']}..{inline['end']} "
            "yields an empty blocker set -- the refusal and its evidence disagree"
        )
    return frozen


def a21_blockers(
    node: dict, secondary: dict[tuple[int, int], dict]
) -> frozenset[str]:
    """A2.1's direct-child construct blockers, kept as a transition ruler."""
    inline = node["children"][0]
    record = secondary.get((inline["start"], inline["end"]))
    if record is None or record.get("outcome") != "clean":
        return frozenset()
    return frozenset(
        child["type"]
        for child in record["root"].get("children", [])
        if child["type"] not in prose.CONSTRUCTS
        and child["type"] not in prose.SAFE_PUNCTUATION
    )


def main() -> int:
    parser = ts.Parser(ts.Language(tsmd.language()))
    inline = ts.Parser(ts.Language(tsmd.inline_language()))
    failures: list[str] = []

    print("controls -- the real predicate must still say what it says")
    for label, text, want in VERDICTS:
        doc = synthetic_doc(parser, inline, text)
        if doc is None:
            failures.append(f"control {label!r}: the synthetic paragraph does not parse")
            continue
        para = first_paragraph(doc)
        verdict, _ = prose.analyse(
            para, text.encode(), prose.secondary_index(doc)
        )
        print(f"  {label:32} {verdict}")
        if verdict != want:
            failures.append(f"control {label!r}: {verdict!r}, wanted {want!r}")

    totals: Counter[str] = Counter()
    sets: Counter[frozenset[str]] = Counter()
    kinds: set[str] = set()
    a22_outcomes: Counter[str] = Counter()
    paragraphs = 0
    files = 0
    skipped = 0
    for path in pp.markdown_files():
        source = path.read_bytes()
        doc = pp.parse(parser, source, path, inline)
        if doc is None:
            skipped += 1
            continue
        files += 1
        secondary = prose.secondary_index(doc)
        found = census_doc(doc["root"], source, secondary)
        real = prose.reasons(doc)
        if [(n["start"], v or "eligible") for n, v in found] != real:
            failures.append(
                f"{path.relative_to(ROOT)}: this walk disagrees with prose.reasons()"
            )
        for node, verdict in found:
            paragraphs += 1
            totals[verdict or "eligible"] += 1
            old_blockers = a21_blockers(node, secondary)
            if old_blockers and old_blockers <= RUNG_A22:
                a22_outcomes[verdict or "eligible"] += 1
            if verdict != "inline construct":
                continue
            try:
                found_blockers = blockers(node, secondary)
            except Failed as why:
                failures.append(str(why))
                continue
            sets[found_blockers] += 1
            kinds |= found_blockers

    if paragraphs < MIN_PARAGRAPHS:
        failures.append(
            f"only {paragraphs} top-level paragraphs, below the "
            f"{MIN_PARAGRAPHS} floor"
        )
    if totals["eligible"] < MIN_ELIGIBLE:
        failures.append(
            f"only {totals['eligible']} eligible paragraphs, below the "
            f"{MIN_ELIGIBLE} floor"
        )
    missing = LIVE_KINDS - kinds
    if missing:
        failures.append(f"blocker kinds no longer occur in the corpus: {sorted(missing)}")
    # A conservation law rather than a floor, because the rung yields are the
    # headline and nothing else guards them: every `inline construct` refusal
    # must have contributed exactly one blocker set. Without this, a
    # `sets` that silently stopped recording prints a rung table of zeros --
    # "A2.4 frees 0" -- with the census above it still correct and every other
    # control still green. Found by mutating this probe against itself; it was
    # the one mutation of three that survived.
    recorded = sum(sets.values())
    if recorded != totals["inline construct"]:
        failures.append(
            f"{recorded} blocker sets recorded for "
            f"{totals['inline construct']} `inline construct` refusals -- the "
            f"rung yields below are computed from the smaller number"
        )

    punct = frozenset(kind for kind in kinds if len(kind) == 1 and not kind.isalnum())

    def freed(rung: frozenset[str]) -> int:
        return sum(count for blockers_set, count in sets.items() if blockers_set <= rung)

    a24 = freed(RUNG_A24)
    punct_alone = freed(punct)
    a24_punct = freed(RUNG_A24 | punct)

    print(f"\nrefusal census, {paragraphs} top-level paragraphs in {files} "
          f"tracked markdown files ({skipped} unparseable)")
    eligible = totals["eligible"]
    print(f"  {'eligible':20} {eligible:5}  ({100 * eligible / paragraphs:.1f}%)")
    for reason, count in sorted(
        totals.items(), key=lambda item: (-item[1], item[0])
    ):
        if reason == "eligible":
            continue
        print(f"  {reason:20} {count:5}")
    for reason in sorted(ALL_REASONS - set(totals)):
        print(f"  {reason:20} {0:5}")

    print("\nblocking sets, one per `inline construct` paragraph")
    for blockers_set, count in sorted(sets.items(), key=lambda item: (-item[1], item[0])):
        label = "{" + ", ".join(sorted(blockers_set)) + "}"
        print(f"  {label:60} {count}")

    print("\nA2.2 transition from A2.1's construct-first classifier")
    print(f"  {'construct refusals removed':32} {sum(a22_outcomes.values())}")
    for outcome, count in sorted(
        a22_outcomes.items(), key=lambda item: (-item[1], item[0])
    ):
        print(f"  {outcome:32} {count}")

    print("\nnext planned rung, paragraphs freed (a rung frees a paragraph only when")
    print("it admits every blocker in that paragraph's set)")
    print(f"  A2.4 seven named kinds                                  {a24}")
    print(f"  punct (single-char non-alphanumeric blockers)             {punct_alone} alone, "
          f"{a24_punct} with A2.4")

    if failures:
        print("\nthis measurement does not stand:")
        for failure in failures:
            print(f"  {failure}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
