import tempfile
import unittest
from pathlib import Path

import manifest


BASE = """\
name = "json"
extensions = [".json"]
grammar = "tree-sitter-json==1.0.0"
grammar_module = "tree_sitter_json"
injection_aliases = ["json"]
reference = "prettier --print-width {{width}}"
reference_version = "1.0.0"
reference_width = "flag"
widths = [88, 60]
gate3 = "default"
"""


class InjectionManifestTests(unittest.TestCase):
    def parse(self, extra: str = "", aliases: str = '["json"]') -> manifest.Manifest:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "json.toml"
        text = (BASE + extra).replace(
            'injection_aliases = ["json"]', f"injection_aliases = {aliases}"
        )
        path.write_text(text)
        return manifest.parse(path)

    def test_aliases_and_host_shapes_are_preserved(self):
        parsed = self.parse(
            'injections = [{ node = "fenced_code_block", info = "info_string", '
            'content = "code_fence_content" }]\n'
        )

        self.assertEqual(parsed.injection_aliases, ("json",))
        self.assertEqual(
            parsed.injections,
            (
                manifest.Injection(
                    "fenced_code_block", "info_string", "code_fence_content"
                ),
            ),
        )

    def test_alias_cannot_contain_whitespace(self):
        with self.assertRaisesRegex(
            manifest.ManifestError, "containing no whitespace"
        ):
            self.parse(aliases='["json lines"]')

    def test_duplicate_alias_across_manifests_is_rejected(self):
        first = self.parse()
        second = manifest.Manifest(
            **{
                **first.__dict__,
                "name": "other",
                "path": first.path.with_name("other.toml"),
            }
        )

        with self.assertRaisesRegex(manifest.ManifestError, "already declared"):
            manifest.injection_map({"json": first, "other": second})


if __name__ == "__main__":
    unittest.main()
