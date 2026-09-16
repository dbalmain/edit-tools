import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import formatter_divergence
import manifest
import review_ledger
import score


class ReviewLedgerScoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.reference = self.root / "reference"
        self.reviews = self.root / "reviews"
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

    def manifest(self) -> manifest.Manifest:
        path = self.root / "json.toml"
        path.write_text(
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
                    'widths = [88, 60]',
                    'gate3 = "default"',
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
            return score.reference_agreement(
                self.root, [(self.tree, m)], ledger_root=self.reviews
            )

    def approve(
        self,
        output: str = "house",
        item_id: str = "json/sample.json@60",
        verdict: str = "design limit",
    ):
        digest = formatter_divergence.make(
            "json", "sample.json", 60, output, "reference"
        ).hash
        review_ledger.approve(
            "formatter",
            "json",
            item_id,
            digest,
            verdict,
            "House containers break differently.",
            "reviewer@example.com",
            root=self.reviews,
            reviewed_at="2026-08-16T00:00:00Z",
        )

    def test_reports_unreviewed_then_accepted_with_review_metadata(self):
        outputs = {
            88: score.Run(ok=True, text="reference"),
            60: score.Run(ok=True, text="house"),
        }
        report = self.classify(outputs)
        self.assertEqual(
            (report["accepted"], report["stale"], report["unreviewed"], report["excluded"]),
            (0, 0, 1, 0),
        )
        self.assertFalse(report["review_threshold_met"])

        self.approve()
        ledger_before = (self.reviews / "formatter" / "json.jsonl").read_text()
        report = self.classify(
            outputs
        )

        self.assertEqual(
            (report["accepted"], report["stale"], report["unreviewed"]),
            (1, 0, 0),
        )
        entry = report["by_language"]["json"]
        self.assertEqual(
            entry["accepted_divergences"][0]["review"]["reviewed_by"],
            "reviewer@example.com",
        )
        self.assertEqual(entry["by_width"]["60"]["accepted"], 1)
        self.assertEqual(
            (self.reviews / "formatter" / "json.jsonl").read_text(), ledger_before
        )

    def test_shape_changing_divergence_is_stale_and_a_hard_failure(self):
        self.approve("first shape")
        report = self.classify(
            {
                88: score.Run(ok=True, text="reference"),
                60: score.Run(ok=True, text="different shape"),
            }
        )

        self.assertEqual(report["stale"], 1)
        self.assertEqual(
            report["by_language"]["json"]["stale_divergences"][0]["why"],
            "formatter divergence changed",
        )
        scored = score.Report(submission="submission")
        scored.gates = {"gate": {"pass": True}}
        scored.measures = {"6-reference-agreement": report}
        self.assertTrue(scored.disqualified)

    def test_package_bug_is_a_hard_failure(self):
        self.approve(verdict=review_ledger.DEFECT_VERDICT)
        report = self.classify(
            {
                88: score.Run(ok=True, text="reference"),
                60: score.Run(ok=True, text="house"),
            }
        )

        self.assertEqual((report["defect"], report["accepted"]), (1, 0))
        scored = score.Report(submission="submission")
        scored.gates = {"gate": {"pass": True}}
        scored.measures = {"6-reference-agreement": report}
        self.assertTrue(scored.disqualified)

    def test_review_that_now_agrees_is_stale(self):
        self.approve()
        report = self.classify(
            {
                88: score.Run(ok=True, text="reference"),
                60: score.Run(ok=True, text="reference"),
            }
        )

        self.assertEqual(report["stale"], 1)
        self.assertIn(
            "now agrees",
            report["by_language"]["json"]["stale_divergences"][0]["why"],
        )

    def test_review_cannot_cover_refusal(self):
        self.approve()
        report = self.classify(
            {
                88: score.Run(ok=True, text="reference"),
                60: score.Run(ok=False, refused=True, error="no"),
            }
        )

        self.assertEqual(report["stale"], 1)
        self.assertIn(
            "refuses",
            report["by_language"]["json"]["stale_divergences"][0]["why"],
        )

    def test_a_present_package_that_refuses_is_a_scored_failure_not_pending(self):
        """Only a missing file is pending. A refuse still enters the denominator."""
        packages = self.root / "packages"
        packages.mkdir()
        (packages / "json.json").write_text("{}")

        pending = score.awaiting_package(self.root, {"json": self.manifest()})
        report = self.classify(
            {
                88: score.Run(ok=False, refused=True, error="no"),
                60: score.Run(ok=False, refused=True, error="no"),
            }
        )
        scored = score.Report(submission="submission")
        scored.gates = {
            "0-coverage": {
                "pass": False,
                "got": 0,
                "of": 2,
                "what": "formatted every corpus file at every width",
            }
        }
        scored.measures = {"6-reference-agreement": report}
        scored.pending = pending

        self.assertEqual(pending, {})
        self.assertEqual(report["unreviewed"], 2)
        self.assertTrue(
            all(
                item.endswith("(refused)")
                for item in report["by_language"]["json"]["unreviewed_divergences"]
            )
        )
        self.assertTrue(scored.disqualified)

    def test_review_requires_a_reference(self):
        self.approve()
        (self.reference / "json__sample@60.txt").unlink()
        report = self.classify(
            {
                88: score.Run(ok=True, text="reference"),
                60: score.Run(ok=True, text="house"),
            }
        )

        self.assertEqual(report["stale"], 1)
        self.assertIn(
            "reference is missing",
            report["by_language"]["json"]["stale_divergences"][0]["why"],
        )

    def test_review_requires_a_corpus_case(self):
        self.approve(item_id="json/other.json@60")
        report = self.classify(
            {
                88: score.Run(ok=True, text="reference"),
                60: score.Run(ok=True, text="house"),
            }
        )

        self.assertEqual(report["stale"], 1)
        self.assertIn(
            "no corpus comparison",
            report["by_language"]["json"]["stale_divergences"][0]["why"],
        )


class SizeScoreTests(unittest.TestCase):
    def test_highlight_packages_are_not_formatter_download_bytes(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        submission = Path(tmp.name)
        runtime = submission / "runtime-js"
        packages = submission / "packages"
        runtime.mkdir()
        packages.mkdir()
        (runtime / "bundle.js").write_bytes(b"runtime")
        format_package = packages / "json.json"
        format_package.write_bytes(b"format")
        (packages / "json.highlight.json").write_bytes(b"highlight")

        measured = score.sizes(submission, {"json": object()})

        self.assertEqual(measured["packages"], score.gzipped(format_package))
        self.assertEqual(
            measured["total"], measured["js-runtime"] + measured["packages"]
        )


def _parse_lang(
    root: Path, name: str, extra: str = "", aliases: list[str] | None = None
) -> manifest.Manifest:
    path = root / f"{name}.toml"
    alias_list = aliases if aliases is not None else [name]
    alias_toml = "[" + ", ".join(f'"{a}"' for a in alias_list) + "]"
    path.write_text(
        "\n".join(
            (
                f'name = "{name}"',
                f'extensions = [".{name}"]',
                'grammar = "tree-sitter-x==1.0.0"',
                'grammar_module = "tree_sitter_x"',
                f"injection_aliases = {alias_toml}",
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


class AwaitingPackageTests(unittest.TestCase):
    """Stage A lands a corpus; stage C lands the package. In between, a
    language must read as pending rather than as one refusal per tree."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.submission = Path(tmp.name)
        (self.submission / "packages").mkdir()
        self.langs = self.submission / "langs"
        self.langs.mkdir()

    def test_a_language_with_no_package_is_awaiting_it(self):
        (self.submission / "packages" / "json.json").write_text("{}")
        manifests = {
            "json": _parse_lang(self.langs, "json"),
            "toml": _parse_lang(self.langs, "toml"),
        }

        pending = score.awaiting_package(self.submission, manifests)

        self.assertEqual(pending, {"toml": "corpus landed, not yet scored"})

    def test_a_package_that_exists_is_scored_however_it_behaves(self):
        """A refusing package is a failure. Only a missing file is pending."""
        (self.submission / "packages" / "toml.json").write_text("{}")

        pending = score.awaiting_package(
            self.submission, {"toml": _parse_lang(self.langs, "toml")}
        )

        self.assertEqual(pending, {})


class PendingGuestTests(unittest.TestCase):
    """A host whose package exists still cannot be scored when a guest it
    formats is awaiting one. Opaque guests do not count; refusals do not
    propagate; cycles must not hang."""

    INFO_SITE = (
        "[[injections]]\n"
        'node = "fenced_code_block"\n'
        'info = "info_string"\n'
        'content = "code_fence_content"\n'
    )

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.submission = Path(tmp.name)
        (self.submission / "packages").mkdir()
        self.langs = self.submission / "langs"
        self.langs.mkdir()

    def _lang(self, name, extra="", aliases=None):
        return _parse_lang(self.langs, name, extra, aliases)

    def test_a_host_is_pending_when_an_info_guest_has_no_package(self):
        (self.submission / "packages" / "markdown.json").write_text("{}")
        manifests = {
            "json": self._lang("json"),
            "markdown": self._lang("markdown", extra=self.INFO_SITE),
        }

        pending = score.awaiting_package(self.submission, manifests)

        self.assertEqual(
            pending,
            {
                "json": "corpus landed, not yet scored",
                "markdown": "json is pending",
            },
        )

    def test_pending_propagates_transitively_and_names_the_missing_package(self):
        (self.submission / "packages" / "a.json").write_text("{}")
        (self.submission / "packages" / "b.json").write_text("{}")
        manifests = {
            "a": self._lang(
                "a", extra='injections = [{ node = "wrap", guest = "b" }]\n'
            ),
            "b": self._lang(
                "b", extra='injections = [{ node = "wrap", guest = "c" }]\n'
            ),
            "c": self._lang("c"),
            "d": self._lang("d"),
        }
        (self.submission / "packages" / "d.json").write_text("{}")

        pending = score.awaiting_package(self.submission, manifests)

        self.assertEqual(
            pending,
            {
                "a": "c is pending",
                "b": "c is pending",
                "c": "corpus landed, not yet scored",
            },
        )

    def test_a_cycle_does_not_hang(self):
        (self.submission / "packages" / "b.json").write_text("{}")
        manifests = {
            "a": self._lang(
                "a", extra='injections = [{ node = "wrap", guest = "b" }]\n'
            ),
            "b": self._lang(
                "b", extra='injections = [{ node = "wrap", guest = "a" }]\n'
            ),
        }

        pending = score.awaiting_package(self.submission, manifests)

        self.assertEqual(
            pending,
            {
                "a": "corpus landed, not yet scored",
                "b": "a is pending",
            },
        )

    def test_an_opaque_guest_does_not_pending_the_host(self):
        (self.submission / "packages" / "markdown.json").write_text("{}")
        manifests = {
            "html": self._lang("html"),
            "markdown": self._lang(
                "markdown",
                extra=(
                    "[[injections]]\n"
                    'node = "html_block"\n'
                    'guest = "html"\n'
                    "format = false\n"
                ),
            ),
        }

        pending = score.awaiting_package(self.submission, manifests)

        self.assertEqual(pending, {"html": "corpus landed, not yet scored"})

    def test_a_selected_host_is_pending_when_an_unselected_guest_is(self):
        (self.submission / "packages" / "markdown.json").write_text("{}")
        manifests = {
            "json": self._lang("json"),
            "markdown": self._lang("markdown", extra=self.INFO_SITE),
        }

        pending = score.awaiting_package(
            self.submission, {"markdown": manifests["markdown"]}, manifests
        )

        self.assertEqual(pending, {"markdown": "json is pending"})

    def test_a_present_guest_package_does_not_pending_the_host(self):
        """Only absence propagates. A file that exists is scored, refusals and all."""
        (self.submission / "packages" / "json.json").write_text("{}")
        (self.submission / "packages" / "markdown.json").write_text("{}")
        manifests = {
            "json": self._lang("json"),
            "markdown": self._lang("markdown", extra=self.INFO_SITE),
        }

        pending = score.awaiting_package(self.submission, manifests)

        self.assertEqual(pending, {})


class LivePendingPropagationTests(unittest.TestCase):
    """The json-aside repro, against the real roster.

    Restored in `finally` so an assertion failure cannot leave the tree
    missing a package.
    """

    def test_current_packages_pend_nobody(self):
        pending = score.awaiting_package(score.ROOT, manifest.load_all())
        self.assertEqual(pending, {})

    def test_missing_json_pends_markdown_and_not_python(self):
        pkg = score.ROOT / "packages" / "json.json"
        aside = pkg.with_name("json.json.aside")
        if aside.is_file() and not pkg.is_file():
            aside.rename(pkg)
        try:
            pkg.rename(aside)
            pending = score.awaiting_package(score.ROOT, manifest.load_all())
        finally:
            if aside.is_file() and not pkg.is_file():
                aside.rename(pkg)

        self.assertEqual(pending["json"], "corpus landed, not yet scored")
        self.assertEqual(pending["markdown"], "json is pending")
        self.assertNotIn("python", pending)
        self.assertTrue(pkg.is_file())


class PendingMainTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.submission = Path(tmp.name)
        (self.submission / "packages").mkdir()
        langs = self.submission / "langs"
        langs.mkdir()
        self.manifests = {
            "json": _parse_lang(langs, "json"),
            "toml": _parse_lang(langs, "toml"),
        }

    def run_main(self, selected, *extra):
        report = score.Report(submission="submission")
        with (
            mock.patch.object(score.mf, "bootstrap", return_value=self.manifests),
            mock.patch.object(score.mf, "selected", return_value=selected),
            mock.patch.object(score, "score", return_value=report) as score_run,
            mock.patch.object(
                score.sys,
                "argv",
                ["score.py", str(self.submission), "--json", *extra],
            ),
            mock.patch("builtins.print"),
        ):
            result = score.main()
        return result, report, score_run

    def test_full_roster_with_no_packages_fails_instead_of_scoring_nothing(self):
        # Regression: hiding every package used to make the whole gate pass.
        result, _, score_run = self.run_main(self.manifests)

        self.assertEqual(result, 1)
        score_run.assert_not_called()

    def test_single_pending_language_remains_a_successful_onboarding_state(self):
        result, _, score_run = self.run_main(
            {"toml": self.manifests["toml"]}, "--language", "toml"
        )

        self.assertEqual(result, 0)
        score_run.assert_not_called()

    def test_full_roster_scores_available_packages_while_others_are_pending(self):
        (self.submission / "packages" / "json.json").write_text("{}")

        result, report, score_run = self.run_main(self.manifests)

        self.assertEqual(result, 0)
        self.assertEqual(report.pending, {"toml": "corpus landed, not yet scored"})
        self.assertEqual(score_run.call_args.args[1], {"json": self.manifests["json"]})

    def test_propagation_does_not_empty_a_roster_that_still_has_packages(self):
        langs = self.submission / "langs"
        host = _parse_lang(
            langs,
            "markdown",
            extra=(
                "[[injections]]\n"
                'node = "fenced_code_block"\n'
                'info = "info_string"\n'
                'content = "code_fence_content"\n'
            ),
        )
        self.manifests["markdown"] = host
        (self.submission / "packages" / "json.json").write_text("{}")
        (self.submission / "packages" / "toml.json").write_text("{}")
        (self.submission / "packages" / "markdown.json").write_text("{}")
        # json is present; toml missing would pending markdown via the info
        # site, but json and toml both have packages here. Hide only json.
        (self.submission / "packages" / "json.json").unlink()

        result, report, score_run = self.run_main(self.manifests)

        self.assertEqual(result, 0)
        self.assertEqual(
            report.pending,
            {
                "json": "corpus landed, not yet scored",
                "markdown": "json is pending",
            },
        )
        self.assertEqual(score_run.call_args.args[1], {"toml": self.manifests["toml"]})

    def test_a_host_is_scored_when_its_guest_package_exists(self):
        """A guest that exists and would refuse is still scored, host included."""
        langs = self.submission / "langs"
        self.manifests["markdown"] = _parse_lang(
            langs,
            "markdown",
            extra=(
                "[[injections]]\n"
                'node = "fenced_code_block"\n'
                'info = "info_string"\n'
                'content = "code_fence_content"\n'
            ),
        )
        for name in self.manifests:
            (self.submission / "packages" / f"{name}.json").write_text("{}")
        failed = score.Report(submission="submission")
        failed.gates = {
            "0-coverage": {
                "pass": False,
                "got": 0,
                "of": 4,
                "what": "formatted every corpus file at every width",
            }
        }

        with (
            mock.patch.object(score.mf, "bootstrap", return_value=self.manifests),
            mock.patch.object(score.mf, "selected", return_value=self.manifests),
            mock.patch.object(score, "score", return_value=failed) as score_run,
            mock.patch.object(
                score.sys,
                "argv",
                ["score.py", str(self.submission), "--json"],
            ),
            mock.patch("builtins.print"),
        ):
            result = score.main()

        self.assertEqual(result, 1)
        self.assertEqual(failed.pending, {})
        self.assertEqual(set(score_run.call_args.args[1]), set(self.manifests))


class IncomparableScoreTests(unittest.TestCase):
    """Incomparable files stay gated, but they are not agreement."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.reference = self.root / "reference"
        self.reviews = self.root / "reviews"
        self.reference.mkdir()
        self.sample = self.root / "json__sample.tree.json"
        self.sample.write_text(
            json.dumps(
                {
                    "source_file": "corpus/src/json/sample.json",
                    "root": {"text": "source"},
                }
            )
        )
        self.quotes = self.root / "json__quotes.tree.json"
        self.quotes.write_text(
            json.dumps(
                {
                    "source_file": "corpus/src/json/quotes.json",
                    "root": {"text": "'hello'"},
                }
            )
        )
        for width in (88, 60):
            (self.reference / f"json__sample@{width}.txt").write_text("reference")
            (self.reference / f"json__quotes@{width}.txt").write_text("rewritten")

    def manifest(self, incomparable=None) -> manifest.Manifest:
        path = self.root / "json.toml"
        path.write_text(
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
                    "widths = [88, 60]",
                    'gate3 = "default"',
                )
            )
        )
        parsed = manifest.parse(path)
        if incomparable is None:
            return parsed
        return manifest.Manifest(
            **{**parsed.__dict__, "incomparable": incomparable}
        )

    def classify(self, m, outputs):
        def invoke(_exe, tree, width):
            return outputs[Path(tree).name, width]

        with (
            mock.patch.object(score, "REFERENCE", self.reference),
            mock.patch.object(score, "invoke", side_effect=invoke),
        ):
            return score.reference_agreement(
                self.root,
                [(self.sample, m), (self.quotes, m)],
                ledger_root=self.reviews,
            )

    def test_incomparable_file_does_not_enter_the_denominator(self):
        m = self.manifest({"quotes.json": "prettier re-quotes to minimise escaping"})
        report = self.classify(
            m,
            {
                ("json__sample.tree.json", 88): score.Run(ok=True, text="reference"),
                ("json__sample.tree.json", 60): score.Run(ok=True, text="reference"),
                ("json__quotes.tree.json", 88): score.Run(ok=True, text="ours"),
                ("json__quotes.tree.json", 60): score.Run(ok=True, text="ours"),
            },
        )

        self.assertEqual(report["of"], 2)
        self.assertEqual(report["agreement"], 2)
        self.assertEqual(report["unreviewed"], 0)
        self.assertEqual(report["excluded"], 1)
        language = report["by_language"]["json"]
        self.assertEqual(language["of"], 2)
        self.assertEqual(language["excluded"], 1)
        self.assertEqual(
            language["excluded_files"],
            [
                {
                    "file": "quotes.json",
                    "reason": "prettier re-quotes to minimise escaping",
                }
            ],
        )
        self.assertEqual(language["by_width"]["88"]["of"], 1)
        self.assertEqual(language["by_width"]["60"]["of"], 1)

    def test_the_same_file_is_unreviewed_when_it_is_comparable(self):
        report = self.classify(
            self.manifest(),
            {
                ("json__sample.tree.json", 88): score.Run(ok=True, text="reference"),
                ("json__sample.tree.json", 60): score.Run(ok=True, text="reference"),
                ("json__quotes.tree.json", 88): score.Run(ok=True, text="ours"),
                ("json__quotes.tree.json", 60): score.Run(ok=True, text="ours"),
            },
        )

        self.assertEqual(report["of"], 4)
        self.assertEqual(report["agreement"], 2)
        self.assertEqual(report["unreviewed"], 2)
        self.assertEqual(report["excluded"], 0)

    def test_a_review_of_an_incomparable_file_is_not_an_orphan(self):
        digest = formatter_divergence.make(
            "json", "quotes.json", 60, "ours", "rewritten"
        ).hash
        review_ledger.approve(
            "formatter",
            "json",
            "json/quotes.json@60",
            digest,
            "design limit",
            "Reference rewrites quotes.",
            "reviewer@example.com",
            root=self.reviews,
            reviewed_at="2026-08-16T00:00:00Z",
        )
        report = self.classify(
            self.manifest({"quotes.json": "prettier re-quotes"}),
            {
                ("json__sample.tree.json", 88): score.Run(ok=True, text="reference"),
                ("json__sample.tree.json", 60): score.Run(ok=True, text="reference"),
                ("json__quotes.tree.json", 88): score.Run(ok=True, text="ours"),
                ("json__quotes.tree.json", 60): score.Run(ok=True, text="ours"),
            },
        )

        self.assertEqual(report["stale"], 0)
        self.assertEqual(report["excluded"], 1)


class TabsCountAsColumns(unittest.TestCase):
    """A tab-indented reference is measured in columns, not characters.

    gofmt indents with tabs always, and emacs `scheme-mode` does in 11 of 15
    scheme corpus files. Counting a tab as one character under-measures every
    indented line by seven, so a package that overflows the box is scored as
    fitting it.
    """

    def test_a_tab_indented_line_is_measured_in_columns(self):
        # Two tabs plus 10 characters: 16 columns of indent, 26 in total.
        line = "\t\t0123456789"
        self.assertEqual(len(line), 12)
        self.assertEqual(score.overflow_lines(line, 20, []), 1)
        self.assertEqual(score.overflow_lines(line, 30, []), 0)

    def test_spaces_are_unaffected(self):
        line = " " * 16 + "0123456789"
        self.assertEqual(score.overflow_lines(line, 20, []), 1)
        self.assertEqual(score.overflow_lines(line, 30, []), 0)


if __name__ == "__main__":
    unittest.main()
