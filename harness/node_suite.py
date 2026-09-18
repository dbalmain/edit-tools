"""Run one `node --test` file from the Python suite, and prove it ran.

The harness has JavaScript unit suites that `./test.sh` must not have to list.
`test.sh` is a shared file several tracks touch at once, so a track that adds a
`.mjs` suite reaches the gate through `python3 -m unittest discover -s harness`
instead, by way of a one-line `unittest` case that calls `assert_passed` here.

The floor is the whole point of the function. `node --test` exits 0 on a file
containing no tests, so a return code alone cannot tell a passing suite from a
suite that stopped being collected -- the failure this repo has already had in
another runner, where the count went to zero and read as success forever after.

The floor counts **assertions that passed**, not tests that were planned. TAP's
`1..N` plan includes skipped and TODO tests, so a suite whose every body became
`it.skip` keeps its plan, exits 0, and clears a plan-based floor while running
nothing -- the same vacuous gate one level down. So this reads the `ok` lines,
subtracts the ones carrying a `# SKIP` or `# TODO` directive, and refuses any
skip outright: a suite that means to skip a case should delete it or fix it,
and this repo has nowhere that a silently skipped JavaScript test is correct.
"""

from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

HARNESS = Path(__file__).resolve().parent


# `ok 3 - name` / `not ok 3 - name`, with an optional trailing TAP directive.
# Node indents subtests, hence the leading whitespace.
_RESULT = re.compile(r"^\s*(not )?ok \d+(?: - .*)?$", re.MULTILINE)
_DIRECTIVE = re.compile(r"#\s*(SKIP|TODO)\b", re.IGNORECASE)


def assert_passed(case: unittest.TestCase, suite: str, minimum: int) -> None:
    """Run `harness/<suite>` under `node --test`; fail unless `minimum` passed.

    `minimum` is a floor rather than the exact count, so adding a test does not
    break the caller -- but dropping the suite, or skipping its bodies, does.
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
    # The plan proves the file was collected at all; the `ok` lines prove its
    # bodies ran. Both, because a missing plan and an empty plan differ.
    plan = re.search(r"^\s*1\.\.(\d+)$", result.stdout, re.MULTILINE)
    case.assertIsNotNone(plan, report)
    lines = [m.group(0) for m in _RESULT.finditer(result.stdout)]
    skipped = [line for line in lines if _DIRECTIVE.search(line)]
    case.assertEqual(skipped, [], f"{suite}: skipped or TODO tests\n{report}")
    passed = sum(1 for line in lines if not line.lstrip().startswith("not "))
    case.assertGreaterEqual(
        passed, minimum, f"{suite}: {passed} passed, floor is {minimum}\n{report}"
    )
