import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

import corpus_stats
import manifest


def stats(
    *,
    files: int = 12,
    width_sensitive: int = 12,
    commented: int = 12,
    thresholds: dict[str, manifest.CorpusThreshold] | None = None,
) -> dict:
    return {
        "files": files,
        "changed": {80: files, 40: files},
        "changed_any": files,
        "width_sensitive": width_sensitive,
        "commented": commented,
        "overflow": {80: 0, 40: 0},
        "missing": [],
        "incomparable": 0,
        "fixed": False,
        "widths": [80, 40],
        "reference": "test formatter",
        "thresholds": thresholds or {},
    }


class CorpusStatsGateTests(unittest.TestCase):
    def report(self, name: str, measured: dict) -> tuple[bool, str]:
        output = io.StringIO()
        with redirect_stdout(output):
            passed = corpus_stats.report(name, measured)
        return passed, output.getvalue()

    def test_default_width_floor_rejects_a_corpus_below_one_third(self):
        passed, output = self.report(
            "python", stats(width_sensitive=3, commented=7)
        )

        self.assertFalse(passed)
        self.assertIn("python", output)
        self.assertIn("differs by width     3/12   [BELOW one third]", output)

    def test_default_comment_floor_rejects_half_the_corpus(self):
        passed, output = self.report(
            "python", stats(width_sensitive=11, commented=6)
        )

        self.assertFalse(passed)
        self.assertIn("python", output)
        self.assertIn("carries a comment    6/12   [BELOW half", output)

    def test_limited_width_reference_still_enforces_its_floor(self):
        threshold = manifest.CorpusThreshold(
            4, "taplo 0.10.0 honours column_width for arrays only"
        )
        passed, output = self.report(
            "toml",
            stats(
                files=15,
                width_sensitive=3,
                commented=14,
                thresholds={"width_sensitive": threshold},
            ),
        )

        self.assertFalse(passed)
        self.assertIn("toml", output)
        self.assertIn("differs by width     3/15", output)
        self.assertIn("BELOW minimum 4", output)
        self.assertIn("arrays only", output)

    def test_inapplicable_comment_layer_does_not_fail_json(self):
        threshold = manifest.CorpusThreshold(
            None, "JSON has no comment syntax"
        )
        passed, output = self.report(
            "json",
            stats(
                files=3,
                width_sensitive=1,
                commented=0,
                thresholds={"comments": threshold},
            ),
        )

        self.assertTrue(passed)
        self.assertIn(
            "carries a comment    n/a -- JSON has no comment syntax", output
        )

    def test_main_returns_failure_when_a_language_fails(self):
        measured = stats(width_sensitive=11, commented=3)
        with (
            mock.patch.object(corpus_stats.mf, "bootstrap", return_value={}),
            mock.patch.object(
                corpus_stats.mf, "selected", return_value={"python": object()}
            ),
            mock.patch.object(corpus_stats, "stats_for", return_value=measured),
        ):
            with redirect_stdout(io.StringIO()):
                self.assertEqual(corpus_stats.main([]), 1)

    def test_main_rejects_an_empty_gate(self):
        with (
            mock.patch.object(corpus_stats.mf, "bootstrap", return_value={}),
            mock.patch.object(corpus_stats.mf, "selected", return_value={}),
        ):
            with redirect_stdout(io.StringIO()):
                self.assertEqual(corpus_stats.main([]), 1)


if __name__ == "__main__":
    unittest.main()
