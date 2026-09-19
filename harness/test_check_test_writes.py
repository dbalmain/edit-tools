"""Unit tests for the write guard, including the defect it was written for.

The end-to-end case runs `check_test_writes.py` as a subprocess over a
temporary directory holding one offending test, because that is the only way
to exercise the arming, the discovery and the hook together. Asserting against
`guarded()` alone would pass even if the hook were never installed -- the
shape of vacuous control this repository has now hit three times.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import check_test_writes as ctw

HARNESS = Path(__file__).resolve().parent
ROOT = HARNESS.parent

HARMLESS = '''
import unittest


class Harmless(unittest.TestCase):
    def test_reads_nothing_and_writes_nothing(self):
        self.assertEqual(1, 1)
'''

OFFENDER = '''
import unittest
from pathlib import Path

ROOT = Path({root!r})


class Offender(unittest.TestCase):
    def test_writes_into_the_repository(self):
        target = ROOT / ".check-control"
        target.write_text("this must never reach the disk\\n")
        target.unlink()
'''


# The historical defect, spelled the way it was spelled: rename a tracked file
# aside, do the work, put it back in a `finally`. It leaves no trace in the
# final tree, so nothing that inspects the tree afterwards can catch it -- and
# `write_text` above goes through a different audit event, so without this the
# whole `_PATH_EVENTS` table could be deleted and both runner tests would stay
# green.
RENAMER = '''
import unittest
from pathlib import Path

ROOT = Path({root!r})


class Renamer(unittest.TestCase):
    def test_renames_a_tracked_file_aside_and_back(self):
        target = ROOT / "README.md"
        aside = ROOT / ".README.aside"
        target.rename(aside)
        try:
            self.assertFalse(target.exists())
        finally:
            aside.rename(target)
'''


def _run(start: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(HARNESS / "check_test_writes.py"), str(start)],
        capture_output=True,
        text=True,
    )


class GuardedTests(unittest.TestCase):
    def test_a_repository_path_is_guarded(self):
        self.assertEqual(
            ctw.guarded(str(ROOT / "packages" / "json.json"), False),
            ROOT / "packages" / "json.json",
        )

    def test_a_temporary_path_is_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(ctw.guarded(str(Path(tmp) / "x.json"), False))

    def test_bytecode_beside_the_source_is_not(self):
        self.assertIsNone(ctw.guarded(str(HARNESS / "__pycache__" / "x.pyc"), False))

    def test_a_file_descriptor_is_not_a_path(self):
        """`io.open` on an open fd raises the `open` event with an `int`, and
        reading that as a relative name made every bytecode write look like a
        violation."""
        self.assertIsNone(ctw.guarded(7, False))

    def test_a_read_is_not_a_write(self):
        """Every other test here writes, so nothing else notices if the mode
        check goes: the suite reads corpus files, packages and manifests out
        of the tree constantly, and a guard that stopped those would take the
        whole run down rather than fail one case."""
        readme = str(ROOT / "README.md")
        ctw.audit("open", (readme, "r", 0))
        ctw.audit("os.open", (readme, os.O_RDONLY, 0))

        with self.assertRaises(ctw.WroteIntoTheRepository):
            ctw.audit("open", (readme, "w", 0))
        with self.assertRaises(ctw.WroteIntoTheRepository):
            ctw.audit("os.open", (readme, os.O_WRONLY | os.O_CREAT, 0))

    def test_a_temporary_root_inside_the_tree_is_still_exempt(self):
        """`TMPDIR` can point inside the checkout. Then "not under the repo"
        and "under a temporary root" stop being the same question, and only
        the second one is the rule this guard means."""
        inside = ROOT / "build" / "tmp"
        with unittest.mock.patch.object(ctw, "TEMP", inside):
            self.assertIsNone(ctw.guarded(str(inside / "fixture.json"), False))
            self.assertIsNotNone(ctw.guarded(str(ROOT / "packages"), False))

    def test_a_bare_name_is_judged_only_where_dir_fd_cannot_apply(self):
        """`shutil.rmtree` walks a tree passing basenames relative to an open
        directory; resolving those against the working directory pointed them
        straight at the repository."""
        self.assertIsNone(ctw.guarded("trees-dirty", True))
        self.assertIsNotNone(ctw.guarded("trees-dirty", False))


class RunnerTests(unittest.TestCase):
    def test_a_test_that_writes_into_the_repository_fails_the_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "test_offender.py").write_text(
                OFFENDER.format(root=str(ROOT))
            )
            result = _run(Path(tmp))

        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("WroteIntoTheRepository", result.stderr)
        self.assertIn(".check-control", result.stderr)
        self.assertFalse(
            (ROOT / ".check-control").exists(),
            "the guard reported the write but did not prevent it",
        )

    def test_a_rename_aside_and_back_is_caught_before_it_happens(self):
        """The shape the guard was written for. A `finally` restores it, so
        the tree is unchanged afterwards either way -- which is exactly why
        the check has to fire at the syscall and not on the result."""
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "test_renamer.py").write_text(
                RENAMER.format(root=str(ROOT))
            )
            result = _run(Path(tmp))

        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("os.rename", result.stderr)
        self.assertTrue((ROOT / "README.md").exists(), "README.md was moved")
        self.assertFalse((ROOT / ".README.aside").exists())

    def test_the_same_runner_passes_a_test_that_writes_nothing(self):
        """The negative half: the failure above must come from the write, not
        from running a foreign directory at all."""
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "test_harmless.py").write_text(HARMLESS)
            result = _run(Path(tmp))

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Ran 1 test", result.stderr)


if __name__ == "__main__":
    unittest.main()
