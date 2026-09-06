// tree-sitter-typescript 0.23.2's scanner, hand-compiled to scanner-VM
// bytecode. Upstream source is reproduced in comments so the two can be diffed
// by eye; that is the only review this port gets.
//
// The scanner is a 13-line shim over `common/scanner.h`, which the repo shares
// with its tsx grammar. `docs/parse-all-languages.md` corrected an earlier
// claim that typescript would be free once javascript was done -- the header
// differs from javascript's `scanner.c` in 145 of 364 lines -- and porting both
// puts a number on it: `scan_template_chars` and `scan_jsx_text` are
// character-for-character identical, and *every other function differs*.
//
//   - two extra token types, FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON and an
//     ERROR_RECOVERY that the scanner declares and never reads;
//   - `scan_whitespace_and_comments` returns a bool rather than a tri-state,
//     takes no `consume` flag, tracks no block newline, and stops its line
//     comment at '\n' only -- javascript also stops at U+2028 and U+2029;
//   - `scan_automatic_semicolon` has no '/' arm, no
//     `is_at_included_range_start`, and a `}` arm that skips trailing space to
//     look for ':' so that `type F = ({a}: {a: number}) => number` is not cut
//     in half;
//   - its switch moves ':' and '.' to the reject list, and makes '{', '(' and
//     '[' conditional on which symbols are valid;
//   - `scan_ternary_qmark` rejects `?.` as well as `??`, then consumes
//     whitespace with *advance* rather than skip, and rejects ':' ')' ','.
//
// So the honest figure is that sharing bought the two identical functions and
// nothing else. That is the general lesson for the four scanners left: a shared
// header is evidence of a shared *shape*, not of shared code.
'use strict';
const fs = require('fs');
const path = require('path');
const { Asm } = require('../../spike/scanner-vm/asm.js');

const CTYPE = path.join(__dirname, '..', 'ctype', 'wctype.utf8.json');

// `common/scanner.h`'s `enum TokenType` -- javascript's eight plus two.
const AUTOMATIC_SEMICOLON = 0;
const TEMPLATE_CHARS = 1;
const TERNARY_QMARK = 2;
const HTML_COMMENT = 3;
const LOGICAL_OR = 4;
const ESCAPE_SEQUENCE = 5;
const REGEX_PATTERN = 6;
const JSX_TEXT = 7;
const FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON = 8;

const C_SPACE = 0;
const C_ALPHA = 1;
const C_DIGIT = 2;

const R_HAS = 0;                          // has_content / saw_text
const R_NL = 1;                           // at_newline
const R_WS = 2;                           // is_wspace
const R_RES = 3;                          // scan_whitespace_and_comments' bool
const R_SCOM = 4;                         // *scanned_comment
const R_RET = 5;                          // scan_automatic_semicolon's verdict

const CH = (c) => c.codePointAt(0);
const LS = 0x2028;
const PS = 0x2029;

function build() {
  const ctype = JSON.parse(fs.readFileSync(CTYPE, 'utf8')).classes;
  const a = new Asm();

  // ======================================================================
  // external_scanner_scan
  // ======================================================================

  //   if (valid[TEMPLATE_CHARS]) {
  //     if (valid[AUTOMATIC_SEMICOLON]) return false;
  //     return scan_template_chars(lexer);
  //   }
  a.label('entry');
  a.ifNValid(TEMPLATE_CHARS, 'jsx_check');
  a.ifValid(AUTOMATIC_SEMICOLON, 'fail');
  a.jmp('template');

  //   if (valid[JSX_TEXT] && scan_jsx_text(lexer)) return true;
  a.label('jsx_check');
  a.ifNValid(JSX_TEXT, 'asi_check');
  a.call('jsx_text');
  a.ifCmpI('ne', R_HAS, 0, 'emit_jsx');

  //   if (valid[AUTOMATIC_SEMICOLON] || valid[FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON]) {
  //     bool scanned_comment = false;
  //     bool ret = scan_automatic_semicolon(lexer, valid_symbols, &scanned_comment);
  //     if (!ret && !scanned_comment && valid[TERNARY_QMARK] && lookahead == '?')
  //       return scan_ternary_qmark(lexer);
  //     return ret;
  //   }
  a.label('asi_check');
  a.ifValid(AUTOMATIC_SEMICOLON, 'asi_call');
  a.ifNValid(FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON, 'ternary_check');
  a.label('asi_call');
  a.const_(R_SCOM, 0);
  a.call('asi');
  a.ifCmpI('ne', R_RET, 0, 'emit_asi');
  a.ifCmpI('ne', R_SCOM, 0, 'fail');
  a.ifNValid(TERNARY_QMARK, 'fail');
  a.ifNChar(CH('?'), 'fail');
  a.jmp('ternary');

  //   if (valid[TERNARY_QMARK]) return scan_ternary_qmark(lexer);
  //   if (valid[HTML_COMMENT] && !valid[LOGICAL_OR] && !valid[ESCAPE_SEQUENCE] &&
  //       !valid[REGEX_PATTERN]) return scan_closing_comment(lexer);
  //   return false;
  a.label('ternary_check');
  a.ifValid(TERNARY_QMARK, 'ternary');
  a.ifNValid(HTML_COMMENT, 'fail');
  a.ifValid(LOGICAL_OR, 'fail');
  a.ifValid(ESCAPE_SEQUENCE, 'fail');
  a.ifValid(REGEX_PATTERN, 'fail');
  a.jmp('closing_comment');

  a.label('emit_jsx');
  a.emit(JSX_TEXT);
  a.label('emit_asi');
  a.emit(AUTOMATIC_SEMICOLON);
  a.label('fail');
  a.fail();

  // ---- scan_template_chars ----------------------------------------------
  // Identical to javascript's; see that file for the increment-clause note.
  a.label('template');
  a.const_(R_HAS, 0);
  a.label('tpl_loop');
  a.markEnd();
  a.ifChar(0x60, 'tpl_return');
  a.ifChar(0, 'fail');
  a.ifChar(0x5c, 'tpl_return');
  a.ifNChar(CH('$'), 'tpl_default');
  a.advance();
  a.ifChar(CH('{'), 'tpl_return');
  a.jmp('tpl_next');
  a.label('tpl_default');
  a.advance();
  a.label('tpl_next');
  a.const_(R_HAS, 1);
  a.jmp('tpl_loop');
  a.label('tpl_return');
  a.emitIf(R_HAS, TEMPLATE_CHARS);

  // ---- scan_jsx_text -> R_HAS -------------------------------------------
  // Also identical to javascript's.
  a.label('jsx_text');
  a.const_(R_HAS, 0);
  a.const_(R_NL, 0);
  a.label('jsx_loop');
  a.ifChar(0, 'jsx_done');
  for (const c of '<>{}&') a.ifChar(CH(c), 'jsx_done');
  a.const_(R_WS, 0);
  a.ifNClass(C_SPACE, 'jsx_not_space');
  a.const_(R_WS, 1);
  a.label('jsx_not_space');
  a.ifNChar(0x0a, 'jsx_else');
  a.const_(R_NL, 1);
  a.jmp('jsx_advance');
  a.label('jsx_else');
  a.alu('and', R_NL, R_WS);
  a.ifCmpI('ne', R_NL, 0, 'jsx_advance');
  a.const_(R_HAS, 1);
  a.label('jsx_advance');
  a.advance();
  a.jmp('jsx_loop');
  a.label('jsx_done');
  a.ret();

  // ---- scan_ternary_qmark -----------------------------------------------
  //   while (iswspace(lookahead)) skip;
  //   if (lookahead == '?') {
  //     advance;
  //     if (lookahead == '?' || lookahead == '.') return false;   // ?? and ?.
  //     mark_end; result = TERNARY_QMARK;
  //     while (iswspace(lookahead)) advance;      // advance, not skip
  //     if (lookahead == ':' || ')' || ',') return false;
  //     if (lookahead == '.') { advance; return iswdigit(lookahead); }
  //     return true;
  //   }
  //   return false;
  //
  // The second loop advances rather than skips, after mark_end -- so trailing
  // whitespace is consumed by the lexer and excluded from the token.
  a.label('ternary');
  a.ifNClass(C_SPACE, 'tq_qmark');
  a.skip();
  a.jmp('ternary');
  a.label('tq_qmark');
  a.ifNChar(CH('?'), 'fail');
  a.advance();
  a.ifChar(CH('?'), 'fail');
  a.ifChar(CH('.'), 'fail');
  a.markEnd();
  a.label('tq_space');
  a.ifNClass(C_SPACE, 'tq_after');
  a.advance();
  a.jmp('tq_space');
  a.label('tq_after');
  a.ifChar(CH(':'), 'fail');
  a.ifChar(CH(')'), 'fail');
  a.ifChar(CH(','), 'fail');
  a.ifNChar(CH('.'), 'tq_true');
  a.advance();
  a.ifClass(C_DIGIT, 'tq_true');
  a.jmp('fail');
  a.label('tq_true');
  a.emit(TERNARY_QMARK);

  // ---- scan_closing_comment ---------------------------------------------
  // Identical to javascript's scan_html_comment, name aside.
  a.label('closing_comment');
  a.ifClass(C_SPACE, 'cc_skip');
  a.ifChar(LS, 'cc_skip');
  a.ifChar(PS, 'cc_skip');
  a.jmp('cc_start');
  a.label('cc_skip');
  a.skip();
  a.jmp('closing_comment');
  a.label('cc_start');
  a.ifChar(CH('<'), 'cc_open');
  a.ifChar(CH('-'), 'cc_close');
  a.jmp('fail');
  a.label('cc_open');
  for (const c of '<!--') { a.ifNChar(CH(c), 'fail'); a.advance(); }
  a.jmp('cc_body');
  a.label('cc_close');
  for (const c of '-->') { a.ifNChar(CH(c), 'fail'); a.advance(); }
  a.label('cc_body');
  a.ifChar(0, 'cc_emit');
  a.ifChar(0x0a, 'cc_emit');
  a.ifChar(LS, 'cc_emit');
  a.ifChar(PS, 'cc_emit');
  a.advance();
  a.jmp('cc_body');
  a.label('cc_emit');
  a.markEnd();
  a.emit(HTML_COMMENT);

  // ---- scan_whitespace_and_comments -> R_RES ----------------------------
  //   for (;;) {
  //     while (iswspace(lookahead)) skip;
  //     if (lookahead == '/') {
  //       skip;
  //       if (lookahead == '/') {
  //         skip;
  //         while (lookahead != 0 && lookahead != '\n') skip;
  //         *scanned_comment = true;
  //       } else if (lookahead == '*') {
  //         skip;
  //         while (lookahead != 0) {
  //           if (lookahead == '*') { skip; if (lookahead == '/') { skip; break; } }
  //           else skip;
  //         }
  //       } else return false;
  //     } else return true;
  //   }
  //
  // Note the block-comment arm never sets *scanned_comment -- only the line
  // comment does. javascript sets it in both.
  a.label('wsc');
  a.label('wsc_top');
  a.ifNClass(C_SPACE, 'wsc_slash');
  a.skip();
  a.jmp('wsc_top');
  a.label('wsc_slash');
  a.ifNChar(CH('/'), 'wsc_true');
  a.skip();
  a.ifChar(CH('/'), 'wsc_line');
  a.ifChar(CH('*'), 'wsc_block');
  a.const_(R_RES, 0);
  a.ret();
  a.label('wsc_true');
  a.const_(R_RES, 1);
  a.ret();
  a.label('wsc_line');
  a.skip();
  a.label('wsc_line_loop');
  a.ifChar(0, 'wsc_line_end');
  a.ifChar(0x0a, 'wsc_line_end');
  a.skip();
  a.jmp('wsc_line_loop');
  a.label('wsc_line_end');
  a.const_(R_SCOM, 1);
  a.jmp('wsc_top');
  a.label('wsc_block');
  a.skip();
  a.label('wsc_block_loop');
  a.ifChar(0, 'wsc_top');
  a.ifNChar(CH('*'), 'wsc_block_other');
  a.skip();
  a.ifNChar(CH('/'), 'wsc_block_loop');
  a.skip();
  a.jmp('wsc_top');
  a.label('wsc_block_other');
  a.skip();
  a.jmp('wsc_block_loop');

  // ---- scan_automatic_semicolon -> R_RET --------------------------------
  //   result = AUTOMATIC_SEMICOLON; mark_end;
  //   for (;;) {
  //     if (lookahead == 0) return true;
  //     if (lookahead == '}') {
  //       // ASI breaks object patterns in a typed context:
  //       //   type F = ({a}: {a: number}) => number;
  //       do { skip; } while (iswspace(lookahead));
  //       if (lookahead == ':') return valid[LOGICAL_OR];
  //       return true;
  //     }
  //     if (!iswspace(lookahead)) return false;
  //     if (lookahead == '\n') break;
  //     skip;
  //   }
  //
  // The `!iswspace` test comes *before* the newline break here; javascript has
  // them the other way round, which matters only for its U+2028/U+2029 cases.
  a.label('asi');
  a.markEnd();
  a.label('asi_loop');
  a.ifChar(0, 'asi_true');
  a.ifNChar(CH('}'), 'asi_space');
  a.label('asi_brace_skip');
  a.skip();
  a.ifClass(C_SPACE, 'asi_brace_skip');
  a.ifNChar(CH(':'), 'asi_true');
  // "Don't return false if we're in a ternary by checking if || is valid."
  a.ifValid(LOGICAL_OR, 'asi_true');
  a.jmp('asi_false');
  a.label('asi_space');
  a.ifNClass(C_SPACE, 'asi_false');
  a.ifChar(0x0a, 'asi_break');
  a.skip();
  a.jmp('asi_loop');

  //   skip;
  //   if (!scan_whitespace_and_comments(lexer, scanned_comment)) return false;
  a.label('asi_break');
  a.skip();
  a.call('wsc');
  a.ifCmpI('eq', R_RES, 0, 'asi_false');

  //   switch (lookahead) {
  //     case '`' ',' '.' ';' '*' '%' '>' '<' '=' '?' '^' '|' '&' '/' ':':
  //       return false;
  for (const c of '`,.;*%><=?^|&/:') a.ifChar(CH(c), 'asi_false');

  //     case '{': if (valid[FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON]) return false; break;
  //     // Don't insert before '[' or '(' unless parsing a type; the validity
  //     // of a binary operator token is how that is detected.
  //     case '(': case '[': if (valid[LOGICAL_OR]) return false; break;
  a.ifChar(CH('{'), 'asi_brace_tok');
  a.ifChar(CH('('), 'asi_open');
  a.ifChar(CH('['), 'asi_open');
  a.ifChar(CH('+'), 'asi_plus');
  a.ifChar(CH('-'), 'asi_minus');
  a.ifChar(CH('!'), 'asi_bang');
  a.ifChar(CH('i'), 'asi_i');
  a.jmp('asi_true');
  a.label('asi_brace_tok');
  a.ifValid(FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON, 'asi_false');
  a.jmp('asi_true');
  a.label('asi_open');
  a.ifValid(LOGICAL_OR, 'asi_false');
  a.jmp('asi_true');

  //     case '+': skip; return lookahead == '+';
  //     case '-': skip; return lookahead == '-';
  //     case '!': skip; return lookahead != '=';
  a.label('asi_plus');
  a.skip();
  a.ifChar(CH('+'), 'asi_true');
  a.jmp('asi_false');
  a.label('asi_minus');
  a.skip();
  a.ifChar(CH('-'), 'asi_true');
  a.jmp('asi_false');
  a.label('asi_bang');
  a.skip();
  a.ifChar(CH('='), 'asi_false');
  a.jmp('asi_true');

  //     case 'i': ... `in` / `instanceof`, identical to javascript's ...
  a.label('asi_i');
  a.skip();
  a.ifNChar(CH('n'), 'asi_true');
  a.skip();
  a.ifNClass(C_ALPHA, 'asi_false');
  for (const c of 'stanceof') { a.ifNChar(CH(c), 'asi_true'); a.skip(); }
  a.ifNClass(C_ALPHA, 'asi_false');

  a.label('asi_true');
  a.const_(R_RET, 1);
  a.ret();
  a.label('asi_false');
  a.const_(R_RET, 0);
  a.ret();

  return {
    entry: 0,
    regPersist: 0,
    stacks: [],
    stackInit: [],
    classes: [ctype.space, ctype.alpha, ctype.digit],
    maps: [],
    strings: [],
    validSets: [],
    jumpTable: [],
    code: a.build(),
  };
}

module.exports = { build };
