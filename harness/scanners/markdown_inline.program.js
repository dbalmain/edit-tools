// EXPERIMENTAL feasibility port; not wired into any manifest or shipped path.
// tree-sitter-markdown 0.5.1's inline scanner
// (`tree-sitter-markdown-inline/src/scanner.c`) hand-compiled to scanner-VM
// bytecode. The source is 397 physical lines / 276 executable-body lines.
//
// External-token order is the upstream enum and is load-bearing. The four
// uint8_t Scanner fields are the first four registers and are persistent. All
// uint8_t increments are explicitly masked so delimiter runs over 255 bytes
// retain C's wraparound behavior.
'use strict';
const { Asm } = require('../../spike/scanner-vm/asm.js');

const ERROR = 0;
const TRIGGER_ERROR = 1;
const CODE_SPAN_START = 2;
const CODE_SPAN_CLOSE = 3;
const EMPHASIS_OPEN_STAR = 4;
const EMPHASIS_OPEN_UNDERSCORE = 5;
const EMPHASIS_CLOSE_STAR = 6;
const EMPHASIS_CLOSE_UNDERSCORE = 7;
const LAST_TOKEN_WHITESPACE = 8;
const LAST_TOKEN_PUNCTUATION = 9;
const STRIKETHROUGH_OPEN = 10;
const STRIKETHROUGH_CLOSE = 11;
const LATEX_SPAN_START = 12;
const LATEX_SPAN_CLOSE = 13;
const UNCLOSED_SPAN = 14;

const STATE_EMPHASIS_DELIMITER_IS_OPEN = 1 << 2;

// Scanner fields (persistent).
const R_STATE = 0;
const R_CODE_LEN = 1;
const R_LATEX_LEN = 2;
const R_EMPH_LEFT = 3;

// Scratch and helper parameters/results.
const R_DELIM = 4;
const R_OPEN = 5;
const R_CLOSE = 6;
const R_LEN_REG = 7; // 1 => R_CODE_LEN; 2 => R_LATEX_LEN
const R_LEVEL = 8;
const R_CLOSE_LEVEL = 9;
const R_COUNT = 10;
const R_LINE_END = 11;
const R_NEXT_WS = 12;
const R_NEXT_PUNCT = 13;
const R_LA = 14;

const C_PUNCTUATION = 0;
const CH = (c) => c.codePointAt(0);

function build() {
  const a = new Asm();

  // scan(): an explicit error request wins before lookahead dispatch.
  a.label('entry');
  a.ifValid(TRIGGER_ERROR, 'error');
  a.ifChar(CH('`'), 'backtick');
  a.ifChar(CH('$'), 'dollar');
  a.ifChar(CH('*'), 'star');
  a.ifChar(CH('_'), 'underscore');
  a.ifChar(CH('~'), 'tilde');
  a.fail();
  a.label('error');
  a.emit(ERROR);

  // parse_backtick / parse_dollar supply parse_leaf_delimiter's parameters.
  a.label('backtick');
  a.const_(R_DELIM, CH('`'));
  a.const_(R_OPEN, CODE_SPAN_START);
  a.const_(R_CLOSE, CODE_SPAN_CLOSE);
  a.const_(R_LEN_REG, 1);
  a.jmp('leaf');

  a.label('dollar');
  a.const_(R_DELIM, CH('$'));
  a.const_(R_OPEN, LATEX_SPAN_START);
  a.const_(R_CLOSE, LATEX_SPAN_CLOSE);
  a.const_(R_LEN_REG, 2);

  // parse_leaf_delimiter. R_LEN_REG chooses one of the two persistent length
  // fields because the VM deliberately has no indirect register addressing.
  a.label('leaf');
  a.const_(R_LEVEL, 0);
  a.label('leaf_open_run');
  a.lookahead(R_LA);
  a.ifCmp('ne', R_LA, R_DELIM, 'leaf_open_done');
  a.advance();
  a.alui('add', R_LEVEL, 1);
  a.alui('and', R_LEVEL, 0xff); // uint8_t level
  a.jmp('leaf_open_run');
  a.label('leaf_open_done');
  a.markEnd();

  // if (level == *delimiter_length && valid_symbols[close_token])
  a.ifCmpI('eq', R_LEN_REG, 1, 'leaf_close_code');
  a.ifCmp('ne', R_LEVEL, R_LATEX_LEN, 'leaf_open_check');
  a.jmp('leaf_close_valid');
  a.label('leaf_close_code');
  a.ifCmp('ne', R_LEVEL, R_CODE_LEN, 'leaf_open_check');
  a.label('leaf_close_valid');
  a.ifNValidR(R_CLOSE, 'leaf_open_check');
  a.ifCmpI('eq', R_LEN_REG, 1, 'leaf_zero_code');
  a.const_(R_LATEX_LEN, 0);
  a.emitR(R_CLOSE);
  a.label('leaf_zero_code');
  a.const_(R_CODE_LEN, 0);
  a.emitR(R_CLOSE);

  // If an opener is valid, scan ahead until an equal-length closing run. The
  // mark_end above keeps the emitted token at the opening delimiter even
  // though the scanner advances arbitrarily far while proving closure.
  a.label('leaf_open_check');
  a.ifNValidR(R_OPEN, 'fail');
  a.const_(R_CLOSE_LEVEL, 0);
  a.label('leaf_ahead');
  a.ifEof('leaf_ahead_done');
  a.lookahead(R_LA);
  a.ifCmp('eq', R_LA, R_DELIM, 'leaf_ahead_delim');
  a.ifCmp('eq', R_CLOSE_LEVEL, R_LEVEL, 'leaf_found');
  a.const_(R_CLOSE_LEVEL, 0);
  a.advance();
  a.jmp('leaf_ahead');
  a.label('leaf_ahead_delim');
  a.alui('add', R_CLOSE_LEVEL, 1); // upstream size_t; practical input bound < i32
  a.advance();
  a.jmp('leaf_ahead');
  a.label('leaf_ahead_done');
  a.ifCmp('ne', R_CLOSE_LEVEL, R_LEVEL, 'leaf_unclosed');
  a.label('leaf_found');
  a.ifCmpI('eq', R_LEN_REG, 1, 'leaf_store_code');
  a.mov(R_LATEX_LEN, R_LEVEL);
  a.emitR(R_OPEN);
  a.label('leaf_store_code');
  a.mov(R_CODE_LEN, R_LEVEL);
  a.emitR(R_OPEN);
  a.label('leaf_unclosed');
  a.ifValid(UNCLOSED_SPAN, 'emit_unclosed');
  a.label('fail');
  a.fail();
  a.label('emit_unclosed');
  a.emit(UNCLOSED_SPAN);

  // The star, underscore, and tilde routines are the same algorithm with
  // different delimiter and token IDs. Load parameters, then share it.
  a.label('star');
  a.const_(R_DELIM, CH('*'));
  a.const_(R_OPEN, EMPHASIS_OPEN_STAR);
  a.const_(R_CLOSE, EMPHASIS_CLOSE_STAR);
  a.jmp('emphasis');

  a.label('underscore');
  a.const_(R_DELIM, CH('_'));
  a.const_(R_OPEN, EMPHASIS_OPEN_UNDERSCORE);
  a.const_(R_CLOSE, EMPHASIS_CLOSE_UNDERSCORE);
  a.jmp('emphasis');

  a.label('tilde');
  a.const_(R_DELIM, CH('~'));
  a.const_(R_OPEN, STRIKETHROUGH_OPEN);
  a.const_(R_CLOSE, STRIKETHROUGH_CLOSE);

  // parse_star / parse_underscore / parse_tilde.
  a.label('emphasis');
  a.advance();

  // A nonzero carry means the preceding scan classified this whole delimiter
  // run. It consumes one delimiter per parser request.
  a.ifCmpI('eq', R_EMPH_LEFT, 0, 'emphasis_new_run');
  a.ifCmpI('eq', R_STATE, STATE_EMPHASIS_DELIMITER_IS_OPEN, 'emphasis_carried_open');
  a.jmp('emphasis_carried_close');
  a.label('emphasis_carried_open');
  a.ifNValidR(R_OPEN, 'emphasis_carried_close');
  a.alui('and', R_STATE, ~STATE_EMPHASIS_DELIMITER_IS_OPEN);
  a.alui('sub', R_EMPH_LEFT, 1);
  a.alui('and', R_EMPH_LEFT, 0xff);
  a.emitR(R_OPEN);
  a.label('emphasis_carried_close');
  a.ifNValidR(R_CLOSE, 'emphasis_new_run');
  a.alui('sub', R_EMPH_LEFT, 1);
  a.alui('and', R_EMPH_LEFT, 0xff);
  a.emitR(R_CLOSE);

  // Otherwise count the delimiter run, with the upstream uint8_t wrap.
  a.label('emphasis_new_run');
  a.markEnd();
  a.const_(R_COUNT, 1);
  a.label('emphasis_count');
  a.lookahead(R_LA);
  a.ifCmp('ne', R_LA, R_DELIM, 'emphasis_after_count');
  a.alui('add', R_COUNT, 1);
  a.alui('and', R_COUNT, 0xff);
  a.advance();
  a.jmp('emphasis_count');

  // line_end = lookahead is LF/CR or lexer->eof().
  a.label('emphasis_after_count');
  a.const_(R_LINE_END, 0);
  a.ifChar(CH('\n'), 'emphasis_line_end');
  a.ifChar(CH('\r'), 'emphasis_line_end');
  a.ifEof('emphasis_line_end');
  a.jmp('emphasis_valid_check');
  a.label('emphasis_line_end');
  a.const_(R_LINE_END, 1);

  // If neither open nor close is valid, the routine returns false without
  // mutating num_emphasis_delimiters_left.
  a.label('emphasis_valid_check');
  a.ifValidR(R_OPEN, 'emphasis_classify');
  a.ifNValidR(R_CLOSE, 'fail');
  a.label('emphasis_classify');
  a.mov(R_EMPH_LEFT, R_COUNT);
  a.alui('sub', R_EMPH_LEFT, 1);
  a.alui('and', R_EMPH_LEFT, 0xff);

  // next_symbol_whitespace = line_end || lookahead == space/tab.
  a.mov(R_NEXT_WS, R_LINE_END);
  a.ifCmpI('ne', R_NEXT_WS, 0, 'emphasis_punct');
  a.ifChar(CH(' '), 'emphasis_set_ws');
  a.ifNChar(CH('\t'), 'emphasis_punct');
  a.label('emphasis_set_ws');
  a.const_(R_NEXT_WS, 1);

  // next_symbol_punctuation = ASCII punctuation per CommonMark.
  a.label('emphasis_punct');
  a.const_(R_NEXT_PUNCT, 0);
  a.ifNClass(C_PUNCTUATION, 'emphasis_try_close');
  a.const_(R_NEXT_PUNCT, 1);

  // Closing delimiters take precedence:
  // valid(close) && !valid(last_ws) &&
  // (!valid(last_punct) || next_punct || next_ws).
  a.label('emphasis_try_close');
  a.ifNValidR(R_CLOSE, 'emphasis_try_open');
  a.ifValid(LAST_TOKEN_WHITESPACE, 'emphasis_try_open');
  a.ifNValid(LAST_TOKEN_PUNCTUATION, 'emphasis_emit_close');
  a.ifCmpI('ne', R_NEXT_PUNCT, 0, 'emphasis_emit_close');
  a.ifCmpI('ne', R_NEXT_WS, 0, 'emphasis_emit_close');
  a.jmp('emphasis_try_open');
  a.label('emphasis_emit_close');
  a.alui('and', R_STATE, ~STATE_EMPHASIS_DELIMITER_IS_OPEN);
  a.emitR(R_CLOSE);

  // Opening condition:
  // !next_ws && (!next_punct || valid(last_punct) || valid(last_ws)).
  // Upstream reaches this condition whenever either open *or close* was valid;
  // it does not re-test valid(open) before emitting the open token.
  a.label('emphasis_try_open');
  a.ifCmpI('ne', R_NEXT_WS, 0, 'fail');
  a.ifCmpI('eq', R_NEXT_PUNCT, 0, 'emphasis_emit_open');
  a.ifValid(LAST_TOKEN_PUNCTUATION, 'emphasis_emit_open');
  a.ifNValid(LAST_TOKEN_WHITESPACE, 'fail');
  a.label('emphasis_emit_open');
  a.alui('or', R_STATE, STATE_EMPHASIS_DELIMITER_IS_OPEN);
  a.emitR(R_OPEN);

  const code = a.build();
  return {
    entry: a.labels.get('entry'),
    regPersist:
      (1 << R_STATE) |
      (1 << R_CODE_LEN) |
      (1 << R_LATEX_LEN) |
      (1 << R_EMPH_LEFT),
    stacks: [],
    stackInit: [],
    classes: [[
      CH('!'), CH('/'),
      CH(':'), CH('@'),
      CH('['), CH('`'),
      CH('{'), CH('~'),
    ]],
    maps: [],
    strings: [],
    validSets: [],
    jumpTable: [],
    code,
  };
}

module.exports = { build };
