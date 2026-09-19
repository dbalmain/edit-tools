"""Which languages cannot be scored yet, and why.

The closure lives in `package_status.py` rather than in the scorer because
three callers need it -- `score.py`, `review_page.py` and `check_gate3.py` --
and a gate importing the scorer to reach it was the wrong direction. These
tests follow the code.

`_parse_lang` is shared with `test_score.py`, which still owns the tests for
what `score.main` does with the answer.
"""

import tempfile
import unittest
from pathlib import Path

import check_gate3
import manifest
import package_status
import review_page
import score


def pending_for(
    submission: Path,
    manifests: dict[str, manifest.Manifest],
    all_manifests: dict[str, manifest.Manifest] | None = None,
) -> dict[str, str]:
    """`awaiting_package` against a package directory on disk.

    Argument adaptation only -- it calls the real function and restates none of
    its rules. The cases below that care about the *predicate* rather than the
    directory call `package_status.awaiting_package` directly with a set.
    """
    return package_status.awaiting_package(
        package_status.roster_on_disk(submission), manifests, all_manifests
    )


def _parse_lang(
    root: Path, name: str, extra: str = "", aliases: list[str] | None = None
) -> manifest.Manifest:
    path = root / f"{name}.toml"
    alias_list = aliases if aliases is not None else [name]
    alias_toml = "[" + ", ".join(f'"{a}"' for a in alias_list) + "]"
    path.write_text(
        "\n".join(
            (
                f'name = "{name}"',
                f'extensions = [".{name}"]',
                'grammar = "tree-sitter-x==1.0.0"',
                'grammar_module = "tree_sitter_x"',
                f"injection_aliases = {alias_toml}",
                'reference = "fmt --width {width}"',
                'reference_version = "1.0.0"',
                'reference_width = "flag"',
                "widths = [80]",
                'gate3 = "default"',
                extra,
            )
        )
    )
    return manifest.parse(path)


class AwaitingPackageTests(unittest.TestCase):
    """Stage A lands a corpus; stage C lands the package. In between, a
    language must read as pending rather than as one refusal per tree."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.submission = Path(tmp.name)
        (self.submission / "packages").mkdir()
        self.langs = self.submission / "langs"
        self.langs.mkdir()

    def test_a_language_with_no_package_is_awaiting_it(self):
        (self.submission / "packages" / "json.json").write_text("{}")
        manifests = {
            "json": _parse_lang(self.langs, "json"),
            "toml": _parse_lang(self.langs, "toml"),
        }

        pending = pending_for(self.submission, manifests)

        self.assertEqual(pending, {"toml": "corpus landed, not yet scored"})

    def test_a_package_that_exists_is_scored_however_it_behaves(self):
        """A refusing package is a failure. Only a missing file is pending."""
        (self.submission / "packages" / "toml.json").write_text("{}")

        pending = pending_for(
            self.submission, {"toml": _parse_lang(self.langs, "toml")}
        )

        self.assertEqual(pending, {})


class PendingGuestTests(unittest.TestCase):
    """A host whose package exists still cannot be scored when a guest it
    formats is awaiting one. Opaque guests do not count; refusals do not
    propagate; cycles must not hang."""

    INFO_SITE = (
        "[[injections]]\n"
        'node = "fenced_code_block"\n'
        'info = "info_string"\n'
        'content = "code_fence_content"\n'
    )

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.submission = Path(tmp.name)
        (self.submission / "packages").mkdir()
        self.langs = self.submission / "langs"
        self.langs.mkdir()

    def _lang(self, name, extra="", aliases=None):
        return _parse_lang(self.langs, name, extra, aliases)

    def test_a_host_is_pending_when_an_info_guest_has_no_package(self):
        (self.submission / "packages" / "markdown.json").write_text("{}")
        manifests = {
            "json": self._lang("json"),
            "markdown": self._lang("markdown", extra=self.INFO_SITE),
        }

        pending = pending_for(self.submission, manifests)

        self.assertEqual(
            pending,
            {
                "json": "corpus landed, not yet scored",
                "markdown": "json is pending",
            },
        )

    def test_pending_propagates_transitively_and_names_the_missing_package(self):
        (self.submission / "packages" / "a.json").write_text("{}")
        (self.submission / "packages" / "b.json").write_text("{}")
        manifests = {
            "a": self._lang(
                "a", extra='injections = [{ node = "wrap", guest = "b" }]\n'
            ),
            "b": self._lang(
                "b", extra='injections = [{ node = "wrap", guest = "c" }]\n'
            ),
            "c": self._lang("c"),
            "d": self._lang("d"),
        }
        (self.submission / "packages" / "d.json").write_text("{}")

        pending = pending_for(self.submission, manifests)

        self.assertEqual(
            pending,
            {
                "a": "c is pending",
                "b": "c is pending",
                "c": "corpus landed, not yet scored",
            },
        )

    def test_a_cycle_does_not_hang(self):
        (self.submission / "packages" / "b.json").write_text("{}")
        manifests = {
            "a": self._lang(
                "a", extra='injections = [{ node = "wrap", guest = "b" }]\n'
            ),
            "b": self._lang(
                "b", extra='injections = [{ node = "wrap", guest = "a" }]\n'
            ),
        }

        pending = pending_for(self.submission, manifests)

        self.assertEqual(
            pending,
            {
                "a": "corpus landed, not yet scored",
                "b": "a is pending",
            },
        )

    def test_an_opaque_guest_does_not_pending_the_host(self):
        (self.submission / "packages" / "markdown.json").write_text("{}")
        manifests = {
            "html": self._lang("html"),
            "markdown": self._lang(
                "markdown",
                extra=(
                    "[[injections]]\n"
                    'node = "html_block"\n'
                    'guest = "html"\n'
                    "format = false\n"
                ),
            ),
        }

        pending = pending_for(self.submission, manifests)

        self.assertEqual(pending, {"html": "corpus landed, not yet scored"})

    def test_a_selected_host_is_pending_when_an_unselected_guest_is(self):
        (self.submission / "packages" / "markdown.json").write_text("{}")
        manifests = {
            "json": self._lang("json"),
            "markdown": self._lang("markdown", extra=self.INFO_SITE),
        }

        pending = pending_for(
            self.submission, {"markdown": manifests["markdown"]}, manifests
        )

        self.assertEqual(pending, {"markdown": "json is pending"})

    def test_a_present_guest_package_does_not_pending_the_host(self):
        """Only absence propagates. A file that exists is scored, refusals and all."""
        (self.submission / "packages" / "json.json").write_text("{}")
        (self.submission / "packages" / "markdown.json").write_text("{}")
        manifests = {
            "json": self._lang("json"),
            "markdown": self._lang("markdown", extra=self.INFO_SITE),
        }

        pending = pending_for(self.submission, manifests)

        self.assertEqual(pending, {})


class LivePendingPropagationTests(unittest.TestCase):
    """The json-absent repro, against the real roster and the real injections.

    The synthetic tests above build their own two-language manifests, so they
    prove the closure but not that *this* repository's injection graph has the
    shape the closure needs. These drive `manifest.load_all()` -- the real
    sixteen languages, the real `injections` tables -- and differ from it only
    in which package files exist.

    `awaiting_package` reads the package roster by `is_file()` alone, so a
    directory of empty placeholders is a faithful stand-in and **nothing in the
    working tree is touched**. An earlier version renamed the real
    `packages/json.json` aside and restored it in `finally`; a SIGKILL in that
    window left a checkout with a language missing, and the test could not run
    against a read-only tree at all.
    """

    def roster(self, *absent: str) -> Path:
        """A submission whose packages are the real roster minus `absent`."""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "packages").mkdir()
        for name in self.manifests:
            if name not in absent:
                (root / "packages" / f"{name}.json").write_text("{}")
        return root

    def setUp(self):
        self.manifests = manifest.load_all()

    def test_the_real_roster_is_complete_so_it_pends_nobody(self):
        """Also the honest statement of why the feature is inert here."""
        self.assertEqual(pending_for(score.ROOT, self.manifests), {})
        self.assertEqual(
            pending_for(self.roster(), self.manifests), {}
        )

    def test_missing_json_pends_markdown_and_not_python(self):
        pending = pending_for(self.roster("json"), self.manifests)

        self.assertEqual(pending["json"], "corpus landed, not yet scored")
        self.assertEqual(pending["markdown"], "json is pending")
        self.assertNotIn("python", pending)

    def test_the_reason_reaches_the_review_page_row(self):
        """A consumer, not just the predicate.

        `awaiting_package` returning the right dict is worth nothing if what
        reads it drops the reason. There are three readers -- `score.main`
        excludes the language, `check_gate3.main` annotates its line, and
        `review_page.status_section` puts the reason in the language row's note
        cell. The third is the one a direct call cannot see through, because
        the reason is rendered rather than returned. `score.main`'s handling is
        covered by `PendingMainTests` in `test_score.py`.
        """
        submission = self.roster("json")
        markdown = {"markdown": self.manifests["markdown"]}

        section = review_page.status_section(
            submission, markdown, [], {}, all_manifests=self.manifests
        )

        self.assertIn("json is pending", section)


class RosterPredicateTests(unittest.TestCase):
    """The seam itself: the closure is pure, and only the roster touches disk."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "packages").mkdir()
        langs = self.root / "langs"
        langs.mkdir()
        self.manifests = {
            "json": _parse_lang(langs, "json"),
            "markdown": _parse_lang(
                langs,
                "markdown",
                extra=(
                    "[[injections]]\n"
                    'node = "fenced_code_block"\n'
                    'info = "info_string"\n'
                    'content = "code_fence_content"\n'
                ),
            ),
        }

    def test_roster_on_disk_reports_presence_only(self):
        available = package_status.roster_on_disk(self.root)
        self.assertFalse(available("json"))
        (self.root / "packages" / "json.json").write_text("{}")
        self.assertTrue(available("json"))
        (self.root / "packages" / "json.json").write_text("not json at all")
        self.assertTrue(
            available("json"),
            "a package that exists and would refuse is a failure to score, "
            "not a reason to skip scoring",
        )

    def test_the_closure_needs_no_path(self):
        """Same answer from a set as from a directory, which is the point."""
        (self.root / "packages" / "markdown.json").write_text("{}")

        on_disk = pending_for(self.root, self.manifests)
        from_set = package_status.awaiting_package(
            {"markdown"}.__contains__, self.manifests
        )

        self.assertEqual(on_disk, from_set)
        self.assertEqual(from_set["json"], "corpus landed, not yet scored")
        self.assertEqual(from_set["markdown"], "json is pending")


class AdversarialLabelTests(unittest.TestCase):
    """`check_gate3`'s consumer of the closure.

    The label is the one place a reader compares gate 3 against the scorer, and
    it read as fully scored for a host whose guest was pending. `main` runs the
    whole gate, so the branch is only reachable in a test through the extracted
    function.
    """

    def label(self, name: str, arm: str = "default", **pending: str) -> str:
        return check_gate3.adversarial_state(name, arm, pending)

    def test_a_scored_language_says_nothing_about_packages(self):
        self.assertEqual(
            self.label("json"),
            "generic default -- arm inert, nothing to compare against",
        )
        self.assertEqual(self.label("yaml", arm="yaml"), "yaml override")

    def test_a_directly_missing_package_is_named(self):
        self.assertEqual(
            self.label("json", **{"json": "corpus landed, not yet scored"}),
            "generic default -- arm inert, nothing to compare against; "
            "not scored (corpus landed, not yet scored)",
        )

    def test_a_host_pending_on_its_guest_is_named_too(self):
        """The case the old `package.is_file()` test could not see."""
        self.assertEqual(
            self.label("markdown", **{"markdown": "json is pending"}),
            "generic default -- arm inert, nothing to compare against; "
            "not scored (json is pending)",
        )

    def test_the_reason_is_the_scorer_s_reason_verbatim(self):
        """Not a second phrasing of the same state -- the same string."""
        reasons = package_status.awaiting_package(
            lambda name: name != "json", self.manifests
        )

        self.assertIn(reasons["markdown"], self.label("markdown", **reasons))

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        langs = Path(tmp.name)
        self.manifests = {
            "json": _parse_lang(langs, "json"),
            "markdown": _parse_lang(
                langs,
                "markdown",
                extra=(
                    "[[injections]]\n"
                    'node = "fenced_code_block"\n'
                    'info = "info_string"\n'
                    'content = "code_fence_content"\n'
                ),
            ),
        }
