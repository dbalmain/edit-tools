import re
import subprocess
import unittest
from pathlib import Path


# Onboarding writes into corpus/, harness/languages/, and packages/ — see
# docs/onboarding/WORKFLOW.md. A top-level directory with no reader is how
# testdata/ landed; adding one without updating this set is the failure.
TOP_LEVEL_DIRECTORIES = {
    "corpus",
    "docs",
    "harness",
    "packages",
    "proposals",
    "reference",
    "runtime-js",
    "rust",
    "spike",
    "web",
}

ROOT = Path(__file__).resolve().parent.parent


class RepoLayoutTests(unittest.TestCase):
    def test_top_level_directories_are_the_routed_set(self):
        found = {
            path.name
            for path in ROOT.iterdir()
            if path.is_dir() and not path.name.startswith(".")
        }
        self.assertEqual(found, TOP_LEVEL_DIRECTORIES)


# A backticked repo path in tracked prose is a route, and a route that goes
# nowhere is a defect of whatever change broke it. Two landed in one week:
# `docs/onboarding/FINDINGS.md` named `corpus/reports/rust/subwidth-spike.md`
# while that file lived only on `spike/rust-subwidth`, and
# `docs/a2-inline-price.md` -- written on a spike branch and landed here alone
# -- labelled seven files "(tracked)" when three had stayed behind. Neither is
# visible to any other gate: the prose is valid, the build is green, and only a
# reader following the path finds out.
#
# Every entry below is a path that is deliberately absent. Each needs a reason,
# and the test fails when one becomes resolvable, so the list cannot quietly
# accumulate entries that are merely stale.
UNRESOLVED_BY_DESIGN = {
    # Build outputs. `.gitignore` covers these; the prose that names them is
    # telling a reader what to run or what a tool wrote.
    "rust/target",
    "rust/target/debug/docfmt",
    "rust/target/debug/hl-rust",
    "rust/target/release/docfmt",
    "web/data/",
    "web/data/blobs/",
    "web/data/blobs/markdown.blob.json",
    "web/data/blobs/markdown_inline.blob.json",
    "web/vendor/",
    # Prospective. `docs/highlight-design.md` and `docs/tree-interface-probe.md`
    # discuss what writing an Aven package *would* involve; no such package is
    # planned to exist in this repository.
    "packages/aven.json",
    # Retained on `spike/a2-price` on purpose -- `E2-COVERAGE.json` is 1.2 MB of
    # generated measurement, and these two regenerate it against the predicate
    # it measured. `docs/a2-inline-price.md` Appendix B says so at each entry.
    "harness/probe_a2_coverage.py",
    "harness/probe_a2_driver.mjs",
    # A typo for `corpus/reference` in a done-note frozen at its own commit.
    "corpus/references",
    # A corpus case id written without its extension, in a done-note frozen at
    # its own commit. `rust/leading_pipes.rs` resolves; this spelling does not.
    "rust/leading_pipes",
}

_PATH_IN_PROSE = re.compile(r"`([A-Za-z0-9_./-]+)`")


def _tracked() -> set[str]:
    out = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
    )
    return set(out.stdout.split())


def _branches() -> set[str]:
    """Local branch names, which share a prefix with real paths.

    `spike/` is both a tracked directory and a branch namespace, so
    `spike/a2-price` in prose is a branch and `spike/scanner-vm/toml.program.js`
    is a file. Asking git which one it is beats guessing from the spelling --
    and it means renaming a branch that prose cites makes this test fail, which
    is the right moment to find out.
    """
    out = subprocess.run(
        ["git", "for-each-ref", "--format=%(refname:short)", "refs/heads/"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    return set(out.stdout.split())


def _resolves(path: str, tracked: set[str]) -> bool:
    """A tracked file, a tracked directory, or a corpus case id.

    Case ids are spelled `<language>/<file>` in reviews and ledgers -- the same
    id the scorer prints -- and live under `corpus/src/`.
    """
    bare = path.rstrip("/")
    if bare in tracked or f"corpus/src/{bare}" in tracked:
        return True
    return any(entry.startswith(bare + "/") for entry in tracked)


class ProseRoutesResolveTests(unittest.TestCase):
    def setUp(self):
        self.tracked = _tracked()
        self.branches = _branches()
        self.roots = tuple(f"{name}/" for name in TOP_LEVEL_DIRECTORIES) + (".ai/",)

    def test_every_backticked_repo_path_in_tracked_prose_exists(self):
        broken: dict[str, set[str]] = {}
        for name in sorted(self.tracked):
            if not name.endswith(".md"):
                continue
            text = (ROOT / name).read_text(errors="replace")
            for match in _PATH_IN_PROSE.finditer(text):
                path = match.group(1)
                if not path.startswith(self.roots):
                    continue
                if path in UNRESOLVED_BY_DESIGN or path in self.branches:
                    continue
                if not _resolves(path, self.tracked):
                    broken.setdefault(path, set()).add(name)

        self.assertEqual(
            broken,
            {},
            "tracked prose names repository paths that are not here. Either "
            "land the file, reword the sentence to say where it lives, or add "
            "it to UNRESOLVED_BY_DESIGN with the reason.",
        )

    def test_the_allowlist_holds_no_entry_that_now_resolves(self):
        """Otherwise the list outlives its reasons and stops being read."""
        resolved = {
            path
            for path in UNRESOLVED_BY_DESIGN
            if _resolves(path, self.tracked)
        }

        self.assertEqual(
            resolved,
            set(),
            "these paths are in UNRESOLVED_BY_DESIGN but now exist; drop them "
            "from the set so it keeps describing only deliberate absences.",
        )

    def test_a_path_that_is_not_here_is_actually_caught(self):
        """The discriminating case: the checker's own negative control.

        Without this, a regex that matched nothing would pass the first test
        for the wrong reason -- which is the defect class this file exists for.
        """
        self.assertFalse(_resolves("harness/no_such_probe.py", self.tracked))
        self.assertTrue(_resolves("harness/score.py", self.tracked))
        self.assertTrue(_resolves("rust/comments.rs", self.tracked))
        self.assertTrue(_resolves("docs/", self.tracked))

    def test_a_branch_name_is_not_read_as_a_path(self):
        """`spike/` is both a directory and a branch namespace."""
        self.assertIn("spike/a2-price", self.branches)
        self.assertFalse(_resolves("spike/a2-price", self.tracked))
        self.assertNotIn("spike/scanner-vm", self.branches)
        self.assertTrue(_resolves("spike/scanner-vm", self.tracked))
