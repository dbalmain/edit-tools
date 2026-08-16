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


if __name__ == "__main__":
    unittest.main()
