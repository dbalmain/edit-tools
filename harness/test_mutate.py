"""Unit tests for the mutation helper, and for what it refuses.

The interesting cases are the ones where a weaker implementation agrees with
this one. `if old not in text: raise` catches a missing anchor and nothing
else, so each test below names a mutation that a bare membership check would
wave through while it still mutates nothing.
"""

import unittest

from mutate import AnchorMissing, mutated


class MutatedTests(unittest.TestCase):
    def test_a_found_anchor_is_replaced(self):
        self.assertEqual(mutated("a b a", "a", "X"), "X b X")

    def test_count_limits_the_replacement(self):
        self.assertEqual(mutated("a b a", "a", "X", 1), "X b a")

    def test_a_missing_anchor_raises(self):
        with self.assertRaises(AnchorMissing) as caught:
            mutated("hello", "goodbye", "X")
        self.assertIn("goodbye", str(caught.exception))

    def test_replacing_a_string_by_itself_raises(self):
        """Membership passes, the text does not change. The commonest shape:
        a table of cases where one row's replacement drifted back to its
        original after an edit."""
        with self.assertRaises(AnchorMissing):
            mutated("a b a", "a", "a")

    def test_too_few_occurrences_for_the_requested_count_raises(self):
        """A control asking for three mutations and getting one is as partial
        as one asking for one and getting none, and membership sees no
        difference between them."""
        with self.assertRaises(AnchorMissing) as caught:
            mutated("a b", "a", "X", 3)
        self.assertIn("3 asked for", str(caught.exception))

    def test_a_negative_count_is_replace_all_and_is_not_a_floor(self):
        """`-1` is `str.replace`'s own sentinel, so it must not be read as a
        count the text has to satisfy."""
        self.assertEqual(mutated("a b a", "a", "X", -1), "X b X")


if __name__ == "__main__":
    unittest.main()
