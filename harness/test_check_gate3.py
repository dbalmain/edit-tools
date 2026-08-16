import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import check_gate3
import gate3
import manifest


class Node:
    def __init__(
        self,
        kind: str,
        start: int,
        end: int,
        children=(),
        *,
        named: bool = True,
        extra: bool = False,
    ):
        self.type = kind
        self.start_byte = start
        self.end_byte = end
        self.children = list(children)
        self.is_named = named
        self.is_extra = extra
        self.is_missing = False


class AssignmentParser:
    """Enough tree-sitter shape for the checker, parsing `x=<number>`."""

    def parse(self, source: bytes):
        text = source.decode()
        number_at = text.index("=") + 1
        root = Node(
            "document",
            0,
            len(source),
            (
                Node("identifier", 0, number_at - 1),
                Node("number", number_at, len(source)),
            ),
        )
        return SimpleNamespace(root_node=root)


def make_manifest(path: Path, name: str, selected_gate: str) -> manifest.Manifest:
    return manifest.Manifest(
        name=name,
        extensions=(".weak",),
        grammar="tree-sitter-weak==1.0.0",
        grammar_module="tree_sitter_weak",
        grammar_symbol="language",
        injection_aliases=(),
        injections=(),
        reference="weakfmt --width {width}",
        reference_version="1.0.0",
        widths=(80,),
        reference_width="flag",
        gate3=selected_gate,
        gate3_requires=(),
        transparent_wrappers=frozenset(),
        equivalent_kinds=(),
        incomparable={},
        path=path,
    )


class AdversarialOverrideTests(unittest.TestCase):
    def test_checker_fails_a_planted_weak_override(self):
        with tempfile.TemporaryDirectory() as tmp:
            lang_dir = Path(tmp)
            (lang_dir / "weak_gate3.py").write_text(
                "def signature(text):\n"
                "    try:\n"
                "        return float(text.split('=', 1)[1])\n"
                "    except ValueError:\n"
                "        return None\n"
            )
            weak = make_manifest(lang_dir / "weak.toml", "weak", "weak")
            markdown = make_manifest(
                lang_dir / "markdown.toml", "markdown", "default"
            )
            parser = AssignmentParser()
            known = {weak.name: weak}
            bootstrapped = {**known, markdown.name: markdown}
            parsers = {weak.name: parser}

            gate3._overrides.clear()
            output = io.StringIO()
            patches = (
                mock.patch.object(gate3, "LANG_DIR", lang_dir),
                mock.patch.object(check_gate3.mf, "load_all", return_value=known),
                mock.patch.object(check_gate3.mf, "parse", return_value=markdown),
                mock.patch.object(
                    check_gate3.mf, "bootstrap", return_value=bootstrapped
                ),
                mock.patch.object(
                    check_gate3.mf, "selected", return_value=known
                ),
                mock.patch.object(
                    check_gate3.mf, "parsers", return_value=parsers
                ),
                mock.patch.object(
                    check_gate3,
                    "cases",
                    return_value=iter((("weak__case@80", "x=1", "x=1"),)),
                ),
                mock.patch.object(
                    check_gate3, "check_injection_mutations", return_value=0
                ),
                mock.patch.object(sys, "argv", ["check_gate3.py"]),
            )
            with patches[0], patches[1], patches[2], patches[3], patches[4], \
                    patches[5], patches[6], patches[7], patches[8], \
                    redirect_stdout(output):
                result = check_gate3.main()
            gate3._overrides.clear()

        self.assertEqual(result, 1)
        report = output.getvalue()
        self.assertIn("2 useful mutation(s)", report)
        self.assertIn("weak override ACCEPTS", report)
        self.assertIn("number-respell", report)
        self.assertIn("WEAKER", report)


if __name__ == "__main__":
    unittest.main()
