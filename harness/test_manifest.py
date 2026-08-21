import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import injection
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

    def test_guest_routed_host_node_is_valid(self):
        parsed = self.parse(
            'injections = [{ node = "minus_metadata", guest = "yaml" }]\n'
        )

        self.assertEqual(
            parsed.injections,
            (manifest.Injection(node="minus_metadata", guest="yaml"),),
        )

        node = SimpleNamespace(
            type="minus_metadata",
            start_byte=0,
            end_byte=len(b"title: demo"),
            children=[],
        )
        region = injection.region_for(node, b"title: demo", parsed, {"yaml": parsed})
        self.assertIs(region.content, node)
        self.assertEqual(region.source, b"title: demo")
        self.assertIs(region.guest, parsed)

    def test_info_and_guest_are_rejected(self):
        with self.assertRaisesRegex(
            manifest.ManifestError, "exactly one of `info` or `guest`"
        ):
            self.parse(
                'injections = [{ node = "script_element", info = "info_string", '
                'content = "raw_text", guest = "javascript" }]\n'
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

    def test_the_six_languages_that_predate_the_field_declare_none(self):
        """The field was added after these six were merged and none of them
        needed it. Naming them keeps that true without forbidding the field to
        every language onboarded afterwards -- kotlin and rust are both
        legitimate users, and the original blanket assertion made declaring it
        a test failure.

        Pinning the six by name rather than special-casing each new user is
        deliberate: this assertion is about the six, and it should not need
        editing again every time a language earns the field."""
        predating = {"css", "go", "json", "python", "toml", "yaml"}
        loaded = manifest.load_all()
        self.assertGreaterEqual(len(loaded), 6)
        self.assertTrue(predating <= set(loaded), predating - set(loaded))
        for name in sorted(predating):
            self.assertEqual(loaded[name].incomparable, {}, name)


if __name__ == "__main__":
    unittest.main()
