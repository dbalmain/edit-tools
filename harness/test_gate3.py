"""The generic default's spelling comparison.

These run without tree-sitter, on the same hand-built `Node` fixture the
`check_gate3` tests use, because `test.sh` runs the harness suites with a plain
`python3` that has no grammars installed.
"""

import unittest
from dataclasses import replace
from pathlib import Path

import gate3
from manifest import Injection
from test_check_gate3 import Node, make_manifest


def signature_of(node, source: str, layout: frozenset[str] = frozenset(),
                 whitespace: frozenset[str] = frozenset(),
                 prose: frozenset[str] = frozenset()):
    manifest = make_manifest(Path("/nonexistent/x.toml"), "x", "default")
    manifest = replace(manifest, whitespace_nodes=whitespace)
    return gate3._generic(
        node, source.encode(), manifest, {}, frozenset(), {}, layout, prose
    )


def empty_parens(source: str, open_at: int, close_at: int):
    """`parameter_list` holding only `(` and `)` -- no named children."""
    return Node(
        "parameter_list",
        open_at,
        close_at + 1,
        (
            Node("(", open_at, open_at + 1, named=False),
            Node(")", close_at, close_at + 1, named=False),
        ),
    )


class SpellingTests(unittest.TestCase):
    def test_whitespace_between_two_anonymous_tokens_is_not_significant(self):
        """gofmt rewrites `func f( )` to `func f()`, and the raw-span
        comparison rejected it. The same rejection reproduced on `{ }` in
        JSON, `[ ]` in TOML and `def f( )` in Python -- every language, latent
        until Go's corpus was the first to write one."""
        spaced = signature_of(empty_parens("f( )", 1, 3), "f( )")
        tight = signature_of(empty_parens("f()", 1, 2), "f()")
        self.assertEqual(spaced, tight)

    def test_a_true_leaf_keeps_its_text_byte_for_byte(self):
        """A node with no children at all is a token, and a formatter may not
        respell one. This is the property the change must not cost."""
        original = signature_of(Node("number", 0, 5), "1_000")
        respelled = signature_of(Node("number", 0, 4), "1000")
        self.assertNotEqual(original, respelled)

    def test_dropping_a_token_is_still_significant(self):
        """Whitespace goes; the tokens themselves do not."""
        pair = signature_of(empty_parens("( )", 0, 2), "( )")
        single = signature_of(
            Node("parameter_list", 0, 1, (Node("(", 0, 1, named=False),)), "("
        )
        self.assertNotEqual(pair, single)

    def test_source_the_grammar_did_not_tokenise_is_still_compared(self):
        """YAML's `block_scalar` is one anonymous `|` child with the whole body
        an untokenised gap. Returning only the child token texts made
        `d: |\\n  hello` equal `d: |\\n  goodbye` -- a formatter could rewrite a
        block scalar's contents and gate 3 would not notice. Destructive
        blindness is the one failure this gate exists to prevent."""
        def block_scalar(body: str):
            source = "|" + body
            return signature_of(
                Node(
                    "block_scalar",
                    0,
                    len(source),
                    (Node("|", 0, 1, named=False),),
                ),
                source,
            )

        self.assertNotEqual(block_scalar("\n  hello\n"), block_scalar("\n  goodbye\n"))

    def test_a_gap_that_is_only_whitespace_is_still_dropped(self):
        """The property the whole change exists for, stated against the same
        shape as the test above so the two cannot drift apart."""
        self.assertEqual(
            signature_of(empty_parens("( )", 0, 2), "( )"),
            signature_of(empty_parens("()", 0, 1), "()"),
        )

    def test_indentation_inside_an_untokenised_gap_is_content(self):
        """A block scalar's interior indentation is part of the data, which is
        why a reference that reindents one is unmatchable rather than merely
        inconvenient."""
        def block_scalar(body: str):
            source = "|" + body
            return signature_of(
                Node("block_scalar", 0, len(source),
                     (Node("|", 0, 1, named=False),)),
                source,
            )

        self.assertNotEqual(block_scalar("\n  hello\n"), block_scalar("\n    hello\n"))

    def test_a_token_tuple_is_described_as_a_spelling_not_as_children(self):
        """`_describe_generic` tells the two apart by their elements, since a
        node's children and a node's tokens are both tuples."""
        message = gate3._describe_generic(
            ("parameter_list", ("(", ")")),
            ("parameter_list", ("(", ",", ")")),
        )
        self.assertIn("leaf text", message)


class LayoutLeafTests(unittest.TestCase):
    """`layout_leaves`: kinds whose text is the formatter's to choose.

    Declared by markdown for pipe-table cells, which are padded to a computed
    column width, and for the ruler, whose dashes are that width drawn out.
    """

    CELLS = frozenset({"pipe_table_cell", "pipe_table_delimiter_cell"})

    def test_padding_a_declared_cell_is_layout(self):
        tight = signature_of(Node("pipe_table_cell", 0, 1), "a", self.CELLS)
        padded = signature_of(Node("pipe_table_cell", 0, 4), "a   ", self.CELLS)
        self.assertEqual(tight, padded)

    def test_a_rulers_length_is_layout_but_its_colons_are_not(self):
        short = signature_of(Node("pipe_table_delimiter_cell", 0, 3), ":-:", self.CELLS)
        long = signature_of(Node("pipe_table_delimiter_cell", 0, 7), ":-----:", self.CELLS)
        left = signature_of(Node("pipe_table_delimiter_cell", 0, 6), ":-----", self.CELLS)
        self.assertEqual(short, long)
        self.assertNotEqual(short, left)

    def test_the_cells_own_content_is_still_compared(self):
        one = signature_of(Node("pipe_table_cell", 0, 3), "a  ", self.CELLS)
        other = signature_of(Node("pipe_table_cell", 0, 3), "b  ", self.CELLS)
        self.assertNotEqual(one, other)

    def test_an_undeclared_kind_keeps_the_strict_comparison(self):
        tight = signature_of(Node("number", 0, 1), "1")
        padded = signature_of(Node("number", 0, 4), "1   ")
        self.assertNotEqual(tight, padded)


class ProseNodeTests(unittest.TestCase):
    PROSE = frozenset({"inline"})

    def inline(self, source: str, children=()):
        return signature_of(
            Node("inline", 0, len(source.encode()), children),
            source,
            prose=self.PROSE,
        )

    def test_soft_whitespace_inside_plain_prose_is_layout(self):
        self.assertEqual(self.inline("alpha beta"), self.inline("alpha\n  beta"))
        self.assertEqual(self.inline(" alpha beta "), self.inline("alpha beta"))

    def test_soft_whitespace_in_an_untokenized_token_gap_is_layout(self):
        flat = "alpha *beta gamma* omega"
        broken = "alpha *beta\n  gamma* omega"
        flat_stars = (Node("*", 6, 7, named=False), Node("*", 17, 18, named=False))
        broken_stars = (
            Node("*", 6, 7, named=False),
            Node("*", 19, 20, named=False),
        )
        self.assertEqual(self.inline(flat, flat_stars), self.inline(broken, broken_stars))

    def test_words_and_tokens_remain_exact(self):
        self.assertNotEqual(self.inline("alpha beta"), self.inline("alpha"))
        self.assertNotEqual(
            self.inline("alpha *beta*", (Node("*", 6, 7, named=False),
                                         Node("*", 11, 12, named=False))),
            self.inline("alpha _beta_", (Node("_", 6, 7, named=False),
                                         Node("_", 11, 12, named=False))),
        )

    def test_two_space_hard_break_is_not_a_soft_break(self):
        self.assertNotEqual(self.inline("alpha  \nbeta"), self.inline("alpha\nbeta"))

    def test_nonbreaking_space_is_content(self):
        self.assertNotEqual(self.inline("alpha\u00a0beta"), self.inline("alpha beta"))

    def test_backslash_hard_break_is_not_backslash_space(self):
        newline = "alpha\\\nbeta"
        spaced = "alpha\\ beta"
        slash = (Node("\\", 5, 6, named=False),)
        self.assertNotEqual(self.inline(newline, slash), self.inline(spaced, slash))

    def test_an_undeclared_node_keeps_soft_whitespace_exact(self):
        plain = signature_of(Node("inline", 0, 10), "alpha beta")
        broken = signature_of(Node("inline", 0, 10), "alpha\nbeta")
        self.assertNotEqual(plain, broken)


class WhitespaceNodeTests(unittest.TestCase):
    def document(self, prefix, kind="section", children=(), declared=True):
        body = "# Title\n"
        nodes = []
        if prefix:
            nodes.append(Node(kind, 0, len(prefix.encode()), children))
        start = len(prefix.encode())
        nodes.append(Node("section", start, start + len(body), (
            Node("heading", start, start + len(body)),
        )))
        return signature_of(Node("document", 0, start + len(body), tuple(nodes)),
                            prefix + body,
                            whitespace=frozenset({"section"}) if declared else frozenset())

    def test_only_declared_whitespace_leaves_can_disappear(self):
        self.assertEqual(self.document("\n\n\n"), self.document(""))
        self.assertNotEqual(self.document("\n\n\n", declared=False), self.document(""))
        self.assertNotEqual(self.document("\n", kind="string_content"), self.document(""))
        self.assertNotEqual(self.document("\u00a0\n"), self.document(""))

    def test_content_and_anonymous_syntax_still_count(self):
        self.assertNotEqual(self.document("paragraph\n"), self.document(""))
        self.assertNotEqual(self.document("#\n", children=(Node("#", 0, 1, named=False),)),
                            self.document(""))

    def test_a_node_containing_only_declared_trivia_matches_an_empty_node(self):
        blank = Node("document", 0, 2, (Node("section", 0, 2),))
        empty = Node("document", 0, 0)
        self.assertEqual(signature_of(blank, "\n\n", whitespace=frozenset({"section"})),
                         signature_of(empty, "", whitespace=frozenset({"section"})))

    def test_dropping_the_meaningful_section_is_still_destruction(self):
        empty = signature_of(Node("document", 0, 0), "", whitespace=frozenset({"section"}))
        self.assertNotEqual(self.document("\n\n\n"), empty)

    def test_a_whole_node_region_keeps_its_comments_only_via_comment_kinds(self):
        """Markdown declares `html_block` as a whole-node injection site (step
        3) *and* in `comment_kinds`. Only the second declaration keeps its
        comments visible to gate 3: `_extras` bails out on a whole-node region
        (`region.content == node`), so a site that is not also a comment kind
        contributes nothing.

        Declaring the site did not cost markdown anything, and that is what the
        first assertion pins: `comment_kinds` is tested before the region, so
        the child is harvested rather than descended into, and the count stayed
        at 40 across the change. Removing `comment_kinds` is loud rather than
        silent -- checked by hand, markdown's dropped-comment count falls 40 ->
        0 and `check_gate3.py` prints "arm inert" -- so the second assertion
        documents the boundary rather than guarding a silent failure.
        """
        base = make_manifest(Path("/nonexistent/x.toml"), "x", "default")
        site = Injection(node="html_block", guest="x", format=False)
        source = b"<!-- c -->"
        root = Node("document", 0, 10, (Node("html_block", 0, 10),))

        declared = replace(base, comment_kinds=("html_block",), injections=(site,))
        self.assertEqual(
            gate3._extras(root, source, declared, {"x": base}, []), ["<!-- c -->"]
        )

        undeclared = replace(base, injections=(site,))
        self.assertEqual(gate3._extras(root, source, undeclared, {"x": base}, []), [])

    def test_a_host_cannot_discard_a_whitespace_injection_boundary(self):
        manifest = make_manifest(Path("/nonexistent/x.toml"), "x", "default")
        for site in (Injection(node="host", content="payload", guest="x"),
                     Injection(node="payload", guest="x")):
            host = replace(manifest, whitespace_nodes=frozenset({"payload"}),
                           injections=(site,))
            root = Node("host", 0, 1, (Node("payload", 0, 1),))
            with_region = gate3.generic_part_from_root(root, b"\n", host, {"x": manifest})
            without = gate3.generic_part_from_root(Node("host", 0, 0), b"", host,
                                                  {"x": manifest})
            self.assertNotEqual(with_region, without)


if __name__ == "__main__":
    unittest.main()
