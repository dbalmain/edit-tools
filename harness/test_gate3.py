"""The generic default's spelling comparison.

These run without tree-sitter, on the same hand-built `Node` fixture the
`check_gate3` tests use, because `test.sh` runs the harness suites with a plain
`python3` that has no grammars installed.
"""

import unittest
from pathlib import Path

import gate3
from test_check_gate3 import Node, make_manifest


def signature_of(node, source: str):
    manifest = make_manifest(Path("/nonexistent/x.toml"), "x", "default")
    return gate3._generic(
        node, source.encode(), manifest, {}, frozenset(), {}
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


if __name__ == "__main__":
    unittest.main()
