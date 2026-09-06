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

const PCT_PAIRED = [
  [0x28, 0x29],                           // ( )
  [0x5b, 0x5d],                           // [ ]
  [0x7b, 0x7d],                           // { }
  [0x3c, 0x3e],                           // < >
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

  // identifier / hash-key / suffix, then open delimiters
  a.jmp('fail');

  a.label('amp');
  a.label('lt');
  a.label('star');
  a.label('minus');
  a.label('colon');
  a.label('bracket');
  a.label('lit_content');
  a.label('heredoc_content');
  a.label('fail');
  a.fail();

  // Stub: real body lands in the next commit. Returning here means
  // "whitespace produced NONE, continue" -- then we fall into fail.
  a.label('whitespace');
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
