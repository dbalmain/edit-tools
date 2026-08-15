import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import score_highlight as scorer


class PartitionTests(unittest.TestCase):
    def test_collects_root_and_nested_languages(self):
        tree = {
            "language": "outer",
            "root": {
                "type": "document",
                "language": "middle",
                "children": [
                    {"type": "leaf", "language": "inner"},
                    {"type": "leaf"},
                ],
            },
        }

        self.assertEqual(
            scorer.tree_languages(tree), {"outer", "middle", "inner"}
        )

    def test_accepts_utf8_byte_offsets_and_whitespace_gaps(self):
        spans = [{"start": 0, "end": 4, "scope": "string"}]

        self.assertIsNone(scorer.partition_error(spans, {"string"}, "🙂 "))

    def test_rejects_each_partition_violation(self):
        cases = {
            "range": (
                [{"start": 0, "end": 0, "scope": "a"}],
                "a",
                "invalid range",
            ),
            "outside": (
                [{"start": 0, "end": 2, "scope": "a"}],
                "a",
                "outside",
            ),
            "unlisted": (
                [{"start": 0, "end": 1, "scope": "missing"}],
                "a",
                "unlisted",
            ),
            "order": (
                [
                    {"start": 1, "end": 2, "scope": "a"},
                    {"start": 0, "end": 1, "scope": "b"},
                ],
                "ab",
                "out of order",
            ),
            "overlap": (
                [
                    {"start": 0, "end": 2, "scope": "a"},
                    {"start": 1, "end": 3, "scope": "b"},
                ],
                "abc",
                "overlaps",
            ),
            "merged": (
                [
                    {"start": 0, "end": 1, "scope": "a"},
                    {"start": 1, "end": 2, "scope": "a"},
                ],
                "ab",
                "not merged",
            ),
        }
        for name, (spans, source, expected) in cases.items():
            with self.subTest(name=name):
                problem = scorer.partition_error(spans, {"a", "b"}, source)
                self.assertIn(expected, problem)

    def test_whitespace_advisory_groups_bare_and_trailing_runs_by_scope(self):
        spans = [
            {"start": 0, "end": 1, "scope": "error"},
            {"start": 1, "end": 3, "scope": "keyword"},
            {"start": 3, "end": 4, "scope": "variable"},
        ]

        self.assertEqual(
            scorer.whitespace_spans(spans, " x y"),
            {
                "entirely": {
                    "error": [{"start": 0, "end": 1, "text": " "}]
                },
                "trailing": {
                    "keyword": [{"start": 1, "end": 3, "text": "x "}]
                },
            },
        )


class ScoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.trees = self.root / "trees"
        self.dirty = self.root / "trees-dirty"
        self.goldens = self.root / "highlight"
        self.submission = self.root / "submission"
        self.trees.mkdir()
        self.dirty.mkdir()
        (self.submission / "packages").mkdir(parents=True)
        self.tree = self.trees / "toy__sample.tree.json"
        self.tree.write_text(
            json.dumps(
                {
                    "language": "toy",
                    "source": "x",
                    "root": {"type": "identifier", "start": 0, "end": 1},
                }
            )
        )
        self.globals = (
            mock.patch.object(scorer, "TREE_DIRS", (self.trees, self.dirty)),
            mock.patch.object(scorer, "GOLDENS", self.goldens),
        )

    def test_missing_package_is_reported_without_failing(self):
        with (
            self.globals[0],
            self.globals[1],
            mock.patch.object(scorer, "invoke") as invoke,
        ):
            report = scorer.score(self.submission, None, update=False, verbose=True)

        invoke.assert_not_called()
        self.assertFalse(report.failed)
        self.assertEqual(report.trees["highlighted"], 0)
        self.assertEqual(
            report.trees["unhighlighted"],
            [{"tree": self.tree.name, "language": "toy"}],
        )

    def test_update_writes_only_an_identical_valid_stream(self):
        package = self.submission / "packages" / "toy.highlight.json"
        package.write_text(json.dumps({"scopes": ["variable"]}))
        output = b'[{"start":0,"end":1,"scope":"variable"}]\n'
        run = scorer.Run(ok=True, output=output)
        with (
            self.globals[0],
            self.globals[1],
            mock.patch.object(scorer, "invoke", side_effect=[run, run]),
        ):
            report = scorer.score(self.submission, None, update=True, verbose=True)

        golden = self.goldens / "toy__sample.spans.json"
        self.assertFalse(report.failed)
        self.assertEqual(report.updated, [golden.name])
        self.assertEqual(json.loads(golden.read_text()), json.loads(output))

    def test_missing_root_package_uses_a_known_nested_package(self):
        self.tree.write_text(
            json.dumps(
                {
                    "language": "outer",
                    "source": "x",
                    "root": {
                        "type": "identifier",
                        "language": "toy",
                        "start": 0,
                        "end": 1,
                    },
                }
            )
        )
        package = self.submission / "packages" / "toy.highlight.json"
        package.write_text(json.dumps({"scopes": ["variable"]}))
        output = b'[{"start":0,"end":1,"scope":"variable"}]\n'
        run = scorer.Run(ok=True, output=output)
        with (
            self.globals[0],
            self.globals[1],
            mock.patch.object(scorer, "invoke", side_effect=[run, run]) as invoke,
        ):
            report = scorer.score(self.submission, None, update=True, verbose=True)

        self.assertFalse(report.failed)
        self.assertEqual(report.trees["highlighted"], 1)
        self.assertEqual(report.trees["unhighlighted"], [])
        self.assertEqual(invoke.call_args_list[0].args[2], {"toy": package})

    def test_identity_failure_does_not_bless_a_golden(self):
        package = self.submission / "packages" / "toy.highlight.json"
        package.write_text(json.dumps({"scopes": ["variable"]}))
        rust = scorer.Run(ok=True, output=b"[]\n")
        js = scorer.Run(ok=True, output=b"[ ]\n")
        with (
            self.globals[0],
            self.globals[1],
            mock.patch.object(scorer, "invoke", side_effect=[rust, js]),
        ):
            report = scorer.score(self.submission, None, update=True, verbose=True)

        self.assertTrue(report.failed)
        self.assertFalse(self.goldens.exists())

    def test_whitespace_findings_are_advisory_not_a_gate(self):
        self.tree.write_text(
            json.dumps(
                {
                    "language": "toy",
                    "source": "x ",
                    "root": {"type": "identifier", "start": 0, "end": 2},
                }
            )
        )
        package = self.submission / "packages" / "toy.highlight.json"
        package.write_text(json.dumps({"scopes": ["variable"]}))
        output = b'[{"start":0,"end":2,"scope":"variable"}]\n'
        run = scorer.Run(ok=True, output=output)
        with (
            self.globals[0],
            self.globals[1],
            mock.patch.object(scorer, "invoke", side_effect=[run, run]),
        ):
            report = scorer.score(self.submission, None, update=True, verbose=True)

        self.assertFalse(report.failed)
        self.assertEqual(
            report.advisory["whitespace"]["trailing"]["variable"],
            [
                {
                    "tree": self.tree.name,
                    "start": 0,
                    "end": 2,
                    "text": "x ",
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
