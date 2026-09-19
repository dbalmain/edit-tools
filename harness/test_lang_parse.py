"""Gate for the browser parse wrapper's secondary-attachment flag.

The suite itself is `harness/lang_parse.test.mjs`. The corpus probe cannot
see this flag -- it never calls `web/js/lang.js` -- so a default that
reached the producers would drop `secondary grammar:` to 0/0 and still
pass. This is the gate that would fail if the flag stopped working in
either direction.
"""

import unittest

import node_suite


class LangParseFlagTest(unittest.TestCase):
    def test_lang_parse_secondaries_flag(self):
        node_suite.assert_passed(self, "lang_parse.test.mjs", 5)


if __name__ == "__main__":
    unittest.main()
