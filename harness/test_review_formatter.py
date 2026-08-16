import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import manifest
import review_formatter
import score


class FormatterViewerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.reference = self.root / "reference"
        self.reference.mkdir()
        self.tree = self.root / "json__nested.tree.json"
        self.tree.write_text(
            json.dumps(
                {
                    "source_file": "corpus/src/json/nested.json",
                    "root": {"text": "source"},
                }
            )
        )
        manifest_path = self.root / "json.toml"
        manifest_path.write_text(
            "\n".join(
                (
                    'name = "json"',
                    'extensions = [".json"]',
                    'grammar = "tree-sitter-json==1.0.0"',
                    'grammar_module = "tree_sitter_json"',
                    'injection_aliases = ["json"]',
                    'reference = "prettier --print-width {width}"',
                    'reference_version = "1.0.0"',
                    'reference_width = "flag"',
                    'widths = [60]',
                    'gate3 = "default"',
                )
            )
        )
        self.manifest = manifest.parse(manifest_path)

    def test_emits_one_complete_record_per_difference(self):
        (self.reference / "json__nested@60.txt").write_text("reference\n")
        with (
            mock.patch.object(score, "REFERENCE", self.reference),
            mock.patch.object(
                score, "invoke", return_value=score.Run(ok=True, text="ours\n")
            ),
        ):
            records, problems = review_formatter.divergences(
                self.root, [(self.tree, self.manifest)]
            )

        self.assertEqual(problems, [])
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record.id, "json/nested.json@60")
        self.assertEqual(record.our_output, "ours\n")
        self.assertEqual(record.reference_output, "reference\n")
        self.assertTrue(record.unified_diff)
        self.assertEqual(len(record.hash), 64)


if __name__ == "__main__":
    unittest.main()
