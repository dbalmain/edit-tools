#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""The review page's job is to make a defect visible, so that is what is tested."""

import unittest
from html.parser import HTMLParser

import review_page


def balanced(fragment: str) -> bool:
    class Check(HTMLParser):
        def __init__(self):
            super().__init__()
            self.stack = []
            self.ok = True

        def handle_starttag(self, tag, attrs):
            self.stack.append(tag)

        def handle_endtag(self, tag):
            if not self.stack or self.stack.pop() != tag:
                self.ok = False

    check = Check()
    check.feed(fragment)
    return check.ok and not check.stack


class PaintTests(unittest.TestCase):
    def test_a_span_covering_only_a_space_is_still_visible(self):
        """The `lambda` bug: a bare space painted `keyword`.

        A foreground-only rendering shows nothing at all here, which is exactly
        how four stray spans survived a review once.
        """
        lines = review_page.paint(
            "lambda x: x",
            [{"start": 0, "end": 7, "scope": "keyword"}],
            boundaries=True,
        )

        self.assertIn('class="ws"', lines[0])
        self.assertIn('data-scope="keyword"', lines[0])

    def test_a_span_crossing_a_line_break_is_clipped_per_line(self):
        """A triple-quoted string is one span over several lines.

        Painting the document and splitting on newlines afterwards leaves an
        unclosed tag on one line and a stray closing tag on the next.
        """
        text = 'x = """one\ntwo"""\n'
        lines = review_page.paint(text, [{"start": 4, "end": 17, "scope": "string"}])

        self.assertEqual(len(lines), 3)
        for line in lines:
            self.assertTrue(balanced(line), line)
        self.assertIn("one", lines[0])
        self.assertIn("two", lines[1])

    def test_a_span_past_the_end_of_the_text_is_ignored(self):
        lines = review_page.paint("ab", [{"start": 0, "end": 99, "scope": "keyword"}])

        self.assertEqual(lines, ["ab"])

    def test_unpainted_text_survives_escaping(self):
        lines = review_page.paint("a < b && c", [])

        self.assertEqual(lines, ["a &lt; b &amp;&amp; c"])

    def test_a_dotted_scope_takes_its_colour_from_the_base_scope(self):
        """Dotted scopes are prefix refinements, not separate vocabularies."""
        self.assertEqual(
            review_page._scope_class("string.documentation"),
            review_page._scope_class("string"),
        )


class DiffTests(unittest.TestCase):
    def test_rows_align_and_mark_only_what_changed(self):
        rows = review_page.diff_rows(["a", "X", "c"], ["a", "b", "c"])

        self.assertEqual([kind for _, _, kind in rows], ["same", "changed", "same"])
        self.assertEqual(rows[1][0], "X")
        self.assertEqual(rows[1][1], "b")

    def test_a_line_present_on_one_side_only_leaves_a_gap(self):
        rows = review_page.diff_rows(["a", "b"], ["a"])

        self.assertEqual(rows[-1], ("b", None, "changed"))


if __name__ == "__main__":
    unittest.main()
