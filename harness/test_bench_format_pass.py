"""Classifier tests for bench_format_pass.py. No Node, no clock."""

from __future__ import annotations

import unittest

import bench_format_pass as bench
import prose


class AcquiresAgreementTests(unittest.TestCase):
    def test_pattern_matches_prose(self):
        self.assertEqual(bench.ACQUIRES.pattern, prose._ACQUIRES.pattern)


class GenuineLineTests(unittest.TestCase):
    def test_prefix_version_is_not_genuine(self):
        self.assertIsNone(bench.genuine_line("0.5.1, then more", continuation=True))

    def test_ordered_not_one_cannot_interrupt(self):
        self.assertIsNone(bench.genuine_line("81. stays a paragraph", continuation=True))

    def test_ordered_one_interrupts(self):
        self.assertEqual(bench.genuine_line("1. now a list", continuation=True), "ordered")

    def test_bullet_interrupts(self):
        self.assertEqual(bench.genuine_line("- now a list", continuation=True), "bullet")

    def test_em_dash_with_following_words_is_not_setext(self):
        self.assertIsNone(bench.genuine_line("-- it is the one claim", continuation=True))

    def test_em_dash_alone_is_setext(self):
        self.assertEqual(bench.genuine_line("--", continuation=True), "setext-or-thematic")

    def test_gfm_delimiter_needs_the_whole_line(self):
        self.assertEqual(bench.genuine_line(":-", continuation=True), "gfm-delimiter")
        self.assertIsNone(bench.genuine_line(":- gamma", continuation=True))


class PostcheckTests(unittest.TestCase):
    def test_wrap_of_a_bullet_is_a_genuine_trip(self):
        source = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx - yyy"
        formatted = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n- yyy\n"
        got = bench.postcheck(source, formatted)
        self.assertTrue(got["atoms_match"])
        self.assertEqual(got["lexical"], ["-"])
        self.assertEqual(got["genuine"], ["-"])

    def test_wrap_of_a_prefix_hit_is_lexical_only(self):
        source = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx 0.5.1, yyy"
        formatted = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n0.5.1, yyy\n"
        got = bench.postcheck(source, formatted)
        self.assertTrue(got["atoms_match"])
        self.assertEqual(got["lexical"], ["0.5.1,"])
        self.assertEqual(got["genuine"], [])

    def test_no_wrap_does_not_trip(self):
        source = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx - yyy"
        got = bench.postcheck(source, source + "\n")
        self.assertTrue(got["atoms_match"])
        self.assertEqual(got["lexical"], [])
        self.assertEqual(got["genuine"], [])

    def test_already_at_a_line_start_is_not_a_reflow_trip(self):
        source = "alpha beta gamma delta epsilon zeta eta theta\n:-"
        formatted = "alpha beta gamma delta epsilon zeta eta theta\n:-"
        got = bench.postcheck(source, formatted)
        self.assertTrue(got["atoms_match"])
        self.assertEqual(got["lexical"], [])
        self.assertEqual(got["genuine"], [])


if __name__ == "__main__":
    unittest.main()
