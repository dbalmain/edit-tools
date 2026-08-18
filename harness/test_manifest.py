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


class IncomparableManifestTests(unittest.TestCase):
    """A table keyed by filename, so a reason cannot drift off its file."""

    def parse(self, extra: str = "") -> manifest.Manifest:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "json.toml"
        path.write_text(BASE + extra)
        return manifest.parse(path)

    def test_omitted_table_is_empty(self):
        self.assertEqual(self.parse().incomparable, {})

    def test_table_records_the_reason(self):
        parsed = self.parse(
            '\n[incomparable]\n"basic.json" = "prettier re-quotes to minimise escaping"\n'
        )
        self.assertEqual(
            parsed.incomparable,
            {"basic.json": "prettier re-quotes to minimise escaping"},
        )

    def test_empty_reason_is_a_manifest_error(self):
        with self.assertRaisesRegex(manifest.ManifestError, "non-empty reason"):
            self.parse('\n[incomparable]\n"basic.json" = ""\n')

    def test_whitespace_only_reason_is_a_manifest_error(self):
        with self.assertRaisesRegex(manifest.ManifestError, "non-empty reason"):
            self.parse('\n[incomparable]\n"basic.json" = "   "\n')

    def test_list_instead_of_table_is_a_manifest_error(self):
        with self.assertRaisesRegex(manifest.ManifestError, "must be a table"):
            self.parse('\nincomparable = ["basic.json"]\n')

    def test_missing_file_is_a_manifest_error(self):
        with self.assertRaisesRegex(manifest.ManifestError, "does not exist"):
            self.parse(
                '\n[incomparable]\n"no-such-file.json" = '
                '"prettier rewrites this"\n'
            )

    def test_path_key_is_a_manifest_error(self):
        with self.assertRaisesRegex(manifest.ManifestError, "not a path"):
            self.parse(
                '\n[incomparable]\n"subdir/basic.json" = "reason"\n'
            )

    def test_extension_must_match_the_language(self):
        with self.assertRaisesRegex(manifest.ManifestError, "extensions"):
            self.parse('\n[incomparable]\n"basic.txt" = "reason"\n')

    def test_merged_languages_declare_none(self):
        """The field landed empty; rust is the first language to use it.

        The six languages the field-addition slice touched still declare none.
        rust's `leading_pipes.rs` is the first legitimate use and must be the
        only one.
        """
        loaded = manifest.load_all()
        self.assertGreaterEqual(len(loaded), 6)
        for name, parsed in loaded.items():
            if name == "rust":
                self.assertEqual(list(parsed.incomparable), ["leading_pipes.rs"], name)
                continue
            self.assertEqual(parsed.incomparable, {}, name)


if __name__ == "__main__":
    unittest.main()
