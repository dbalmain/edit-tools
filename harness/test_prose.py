"""The A1 prose projection's predicate and partition.

These run without tree-sitter, on hand-built documents, because `test.sh` runs
the harness suites with a plain `python3` that has no grammars installed --
the same constraint `test_gate3.py` works under.

Hand-built `inline` children are a *model* of what the block grammar emits, so
these tests cannot prove the model right. That is what
`harness/probe_prose.py` is for: it drives the real grammar over every tracked
markdown file in the repository, checks an independent inline-grammar oracle,
and keeps a fixture of near misses that must stay refused. Logic here, reality
there.
"""

import json
import unittest
from pathlib import Path

import prose


def doc(text: str, *, tokens: tuple[str, ...] = (), base: int = 0) -> dict:
    """One top-level paragraph holding `text`, as a document.

    `tokens` are the anonymous children the block grammar would surface inside
    `inline`; their offsets are found by searching `text`, which is enough for
    a fixture and wrong for anything else.
    """
    source = " " * base + text
    children = []
    at = base
    for token in tokens:
        at = source.index(token, at)
        children.append({"type": token, "start": at, "end": at + len(token),
                         "text": token})
        at += len(token)
    inline = {"type": "inline", "start": base, "end": base + len(text)}
    if children:
        inline["children"] = children
    else:
        inline["text"] = text
    return {
        "language": "markdown",
        "source": source,
        "root": {
            "type": "document", "start": 0, "end": len(source),
            "children": [{
                "type": "paragraph", "start": base, "end": base + len(text),
                "children": [inline],
            }],
        },
    }


def paragraph(d: dict) -> dict:
    return d["root"]["children"][0]


class Refusal(unittest.TestCase):
    """Which rule refuses, for one paragraph shape each."""

    CASES = (
        ("plain words", "alpha beta gamma", (), None),
        ("trailing period", "alpha beta gamma.", (".",), None),
        ("admitted punctuation", "alpha, beta; gamma?", (",", ";", "?"), None),
        ("newline gap", "alpha beta\ngamma delta", (), None),
        ("hyphen inside a word", "alpha well-known beta", ("-",), None),
        ("one word", "alpha", (), "single atom"),
        ("emphasis", "alpha _beta_ gamma", ("_", "_"), "inline token"),
        ("code span", "alpha `beta` gamma", ("`", "`"), "inline token"),
        ("link", "alpha [beta](c) delta", ("[", "]", "(", ")"), "inline token"),
        # `~` and `+` are not tokenised by the block grammar inside `inline`,
        # so the byte check is the only thing standing between a strikethrough
        # and an accepted paragraph. That is the case the whitelist exists for.
        ("strikethrough", "alpha ~~beta~~ gamma", (), "byte"),
        ("plus", "alpha +beta gamma", (), "byte"),
        ("double space", "alpha  beta", (), "whitespace run"),
        ("blank line", "alpha\n\nbeta", (), "whitespace run"),
        ("tab", "alpha\tbeta", (), "byte"),
        ("leading space", " alpha beta", (), "edge whitespace"),
        ("trailing newline", "alpha beta\n", (), "edge whitespace"),
        ("non-ascii", "alpha béta gamma", (), "non-ascii"),
        ("list marker", "alpha - beta", ("-",), "block acquisition"),
        ("thematic break", "alpha --- beta", ("-", "-", "-"),
         "block acquisition"),
        ("ordered list", "in version 1. Then it changed", (".",),
         "block acquisition"),
        ("ordered paren", "see 2) below now", (")",), "block acquisition"),
        # A GFM one-column table delimiter row needs no pipe, so moving `:-` to
        # a line start turns this paragraph into a table. prettier 3.9.6 and
        # micromark+GFM both agree that it does; the pinned block grammar does
        # not parse a pipeless table, so no reparse can stand in for this.
        ("table delimiter row", "alpha :- beta", (":", "-"),
         "block acquisition"),
        ("centre-aligned delimiter", "alpha :-: beta", (":", "-", ":"),
         "block acquisition"),
        ("long delimiter", "alpha :--- beta", (":", "-", "-", "-"),
         "block acquisition"),
        # Not delimiter rows: the fix must not cost every paragraph with a
        # colon in it.
        ("colon then a word", "alpha :-beta gamma", (":", "-"), None),
        ("a time of day", "alpha 10:30 beta gamma", (":",), None),
    )

    def test_cases(self):
        for name, text, tokens, want in self.CASES:
            with self.subTest(name):
                d = doc(text, tokens=tokens)
                got = prose.refusal(paragraph(d), d["source"].encode())
                self.assertEqual(got, want)

    def test_a_paragraph_with_no_inline_child_is_refused(self):
        d = doc("alpha beta")
        paragraph(d)["children"].append(
            {"type": "block_continuation", "start": 10, "end": 10, "text": ""}
        )
        self.assertEqual(
            prose.refusal(paragraph(d), d["source"].encode()), "paragraph shape"
        )


class Partition(unittest.TestCase):
    def covers(self, node, source: bytes):
        """The invariant `source_partitions` enforces at format time."""
        at = node["start"]
        for child in node["children"]:
            self.assertEqual(child["start"], at, "abutting")
            self.assertLess(child["start"], child["end"], "non-empty")
            at = child["end"]
        self.assertEqual(at, node["end"], "total")

    def test_atoms_and_gaps_alternate_and_cover_the_range(self):
        out = prose.project(doc("alpha beta\ngamma"))
        run = paragraph(out)["children"][0]
        self.assertEqual(run["type"], prose.RUN)
        kinds = [child["type"] for child in run["children"]]
        self.assertEqual(
            kinds, [prose.ATOM, prose.GAP, prose.ATOM, prose.GAP, prose.ATOM]
        )
        self.covers(run, out["source"].encode())

    def test_a_gap_keeps_the_byte_it_replaced(self):
        out = prose.project(doc("alpha beta\ngamma"))
        gaps = [
            child
            for child in paragraph(out)["children"][0]["children"]
            if child["type"] == prose.GAP
        ]
        self.assertEqual([gap["text"] for gap in gaps], [" ", "\n"])

    def test_an_atom_is_a_leaf(self):
        """`source_partitions` on the run validates leaf text, so the design
        doc's interior wrapper bought nothing. See `prose.py`."""
        atom = prose.project(doc("alpha beta"))["root"]["children"][0][
            "children"
        ][0]["children"][0]
        self.assertNotIn("children", atom)
        self.assertEqual(
            atom, {"type": prose.ATOM, "start": 0, "end": 5, "text": "alpha"}
        )

    def test_offsets_are_absolute_not_paragraph_relative(self):
        out = prose.project(doc("alpha beta", base=17))
        run = paragraph(out)["children"][0]
        self.assertEqual((run["start"], run["end"]), (17, 27))
        self.assertEqual(run["children"][0]["start"], 17)


class Project(unittest.TestCase):
    def test_an_ineligible_paragraph_keeps_its_inline_child(self):
        out = prose.project(doc("alpha"))
        self.assertEqual(paragraph(out)["children"][0]["type"], "inline")

    def test_the_input_document_is_not_mutated(self):
        """The syntax tree has to survive for highlighting; see `project`."""
        d = doc("alpha beta")
        before = json.dumps(d, sort_keys=True)
        out = prose.project(d)
        self.assertEqual(json.dumps(d, sort_keys=True), before)
        self.assertEqual(paragraph(out)["children"][0]["type"], prose.RUN)

    def test_a_paragraph_inside_a_container_is_never_offered(self):
        d = doc("alpha beta")
        para = paragraph(d)
        d["root"]["children"] = [
            {"type": "block_quote", "start": para["start"], "end": para["end"],
             "children": [para]}
        ]
        out = prose.project(d)
        self.assertEqual(
            out["root"]["children"][0]["children"][0]["children"][0]["type"],
            "inline",
        )

    def test_an_injected_region_is_never_offered(self):
        """A guest language owns its own subtree; markdown's policy stops here."""
        d = doc("alpha beta")
        para = paragraph(d)
        d["root"]["children"] = [
            {"type": "fence", "start": para["start"], "end": para["end"],
             "language": "markdown", "children": [para]}
        ]
        out = prose.project(d)
        self.assertEqual(
            out["root"]["children"][0]["children"][0]["children"][0]["type"],
            "inline",
        )

    def test_the_field_of_the_replaced_inline_survives(self):
        d = doc("alpha beta")
        paragraph(d)["children"][0]["field"] = "body"
        self.assertEqual(
            paragraph(prose.project(d))["children"][0]["field"], "body"
        )


class Package(unittest.TestCase):
    """The derived A1 package, against the shipped one it extends."""

    def setUp(self):
        root = Path(__file__).resolve().parent.parent
        self.base = json.loads((root / "packages" / "markdown.json").read_text())
        self.out = prose.package(self.base)

    def test_the_shipped_package_is_not_mutated(self):
        self.assertEqual(self.base["format"], "et-doc-rules/2")
        self.assertNotIn("source_partitions", self.base)
        self.assertEqual(self.base["rules"]["paragraph"], ["verbatim"])

    def test_partitions_and_whitespace_nodes_stay_disjoint(self):
        """Both runtimes refuse a package whose two lists overlap."""
        self.assertEqual(
            set(self.out["source_partitions"]) & set(self.out["whitespace_nodes"]),
            set(),
        )

    def test_the_shipped_whitespace_nodes_survive(self):
        self.assertEqual(
            self.out["whitespace_nodes"], [*self.base["whitespace_nodes"], prose.GAP]
        )

    def test_an_unprojected_paragraph_still_reaches_verbatim(self):
        branch = self.out["rules"]["paragraph"]
        self.assertEqual(branch[0], "when")
        self.assertEqual(branch[3], ["verbatim"])


if __name__ == "__main__":
    unittest.main()
