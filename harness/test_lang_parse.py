"""Gate for the browser parse wrapper's secondary-attachment flag.

The suite itself is `harness/lang_parse.test.mjs`. The corpus probe never
calls `web/js/lang.js`, so it cannot see the browser default, the URL
opt-in, or whether `parse()` fetches the inline blob. This is the gate
that would fail if any of those stopped working.
"""

import unittest

import node_suite


class LangParseFlagTest(unittest.TestCase):
    def test_lang_parse_secondaries_flag(self):
        node_suite.assert_passed(self, "lang_parse.test.mjs", 6)


if __name__ == "__main__":
    unittest.main()
