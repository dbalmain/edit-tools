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


class AwaitingPackageTests(unittest.TestCase):
    """Stage A lands a corpus; stage C lands the package. In between, a
    language must read as pending rather than as one refusal per tree."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.submission = Path(tmp.name)
        (self.submission / "packages").mkdir()

    def test_a_language_with_no_package_is_awaiting_it(self):
        (self.submission / "packages" / "json.json").write_text("{}")

        pending = score.awaiting_package(
            self.submission, {"json": object(), "toml": object()}
        )

        self.assertEqual(sorted(pending), ["toml"])

    def test_a_package_that_exists_is_scored_however_it_behaves(self):
        """A refusing package is a failure. Only a missing file is pending."""
        (self.submission / "packages" / "toml.json").write_text("{}")

        pending = score.awaiting_package(self.submission, {"toml": object()})

        self.assertEqual(pending, {})


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


if __name__ == "__main__":
    unittest.main()
