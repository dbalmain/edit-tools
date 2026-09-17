"""Gate for the secondary-grammar loader's JavaScript unit suite.

The suite itself is `harness/ts_secondary.test.mjs`, and its subject is a fetch
that must *not* happen -- something `probe_secondary_grammar.py` structurally
cannot see, since both producers return the same `secondary` array either way.
"""

import unittest

import node_suite


class SecondarySuiteTest(unittest.TestCase):
    def test_secondary_loader_tests_pass(self):
        node_suite.assert_passed(self, "ts_secondary.test.mjs", 5)


if __name__ == "__main__":
    unittest.main()
