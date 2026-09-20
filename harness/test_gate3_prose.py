"""The declared prose narrowing: what gate 3 forgives inside `prose_nodes`.

These run without tree-sitter, on the same hand-built `Node` fixture the other
gate-3 suites use, because `test.sh` runs the harness suites with a plain
`python3` that has no grammars installed. The end-to-end half -- real grammars,
real reference output -- lives in `harness/probe_prose_equivalence.py`, which is
a measurement rather than a gate.

**What a wrong implementation looks like, and which test catches it.** The
narrowing is three lines and there are four plausible ways to get it wrong:

  * collapse *all* whitespace, losing the hard break
        -> `test_a_flattened_hard_break_is_still_destruction`
  * compare the words as a set or a bag rather than in order
        -> `test_reordering_two_words_is_still_destruction`
  * apply it to every node instead of declared ones
        -> `test_an_undeclared_node_still_compares_exactly`, and the YAML pair
           below, which is the historical shape of the bug
  * admit non-ASCII whitespace into the class, so a no-break space becomes a
        break opportunity
        -> `test_a_no_break_space_is_content_not_a_gap`
  * collapse a gap to nothing rather than to one space, joining two words
        -> `test_joining_two_words_is_still_destruction`
  * take *one* space before a newline as a hard break, rejecting correct output
        -> `test_one_trailing_space_is_not_a_hard_break`

The last two were found by mutating this module against its own suite, not by
writing it: the first eight tests passed both mutants. Every entry above is a
mutant that was run and killed, not a shape that was imagined.

The YAML case is kept as a live counterexample rather than a comment because it
is the one that would be *silently* destructive: `harness/prose.py` refuses
non-ASCII and hard breaks loudly, but a literal block scalar whose newlines are
its value looks exactly like a paragraph to this transform.
"""

import unittest
from dataclasses import replace
from pathlib import Path

import gate3
from test_check_gate3 import Node, make_manifest


def signature_of(
    node,
    source: str,
    prose: frozenset[str] = frozenset(),
    prefixes: frozenset[str] = frozenset(),
):
    manifest = make_manifest(Path("/nonexistent/x.toml"), "x", "default")
    manifest = replace(
        manifest,
        prose_nodes=prose,
        prose_prefix_nodes=prefixes,
    )
    return gate3._generic(
        node, source.encode(), manifest, {}, frozenset(), {}, frozenset()
    )


def paragraph(source: str):
    """One `inline` leaf spanning the whole source, as markdown's tree has it."""
    return Node("inline", 0, len(source.encode()))


INLINE = frozenset({"inline"})


class DeclaredProseTests(unittest.TestCase):
    def test_a_declared_container_prefix_is_not_prose_content(self):
        quoted = "alpha\n> beta"
        inline = Node(
            "inline",
            0,
            len(quoted),
            (Node("block_continuation", 6, 8),),
        )
        plain = paragraph("alpha beta")
        self.assertEqual(
            signature_of(
                inline,
                quoted,
                INLINE,
                frozenset({"block_continuation"}),
            ),
            signature_of(plain, "alpha beta", INLINE),
        )
        self.assertNotEqual(
            signature_of(inline, quoted, INLINE),
            signature_of(plain, "alpha beta", INLINE),
        )

    def test_a_soft_rewrap_is_accepted(self):
        """The whole point: prettier moving words between lines to fit a width
        keeps every word in order, and gate 3 must stop calling that
        destruction. Measured against the real thing in
        `probe_prose_equivalence.py`: 183 of 186 changed re-wraps across 139
        files were rejected for exactly this and nothing else."""
        wide = "the quick brown fox jumps\nover the lazy dog"
        narrow = "the quick brown\nfox jumps over\nthe lazy dog"
        self.assertEqual(
            signature_of(paragraph(wide), wide, INLINE),
            signature_of(paragraph(narrow), narrow, INLINE),
        )

    def test_an_undeclared_node_still_compares_exactly(self):
        """The same pair, with nothing declared. Empty by default is the strict
        end, and every shipped language is at it."""
        wide = "the quick brown fox jumps\nover the lazy dog"
        narrow = "the quick brown\nfox jumps over\nthe lazy dog"
        self.assertNotEqual(
            signature_of(paragraph(wide), wide),
            signature_of(paragraph(narrow), narrow),
        )

    def test_deleting_a_word_is_still_destruction(self):
        kept = "the quick brown fox"
        lost = "the quick fox"
        self.assertNotEqual(
            signature_of(paragraph(kept), kept, INLINE),
            signature_of(paragraph(lost), lost, INLINE),
        )

    def test_reordering_two_words_is_still_destruction(self):
        """A bag-of-words comparison would pass this. The two texts have the
        same words, the same count, and the same whitespace."""
        before = "the quick brown fox"
        after = "the brown quick fox"
        self.assertNotEqual(
            signature_of(paragraph(before), before, INLINE),
            signature_of(paragraph(after), after, INLINE),
        )

    def test_a_flattened_hard_break_is_still_destruction(self):
        """Two spaces before a newline is a Markdown hard break -- a line the
        author ended deliberately. Joining those lines changes the rendered
        output, so the break survives the canonicalisation as a newline."""
        broken = "one line ending in a break,  \nand the line after it"
        joined = "one line ending in a break, and the line after it"
        self.assertNotEqual(
            signature_of(paragraph(broken), broken, INLINE),
            signature_of(paragraph(joined), joined, INLINE),
        )

    def test_a_hard_break_survives_a_rewrap_around_it(self):
        """The other half of the same rule, and the one a hard-break-blind
        implementation also fails: the break is kept while the words on either
        side of it are free to move."""
        before = "alpha beta gamma  \ndelta epsilon zeta"
        after = "alpha beta\ngamma  \ndelta epsilon\nzeta"
        self.assertEqual(
            signature_of(paragraph(before), before, INLINE),
            signature_of(paragraph(after), after, INLINE),
        )

    def test_joining_two_words_is_still_destruction(self):
        """A gap must become *one space*, never nothing. Collapsing it to the
        empty string makes `alpha beta` compare equal to `alphabeta`, so a
        formatter that swallowed a word boundary would pass -- destruction
        wearing a re-wrap's clothes. Found by mutation; no other test here
        caught it, because every pair they compare keeps its boundaries."""
        spaced = "alpha beta gamma"
        run_together = "alphabeta gamma"
        self.assertNotEqual(
            signature_of(paragraph(spaced), spaced, INLINE),
            signature_of(paragraph(run_together), run_together, INLINE),
        )

    def test_one_trailing_space_is_not_a_hard_break(self):
        """The break rule is *two or more* spaces, and the boundary matters in
        the over-strict direction: a single space before a newline is ordinary
        soft-wrap trailing whitespace, which editors leave behind constantly. A
        rule of `one or more` would read it as a deliberate break and reject
        the re-wrap -- rejecting correct output, which this gate's own
        docstring calls wrong rather than strict. Found by mutation."""
        before = "alpha beta \ngamma delta"
        after = "alpha beta gamma\ndelta"
        self.assertEqual(
            signature_of(paragraph(before), before, INLINE),
            signature_of(paragraph(after), after, INLINE),
        )

    def test_a_no_break_space_is_content_not_a_gap(self):
        """U+00A0 is whitespace to `str.isspace` and to `\\s`, and is content
        here: an author who wrote one meant the words not to be separated. If
        it were in the gap class, replacing it with a plain space -- which
        *does* break -- would compare equal."""
        nbsp = "ten kilometres of it"
        plain = "ten kilometres of it"
        self.assertNotEqual(
            signature_of(paragraph(nbsp), nbsp, INLINE),
            signature_of(paragraph(plain), plain, INLINE),
        )

    def test_leading_and_trailing_space_does_not_count(self):
        """A re-wrap may leave the run flush or indented; neither is content."""
        flush = "alpha beta gamma"
        indented = "  alpha beta gamma  "
        self.assertEqual(
            signature_of(paragraph(flush), flush, INLINE),
            signature_of(paragraph(indented), indented, INLINE),
        )


class NotProseTests(unittest.TestCase):
    """The declaration is load-bearing, demonstrated rather than asserted."""

    SCALAR = "alpha beta\ngamma delta"
    FLAT = "alpha beta gamma delta"

    def test_a_yaml_block_scalar_body_is_rejected_today(self):
        """YAML declares no `prose_nodes`, so the newline between two lines of
        a literal block scalar -- which *is* the value -- still compares
        exactly. This is the behaviour the narrowing must not cost."""
        self.assertNotEqual(
            signature_of(Node("block_scalar", 0, len(self.SCALAR)), self.SCALAR),
            signature_of(Node("block_scalar", 0, len(self.FLAT)), self.FLAT),
        )

    def test_declaring_a_block_scalar_as_prose_would_destroy_it(self):
        """The counterexample, run rather than described. Declaring
        `block_scalar` makes a formatter free to collapse a two-line literal
        scalar to one line and gate 3 accepts it -- the exact regression
        `_tokens`'s docstring records from the first version of that function.

        This test passes today and must keep passing: it is not a bug report,
        it is the reason `prose_nodes` is per-language and empty by default. If
        it ever starts failing, someone has made the transform smart enough to
        tell layout from content, and this whole design should be revisited."""
        self.assertEqual(
            signature_of(Node("block_scalar", 0, len(self.SCALAR)), self.SCALAR,
                         frozenset({"block_scalar"})),
            signature_of(Node("block_scalar", 0, len(self.FLAT)), self.FLAT,
                         frozenset({"block_scalar"})),
        )

    def test_only_markdown_declares_its_projected_inline_kind(self):
        """The first consumer opts in narrowly; every other language retains
        the generic whitespace-sensitive signature."""
        import manifest as mf

        declared = {
            name: sorted(man.prose_nodes)
            for name, man in mf.load_all().items()
            if man.prose_nodes
        }
        self.assertEqual(declared, {"markdown": ["inline"]})


if __name__ == "__main__":
    unittest.main()
