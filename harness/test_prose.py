"""The A2.1 prose projection's predicate and partition.

These run without tree-sitter, on hand-built documents, because `test.sh` runs
the harness suites with a plain `python3` that has no grammars installed --
the same constraint `test_gate3.py` works under.

Hand-built `inline` children and hand-built secondary records are a *model* of
what the producers emit, so these tests cannot prove the model right. That is
what `harness/probe_prose.py` is for: it drives the real block grammar and the
real inline grammar over every tracked markdown file in the repository and
keeps a fixture of near misses that must stay refused. Logic here, reality
there.

**Why the block-safety cases live here and not in the fixture.** A2.1 admits
the paragraphs A1 refused as `block acquisition`, so `prose-refused.md` can no
longer guard them -- it detects a change in eligibility, and they are eligible
either way. What has to be guarded is the *partition*: which gaps came back
breakable. `BilateralProtection` asserts that, and `MutationControl` proves
those assertions are live by restoring predecessor-only protection and
requiring them to fail.
"""

import json
import re
import unittest
from pathlib import Path

import prose

INLINE_LANGUAGE = "markdown_inline"


def doc(
    text: str,
    *,
    tokens: tuple[str, ...] = (),
    inline: tuple[tuple[str, str], ...] = (),
    base: int = 0,
    secondary: bool = True,
) -> dict:
    """One top-level paragraph holding `text`, as a document.

    `tokens` are the anonymous children the *block* grammar would surface
    inside `inline`. `inline` is what the *secondary* inline grammar would
    return as the direct children of its root: `(kind, literal)` pairs, where
    an anonymous punctuation token spells itself and a named construct gives
    its source text. Both are located by searching `text`, which is enough for
    a fixture and wrong for anything else.

    The two are not the same list and must not be conflated. For
    ``alpha `beta` gamma`` the block grammar surfaces two backtick tokens while
    the inline grammar surfaces one `code_span` -- and A2.1 reads the second.
    """
    source = " " * base + text
    end = base + len(text)

    def locate(spellings):
        out, at = [], base
        for kind, literal in spellings:
            at = source.index(literal, at)
            out.append({"type": kind, "start": at, "end": at + len(literal)})
            at += len(literal)
        return out

    block_children = locate([(t, t) for t in tokens])
    for child in block_children:
        child["text"] = source[child["start"] : child["end"]]

    node = {"type": "inline", "start": base, "end": end}
    if block_children:
        node["children"] = block_children
    else:
        node["text"] = text

    out = {
        "language": "markdown",
        "source": source,
        "root": {
            "type": "document", "start": 0, "end": len(source),
            "children": [{
                "type": "paragraph", "start": base, "end": end,
                "children": [node],
            }],
        },
    }
    if secondary:
        out["secondary"] = [{
            "language": INLINE_LANGUAGE,
            "within": "inline",
            "start": base,
            "end": end,
            "outcome": "clean",
            "root": {
                "type": "inline", "start": base, "end": end,
                "children": locate(inline),
            },
        }]
    return out


def paragraph(d: dict) -> dict:
    return d["root"]["children"][0]


def verdict(d: dict) -> str | None:
    return prose.refusal(
        paragraph(d), d["source"].encode(), prose.secondary_index(d)
    )


def atom_texts(d: dict) -> list[str]:
    """The projected run's atoms, as source text. The partition, observably."""
    run = paragraph(prose.project(d))["children"][0]
    return [
        child["text"] for child in run["children"]
        if child["type"] == prose.ATOM
    ]


class Refusal(unittest.TestCase):
    """Which rule refuses, for one paragraph shape each."""

    CASES = (
        ("plain words", "alpha beta gamma", (), (), None),
        ("trailing period", "alpha beta gamma.", (".",), ((".", "."),), None),
        ("admitted punctuation", "alpha, beta; gamma?", (",", ";", "?"),
         ((",", ","), (";", ";"), ("?", "?")), None),
        ("newline gap", "alpha beta\ngamma delta", (), (), None),
        ("hyphen inside a word", "alpha well-known beta", ("-",),
         (("-", "-"),), None),
        ("one word", "alpha", (), (), "single atom"),

        # The three constructs A2.1 admits. Under A1 every one of these was
        # refused as `inline token`; that verdict no longer exists, because the
        # secondary CST answers the question instead of the block grammar's
        # loose punctuation.
        ("code span", "alpha `beta` gamma", ("`", "`"),
         (("code_span", "`beta`"),), None),
        ("inline link", "alpha [beta](c) delta", ("[", "]", "(", ")"),
         (("inline_link", "[beta](c)"),), None),
        ("uri autolink", "alpha <http://x.com/a> beta", ("<", ">"),
         (("uri_autolink", "<http://x.com/a>"),), None),

        # Named constructs A2.1 does not admit. Each is a later rung.
        ("emphasis is A2.2", "alpha *beta* gamma", ("*", "*"),
         (("emphasis", "*beta*"),), "inline construct"),
        ("strong is A2.2", "alpha **beta** gamma", ("*", "*", "*", "*"),
         (("strong_emphasis", "**beta**"),), "inline construct"),
        ("image is A2.4", "alpha ![beta](c) delta", (),
         (("image", "![beta](c)"),), "inline construct"),
        ("shortcut link is A2.4", "alpha [beta] gamma", ("[", "]"),
         (("shortcut_link", "[beta]"),), "inline construct"),
        ("reference link is A2.4", "alpha [b][c] gamma", (),
         (("full_reference_link", "[b][c]"),), "inline construct"),
        ("backslash escape is A2.4", "alpha b\\*eta gamma", (),
         (("backslash_escape", "\\*"),), "inline construct"),

        # `~` and `+` are not tokenised by the block grammar inside `inline`,
        # so the byte check is the only thing standing between a strikethrough
        # and an accepted paragraph. That is the case the whitelist exists for.
        ("strikethrough", "alpha ~~beta~~ gamma", (), (), "byte"),
        ("plus", "alpha +beta gamma", (), (), "byte"),
        ("double space", "alpha  beta", (), (), "whitespace run"),
        ("blank line", "alpha\n\nbeta", (), (), "whitespace run"),
        ("tab", "alpha\tbeta", (), (), "byte"),
        ("leading space", " alpha beta", (), (), "edge whitespace"),
        ("trailing newline", "alpha beta\n", (), (), "edge whitespace"),
        ("non-ascii", "alpha béta gamma", (), (), "non-ascii"),

        # A1 refused all of these as `block acquisition`. A2.1 coalesces them
        # instead; `BilateralProtection` below asserts the resulting partition.
        ("list marker coalesces", "alpha - beta gamma", ("-",),
         (("-", "-"),), None),
        ("thematic break coalesces", "alpha --- beta gamma",
         ("-", "-", "-"), (("-", "-"), ("-", "-"), ("-", "-")), None),
        ("ordered list coalesces", "in version 1. Then it changed", (".",),
         ((".", "."),), None),
        ("delimiter row coalesces", "alpha :- beta gamma", (":", "-"),
         ((":", ":"), ("-", "-")), None),

        # ...but not when it is the last atom, where it makes the preceding
        # line a table header. See `_DELIMITER_ROW`.
        ("trailing delimiter row", "alpha beta gamma\n:-", (":", "-"),
         ((":", ":"), ("-", "-")), "delimiter row"),
        ("trailing right-aligned row", "alpha beta gamma\n-:", ("-", ":"),
         (("-", "-"), (":", ":")), "delimiter row"),
        ("trailing centre-aligned row", "alpha beta gamma\n:-:",
         (":", "-", ":"), ((":", ":"), ("-", "-"), (":", ":")),
         "delimiter row"),

        # Not delimiter rows: the fix must not cost every paragraph with a
        # colon in it.
        ("colon then a word", "alpha :-beta gamma", (":", "-"),
         ((":", ":"), ("-", "-")), None),
        ("a time of day", "alpha 10:30 beta gamma", (":",),
         ((":", ":"),), None),
    )

    def test_cases(self):
        for name, text, tokens, inline, want in self.CASES:
            with self.subTest(name):
                self.assertEqual(verdict(doc(text, tokens=tokens, inline=inline)), want)

    def test_a_paragraph_with_no_inline_child_is_refused(self):
        d = doc("alpha beta")
        paragraph(d)["children"].append(
            {"type": "block_continuation", "start": 10, "end": 10, "text": ""}
        )
        self.assertEqual(verdict(d), "paragraph shape")

    def test_a_missing_secondary_record_is_a_producer_bug_not_a_dirty_parse(self):
        """A2.0 made the outcome table total, so absence means something."""
        self.assertEqual(
            verdict(doc("alpha beta", secondary=False)), "no inline parse"
        )

    def test_a_dirty_secondary_record_refuses_that_paragraph_only(self):
        d = doc("alpha beta")
        d["secondary"][0]["outcome"] = "dirty"
        del d["secondary"][0]["root"]
        self.assertEqual(verdict(d), "dirty inline parse")

    def test_a_record_for_another_host_kind_does_not_answer_for_inline(self):
        d = doc("alpha beta")
        d["secondary"][0]["within"] = "fenced_code_block"
        self.assertEqual(verdict(d), "no inline parse")


class ProtectedWhole(unittest.TestCase):
    """An admitted construct never has a gap inside it made breakable."""

    def test_a_space_inside_a_code_span_is_not_a_gap(self):
        d = doc("alpha `co de` beta", tokens=("`", "`"),
                inline=(("code_span", "`co de`"),))
        self.assertIsNone(verdict(d))
        self.assertEqual(atom_texts(d), ["alpha", "`co de`", "beta"])

    def test_a_newline_inside_a_code_span_is_not_a_gap(self):
        d = doc("alpha `co\nde` beta", tokens=("`", "`"),
                inline=(("code_span", "`co\nde`"),))
        self.assertEqual(atom_texts(d), ["alpha", "`co\nde`", "beta"])

    def test_a_double_space_inside_a_code_span_is_not_a_whitespace_run(self):
        """Outside a construct it would be; inside, it never becomes a gap."""
        d = doc("alpha `co  de` beta", tokens=("`", "`"),
                inline=(("code_span", "`co  de`"),))
        self.assertIsNone(verdict(d))
        self.assertEqual(atom_texts(d), ["alpha", "`co  de`", "beta"])

    def test_a_link_with_spaces_stays_one_atom(self):
        d = doc("see [text here](http://x.com/a) ok",
                inline=(("inline_link", "[text here](http://x.com/a)"),))
        self.assertEqual(
            atom_texts(d), ["see", "[text here](http://x.com/a)", "ok"]
        )

    def test_a_character_the_whitelist_refuses_is_fine_inside_a_construct(self):
        """`~` and `*` refuse outside; inside one atom they are just bytes."""
        d = doc("alpha `a~b*c` beta", tokens=("`", "`"),
                inline=(("code_span", "`a~b*c`"),))
        self.assertIsNone(verdict(d))
        self.assertEqual(atom_texts(d), ["alpha", "`a~b*c`", "beta"])

    def test_the_same_character_outside_a_construct_still_refuses(self):
        """The discriminating case for the one above: only position differs."""
        d = doc("alpha a~b*c beta", inline=())
        self.assertEqual(verdict(d), "byte")


# The block-safety cases the design was derived from. Each names the source,
# and the atoms `partition` must emit -- which is the whole claim, since an
# atom is emitted verbatim and only a *gap* can become a line break.
#
# `W` is over-width at 80 so that `fill` is forced to break the separator
# after the first item; that is the mechanism the counterexample turns on.
W = "x" * 88
CODE = f"`{W}`"
LINK = f"[{W}](http://x.com/a)"

BILATERAL = (
    # 1. A hazardous FIRST atom has no predecessor and fails on its own:
    #    `---` and an over-width word format as a thematic break plus a
    #    paragraph. The right-gap half of the rule repairs it.
    ("first atom, three atoms", f"--- {W} beta", (),
     [f"--- {W}", "beta"]),
    ("first atom, nothing left to break", f"--- {W}", (),
     "single atom"),

    # 2. An over-width protected code span, a source newline, and `--`.
    #    Predecessor-only binding yields "`x...x`\n--" + " " + "beta", whose
    #    first physical line is over width, so `fill` breaks the following
    #    separator, isolates `--` and completes a setext h2.
    ("over-width code span then newline and --",
     f"{CODE}\n-- beta gamma", (("code_span", CODE),),
     [f"{CODE}\n-- beta", "gamma"]),

    # 3. The same with a protected link and `:-`.
    ("over-width link then newline and :-",
     f"{LINK}\n:- beta gamma", (("inline_link", LINK),),
     [f"{LINK}\n:- beta", "gamma"]),

    # 4. Both spellings, not just one.
    ("over-width code span then newline and -:",
     f"{CODE}\n-: beta gamma", (("code_span", CODE),),
     [f"{CODE}\n-: beta", "gamma"]),
    ("over-width link then newline and -:",
     f"{LINK}\n-: beta gamma", (("inline_link", LINK),),
     [f"{LINK}\n-: beta", "gamma"]),

    # 5. Adjacent hazards cascade into ONE connected component. Pairwise
    #    merging would produce {alpha,--} and {--,:-} with no definition of
    #    what they mean together; removing from one gap set unions them.
    ("adjacent hazards cascade", "alpha -- :- beta gamma", (),
     ["alpha -- :- beta", "gamma"]),
    ("three adjacent hazards cascade", "alpha -- :- -: beta gamma", (),
     ["alpha -- :- -: beta", "gamma"]),
)


def bilateral_case(name, text, inline, want):
    """Drive the real predicate and the real partition for one case.

    A free function, not a method, so `MutationControl` can re-run the exact
    same assertions against a mutated product rather than a restatement of
    them.
    """
    d = doc(text, inline=inline)
    got = verdict(d)
    if want == "single atom":
        if got != "single atom":
            raise AssertionError(f"{name}: expected refusal, got {got!r}")
        return
    if got is not None:
        raise AssertionError(f"{name}: expected eligible, refused {got!r}")
    atoms = atom_texts(d)
    if atoms != want:
        raise AssertionError(f"{name}: atoms {atoms!r} != {want!r}")


class BilateralProtection(unittest.TestCase):
    """Both gaps around a hazardous atom, not just the preceding one."""

    def test_cases(self):
        for name, text, inline, want in BILATERAL:
            with self.subTest(name):
                bilateral_case(name, text, inline, want)

    def test_a_hazardous_atom_is_never_alone_on_a_line(self):
        """The property behind every case above, stated directly.

        An atom is emitted verbatim, so the only way a marker reaches a line
        start with nothing after it is a breakable gap on each side of it.
        """
        for name, text, inline, want in BILATERAL:
            if want == "single atom":
                continue
            with self.subTest(name):
                for atom in atom_texts(doc(text, inline=inline)):
                    for line in atom.split("\n"):
                        if prose._ACQUIRES.match(line):
                            self.assertNotEqual(
                                line.strip(), line.split(" ")[0],
                                f"{name}: {line!r} is a bare marker line",
                            )


class MutationControl(unittest.TestCase):
    """Restore predecessor-only protection; cases 2-5 must fail.

    Without this the suite cannot tell bilateral protection from a no-op: every
    assertion above would still pass if `_block_safe` dropped only the *left*
    gap, for any case whose hazard happens to sit mid-paragraph.

    It replaces the **product** function and re-runs the **real** assertions,
    rather than re-deriving what the answer ought to be. And it names which
    cases must fail, so a control that starts accepting any failure -- or that
    stops reaching the cases at all -- fails here itself.
    """

    # Every case in `BILATERAL` discriminates, which is what makes the table a
    # regression suite rather than a collection. Named individually rather than
    # derived from `BILATERAL`, so a case added without a thought about whether
    # it discriminates fails here instead of being absorbed silently.
    MUST_FAIL = {
        "over-width code span then newline and --",
        "over-width link then newline and :-",
        "over-width code span then newline and -:",
        "over-width link then newline and -:",
        "adjacent hazards cascade",
        "three adjacent hazards cascade",
        "first atom, three atoms",
        # This one fails for its own reason: predecessor-only binding has no
        # left gap to drop for atom 0, so `---` keeps a breakable gap after it
        # and reaches a line start alone.
        "first atom, nothing left to break",
    }

    @staticmethod
    def _left_only(start, end, text, candidates):
        """The design that was wrong: bind a hazard to its predecessor only."""
        drop = set()
        edges = [start, *[gap + 1 for gap in candidates]]
        stops = [*candidates, end]
        for index, (first, last) in enumerate(zip(edges, stops)):
            if not prose._hazardous(text[first - start : last - start]):
                continue
            if index > 0:
                drop.add(candidates[index - 1])
        return [gap for gap in candidates if gap not in drop]

    def test_left_only_protection_fails_the_cases_it_should(self):
        real = prose._block_safe
        failed = set()
        prose._block_safe = self._left_only
        try:
            for name, text, inline, want in BILATERAL:
                try:
                    bilateral_case(name, text, inline, want)
                except AssertionError:
                    failed.add(name)
        finally:
            prose._block_safe = real
        self.assertEqual(
            failed, self.MUST_FAIL,
            "predecessor-only protection must fail exactly the cases "
            "bilateral protection exists for",
        )

    def test_the_real_implementation_passes_all_of_them(self):
        """The other half of the control: the mutation was what failed."""
        for name, text, inline, want in BILATERAL:
            bilateral_case(name, text, inline, want)


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

    def test_a_coalesced_run_still_covers_its_range(self):
        """The invariant has to hold for the wider atoms too, not just A1's."""
        d = doc("alpha -- :- beta gamma")
        out = prose.project(d)
        self.covers(paragraph(out)["children"][0], out["source"].encode())

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

    def test_an_atom_text_is_exactly_its_source_range(self):
        """`eval.rs:1148` refuses a leaf whose text disagrees with the source,
        so a coalesced atom's bytes are provably its source bytes."""
        d = doc("alpha -- :- beta gamma")
        out = prose.project(d)
        source = out["source"].encode()
        for child in paragraph(out)["children"][0]["children"]:
            self.assertEqual(
                child["text"], source[child["start"] : child["end"]].decode()
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

    def test_refusal_and_project_cannot_disagree(self):
        """Both route through `analyse`; this is the property that buys."""
        for name, text, tokens, inline, want in Refusal.CASES:
            with self.subTest(name):
                d = doc(text, tokens=tokens, inline=inline)
                projected = paragraph(prose.project(d))["children"][0]["type"]
                self.assertEqual(
                    projected == prose.RUN, verdict(d) is None, name
                )


class Mirror(unittest.TestCase):
    """`prose.mjs` is a mirror, and a mirror can be checked without Node."""

    def setUp(self):
        self.js = (Path(__file__).resolve().parent / "prose.mjs").read_text()

    def test_the_construct_set_matches(self):
        found = re.search(r"CONSTRUCTS = new Set\(\[(.*?)\]\)", self.js, re.S)
        self.assertIsNotNone(found, "CONSTRUCTS not found in prose.mjs")
        self.assertEqual(
            set(re.findall(r'"([^"]+)"', found.group(1))), set(prose.CONSTRUCTS)
        )

    def test_every_refusal_reason_is_spelled_in_both(self):
        """Refusal text is part of the contract; `contains` has hidden a live
        parity split here before. See REVIEW.md, 2026-09-12."""
        reasons = {
            want
            for _, _, _, _, want in Refusal.CASES
            if want is not None
        } | {"no inline parse", "dirty inline parse", "paragraph shape"}
        for reason in sorted(reasons):
            with self.subTest(reason):
                self.assertIn(f'"{reason}"', self.js)


class Package(unittest.TestCase):
    """The derived package, against the shipped one it extends."""

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
