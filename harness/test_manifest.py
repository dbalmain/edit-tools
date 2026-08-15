import tempfile
import unittest
from pathlib import Path

import manifest


BASE = """\
name = "json"
extensions = [".json"]
grammar = "tree-sitter-json==1.0.0"
grammar_module = "tree_sitter_json"
reference = "prettier --print-width {{width}}"
reference_version = "1.0.0"
reference_width = "flag"
widths = [88, 60]
gate3 = "default"
{declarations}
"""


class IntentionalDivergenceManifestTests(unittest.TestCase):
    def parse(self, declarations: str) -> manifest.Manifest:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "json.toml"
        path.write_text(BASE.format(declarations=declarations))
        return manifest.parse(path)

    def test_exact_file_width_and_reason_are_preserved(self):
        parsed = self.parse(
            'intentional_divergences = [{ file = "nested.json", width = 60, '
            'reason = "House containers break around nested containers." }]'
        )

        self.assertEqual(
            parsed.intentional_divergences,
            (
                manifest.IntentionalDivergence(
                    "nested.json",
                    60,
                    "House containers break around nested containers.",
                ),
            ),
        )

    def test_reason_must_not_be_blank(self):
        with self.assertRaisesRegex(
            manifest.ManifestError,
            r"json\.toml: `intentional_divergences\[0\]\.reason` must be",
        ):
            self.parse(
                'intentional_divergences = [{ file = "nested.json", width = 60, '
                'reason = "   " }]'
            )

    def test_width_must_be_measured(self):
        with self.assertRaisesRegex(
            manifest.ManifestError,
            r"json\.toml: `intentional_divergences\[0\]\.width` must be one of",
        ):
            self.parse(
                'intentional_divergences = [{ file = "nested.json", width = 72, '
                'reason = "A real reason." }]'
            )

    def test_duplicate_case_is_rejected(self):
        with self.assertRaisesRegex(manifest.ManifestError, "duplicates declaration"):
            self.parse(
                "intentional_divergences = ["
                '{ file = "nested.json", width = 60, reason = "First." },'
                '{ file = "nested.json", width = 60, reason = "Second." }]'
            )

    def test_file_must_be_a_normalised_relative_source_path(self):
        with self.assertRaisesRegex(manifest.ManifestError, "normalised relative path"):
            self.parse(
                'intentional_divergences = [{ file = "../nested.json", width = 60, '
                'reason = "A real reason." }]'
            )


if __name__ == "__main__":
    unittest.main()
