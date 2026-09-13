"""The A1 prose projection's predicate and partition.

These run without tree-sitter, on hand-built documents, because `test.sh` runs
the harness suites with a plain `python3` that has no grammars installed --
the same constraint `test_gate3.py` works under.

Hand-built `inline` children are a *model* of what the block grammar emits, so
these tests cannot prove the model right. That is what
`harness/probe_prose_reflow.py` is for: it drives the real grammar over every
markdown file in the repository and requires the projection to survive a
reflow and a reparse. Logic here, reality there.
"""

import unittest

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
        d = doc("alpha beta\ngamma")
        self.assertEqual(prose.project(d), 1)
        run = paragraph(d)["children"][0]
        self.assertEqual(run["type"], prose.RUN)
        kinds = [child["type"] for child in run["children"]]
        self.assertEqual(
            kinds, [prose.ATOM, prose.GAP, prose.ATOM, prose.GAP, prose.ATOM]
        )
        self.covers(run, d["source"].encode())

    def test_a_gap_keeps_the_byte_it_replaced(self):
        d = doc("alpha beta\ngamma")
        prose.project(d)
        gaps = [
            child
            for child in paragraph(d)["children"][0]["children"]
            if child["type"] == prose.GAP
        ]
        self.assertEqual([gap["text"] for gap in gaps], [" ", "\n"])

    def test_an_atom_wraps_its_bytes_in_a_leaf_child(self):
        """Interior, so `verbatim` validates the range against the source."""
        d = doc("alpha beta")
        prose.project(d)
        atom = paragraph(d)["children"][0]["children"][0]
        self.assertNotIn("text", atom)
        self.assertEqual(
            atom["children"], [{"type": prose.TEXT, "start": 0, "end": 5,
                                "text": "alpha"}]
        )

    def test_offsets_are_absolute_not_paragraph_relative(self):
        d = doc("alpha beta", base=17)
        prose.project(d)
        run = paragraph(d)["children"][0]
        self.assertEqual((run["start"], run["end"]), (17, 27))
        self.assertEqual(run["children"][0]["start"], 17)


class Project(unittest.TestCase):
    def test_an_ineligible_paragraph_keeps_its_inline_child(self):
        d = doc("alpha")
        self.assertEqual(prose.project(d), 0)
        self.assertEqual(paragraph(d)["children"][0]["type"], "inline")

    def test_a_paragraph_inside_a_container_is_never_offered(self):
        d = doc("alpha beta")
        para = paragraph(d)
        d["root"]["children"] = [
            {"type": "block_quote", "start": para["start"], "end": para["end"],
             "children": [para]}
        ]
        self.assertEqual(prose.project(d), 0)
        self.assertEqual(para["children"][0]["type"], "inline")

    def test_an_injected_region_is_never_offered(self):
        """A guest language owns its own subtree; markdown's policy stops here."""
        d = doc("alpha beta")
        para = paragraph(d)
        d["root"]["children"] = [
            {"type": "fence", "start": para["start"], "end": para["end"],
             "language": "markdown", "children": [para]}
        ]
        self.assertEqual(prose.project(d), 0)

    def test_the_field_of_the_replaced_inline_survives(self):
        d = doc("alpha beta")
        paragraph(d)["children"][0]["field"] = "body"
        prose.project(d)
        self.assertEqual(paragraph(d)["children"][0]["field"], "body")


if __name__ == "__main__":
    unittest.main()
