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
# nowhere is a defect of whatever change broke it. Three landed in one week:
# `docs/onboarding/FINDINGS.md` named a report that lived only on
# `spike/rust-subwidth`; `docs/a2-inline-price.md` -- written on a spike branch
# and landed here alone -- labelled seven files "(tracked)" when three had
# stayed behind; and `docs/parse-all-languages.md` named a scanner under
# `spike/scanner-vm/` after it moved to `harness/scanners/`. None is visible to
# any other gate: the prose is valid, the build is green, and only a reader
# following the path finds out.

# Branch names share a prefix with real paths -- `spike/` is both a tracked
# directory and a branch namespace -- so prose citing a branch must be
# distinguished from prose citing a file. This list is tracked rather than read
# from `refs/heads/`, because a fresh clone has only `main` locally and a gate
# that consults the author's refs is green for its author and red for everyone
# else. Whether these branches still exist is a maintenance question, not a
# question for the default suite.
BRANCH_REFERENCES = frozenset({
    "spike/a2-price",
    "spike/alignment",
    "spike/cell-node",
    "spike/cell-node-agy",
    "spike/rust-alignment",
    "spike/rust-subwidth",
})

# Paths that are deliberately absent, each scoped to the document that names it
# and each with a reason. Scoping is the point: a global exception would let the
# same wrong instruction reappear in a different file, which is the defect this
# check exists to catch.
UNRESOLVED_BY_DESIGN = {
    # Build outputs, gitignored and named to tell a reader what to run or what
    # a tool wrote.
    ("DESIGN.md", "web/data/blobs/"),
    ("README.md", "web/data/blobs/"),
    ("REVIEW.md", "web/vendor/"),
    ("web/README.md", "web/data/"),
    ("web/README.md", "web/vendor/"),
    (".ai/done-header-silence.md", "rust/target/debug/docfmt"),
    (".ai/done-header-silence.md", "rust/target/debug/hl-rust"),
    (".ai/ledger-audit.md", "rust/target/release/docfmt"),
    (".ai/reviews/a2b/hermetic/note.md", "rust/target"),
    (".ai/reviews/a2b/hermetic/note.md", "web/data/"),
    (".ai/reviews/a2b/hermetic/note.md", "web/data/blobs/"),
    (".ai/reviews/a2b/hermetic/note.md", "web/data/blobs/markdown.blob.json"),
    (".ai/reviews/a2b/hermetic/note.md", "web/vendor/"),
    (".ai/reviews/a2/q30flag/note.md", "web/data/"),
    (".ai/reviews/a2/q30flag/note.md", "web/data/blobs/"),
    (".ai/reviews/a2/q30flag/note.md", "web/vendor/"),
    ("docs/a2-inline-price.md", "web/data/blobs/markdown.blob.json"),
    ("docs/a2-inline-price.md", "web/data/blobs/markdown_inline.blob.json"),
    # Prospective: both documents discuss what writing an Aven package *would*
    # involve. No such package is planned to exist here.
    ("docs/highlight-design.md", "packages/aven.json"),
    ("docs/tree-interface-probe.md", "packages/aven.json"),
    # Retained on `spike/a2-price` on purpose -- `E2-COVERAGE.json` is 1.2 MB of
    # generated measurement and these regenerate it against the predicate it
    # measured. Appendix B of that file says so at each entry.
    ("docs/a2-inline-price.md", "harness/probe_a2_coverage.py"),
    ("docs/a2-inline-price.md", "harness/probe_a2_driver.mjs"),
    # Frozen-note spellings: a typo for `corpus/reference`, and a corpus case id
    # written without its extension.
    (".ai/done-a2-foundation.md", "corpus/references"),
    (".ai/ledger-audit.md", "rust/leading_pipes"),
    # The findings log names this path *as the defect* -- it moved to
    # `harness/scanners/` in `45c76a1` and `docs/parse-all-languages.md` did not
    # follow. Quoting a dead path to say why it was dead is the one case where
    # tracked prose should name something absent, and scoping the pair to
    # REVIEW.md means restoring the wrong path in the document it broke still
    # fails -- which a global exception did not.
    ("REVIEW.md", "spike/scanner-vm/toml.program.js"),
    # Same path, same reason, in the review record that found it. Enumerating
    # these rather than exempting `.ai/reviews/**` wholesale is deliberate: a
    # blanket rule would let a genuinely wrong route hide in a review note, and
    # the reviewer who asked for document scoping also said that generating
    # exemptions automatically would undermine the check.
    (".ai/reviews/merge/astra/note-01.md", "spike/scanner-vm/toml.program.js"),
    (".ai/reviews/merge/astra/note-02.md", "spike/scanner-vm/toml.program.js"),
    (".ai/reviews/merge/astra/prompt-03.md", "spike/scanner-vm/toml.program.js"),
}

_PATH_IN_PROSE = re.compile(r"`([A-Za-z0-9_./-]+)`")


def _tracked() -> set[str]:
    out = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
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


def broken_routes(
    documents: dict[str, str], tracked: set[str]
) -> dict[str, set[str]]:
    """Backticked repo paths in `documents` that do not resolve.

    Takes the documents as text rather than reading them, so the negative
    control below can drive this exact function -- extraction, prefix filter,
    scoped exceptions and resolution -- on a synthetic page. A control that
    called `_resolves` directly would pass even if the regex matched nothing,
    which is the shape of vacuous gate this file exists to prevent.
    """
    roots = tuple(f"{name}/" for name in TOP_LEVEL_DIRECTORIES) + (".ai/",)
    broken: dict[str, set[str]] = {}
    for name, text in documents.items():
        for match in _PATH_IN_PROSE.finditer(text):
            path = match.group(1)
            if not path.startswith(roots):
                continue
            if path in BRANCH_REFERENCES:
                continue
            if (name, path) in UNRESOLVED_BY_DESIGN:
                continue
            if not _resolves(path, tracked):
                broken.setdefault(path, set()).add(name)
    return broken


class ProseRoutesResolveTests(unittest.TestCase):
    def setUp(self):
        self.tracked = _tracked()
        self.documents = {
            name: (ROOT / name).read_text(errors="replace")
            for name in sorted(self.tracked)
            if name.endswith(".md")
        }

    def test_every_backticked_repo_path_in_tracked_prose_exists(self):
        self.assertEqual(
            broken_routes(self.documents, self.tracked),
            {},
            "tracked prose names repository paths that are not here. Either "
            "land the file, reword the sentence to say where it lives, or add "
            "the (document, path) pair to UNRESOLVED_BY_DESIGN with a reason.",
        )

    def test_the_scan_is_actually_looking(self):
        """The negative control, through the real extraction.

        A regex that matched nothing, a prefix filter that excluded everything,
        or an exception applied too widely would each leave the test above
        green. Driving a synthetic page through `broken_routes` catches all
        three, because the assertion names the route it must report.
        """
        page = "Run `harness/no_such_probe.py` against `harness/score.py`.\n"

        found = broken_routes({"synthetic.md": page}, self.tracked)

        self.assertEqual(found, {"harness/no_such_probe.py": {"synthetic.md"}})

    def test_an_exception_is_scoped_to_the_document_that_earned_it(self):
        """Restoring a known-wrong path in the document it broke must fail.

        `REVIEW.md` may quote `spike/scanner-vm/toml.program.js` because its
        findings entry explains that the path is dead. The same string in
        `docs/parse-all-languages.md` is the original defect.
        """
        quoted = "It moved from `spike/scanner-vm/toml.program.js`.\n"

        self.assertEqual(broken_routes({"REVIEW.md": quoted}, self.tracked), {})
        self.assertEqual(
            broken_routes({"docs/parse-all-languages.md": quoted}, self.tracked),
            {"spike/scanner-vm/toml.program.js": {"docs/parse-all-languages.md"}},
        )

    def test_no_exception_outlives_its_reason(self):
        """Otherwise the list stops describing deliberate absences."""
        resolved = {
            (name, path)
            for name, path in UNRESOLVED_BY_DESIGN
            if _resolves(path, self.tracked)
        }

        self.assertEqual(
            resolved,
            set(),
            "these paths are allowlisted but now exist; drop the pairs so the "
            "set keeps describing only deliberate absences.",
        )

    def test_every_exception_names_a_document_that_exists(self):
        """A pair keyed on a renamed file silently exempts nothing."""
        orphans = {
            (name, path)
            for name, path in UNRESOLVED_BY_DESIGN
            if name not in self.tracked
        }

        self.assertEqual(orphans, set())

    def test_a_branch_reference_is_not_read_as_a_path(self):
        """`spike/` is both a tracked directory and a branch namespace."""
        page = "See `spike/a2-price` and `spike/scanner-vm/vm.js`.\n"

        self.assertEqual(broken_routes({"docs/x.md": page}, self.tracked), {})
        self.assertFalse(_resolves("spike/a2-price", self.tracked))
        self.assertTrue(_resolves("spike/scanner-vm", self.tracked))
