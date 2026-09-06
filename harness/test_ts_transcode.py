"""Unit tests for the ts_lex recoverer and the interval algebra under it.

`python3 -m unittest discover -s harness` picks these up, so `./test.sh` runs
them. The last test shells out to `node --test harness/ts_lr.test.mjs`, which is
how the JavaScript half reaches the same suite without editing `test.sh` -- a
shared file that four other tracks are also touching.

Everything here covers behaviour the frozen corpus cannot reach. The corpus is
3 JSON files and 16 Go files; `docs/parse-tables-spike.md` measures how little
of the blob that exercises.
"""

import re
import subprocess
import unittest
from pathlib import Path

import ts_transcode as tt

HARNESS = Path(__file__).resolve().parent

# A synthetic `parser.c` carrying only what the recoverer reads.
SOURCE = """
enum ts_symbol_identifiers {
  sym_word = 1,
  sym_nl = 2,
};

static const TSCharacterRange sym_word_character_set_1[] = {
  {'A', 'Z'}, {'a', 'z'},
};

static bool ts_lex(TSLexer *lexer, TSStateId state) {
  START_LEXER();
  eof = lexer->eof(lexer);
  switch (state) {
    case 0:
      if (eof) ADVANCE(4);
      ADVANCE_MAP(
        'a', 1,
        'b', 2,
      );
      if (set_contains(sym_word_character_set_1, 2, lookahead)) ADVANCE(1);
      if ((!eof && lookahead == 00) ||
          lookahead == '\\n') ADVANCE(3);
      if (lookahead != 0 &&
          lookahead != '\\n') SKIP(0);
      END_STATE();
    case 1:
      ACCEPT_TOKEN(sym_word);
      if ((lookahead < 'a' || 'z' < lookahead)) ADVANCE(2);
      END_STATE();
    case 2:
      ADVANCE(1);
      END_STATE();
    case 3:
      ACCEPT_TOKEN(sym_nl);
      END_STATE();
    case 4:
      ACCEPT_TOKEN(ts_builtin_sym_end);
      END_STATE();
    default:
      return false;
  }
}
"""

INT32_MIN, INT32_MAX = -(2**31), 2**31 - 1


class CStringTest(unittest.TestCase):
    def test_nul_truncates(self):
        # tree-sitter-go names its EOF terminator "\0". As a C string that is
        # the empty name, and the node's type is "" -- not "\x00".
        self.assertEqual(tt.c_string(r'"\0"'), "")
        self.assertEqual(tt.c_string(r'"ab\0cd"'), "ab")

    def test_c_escapes_json_does_not_have(self):
        self.assertEqual(tt.c_string(r'"\'"'), "'")
        self.assertEqual(tt.c_string(r'"\v"'), "\v")
        self.assertEqual(tt.c_string(r'"a\tb"'), "a\tb")


class CharLiteralTest(unittest.TestCase):
    def test_double_zero_is_zero(self):
        # `lookahead == 00` is a generator bug (parse-survey.md 3f): the
        # `\0` branch writes "lookahead == 0" then appends another 0. Harmless
        # in C, where 00 is octal zero.
        syms = tt.Symbols("enum ts_symbol_identifiers {\n  sym_a = 1,\n};")
        self.assertEqual(syms.value("00"), 0)
        self.assertEqual(syms.value("0"), 0)

    def test_escapes(self):
        self.assertEqual(tt.char_literal(r"'\n'"), 10)
        self.assertEqual(tt.char_literal(r"'\\'"), 92)
        self.assertEqual(tt.char_literal(r"'\''"), 39)
        self.assertEqual(tt.char_literal(r"'\x7f'"), 127)


class IntervalTest(unittest.TestCase):
    def test_complement_spans_the_whole_int32_line(self):
        # `lookahead != 0` must accept -1, the UTF-8 decode-error value, so the
        # domain cannot be [0, 0x10FFFF].
        got = tt.complement([(0, 0)])
        self.assertEqual(got, [(INT32_MIN, -1), (1, INT32_MAX)])

    def test_adjacent_ranges_merge(self):
        self.assertEqual(tt.norm([(1, 3), (4, 6)]), [(1, 6)])

    def test_intersect_and_union(self):
        self.assertEqual(tt.intersect([(1, 10)], [(5, 20)]), [(5, 10)])
        self.assertEqual(tt.union([(1, 3)], [(10, 12)]), [(1, 3), (10, 12)])


class CondTest(unittest.TestCase):
    def test_contradiction_emits_an_empty_set_not_an_absent_guard(self):
        # `lookahead < 0 && lookahead >= 0`. The interpreter must read the empty
        # set as "false", never as "no character test"; op 3 is the encoding for
        # a genuinely unconditional action.
        cond = tt.ranges_cond(tt.cmp_ranges("lookahead", "<", 0)).intersect(
            tt.ranges_cond(tt.cmp_ranges("lookahead", ">=", 0))
        )
        self.assertEqual(cond.emit(0, 7), [2, tt.ANY_EOF, [], 0, 7])

    def test_full_domain_has_a_non_empty_representation(self):
        cond = tt.ranges_cond(tt.ALL)
        self.assertEqual(cond.emit(0, 7), [2, tt.ANY_EOF, [INT32_MIN, INT32_MAX], 0, 7])

    def test_eof_only_and_not_eof_collapse(self):
        self.assertEqual(tt.Cond(tt.ALL, []).emit(0, 3)[:2], [2, tt.IS_EOF])
        self.assertEqual(tt.Cond([], tt.ALL).emit(0, 3)[:2], [2, tt.NOT_EOF])

    def test_disagreeing_clauses_need_the_split_encoding(self):
        # (!eof && lookahead == 0) || lookahead == '\n'
        cond = tt.Cond([], [(0, 0)]).union(tt.ranges_cond([(10, 10)]))
        op = cond.emit(0, 3)
        self.assertEqual(op[0], 4, "an eof-dependent guard cannot collapse to op 2")
        self.assertEqual(op[1], [0, 0, 10, 10], "not at eof: NUL or newline")
        self.assertEqual(op[2], [10, 10], "at eof: newline only")


class LexRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.syms = tt.Symbols(SOURCE)
        self.sets = tt.parse_charsets(SOURCE)
        self.states = tt.parse_lex_fn(SOURCE, "ts_lex", self.syms, self.sets)

    def test_character_set_is_found_without_const(self):
        # 0.23/0.24-era generators emit `static TSCharacterRange`, not
        # `static const`. haskell, kotlin, typescript and xml all do.
        source = SOURCE.replace("static const TSCharacterRange", "static TSCharacterRange")
        sets = tt.parse_charsets(source)
        self.assertEqual(sets["sym_word_character_set_1"], [(65, 90), (97, 122)])

    def test_every_case_becomes_a_state(self):
        self.assertEqual(len(self.states), 5)

    def test_eof_guard_is_first_and_carries_the_eof_mode(self):
        first = self.states[0]["o"][0]
        self.assertEqual(first, [2, tt.IS_EOF, [INT32_MIN, INT32_MAX], 0, 4])

    def test_advance_map_keeps_its_order(self):
        self.assertEqual(self.states[0]["o"][1], [1, [ord("a"), 1, ord("b"), 2]])

    def test_set_contains_expands_to_the_table(self):
        self.assertEqual(self.states[0]["o"][2], [2, tt.ANY_EOF, [65, 90, 97, 122], 0, 1])

    def test_eof_split_guard_recovers_as_op_4(self):
        op = self.states[0]["o"][3]
        self.assertEqual(op, [4, [0, 0, 10, 10], [10, 10], 0, 3])

    def test_negated_conjunction_becomes_one_interval_set(self):
        # `lookahead != 0 && lookahead != '\n'` -> SKIP
        op = self.states[0]["o"][4]
        self.assertEqual(op, [2, tt.ANY_EOF, [INT32_MIN, -1, 1, 9, 11, INT32_MAX], 1, 0])

    def test_accept_token_then_negated_range(self):
        self.assertEqual(self.states[1]["o"][0], [0, self.syms.sym["sym_word"]])
        self.assertEqual(
            self.states[1]["o"][1],
            [2, tt.ANY_EOF, [INT32_MIN, 96, 123, INT32_MAX], 0, 2],
        )

    def test_unconditional_advance_is_op_3(self):
        # The generator can emit a bare ADVANCE when the character set
        # simplifies away; it does not in any pinned grammar, so this is the
        # only place it is exercised.
        self.assertEqual(self.states[2]["o"], [[3, 0, 1]])

    def test_unknown_construct_raises_rather_than_being_skipped(self):
        broken = SOURCE.replace("if (eof) ADVANCE(4);", "lexer->mark_end(lexer);")
        with self.assertRaises(tt.Unrecognised):
            tt.parse_lex_fn(broken, "ts_lex", self.syms, self.sets)

    def test_unknown_character_set_raises(self):
        broken = SOURCE.replace("sym_word_character_set_1, 2,", "nonexistent_set, 2,")
        with self.assertRaises(tt.Unrecognised):
            tt.parse_lex_fn(broken, "ts_lex", self.syms, self.sets)

    def test_wrong_character_set_length_raises(self):
        broken = SOURCE.replace("sym_word_character_set_1, 2,", "sym_word_character_set_1, 3,")
        with self.assertRaises(tt.Unrecognised):
            tt.parse_lex_fn(broken, "ts_lex", self.syms, self.sets)


class InterpreterSuiteTest(unittest.TestCase):
    # A floor, not the exact count, so adding a test does not break this -- but
    # dropping the suite does. `node --test` exits 0 on a file it collected no
    # tests from, so the return code alone cannot tell a passing suite from a
    # suite that stopped being run.
    MIN_INTERPRETER_TESTS = 19

    def test_javascript_lexer_tests_pass(self):
        result = subprocess.run(
            ["node", "--test", str(HARNESS / "ts_lr.test.mjs")],
            capture_output=True,
            text=True,
        )
        report = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, report)
        passed = re.search(r"^\u2139 pass (\d+)$", result.stdout, re.MULTILINE)
        self.assertIsNotNone(passed, report)
        self.assertGreaterEqual(int(passed.group(1)), self.MIN_INTERPRETER_TESTS, report)


class ScannerPortTest(unittest.TestCase):
    """The ported external scanners, against what the real C scanners did.

    Two separate hazards, so two separate gates.

    `--check` catches a `.svm` that no longer matches the source it was
    assembled from -- the hazard `spike/scanner-vm/build-svm.js` was written
    for, when a committed artifact had been produced by a command nobody could
    re-run.

    The replay catches a port that is wrong. Its floor is a **call count**, not
    an exit status: a replay that stops finding traces, or a scanner that quietly
    stops being replayed, exits 0 with nothing done and would read green
    forever. The numbers below are what the committed traces contain, so a drop
    is as much a failure as a mismatch.

    The state count is floored separately for the same reason. xml is the first
    port that carries state across tokens, and its serialize/deserialize
    correspondence is a different check from its scan behaviour -- one that a
    replay could stop performing while still walking every call.
    """

    # toml 230 scan calls, css 450, xml 803, html 1102, python 2194, rust 925,
    # javascript 2439, typescript 2808, kotlin 2519, ruby 1855, yaml 1480,
    # markdown 3127, haskell 2685. All thirteen external scanners are ported,
    # so this floor stops being a ratchet and becomes a regression check.
    MIN_SCANNER_CALLS = 22617
    MIN_SCANNER_STATES = 5288
    MIN_PORTED_LANGUAGES = 13

    def _run(self, script: str, *args: str) -> str:
        result = subprocess.run(
            ["node", str(HARNESS / script), *args], capture_output=True, text=True
        )
        report = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, report)
        return result.stdout

    def test_packed_scanners_match_their_source(self):
        out = self._run("ts_scanner_build.mjs", "--check")
        self.assertGreaterEqual(
            len(re.findall(r"up to date", out)), self.MIN_PORTED_LANGUAGES, out
        )

    def test_ports_replay_the_recorded_calls(self):
        out = self._run("ts_scanner_replay.mjs", "--all")
        self.assertNotIn("MISMATCH", out)
        calls = sum(int(n.replace(",", "")) for n in re.findall(r"(\d+) calls", out))
        self.assertGreaterEqual(calls, self.MIN_SCANNER_CALLS, out)
        states = sum(int(n.replace(",", "")) for n in re.findall(r"(\d+) states", out))
        self.assertGreaterEqual(states, self.MIN_SCANNER_STATES, out)


if __name__ == "__main__":
    unittest.main()
