"""YAML formatter regressions checked with a real data-model loader."""

import subprocess
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "corpus" / "src" / "yaml" / "block_scalars.yaml"
TREE = ROOT / "corpus" / "trees" / "yaml__block_scalars.tree.json"


class YamlRoundTripTests(unittest.TestCase):
    def test_keep_chomping_round_trips_at_both_widths_in_both_runtimes(self):
        before = yaml.safe_load(SOURCE.read_text(encoding="utf-8"))
        self.assertEqual(before["keep"], "keep blanks\n\n\n")

        for formatter in ("fmt-rust", "fmt-js"):
            for width in (80, 40):
                with self.subTest(formatter=formatter, width=width):
                    result = subprocess.run(
                        [str(ROOT / formatter), str(TREE), str(width)],
                        cwd=ROOT,
                        check=True,
                        capture_output=True,
                        text=True,
                    )
                    after = yaml.safe_load(result.stdout)
                    self.assertEqual(after, before)
                    self.assertEqual(after["keep"], "keep blanks\n\n\n")


if __name__ == "__main__":
    unittest.main()
