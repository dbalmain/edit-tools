import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import reason_rot
import review_ledger


KNOWN_REASONS = {
    "css/custom_properties.css@80": (
        "The IR lacks fill, so a mixed comma and space value list can only "
        "stay flat or break every comma rather than pack two shadows on a "
        "continuation line."
    ),
    "rust/leading_pipes.rs@100": (
        "Entry 13: rustfmt deletes the redundant leading pipe in a match "
        "pattern and no opcode can express deleting a token -- a rule either "
        "emits it or refuses at the cursor. This is the second language to "
        "want the proposed drop opcode, which is the condition entry 13 set "
        "for deciding it; entry 13 has been updated to record the trigger. "
        "Gate 3 permits the deletion (the reparse is unchanged and the token "
        "is anonymous), so this is a missing opcode, not a safety rule."
    ),
    "rust/leading_pipes.rs@60": (
        "Entry 13: rustfmt deletes the redundant leading pipe in a match "
        "pattern and no opcode can express deleting a token -- a rule either "
        "emits it or refuses at the cursor. This is the second language to "
        "want the proposed drop opcode, which is the condition entry 13 set "
        "for deciding it; entry 13 has been updated to record the trigger. "
        "Gate 3 permits the deletion (the reparse is unchanged and the token "
        "is anonymous), so this is a missing opcode, not a safety rule."
    ),
}


class InventoryFromRepoTests(unittest.TestCase):
    """The live sources of truth, not a hardcoded opcode list."""

    @classmethod
    def setUpClass(cls):
        cls.inv = reason_rot.load_inventory()

    def test_opcodes_come_from_pkg_rs_not_a_list_in_this_file(self):
        self.assertIn("fill", self.inv.opcodes)
        self.assertIn("drop", self.inv.opcodes)
        self.assertIn("flatten", self.inv.opcodes)
        self.assertNotIn("column", self.inv.opcodes)
        self.assertNotIn("use", self.inv.opcodes)

    def test_predicates_include_the_shipped_ones(self):
        self.assertIn("all", self.inv.predicates)
        self.assertIn("source-multiline", self.inv.predicates)
        self.assertIn("child-count", self.inv.predicates)

    def test_headers_are_package_fields_not_nested_structs(self):
        self.assertIn("comment_cells", self.inv.headers)
        self.assertNotIn("left", self.inv.headers)
        self.assertNotIn("operator", self.inv.headers)

    def test_fill_is_used_by_a_shipped_package(self):
        self.assertIn("css.json", self.inv.package_uses["fill"])

    def test_drop_is_used_by_a_shipped_package(self):
        users = self.inv.package_uses["drop"]
        self.assertTrue(users, "drop should have a caller in packages/")

    def test_findings_8_is_built_and_1_is_not(self):
        self.assertTrue(self.inv.findings[8].built)
        self.assertFalse(self.inv.findings[1].built)
        self.assertFalse(self.inv.findings[14].built)

    def test_findings_13_counts_as_built_when_parked_with_opcode_built(self):
        finding = self.inv.findings[13]
        self.assertTrue(finding.built, finding.status)
        self.assertIn("drop", finding.related)

    def test_findings_22_is_built_and_binds_comment_cells(self):
        finding = self.inv.findings[22]
        self.assertTrue(finding.built, finding.status)
        self.assertIn("comment_cells", finding.related)


class ParseSnippetTests(unittest.TestCase):
    def test_opcode_parser_reads_the_match_arms(self):
        source = """
        match op.as_str() {
            "seq" => Ok(Expr::Seq(rest(parts)?)),
            "each" | "fill" | "opt" => Ok(Expr::Each(sel, body)),
            "drop" => Ok(Expr::Drop(literal(&parts[0])?)),
            _ => Err(format!("unknown opcode `{op}`")),
        }
        """
        self.assertEqual(
            reason_rot.parse_opcodes(source),
            frozenset({"seq", "each", "fill", "opt", "drop"}),
        )

    def test_status_is_built_keys_on_the_word_built(self):
        cases = (
            ("**built** (2026-08-17)", True),
            ("**decided — parked**. Opcode built 2026-08-20", True),
            ("**closed — built and landed**", True),
            ("**leaning build**", False),
            ("**decided — build it**", False),
            ("open", False),
        )
        for status, expect in cases:
            with self.subTest(status=status):
                self.assertEqual(reason_rot.status_is_built(status), expect)

    def test_findings_parser_splits_entries(self):
        text = """
## 8. `fill` — pack as many items per line as fit

**Status:** **built** (2026-08-17) · **Cost:** local

## 14. A third sanctioned token policy

**Status:** **decided — build it** (Dave) · **Cost:** contextual
"""
        findings = reason_rot.parse_findings(text, frozenset({"fill"}))
        self.assertTrue(findings[8].built)
        self.assertIn("fill", findings[8].related)
        self.assertFalse(findings[14].built)


class ClaimExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inv = reason_rot.load_inventory()

    def capabilities(self, reason: str) -> set[str]:
        return {hit.capability for hit in reason_rot.scan_reason(reason, self.inv)}

    def test_known_wrong_cause_reasons_flag_without_naming_their_ids(self):
        fill_hits = self.capabilities(KNOWN_REASONS["css/custom_properties.css@80"])
        self.assertIn("fill", fill_hits)
        drop_hits = self.capabilities(KNOWN_REASONS["rust/leading_pipes.rs@100"])
        self.assertIn("drop", drop_hits)
        self.assertIn("FINDINGS 13", drop_hits)

    def test_paraphrases_of_the_same_claims_also_hit(self):
        self.assertIn("fill", self.capabilities("The Doc IR lacks fill."))
        self.assertIn("fill", self.capabilities("there is no fill opcode for packing"))
        self.assertIn("drop", self.capabilities("the proposed drop opcode is the gap"))
        self.assertIn("drop", self.capabilities("no drop opcode can consume the pipe"))
        self.assertIn("FINDINGS 13", self.capabilities("Existing entry 13 still blocks this."))

    def test_existing_capability_limits_are_not_absence(self):
        silent = (
            "Hanging fill packs the first two minmax() calls and wraps the third flat.",
            "font-family now fills. Remaining: --shadow is a mixed comma/space list.",
            "fill has the desired per-separator policy but cannot traverse the spine.",
            "FINDINGS 8's missing extension: fill can pack direct children, but flatten cannot.",
            "the FINDINGS 8/21 boundary: fill admits 170 because it does not reserve the comma.",
            "FINDINGS 24 is fixed: the host continuation now reaches every guest line.",
            "this is FINDINGS entry 10 rather than entry 2.",
            "Not entry 11: that is an alternating-type spine.",
            "The existing flatten cannot express rustfmt's dot-by-dot breaks.",
            "this is existing FINDINGS 6.",
            "Rules are node-local: the same binary_query rule serves media and supports.",
            "The IR has no group-fit mode that excludes suffix trivia (FINDINGS 6).",
            "What remains is the heterogeneous method chain, which has no group to break.",
            "current fill preserves BreakParent comments, and this number array has no comments.",
        )
        for reason in silent:
            with self.subTest(reason=reason[:60]):
                self.assertEqual(self.capabilities(reason), set(), reason)

    def test_open_findings_citations_do_not_hit(self):
        self.assertNotIn("FINDINGS 6", self.capabilities("this is existing FINDINGS 6."))
        self.assertNotIn("FINDINGS 1", self.capabilities("cannot compute a sibling-derived column (FINDINGS 1)."))

    def test_source_does_not_special_case_the_fixture_ids(self):
        source = Path(reason_rot.__file__).read_text(encoding="utf-8")
        for record_id in KNOWN_REASONS:
            self.assertNotIn(record_id, source)


class LiveLedgerTests(unittest.TestCase):
    """The three audited WRONG-CAUSE records must appear in a full scan."""

    @classmethod
    def setUpClass(cls):
        cls.hits = reason_rot.scan("formatter")
        cls.by_id: dict[str, list[reason_rot.Hit]] = {}
        for hit in cls.hits:
            cls.by_id.setdefault(hit.id, []).append(hit)

    def test_flags_all_three_known_records(self):
        for record_id, reason in KNOWN_REASONS.items():
            with self.subTest(record_id=record_id):
                self.assertIn(record_id, self.by_id, f"missed {record_id}: {reason[:80]}")

    def test_each_known_hit_names_a_phrase_capability_and_evidence(self):
        for record_id in KNOWN_REASONS:
            for hit in self.by_id[record_id]:
                self.assertTrue(hit.phrase, hit)
                self.assertTrue(hit.capability, hit)
                self.assertTrue(hit.evidence, hit)
                self.assertIn(hit.phrase, KNOWN_REASONS[record_id])

    def test_custom_properties_is_fill_not_a_findings_number_it_never_cited(self):
        caps = {hit.capability for hit in self.by_id["css/custom_properties.css@80"]}
        self.assertIn("fill", caps)

    def test_ordinary_english_is_not_a_live_hit(self):
        for record_id in (
            "ruby/collections.rb@40",
            "rust/widths.rs@60",
            "typescript/sequences.ts@40",
        ):
            self.assertNotIn(record_id, self.by_id)


class CliAndRenderTests(unittest.TestCase):
    def test_render_groups_hits_and_counts_records(self):
        hit = reason_rot.Hit(
            id="css/x.css@80",
            phrase="lacks fill",
            capability="fill",
            kind="opcode",
            evidence=("fill is an opcode in rust/src/pkg.rs",),
        )
        text = reason_rot.render([hit], of=142)
        self.assertIn("reason-rot: 1 hits in 142 records", text)
        self.assertIn("css/x.css@80", text)
        self.assertIn("'lacks fill'", text)
        self.assertIn("fill (opcode)", text)

    def test_render_empty(self):
        self.assertEqual(reason_rot.render([], of=3), "reason-rot: 0 hits in 3 records\n")

    def test_scan_respects_a_temp_ledger_root(self):
        inv = reason_rot.load_inventory()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        review_ledger.approve(
            "formatter",
            "css",
            "css/sample.css@80",
            "a" * 64,
            "design limit",
            "The IR lacks fill.",
            "reviewer",
            root=root,
            reviewed_at="2026-08-16T00:00:00Z",
        )
        review_ledger.approve(
            "formatter",
            "css",
            "css/other.css@80",
            "b" * 64,
            "design limit",
            "Hanging fill packs the first two items.",
            "reviewer",
            root=root,
            reviewed_at="2026-08-16T00:00:00Z",
        )
        hits = reason_rot.scan("formatter", inv=inv, root=root)
        self.assertEqual([hit.id for hit in hits], ["css/sample.css@80"])
        self.assertEqual(hits[0].capability, "fill")

    def test_json_cli_shape(self):
        payload = json.loads(
            _stdout(lambda: reason_rot.main(["--language", "json", "--json"]))
        )
        self.assertEqual(payload["kind"], "formatter")
        self.assertEqual(payload["language"], "json")
        self.assertIn("records", payload)
        self.assertIn("hits", payload)


def _stdout(thunk) -> str:
    import io
    from contextlib import redirect_stdout

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = thunk()
    if code != 0:
        raise AssertionError(f"cli exited {code}: {buf.getvalue()}")
    return buf.getvalue()


if __name__ == "__main__":
    unittest.main()
