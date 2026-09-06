// tree-sitter-python 0.25.0's scanner, hand-compiled to scanner-VM bytecode.
// Upstream source is reproduced in comments so the two can be diffed by eye;
// that is the only review this port gets.
//
// Ported fifth, and out of cost order, because of what it tests rather than
// what it costs. `docs/scanner-vm.md` singles python out as the case where a
// *faithful* port is wrong: its serializer is lossy in three separate ways, and
// what a port has to reproduce is not upstream's format but the equivalence
// relation that format induces on scanner states. That argument had never been
// run against a real port. This is it.
//
// The three lossy spots, and what this port does about each:
//
//   1. `indents[0]` is a sentinel. `deserialize` pushes a 0 before reading
//      anything and `serialize` starts its loop at `iter = 1`, so the bottom
//      entry exists and is defined not to matter. It is also provably never
//      popped: DEDENT needs `indent_length < current`, and with only the
//      sentinel left `current` is 0. So keeping it costs no distinctions --
//      a constant carries no information -- and stack 0 holds it like any
//      other entry, seeded by `stackInit`.
//   2. `delimiter_count` is clamped to UINT8_MAX, so 255 and 300 open string
//      delimiters are *equal* upstream and distinct here. Deepest in the
//      corpus: two.
//   3. Truncation drops from the tail of `indents` specifically. The VM drops
//      from the top of its deepest stack, and for indents the top *is* the
//      tail -- so the two agree unless `delimiters` is the deeper stack, which
//      needs hundreds of nested f-strings. Deepest recorded python state is
//      11 bytes against a 1024-byte buffer.
//
// All three are bounds rather than bugs, and the replay's state bijection is
// what turns "we think these agree" into a check.
'use strict';
const { Asm } = require('../../spike/scanner-vm/asm.js');

// Upstream's `enum TokenType`. COMMENT is declared and never produced -- the
// scanner neither emits it nor reads its validity.
const NEWLINE = 0;
const INDENT = 1;
const DEDENT = 2;
const STRING_START = 3;
const STRING_CONTENT = 4;
const ESCAPE_INTERPOLATION = 5;
const STRING_END = 6;
const CLOSE_PAREN = 8;
const CLOSE_BRACKET = 9;
const CLOSE_BRACE = 10;
const EXCEPT = 11;

// `enum Flags`, one byte per delimiter -- upstream static-asserts
// `sizeof(Delimiter) == sizeof(char)`, which is what lets a delimiter live in
// one stack slot here.
const F_SQ = 1 << 0;
const F_DQ = 1 << 1;
const F_BQ = 1 << 2;
const F_RAW = 1 << 3;
const F_FORMAT = 1 << 4;
const F_TRIPLE = 1 << 5;
const F_BYTES = 1 << 6;
const F_ANY_QUOTE = F_SQ | F_DQ | F_BQ;

// Stacks. Both persistent; there is no transient one.
const S_INDENTS = 0;
const S_DELIMS = 1;

// Registers. R_III is the only persistent one -- upstream's
// `inside_interpolated_string`.
const R_ERM = 0;                          // error_recovery_mode
const R_WB = 1;                           // within_brackets
const R_ADV = 2;                          // advanced_once
const R_DELIM = 3;                        // the delimiter being read or built
const R_END = 4;                          // end_character(delimiter)
const R_HAS = 5;                          // has_content
const R_LA = 6;
const R_EOL = 7;                          // found_end_of_line
const R_ILEN = 8;                         // indent_length (uint16_t upstream)
const R_FCI = 9;                          // first_comment_indent_length
const R_CUR = 10;                         // current_indent_length
const R_TMP = 11;
const R_LB = 12;                          // is_left_brace
const R_III = 13;                         // inside_interpolated_string

const CH = (c) => c.codePointAt(0);

function build() {
  const a = new Asm();

  // `flags & bit`, which is every predicate in tag.h's python equivalent.
  const ifNoFlag = (bit, target) => {
    a.mov(R_TMP, R_DELIM);
    a.alui('and', R_TMP, bit);
    a.ifCmpI('eq', R_TMP, 0, target);
  };
  const ifFlag = (bit, target) => {
    a.mov(R_TMP, R_DELIM);
    a.alui('and', R_TMP, bit);
    a.ifCmpI('ne', R_TMP, 0, target);
  };

  // ======================================================================
  //   bool error_recovery_mode = valid[STRING_CONTENT] && valid[INDENT];
  //   bool within_brackets = valid[CLOSE_BRACE] || valid[CLOSE_PAREN] ||
  //                          valid[CLOSE_BRACKET];
  //   bool advanced_once = false;
  // ======================================================================
  a.label('entry');
  a.const_(R_ERM, 0);
  a.ifNValid(STRING_CONTENT, 'erm_done');
  a.ifNValid(INDENT, 'erm_done');
  a.const_(R_ERM, 1);
  a.label('erm_done');
  a.const_(R_WB, 0);
  a.ifValid(CLOSE_BRACE, 'wb_set');
  a.ifValid(CLOSE_PAREN, 'wb_set');
  a.ifValid(CLOSE_BRACKET, 'wb_set');
  a.jmp('wb_done');
  a.label('wb_set');
  a.const_(R_WB, 1);
  a.label('wb_done');
  a.const_(R_ADV, 0);

  // ---- escape interpolation ---------------------------------------------
  //   if (valid[ESCAPE_INTERPOLATION] && delimiters.size > 0 &&
  //       (lookahead == '{' || lookahead == '}') && !error_recovery_mode) {
  //     Delimiter *d = array_back(&delimiters);
  //     if (is_format(d)) {
  //       mark_end;
  //       bool is_left_brace = lookahead == '{';
  //       advance; advanced_once = true;
  //       if ((lookahead == '{' && is_left_brace) ||
  //           (lookahead == '}' && !is_left_brace)) {
  //         advance; mark_end; result = ESCAPE_INTERPOLATION; return true;
  //       }
  //       return false;
  //     }
  //   }
  //
  // Both exits of the is_format arm return, so `advanced_once` is provably
  // still false everywhere below. It is carried anyway rather than folded away:
  // being wrong about that would be a silent divergence, and a register costs
  // nothing.
  a.ifNValid(ESCAPE_INTERPOLATION, 'string_content');
  a.len(S_DELIMS, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'string_content');
  a.ifChar(CH('{'), 'ei_maybe');
  a.ifChar(CH('}'), 'ei_maybe');
  a.jmp('string_content');
  a.label('ei_maybe');
  a.ifCmpI('ne', R_ERM, 0, 'string_content');
  a.peek(S_DELIMS, R_DELIM, 0);
  ifNoFlag(F_FORMAT, 'string_content');
  a.markEnd();
  a.const_(R_LB, 0);
  a.ifNChar(CH('{'), 'ei_advance');
  a.const_(R_LB, 1);
  a.label('ei_advance');
  a.advance();
  a.const_(R_ADV, 1);
  a.ifChar(CH('{'), 'ei_left');
  a.ifChar(CH('}'), 'ei_right');
  a.jmp('fail');
  a.label('ei_left');
  a.ifCmpI('ne', R_LB, 0, 'ei_emit');
  a.jmp('fail');
  a.label('ei_right');
  a.ifCmpI('eq', R_LB, 0, 'ei_emit');
  a.jmp('fail');
  a.label('ei_emit');
  a.advance();
  a.markEnd();
  a.emit(ESCAPE_INTERPOLATION);

  // ---- string content ---------------------------------------------------
  //   if (valid[STRING_CONTENT] && delimiters.size > 0 && !error_recovery_mode) {
  //     Delimiter *d = array_back(&delimiters);
  //     int32_t end_char = end_character(d);
  //     bool has_content = advanced_once;
  //     while (lexer->lookahead) {
  a.label('string_content');
  a.ifNValid(STRING_CONTENT, 'indent');
  a.len(S_DELIMS, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'indent');
  a.ifCmpI('ne', R_ERM, 0, 'indent');
  a.peek(S_DELIMS, R_DELIM, 0);
  a.call('end_char');
  a.mov(R_HAS, R_ADV);

  a.label('sc_loop');
  a.ifChar(0, 'indent');
  //       if ((advanced_once || lookahead == '{' || lookahead == '}') &&
  //           is_format(d)) {
  //         mark_end; result = STRING_CONTENT; return has_content;
  //       }
  // `return has_content` sets the symbol and then returns *false* when there is
  // none, which is exactly EMIT_IF.
  ifNoFlag(F_FORMAT, 'sc_backslash');
  a.ifCmpI('ne', R_ADV, 0, 'sc_format');
  a.ifChar(CH('{'), 'sc_format');
  a.ifChar(CH('}'), 'sc_format');
  a.jmp('sc_backslash');
  a.label('sc_format');
  a.markEnd();
  a.emitIf(R_HAS, STRING_CONTENT);

  //       if (lookahead == '\\') {
  a.label('sc_backslash');
  a.ifNChar(0x5c, 'sc_endchar');
  //         if (is_raw(d)) {
  //           advance;                                  // over the backslash
  //           if (lookahead == end_character(d) || lookahead == '\\') advance;
  //           if (lookahead == '\r') { advance; if (lookahead == '\n') advance; }
  //           else if (lookahead == '\n') advance;
  //           continue;
  //         }
  ifNoFlag(F_RAW, 'sc_bytes');
  a.advance();
  a.ifChar(0x5c, 'sc_raw_quote');
  a.lookahead(R_LA);
  a.ifCmp('ne', R_LA, R_END, 'sc_raw_cr');
  a.label('sc_raw_quote');
  a.advance();
  a.label('sc_raw_cr');
  a.ifNChar(0x0d, 'sc_raw_lf');
  a.advance();
  a.ifNChar(0x0a, 'sc_loop');
  a.advance();
  a.jmp('sc_loop');
  a.label('sc_raw_lf');
  a.ifNChar(0x0a, 'sc_loop');
  a.advance();
  a.jmp('sc_loop');

  //         if (is_bytes(d)) {
  //           mark_end; advance;
  //           if (lookahead == 'N' || 'u' || 'U') advance;   // not an escape
  //           else { result = STRING_CONTENT; return has_content; }
  //         } else {
  //           mark_end; result = STRING_CONTENT; return has_content;
  //         }
  //
  // The bytes arm falls out of the whole `if (lookahead == '\\')` block into
  // the loop tail, which advances a *third* time. Deliberate upstream.
  a.label('sc_bytes');
  ifNoFlag(F_BYTES, 'sc_plain_backslash');
  a.markEnd();
  a.advance();
  a.ifChar(CH('N'), 'sc_tail');
  a.ifChar(CH('u'), 'sc_tail');
  a.ifChar(CH('U'), 'sc_tail');
  a.emitIf(R_HAS, STRING_CONTENT);
  a.label('sc_plain_backslash');
  a.markEnd();
  a.emitIf(R_HAS, STRING_CONTENT);

  //       } else if (lookahead == end_char) {
  a.label('sc_endchar');
  a.lookahead(R_LA);
  a.ifCmp('ne', R_LA, R_END, 'sc_newline');
  //         if (is_triple(d)) {
  //           mark_end; advance;
  //           if (lookahead == end_char) {
  //             advance;
  //             if (lookahead == end_char) {
  //               if (has_content) { result = STRING_CONTENT; }
  //               else { advance; mark_end; array_pop(&delimiters);
  //                      result = STRING_END; inside_interpolated_string = false; }
  //               return true;
  //             }
  //             mark_end; result = STRING_CONTENT; return true;
  //           }
  //           mark_end; result = STRING_CONTENT; return true;
  //         }
  ifNoFlag(F_TRIPLE, 'sc_single');
  a.markEnd();
  a.advance();
  a.lookahead(R_LA);
  a.ifCmp('ne', R_LA, R_END, 'sc_triple_short');
  a.advance();
  a.lookahead(R_LA);
  a.ifCmp('ne', R_LA, R_END, 'sc_triple_short');
  a.ifCmpI('ne', R_HAS, 0, 'sc_content_true');
  a.advance();
  a.markEnd();
  a.pop(S_DELIMS, R_TMP);
  a.const_(R_III, 0);
  a.emit(STRING_END);
  a.label('sc_content_true');
  a.emit(STRING_CONTENT);
  // Both inner "not a third quote" exits are the same two lines.
  a.label('sc_triple_short');
  a.markEnd();
  a.emit(STRING_CONTENT);

  //         if (has_content) { result = STRING_CONTENT; }
  //         else { advance; array_pop(&delimiters); result = STRING_END;
  //                inside_interpolated_string = false; }
  //         mark_end;
  //         return true;
  a.label('sc_single');
  a.ifCmpI('ne', R_HAS, 0, 'sc_single_content');
  a.advance();
  a.pop(S_DELIMS, R_TMP);
  a.const_(R_III, 0);
  a.markEnd();
  a.emit(STRING_END);
  a.label('sc_single_content');
  a.markEnd();
  a.emit(STRING_CONTENT);

  //       } else if (lookahead == '\n' && has_content && !is_triple(d)) {
  //         return false;
  //       }
  //       advance; has_content = true;
  //     }
  //   }
  a.label('sc_newline');
  a.ifNChar(0x0a, 'sc_tail');
  a.ifCmpI('eq', R_HAS, 0, 'sc_tail');
  ifFlag(F_TRIPLE, 'sc_tail');
  a.jmp('fail');
  a.label('sc_tail');
  a.advance();
  a.const_(R_HAS, 1);
  a.jmp('sc_loop');

  // ---- the indent scan --------------------------------------------------
  //   lexer->mark_end(lexer);
  //   bool found_end_of_line = false;
  //   uint16_t indent_length = 0;
  //   int32_t first_comment_indent_length = -1;
  //   for (;;) {
  //
  // indent_length is uint16_t, so the two `+=` sites wrap. Masking reproduces
  // that; nothing in any corpus comes near it, and a register is i32.
  a.label('indent');
  a.markEnd();
  a.const_(R_EOL, 0);
  a.const_(R_ILEN, 0);
  a.const_(R_FCI, -1);

  a.label('ind_loop');
  //     if (lookahead == '\n') { found_end_of_line = true; indent_length = 0; skip; }
  a.ifNChar(0x0a, 'ind_space');
  a.const_(R_EOL, 1);
  a.const_(R_ILEN, 0);
  a.skip();
  a.jmp('ind_loop');
  //     else if (lookahead == ' ') { indent_length++; skip; }
  a.label('ind_space');
  a.ifNChar(0x20, 'ind_cr');
  a.alui('add', R_ILEN, 1);
  a.alui('and', R_ILEN, 0xffff);
  a.skip();
  a.jmp('ind_loop');
  //     else if (lookahead == '\r' || lookahead == '\f') { indent_length = 0; skip; }
  a.label('ind_cr');
  a.ifChar(0x0d, 'ind_reset');
  a.ifNChar(0x0c, 'ind_tab');
  a.label('ind_reset');
  a.const_(R_ILEN, 0);
  a.skip();
  a.jmp('ind_loop');
  //     else if (lookahead == '\t') { indent_length += 8; skip; }
  a.label('ind_tab');
  a.ifNChar(0x09, 'ind_hash');
  a.alui('add', R_ILEN, 8);
  a.alui('and', R_ILEN, 0xffff);
  a.skip();
  a.jmp('ind_loop');

  //     else if (lookahead == '#' && (valid[INDENT] || valid[DEDENT] ||
  //                                   valid[NEWLINE] || valid[EXCEPT])) {
  //       if (!found_end_of_line) return false;    // `foo = bar # comment`
  //       if (first_comment_indent_length == -1)
  //         first_comment_indent_length = (int32_t)indent_length;
  //       while (lookahead && lookahead != '\n') skip;
  //       skip;
  //       indent_length = 0;
  //     }
  //
  // A '#' with none of those four valid falls past the '\\' and eof arms to the
  // bare `else break`, which is why the guard jumps to `ind_break` rather than
  // to the next test.
  a.label('ind_hash');
  a.ifNChar(CH('#'), 'ind_backslash');
  a.ifValid(INDENT, 'ind_comment');
  a.ifValid(DEDENT, 'ind_comment');
  a.ifValid(NEWLINE, 'ind_comment');
  a.ifValid(EXCEPT, 'ind_comment');
  a.jmp('ind_break');
  a.label('ind_comment');
  a.ifCmpI('eq', R_EOL, 0, 'fail');
  a.ifCmpI('ne', R_FCI, -1, 'ind_comment_skip');
  a.mov(R_FCI, R_ILEN);
  a.label('ind_comment_skip');
  a.ifChar(0, 'ind_comment_end');
  a.ifChar(0x0a, 'ind_comment_end');
  a.skip();
  a.jmp('ind_comment_skip');
  a.label('ind_comment_end');
  a.skip();
  a.const_(R_ILEN, 0);
  a.jmp('ind_loop');

  //     else if (lookahead == '\\') {
  //       skip;
  //       if (lookahead == '\r') skip;
  //       if (lookahead == '\n' || lexer->eof(lexer)) skip;
  //       else return false;
  //     }
  a.label('ind_backslash');
  a.ifNChar(0x5c, 'ind_eof');
  a.skip();
  a.ifNChar(0x0d, 'ind_bs_nl');
  a.skip();
  a.label('ind_bs_nl');
  a.ifChar(0x0a, 'ind_bs_skip');
  a.ifEof('ind_bs_skip');
  a.jmp('fail');
  a.label('ind_bs_skip');
  a.skip();
  a.jmp('ind_loop');

  //     else if (lexer->eof(lexer)) {
  //       indent_length = 0; found_end_of_line = true; break;
  //     } else break;
  a.label('ind_eof');
  a.ifNEof('ind_break');
  a.const_(R_ILEN, 0);
  a.const_(R_EOL, 1);
  a.label('ind_break');

  // ---- indent / dedent / newline ----------------------------------------
  //   if (found_end_of_line) {
  //     if (scanner->indents.size > 0) {
  //       uint16_t current = *array_back(&scanner->indents);
  //       if (valid[INDENT] && indent_length > current) {
  //         array_push(&indents, indent_length); result = INDENT; return true;
  //       }
  a.ifCmpI('eq', R_EOL, 0, 'string_start');
  a.len(S_INDENTS, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'newline_check');
  a.peek(S_INDENTS, R_CUR, 0);
  a.ifNValid(INDENT, 'dedent');
  a.ifCmp('le', R_ILEN, R_CUR, 'dedent');
  a.push(S_INDENTS, R_ILEN);
  a.emit(INDENT);

  //       bool next_tok_is_string_start =
  //         lookahead == '"' || lookahead == '\'' || lookahead == '`';
  //       if ((valid[DEDENT] ||
  //            (!valid[NEWLINE] && !(valid[STRING_START] && next_tok_is_string_start) &&
  //             !within_brackets)) &&
  //           indent_length < current && !inside_interpolated_string &&
  //           first_comment_indent_length < (int32_t)current) {
  //         array_pop(&indents); result = DEDENT; return true;
  //       }
  //     }
  a.label('dedent');
  a.ifValid(DEDENT, 'de_rest');
  a.ifValid(NEWLINE, 'newline_check');
  a.ifNValid(STRING_START, 'de_brackets');
  a.ifChar(0x22, 'newline_check');
  a.ifChar(0x27, 'newline_check');
  a.ifChar(0x60, 'newline_check');
  a.label('de_brackets');
  a.ifCmpI('ne', R_WB, 0, 'newline_check');
  a.label('de_rest');
  a.ifCmp('ge', R_ILEN, R_CUR, 'newline_check');
  a.ifCmpI('ne', R_III, 0, 'newline_check');
  // The comment guard: wait to dedent until any comment indented at least as
  // far as the current block has been consumed. R_FCI is -1 when there was no
  // comment, which is less than every real indent.
  a.ifCmp('ge', R_FCI, R_CUR, 'newline_check');
  a.pop(S_INDENTS, R_TMP);
  a.emit(DEDENT);

  //     if (valid[NEWLINE] && !error_recovery_mode) { result = NEWLINE; return true; }
  //   }
  a.label('newline_check');
  a.ifNValid(NEWLINE, 'string_start');
  a.ifCmpI('ne', R_ERM, 0, 'string_start');
  a.emit(NEWLINE);

  // ---- string start -----------------------------------------------------
  //   if (first_comment_indent_length == -1 && valid[STRING_START]) {
  //     Delimiter delimiter = new_delimiter();
  //     bool has_flags = false;
  //     while (lexer->lookahead) {
  //       if (lookahead == 'f' || 'F' || 't' || 'T') set_format(&delimiter);
  //       else if (lookahead == 'r' || 'R')          set_raw(&delimiter);
  //       else if (lookahead == 'b' || 'B')          set_bytes(&delimiter);
  //       else if (lookahead != 'u' && lookahead != 'U') break;
  //       has_flags = true;
  //       advance;
  //     }
  //
  // `has_flags` is dropped: upstream's only use is `if (has_flags) return
  // false;` immediately before `return false;`, so both arms are the same exit.
  a.label('string_start');
  a.ifCmpI('ne', R_FCI, -1, 'fail');
  a.ifNValid(STRING_START, 'fail');
  a.const_(R_DELIM, 0);
  a.label('ss_flags');
  a.ifChar(0, 'ss_quote');
  for (const c of 'fFtT') a.ifChar(CH(c), 'ss_format');
  for (const c of 'rR') a.ifChar(CH(c), 'ss_raw');
  for (const c of 'bB') a.ifChar(CH(c), 'ss_bytes');
  for (const c of 'uU') a.ifChar(CH(c), 'ss_next');
  a.jmp('ss_quote');
  a.label('ss_format');
  a.alui('or', R_DELIM, F_FORMAT);
  a.jmp('ss_next');
  a.label('ss_raw');
  a.alui('or', R_DELIM, F_RAW);
  a.jmp('ss_next');
  a.label('ss_bytes');
  a.alui('or', R_DELIM, F_BYTES);
  a.label('ss_next');
  a.advance();
  a.jmp('ss_flags');

  //     if (lookahead == '`')  { set_end_character('`');  advance; mark_end; }
  //     else if (lookahead == '\'') { set_end_character('\''); advance; mark_end;
  //       if (lookahead == '\'') { advance;
  //         if (lookahead == '\'') { advance; mark_end; set_triple(&delimiter); } } }
  //     else if (lookahead == '"') { ... the same with '"' ... }
  a.label('ss_quote');
  a.ifChar(0x60, 'ss_backquote');
  a.ifChar(0x27, 'ss_singlequote');
  a.ifChar(0x22, 'ss_doublequote');
  a.jmp('ss_done');
  a.label('ss_backquote');
  a.alui('or', R_DELIM, F_BQ);
  a.advance();
  a.markEnd();
  a.jmp('ss_done');
  for (const [name, bit, quote] of [
    ['ss_singlequote', F_SQ, 0x27],
    ['ss_doublequote', F_DQ, 0x22],
  ]) {
    a.label(name);
    a.alui('or', R_DELIM, bit);
    a.advance();
    a.markEnd();
    a.ifNChar(quote, 'ss_done');
    a.advance();
    a.ifNChar(quote, 'ss_done');
    a.advance();
    a.markEnd();
    a.alui('or', R_DELIM, F_TRIPLE);
    a.jmp('ss_done');
  }

  //     if (end_character(&delimiter)) {
  //       array_push(&delimiters, delimiter); result = STRING_START;
  //       inside_interpolated_string = is_format(&delimiter);
  //       return true;
  //     }
  //     if (has_flags) return false;
  //   }
  //   return false;
  a.label('ss_done');
  a.mov(R_TMP, R_DELIM);
  a.alui('and', R_TMP, F_ANY_QUOTE);
  a.ifCmpI('eq', R_TMP, 0, 'fail');
  a.push(S_DELIMS, R_DELIM);
  a.const_(R_III, 0);
  ifNoFlag(F_FORMAT, 'ss_emit');
  a.const_(R_III, 1);
  a.label('ss_emit');
  a.emit(STRING_START);

  a.label('fail');
  a.fail();

  // ---- end_character(delimiter) -> R_END --------------------------------
  //   if (flags & SingleQuote) return '\'';
  //   if (flags & DoubleQuote) return '"';
  //   if (flags & BackQuote)   return '`';
  //   return 0;
  a.label('end_char');
  a.const_(R_END, 0);
  ifFlag(F_SQ, 'ec_single');
  ifFlag(F_DQ, 'ec_double');
  ifFlag(F_BQ, 'ec_back');
  a.ret();
  a.label('ec_single');
  a.const_(R_END, 0x27);
  a.ret();
  a.label('ec_double');
  a.const_(R_END, 0x22);
  a.ret();
  a.label('ec_back');
  a.const_(R_END, 0x60);
  a.ret();

  return {
    entry: 0,
    regPersist: 1 << R_III,
    stacks: [{ persist: true }, { persist: true }],
    // `deserialize(NULL, 0)` pushes a 0 before reading anything, and `create`
    // calls it -- so an empty state is one indent of zero, not no indents.
    stackInit: [{ stack: S_INDENTS, values: [0] }],
    classes: [],
    maps: [],
    strings: [],
    validSets: [],
    jumpTable: [],
    code: a.build(),
  };
}

module.exports = { build };
