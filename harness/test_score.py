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

    def approve(self, output: str = "house", item_id: str = "json/sample.json@60"):
        digest = formatter_divergence.make(
            "json", "sample.json", 60, output, "reference"
        ).hash
        review_ledger.approve(
            "formatter",
            "json",
            item_id,
            digest,
            "design limit",
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
            (report["accepted"], report["stale"], report["unreviewed"]),
            (0, 0, 1),
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


if __name__ == "__main__":
    unittest.main()
