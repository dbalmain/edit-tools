// tree-sitter-ruby 0.23.1's scanner, hand-compiled to scanner-VM bytecode.
// Upstream source is reproduced in comments so the two can be diffed by eye;
// that is the only review this port gets.
//
// The interesting problem is state, not control flow. Upstream carries two
// arrays plus a bool:
//
//   literal_stack: Literal { type, open_delimiter, close_delimiter,
//                    nesting_depth, allows_interpolation }
//   open_heredocs: Heredoc { word, end_word_indentation_allowed,
//                    allows_interpolation, started }
//   has_leading_whitespace -- in the Scanner struct, but reset at the start
//                    of every scan and omitted from serialize. Intra-scan
//                    only; a transient register, not a persistent one.
//
// That is more fields than the VM has stacks. The encoding, which is the
// brief's suggestion and which fits:
//
//   stack 0  packed Literal, one int32 per entry:
//              bits 0-5    type
//              bit  6      allows_interpolation
//              bits 8-15   open_delimiter  (unsigned char; every delimiter
//                          scan_open_delimiter accepts is ASCII)
//              bits 16-23  close_delimiter
//              bits 24-31  nesting_depth   (unsigned char, matching serialize)
//   stack 1  packed Heredoc header, one int32 per entry, in array order so
//            index 0 is the one content/whitespace always look at (FIFO, not
//            a stack -- array_erase(&open_heredocs, 0)):
//              bits 0-15   word.size
//              bit  16     end_word_indentation_allowed
//              bit  17     allows_interpolation
//              bit  18     started
//   stack 2  those words' bytes, concatenated flat, each stored as a
//            sign-extended `char` so `lookahead == word[i]` matches signed
//            char promotion on the glibc host that froze the corpus
//   stack 3  transient scratch, used to rebuild stacks 1 and 2 when erasing
//            or mutating index 0 (the ISA has GETIDX and SETTOP, not SETIDX)
//
// Two deliberate divergences, both bounds rather than bugs:
//
//   1. Upstream serialize returns 0 (empty state) if the literals would
//      overflow the 1024-byte buffer, or if a heredoc would. The VM drops
//      from the top of its deepest stack instead. Deepest recorded ruby
//      state is well under 1024; the bijection cannot see the difference
//      on this corpus.
//   2. Word bytes live on a stack capped at 256; upstream's String is
//      unbounded. Same bound html and xml already carry for tag names.
//
// `has_leading_whitespace` is the brief's "persistent scalar" that is not:
// deserialize forces it false, and scan() does too before anything reads it.
'use strict';
const fs = require('fs');
const path = require('path');
const { Asm } = require('../../spike/scanner-vm/asm.js');

const CTYPE = path.join(__dirname, '..', 'ctype', 'wctype.utf8.json');

// Upstream's `enum TokenType`. NONE is a scanner-internal sentinel, not an
// external token -- the parser's valid_symbols vector is 30 bits long.
const LINE_BREAK = 0;
const NO_LINE_BREAK = 1;
const SIMPLE_SYMBOL = 2;
const STRING_START = 3;
const SYMBOL_START = 4;
const SUBSHELL_START = 5;
const REGEX_START = 6;
const STRING_ARRAY_START = 7;
const SYMBOL_ARRAY_START = 8;
const HEREDOC_BODY_START = 9;
const STRING_CONTENT = 10;
const HEREDOC_CONTENT = 11;
const STRING_END = 12;
const HEREDOC_BODY_END = 13;
const HEREDOC_START = 14;
const FORWARD_SLASH = 15;
const BLOCK_AMPERSAND = 16;
const SPLAT_STAR = 17;
const UNARY_MINUS = 18;
const UNARY_MINUS_NUM = 19;
const BINARY_MINUS = 20;
const BINARY_STAR = 21;
const SINGLETON_CLASS_LEFT_ANGLE_LEFT_ANGLE = 22;
const HASH_KEY_SYMBOL = 23;
const IDENTIFIER_SUFFIX = 24;
const CONSTANT_SUFFIX = 25;
const HASH_SPLAT_STAR_STAR = 26;
const BINARY_STAR_STAR = 27;
const ELEMENT_REFERENCE_BRACKET = 28;
const SHORT_INTERPOLATION = 29;

// Literal packing.
const LIT_TYPE_MASK = 0x3f;
const LIT_INTERP_BIT = 6;
const LIT_OPEN_SHIFT = 8;
const LIT_CLOSE_SHIFT = 16;
const LIT_NEST_SHIFT = 24;

// Heredoc-header packing.
const HD_LEN_MASK = 0xffff;
const HD_INDENT_BIT = 16;
const HD_INTERP_BIT = 17;
const HD_STARTED_BIT = 18;

// Class table slots.
const C_SPACE = 0;
const C_ALNUM = 1;
const C_ALPHA = 2;
const C_DIGIT = 3;
const C_LOWER = 4;
const C_UPPER = 5;
const C_ALNUM_US = 6;                     // iswalnum || '_'
const C_ALPHA_US = 7;                     // iswalpha || '_'

// Stacks.
const S_LITS = 0;                         // persistent: packed Literal
const S_HDOC = 1;                         // persistent: packed Heredoc headers
const S_WORD = 2;                         // persistent: heredoc word bytes, flat
const S_TMP = 3;                          // transient: rebuild scratch

// Registers. None persistent -- all scanner state is in the three stacks.
const R_HLW = 0;                          // has_leading_whitespace
const R_SYM = 1;                          // content_symbol for short interpolation
const R_OK = 2;                           // subroutine bool
const R_LIT = 3;                          // packed literal
const R_TYPE = 4;
const R_OPEN = 5;
const R_CLOSE = 6;
const R_NEST = 7;
const R_INTERP = 8;
const R_HDR = 9;                          // packed heredoc header
const R_WLEN = 10;
const R_POS = 11;                         // position_in_word
const R_HAS = 12;                         // has_content
const R_LA = 13;
const R_TMP = 14;
const R_N = 15;
const R_I = 16;
const R_CNT = 17;
const R_QUOTE = 18;
const R_START = 19;                       // short-interpolation start char
const R_CROSSED = 20;                     // crossed_newline
const R_HBS = 21;                         // heredoc_body_start_is_valid
const R_LOOKEND = 22;                     // look_for_heredoc_end
const R_STOP = 23;                        // stop_on_space
const R_ZERO = 24;                        // constant 0, for getidx of index 0
const R_ISI = 25;                         // is_short_interpolation
const R_VID = 26;                         // validIdentifierSymbol
const R_INDENT = 27;                      // end_word_indentation_allowed
const R_STARTED = 28;

// `NON_IDENTIFIER_CHARS`, 36 entries. is_iden_char is memchr over this after
// truncating lookahead to char -- not a class, because U+0100 must fail
// (low byte 0 is in the set) while U+0101 must pass.
const NON_IDEN = [
  0, 0x0a, 0x0d, 0x09, 0x20, 0x3a, 0x3b, 0x60, 0x22, 0x27, 0x40, 0x24, 0x23,
  0x2e, 0x2c, 0x7c, 0x5e, 0x26, 0x3c, 0x3d, 0x3e, 0x2b, 0x2d, 0x2a, 0x2f,
  0x5c, 0x25, 0x3f, 0x21, 0x7e, 0x28, 0x29, 0x5b, 0x5d, 0x7b, 0x7d,
];

// strchr("!@&`'+~=/\\,;.<>*$?:\"", lookahead) -- and, because strchr of NUL
// hits the C-string terminator, low-byte 0 is a hit too.
const DOLLAR_SPECIAL = [
  0, 0x21, 0x40, 0x26, 0x60, 0x27, 0x2b, 0x7e, 0x3d, 0x2f, 0x5c, 0x2c, 0x3b,
  0x2e, 0x3c, 0x3e, 0x2a, 0x24, 0x3f, 0x3a, 0x22,
];

const PCT_UNBALANCED = [
  '|', '!', '#', '/', '\\', '@', '$', '%', '^', '&', '*', ')', ']', '}', '>',
  '+', '-', '~', '`', ',', '.', '?', ':', ';', '_', '"', '\'',
];

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
  if (NON_IDEN.length !== 36) {
    throw new Error(`NON_IDENTIFIER_CHARS is ${NON_IDEN.length}, upstream has 36`);
  }
  const ctype = JSON.parse(fs.readFileSync(CTYPE, 'utf8')).classes;
  const a = new Asm();

  const skip_ = () => { a.const_(R_HLW, 1); a.skip(); };

  const packLit = () => {
    a.mov(R_LIT, R_TYPE);
    a.mov(R_TMP, R_INTERP);
    a.alui('and', R_TMP, 1);
    a.alui('shl', R_TMP, LIT_INTERP_BIT);
    a.alu('or', R_LIT, R_TMP);
    a.mov(R_TMP, R_OPEN);
    a.alui('and', R_TMP, 0xff);
    a.alui('shl', R_TMP, LIT_OPEN_SHIFT);
    a.alu('or', R_LIT, R_TMP);
    a.mov(R_TMP, R_CLOSE);
    a.alui('and', R_TMP, 0xff);
    a.alui('shl', R_TMP, LIT_CLOSE_SHIFT);
    a.alu('or', R_LIT, R_TMP);
    a.mov(R_TMP, R_NEST);
    a.alui('and', R_TMP, 0xff);
    a.alui('shl', R_TMP, LIT_NEST_SHIFT);
    a.alu('or', R_LIT, R_TMP);
  };

  const unpackLit = () => {
    a.mov(R_TYPE, R_LIT);
    a.alui('and', R_TYPE, LIT_TYPE_MASK);
    a.mov(R_INTERP, R_LIT);
    a.alui('sar', R_INTERP, LIT_INTERP_BIT);
    a.alui('and', R_INTERP, 1);
    a.mov(R_OPEN, R_LIT);
    a.alui('sar', R_OPEN, LIT_OPEN_SHIFT);
    a.alui('and', R_OPEN, 0xff);
    a.mov(R_CLOSE, R_LIT);
    a.alui('sar', R_CLOSE, LIT_CLOSE_SHIFT);
    a.alui('and', R_CLOSE, 0xff);
    a.mov(R_NEST, R_LIT);
    a.alui('sar', R_NEST, LIT_NEST_SHIFT);
    a.alui('and', R_NEST, 0xff);
  };

  const packHdoc = () => {
    a.mov(R_HDR, R_WLEN);
    a.alui('and', R_HDR, HD_LEN_MASK);
    a.mov(R_TMP, R_INDENT);
    a.alui('and', R_TMP, 1);
    a.alui('shl', R_TMP, HD_INDENT_BIT);
    a.alu('or', R_HDR, R_TMP);
    a.mov(R_TMP, R_INTERP);
    a.alui('and', R_TMP, 1);
    a.alui('shl', R_TMP, HD_INTERP_BIT);
    a.alu('or', R_HDR, R_TMP);
    a.mov(R_TMP, R_STARTED);
    a.alui('and', R_TMP, 1);
    a.alui('shl', R_TMP, HD_STARTED_BIT);
    a.alu('or', R_HDR, R_TMP);
  };

  const unpackHdoc = () => {
    a.mov(R_WLEN, R_HDR);
    a.alui('and', R_WLEN, HD_LEN_MASK);
    a.mov(R_INDENT, R_HDR);
    a.alui('sar', R_INDENT, HD_INDENT_BIT);
    a.alui('and', R_INDENT, 1);
    a.mov(R_INTERP, R_HDR);
    a.alui('sar', R_INTERP, HD_INTERP_BIT);
    a.alui('and', R_INTERP, 1);
    a.mov(R_STARTED, R_HDR);
    a.alui('sar', R_STARTED, HD_STARTED_BIT);
    a.alui('and', R_STARTED, 1);
  };

  const pushWordByte = () => {
    a.lookahead(R_LA);
    a.alui('shl', R_LA, 24);
    a.alui('sar', R_LA, 24);
    a.push(S_WORD, R_LA);
  };

  // ======================================================================
  // scan
  // ======================================================================

  //   scanner->has_leading_whitespace = false;
  a.label('entry');
  a.const_(R_HLW, 0);
  a.const_(R_ZERO, 0);

  //   if (!valid_symbols[STRING_START]) {
  //     if ((valid_symbols[STRING_CONTENT] || valid_symbols[STRING_END]) &&
  //         scanner->literal_stack.size > 0) {
  //       return scan_literal_content(scanner, lexer);
  //     }
  //     if ((valid_symbols[HEREDOC_CONTENT] || valid_symbols[HEREDOC_BODY_END]) &&
  //         scanner->open_heredocs.size > 0) {
  //       return scan_heredoc_content(scanner, lexer);
  //     }
  //   }
  a.ifValid(STRING_START, 'ws_call');
  a.ifValid(STRING_CONTENT, 'lit_check');
  a.ifValid(STRING_END, 'lit_check');
  a.jmp('hc_check');
  a.label('lit_check');
  a.len(S_LITS, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'hc_check');
  a.jmp('lit_content');
  a.label('hc_check');
  a.ifValid(HEREDOC_CONTENT, 'hc_size');
  a.ifValid(HEREDOC_BODY_END, 'hc_size');
  a.jmp('ws_call');
  a.label('hc_size');
  a.len(S_HDOC, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'ws_call');
  a.jmp('heredoc_content');

  //   lexer->result_symbol = NONE;
  //   if (!scan_whitespace(scanner, lexer, valid_symbols)) return false;
  //   if (lexer->result_symbol != NONE) return true;
  a.label('ws_call');
  a.call('whitespace');

  //   switch (lexer->lookahead) {
  a.ifChar(CH('&'), 'amp');
  a.ifChar(CH('<'), 'lt');
  a.ifChar(CH('*'), 'star');
  a.ifChar(CH('-'), 'minus');
  a.ifChar(CH(':'), 'colon');
  a.ifChar(CH('['), 'bracket');

  a.jmp('iden_gate');

  //     case '&':
  //       if (valid_symbols[BLOCK_AMPERSAND]) {
  //         advance(lexer);
  //         if (lexer->lookahead != '&' && lexer->lookahead != '.' &&
  //             lexer->lookahead != '=' && !iswspace(lexer->lookahead)) {
  //           lexer->result_symbol = BLOCK_AMPERSAND;
  //           return true;
  //         }
  //         return false;
  //       }
  //       break;
  a.label('amp');
  a.ifNValid(BLOCK_AMPERSAND, 'iden_gate');
  a.advance();
  a.ifChar(CH('&'), 'fail');
  a.ifChar(CH('.'), 'fail');
  a.ifChar(CH('='), 'fail');
  a.ifClass(C_SPACE, 'fail');
  a.emit(BLOCK_AMPERSAND);

  //     case '<':
  //       if (valid_symbols[SINGLETON_CLASS_LEFT_ANGLE_LEFT_ANGLE]) {
  //         advance(lexer);
  //         if (lexer->lookahead == '<') {
  //           advance(lexer);
  //           lexer->result_symbol = SINGLETON_CLASS_LEFT_ANGLE_LEFT_ANGLE;
  //           return true;
  //         }
  //         return false;
  //       }
  //       break;
  a.label('lt');
  a.ifNValid(SINGLETON_CLASS_LEFT_ANGLE_LEFT_ANGLE, 'iden_gate');
  a.advance();
  a.ifNChar(CH('<'), 'fail');
  a.advance();
  a.emit(SINGLETON_CLASS_LEFT_ANGLE_LEFT_ANGLE);

  //     case '*':
  //       if (valid[SPLAT_STAR] || valid[BINARY_STAR] ||
  //           valid[HASH_SPLAT_STAR_STAR] || valid[BINARY_STAR_STAR]) {
  //         advance;
  //         if (lookahead == '=') return false;
  //         if (lookahead == '*') {
  //           if (valid[HASH_SPLAT_STAR_STAR] || valid[BINARY_STAR_STAR]) {
  //             advance;
  //             if (lookahead == '=') return false;
  //             if (valid[BINARY_STAR_STAR] && !has_leading_whitespace)
  //               { result = BINARY_STAR_STAR; return true; }
  //             if (valid[HASH_SPLAT_STAR_STAR] && !iswspace)
  //               { result = HASH_SPLAT_STAR_STAR; return true; }
  //             if (valid[BINARY_STAR_STAR]) { result = BINARY_STAR_STAR; return true; }
  //             if (valid[HASH_SPLAT_STAR_STAR]) { result = HASH_SPLAT_STAR_STAR; return true; }
  //             return false;
  //           }
  //           return false;
  //         }
  //         if (valid[BINARY_STAR] && !has_leading_whitespace)
  //           { result = BINARY_STAR; return true; }
  //         if (valid[SPLAT_STAR] && !iswspace)
  //           { result = SPLAT_STAR; return true; }
  //         if (valid[BINARY_STAR]) { result = BINARY_STAR; return true; }
  //         if (valid[SPLAT_STAR]) { result = SPLAT_STAR; return true; }
  //         return false;
  //       }
  //       break;
  a.label('star');
  a.ifValid(SPLAT_STAR, 'star_go');
  a.ifValid(BINARY_STAR, 'star_go');
  a.ifValid(HASH_SPLAT_STAR_STAR, 'star_go');
  a.ifValid(BINARY_STAR_STAR, 'star_go');
  a.jmp('iden_gate');
  a.label('star_go');
  a.advance();
  a.ifChar(CH('='), 'fail');
  a.ifNChar(CH('*'), 'star_one');
  //         if (lookahead == '*') {
  //           if (valid[HASH_SPLAT_STAR_STAR] || valid[BINARY_STAR_STAR]) {
  a.ifValid(HASH_SPLAT_STAR_STAR, 'star_two');
  a.ifValid(BINARY_STAR_STAR, 'star_two');
  a.jmp('fail');
  a.label('star_two');
  a.advance();
  a.ifChar(CH('='), 'fail');
  a.ifNValid(BINARY_STAR_STAR, 'star_hash');
  a.ifCmpI('eq', R_HLW, 0, 'star_bss');
  a.label('star_hash');
  a.ifNValid(HASH_SPLAT_STAR_STAR, 'star_bss2');
  a.ifNClass(C_SPACE, 'star_hss');
  a.label('star_bss2');
  a.ifValid(BINARY_STAR_STAR, 'star_bss');
  a.ifValid(HASH_SPLAT_STAR_STAR, 'star_hss');
  a.jmp('fail');
  a.label('star_bss');
  a.emit(BINARY_STAR_STAR);
  a.label('star_hss');
  a.emit(HASH_SPLAT_STAR_STAR);
  a.label('star_one');
  a.ifNValid(BINARY_STAR, 'star_splat');
  a.ifCmpI('eq', R_HLW, 0, 'star_bs');
  a.label('star_splat');
  a.ifNValid(SPLAT_STAR, 'star_bs2');
  a.ifNClass(C_SPACE, 'star_ss');
  a.label('star_bs2');
  a.ifValid(BINARY_STAR, 'star_bs');
  a.ifValid(SPLAT_STAR, 'star_ss');
  a.jmp('fail');
  a.label('star_bs');
  a.emit(BINARY_STAR);
  a.label('star_ss');
  a.emit(SPLAT_STAR);

  //     case '-':
  //       if (valid[UNARY_MINUS] || valid[UNARY_MINUS_NUM] || valid[BINARY_MINUS]) {
  //         advance;
  //         if (lookahead != '=' && lookahead != '>') {
  //           if (valid[UNARY_MINUS_NUM] &&
  //               (!valid[BINARY_STAR] || has_leading_whitespace) &&
  //               iswdigit(lookahead))
  //             { result = UNARY_MINUS_NUM; return true; }
  //           if (valid[UNARY_MINUS] && has_leading_whitespace && !iswspace)
  //             result = UNARY_MINUS;
  //           else if (valid[BINARY_MINUS]) result = BINARY_MINUS;
  //           else result = UNARY_MINUS;
  //           return true;
  //         }
  //         return false;
  //       }
  //       break;
  a.label('minus');
  a.ifValid(UNARY_MINUS, 'minus_go');
  a.ifValid(UNARY_MINUS_NUM, 'minus_go');
  a.ifValid(BINARY_MINUS, 'minus_go');
  a.jmp('iden_gate');
  a.label('minus_go');
  a.advance();
  a.ifChar(CH('='), 'fail');
  a.ifChar(CH('>'), 'fail');
  a.ifNValid(UNARY_MINUS_NUM, 'minus_unary');
  a.ifNValid(BINARY_STAR, 'minus_num_digit');
  a.ifCmpI('eq', R_HLW, 0, 'minus_unary');
  a.label('minus_num_digit');
  a.ifClass(C_DIGIT, 'minus_num');
  a.label('minus_unary');
  a.ifNValid(UNARY_MINUS, 'minus_bin');
  a.ifCmpI('eq', R_HLW, 0, 'minus_bin');
  a.ifNClass(C_SPACE, 'minus_um');
  a.label('minus_bin');
  a.ifValid(BINARY_MINUS, 'minus_bm');
  a.emit(UNARY_MINUS);
  a.label('minus_um');
  a.emit(UNARY_MINUS);
  a.label('minus_bm');
  a.emit(BINARY_MINUS);
  a.label('minus_num');
  a.emit(UNARY_MINUS_NUM);

  //     case ':':
  //       if (valid[SYMBOL_START]) {
  //         Literal literal = {0}; literal.type = SYMBOL_START; literal.nesting_depth = 1;
  //         advance;
  //         switch (lookahead) {
  //           case '"': advance; open = close = '"'; interp = true; push; result = SYMBOL_START; return true;
  //           case '\'': advance; open = close = '\''; interp = false; push; result = SYMBOL_START; return true;
  //           default: if (scan_symbol_identifier(lexer)) { result = SIMPLE_SYMBOL; return true; }
  //         }
  //         return false;
  //       }
  //       break;
  a.label('colon');
  a.ifNValid(SYMBOL_START, 'iden_gate');
  a.const_(R_TYPE, SYMBOL_START);
  a.const_(R_NEST, 1);
  a.advance();
  a.ifChar(CH('"'), 'colon_dq');
  a.ifChar(CH('\''), 'colon_sq');
  a.call('symbol_id');
  a.ifCmpI('eq', R_OK, 0, 'fail');
  a.emit(SIMPLE_SYMBOL);
  a.label('colon_dq');
  a.advance();
  a.const_(R_OPEN, CH('"'));
  a.const_(R_CLOSE, CH('"'));
  a.const_(R_INTERP, 1);
  packLit();
  a.push(S_LITS, R_LIT);
  a.emit(SYMBOL_START);
  a.label('colon_sq');
  a.advance();
  a.const_(R_OPEN, CH('\''));
  a.const_(R_CLOSE, CH('\''));
  a.const_(R_INTERP, 0);
  packLit();
  a.push(S_LITS, R_LIT);
  a.emit(SYMBOL_START);

  //     case '[':
  //       if (valid[ELEMENT_REFERENCE_BRACKET] &&
  //           (!has_leading_whitespace || !valid[STRING_START])) {
  //         advance; result = ELEMENT_REFERENCE_BRACKET; return true;
  //       }
  //       break;
  a.label('bracket');
  a.ifNValid(ELEMENT_REFERENCE_BRACKET, 'iden_gate');
  a.ifCmpI('eq', R_HLW, 0, 'bracket_go');
  a.ifValid(STRING_START, 'iden_gate');
  a.label('bracket_go');
  a.advance();
  a.emit(ELEMENT_REFERENCE_BRACKET);

  //   if (((valid[HASH_KEY_SYMBOL] || valid[IDENTIFIER_SUFFIX]) &&
  //        (iswalpha(lexer->lookahead) || lexer->lookahead == '_')) ||
  //       (valid[CONSTANT_SUFFIX] && iswupper(lexer->lookahead))) {
  a.label('iden_gate');
  a.ifValid(HASH_KEY_SYMBOL, 'iden_al');
  a.ifValid(IDENTIFIER_SUFFIX, 'iden_al');
  a.jmp('iden_cu');
  a.label('iden_al');
  a.ifClass(C_ALPHA, 'iden_enter');
  a.ifChar(CH('_'), 'iden_enter');
  a.label('iden_cu');
  a.ifNValid(CONSTANT_SUFFIX, 'str_start');
  a.ifNClass(C_UPPER, 'str_start');
  a.label('iden_enter');
  a.const_(R_VID, IDENTIFIER_SUFFIX);
  a.ifNClass(C_UPPER, 'iden_loop');
  a.const_(R_VID, CONSTANT_SUFFIX);
  a.label('iden_loop');
  a.ifNClass(C_ALNUM_US, 'iden_after');
  a.advance();
  a.jmp('iden_loop');
  a.label('iden_after');
  a.ifNValid(HASH_KEY_SYMBOL, 'iden_bang');
  a.ifNChar(CH(':'), 'iden_bang');
  a.markEnd();
  a.advance();
  a.ifChar(CH(':'), 'fail');
  a.emit(HASH_KEY_SYMBOL);
  a.label('iden_bang');
  a.ifNValidR(R_VID, 'fail');
  a.ifNChar(CH('!'), 'fail');
  a.advance();
  a.ifChar(CH('='), 'fail');
  a.emitR(R_VID);

  //   if (valid_symbols[STRING_START]) {
  //     Literal literal = {0}; literal.nesting_depth = 1;
  //     if (lexer->lookahead == '<') {
  //       advance; if (lookahead != '<') return false; advance;
  //       Heredoc heredoc = {0};
  //       if (lookahead == '-' || lookahead == '~') {
  //         advance; heredoc.end_word_indentation_allowed = true;
  //       }
  //       scan_heredoc_word(lexer, &heredoc);
  //       if (heredoc.word.size == 0) return false;
  //       array_push(&open_heredocs, heredoc);
  //       result = HEREDOC_START; return true;
  //     }
  //     if (scan_open_delimiter(...)) {
  //       array_push(&literal_stack, literal);
  //       result = literal.type; return true;
  //     }
  //     return false;
  //   }
  a.label('str_start');
  a.ifNValid(STRING_START, 'fail');
  a.const_(R_TYPE, 0);
  a.const_(R_OPEN, 0);
  a.const_(R_CLOSE, 0);
  a.const_(R_NEST, 1);
  a.const_(R_INTERP, 0);
  a.ifNChar(CH('<'), 'str_delim');
  a.advance();
  a.ifNChar(CH('<'), 'fail');
  a.advance();
  a.const_(R_INDENT, 0);
  a.const_(R_STARTED, 0);
  a.ifChar(CH('-'), 'hd_indent');
  a.ifChar(CH('~'), 'hd_indent');
  a.jmp('hd_word');
  a.label('hd_indent');
  a.advance();
  a.const_(R_INDENT, 1);
  a.label('hd_word');
  a.call('heredoc_word');
  a.ifCmpI('eq', R_WLEN, 0, 'fail');
  packHdoc();
  a.push(S_HDOC, R_HDR);
  a.emit(HEREDOC_START);
  a.label('str_delim');
  a.call('open_delim');
  a.ifCmpI('eq', R_OK, 0, 'fail');
  packLit();
  a.push(S_LITS, R_LIT);
  a.emitR(R_TYPE);

  a.label('fail');
  a.fail();

  // ======================================================================
  // scan_whitespace
  // ======================================================================
  a.label('whitespace');
  //   bool heredoc_body_start_is_valid =
  //       scanner->open_heredocs.size > 0 &&
  //       !scanner->open_heredocs.contents[0].started &&
  //       valid_symbols[HEREDOC_BODY_START];
  a.const_(R_HBS, 0);
  a.const_(R_CROSSED, 0);
  a.len(S_HDOC, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'ws_loop');
  a.getidx(S_HDOC, R_HDR, R_ZERO);
  unpackHdoc();
  a.ifCmpI('ne', R_STARTED, 0, 'ws_loop');
  a.ifNValid(HEREDOC_BODY_START, 'ws_loop');
  a.const_(R_HBS, 1);

  a.label('ws_loop');
  //     if (!valid[NO_LINE_BREAK] && valid[LINE_BREAK] &&
  //         lexer->is_at_included_range_start(lexer)) {
  a.ifValid(NO_LINE_BREAK, 'ws_sw');
  a.ifNValid(LINE_BREAK, 'ws_sw');
  a.ifRangeStart('ws_range_lb');
  a.jmp('ws_sw');
  a.label('ws_range_lb');
  a.markEnd();
  a.emit(LINE_BREAK);

  a.label('ws_sw');
  a.ifChar(CH(' '), 'ws_skip');
  a.ifChar(CH('\t'), 'ws_skip');
  a.ifChar(CH('\r'), 'ws_cr');
  a.ifChar(CH('\n'), 'ws_nl');
  a.ifChar(CH('\\'), 'ws_bs');
  a.jmp('ws_default');

  a.label('ws_skip');
  skip_();
  a.jmp('ws_loop');

  a.label('ws_cr');
  a.ifCmpI('eq', R_HBS, 0, 'ws_cr_skip');
  a.call('hdoc0_set_started');
  a.emit(HEREDOC_BODY_START);
  a.label('ws_cr_skip');
  skip_();
  a.jmp('ws_loop');

  a.label('ws_nl');
  a.ifCmpI('ne', R_HBS, 0, 'ws_nl_hbs');
  a.ifValid(NO_LINE_BREAK, 'ws_nl_skip');
  a.ifNValid(LINE_BREAK, 'ws_nl_skip');
  a.ifCmpI('ne', R_CROSSED, 0, 'ws_nl_skip');
  a.markEnd();
  a.advance();
  a.const_(R_CROSSED, 1);
  a.jmp('ws_loop');
  a.label('ws_nl_hbs');
  a.call('hdoc0_set_started');
  a.emit(HEREDOC_BODY_START);
  a.label('ws_nl_skip');
  skip_();
  a.jmp('ws_loop');

  a.label('ws_bs');
  a.advance();
  a.ifNChar(CH('\r'), 'ws_bs_sp');
  skip_();
  a.label('ws_bs_sp');
  a.ifNClass(C_SPACE, 'fail');
  skip_();
  a.jmp('ws_loop');

  a.label('ws_default');
  a.ifCmpI('eq', R_CROSSED, 0, 'ws_cont');
  a.ifChar(CH('.'), 'ws_dot');
  a.ifChar(CH('&'), 'ws_cont');
  a.ifChar(CH('#'), 'ws_cont');
  a.emit(LINE_BREAK);
  a.label('ws_dot');
  a.advance();
  a.ifEof('fail');
  a.ifChar(CH('.'), 'ws_dot_lb');
  a.jmp('fail');
  a.label('ws_dot_lb');
  a.emit(LINE_BREAK);
  a.label('ws_cont');
  a.ret();

  // ======================================================================
  // scan_literal_content
  //   Literal *literal = array_back(&scanner->literal_stack);
  //   bool has_content = false;
  //   bool stop_on_space = literal->type == SYMBOL_ARRAY_START ||
  //                        literal->type == STRING_ARRAY_START;
  // ======================================================================
  a.label('lit_content');
  a.peek(S_LITS, R_LIT, 0);
  unpackLit();
  a.const_(R_HAS, 0);
  a.const_(R_STOP, 0);
  a.ifCmpI('eq', R_TYPE, SYMBOL_ARRAY_START, 'lit_stop');
  a.ifCmpI('eq', R_TYPE, STRING_ARRAY_START, 'lit_stop');
  a.jmp('lit_loop');
  a.label('lit_stop');
  a.const_(R_STOP, 1);

  a.label('lit_loop');
  //     if (stop_on_space && iswspace(lexer->lookahead)) {
  //       if (has_content) { mark_end; result = STRING_CONTENT; return true; }
  //       return false;
  //     }
  a.ifCmpI('eq', R_STOP, 0, 'lit_close');
  a.ifNClass(C_SPACE, 'lit_close');
  a.ifCmpI('eq', R_HAS, 0, 'fail');
  a.markEnd();
  a.emit(STRING_CONTENT);

  //     if (lexer->lookahead == literal->close_delimiter) {
  //       mark_end;
  //       if (literal->nesting_depth == 1) {
  //         if (has_content) { result = STRING_CONTENT; }
  //         else {
  //           advance;
  //           if (type == REGEX_START) while (iswlower) advance;
  //           array_pop(&literal_stack);
  //           result = STRING_END; mark_end;
  //         }
  //         return true;
  //       }
  //       literal->nesting_depth--;
  //       advance;
  //     }
  a.label('lit_close');
  a.lookahead(R_LA);
  a.ifCmp('ne', R_LA, R_CLOSE, 'lit_open');
  a.markEnd();
  a.ifCmpI('ne', R_NEST, 1, 'lit_nest_dec');
  a.ifCmpI('ne', R_HAS, 0, 'lit_end_content');
  a.advance();
  a.ifCmpI('ne', R_TYPE, REGEX_START, 'lit_pop');
  a.label('lit_flags');
  a.ifNClass(C_LOWER, 'lit_pop');
  a.advance();
  a.jmp('lit_flags');
  a.label('lit_pop');
  a.pop(S_LITS, R_TMP);
  a.markEnd();
  a.emit(STRING_END);
  a.label('lit_end_content');
  a.emit(STRING_CONTENT);
  a.label('lit_nest_dec');
  a.alui('add', R_NEST, -1);
  packLit();
  a.settop(S_LITS, R_LIT);
  a.advance();
  a.jmp('lit_has');

  //     } else if (lexer->lookahead == literal->open_delimiter) {
  //       literal->nesting_depth++;
  //       advance;
  a.label('lit_open');
  a.lookahead(R_LA);
  a.ifCmp('ne', R_LA, R_OPEN, 'lit_hash');
  a.alui('add', R_NEST, 1);
  packLit();
  a.settop(S_LITS, R_LIT);
  a.advance();
  a.jmp('lit_has');

  //     } else if (literal->allows_interpolation && lexer->lookahead == '#') {
  //       mark_end; advance;
  //       if (lookahead == '{') {
  //         if (has_content) { result = STRING_CONTENT; return true; }
  //         return false;
  //       }
  //       if (scan_short_interpolation(lexer, has_content, STRING_CONTENT))
  //         return true;
  a.label('lit_hash');
  a.ifCmpI('eq', R_INTERP, 0, 'lit_bs');
  a.ifNChar(CH('#'), 'lit_bs');
  a.markEnd();
  a.advance();
  a.ifNChar(CH('{'), 'lit_hash_si');
  a.ifCmpI('eq', R_HAS, 0, 'fail');
  a.emit(STRING_CONTENT);
  a.label('lit_hash_si');
  a.const_(R_SYM, STRING_CONTENT);
  a.call('short_interp');
  a.jmp('lit_has');

  //     } else if (lexer->lookahead == '\\') {
  //       if (literal->allows_interpolation) {
  //         if (has_content) { mark_end; result = STRING_CONTENT; return true; }
  //         return false;
  //       }
  //       advance; advance;
  a.label('lit_bs');
  a.ifNChar(CH('\\'), 'lit_eof');
  a.ifCmpI('eq', R_INTERP, 0, 'lit_bs_raw');
  a.ifCmpI('eq', R_HAS, 0, 'fail');
  a.markEnd();
  a.emit(STRING_CONTENT);
  a.label('lit_bs_raw');
  a.advance();
  a.advance();
  a.jmp('lit_has');

  //     } else if (lexer->eof(lexer)) {
  //       advance; mark_end; return false;
  //     } else {
  //       advance;
  //     }
  //     has_content = true;
  a.label('lit_eof');
  a.ifNEof('lit_other');
  a.advance();
  a.markEnd();
  a.jmp('fail');
  a.label('lit_other');
  a.advance();
  a.label('lit_has');
  a.const_(R_HAS, 1);
  a.jmp('lit_loop');

  // ======================================================================
  // scan_heredoc_content
  //   Heredoc *heredoc = array_get(&scanner->open_heredocs, 0);
  //   size_t position_in_word = 0;
  //   bool look_for_heredoc_end = true;
  //   bool has_content = false;
  // ======================================================================
  a.label('heredoc_content');
  a.getidx(S_HDOC, R_HDR, R_ZERO);
  unpackHdoc();
  a.const_(R_POS, 0);
  a.const_(R_LOOKEND, 1);
  a.const_(R_HAS, 0);

  a.label('hc_loop');
  //     if (position_in_word == heredoc->word.size) {
  //       if (!has_content) mark_end;
  //       while (lookahead == ' ' || lookahead == '\t') advance;
  //       if (lookahead == '\n' || lookahead == '\r') {
  //         if (has_content) result = HEREDOC_CONTENT;
  //         else { array_erase(&open_heredocs, 0); result = HEREDOC_BODY_END; }
  //         return true;
  //       }
  //       has_content = true;
  //       position_in_word = 0;
  //     }
  a.ifCmp('ne', R_POS, R_WLEN, 'hc_eof');
  a.ifCmpI('ne', R_HAS, 0, 'hc_mw_ws');
  a.markEnd();
  a.label('hc_mw_ws');
  a.ifChar(CH(' '), 'hc_mw_sp');
  a.ifChar(CH('\t'), 'hc_mw_sp');
  a.jmp('hc_mw_nl');
  a.label('hc_mw_sp');
  a.advance();
  a.jmp('hc_mw_ws');
  a.label('hc_mw_nl');
  a.ifChar(CH('\n'), 'hc_mw_end');
  a.ifChar(CH('\r'), 'hc_mw_end');
  a.const_(R_HAS, 1);
  a.const_(R_POS, 0);
  a.jmp('hc_eof');
  a.label('hc_mw_end');
  a.ifCmpI('ne', R_HAS, 0, 'hc_mw_content');
  a.call('hdoc0_erase');
  a.emit(HEREDOC_BODY_END);
  a.label('hc_mw_content');
  a.emit(HEREDOC_CONTENT);

  //     if (lexer->eof(lexer)) {
  //       mark_end;
  //       if (has_content) result = HEREDOC_CONTENT;
  //       else { array_erase(&open_heredocs, 0); result = HEREDOC_BODY_END; }
  //       return true;
  //     }
  a.label('hc_eof');
  a.ifNEof('hc_match');
  a.markEnd();
  a.ifCmpI('ne', R_HAS, 0, 'hc_eof_content');
  a.call('hdoc0_erase');
  a.emit(HEREDOC_BODY_END);
  a.label('hc_eof_content');
  a.emit(HEREDOC_CONTENT);

  //     if (lookahead == *array_get(&heredoc->word, position_in_word) &&
  //         look_for_heredoc_end) {
  //       advance; position_in_word++;
  //     } else {
  //       position_in_word = 0;
  //       look_for_heredoc_end = false;
  a.label('hc_match');
  a.ifCmpI('eq', R_LOOKEND, 0, 'hc_nomatch');
  a.getidx(S_WORD, R_TMP, R_POS);
  a.lookahead(R_LA);
  a.ifCmp('ne', R_LA, R_TMP, 'hc_nomatch');
  a.advance();
  a.alui('add', R_POS, 1);
  a.jmp('hc_loop');

  a.label('hc_nomatch');
  a.const_(R_POS, 0);
  a.const_(R_LOOKEND, 0);
  //       if (heredoc->allows_interpolation && lookahead == '\\') {
  //         if (has_content) { result = HEREDOC_CONTENT; return true; }
  //         return false;
  //       }
  a.ifCmpI('eq', R_INTERP, 0, 'hc_hash');
  a.ifNChar(CH('\\'), 'hc_hash');
  a.ifCmpI('eq', R_HAS, 0, 'fail');
  a.emit(HEREDOC_CONTENT);

  //       if (heredoc->allows_interpolation && lookahead == '#') {
  //         mark_end; advance;
  //         if (lookahead == '{') {
  //           if (has_content) { result = HEREDOC_CONTENT; return true; }
  //           return false;
  //         }
  //         if (scan_short_interpolation(..., HEREDOC_CONTENT)) return true;
  //       } else if (lookahead == '\r' || lookahead == '\n') {
  a.label('hc_hash');
  a.ifCmpI('eq', R_INTERP, 0, 'hc_nl');
  a.ifNChar(CH('#'), 'hc_nl');
  a.markEnd();
  a.advance();
  a.ifNChar(CH('{'), 'hc_hash_si');
  a.ifCmpI('eq', R_HAS, 0, 'fail');
  a.emit(HEREDOC_CONTENT);
  a.label('hc_hash_si');
  a.const_(R_SYM, HEREDOC_CONTENT);
  a.call('short_interp');
  a.jmp('hc_loop');

  a.label('hc_nl');
  //         if (lookahead == '\r') { advance; if (lookahead == '\n') advance; }
  //         else advance;
  //         has_content = true; look_for_heredoc_end = true;
  //         while (lookahead == ' ' || lookahead == '\t') {
  //           advance;
  //           if (!heredoc->end_word_indentation_allowed)
  //             look_for_heredoc_end = false;
  //         }
  //         mark_end;
  //       } else {
  //         has_content = true; advance; mark_end;
  //       }
  a.ifChar(CH('\r'), 'hc_cr');
  a.ifChar(CH('\n'), 'hc_lf');
  a.jmp('hc_other');
  a.label('hc_cr');
  a.advance();
  a.ifNChar(CH('\n'), 'hc_after_nl');
  a.advance();
  a.jmp('hc_after_nl');
  a.label('hc_lf');
  a.advance();
  a.label('hc_after_nl');
  a.const_(R_HAS, 1);
  a.const_(R_LOOKEND, 1);
  a.label('hc_nl_ws');
  a.ifChar(CH(' '), 'hc_nl_sp');
  a.ifChar(CH('\t'), 'hc_nl_sp');
  a.markEnd();
  a.jmp('hc_loop');
  a.label('hc_nl_sp');
  a.advance();
  a.ifCmpI('ne', R_INDENT, 0, 'hc_nl_ws');
  a.const_(R_LOOKEND, 0);
  a.jmp('hc_nl_ws');

  a.label('hc_other');
  a.const_(R_HAS, 1);
  a.advance();
  a.markEnd();
  a.jmp('hc_loop');

  // ======================================================================
  // scan_open_delimiter -> R_OK, fills R_TYPE/R_OPEN/R_CLOSE/R_INTERP
  //   switch (lexer->lookahead) {
  //     case '"': type = STRING_START; open = close = '"'; interp = true; ...
  //     case '\'': ... interp = false;
  //     case '`': if (!valid[SUBSHELL_START]) return false; ...
  //     case '/': if (!valid[REGEX_START]) return false; ... FORWARD_SLASH
  //     case '%': ...
  //     default: return false;
  //   }
  // ======================================================================
  a.label('open_delim');
  a.ifChar(CH('"'), 'od_dq');
  a.ifChar(CH('\''), 'od_sq');
  a.ifChar(CH('`'), 'od_tick');
  a.ifChar(CH('/'), 'od_slash');
  a.ifChar(CH('%'), 'od_pct');
  a.const_(R_OK, 0);
  a.ret();

  a.label('od_dq');
  a.const_(R_TYPE, STRING_START);
  a.const_(R_OPEN, CH('"'));
  a.const_(R_CLOSE, CH('"'));
  a.const_(R_INTERP, 1);
  a.advance();
  a.const_(R_OK, 1);
  a.ret();

  a.label('od_sq');
  a.const_(R_TYPE, STRING_START);
  a.const_(R_OPEN, CH('\''));
  a.const_(R_CLOSE, CH('\''));
  a.const_(R_INTERP, 0);
  a.advance();
  a.const_(R_OK, 1);
  a.ret();

  a.label('od_tick');
  a.ifNValid(SUBSHELL_START, 'od_no');
  a.const_(R_TYPE, SUBSHELL_START);
  a.const_(R_OPEN, CH('`'));
  a.const_(R_CLOSE, CH('`'));
  a.const_(R_INTERP, 1);
  a.advance();
  a.const_(R_OK, 1);
  a.ret();

  a.label('od_slash');
  a.ifNValid(REGEX_START, 'od_no');
  a.const_(R_TYPE, REGEX_START);
  a.const_(R_OPEN, CH('/'));
  a.const_(R_CLOSE, CH('/'));
  a.const_(R_INTERP, 1);
  a.advance();
  a.ifNValid(FORWARD_SLASH, 'od_yes');
  a.ifCmpI('eq', R_HLW, 0, 'od_no');
  a.ifChar(CH(' '), 'od_no');
  a.ifChar(CH('\t'), 'od_no');
  a.ifChar(CH('\n'), 'od_no');
  a.ifChar(CH('\r'), 'od_no');
  a.ifChar(CH('='), 'od_no');
  a.jmp('od_yes');

  a.label('od_no');
  a.const_(R_OK, 0);
  a.ret();
  a.label('od_yes');
  a.const_(R_OK, 1);
  a.ret();

  a.label('od_pct');
  a.advance();
  a.ifChar(CH('s'), 'od_pct_s');
  a.ifChar(CH('r'), 'od_pct_r');
  a.ifChar(CH('x'), 'od_pct_x');
  a.ifChar(CH('q'), 'od_pct_q');
  a.ifChar(CH('Q'), 'od_pct_Q');
  a.ifChar(CH('w'), 'od_pct_w');
  a.ifChar(CH('i'), 'od_pct_i');
  a.ifChar(CH('W'), 'od_pct_W');
  a.ifChar(CH('I'), 'od_pct_I');
  a.ifNValid(STRING_START, 'od_no');
  a.const_(R_TYPE, STRING_START);
  a.const_(R_INTERP, 1);
  a.jmp('od_pct_delim');
  a.label('od_pct_s');
  a.ifNValid(SIMPLE_SYMBOL, 'od_no');
  a.const_(R_TYPE, SYMBOL_START);
  a.const_(R_INTERP, 0);
  a.advance();
  a.jmp('od_pct_delim');
  a.label('od_pct_r');
  a.ifNValid(REGEX_START, 'od_no');
  a.const_(R_TYPE, REGEX_START);
  a.const_(R_INTERP, 1);
  a.advance();
  a.jmp('od_pct_delim');
  a.label('od_pct_x');
  a.ifNValid(SUBSHELL_START, 'od_no');
  a.const_(R_TYPE, SUBSHELL_START);
  a.const_(R_INTERP, 1);
  a.advance();
  a.jmp('od_pct_delim');
  a.label('od_pct_q');
  a.ifNValid(STRING_START, 'od_no');
  a.const_(R_TYPE, STRING_START);
  a.const_(R_INTERP, 0);
  a.advance();
  a.jmp('od_pct_delim');
  a.label('od_pct_Q');
  a.ifNValid(STRING_START, 'od_no');
  a.const_(R_TYPE, STRING_START);
  a.const_(R_INTERP, 1);
  a.advance();
  a.jmp('od_pct_delim');
  a.label('od_pct_w');
  a.ifNValid(STRING_ARRAY_START, 'od_no');
  a.const_(R_TYPE, STRING_ARRAY_START);
  a.const_(R_INTERP, 0);
  a.advance();
  a.jmp('od_pct_delim');
  a.label('od_pct_i');
  a.ifNValid(SYMBOL_ARRAY_START, 'od_no');
  a.const_(R_TYPE, SYMBOL_ARRAY_START);
  a.const_(R_INTERP, 0);
  a.advance();
  a.jmp('od_pct_delim');
  a.label('od_pct_W');
  a.ifNValid(STRING_ARRAY_START, 'od_no');
  a.const_(R_TYPE, STRING_ARRAY_START);
  a.const_(R_INTERP, 1);
  a.advance();
  a.jmp('od_pct_delim');
  a.label('od_pct_I');
  a.ifNValid(SYMBOL_ARRAY_START, 'od_no');
  a.const_(R_TYPE, SYMBOL_ARRAY_START);
  a.const_(R_INTERP, 1);
  a.advance();

  a.label('od_pct_delim');
  a.ifChar(CH('('), 'od_pd_paren');
  a.ifChar(CH('['), 'od_pd_brack');
  a.ifChar(CH('{'), 'od_pd_brace');
  a.ifChar(CH('<'), 'od_pd_angle');
  a.ifChar(CH('\r'), 'od_pd_ws');
  a.ifChar(CH('\n'), 'od_pd_ws');
  a.ifChar(CH(' '), 'od_pd_ws');
  a.ifChar(CH('\t'), 'od_pd_ws');
  for (const c of PCT_UNBALANCED) a.ifChar(CH(c), 'od_pd_same');
  a.jmp('od_no');
  a.label('od_pd_paren');
  a.const_(R_OPEN, CH('('));
  a.const_(R_CLOSE, CH(')'));
  a.jmp('od_pct_adv');
  a.label('od_pd_brack');
  a.const_(R_OPEN, CH('['));
  a.const_(R_CLOSE, CH(']'));
  a.jmp('od_pct_adv');
  a.label('od_pd_brace');
  a.const_(R_OPEN, CH('{'));
  a.const_(R_CLOSE, CH('}'));
  a.jmp('od_pct_adv');
  a.label('od_pd_angle');
  a.const_(R_OPEN, CH('<'));
  a.const_(R_CLOSE, CH('>'));
  a.jmp('od_pct_adv');
  a.label('od_pd_ws');
  a.ifValid(FORWARD_SLASH, 'od_no');
  a.jmp('od_pct_adv');
  a.label('od_pd_same');
  a.lookahead(R_OPEN);
  a.mov(R_CLOSE, R_OPEN);
  a.label('od_pct_adv');
  a.advance();
  a.const_(R_OK, 1);
  a.ret();

  // ======================================================================
  // scan_heredoc_word
  //   quote = 0;
  //   switch (lookahead) {
  //     case '\'': case '"': case '`':
  //       quote = lookahead; advance;
  //       while (lookahead != quote && !eof) { array_push(&word, lookahead); advance; }
  //       advance;
  //       break;
  //     default:
  //       if (iswalnum(lookahead) || lookahead == '_') {
  //         array_push; advance;
  //         while (iswalnum || '_') { array_push; advance; }
  //       }
  //   }
  //   heredoc->allows_interpolation = quote != '\'';
  // ======================================================================
  a.label('heredoc_word');
  a.const_(R_WLEN, 0);
  a.const_(R_INTERP, 1);
  a.ifChar(CH('\''), 'hw_sq');
  a.ifChar(CH('"'), 'hw_dq');
  a.ifChar(CH('`'), 'hw_bq');
  a.jmp('hw_unquoted');
  a.label('hw_sq');
  a.const_(R_INTERP, 0);
  a.const_(R_QUOTE, CH('\''));
  a.jmp('hw_quoted');
  a.label('hw_dq');
  a.const_(R_QUOTE, CH('"'));
  a.jmp('hw_quoted');
  a.label('hw_bq');
  a.const_(R_QUOTE, CH('`'));
  a.label('hw_quoted');
  a.advance();
  a.label('hw_qloop');
  a.ifEof('hw_qend');
  a.lookahead(R_LA);
  a.ifCmp('eq', R_LA, R_QUOTE, 'hw_qend');
  pushWordByte();
  a.alui('add', R_WLEN, 1);
  a.advance();
  a.jmp('hw_qloop');
  a.label('hw_qend');
  a.advance();
  a.ret();
  a.label('hw_unquoted');
  a.ifNClass(C_ALNUM_US, 'hw_empty');
  pushWordByte();
  a.alui('add', R_WLEN, 1);
  a.advance();
  a.label('hw_uloop');
  a.ifNClass(C_ALNUM_US, 'hw_empty');
  pushWordByte();
  a.alui('add', R_WLEN, 1);
  a.advance();
  a.jmp('hw_uloop');
  a.label('hw_empty');
  a.ret();

  // ======================================================================
  // scan_short_interpolation(has_content=R_HAS, content_symbol=R_SYM)
  //   char start = (char)lexer->lookahead;
  //   if (start == '@' || start == '$') {
  //     if (has_content) { result = content_symbol; return true; }
  //     mark_end; advance;
  //     ... $ specials / $ - alpha_ / $ alnum_ / @[@] is_iden && !digit ...
  //     if (is_short_interpolation) { result = SHORT_INTERPOLATION; return true; }
  //   }
  //   return false;
  // ======================================================================
  a.label('short_interp');
  a.lookahead(R_START);
  a.alui('shl', R_START, 24);
  a.alui('sar', R_START, 24);
  a.ifCmpI('eq', R_START, CH('@'), 'si_go');
  a.ifCmpI('eq', R_START, CH('$'), 'si_go');
  a.ret();
  a.label('si_go');
  a.ifCmpI('eq', R_HAS, 0, 'si_scan');
  a.emitR(R_SYM);
  a.label('si_scan');
  a.markEnd();
  a.advance();
  a.const_(R_ISI, 0);
  a.ifCmpI('ne', R_START, CH('$'), 'si_at');
  a.call('dollar_special');
  a.ifCmpI('ne', R_OK, 0, 'si_yes');
  a.ifNChar(CH('-'), 'si_dol_alnum');
  a.advance();
  a.ifClass(C_ALPHA, 'si_yes');
  a.ifChar(CH('_'), 'si_yes');
  a.jmp('si_at');
  a.label('si_dol_alnum');
  a.ifClass(C_ALNUM_US, 'si_yes');
  a.jmp('si_at');
  a.label('si_yes');
  a.const_(R_ISI, 1);
  a.label('si_at');
  a.ifCmpI('ne', R_START, CH('@'), 'si_check');
  a.ifNChar(CH('@'), 'si_at_iden');
  a.advance();
  a.label('si_at_iden');
  a.call('is_iden');
  a.ifCmpI('eq', R_OK, 0, 'si_check');
  a.ifClass(C_DIGIT, 'si_check');
  a.const_(R_ISI, 1);
  a.label('si_check');
  a.ifCmpI('eq', R_ISI, 0, 'si_no');
  a.emit(SHORT_INTERPOLATION);
  a.label('si_no');
  a.ret();

  // ======================================================================
  // scan_symbol_identifier -> R_OK
  // ======================================================================
  a.label('symbol_id');
  a.ifChar(CH('@'), 'syid_at');
  a.ifChar(CH('$'), 'syid_dol');
  a.jmp('syid_body');
  a.label('syid_at');
  a.advance();
  a.ifNChar(CH('@'), 'syid_body');
  a.advance();
  a.jmp('syid_body');
  a.label('syid_dol');
  a.advance();
  a.label('syid_body');
  a.call('is_iden');
  a.ifCmpI('ne', R_OK, 0, 'syid_adv');
  a.call('operator');
  a.ifCmpI('eq', R_OK, 0, 'syid_no');
  a.jmp('syid_rest');
  a.label('syid_adv');
  a.advance();
  a.label('syid_rest');
  a.call('is_iden');
  a.ifCmpI('eq', R_OK, 0, 'syid_bang');
  a.advance();
  a.jmp('syid_rest');
  a.label('syid_bang');
  a.ifChar(CH('?'), 'syid_bang_a');
  a.ifChar(CH('!'), 'syid_bang_a');
  a.jmp('syid_eq');
  a.label('syid_bang_a');
  a.advance();
  a.label('syid_eq');
  a.ifNChar(CH('='), 'syid_yes');
  a.markEnd();
  a.advance();
  a.ifChar(CH('>'), 'syid_yes');
  a.markEnd();
  a.label('syid_yes');
  a.const_(R_OK, 1);
  a.ret();
  a.label('syid_no');
  a.const_(R_OK, 0);
  a.ret();

  // ======================================================================
  // scan_operator -> R_OK
  //   switch (lookahead) {
  //     case '<': advance; if ('<') advance; else if ('=') { advance; if ('>') advance; } return true;
  //     case '>': advance; if ('>' || '=') advance; return true;
  //     case '=': advance; if ('~') { advance; return true; }
  //               if ('=') { advance; if ('=') advance; return true; } return false;
  //     case '+': case '-': case '~': advance; if ('@') advance; return true;
  //     case '.': advance; if ('.') { advance; return true; } return false;
  //     case '&': case '^': case '|': case '/': case '%': case '`': advance; return true;
  //     case '!': advance; if ('=' || '~') advance; return true;
  //     case '*': advance; if ('*') advance; return true;
  //     case '[': advance; if (']') { advance; if ('=') advance; return true; } return false;
  //     default: return false;
  //   }
  // ======================================================================
  a.label('operator');
  a.ifChar(CH('<'), 'op_lt');
  a.ifChar(CH('>'), 'op_gt');
  a.ifChar(CH('='), 'op_eq');
  a.ifChar(CH('+'), 'op_pm');
  a.ifChar(CH('-'), 'op_pm');
  a.ifChar(CH('~'), 'op_pm');
  a.ifChar(CH('.'), 'op_dot');
  a.ifChar(CH('&'), 'op_one');
  a.ifChar(CH('^'), 'op_one');
  a.ifChar(CH('|'), 'op_one');
  a.ifChar(CH('/'), 'op_one');
  a.ifChar(CH('%'), 'op_one');
  a.ifChar(CH('`'), 'op_one');
  a.ifChar(CH('!'), 'op_bang');
  a.ifChar(CH('*'), 'op_star');
  a.ifChar(CH('['), 'op_brack');
  a.const_(R_OK, 0);
  a.ret();

  a.label('op_lt');
  a.advance();
  a.ifChar(CH('<'), 'op_adv_yes');
  a.ifNChar(CH('='), 'op_yes');
  a.advance();
  a.ifChar(CH('>'), 'op_adv_yes');
  a.jmp('op_yes');

  a.label('op_gt');
  a.advance();
  a.ifChar(CH('>'), 'op_adv_yes');
  a.ifChar(CH('='), 'op_adv_yes');
  a.jmp('op_yes');

  a.label('op_eq');
  a.advance();
  a.ifChar(CH('~'), 'op_adv_yes');
  a.ifNChar(CH('='), 'op_no');
  a.advance();
  a.ifChar(CH('='), 'op_adv_yes');
  a.jmp('op_yes');

  a.label('op_pm');
  a.advance();
  a.ifChar(CH('@'), 'op_adv_yes');
  a.jmp('op_yes');

  a.label('op_dot');
  a.advance();
  a.ifChar(CH('.'), 'op_adv_yes');
  a.jmp('op_no');

  a.label('op_one');
  a.advance();
  a.jmp('op_yes');

  a.label('op_bang');
  a.advance();
  a.ifChar(CH('='), 'op_adv_yes');
  a.ifChar(CH('~'), 'op_adv_yes');
  a.jmp('op_yes');

  a.label('op_star');
  a.advance();
  a.ifChar(CH('*'), 'op_adv_yes');
  a.jmp('op_yes');

  a.label('op_brack');
  a.advance();
  a.ifNChar(CH(']'), 'op_no');
  a.advance();
  a.ifChar(CH('='), 'op_adv_yes');
  a.jmp('op_yes');

  a.label('op_adv_yes');
  a.advance();
  a.label('op_yes');
  a.const_(R_OK, 1);
  a.ret();
  a.label('op_no');
  a.const_(R_OK, 0);
  a.ret();

  // ======================================================================
  // is_iden_char((char)lookahead) -> R_OK
  // ======================================================================
  a.label('is_iden');
  a.lookahead(R_LA);
  a.alui('and', R_LA, 0xff);
  for (const c of NON_IDEN) a.ifCmpI('eq', R_LA, c, 'iden_no');
  a.const_(R_OK, 1);
  a.ret();
  a.label('iden_no');
  a.const_(R_OK, 0);
  a.ret();

  // ======================================================================
  // strchr("!@&`'+~=/\\,;.<>*$?:\"", lookahead) including NUL terminator
  // ======================================================================
  a.label('dollar_special');
  a.lookahead(R_LA);
  a.alui('and', R_LA, 0xff);
  a.const_(R_OK, 0);
  for (const c of DOLLAR_SPECIAL) a.ifCmpI('eq', R_LA, c, 'ds_yes');
  a.ret();
  a.label('ds_yes');
  a.const_(R_OK, 1);
  a.ret();

  // ======================================================================
  // set started on open_heredocs[0]
  // ======================================================================
  a.label('hdoc0_set_started');
  a.len(S_HDOC, R_N);
  a.mov(R_CNT, R_N);
  a.alui('add', R_CNT, -1);
  a.label('hs_peel');
  a.ifCmpI('eq', R_CNT, 0, 'hs_set');
  a.pop(S_HDOC, R_TMP);
  a.push(S_TMP, R_TMP);
  a.alui('add', R_CNT, -1);
  a.jmp('hs_peel');
  a.label('hs_set');
  a.peek(S_HDOC, R_HDR, 0);
  a.alui('or', R_HDR, 1 << HD_STARTED_BIT);
  a.settop(S_HDOC, R_HDR);
  a.label('hs_rest');
  a.len(S_TMP, R_CNT);
  a.ifCmpI('eq', R_CNT, 0, 'hs_done');
  a.pop(S_TMP, R_TMP);
  a.push(S_HDOC, R_TMP);
  a.jmp('hs_rest');
  a.label('hs_done');
  a.ret();

  // ======================================================================
  // array_erase(&open_heredocs, 0) plus the matching word-byte prefix
  // ======================================================================
  a.label('hdoc0_erase');
  a.getidx(S_HDOC, R_HDR, R_ZERO);
  a.mov(R_WLEN, R_HDR);
  a.alui('and', R_WLEN, HD_LEN_MASK);
  a.len(S_WORD, R_N);
  a.mov(R_I, R_N);
  a.alui('add', R_I, -1);
  a.label('he_copy');
  a.ifCmp('lt', R_I, R_WLEN, 'he_copy_done');
  a.getidx(S_WORD, R_TMP, R_I);
  a.push(S_TMP, R_TMP);
  a.alui('add', R_I, -1);
  a.jmp('he_copy');
  a.label('he_copy_done');
  a.clear(S_WORD);
  a.label('he_rest_w');
  a.len(S_TMP, R_CNT);
  a.ifCmpI('eq', R_CNT, 0, 'he_hdrs');
  a.pop(S_TMP, R_TMP);
  a.push(S_WORD, R_TMP);
  a.jmp('he_rest_w');
  a.label('he_hdrs');
  a.len(S_HDOC, R_N);
  a.mov(R_CNT, R_N);
  a.alui('add', R_CNT, -1);
  a.label('he_peel');
  a.ifCmpI('eq', R_CNT, 0, 'he_drop');
  a.pop(S_HDOC, R_TMP);
  a.push(S_TMP, R_TMP);
  a.alui('add', R_CNT, -1);
  a.jmp('he_peel');
  a.label('he_drop');
  a.pop(S_HDOC, R_TMP);
  a.label('he_rest_h');
  a.len(S_TMP, R_CNT);
  a.ifCmpI('eq', R_CNT, 0, 'he_done');
  a.pop(S_TMP, R_TMP);
  a.push(S_HDOC, R_TMP);
  a.jmp('he_rest_h');
  a.label('he_done');
  a.ret();

  return {
    entry: 0,
    regPersist: 0,
    stacks: [
      { persist: true },
      { persist: true },
      { persist: true },
      { persist: false },
    ],
    stackInit: [],
    classes: [
      ctype.space,
      ctype.alnum,
      ctype.alpha,
      ctype.digit,
      ctype.lower,
      ctype.upper,
      union(ctype.alnum, one('_')),
      union(ctype.alpha, one('_')),
    ],
    maps: [],
    strings: [],
    validSets: [],
    jumpTable: [],
    code: a.build(),
  };
}

module.exports = { build };
