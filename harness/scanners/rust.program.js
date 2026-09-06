// tree-sitter-rust 0.24.0's scanner, hand-compiled to scanner-VM bytecode.
// Upstream source is reproduced in comments so the two can be diffed by eye;
// that is the only review this port gets.
//
// The cheapest state a scanner can carry: one `uint8_t opening_hash_count`,
// which is one persistent register and nothing else. `docs/scanner-vm.md`
// nominated rust as the first port to convert its serialization argument from
// analysis into measurement; python got there first, but this is the minimal
// case and it is worth having both ends of the range.
//
// rust is also the worked example in `docs/host-ctype-divergence.md`: the float
// rule below is the one place across four constructed candidates where the
// host's `isw*` actually changes the tree -- `1.é` parses as a field access
// under a UTF-8 locale and as a float plus ERROR under `LC_CTYPE=C`. So the
// `iswalpha` on line "the dot is followed by a letter" is not incidental, and
// the classes come from `harness/ctype/wctype.utf8.json` rather than from
// whatever the runtime is sitting on.
'use strict';
const fs = require('fs');
const path = require('path');
const { Asm } = require('../../spike/scanner-vm/asm.js');

const CTYPE = path.join(__dirname, '..', 'ctype', 'wctype.utf8.json');

// Upstream's `enum TokenType`.
const STRING_CONTENT = 0;
const RAW_STRING_LITERAL_START = 1;
const RAW_STRING_LITERAL_CONTENT = 2;
const RAW_STRING_LITERAL_END = 3;
const FLOAT_LITERAL = 4;
const BLOCK_OUTER_DOC_MARKER = 5;
const BLOCK_INNER_DOC_MARKER = 6;
const BLOCK_COMMENT_CONTENT = 7;
const LINE_DOC_CONTENT = 8;
const ERROR_SENTINEL = 9;

// `enum BlockCommentState`.
const ST_SLASH = 0;                       // LeftForwardSlash
const ST_ASTERISK = 1;                    // LeftAsterisk
const ST_CONT = 2;                        // Continuing

// Class table slots.
const C_SPACE = 0;
const C_NUM = 1;                          // is_num_char: '_' || iswdigit
const C_ALPHA = 2;
const C_DIGIT = 3;

// Registers. R_HASH is the only persistent one.
const R_FIRST = 0;                        // `char first`, truncated
const R_STATE = 1;                        // BlockCommentProcessing.state
const R_DEPTH = 2;                        // BlockCommentProcessing.nestingDepth
const R_CNT = 3;
const R_HAS = 4;                          // has_content
const R_FRAC = 5;                         // has_fraction
const R_EXP = 6;                          // has_exponent
const R_HASH = 7;                         // opening_hash_count -- persistent

const CH = (c) => c.codePointAt(0);

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

  // `char first = (char)lexer->lookahead;` -- truncated to a signed char, then
  // compared only against ASCII, so masking to the low byte is equivalent:
  // `(char)x == '*'` and `(x & 0xff) == 42` agree for every target below 0x80.
  const first = () => { a.lookahead(R_FIRST); a.alui('and', R_FIRST, 0xff); };

  // ======================================================================
  // tree_sitter_rust_external_scanner_scan
  // ======================================================================

  //   if (valid_symbols[ERROR_SENTINEL]) return false;
  //
  // The sentinel is upstream's documented way of noticing error recovery, where
  // every token is marked valid. rust declines outright rather than guessing.
  a.label('entry');
  a.ifValid(ERROR_SENTINEL, 'fail');

  //   if (valid[BLOCK_COMMENT_CONTENT] || valid[BLOCK_INNER_DOC_MARKER] ||
  //       valid[BLOCK_OUTER_DOC_MARKER]) return process_block_comment(...);
  a.ifValid(BLOCK_COMMENT_CONTENT, 'block_comment');
  a.ifValid(BLOCK_INNER_DOC_MARKER, 'block_comment');
  a.ifValid(BLOCK_OUTER_DOC_MARKER, 'block_comment');

  //   if (valid[STRING_CONTENT] && !valid[FLOAT_LITERAL]) return process_string(lexer);
  a.ifNValid(STRING_CONTENT, 'line_doc_check');
  a.ifValid(FLOAT_LITERAL, 'line_doc_check');
  a.jmp('string');

  //   if (valid[LINE_DOC_CONTENT]) return process_line_doc_content(lexer);
  a.label('line_doc_check');
  a.ifValid(LINE_DOC_CONTENT, 'line_doc');

  //   while (iswspace(lexer->lookahead)) skip(lexer);
  a.label('ws');
  a.ifNClass(C_SPACE, 'raw_start_check');
  a.skip();
  a.jmp('ws');

  //   if (valid[RAW_STRING_LITERAL_START] &&
  //       (lookahead == 'r' || lookahead == 'b' || lookahead == 'c'))
  //     return scan_raw_string_start(scanner, lexer);
  a.label('raw_start_check');
  a.ifNValid(RAW_STRING_LITERAL_START, 'raw_content_check');
  a.ifChar(CH('r'), 'raw_start');
  a.ifChar(CH('b'), 'raw_start');
  a.ifChar(CH('c'), 'raw_start');

  //   if (valid[RAW_STRING_LITERAL_CONTENT]) return scan_raw_string_content(...);
  a.label('raw_content_check');
  a.ifValid(RAW_STRING_LITERAL_CONTENT, 'raw_content');

  //   if (valid[RAW_STRING_LITERAL_END] && lookahead == '"')
  //     return scan_raw_string_end(scanner, lexer);
  a.ifNValid(RAW_STRING_LITERAL_END, 'float_check');
  a.ifChar(0x22, 'raw_end');

  //   if (valid[FLOAT_LITERAL] && iswdigit(lookahead)) return process_float_literal(lexer);
  //   return false;
  a.label('float_check');
  a.ifNValid(FLOAT_LITERAL, 'fail');
  a.ifClass(C_DIGIT, 'float');
  a.label('fail');
  a.fail();

  // ---- process_string ---------------------------------------------------
  //   bool has_content = false;
  //   for (;;) {
  //     if (lookahead == '"' || lookahead == '\\') break;
  //     if (lexer->eof(lexer)) return false;
  //     has_content = true;
  //     advance;
  //   }
  //   result = STRING_CONTENT; mark_end; return has_content;
  a.label('string');
  a.const_(R_HAS, 0);
  a.label('str_loop');
  a.ifChar(0x22, 'str_done');
  a.ifChar(0x5c, 'str_done');
  a.ifEof('fail');
  a.const_(R_HAS, 1);
  a.advance();
  a.jmp('str_loop');
  a.label('str_done');
  a.markEnd();
  a.emitIf(R_HAS, STRING_CONTENT);

  // ---- process_line_doc_content -----------------------------------------
  //   result = LINE_DOC_CONTENT;
  //   for (;;) {
  //     if (lexer->eof(lexer)) return true;
  //     if (lookahead == '\n') { advance; return true; }   // newline included,
  //     advance;                                           // for md injection
  //   }
  a.label('line_doc');
  a.ifEof('ld_emit');
  a.ifNChar(0x0a, 'ld_advance');
  a.advance();
  a.jmp('ld_emit');
  a.label('ld_advance');
  a.advance();
  a.jmp('line_doc');
  a.label('ld_emit');
  a.emit(LINE_DOC_CONTENT);

  // ---- scan_raw_string_start --------------------------------------------
  //   if (lookahead == 'b' || lookahead == 'c') advance;
  //   if (lookahead != 'r') return false;
  //   advance;
  //   uint8_t opening_hash_count = 0;
  //   while (lookahead == '#') { advance; opening_hash_count++; }
  //   if (lookahead != '"') return false;
  //   advance;
  //   scanner->opening_hash_count = opening_hash_count;
  //   result = RAW_STRING_LITERAL_START; return true;
  //
  // The counter is uint8_t and wraps; masking keeps a 256-hash literal behaving
  // the way upstream does rather than the way arithmetic would like it to.
  a.label('raw_start');
  a.ifChar(CH('b'), 'rs_prefix');
  a.ifChar(CH('c'), 'rs_prefix');
  a.jmp('rs_r');
  a.label('rs_prefix');
  a.advance();
  a.label('rs_r');
  a.ifNChar(CH('r'), 'fail');
  a.advance();
  a.const_(R_CNT, 0);
  a.label('rs_hash');
  a.ifNChar(CH('#'), 'rs_quote');
  a.advance();
  a.alui('add', R_CNT, 1);
  a.alui('and', R_CNT, 0xff);
  a.jmp('rs_hash');
  a.label('rs_quote');
  a.ifNChar(0x22, 'fail');
  a.advance();
  a.mov(R_HASH, R_CNT);
  a.emit(RAW_STRING_LITERAL_START);

  // ---- scan_raw_string_content ------------------------------------------
  //   for (;;) {
  //     if (lexer->eof(lexer)) return false;
  //     if (lookahead == '"') {
  //       mark_end; advance;
  //       unsigned hash_count = 0;
  //       while (lookahead == '#' && hash_count < scanner->opening_hash_count) {
  //         advance; hash_count++;
  //       }
  //       if (hash_count == scanner->opening_hash_count) {
  //         result = RAW_STRING_LITERAL_CONTENT; return true;
  //       }
  //     } else advance;
  //   }
  a.label('raw_content');
  a.ifEof('fail');
  a.ifNChar(0x22, 'rc_advance');
  a.markEnd();
  a.advance();
  a.const_(R_CNT, 0);
  a.label('rc_hash');
  a.ifNChar(CH('#'), 'rc_check');
  a.ifCmp('ge', R_CNT, R_HASH, 'rc_check');
  a.advance();
  a.alui('add', R_CNT, 1);
  a.jmp('rc_hash');
  a.label('rc_check');
  a.ifCmp('eq', R_CNT, R_HASH, 'rc_emit');
  a.jmp('raw_content');
  a.label('rc_advance');
  a.advance();
  a.jmp('raw_content');
  a.label('rc_emit');
  a.emit(RAW_STRING_LITERAL_CONTENT);

  // ---- scan_raw_string_end ----------------------------------------------
  //   advance;
  //   for (unsigned i = 0; i < scanner->opening_hash_count; i++) advance;
  //   result = RAW_STRING_LITERAL_END; return true;
  a.label('raw_end');
  a.advance();
  a.const_(R_CNT, 0);
  a.label('re_loop');
  a.ifCmp('ge', R_CNT, R_HASH, 're_emit');
  a.advance();
  a.alui('add', R_CNT, 1);
  a.jmp('re_loop');
  a.label('re_emit');
  a.emit(RAW_STRING_LITERAL_END);

  // ---- process_float_literal --------------------------------------------
  //   result = FLOAT_LITERAL;
  //   advance;
  //   while (is_num_char(lookahead)) advance;
  //   bool has_fraction = false, has_exponent = false;
  //   if (lookahead == '.') {
  //     has_fraction = true;
  //     advance;
  //     if (iswalpha(lookahead)) return false;   // 1.max(2) is not a float
  //     if (lookahead == '.') return false;
  //     while (is_num_char(lookahead)) advance;
  //   }
  //   mark_end;
  a.label('float');
  a.advance();
  a.label('f_int');
  a.ifNClass(C_NUM, 'f_dot');
  a.advance();
  a.jmp('f_int');
  a.label('f_dot');
  a.const_(R_FRAC, 0);
  a.ifNChar(CH('.'), 'f_mark');
  a.const_(R_FRAC, 1);
  a.advance();
  // The one place in four constructed candidates where the host's isw* changes
  // a tree -- see docs/host-ctype-divergence.md.
  a.ifClass(C_ALPHA, 'fail');
  a.ifChar(CH('.'), 'fail');
  a.label('f_frac');
  a.ifNClass(C_NUM, 'f_mark');
  a.advance();
  a.jmp('f_frac');
  a.label('f_mark');
  a.markEnd();

  //   if (lookahead == 'e' || lookahead == 'E') {
  //     has_exponent = true;
  //     advance;
  //     if (lookahead == '+' || lookahead == '-') advance;
  //     if (!is_num_char(lookahead)) return true;
  //     advance;
  //     while (is_num_char(lookahead)) advance;
  //     mark_end;
  //   }
  a.const_(R_EXP, 0);
  a.ifChar(CH('e'), 'f_exp');
  a.ifChar(CH('E'), 'f_exp');
  a.jmp('f_tail');
  a.label('f_exp');
  a.const_(R_EXP, 1);
  a.advance();
  a.ifChar(CH('+'), 'f_sign');
  a.ifChar(CH('-'), 'f_sign');
  a.jmp('f_exp_digits');
  a.label('f_sign');
  a.advance();
  a.label('f_exp_digits');
  a.ifNClass(C_NUM, 'f_true');
  a.advance();
  a.label('f_exp_rest');
  a.ifNClass(C_NUM, 'f_exp_mark');
  a.advance();
  a.jmp('f_exp_rest');
  a.label('f_exp_mark');
  a.markEnd();

  //   if (!has_exponent && !has_fraction) return false;
  //   if (lookahead != 'u' && lookahead != 'i' && lookahead != 'f') return true;
  //   advance;
  //   if (!iswdigit(lookahead)) return true;
  //   while (iswdigit(lookahead)) advance;
  //   mark_end; return true;
  a.label('f_tail');
  a.ifCmpI('ne', R_EXP, 0, 'f_suffix');
  a.ifCmpI('eq', R_FRAC, 0, 'fail');
  a.label('f_suffix');
  a.ifChar(CH('u'), 'f_suffix_go');
  a.ifChar(CH('i'), 'f_suffix_go');
  a.ifChar(CH('f'), 'f_suffix_go');
  a.jmp('f_true');
  a.label('f_suffix_go');
  a.advance();
  a.ifNClass(C_DIGIT, 'f_true');
  a.label('f_width');
  a.ifNClass(C_DIGIT, 'f_width_mark');
  a.advance();
  a.jmp('f_width');
  a.label('f_width_mark');
  a.markEnd();
  a.label('f_true');
  a.emit(FLOAT_LITERAL);

  // ---- process_block_comment --------------------------------------------
  //   char first = (char)lexer->lookahead;
  //   if (valid[BLOCK_INNER_DOC_MARKER] && first == '!') {
  //     result = BLOCK_INNER_DOC_MARKER; advance; return true;
  //   }
  //   if (valid[BLOCK_OUTER_DOC_MARKER] && first == '*') {
  //     advance; mark_end;
  //     if (lookahead == '/') return false;         // empty block comment
  //     if (lookahead != '*') { result = BLOCK_OUTER_DOC_MARKER; return true; }
  //   } else {
  //     advance;
  //   }
  //
  // Note the fall-through: when the outer-marker arm is taken and the next
  // character *is* '*', control reaches the content block having advanced once,
  // and the `else`'s advance does not also run.
  a.label('block_comment');
  first();
  a.ifNValid(BLOCK_INNER_DOC_MARKER, 'bc_outer');
  a.ifCmpI('ne', R_FIRST, CH('!'), 'bc_outer');
  a.advance();
  a.emit(BLOCK_INNER_DOC_MARKER);
  a.label('bc_outer');
  a.ifNValid(BLOCK_OUTER_DOC_MARKER, 'bc_else');
  a.ifCmpI('ne', R_FIRST, CH('*'), 'bc_else');
  a.advance();
  a.markEnd();
  a.ifChar(CH('/'), 'fail');
  a.ifChar(CH('*'), 'bc_content');
  a.emit(BLOCK_OUTER_DOC_MARKER);
  a.label('bc_else');
  a.advance();

  //   if (valid[BLOCK_COMMENT_CONTENT]) {
  //     BlockCommentProcessing processing = {Continuing, 1};
  //     switch (first) {
  //       case '*': processing.state = LeftAsterisk;
  //                 if (lookahead == '/') return false;   // /*!*/ has no content
  //                 break;
  //       case '/': processing.state = LeftForwardSlash; break;
  //       default:  processing.state = Continuing; break;
  //     }
  a.label('bc_content');
  a.ifNValid(BLOCK_COMMENT_CONTENT, 'fail');
  a.const_(R_DEPTH, 1);
  a.ifCmpI('eq', R_FIRST, CH('*'), 'bc_first_star');
  a.ifCmpI('eq', R_FIRST, CH('/'), 'bc_first_slash');
  a.const_(R_STATE, ST_CONT);
  a.jmp('bc_loop');
  a.label('bc_first_star');
  a.const_(R_STATE, ST_ASTERISK);
  a.ifChar(CH('/'), 'fail');
  a.jmp('bc_loop');
  a.label('bc_first_slash');
  a.const_(R_STATE, ST_SLASH);

  //     while (!lexer->eof(lexer) && processing.nestingDepth != 0) {
  //       first = (char)lexer->lookahead;
  //       switch (processing.state) { ... }
  //       advance;
  //       if (first == '/' && processing.nestingDepth != 0) mark_end;
  //     }
  //     result = BLOCK_COMMENT_CONTENT; return true;
  //   }
  //   return false;
  //
  // An unterminated block comment returns *true* on purpose: upstream says this
  // is wrong for parsing and right for highlighting, since otherwise nothing
  // above an unclosed `/*` can be highlighted at all.
  a.label('bc_loop');
  a.ifEof('bc_emit');
  a.ifCmpI('eq', R_DEPTH, 0, 'bc_emit');
  first();
  a.ifCmpI('eq', R_STATE, ST_SLASH, 'bc_st_slash');
  a.ifCmpI('eq', R_STATE, ST_ASTERISK, 'bc_st_star');

  //       case Continuing:
  //         lexer->mark_end(lexer);
  //         switch (current) {
  //           case '/': state = LeftForwardSlash; break;
  //           case '*': state = LeftAsterisk; break;
  //         }
  a.markEnd();
  a.ifCmpI('eq', R_FIRST, CH('/'), 'bc_cont_slash');
  a.ifCmpI('eq', R_FIRST, CH('*'), 'bc_cont_star');
  a.jmp('bc_advance');
  a.label('bc_cont_slash');
  a.const_(R_STATE, ST_SLASH);
  a.jmp('bc_advance');
  a.label('bc_cont_star');
  a.const_(R_STATE, ST_ASTERISK);
  a.jmp('bc_advance');

  //       case LeftForwardSlash:
  //         if (current == '*') nestingDepth += 1;
  //         state = Continuing;
  a.label('bc_st_slash');
  a.ifCmpI('ne', R_FIRST, CH('*'), 'bc_st_slash_done');
  a.alui('add', R_DEPTH, 1);
  a.label('bc_st_slash_done');
  a.const_(R_STATE, ST_CONT);
  a.jmp('bc_advance');

  //       case LeftAsterisk:
  //         if (current == '*') { mark_end; state = LeftAsterisk; return; }
  //         if (current == '/') nestingDepth -= 1;
  //         state = Continuing;
  //
  // nestingDepth is `unsigned` upstream and this is its only decrement; the
  // loop has already exited at zero, so it cannot wrap.
  a.label('bc_st_star');
  a.ifCmpI('ne', R_FIRST, CH('*'), 'bc_st_star_slash');
  a.markEnd();
  a.const_(R_STATE, ST_ASTERISK);
  a.jmp('bc_advance');
  a.label('bc_st_star_slash');
  a.ifCmpI('ne', R_FIRST, CH('/'), 'bc_st_star_done');
  a.alui('sub', R_DEPTH, 1);
  a.label('bc_st_star_done');
  a.const_(R_STATE, ST_CONT);

  a.label('bc_advance');
  a.advance();
  a.ifCmpI('ne', R_FIRST, CH('/'), 'bc_loop');
  a.ifCmpI('eq', R_DEPTH, 0, 'bc_loop');
  a.markEnd();
  a.jmp('bc_loop');

  a.label('bc_emit');
  a.emit(BLOCK_COMMENT_CONTENT);

  return {
    entry: 0,
    regPersist: 1 << R_HASH,
    stacks: [],
    stackInit: [],
    classes: [
      ctype.space,
      union(ctype.digit, one('_')),       // is_num_char
      ctype.alpha,
      ctype.digit,
    ],
    maps: [],
    strings: [],
    validSets: [],
    jumpTable: [],
    code: a.build(),
  };
}

module.exports = { build };
