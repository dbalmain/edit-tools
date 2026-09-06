// tree-sitter-javascript 0.23.1's scanner, hand-compiled to scanner-VM
// bytecode. Upstream source is reproduced in comments so the two can be diffed
// by eye; that is the only review this port gets.
//
// Stateless -- serialize returns 0 bytes -- but not simple: the
// automatic-semicolon rule is the largest single decision procedure in any of
// the thirteen, and it calls a whitespace-and-comments scanner that returns a
// tri-state and mutates an out-parameter.
//
// ## It needed a sixth lexer call
//
// `scan_automatic_semicolon` calls `lexer->is_at_included_range_start`, which
// `docs/scanner-vm.md`'s host-interface table does not list -- and that table
// surveyed javascript. Five operations was wrong; it is six.
//
// The VM gained `IF_RANGE_START` rather than an approximation, and the *answer*
// lives in the host: for a whole-document parse there is one included range
// starting at byte zero, so it reduces to "are we at the start", but that is a
// fact about the host's ranges, not about the VM. A host that parses injected
// ranges answers differently and the bytecode does not change.
'use strict';
const fs = require('fs');
const path = require('path');
const { Asm } = require('../../spike/scanner-vm/asm.js');

const CTYPE = path.join(__dirname, '..', 'ctype', 'wctype.utf8.json');

// Upstream's `enum TokenType`.
const AUTOMATIC_SEMICOLON = 0;
const TEMPLATE_CHARS = 1;
const TERNARY_QMARK = 2;
const HTML_COMMENT = 3;
const LOGICAL_OR = 4;
const ESCAPE_SEQUENCE = 5;
const REGEX_PATTERN = 6;
const JSX_TEXT = 7;

// `enum WhitespaceResult`.
const REJECT = 0;
const NO_NEWLINE = 1;
const ACCEPT = 2;

// Class table slots.
const C_SPACE = 0;
const C_ALPHA = 1;
const C_DIGIT = 2;

// Registers. Nothing persists; the scanner is stateless.
const R_HAS = 0;                          // has_content / saw_text
const R_NL = 1;                           // at_newline
const R_WS = 2;                           // is_wspace
const R_SAWBLK = 3;                       // saw_block_newline
const R_CONSUME = 4;                      // scan_whitespace_and_comments' arg
const R_RES = 5;                          // ... and its WhitespaceResult
const R_SCOM = 6;                         // *scanned_comment, the out-param
const R_CC = 7;                           // comment_condition
const R_RET = 8;                          // scan_automatic_semicolon's verdict

const CH = (c) => c.codePointAt(0);
// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, which ECMAScript
// counts as line terminators and which this scanner tests for by hand
// everywhere it tests for '\n'.
const LS = 0x2028;
const PS = 0x2029;

function build() {
  const ctype = JSON.parse(fs.readFileSync(CTYPE, 'utf8')).classes;
  const a = new Asm();

  // ======================================================================
  // tree_sitter_javascript_external_scanner_scan
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
  // A false scan_jsx_text has still advanced the lexer, and control carries on.
  a.label('jsx_check');
  a.ifNValid(JSX_TEXT, 'asi_check');
  a.call('jsx_text');
  a.ifCmpI('ne', R_HAS, 0, 'emit_jsx');

  //   if (valid[AUTOMATIC_SEMICOLON]) {
  //     bool scanned_comment = false;
  //     bool ret = scan_automatic_semicolon(lexer, !valid[LOGICAL_OR], &scanned_comment);
  //     if (!ret && !scanned_comment && valid[TERNARY_QMARK] && lookahead == '?')
  //       return scan_ternary_qmark(lexer);
  //     return ret;
  //   }
  a.label('asi_check');
  a.ifNValid(AUTOMATIC_SEMICOLON, 'ternary_check');
  a.const_(R_SCOM, 0);
  a.const_(R_CC, 1);
  a.ifNValid(LOGICAL_OR, 'asi_call');
  a.const_(R_CC, 0);
  a.label('asi_call');
  a.call('asi');
  a.ifCmpI('ne', R_RET, 0, 'emit_asi');
  a.ifCmpI('ne', R_SCOM, 0, 'fail');
  a.ifNValid(TERNARY_QMARK, 'fail');
  a.ifNChar(CH('?'), 'fail');
  a.jmp('ternary');

  //   if (valid[TERNARY_QMARK]) return scan_ternary_qmark(lexer);
  //   if (valid[HTML_COMMENT] && !valid[LOGICAL_OR] && !valid[ESCAPE_SEQUENCE] &&
  //       !valid[REGEX_PATTERN]) return scan_html_comment(lexer);
  //   return false;
  a.label('ternary_check');
  a.ifValid(TERNARY_QMARK, 'ternary');
  a.ifNValid(HTML_COMMENT, 'fail');
  a.ifValid(LOGICAL_OR, 'fail');
  a.ifValid(ESCAPE_SEQUENCE, 'fail');
  a.ifValid(REGEX_PATTERN, 'fail');
  a.jmp('html_comment');

  a.label('emit_jsx');
  a.emit(JSX_TEXT);
  a.label('emit_asi');
  a.emit(AUTOMATIC_SEMICOLON);
  a.label('fail');
  a.fail();

  // ---- scan_template_chars ----------------------------------------------
  //   result = TEMPLATE_CHARS;
  //   for (bool has_content = false;; has_content = true) {
  //     mark_end;
  //     switch (lookahead) {
  //       case '`':  return has_content;
  //       case '\0': return false;
  //       case '$':  advance; if (lookahead == '{') return has_content; break;
  //       case '\\': return has_content;
  //       default:   advance;
  //     }
  //   }
  //
  // The increment clause is what makes this readable: has_content is false only
  // on the first pass, so `$` at position zero yields an empty token and false.
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

  // ---- scan_ternary_qmark -----------------------------------------------
  //   while (iswspace(lookahead)) skip;
  //   if (lookahead == '?') {
  //     advance;
  //     if (lookahead == '?') return false;           // `??`, not a ternary
  //     mark_end; result = TERNARY_QMARK;
  //     if (lookahead == '.') { advance; return iswdigit(lookahead); }
  //     return true;
  //   }
  //   return false;
  a.label('ternary');
  a.ifNClass(C_SPACE, 'tq_qmark');
  a.skip();
  a.jmp('ternary');
  a.label('tq_qmark');
  a.ifNChar(CH('?'), 'fail');
  a.advance();
  a.ifChar(CH('?'), 'fail');
  a.markEnd();
  a.ifNChar(CH('.'), 'tq_true');
  a.advance();
  a.ifClass(C_DIGIT, 'tq_true');
  a.jmp('fail');
  a.label('tq_true');
  a.emit(TERNARY_QMARK);

  // ---- scan_html_comment ------------------------------------------------
  //   while (iswspace(lookahead) || lookahead == 0x2028 || lookahead == 0x2029) skip;
  //   if (lookahead == '<')      match "<!--"  else
  //   if (lookahead == '-')      match "-->"   else return false;
  //   while (lookahead != 0 && != '\n' && != 0x2028 && != 0x2029) advance;
  //   result = HTML_COMMENT; mark_end; return true;
  a.label('html_comment');
  a.ifClass(C_SPACE, 'hc_skip');
  a.ifChar(LS, 'hc_skip');
  a.ifChar(PS, 'hc_skip');
  a.jmp('hc_start');
  a.label('hc_skip');
  a.skip();
  a.jmp('html_comment');
  a.label('hc_start');
  a.ifChar(CH('<'), 'hc_open');
  a.ifChar(CH('-'), 'hc_close');
  a.jmp('fail');
  a.label('hc_open');
  for (const c of '<!--') { a.ifNChar(CH(c), 'fail'); a.advance(); }
  a.jmp('hc_body');
  a.label('hc_close');
  for (const c of '-->') { a.ifNChar(CH(c), 'fail'); a.advance(); }
  a.label('hc_body');
  a.ifChar(0, 'hc_emit');
  a.ifChar(0x0a, 'hc_emit');
  a.ifChar(LS, 'hc_emit');
  a.ifChar(PS, 'hc_emit');
  a.advance();
  a.jmp('hc_body');
  a.label('hc_emit');
  a.markEnd();
  a.emit(HTML_COMMENT);

  // ---- scan_jsx_text -> R_HAS -------------------------------------------
  //   bool saw_text = false, at_newline = false;
  //   while (lookahead != 0 && != '<' && != '>' && != '{' && != '}' && != '&') {
  //     bool is_wspace = iswspace(lookahead);
  //     if (lookahead == '\n') at_newline = true;
  //     else { at_newline &= is_wspace; if (!at_newline) saw_text = true; }
  //     advance;
  //   }
  //   result = JSX_TEXT; return saw_text;
  //
  // The `&=` is upstream's, and its truth table is in a comment there: text is
  // "seen" for anything that is not a newline and not whitespace trailing one.
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

  // ---- scan_whitespace_and_comments -> R_RES ----------------------------
  //   bool saw_block_newline = false;
  //   for (;;) {
  //     while (iswspace(lookahead)) skip;
  //     if (lookahead == '/') {
  //       skip;
  //       if (lookahead == '/') { ... line comment ...; *scanned_comment = true; }
  //       else if (lookahead == '*') { ... block comment ... }
  //       else return REJECT;
  //     } else return ACCEPT;
  //   }
  //
  // Takes `consume` in R_CONSUME, returns the tri-state in R_RES, and updates
  // `*scanned_comment` in R_SCOM -- the out-parameter is just a register that
  // outlives the call.
  a.label('wsc');
  a.const_(R_SAWBLK, 0);
  a.label('wsc_top');
  a.ifNClass(C_SPACE, 'wsc_slash');
  a.skip();
  a.jmp('wsc_top');
  a.label('wsc_slash');
  a.ifNChar(CH('/'), 'wsc_accept');
  a.skip();
  a.ifChar(CH('/'), 'wsc_line');
  a.ifChar(CH('*'), 'wsc_block');
  a.const_(R_RES, REJECT);
  a.ret();
  a.label('wsc_accept');
  a.const_(R_RES, ACCEPT);
  a.ret();

  //       if (lookahead == '/') {
  //         skip;
  //         while (lookahead != 0 && != '\n' && != 0x2028 && != 0x2029) skip;
  //         *scanned_comment = true;
  //       }
  a.label('wsc_line');
  a.skip();
  a.label('wsc_line_loop');
  a.ifChar(0, 'wsc_line_end');
  a.ifChar(0x0a, 'wsc_line_end');
  a.ifChar(LS, 'wsc_line_end');
  a.ifChar(PS, 'wsc_line_end');
  a.skip();
  a.jmp('wsc_line_loop');
  a.label('wsc_line_end');
  a.const_(R_SCOM, 1);
  a.jmp('wsc_top');

  //       else if (lookahead == '*') {
  //         skip;
  //         while (lookahead != 0) {
  //           if (lookahead == '*') {
  //             skip;
  //             if (lookahead == '/') {
  //               skip; *scanned_comment = true;
  //               if (lookahead != '/' && !consume)
  //                 return saw_block_newline ? ACCEPT : NO_NEWLINE;
  //               break;
  //             }
  //           } else if (lookahead == '\n' || 0x2028 || 0x2029) {
  //             saw_block_newline = true; skip;
  //           } else skip;
  //         }
  //       }
  //
  // Note the '*' arm does not skip again when the next character is not '/':
  // it has already consumed the '*', so the loop makes progress.
  a.label('wsc_block');
  a.skip();
  a.label('wsc_block_loop');
  a.ifChar(0, 'wsc_top');
  a.ifNChar(CH('*'), 'wsc_block_newline');
  a.skip();
  a.ifNChar(CH('/'), 'wsc_block_loop');
  a.skip();
  a.const_(R_SCOM, 1);
  a.ifChar(CH('/'), 'wsc_top');
  a.ifCmpI('ne', R_CONSUME, 0, 'wsc_top');
  a.ifCmpI('ne', R_SAWBLK, 0, 'wsc_block_accept');
  a.const_(R_RES, NO_NEWLINE);
  a.ret();
  a.label('wsc_block_accept');
  a.const_(R_RES, ACCEPT);
  a.ret();
  a.label('wsc_block_newline');
  a.ifChar(0x0a, 'wsc_block_saw');
  a.ifChar(LS, 'wsc_block_saw');
  a.ifChar(PS, 'wsc_block_saw');
  a.skip();
  a.jmp('wsc_block_loop');
  a.label('wsc_block_saw');
  a.const_(R_SAWBLK, 1);
  a.skip();
  a.jmp('wsc_block_loop');

  // ---- scan_automatic_semicolon -> R_RET --------------------------------
  //   result = AUTOMATIC_SEMICOLON;
  //   mark_end;
  //   for (;;) {
  //     if (lookahead == 0) return true;
  //     if (lookahead == '/') {
  //       WhitespaceResult r = scan_whitespace_and_comments(lexer, sc, false);
  //       if (r == REJECT) return false;
  //       if (r == ACCEPT && comment_condition &&
  //           lookahead != ',' && lookahead != '=') return true;
  //     }
  //     if (lookahead == '}') return true;
  //     if (lexer->is_at_included_range_start(lexer)) return true;
  //     if (lookahead == '\n' || 0x2028 || 0x2029) break;
  //     if (!iswspace(lookahead)) return false;
  //     skip;
  //   }
  //
  // These are sequential ifs, not else-ifs: the '/' arm falls through into the
  // '}' test with the lexer wherever the comment scan left it.
  a.label('asi');
  a.markEnd();
  a.label('asi_loop');
  a.ifChar(0, 'asi_true');
  a.ifNChar(CH('/'), 'asi_brace');
  a.const_(R_CONSUME, 0);
  a.call('wsc');
  a.ifCmpI('eq', R_RES, REJECT, 'asi_false');
  a.ifCmpI('ne', R_RES, ACCEPT, 'asi_brace');
  a.ifCmpI('eq', R_CC, 0, 'asi_brace');
  a.ifChar(CH(','), 'asi_brace');
  a.ifChar(CH('='), 'asi_brace');
  a.jmp('asi_true');
  a.label('asi_brace');
  a.ifChar(CH('}'), 'asi_true');
  a.ifRangeStart('asi_true');
  a.ifChar(0x0a, 'asi_break');
  a.ifChar(LS, 'asi_break');
  a.ifChar(PS, 'asi_break');
  a.ifNClass(C_SPACE, 'asi_false');
  a.skip();
  a.jmp('asi_loop');

  //   skip;
  //   if (scan_whitespace_and_comments(lexer, sc, true) == REJECT) return false;
  //   switch (lookahead) { ... }
  //   return true;
  a.label('asi_break');
  a.skip();
  a.const_(R_CONSUME, 1);
  a.call('wsc');
  a.ifCmpI('eq', R_RES, REJECT, 'asi_false');

  // The sixteen characters after which a newline never means a semicolon: an
  // expression cannot end there, or the next line continues it.
  for (const c of '`,:;*%><=[(?^|&/') a.ifChar(CH(c), 'asi_false');

  //     case '.': skip; return iswdigit(lookahead);   // before decimal literals
  //     case '+': skip; return lookahead == '+';      // before ++ but not binary +
  //     case '-': skip; return lookahead == '-';
  //     case '!': skip; return lookahead != '=';      // before unary ! but not !=
  a.ifChar(CH('.'), 'asi_dot');
  a.ifChar(CH('+'), 'asi_plus');
  a.ifChar(CH('-'), 'asi_minus');
  a.ifChar(CH('!'), 'asi_bang');
  a.ifChar(CH('i'), 'asi_i');
  a.jmp('asi_true');
  a.label('asi_dot');
  a.skip();
  a.ifClass(C_DIGIT, 'asi_true');
  a.jmp('asi_false');
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

  //     case 'i':
  //       skip;
  //       if (lookahead != 'n') return true;
  //       skip;
  //       if (!iswalpha(lookahead)) return false;          // bare `in`
  //       for (unsigned i = 0; i < 8; i++) {
  //         if (lookahead != "stanceof"[i]) return true;
  //         skip;
  //       }
  //       if (!iswalpha(lookahead)) return false;          // exactly `instanceof`
  //       break;
  //
  // `"stanceof"[i]` is an indexed read of a constant string, which the ISA has
  // no instruction for; unrolling is exact because the word is fixed and the
  // match never backtracks. Same shape as html's raw-text delimiters.
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
