"""Run one `node --test` file from the Python suite, and prove it ran.

The harness has JavaScript unit suites that `./test.sh` must not have to list.
`test.sh` is a shared file several tracks touch at once, so a track that adds a
`.mjs` suite reaches the gate through `python3 -m unittest discover -s harness`
instead, by way of a one-line `unittest` case that calls `assert_passed` here.

The floor is the whole point of the function. `node --test` exits 0 on a file
containing no tests, so a return code alone cannot tell a passing suite from a
suite that stopped being collected -- the failure this repo has already had in
another runner, where the count went to zero and read as success forever after.
"""

from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

HARNESS = Path(__file__).resolve().parent


def assert_passed(case: unittest.TestCase, suite: str, minimum: int) -> None:
    """Run `harness/<suite>` under `node --test`; fail unless it planned `minimum`.

    `minimum` is a floor rather than the exact count, so adding a test does not
    break the caller -- but dropping the suite does.
    """
    result = subprocess.run(
        [
            "node",
            "--test",
            "--test-isolation=none",
            "--test-reporter=tap",
            str(HARNESS / suite),
        ],
        capture_output=True,
        text=True,
    )
    report = result.stdout + result.stderr
    case.assertEqual(result.returncode, 0, report)
    # TAP's `1..N` plan counts the tests this non-isolated process actually
    # collected; the pass summary can collapse to one line per file.
    plan = re.search(r"^1\.\.(\d+)$", result.stdout, re.MULTILINE)
    case.assertIsNotNone(plan, report)
    case.assertGreaterEqual(int(plan.group(1)), minimum, report)
