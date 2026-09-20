import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import injection
import manifest
import ts_injections


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

    def test_non_formatting_site_reaches_javascript_config(self):
        parsed = self.parse(
            'injections = [{ node = "html_block", guest = "json", '
            'format = false }]\n'
        )

        config = ts_injections.config({parsed.name: parsed}, Path("missing-blobs"))

        self.assertEqual(
            config["sites"]["json"],
            [{
                "node": "html_block",
                "info": None,
                "content": None,
                "guest": "json",
                "format": False,
            }],
        )

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


class SecondaryGrammarManifestTests(unittest.TestCase):
    def parse(self, extra: str = "") -> manifest.Manifest:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "json.toml"
        path.write_text(BASE + extra)
        return manifest.parse(path)

    def test_omitted_declaration_is_empty(self):
        self.assertEqual(self.parse().secondary_grammars, ())

    def test_declaration_preserves_artifact_symbol_and_host_node(self):
        parsed = self.parse(
            'secondary_grammars = [{ name = "json_strings", '
            'grammar_symbol = "strings_language", within = "string" }]\n'
        )
        self.assertEqual(
            parsed.secondary_grammars,
            (manifest.SecondaryGrammar("json_strings", "strings_language", "string"),),
        )

    def test_declaration_requires_exact_nonempty_fields(self):
        cases = (
            'secondary_grammars = [{ name = "json_strings", within = "string" }]\n',
            'secondary_grammars = [{ name = "json_strings", '
            'grammar_symbol = "strings_language", within = "" }]\n',
            'secondary_grammars = [{ name = "json_strings", '
            'grammar_symbol = "strings_language", within = "string", extra = 1 }]\n',
            'secondary_grammars = [{ name = "JSON-strings", '
            'grammar_symbol = "strings_language", within = "string" }]\n',
        )
        for declaration in cases:
            with self.subTest(declaration=declaration):
                with self.assertRaises(manifest.ManifestError):
                    self.parse(declaration)

    def test_names_and_host_nodes_are_unique_per_manifest(self):
        declarations = (
            'secondary_grammars = ['
            '{ name = "json_strings", grammar_symbol = "a", within = "string" }, '
            '{ name = "json_strings", grammar_symbol = "b", within = "number" }]\n',
            'secondary_grammars = ['
            '{ name = "json_strings", grammar_symbol = "a", within = "string" }, '
            '{ name = "json_numbers", grammar_symbol = "b", within = "string" }]\n',
        )
        for declaration in declarations:
            with self.subTest(declaration=declaration):
                with self.assertRaises(manifest.ManifestError):
                    self.parse(declaration)


class FormattedGuestsTests(unittest.TestCase):
    """The scoring graph uses the same alias lookup as `injection.region_for`."""

    def parse(
        self, name: str, extra: str = "", aliases: str | None = None
    ) -> manifest.Manifest:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / f"{name}.toml"
        text = BASE.replace('name = "json"', f'name = "{name}"').replace(
            'injection_aliases = ["json"]',
            f"injection_aliases = {aliases or f'[{name!r}]'}",
        )
        path.write_text(text + extra)
        return manifest.parse(path)

    def test_an_info_site_can_resolve_to_any_alias(self):
        host = self.parse(
            "markdown",
            extra=(
                'injections = [{ node = "fenced_code_block", '
                'info = "info_string", content = "code_fence_content" }]\n'
            ),
            aliases='["markdown", "md"]',
        )
        json_m = self.parse("json")
        aliases = manifest.injection_map({"markdown": host, "json": json_m})

        self.assertEqual(
            manifest.formatted_guests(host, aliases), frozenset({"markdown", "json"})
        )

    def test_a_guest_field_is_looked_up_as_an_alias(self):
        host = self.parse(
            "markdown",
            extra='injections = [{ node = "minus_metadata", guest = "yml" }]\n',
        )
        yaml_m = self.parse("yaml", aliases='["yaml", "yml"]')
        aliases = manifest.injection_map({"markdown": host, "yaml": yaml_m})

        self.assertEqual(manifest.formatted_guests(host, aliases), frozenset({"yaml"}))

    def test_an_opaque_site_is_not_a_formatted_guest(self):
        host = self.parse(
            "markdown",
            extra=(
                'injections = [{ node = "html_block", guest = "html", '
                "format = false }]\n"
            ),
        )
        html = self.parse("html")
        aliases = manifest.injection_map({"markdown": host, "html": html})

        self.assertEqual(manifest.formatted_guests(host, aliases), frozenset())

    def test_an_unknown_guest_alias_is_not_a_guest(self):
        host = self.parse(
            "markdown",
            extra='injections = [{ node = "minus_metadata", guest = "yaml" }]\n',
        )
        aliases = manifest.injection_map({"markdown": host})

        self.assertEqual(manifest.formatted_guests(host, aliases), frozenset())

    def test_roster_markdown_formats_every_aliased_language(self):
        """An info site is a capability edge, not a corpus-content edge."""
        manifests = manifest.load_all()
        aliases = manifest.injection_map(manifests)

        self.assertEqual(
            manifest.formatted_guests(manifests["markdown"], aliases),
            frozenset(manifests),
        )


class TriviaKindsManifestTests(unittest.TestCase):
    def parse(self, extra: str = "") -> manifest.Manifest:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "json.toml"
        path.write_text(BASE + extra)
        return manifest.parse(path)

    def test_omitted_comment_kinds_are_empty(self):
        self.assertEqual(self.parse().comment_kinds, ())

    def test_comment_kinds_are_preserved(self):
        parsed = self.parse('comment_kinds = ["Comment", "html_block"]\n')
        self.assertEqual(parsed.comment_kinds, ("Comment", "html_block"))

    def test_comment_kinds_must_be_non_empty_strings(self):
        with self.assertRaisesRegex(manifest.ManifestError, "non-empty string"):
            self.parse('comment_kinds = [""]\n')

    def test_whitespace_nodes_default_to_empty_and_preserve_declarations(self):
        self.assertEqual(self.parse().whitespace_nodes, frozenset())
        self.assertEqual(self.parse('whitespace_nodes = ["section"]\n').whitespace_nodes,
                         frozenset({"section"}))

    def test_whitespace_nodes_require_a_list_and_cannot_hide_comments(self):
        for value in ('"section"', '[1]', '{}'):
            with self.assertRaisesRegex(manifest.ManifestError, "list of node kinds"):
                self.parse(f'whitespace_nodes = {value}\n')
        with self.assertRaisesRegex(manifest.ManifestError, "must not overlap"):
            self.parse('whitespace_nodes = ["comment"]\ncomment_kinds = ["comment"]\n')

    def test_prose_nodes_default_to_empty_and_preserve_declarations(self):
        """Empty is the strict end, and every shipped language is at it: the
        narrowing has no reachable call site until a package opts in."""
        self.assertEqual(self.parse().prose_nodes, frozenset())
        self.assertEqual(self.parse('prose_nodes = ["inline"]\n').prose_nodes,
                         frozenset({"inline"}))

    def test_prose_nodes_require_a_list_of_kinds(self):
        for value in ('"inline"', '[1]', '{}', '[""]'):
            with self.assertRaisesRegex(manifest.ManifestError, "list of node kinds"):
                self.parse(f'prose_nodes = {value}\n')

    def test_prose_prefix_nodes_default_to_empty_and_preserve_declarations(self):
        self.assertEqual(self.parse().prose_prefix_nodes, frozenset())
        parsed = self.parse('prose_prefix_nodes = ["block_continuation"]\n')
        self.assertEqual(
            parsed.prose_prefix_nodes,
            frozenset({"block_continuation"}),
        )

    def test_prose_prefix_nodes_require_a_list_of_kinds(self):
        for value in ('"block_continuation"', '[1]', '{}', '[""]'):
            with self.assertRaisesRegex(manifest.ManifestError, "list of node kinds"):
                self.parse(f'prose_prefix_nodes = {value}\n')

    def test_prose_nodes_cannot_claim_a_comment_kind(self):
        """Comments are compared verbatim by the universal extras layer, which
        never consults this field. A kind in both would read as a permission
        that layer will not honour -- a declaration whose effect is nothing."""
        with self.assertRaisesRegex(manifest.ManifestError, "must not overlap"):
            self.parse('prose_nodes = ["comment"]\ncomment_kinds = ["comment"]\n')

    def test_prose_nodes_cannot_also_be_whitespace(self):
        """A whitespace node is dropped wholesale; a prose node has its gaps
        canonicalised and its words kept. Declaring both is incoherent, and
        `_whitespace_node` runs first, so the prose declaration would be the
        silent loser."""
        with self.assertRaisesRegex(manifest.ManifestError, "must not overlap"):
            self.parse('prose_nodes = ["inline"]\nwhitespace_nodes = ["inline"]\n')


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


class CorpusThresholdManifestTests(unittest.TestCase):
    def parse(self, extra: str = "") -> manifest.Manifest:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "json.toml"
        path.write_text(BASE + extra)
        return manifest.parse(path)

    def test_omitted_table_keeps_universal_defaults(self):
        self.assertEqual(self.parse().corpus_thresholds, {})

    def test_floor_carries_its_reference_reason(self):
        parsed = self.parse(
            "\n[corpus_thresholds.width_sensitive]\n"
            "minimum_files = 4\n"
            'reason = "reference reflows arrays only"\n'
        )

        self.assertEqual(
            parsed.corpus_thresholds["width_sensitive"],
            manifest.CorpusThreshold(4, "reference reflows arrays only"),
        )

    def test_inapplicable_threshold_carries_its_reference_reason(self):
        parsed = self.parse(
            "\n[corpus_thresholds.comments]\n"
            "inapplicable = true\n"
            'reason = "the language has no comment syntax"\n'
        )

        self.assertEqual(
            parsed.corpus_thresholds["comments"],
            manifest.CorpusThreshold(None, "the language has no comment syntax"),
        )

    def test_bare_or_zero_waiver_is_rejected(self):
        cases = (
            '[corpus_thresholds.comments]\nreason = "why"\n',
            '[corpus_thresholds.comments]\nminimum_files = 0\nreason = "why"\n',
        )
        for declaration in cases:
            with self.subTest(declaration=declaration):
                with self.assertRaises(manifest.ManifestError):
                    self.parse("\n" + declaration)

    def test_reason_is_required(self):
        with self.assertRaisesRegex(manifest.ManifestError, "reason"):
            self.parse(
                "\n[corpus_thresholds.width_sensitive]\nminimum_files = 4\n"
            )

    def test_unknown_metric_is_rejected(self):
        with self.assertRaisesRegex(manifest.ManifestError, "unknown metric"):
            self.parse(
                "\n[corpus_thresholds.reference_changes]\n"
                "minimum_files = 1\n"
                'reason = "why"\n'
            )

    def test_live_declarations_name_reference_limits(self):
        loaded = manifest.load_all()

        self.assertIsNone(
            loaded["json"].corpus_thresholds["comments"].minimum_files
        )
        markdown = loaded["markdown"].corpus_thresholds["width_sensitive"]
        self.assertEqual(markdown.minimum_files, 18)
        self.assertIn("proseWrap=always", markdown.reason)
        toml = loaded["toml"].corpus_thresholds["width_sensitive"]
        self.assertEqual(toml.minimum_files, 4)
        self.assertIn("arrays only", toml.reason)


if __name__ == "__main__":
    unittest.main()


class DuplicateInjectionNodeTests(unittest.TestCase):
    """One injection per host node, because the two readers would disagree.

    `injection.region_for` takes the first declaration for a node;
    `manifest.formatted_guests` accumulates every one. A duplicate is therefore
    a host that `awaiting_package` believes depends on a guest the formatter
    can never route to.
    """

    def parse(self, extra: str) -> manifest.Manifest:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "markdown.toml"
        path.write_text(
            "\n".join(
                (
                    'name = "markdown"',
                    'extensions = [".md"]',
                    'grammar = "tree-sitter-x==1.0.0"',
                    'grammar_module = "tree_sitter_x"',
                    'injection_aliases = ["markdown"]',
                    'reference = "fmt --width {width}"',
                    'reference_version = "1.0.0"',
                    'reference_width = "flag"',
                    "widths = [80]",
                    'gate3 = "default"',
                    extra,
                )
            )
        )
        return manifest.parse(path)

    SITE = (
        "[[injections]]\n"
        'node = "fenced_code_block"\n'
        '{route}\n'
        'content = "code_fence_content"\n'
    )

    def test_two_declarations_for_one_node_are_refused(self):
        with self.assertRaises(manifest.ManifestError) as caught:
            self.parse(
                self.SITE.format(route='info = "info_string"')
                + self.SITE.format(route='guest = "json"')
            )

        self.assertIn("fenced_code_block", str(caught.exception))
        self.assertIn("already", str(caught.exception))

    def test_two_declarations_for_different_nodes_are_fine(self):
        """The discriminating case: the rule is per node, not per manifest."""
        parsed = self.parse(
            self.SITE.format(route='info = "info_string"')
            + self.SITE.format(route='guest = "yaml"').replace(
                "fenced_code_block", "minus_metadata"
            )
        )

        self.assertEqual(
            [site.node for site in parsed.injections],
            ["fenced_code_block", "minus_metadata"],
        )
