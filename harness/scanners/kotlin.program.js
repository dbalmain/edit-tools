// tree-sitter-kotlin 1.1.0's scanner, hand-compiled to scanner-VM bytecode.
// Upstream source is reproduced in comments so the two can be diffed by eye;
// that is the only review this port gets.
//
// Stateless, and by far the most tangled control flow of the twelve: four
// `goto`s that jump *into* the middle of later blocks (`_switch`,
// `continue_not_is_from_semi`, `q_dot_from_semi`, `comment`), one of which
// jumps backwards to re-enter a switch. That is a shape the ISA handles for
// free -- every label is a jump target and there is no block structure to
// violate -- and it is worth noticing that the hardest C to *read* was not the
// hardest to port.
//
// The one real machinery is `scan_words`: a 16-byte buffer filled with up to
// fifteen alphabetic characters, then `strncmp`'d against two tables of
// sixteen-byte entries. `BUF_PUSH` and `IF_BUF_EQ` are exactly that, and the
// tables become string-table entries -- `strncmp(a, b, 16)` over zero-padded
// blocks is equality of the strings, which is what IF_BUF_EQ tests.
'use strict';
const fs = require('fs');
const path = require('path');
const { Asm } = require('../../spike/scanner-vm/asm.js');

const CTYPE = path.join(__dirname, '..', 'ctype', 'wctype.utf8.json');

// Upstream's `enum TokenType`.
const SEMI = 0;
const CLASS_MEMBER_SEMI = 1;
const BLOCK_COMMENT = 2;
const NOT_IS = 3;
const IN = 4;
const Q_DOT = 5;
const MULTILINE_STRING_CONTENT = 6;
const CONSTRUCTOR = 7;
const GET = 8;
const SET = 9;
const DOLLAR = 10;

// The two `(const char[16][16]){...}` compound literals. Order is load-bearing
// for the second: the code branches on the matched index.
const MODIFIERS = [
  'public', 'private', 'protected', 'internal', 'abstract', 'final', 'open',
  'override', 'lateinit', 'vararg', 'noinline', 'crossinline', 'external',
  'suspend', 'inline',
];
const KEYWORDS = [
  'else', 'in', 'instanceof', 'get', 'set', 'constructor', 'by', 'as', 'where',
];
const MOD_BASE = 0;
const KW_BASE = MODIFIERS.length;

// Class table slots.
const C_SPACE = 0;
const C_ALPHA = 1;
const C_ALNUM = 2;
const C_DIGIT = 3;

// Registers; nothing persists.
const R_DID = 0;                          // did_advance
const R_NL = 1;                           // saw_newline
const R_SYM = 2;                          // SEMI or CLASS_MEMBER_SEMI
const R_RES = 3;                          // scan_words' bool
const R_IDX = 4;                          // its *index out-param
const R_SAWP = 5;                         // saw_paren
const R_STAR = 6;                         // after_star
const R_DEPTH = 7;                        // nesting_depth
const R_TMP = 8;
const R_I = 9;
const R_LA = 10;

const CH = (c) => c.codePointAt(0);
const bytes = (s) => Array.from(s, (c) => c.charCodeAt(0));

function build() {
  const ctype = JSON.parse(fs.readFileSync(CTYPE, 'utf8')).classes;
  const a = new Asm();

  // `while (iswspace(lexer->lookahead)) skip(lexer);`, which appears nine times.
  const skipSpace = (label, next) => {
    a.label(label);
    a.ifNClass(C_SPACE, next);
    a.skip();
    a.jmp(label);
  };

  // ======================================================================
  //   if (valid_symbols[MULTILINE_STRING_CONTENT]) { ... }
  // ======================================================================
  //   bool did_advance = false;
  //   result = MULTILINE_STRING_CONTENT;
  //   while (!lexer->eof(lexer)) { switch (lookahead) { ... } }
  //
  // The loop running out at EOF falls through to the SEMI block rather than
  // returning, which is why this is a jump to `semi_check` and not a failure.
  a.label('entry');
  a.ifNValid(MULTILINE_STRING_CONTENT, 'semi_check');
  a.const_(R_DID, 0);
  a.label('mls_loop');
  a.ifEof('semi_check');
  a.ifChar(CH('$'), 'mls_dollar');
  a.ifChar(0x22, 'mls_quote');
  //       default: advance; did_advance = true; break;
  a.advance();
  a.const_(R_DID, 1);
  a.jmp('mls_loop');

  //       case '$':
  //         mark_end; advance;
  //         if (iswalpha(lookahead) || lookahead == '{') return did_advance;
  //         did_advance = true; break;
  a.label('mls_dollar');
  a.markEnd();
  a.advance();
  a.ifClass(C_ALPHA, 'mls_return');
  a.ifChar(CH('{'), 'mls_return');
  a.const_(R_DID, 1);
  a.jmp('mls_loop');

  //       case '"':
  //         mark_end; advance;                    // 3 or 4 quotes means done
  //         if (lookahead == '"') {
  //           advance;
  //           if (lookahead == '"') {
  //             advance;
  //             if (lookahead == '"') advance;
  //             return did_advance;
  //           }
  //         }
  //         did_advance = true; break;
  a.label('mls_quote');
  a.markEnd();
  a.advance();
  a.ifNChar(0x22, 'mls_quote_no');
  a.advance();
  a.ifNChar(0x22, 'mls_quote_no');
  a.advance();
  a.ifNChar(0x22, 'mls_return');
  a.advance();
  a.jmp('mls_return');
  a.label('mls_quote_no');
  a.const_(R_DID, 1);
  a.jmp('mls_loop');
  a.label('mls_return');
  a.emitIf(R_DID, MULTILINE_STRING_CONTENT);

  // ======================================================================
  //   if (valid_symbols[SEMI] || valid_symbols[CLASS_MEMBER_SEMI]) { ... }
  // ======================================================================
  //   result = valid[SEMI] ? SEMI : CLASS_MEMBER_SEMI;
  //   mark_end;
  //   bool saw_newline = false;
  //   for (;;) {
  //     if (eof) return true;
  //     if (lookahead == ';') { advance; mark_end; return true; }
  //     if (!iswspace(lookahead)) break;
  //     if (lookahead == '\n') { skip; saw_newline = true; break; }
  //     if (lookahead == '\r') { skip; if (lookahead == '\n') skip;
  //                              saw_newline = true; break; }
  //     skip;
  //   }
  a.label('semi_check');
  a.ifValid(SEMI, 'semi');
  a.ifValid(CLASS_MEMBER_SEMI, 'semi');
  a.jmp('after_semi');
  a.label('semi');
  a.const_(R_SYM, CLASS_MEMBER_SEMI);
  a.ifNValid(SEMI, 'semi_start');
  a.const_(R_SYM, SEMI);
  a.label('semi_start');
  a.markEnd();
  a.const_(R_NL, 0);
  a.label('semi_loop');
  a.ifEof('semi_true');
  a.ifNChar(CH(';'), 'semi_space');
  a.advance();
  a.markEnd();
  a.jmp('semi_true');
  a.label('semi_space');
  a.ifNClass(C_SPACE, 'semi_break');
  a.ifNChar(0x0a, 'semi_cr');
  a.skip();
  a.const_(R_NL, 1);
  a.jmp('semi_break');
  a.label('semi_cr');
  a.ifNChar(0x0d, 'semi_plain');
  a.skip();
  a.ifNChar(0x0a, 'semi_cr_done');
  a.skip();
  a.label('semi_cr_done');
  a.const_(R_NL, 1);
  a.jmp('semi_break');
  a.label('semi_plain');
  a.skip();
  a.jmp('semi_loop');

  //   while (iswspace(lookahead)) skip;
  //   if (lookahead == '/') goto comment;
  a.label('semi_break');
  skipSpace('semi_break_ws', 'semi_slash');
  a.label('semi_slash');
  a.ifChar(CH('/'), 'comment');
  a.ifCmpI('ne', R_NL, 0, 'switch_entry');

  //   if (!saw_newline) {
  //     switch (lookahead) {
  //       case '!': skip; goto continue_not_is_from_semi;
  //       case '?': if (valid[Q_DOT]) goto q_dot_from_semi; return false;
  //       case 'i': return scan_word(lexer, "import");
  //       case ';': advance; mark_end; return true;
  //       default:  return false;
  //     }
  //   }
  a.ifChar(CH('!'), 'semi_bang');
  a.ifChar(CH('?'), 'semi_qmark');
  a.ifChar(CH('i'), 'semi_import');
  a.ifChar(CH(';'), 'semi_semi');
  a.jmp('fail');
  a.label('semi_bang');
  a.skip();
  a.jmp('not_is_continue');
  a.label('semi_qmark');
  a.ifValid(Q_DOT, 'q_dot');
  a.jmp('fail');
  // scan_word: every character must match, each consumed with skip.
  a.label('semi_import');
  for (const c of 'import') { a.ifNChar(CH(c), 'fail'); a.skip(); }
  a.jmp('semi_true');
  a.label('semi_semi');
  a.advance();
  a.markEnd();
  a.label('semi_true');
  a.emitR(R_SYM);

  //   char scanned_word[16] = {0};
  // _switch:
  //   switch (lookahead) { ... }
  //
  // The declaration is *before* the label, so `goto _switch` from the '@' case
  // does not re-zero the buffer. Hence the clear sits above `switch_body`.
  a.label('switch_entry');
  a.bufClr();
  a.label('switch_body');
  //     case ',' '.' ':' '*' '%' '>' '<' '=' '{' '[' '|' '&' '/': return false;
  for (const c of ',.:*%><={[|&/') a.ifChar(CH(c), 'fail');
  a.ifChar(CH('+'), 'sw_plus');
  a.ifChar(CH('-'), 'sw_minus');
  a.ifChar(CH('!'), 'sw_bang');
  a.ifChar(CH('?'), 'sw_qmark');
  // The fourteen first letters of the two word lists.
  for (const c of 'eigspafolvncbw') a.ifChar(CH(c), 'sw_words');
  a.ifChar(CH(';'), 'sw_semi');
  a.ifChar(CH('@'), 'sw_at');
  a.jmp('semi_true');                     // default: return true

  //     case '+': skip; if (lookahead == '+') return true;
  //               return iswdigit(lookahead);      // and before +/-{float}
  //     case '-': skip; if (lookahead == '-') return true;
  //               return iswdigit(lookahead);
  a.label('sw_plus');
  a.skip();
  a.ifChar(CH('+'), 'semi_true');
  a.ifClass(C_DIGIT, 'semi_true');
  a.jmp('fail');
  a.label('sw_minus');
  a.skip();
  a.ifChar(CH('-'), 'semi_true');
  a.ifClass(C_DIGIT, 'semi_true');
  a.jmp('fail');

  //     case '!':
  //       skip;
  //       if (lookahead == 'i' && valid[NOT_IS]) {
  //         skip;
  //         if (lookahead == 's') { skip; if (!iswalnum(lookahead)) return true; }
  //       }
  //       return lookahead != '=';
  a.label('sw_bang');
  a.skip();
  a.ifNChar(CH('i'), 'sw_bang_eq');
  a.ifNValid(NOT_IS, 'sw_bang_eq');
  a.skip();
  a.ifNChar(CH('s'), 'sw_bang_eq');
  a.skip();
  a.ifClass(C_ALNUM, 'sw_bang_eq');
  a.jmp('semi_true');
  a.label('sw_bang_eq');
  a.ifChar(CH('='), 'fail');
  a.jmp('semi_true');

  //     case '?': if (valid[Q_DOT]) goto q_dot_from_semi; return true;
  a.label('sw_qmark');
  a.ifValid(Q_DOT, 'q_dot');
  a.jmp('semi_true');
  //     case ';': advance; mark_end; return true;
  a.label('sw_semi');
  a.advance();
  a.markEnd();
  a.jmp('semi_true');

  //     case 'e' 'i' 'g' 's' 'p' 'a' 'f' 'o' 'l' 'v' 'n' 'c' 'b' 'w':
  //       while (scan_words(lexer, MODIFIERS, scanned_word, NULL)) {
  //         memset(scanned_word, 0, MAX_WORD_SIZE);
  //         while (iswspace(lookahead)) skip;
  //       }
  //       uint8_t index = -1;
  //       bool res = scan_words(lexer, KEYWORDS, scanned_word, &index);
  a.label('sw_words');
  a.call('words_modifier');
  a.ifCmpI('eq', R_RES, 0, 'sw_keyword');
  a.bufClr();
  skipSpace('sw_modifier_ws', 'sw_words');
  a.label('sw_keyword');
  a.call('words_keyword');
  a.ifCmpI('eq', R_IDX, 5, 'sw_ctor');
  a.ifCmpI('eq', R_IDX, 0, 'sw_else');
  a.ifCmpI('eq', R_IDX, 3, 'sw_get');
  a.ifCmpI('eq', R_IDX, 4, 'sw_set');
  a.ifCmpI('eq', R_IDX, 1, 'sw_in');
  //       return !res;
  a.label('sw_not_res');
  a.ifCmpI('ne', R_RES, 0, 'fail');
  a.jmp('semi_true');

  //       // A secondary constructor, or a variable named `constructor` whose
  //       // field is being accessed.
  //       if (index == 5) {
  //         while (iswspace(lookahead)) skip;
  //         if (valid[CLASS_MEMBER_SEMI] || lookahead == '.' || lookahead == '=')
  //           return true;
  //       }
  a.label('sw_ctor');
  skipSpace('sw_ctor_ws', 'sw_ctor_check');
  a.label('sw_ctor_check');
  a.ifValid(CLASS_MEMBER_SEMI, 'semi_true');
  a.ifChar(CH('.'), 'semi_true');
  a.ifChar(CH('='), 'semi_true');
  a.jmp('sw_not_res');

  //       // No semicolon before an `else` on the next line, unless it is a
  //       // `when` entry, which has a `->` after the `else`.
  //       else if (index == 0) {
  //         while (iswspace(lookahead)) skip;
  //         if (lookahead == '-') { skip; if (lookahead == '>') return true; }
  //       }
  a.label('sw_else');
  skipSpace('sw_else_ws', 'sw_else_check');
  a.label('sw_else_check');
  a.ifNChar(CH('-'), 'sw_not_res');
  a.skip();
  a.ifChar(CH('>'), 'semi_true');
  a.jmp('sw_not_res');

  //       else if (index == 3 && (!valid[GET] || lookahead == '['))  return true;
  a.label('sw_get');
  a.ifNValid(GET, 'semi_true');
  a.ifChar(CH('['), 'semi_true');
  a.jmp('sw_not_res');

  //       else if (index == 4 && (!valid[SET] || lookahead == '[' ||
  //                               lookahead == '(' || lookahead == '.')) {
  //         if (lookahead == '(' && valid[SET]) {
  //           while (lookahead != ')' && !eof) skip;      // to the closing paren
  //           skip;
  //           while (iswspace(lookahead)) {
  //             if (lookahead == '\n') return true;
  //             skip;
  //           }
  //           return false;
  //         }
  //         return true;
  //       }
  a.label('sw_set');
  a.ifNValid(SET, 'sw_set_body');
  a.ifChar(CH('['), 'sw_set_body');
  a.ifChar(CH('('), 'sw_set_body');
  a.ifChar(CH('.'), 'sw_set_body');
  a.jmp('sw_not_res');
  a.label('sw_set_body');
  a.ifNChar(CH('('), 'semi_true');
  a.ifNValid(SET, 'semi_true');
  a.label('sw_set_paren');
  a.ifChar(CH(')'), 'sw_set_close');
  a.ifEof('sw_set_close');
  a.skip();
  a.jmp('sw_set_paren');
  a.label('sw_set_close');
  a.skip();
  a.label('sw_set_ws');
  a.ifNClass(C_SPACE, 'fail');
  a.ifChar(0x0a, 'semi_true');
  a.skip();
  a.jmp('sw_set_ws');

  //       // `in` used in a range test.
  //       else if (index == 1 && valid[IN]) return true;
  a.label('sw_in');
  a.ifValid(IN, 'semi_true');
  a.jmp('sw_not_res');

  //     case '@':
  //       if (valid[CONSTRUCTOR]) {
  //         while (!iswspace(lookahead)) skip;
  //         while (iswspace(lookahead)) skip;
  //         char ctor[12] = "constructor";
  //         for (i = 0; i < 11; i++) { if (lookahead != ctor[i]) return true; skip; }
  //         return false;
  //       }
  //
  // The first loop does not test for EOF; at end of input `iswspace(0)` is
  // false forever. Upstream hangs there and so does this, deliberately -- a
  // guard here would be a divergence, and no corpus file reaches it.
  a.label('sw_at');
  a.ifNValid(CONSTRUCTOR, 'sw_at_accessor');
  a.label('sw_at_nonspace');
  a.ifClass(C_SPACE, 'sw_at_space');
  a.skip();
  a.jmp('sw_at_nonspace');
  skipSpace('sw_at_space', 'sw_at_word');
  a.label('sw_at_word');
  for (const c of 'constructor') { a.ifNChar(CH(c), 'semi_true'); a.skip(); }
  a.jmp('fail');

  //       if (valid[GET] || valid[SET]) {
  //         bool saw_paren = false;
  //         while (saw_paren ? lookahead != '\n' : !iswspace(lookahead)) {
  //           skip;
  //           if (lookahead == '(') saw_paren = true;
  //           if (lookahead == ')') saw_paren = false;
  //         }
  //         while (iswspace(lookahead)) skip;
  //         if (lookahead == '/') return true;
  //         goto _switch;
  //       }
  //       return true;
  a.label('sw_at_accessor');
  a.ifValid(GET, 'sw_at_paren');
  a.ifValid(SET, 'sw_at_paren');
  a.jmp('semi_true');
  a.label('sw_at_paren');
  a.const_(R_SAWP, 0);
  a.label('sw_at_paren_loop');
  a.ifCmpI('ne', R_SAWP, 0, 'sw_at_paren_nl');
  a.ifClass(C_SPACE, 'sw_at_paren_done');
  a.jmp('sw_at_paren_body');
  a.label('sw_at_paren_nl');
  a.ifChar(0x0a, 'sw_at_paren_done');
  a.label('sw_at_paren_body');
  a.skip();
  a.ifNChar(CH('('), 'sw_at_paren_close');
  a.const_(R_SAWP, 1);
  a.label('sw_at_paren_close');
  a.ifNChar(CH(')'), 'sw_at_paren_loop');
  a.const_(R_SAWP, 0);
  a.jmp('sw_at_paren_loop');
  a.label('sw_at_paren_done');
  skipSpace('sw_at_paren_ws', 'sw_at_paren_end');
  a.label('sw_at_paren_end');
  a.ifChar(CH('/'), 'semi_true');
  a.jmp('switch_body');                   // goto _switch

  // ======================================================================
  //   while (iswspace(lookahead)) skip;
  //   if (valid[NOT_IS]) { if (lookahead == '!') { advance;
  // continue_not_is_from_semi:
  //     if (lookahead == 'i') { advance;
  //       if (lookahead == 's') { advance;
  //         result = NOT_IS; mark_end; return !iswalnum(lookahead); } } } }
  // ======================================================================
  a.label('after_semi');
  skipSpace('after_semi_ws', 'not_is');
  a.label('not_is');
  a.ifNValid(NOT_IS, 'in_check');
  a.ifNChar(CH('!'), 'in_check');
  a.advance();
  // Entered directly by the SEMI block's `case '!'`, which has already skipped
  // the '!' and does not re-check valid[NOT_IS].
  a.label('not_is_continue');
  a.ifNChar(CH('i'), 'in_check');
  a.advance();
  a.ifNChar(CH('s'), 'in_check');
  a.advance();
  a.markEnd();
  a.const_(R_TMP, 0);
  a.ifClass(C_ALNUM, 'not_is_emit');
  a.const_(R_TMP, 1);
  a.label('not_is_emit');
  a.emitIf(R_TMP, NOT_IS);

  //   if (valid[IN]) { if (lookahead == 'i') { advance;
  //     if (lookahead == 'n') { advance;
  //       result = IN; mark_end; return !iswalnum(lookahead); } } }
  a.label('in_check');
  a.ifNValid(IN, 'q_dot');
  a.ifNChar(CH('i'), 'q_dot');
  a.advance();
  a.ifNChar(CH('n'), 'q_dot');
  a.advance();
  a.markEnd();
  a.const_(R_TMP, 0);
  a.ifClass(C_ALNUM, 'in_emit');
  a.const_(R_TMP, 1);
  a.label('in_emit');
  a.emitIf(R_TMP, IN);

  // q_dot_from_semi:
  //   if (valid[Q_DOT]) {
  //     while (iswspace(lookahead)) skip;
  //     if (lookahead == '?') {
  //       advance;
  //       while (iswspace(lookahead)) skip;
  //       if (lookahead == '.') { advance; result = Q_DOT; mark_end; return true; }
  //     }
  //   }
  a.label('q_dot');
  a.ifNValid(Q_DOT, 'comment');
  skipSpace('q_dot_ws', 'q_dot_qmark');
  a.label('q_dot_qmark');
  a.ifNChar(CH('?'), 'comment');
  a.advance();
  skipSpace('q_dot_ws2', 'q_dot_dot');
  a.label('q_dot_dot');
  a.ifNChar(CH('.'), 'comment');
  a.advance();
  a.markEnd();
  a.emit(Q_DOT);

  // comment:
  //   if (valid[DOLLAR]) return false;
  //   if (lookahead == '/') {
  //     advance; if (lookahead != '*') return false; advance;
  //     bool after_star = false;
  //     unsigned nesting_depth = 1;
  //     for (;;) { switch (lookahead) { ... } }
  //   }
  //   return false;
  a.label('comment');
  a.ifValid(DOLLAR, 'fail');
  a.ifNChar(CH('/'), 'fail');
  a.advance();
  a.ifNChar(CH('*'), 'fail');
  a.advance();
  a.const_(R_STAR, 0);
  a.const_(R_DEPTH, 1);
  a.label('cm_loop');
  //       case '\0': return false;
  a.ifChar(0, 'fail');
  a.ifChar(CH('*'), 'cm_star');
  a.ifChar(CH('/'), 'cm_slash');
  //       default: advance; after_star = false; break;
  a.advance();
  a.const_(R_STAR, 0);
  a.jmp('cm_loop');
  //       case '*': advance; after_star = true; break;
  a.label('cm_star');
  a.advance();
  a.const_(R_STAR, 1);
  a.jmp('cm_loop');
  //       case '/':
  //         if (after_star) {
  //           advance; after_star = false; nesting_depth--;
  //           if (nesting_depth == 0) { result = BLOCK_COMMENT; mark_end; return true; }
  //         } else {
  //           advance; after_star = false;
  //           if (lookahead == '*') { nesting_depth++; advance; }
  //         }
  a.label('cm_slash');
  a.ifCmpI('eq', R_STAR, 0, 'cm_open');
  a.advance();
  a.const_(R_STAR, 0);
  a.alui('sub', R_DEPTH, 1);
  a.ifCmpI('ne', R_DEPTH, 0, 'cm_loop');
  a.markEnd();
  a.emit(BLOCK_COMMENT);
  a.label('cm_open');
  a.advance();
  a.const_(R_STAR, 0);
  a.ifNChar(CH('*'), 'cm_loop');
  a.alui('add', R_DEPTH, 1);
  a.advance();
  a.jmp('cm_loop');

  a.label('fail');
  a.fail();

  // ---- scan_words' buffer fill -> R_TMP ---------------------------------
  //   if (!scanned_word[0]) {
  //     for (uint8_t i = 0; i < MAX_WORD_SIZE - 1; i++) {
  //       if (!iswalpha(lookahead)) { if (i == 0) return false; break; }
  //       scanned_word[i] = (char)lookahead;
  //       skip;
  //     }
  //   }
  //
  // Fifteen characters at most, so a longer identifier leaves its tail in the
  // input; and an empty buffer with a non-alphabetic lookahead is the only way
  // scan_words fails before comparing.
  a.label('words_fill');
  a.bufLen(R_TMP);
  a.ifCmpI('ne', R_TMP, 0, 'fill_ok');
  a.const_(R_I, 0);
  a.label('fill_loop');
  a.ifCmpI('ge', R_I, 15, 'fill_done');
  a.ifNClass(C_ALPHA, 'fill_done');
  a.lookahead(R_LA);
  a.alui('and', R_LA, 0xff);
  a.bufPush(R_LA);
  a.skip();
  a.alui('add', R_I, 1);
  a.jmp('fill_loop');
  a.label('fill_done');
  a.ifCmpI('ne', R_I, 0, 'fill_ok');
  a.const_(R_TMP, 0);
  a.ret();
  a.label('fill_ok');
  a.const_(R_TMP, 1);
  a.ret();

  // ---- scan_words(MODIFIERS, ..., NULL) -> R_RES ------------------------
  //   for (uint8_t i = 0; i < MAX_WORDS; i++)
  //     if (strncmp(scanned_word, words[i], MAX_WORD_SIZE) == 0) return true;
  //   return false;
  //
  // The tables are 16 entries of 16 zero-padded bytes, so the unused tail
  // entries are all-zero -- they can only match an empty buffer, which
  // `words_fill` has already ruled out.
  a.label('words_modifier');
  a.call('words_fill');
  a.ifCmpI('eq', R_TMP, 0, 'mod_no');
  for (let i = 0; i < MODIFIERS.length; i++) a.ifBufEq(MOD_BASE + i, 'mod_yes');
  a.label('mod_no');
  a.const_(R_RES, 0);
  a.ret();
  a.label('mod_yes');
  a.const_(R_RES, 1);
  a.ret();

  // ---- scan_words(KEYWORDS, ..., &index) -> R_RES, R_IDX ----------------
  // `uint8_t index = -1` is 255, and every branch below tests for a specific
  // small index, so an unmatched call falls through all of them.
  a.label('words_keyword');
  a.const_(R_IDX, 255);
  a.call('words_fill');
  a.ifCmpI('eq', R_TMP, 0, 'kw_no');
  for (let i = 0; i < KEYWORDS.length; i++) a.ifBufEq(KW_BASE + i, `kw_${i}`);
  a.label('kw_no');
  a.const_(R_RES, 0);
  a.ret();
  for (let i = 0; i < KEYWORDS.length; i++) {
    a.label(`kw_${i}`);
    a.const_(R_IDX, i);
    a.const_(R_RES, 1);
    a.ret();
  }

  return {
    entry: 0,
    regPersist: 0,
    stacks: [],
    stackInit: [],
    classes: [ctype.space, ctype.alpha, ctype.alnum, ctype.digit],
    maps: [],
    strings: [...MODIFIERS, ...KEYWORDS].map(bytes),
    validSets: [],
    jumpTable: [],
    code: a.build(),
  };
}

module.exports = { build };
