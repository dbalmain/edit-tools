// tree-sitter-toml 0.7.0's 82-line scanner, hand-compiled to scanner-VM
// bytecode.  Upstream source is reproduced in comments so the two can be
// diffed by eye; that is the only review this port gets.
//
// External token order is upstream's enum, and it is load-bearing -- the
// parser passes valid_symbols indexed by it.
const { Asm } = require('./asm.js');

const LINE_ENDING_OR_EOF = 0;
const MB_CONTENT = 1;  // MULTILINE_BASIC_STRING_CONTENT
const MB_END = 2;      // MULTILINE_BASIC_STRING_END
const ML_CONTENT = 3;  // MULTILINE_LITERAL_STRING_CONTENT
const ML_END = 4;      // MULTILINE_LITERAL_STRING_END

// Registers.  R0..R2 are the helper's parameters, matching the C signature
// `(delimiter, content_symbol, end_symbol)`.
const R_DELIM = 0, R_CONTENT = 1, R_END = 2;
const R_HIT = 3;   // helper result: 1 = emit, 0 = fall through
const R_SYM = 4;   // helper result: which symbol to emit
const R_LA = 5;    // scratch for lookahead

const CLASS_SPACE_TAB = 0; // [\t ] -- upstream tests ' ' and '\t' explicitly

function build() {
  const a = new Asm();

  // --- scan() -------------------------------------------------------------
  a.label('entry');

  //   if (scan_multiline_string_end(lexer, valid_symbols, '"',
  //         MULTILINE_BASIC_STRING_CONTENT, MULTILINE_BASIC_STRING_END) || ...
  a.const_(R_DELIM, 0x22).const_(R_CONTENT, MB_CONTENT).const_(R_END, MB_END);
  a.call('mls');
  a.ifCmpI('ne', R_HIT, 0, 'do_emit');

  //   ... scan_multiline_string_end(lexer, valid_symbols, '\'',
  //         MULTILINE_LITERAL_STRING_CONTENT, MULTILINE_LITERAL_STRING_END))
  a.const_(R_DELIM, 0x27).const_(R_CONTENT, ML_CONTENT).const_(R_END, ML_END);
  a.call('mls');
  a.ifCmpI('ne', R_HIT, 0, 'do_emit');

  //   if (valid_symbols[LINE_ENDING_OR_EOF]) {
  a.ifNValid(LINE_ENDING_OR_EOF, 'fail');

  //     while (lexer->lookahead == ' ' || lexer->lookahead == '\t')
  //         lexer->advance(lexer, true);
  a.label('ws');
  a.ifNClass(CLASS_SPACE_TAB, 'after_ws');
  a.skip();
  a.jmp('ws');
  a.label('after_ws');

  //     if (lexer->lookahead == 0 || lexer->lookahead == '\n') return true;
  // NB: upstream tests `lookahead == 0`, not `eof()`.  A literal NUL byte in
  // the source therefore ends a line here.  IF_CHAR 0, not IF_EOF.
  a.ifChar(0, 'emit_le');
  a.ifChar(0x0a, 'emit_le');

  //     if (lexer->lookahead == '\r') {
  //         lexer->advance(lexer, true);
  //         if (lexer->lookahead == '\n') return true;
  //     }
  a.ifNChar(0x0d, 'fail');
  a.skip();
  a.ifChar(0x0a, 'emit_le');

  a.label('fail');
  a.fail();

  a.label('emit_le');
  a.emit(LINE_ENDING_OR_EOF);

  a.label('do_emit');
  a.emitR(R_SYM);

  // --- scan_multiline_string_end(delimiter, content_symbol, end_symbol) ----
  // Returns in R_HIT / R_SYM rather than halting, because upstream's `false`
  // means "keep looking", not "no token here".
  a.label('mls');
  a.const_(R_HIT, 0);

  //   if (!valid_symbols[end_symbol] || lexer->lookahead != delimiter)
  //       return false;
  a.ifNValidR(R_END, 'mls_ret');
  a.lookahead(R_LA);
  a.ifCmp('ne', R_LA, R_DELIM, 'mls_ret');

  //   lexer->advance(lexer, false);
  //   lexer->mark_end(lexer);
  a.advance();
  a.markEnd();

  //   if (lexer->lookahead != delimiter) { result = content; return true; }
  a.lookahead(R_LA);
  a.ifCmp('ne', R_LA, R_DELIM, 'mls_content');

  //   lexer->advance(lexer, false);
  //   if (lexer->lookahead != delimiter) { mark_end; result = content; return true; }
  a.advance();
  a.lookahead(R_LA);
  a.ifCmp('ne', R_LA, R_DELIM, 'mls_mark_content');

  //   lexer->advance(lexer, false);
  //   if (lexer->lookahead != delimiter) { mark_end; result = end; return true; }
  a.advance();
  a.lookahead(R_LA);
  a.ifCmp('ne', R_LA, R_DELIM, 'mls_mark_end');

  //   result = content; return true;   <- no mark_end: the token ends where
  //   the first mark_end put it, one delimiter in.
  a.label('mls_content');
  a.const_(R_HIT, 1);
  a.mov(R_SYM, R_CONTENT);
  a.ret();

  a.label('mls_mark_content');
  a.markEnd();
  a.const_(R_HIT, 1);
  a.mov(R_SYM, R_CONTENT);
  a.ret();

  a.label('mls_mark_end');
  a.markEnd();
  a.const_(R_HIT, 1);
  a.mov(R_SYM, R_END);
  a.ret();

  a.label('mls_ret');
  a.ret();

  const code = a.build();
  return {
    abi: 1,
    entry: a.labels.get('entry'),
    externals: [
      'line_ending_or_eof',
      'multiline_basic_string_content',
      'multiline_basic_string_end',
      'multiline_literal_string_content',
      'multiline_literal_string_end',
    ],
    regPersist: 0,          // toml's serialize() returns 0 bytes
    stacks: [],
    stackInit: [],
    classes: [[0x09, 0x09, 0x20, 0x20]],
    strings: [],
    validSets: [],
    jumpTable: [],
    code,
  };
}

module.exports = { build };
