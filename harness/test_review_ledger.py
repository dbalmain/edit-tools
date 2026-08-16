import json
import tempfile
import unittest
from pathlib import Path

import review_ledger


class ReviewLedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def approve(self, item_id: str, digest: str, reason: str = "Looked good."):
        return review_ledger.approve(
            "formatter",
            "json",
            item_id,
            digest,
            "reference quirk",
            reason,
            "reviewer@example.com",
            root=self.root,
            reviewed_at="2026-08-16T00:00:00Z",
        )

    def test_approval_requires_reason_and_reviewer(self):
        for field, reason, reviewer in (
            ("reason", " ", "reviewer"),
            ("reviewed_by", "reason", " "),
        ):
            with self.subTest(field=field), self.assertRaisesRegex(
                review_ledger.LedgerError, field
            ):
                review_ledger.approve(
                    "formatter",
                    "json",
                    "json/sample.json@60",
                    "a" * 64,
                    "design limit",
                    reason,
                    reviewer,
                    root=self.root,
                )

    def test_replacing_one_review_does_not_reorder_another(self):
        first = self.approve("json/first.json@60", "a" * 64)
        second = self.approve("json/second.json@60", "b" * 64)
        path = self.root / "formatter" / "json.jsonl"
        before = path.read_text().splitlines()

        updated = self.approve("json/second.json@60", "c" * 64, "Re-reviewed.")
        after = path.read_text().splitlines()

        self.assertEqual(json.loads(before[0]), first.__dict__)
        self.assertEqual(json.loads(after[0]), first.__dict__)
        self.assertEqual(json.loads(after[1]), updated.__dict__)
        self.assertEqual(
            review_ledger.load("formatter", "json", self.root)[second.id], updated
        )

    def test_states_and_threshold_are_explicit(self):
        review = self.approve("json/sample.json@60", "a" * 64)

        self.assertEqual(review_ledger.state("a" * 64, review), "accepted")
        self.assertEqual(review_ledger.state("b" * 64, review), "stale")
        self.assertEqual(review_ledger.state("b" * 64, None), "unreviewed")
        self.assertFalse(
            review_ledger.summary(["accepted", "unreviewed"])["threshold_met"]
        )



class RetireTests(unittest.TestCase):
    """Retiring is for a divergence that is gone, never one that changed."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        review_ledger.approve(
            "formatter", "toml", "toml/a.toml@80", "a" * 64,
            "design limit", "because", "someone", root=self.root,
        )
        review_ledger.approve(
            "formatter", "toml", "toml/b.toml@80", "b" * 64,
            "design limit", "because", "someone", root=self.root,
        )

    def test_retiring_drops_only_that_record(self):
        dropped = review_ledger.retire(
            "formatter", "toml", "toml/a.toml@80", root=self.root
        )

        self.assertEqual(dropped.id, "toml/a.toml@80")
        remaining = review_ledger.load("formatter", "toml", root=self.root)
        self.assertEqual(list(remaining), ["toml/b.toml@80"])

    def test_retiring_the_last_record_removes_the_file(self):
        for item in ("toml/a.toml@80", "toml/b.toml@80"):
            review_ledger.retire("formatter", "toml", item, root=self.root)

        self.assertFalse(
            review_ledger.path_for("formatter", "toml", self.root).exists()
        )

    def test_retiring_something_absent_is_an_error(self):
        with self.assertRaises(review_ledger.LedgerError):
            review_ledger.retire(
                "formatter", "toml", "toml/never.toml@80", root=self.root
            )

if __name__ == "__main__":
    unittest.main()
