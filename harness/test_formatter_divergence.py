import hashlib
import unittest

import formatter_divergence


class FormatterDivergenceTests(unittest.TestCase):
    def test_record_carries_both_outputs_diff_and_hashes_the_pair(self):
        record = formatter_divergence.make(
            "json", "nested.json", 60, "ours\n", "reference\n"
        )

        self.assertEqual(record.id, "json/nested.json@60")
        self.assertEqual(
            record.hash,
            hashlib.sha256(b"ours\nreference\n").hexdigest(),
        )
        self.assertIn("-reference", record.unified_diff)
        self.assertIn("+ours", record.unified_diff)
        self.assertEqual(record.as_dict()["our_output"], "ours\n")
        self.assertIn("diff:\n", record.render())

    def test_changing_either_side_changes_the_hash(self):
        original = formatter_divergence.make("json", "x.json", 60, "a", "b")
        ours_changed = formatter_divergence.make("json", "x.json", 60, "A", "b")
        reference_changed = formatter_divergence.make("json", "x.json", 60, "a", "B")

        self.assertNotEqual(original.hash, ours_changed.hash)
        self.assertNotEqual(original.hash, reference_changed.hash)


if __name__ == "__main__":
    unittest.main()
