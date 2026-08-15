import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import manifest
import score


class IntentionalDivergenceScoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.reference = self.root / "reference"
        self.reference.mkdir()
        self.tree = self.root / "json__sample.tree.json"
        self.tree.write_text(
            json.dumps(
                {
                    "source_file": "corpus/src/json/sample.json",
                    "root": {"text": "source"},
                }
            )
        )
        for width in (88, 60):
            (self.reference / f"json__sample@{width}.txt").write_text("reference")

    def manifest(self, file: str = "sample.json") -> manifest.Manifest:
        path = self.root / "json.toml"
        path.write_text(
            "\n".join(
                (
                    'name = "json"',
                    'extensions = [".json"]',
                    'grammar = "tree-sitter-json==1.0.0"',
                    'grammar_module = "tree_sitter_json"',
                    'reference = "prettier --print-width {width}"',
                    'reference_version = "1.0.0"',
                    'reference_width = "flag"',
                    'widths = [88, 60]',
                    'gate3 = "default"',
                    "intentional_divergences = [",
                    f'  {{ file = "{file}", width = 60, reason = "House rule." }},',
                    "]",
                )
            )
        )
        return manifest.parse(path)

    def classify(self, outputs: dict[int, score.Run], m=None):
        m = m or self.manifest()

        def invoke(_exe, _tree, width):
            return outputs[width]

        with (
            mock.patch.object(score, "REFERENCE", self.reference),
            mock.patch.object(score, "invoke", side_effect=invoke),
        ):
            return score.reference_agreement(self.root, [(self.tree, m)])

    def test_reports_three_outcomes_and_the_reason(self):
        report = self.classify(
            {
                88: score.Run(ok=True, text="reference"),
                60: score.Run(ok=True, text="house"),
            }
        )

        self.assertEqual(
            (report["agreement"], report["intentional"], report["unexplained"]),
            (1, 1, 0),
        )
        entry = report["by_language"]["json"]
        self.assertEqual(
            entry["intentional_divergences"],
            [{"case": "sample.json@60", "reason": "House rule."}],
        )
        self.assertEqual(entry["by_width"]["60"]["intentional"], 1)

    def test_declaration_that_now_agrees_is_stale(self):
        with self.assertRaisesRegex(manifest.ManifestError, "is stale"):
            self.classify(
                {
                    88: score.Run(ok=True, text="reference"),
                    60: score.Run(ok=True, text="reference"),
                }
            )

    def test_declaration_cannot_cover_refusal(self):
        with self.assertRaisesRegex(
            manifest.ManifestError, "cannot cover a formatter refusal"
        ):
            self.classify(
                {
                    88: score.Run(ok=True, text="reference"),
                    60: score.Run(ok=False, refused=True, error="no"),
                }
            )

    def test_declaration_requires_a_reference(self):
        (self.reference / "json__sample@60.txt").unlink()
        with self.assertRaisesRegex(manifest.ManifestError, "reference is missing"):
            self.classify(
                {
                    88: score.Run(ok=True, text="reference"),
                    60: score.Run(ok=True, text="house"),
                }
            )

    def test_declaration_requires_a_corpus_case(self):
        with self.assertRaisesRegex(manifest.ManifestError, "has no corpus comparison"):
            self.classify(
                {
                    88: score.Run(ok=True, text="reference"),
                    60: score.Run(ok=True, text="house"),
                },
                self.manifest("other.json"),
            )


if __name__ == "__main__":
    unittest.main()
