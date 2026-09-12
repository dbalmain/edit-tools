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
