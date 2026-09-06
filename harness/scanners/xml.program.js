// tree-sitter-xml 0.7.0's scanner, hand-compiled to scanner-VM bytecode.
// Upstream source is reproduced in comments so the two can be diffed by eye;
// that is the only review this port gets.
//
// The scanner is two files: `xml/src/scanner.c` and the `common/scanner.h` it
// shares with the dtd grammar in the same repo.  Its shape is why it was
// ported third: it is the first of the thirteen to carry *string* state -- a
// stack of open tag names, matched against each closing tag -- and the ISA had
// no obvious place to put one.  It turns out to need no new instruction:
//
//   - stack 0 holds every open tag's bytes, concatenated flat;
//   - stack 1 holds one length per open tag, so stack 0 is a stack of strings
//     with a length prefix living beside it rather than in it;
//   - stack 2 holds the name currently being scanned, and the comparison is a
//     `getidx` walk over both.
//
// `bufPush`/`ifBufEq` cannot do this: `ifBufEq` compares the buffer against a
// *constant* from the strings table, and here both sides are dynamic.
//
// The two persistent stacks make xml the first port whose serialized state is
// non-empty, and the VM's serialization format is deliberately not upstream's
// -- see `harness/ts_scanner_replay.mjs` on the state-correspondence check
// that replaces the byte-for-byte one.
'use strict';
const fs = require('fs');
const path = require('path');
const { Asm } = require('../../spike/scanner-vm/asm.js');

const CTYPE = path.join(__dirname, '..', 'ctype', 'wctype.utf8.json');

// `common/scanner.h`'s `enum TokenType`, with TS_XML defined.  Load-bearing:
// the parser passes `valid_symbols` indexed by it, and the recorded traces
// carry it as an 11-bit string.
const PI_TARGET = 0;
const PI_CONTENT = 1;
const COMMENT = 2;
const CHAR_DATA = 3;
const CDATA = 4;
const XML_MODEL = 5;
const XML_STYLESHEET = 6;
const START_TAG_NAME = 7;
const END_TAG_NAME = 8;
const ERRONEOUS_END_NAME = 9;             // set by upstream, never returned true
const SELF_CLOSING_TAG_DELIMITER = 10;

// Class table slots.
const C_NAME_START = 0;                   // iswalpha || '_' || ':'
const C_NAME_CHAR = 1;                    // iswalnum || '_' || ':' || '.' || '-' || 0xB7

// Stacks.
const S_NAMES = 0;                        // persistent: open tag names, flat
const S_LENS = 1;                         // persistent: one length per open tag
const S_CUR = 2;                          // transient: the name being scanned

// Registers, all transient.
const R_SYM = 0;                          // upstream's lexer->result_symbol
const R_ADV = 1;                          // advanced_once
const R_X = 2;                            // found_x_first
const R_HYPH = 3;                         // last_char_hyphen
const R_LA = 4;
const R_I = 5;
const R_J = 6;
const R_N = 7;
const R_BASE = 8;
const R_TMP = 9;

const CH = (c) => c.codePointAt(0);

// Merge sorted inclusive [lo,hi] interval lists, coalescing anything that
// touches.  `is_valid_name_char` is `iswalnum(c) || c == '-' || ...`, and the
// VM has one class test, so the disjunction has to become one table.
function union(...lists) {
  const pairs = [];
  for (const l of lists) for (let i = 0; i < l.length; i += 2) pairs.push([l[i], l[i + 1]]);
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [lo, hi] of pairs) {
    if (out.length && lo <= out[out.length - 1] + 1) {
      if (hi > out[out.length - 1]) out[out.length - 1] = hi;
    } else {
      out.push(lo, hi);
    }
  }
  return out;
}

const one = (c) => [CH(c), CH(c)];

function build() {
  const ctype = JSON.parse(fs.readFileSync(CTYPE, 'utf8')).classes;
  const a = new Asm();

  // ======================================================================
  // tree_sitter_xml_external_scanner_scan
  // ======================================================================

  //   if (in_error_recovery(valid_symbols)) return false;
  // which is PI_TARGET && PI_CONTENT && COMMENT && CHAR_DATA && CDATA all
  // valid at once.  Never true anywhere in the recorded corpus, so this arm is
  // ported from the source rather than from evidence.
  a.label('entry');
  for (const s of [PI_TARGET, PI_CONTENT, COMMENT, CHAR_DATA, CDATA]) {
    a.ifNValid(s, 'not_recovery');
  }
  a.jmp('fail');

  a.label('not_recovery');
  //   if (valid_symbols[PI_TARGET])  return scan_pi_target(lexer, valid_symbols);
  //   if (valid_symbols[PI_CONTENT]) return scan_pi_content(lexer);
  a.ifValid(PI_TARGET, 'pi_target');
  a.ifValid(PI_CONTENT, 'pi_content');
  //   if (valid_symbols[CHAR_DATA] && scan_char_data(lexer)) return true;
  a.ifNValid(CHAR_DATA, 'try_cdata');

  // ---- scan_char_data ---------------------------------------------------
  // Inlined rather than CALLed because its false exit is not the scan's false
  // exit: it falls through to the CDATA test with the lexer already advanced,
  // and on one of its two false paths with result_symbol already set.
  //
  //   bool advanced_once = false;
  //   while (in_char_data(lexer)) {
  a.const_(R_ADV, 0);
  a.label('cd_loop');
  //     in_char_data: !eof && lookahead != '<' && lookahead != '&'
  a.ifEof('cd_done');
  a.ifChar(CH('<'), 'cd_done');
  a.ifChar(CH('&'), 'cd_done');
  //     if (lexer->lookahead == ']') {
  //       mark_end; advance;
  //       if (lookahead == ']') { advance;
  //         if (lookahead == '>') { advance;
  //           if (advanced_once) { result = CHAR_DATA; return false; }
  //   } } }
  a.ifNChar(CH(']'), 'cd_body');
  a.markEnd();
  a.advance();
  a.ifNChar(CH(']'), 'cd_body');
  a.advance();
  a.ifNChar(CH('>'), 'cd_body');
  a.advance();
  a.ifCmpI('eq', R_ADV, 0, 'cd_body');
  // The one place upstream returns false with result_symbol set; it is
  // observable, because scan_self_closing_tag_delimiter below can return true
  // without setting it.
  a.const_(R_SYM, CHAR_DATA);
  a.jmp('try_cdata');

  //     advanced_once = true;
  //     if (in_char_data(lexer)) advance(lexer);
  //   }
  a.label('cd_body');
  a.const_(R_ADV, 1);
  a.ifEof('cd_loop');
  a.ifChar(CH('<'), 'cd_loop');
  a.ifChar(CH('&'), 'cd_loop');
  a.advance();
  a.jmp('cd_loop');

  //   if (advanced_once) { mark_end; result = CHAR_DATA; return true; }
  //   return false;
  a.label('cd_done');
  a.ifCmpI('eq', R_ADV, 0, 'try_cdata');
  a.markEnd();
  a.const_(R_SYM, CHAR_DATA);
  a.emit(CHAR_DATA);

  // ---- scan_cdata -------------------------------------------------------
  //   if (valid_symbols[CDATA] && scan_cdata(lexer)) return true;
  a.label('try_cdata');
  a.ifNValid(CDATA, 'sw');
  //   bool advanced_once = false;
  //   while (!lexer->eof(lexer)) {
  a.const_(R_ADV, 0);
  a.label('cda_loop');
  a.ifEof('sw');
  //     if (lookahead == ']') { mark_end; advance;
  //       if (lookahead == ']') { advance;
  //         if (lookahead == '>' && advanced_once) { result = CDATA; return true; }
  //     } }
  a.ifNChar(CH(']'), 'cda_body');
  a.markEnd();
  a.advance();
  a.ifNChar(CH(']'), 'cda_body');
  a.advance();
  a.ifNChar(CH('>'), 'cda_body');
  a.ifCmpI('eq', R_ADV, 0, 'cda_body');
  // Note the '>' is *not* consumed and mark_end stayed at the first ']'.
  a.const_(R_SYM, CDATA);
  a.emit(CDATA);
  //     advanced_once = true;
  //     advance(lexer);
  //   }
  //   return false;
  a.label('cda_body');
  a.const_(R_ADV, 1);
  a.advance();
  a.jmp('cda_loop');

  // ---- the switch -------------------------------------------------------
  //   switch (lexer->lookahead) {
  //     case '<':  ... break;
  //     case '/':  ... break;
  //     case '\0': break;
  //     default:   ...
  //   }
  //   return false;
  a.label('sw');
  a.ifChar(CH('<'), 'sw_lt');
  a.ifChar(CH('/'), 'sw_slash');
  // `case '\0'` is EOF as well as a literal NUL byte, exactly as upstream:
  // tree-sitter's lexer reports lookahead 0 at end of input.
  a.ifChar(0, 'fail');
  //     default: if (valid[START_TAG_NAME]) return scan_start_tag_name(...);
  //              if (valid[END_TAG_NAME])   return scan_end_tag_name(...);
  a.ifValid(START_TAG_NAME, 'start_tag');
  a.ifValid(END_TAG_NAME, 'end_tag');
  a.jmp('fail');

  //     case '<': mark_end; advance;
  //               if (lookahead == '!') { advance; return scan_comment(lexer); }
  //               break;
  a.label('sw_lt');
  a.markEnd();
  a.advance();
  a.ifNChar(CH('!'), 'fail');
  a.advance();
  a.jmp('comment');

  //     case '/': if (valid[SELF_CLOSING_TAG_DELIMITER])
  //                 return scan_self_closing_tag_delimiter(tags, lexer);
  //               break;
  a.label('sw_slash');
  a.ifNValid(SELF_CLOSING_TAG_DELIMITER, 'fail');

  // ---- scan_self_closing_tag_delimiter ----------------------------------
  //   advance(lexer);
  //   advance_if_eq(lexer, '>');
  //   if (tags->size > 0) { array_pop(tags); result = SELF_CLOSING_TAG_DELIMITER; }
  //   return true;
  //
  // `advance_if_eq` is the header's macro: advance on a match, `return false`
  // from the enclosing function otherwise.
  a.advance();
  a.ifEof('fail');
  a.ifNChar(CH('>'), 'fail');
  a.advance();
  a.len(S_LENS, R_N);
  a.ifCmpI('eq', R_N, 0, 'sc_emit');
  a.pop(S_LENS, R_N);
  a.label('sc_trim');
  a.ifCmpI('eq', R_N, 0, 'sc_popped');
  a.pop(S_NAMES, R_TMP);
  a.alui('sub', R_N, 1);
  a.jmp('sc_trim');
  a.label('sc_popped');
  a.const_(R_SYM, SELF_CLOSING_TAG_DELIMITER);
  // Upstream returns true even with no open tag, leaving result_symbol at
  // whatever it was -- 0 from ts_lexer_start, or CHAR_DATA if scan_char_data
  // bailed above.  R_SYM models that field, so EMIT_R reproduces it.
  a.label('sc_emit');
  a.emitR(R_SYM);

  // ======================================================================
  // common/scanner.h
  // ======================================================================

  // ---- scan_comment -----------------------------------------------------
  //   advance_if_eq(lexer, '-');
  //   advance_if_eq(lexer, '-');
  a.label('comment');
  for (let i = 0; i < 2; i++) {
    a.ifEof('fail');
    a.ifNChar(CH('-'), 'fail');
    a.advance();
  }
  //   while (!lexer->eof(lexer)) {
  //     if (lookahead == '-') { advance; if (lookahead == '-') { advance; break; } }
  //     else advance;
  //   }
  a.label('cm_loop');
  a.ifEof('cm_end');
  a.ifNChar(CH('-'), 'cm_else');
  a.advance();
  a.ifNChar(CH('-'), 'cm_loop');
  a.advance();
  a.jmp('cm_end');
  a.label('cm_else');
  a.advance();
  a.jmp('cm_loop');
  //   if (lookahead == '>') { advance; mark_end; result = COMMENT; return true; }
  //   return false;
  a.label('cm_end');
  a.ifNChar(CH('>'), 'fail');
  a.advance();
  a.markEnd();
  a.const_(R_SYM, COMMENT);
  a.emit(COMMENT);

  // ---- scan_pi_content --------------------------------------------------
  //   while (!eof && lookahead != '\n' && lookahead != '?') advance;
  a.label('pi_content');
  a.label('pc_skip');
  a.ifEof('pc_check');
  a.ifChar(0x0a, 'pc_check');
  a.ifChar(CH('?'), 'pc_check');
  a.advance();
  a.jmp('pc_skip');
  //   if (lookahead != '?') return false;
  //   mark_end; advance;
  a.label('pc_check');
  a.ifNChar(CH('?'), 'fail');
  a.markEnd();
  a.advance();
  //   if (lookahead == '>') { advance;
  //     while (lookahead == ' ') advance;
  //     advance_if_eq(lexer, '\n');
  //     result = PI_CONTENT; return true;
  //   }
  //   return false;
  a.ifNChar(CH('>'), 'fail');
  a.advance();
  a.label('pc_sp');
  a.ifNChar(CH(' '), 'pc_nl');
  a.advance();
  a.jmp('pc_sp');
  a.label('pc_nl');
  a.ifEof('fail');
  a.ifNChar(0x0a, 'fail');
  a.advance();
  a.const_(R_SYM, PI_CONTENT);
  a.emit(PI_CONTENT);

  // ---- scan_pi_target ---------------------------------------------------
  //   bool advanced_once = false, found_x_first = false;
  //   if (is_valid_name_start_char(lookahead)) {
  //     if (lookahead == 'x' || lookahead == 'X') { found_x_first = true; mark_end; }
  //     advanced_once = true;
  //     advance;
  //   }
  //   if (advanced_once) { ... }
  //   return false;
  //
  // advanced_once is exactly "the first character was a name-start char", so
  // the `if (advanced_once)` never needs a register: the not-taken arm is the
  // scan's false exit.
  a.label('pi_target');
  a.const_(R_X, 0);
  a.ifNClass(C_NAME_START, 'fail');
  a.ifChar(CH('x'), 'pt_x');
  a.ifChar(CH('X'), 'pt_x');
  a.jmp('pt_adv');
  a.label('pt_x');
  a.const_(R_X, 1);
  a.markEnd();
  a.label('pt_adv');
  a.advance();

  //     while (is_valid_name_char(lexer->lookahead)) {
  a.label('pt_loop');
  a.ifNClass(C_NAME_CHAR, 'pt_end');
  //       if (found_x_first && (lookahead == 'm' || lookahead == 'M')) {
  a.ifCmpI('eq', R_X, 0, 'pt_tail');
  a.ifChar(CH('m'), 'pt_m');
  a.ifChar(CH('M'), 'pt_m');
  a.jmp('pt_tail');
  //         advance;
  //         if (lookahead == 'l' || lookahead == 'L') {
  a.label('pt_m');
  a.advance();
  a.ifChar(CH('l'), 'pt_l');
  a.ifChar(CH('L'), 'pt_l');
  // Falling out of the `if (l||L)` lands on the loop tail, which advances
  // again -- so the character after "?xm" is consumed without ever being
  // tested as a name char.  Upstream's behaviour, reproduced deliberately.
  a.jmp('pt_tail');
  //           advance;
  //           if (is_valid_name_char(lookahead)) {
  //             found_x_first = false;
  //             bool last_char_hyphen = lookahead == '-';
  //             advance;
  //             ...
  //           } else return false;
  a.label('pt_l');
  a.advance();
  a.ifNClass(C_NAME_CHAR, 'fail');
  a.const_(R_X, 0);
  a.const_(R_HYPH, 0);
  a.ifNChar(CH('-'), 'pt_h0');
  a.const_(R_HYPH, 1);
  a.label('pt_h0');
  a.advance();
  a.ifCmpI('eq', R_HYPH, 0, 'pt_tail');
  //             if (valid[XML_MODEL] && check_word(lexer, "model", 5)) return false;
  //             if (valid[XML_STYLESHEET] && check_word(lexer, "stylesheet", 10)) return false;
  //
  // check_word is advance_if_eq per character, so a mismatch leaves the
  // matching prefix consumed and falls through to the next test.  Inlining
  // preserves that; a shared subroutine would need the word as data.
  a.ifNValid(XML_MODEL, 'pt_ss');
  for (const c of 'model') {
    a.ifEof('pt_ss');
    a.ifNChar(CH(c), 'pt_ss');
    a.advance();
  }
  a.jmp('fail');
  a.label('pt_ss');
  a.ifNValid(XML_STYLESHEET, 'pt_tail');
  for (const c of 'stylesheet') {
    a.ifEof('pt_tail');
    a.ifNChar(CH(c), 'pt_tail');
    a.advance();
  }
  a.jmp('fail');

  //       found_x_first = false;
  //       advance;
  //     }
  a.label('pt_tail');
  a.const_(R_X, 0);
  a.advance();
  a.jmp('pt_loop');

  //     mark_end; result = PI_TARGET; return true;
  a.label('pt_end');
  a.markEnd();
  a.const_(R_SYM, PI_TARGET);
  a.emit(PI_TARGET);

  // ======================================================================
  // The tag stack
  // ======================================================================

  // ---- scan_tag_name ----------------------------------------------------
  //   String tag_name = array_new();
  //   if (is_valid_name_start_char(lookahead)) { array_push(&tag_name, (char)lookahead); advance; }
  //   while (is_valid_name_char(lookahead))    { array_push(&tag_name, (char)lookahead); advance; }
  //
  // `(char)lookahead` truncates the code point to its low 8 bits, and
  // `string_eq` then memcmps those bytes -- so two names differing only above
  // U+00FF can compare equal upstream.  Masking reproduces it.
  a.label('tag_name');
  a.clear(S_CUR);
  a.ifNClass(C_NAME_START, 'tn_loop');
  a.lookahead(R_LA);
  a.alui('and', R_LA, 0xff);
  a.push(S_CUR, R_LA);
  a.advance();
  a.label('tn_loop');
  a.ifNClass(C_NAME_CHAR, 'tn_done');
  a.lookahead(R_LA);
  a.alui('and', R_LA, 0xff);
  a.push(S_CUR, R_LA);
  a.advance();
  a.jmp('tn_loop');
  a.label('tn_done');
  a.ret();

  // ---- scan_start_tag_name ----------------------------------------------
  //   String tag_name = scan_tag_name(lexer);
  //   if (tag_name.size == 0) return false;
  //   result = START_TAG_NAME;
  //   array_push(tags, tag_name);
  //   return true;
  a.label('start_tag');
  a.call('tag_name');
  a.len(S_CUR, R_N);
  a.ifCmpI('eq', R_N, 0, 'fail');
  a.const_(R_I, 0);
  a.label('st_push');
  a.ifCmp('ge', R_I, R_N, 'st_done');
  a.getidx(S_CUR, R_TMP, R_I);
  a.push(S_NAMES, R_TMP);
  a.alui('add', R_I, 1);
  a.jmp('st_push');
  a.label('st_done');
  a.push(S_LENS, R_N);
  a.const_(R_SYM, START_TAG_NAME);
  a.emit(START_TAG_NAME);

  // ---- scan_end_tag_name ------------------------------------------------
  //   String tag_name = scan_tag_name(lexer);
  //   if (tag_name.size == 0) return false;
  //   if (tags->size > 0 && string_eq(array_back(tags), &tag_name)) {
  //     array_pop(tags); result = END_TAG_NAME;
  //   } else {
  //     result = ERRONEOUS_END_NAME;
  //   }
  //   return lexer->result_symbol == END_TAG_NAME;
  //
  // So ERRONEOUS_END_NAME is set and then thrown away -- the function returns
  // false on that arm, and the parser never sees the symbol.  All 803 recorded
  // xml scans agree: symbol 9 is never returned.
  a.label('end_tag');
  a.call('tag_name');
  a.len(S_CUR, R_N);
  a.ifCmpI('eq', R_N, 0, 'fail');
  a.len(S_LENS, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'fail');
  a.peek(S_LENS, R_J, 0);
  a.ifCmp('ne', R_J, R_N, 'fail');
  // string_eq's memcmp, over the top name's slice of the flat stack.
  a.len(S_NAMES, R_BASE);
  a.alu('sub', R_BASE, R_N);
  a.const_(R_I, 0);
  a.label('et_cmp');
  a.ifCmp('ge', R_I, R_N, 'et_match');
  a.mov(R_J, R_BASE);
  a.alu('add', R_J, R_I);
  a.getidx(S_NAMES, R_TMP, R_J);
  a.getidx(S_CUR, R_LA, R_I);
  a.ifCmp('ne', R_TMP, R_LA, 'fail');
  a.alui('add', R_I, 1);
  a.jmp('et_cmp');
  a.label('et_match');
  a.pop(S_LENS, R_N);
  a.label('et_trim');
  a.ifCmpI('eq', R_N, 0, 'et_popped');
  a.pop(S_NAMES, R_TMP);
  a.alui('sub', R_N, 1);
  a.jmp('et_trim');
  a.label('et_popped');
  a.const_(R_SYM, END_TAG_NAME);
  a.emit(END_TAG_NAME);

  a.label('fail');
  a.fail();

  return {
    entry: 0,
    regPersist: 0,                        // every register is per-scan
    stacks: [{ persist: true }, { persist: true }, { persist: false }],
    stackInit: [],
    classes: [
      union(ctype.alpha, one('_'), one(':')),
      union(ctype.alnum, one('_'), one(':'), one('.'), one('-'), [0xb7, 0xb7]),
    ],
    strings: [],
    validSets: [],
    jumpTable: [],
    code: a.build(),
  };
}

module.exports = { build, ERRONEOUS_END_NAME };
