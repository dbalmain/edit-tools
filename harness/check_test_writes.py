#!/usr/bin/env python3
"""Run the harness unit suite with writes into the repository made fatal.

`./test.sh` reaches the Python suite through this file rather than calling
`python3 -m unittest discover -s harness` directly. Same discovery, same
reporter, same exit code -- with an audit hook installed first, so a test that
writes anywhere under the repository is stopped at the write instead of being
noticed later, or never.

**Why this exists.** `test_check_gate3.py` renamed the real `packages/json.json`
aside and restored it in a `finally`, to exercise the pending-package closure
against the live roster. It was green, and the `finally` reads as careful, but a
SIGKILL inside that window leaves the checkout missing a language, and the test
could not run at all against a read-only tree. Nothing in the repository
distinguished a test that *reads* the tree from one that *writes* it.

**Why an audit hook and not a grep.** The obvious check -- scan `test_*.py` for
`write_text`, `mkdir`, `rename` -- has to decide whether each receiver is a
temporary path, which is a dataflow question a grep cannot answer. Every one of
the twenty test modules here writes, legitimately, into `tempfile` directories;
a textual check would be all false positives. It would also miss the shape that
actually bit: a rename aside and back, which leaves no trace in the final tree,
so even comparing `git status` before and after sees nothing.

`sys.addaudithook` sees the syscall instead of the source, so both problems go
away: the path is resolved, the temporary roots are simply not under the
repository, and a write that is restored afterwards is still a write.

**What it does not see**, stated plainly because a guard's blind spots are the
part that rots:

* **Writes by a child process.** Audit events are per-process, so `node --test`
  through `node_suite`, and the tests that shell out to a harness script, are
  invisible here. They run against their own temporary trees.
* **Writes through a directory descriptor.** `os.rename` and its neighbours
  take `dir_fd=`, and the audit event does not carry it, so a bare name means
  nothing on its own -- `shutil.rmtree` walks a tree this way, passing
  basenames relative to an open directory. Those events are only guarded when
  the path is absolute. The high-level `shutil.*` call that starts such a walk
  carries the whole path and is guarded, which is where a test's own intent
  shows up.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

HARNESS = Path(__file__).resolve().parent
ROOT = HARNESS.parent
TEMP = Path(tempfile.gettempdir()).resolve()

# Audit events whose first argument is a path about to change. `os.rename`
# covers `Path.rename`, `Path.replace` and `os.replace`.
_PATH_EVENTS = frozenset({
    "os.remove",
    "os.rename",
    "os.mkdir",
    "os.rmdir",
    "os.symlink",
    "os.link",
    "os.truncate",
    "os.chmod",
    "os.chown",
    "os.utime",
    "shutil.copyfile",
    "shutil.copymode",
    "shutil.copystat",
    "shutil.move",
    "shutil.rmtree",
})

# The subset that accepts `dir_fd=`, where a relative path is not relative to
# the working directory and must not be read as though it were.
_MAY_BE_FD_RELATIVE = frozenset({
    "os.open",
    "os.remove",
    "os.rename",
    "os.mkdir",
    "os.rmdir",
    "os.symlink",
    "os.link",
    "os.chmod",
    "os.chown",
    "os.utime",
})

_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
_WRITE_MODES = frozenset("wax+")


class WroteIntoTheRepository(Exception):
    """A test tried to change the checkout instead of a temporary tree."""


def guarded(path, absolute_only: bool) -> Path | None:
    """The resolved path, when changing it would touch the repository.

    Returns `None` for anything this hook declines to judge: a file descriptor
    rather than a name (`io.open` on an already-open fd raises the `open`
    event with an `int`, and reading that as a relative name resolved every
    bytecode write into the repository), a `dir_fd`-relative name, a temporary
    root, and the bytecode and dependency caches that live inside the tree
    without any test putting them there.
    """
    try:
        named = Path(os.fsdecode(path))
    except (UnicodeDecodeError, TypeError, ValueError):
        # `fsdecode` is what rejects a file descriptor: `io.open` on an
        # already-open fd raises the `open` event with an `int` where the name
        # would be, and `str()`-ing that resolved every bytecode write into
        # the repository. Do not "helpfully" widen this to accept an int.
        return None
    if absolute_only and not named.is_absolute():
        return None
    try:
        resolved = (named if named.is_absolute() else Path.cwd() / named).resolve()
    except (OSError, ValueError):
        return None
    if resolved.is_relative_to(TEMP) or not resolved.is_relative_to(ROOT):
        return None
    # Import machinery writes bytecode beside the source, and `uv` caches under
    # the repository for the scripts whose header names dependencies. Neither
    # is a test writing to the tree.
    if {"__pycache__", ".venv", ".uv-cache"} & set(resolved.parts):
        return None
    return resolved


def audit(event: str, args: tuple) -> None:
    """The audit hook itself: decide whether `event` is a guarded write."""
    if event == "open":
        path, mode, _flags = args
        if not isinstance(mode, str) or not _WRITE_MODES & set(mode):
            return
    elif event == "os.open":
        path, flags, _mode = args
        if not isinstance(flags, int) or not flags & _WRITE_FLAGS:
            return
    elif event in _PATH_EVENTS:
        path = args[0]
    else:
        return
    offending = guarded(path, event in _MAY_BE_FD_RELATIVE)
    if offending is None:
        return
    raise WroteIntoTheRepository(
        f"{event} on {offending.relative_to(ROOT)}: a harness test must write "
        f"only under {TEMP}. Build the fixture in a temporary directory and "
        f"point the code under test at it. A `finally` that restores the file "
        f"is not enough: a kill inside that window is not undone, and the test "
        f"cannot run against a read-only checkout either way."
    )


def arm() -> None:
    """Install the hook, then prove it fires. It cannot be removed after this.

    The control is the reason this runs in-process rather than wrapping the
    suite in a subprocess and diffing the tree afterwards. A hook that quietly
    stopped matching -- a renamed audit event, a path comparison resolving the
    wrong way, the `int` descriptor above -- would leave the suite green and
    the guard absent, which is the vacuous gate this repository keeps
    rediscovering. So the first write attempted after arming is one that must
    fail, and the file it names must not exist afterwards.
    """
    sys.addaudithook(audit)
    probe = ROOT / ".check_test_writes_probe"
    try:
        with open(probe, "w"):
            pass
    except WroteIntoTheRepository:
        if probe.exists():
            raise SystemExit(
                f"check_test_writes: the guard raised but {probe.name} exists, "
                "so it fired after the write rather than before it"
            ) from None
        return
    probe.unlink(missing_ok=True)
    raise SystemExit(
        f"check_test_writes: the guard is not armed -- writing {probe.name} "
        "was allowed. The suite below would run unguarded, so this is a "
        "failure, not a warning."
    )


def main(argv: list[str] | None = None) -> int:
    """Discover and run `harness/`, or the directory named on the command line.

    The argument exists for `test_check_test_writes.py`, which points this at a
    temporary directory holding one deliberately offending test. Without it the
    control would have to assert against this module's internals instead of
    running the thing that ships.
    """
    argv = sys.argv[1:] if argv is None else argv
    start = Path(argv[0]).resolve() if argv else HARNESS
    arm()
    loader = unittest.TestLoader()
    suite = loader.discover(str(start), top_level_dir=str(start))
    if loader.errors:
        for error in loader.errors:
            print(error, file=sys.stderr)
        return 1
    return 0 if unittest.TextTestRunner().run(suite).wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
