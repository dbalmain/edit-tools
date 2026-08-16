"""Focused evidence for YAML's default-and-extra gate-3 override."""

import unittest

from languages import yaml_gate3
from test_check_gate3 import Node


def keep_tree(source: str) -> Node:
    start = source.index("|+")
    end = source.index("\n", source.index("keep blanks"))
    scalar = Node(
        "block_scalar",
        start,
        end,
        (Node("|", start, start + 2, named=False),),
    )
    return Node("stream", 0, len(source), (scalar,))


class YamlChompSignatureTests(unittest.TestCase):
    def test_old_broken_output_loses_one_kept_line_ending(self):
        source = "keep: |+\n  keep blanks\n\n\nnext: 1\n"
        broken = "keep: |+\n  keep blanks\n\nnext: 1\n"
        before = yaml_gate3.chomp_part(keep_tree(source), source.encode())
        after = yaml_gate3.chomp_part(keep_tree(broken), broken.encode())
        self.assertEqual(before, ((b"\n", b"\n", b"\n"),))
        self.assertEqual(after, ((b"\n", b"\n"),))
        self.assertNotEqual(before, after)

    def test_empty_scalar_does_not_count_the_header_terminator(self):
        source = "x: |+\n\nnext: 1\n"
        start = source.index("|+")
        scalar = Node(
            "block_scalar",
            start,
            start + 2,
            (Node("|", start, start + 2, named=False),),
        )
        root = Node("stream", 0, len(source), (scalar,))
        self.assertEqual(yaml_gate3.chomp_part(root, source.encode()), ((b"\n",),))


if __name__ == "__main__":
    unittest.main()
