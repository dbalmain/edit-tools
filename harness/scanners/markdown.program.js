// tree-sitter-markdown 0.5.1's *block* scanner (`tree-sitter-markdown/src/scanner.c`,
// 1602 lines), hand-compiled to scanner-VM bytecode. Upstream source is reproduced
// in comments so the two can be diffed by eye; that is the only review this port
// gets.
//
// The sdist ships a second scanner (`tree-sitter-markdown-inline`, 397 lines).
// `harness/languages/markdown.toml` selects `language()` — the block grammar —
// because fences, info strings and fence content live in the block tree and the
// harness has no included-range second pass. The recorded traces agree: the first
// call in `headings.jsonl` emits `HTML_BLOCK_2_START`. This file is the block
// scanner only.
//
// ## State
//
// Upstream `serialize` writes five `uint8_t` scalars (`state`, `matched`,
// `indentation`, `column`, `fenced_code_block_delimiter_length`) and then
// `memcpy`s `open_blocks`. `sizeof(Block)` is **4**, not 1: a recorded one-block
// state is 9 bytes (`00 00 00 00 00  13 00 00 00` — `ANONYMOUS` as a little-endian
// C enum). The values themselves are small integers (0..19, or
// `LIST_ITEM + extra_indentation`, which can overshoot the named constants). The
// three padding bytes carry no distinctions, so the VM encoding is five persistent
// registers plus one persistent stack of those integers. Relation-compatibility
// with the 4-byte memcpy is the bijection the replay checks, not the bytes.
//
// `simulate` lives on `Scanner` but is not serialized. The C ABI wrapper sets it
// false on every host call; the self-call `scan(s, lexer, paragraph_interrupt_symbols)`
// does not go through the wrapper, so a true set just before `RECURSE` sticks.
// The VM matches that: `R_SIM` is transient (zeroed by `enterScan` on a host
// call) and `RECURSE` re-enters `entry` without `enterScan`. `entry` is therefore
// `scan()` itself and must not write `R_SIM = 0`.
//
// Markdown tracks its own column inside `advance` (tab stop 4) rather than
// calling `lexer->get_column`. Opcode 0x06 is reserved and traps; the port counts
// in `R_COLUMN` the same way. All five scalars are `uint8_t` — arithmetic writes
// mask to 0xff so a wrap upstream merges is a wrap here too.
//
// `list_item_indentation(block)` is `(uint8_t)(block - LIST_ITEM + 2)`, kept
// literal. Folding it to `block` would only hold while `LIST_ITEM == 2`.
'use strict';
const fs = require('fs');
const path = require('path');
const { Asm } = require('../../spike/scanner-vm/asm.js');

const CTYPE = path.join(__dirname, '..', 'ctype', 'wctype.utf8.json');

// Upstream's `enum TokenType`. Order is load-bearing: the parser passes
// `valid_symbols` indexed by it. 47 tokens, 0..46.
const LINE_ENDING = 0;
const SOFT_LINE_ENDING = 1;
const BLOCK_CLOSE = 2;
const BLOCK_CONTINUATION = 3;
const BLOCK_QUOTE_START = 4;
const INDENTED_CHUNK_START = 5;
const ATX_H1_MARKER = 6;
const ATX_H2_MARKER = 7;
const ATX_H3_MARKER = 8;
const ATX_H4_MARKER = 9;
const ATX_H5_MARKER = 10;
const ATX_H6_MARKER = 11;
const SETEXT_H1_UNDERLINE = 12;
const SETEXT_H2_UNDERLINE = 13;
const THEMATIC_BREAK = 14;
const LIST_MARKER_MINUS = 15;
const LIST_MARKER_PLUS = 16;
const LIST_MARKER_STAR = 17;
const LIST_MARKER_PARENTHESIS = 18;
const LIST_MARKER_DOT = 19;
const LIST_MARKER_MINUS_DONT_INTERRUPT = 20;
const LIST_MARKER_PLUS_DONT_INTERRUPT = 21;
const LIST_MARKER_STAR_DONT_INTERRUPT = 22;
const LIST_MARKER_PARENTHESIS_DONT_INTERRUPT = 23;
const LIST_MARKER_DOT_DONT_INTERRUPT = 24;
const FENCED_CODE_BLOCK_START_BACKTICK = 25;
const FENCED_CODE_BLOCK_START_TILDE = 26;
const BLANK_LINE_START = 27;
const FENCED_CODE_BLOCK_END_BACKTICK = 28;
const FENCED_CODE_BLOCK_END_TILDE = 29;
const HTML_BLOCK_1_START = 30;
const HTML_BLOCK_1_END = 31;
const HTML_BLOCK_2_START = 32;
const HTML_BLOCK_3_START = 33;
const HTML_BLOCK_4_START = 34;
const HTML_BLOCK_5_START = 35;
const HTML_BLOCK_6_START = 36;
const HTML_BLOCK_7_START = 37;
const CLOSE_BLOCK = 38;
const NO_INDENTED_CHUNK = 39;
const ERROR = 40;
const TRIGGER_ERROR = 41;
const TOKEN_EOF = 42;
const MINUS_METADATA = 43;
const PLUS_METADATA = 44;
const PIPE_TABLE_START = 45;
const PIPE_TABLE_LINE_ENDING = 46;

// `enum Block`, upstream order. List-item values carry indentation in the
// enumerand: LIST_ITEM is "content begins at indent 2", then +1 per step up to
// LIST_ITEM_MAX_INDENTATION.
const BLOCK_QUOTE = 0;
const INDENTED_CODE_BLOCK = 1;
const LIST_ITEM = 2;
const LIST_ITEM_MAX_INDENTATION = 17;
const FENCED_CODE_BLOCK = 18;
const ANONYMOUS = 19;

// `state` bitflags.
const STATE_MATCHING = 0x1 << 0;
const STATE_WAS_SOFT_LINE_BREAK = 0x1 << 1;
const STATE_CLOSE_BLOCK = 0x1 << 4;

// Class table slots.
const C_ALPHA = 0;                        // iswalpha
const C_ALNUM = 1;                        // iswalnum
const C_DIGIT = 2;                        // isdigit — ASCII '0'..'9', not iswdigit
const C_PUNCT = 3;                        // is_punctuation (markdown spec, ASCII)
const C_AZ = 4;                           // 'A'..'Z' (HTML block 4)
const C_ATTR_START = 5;                   // iswalpha || '_' || ':'
const C_ATTR_CHAR = 6;                    // iswalnum || '_' || '.' || ':' || '-'
const C_NAME_CONT = 7;                    // iswalnum || '-'  (HTML tag name continued)

// Stacks.
const S_BLOCKS = 0;                       // persistent: open_blocks
const S_SAVE = 1;                         // transient: locals across RECURSE

// Persistent registers — the five uint8_t scalars, in serialize order.
const R_STATE = 0;
const R_MATCHED = 1;
const R_IND = 2;
const R_COLUMN = 3;
const R_FENCE = 4;
// Transient.
const R_SIM = 5;                          // simulate; zeroed by enterScan
const R_RET = 6;                          // match / recurse bool
const R_SIZE = 7;                         // advance() return
const R_BLOCK = 8;
const R_LII = 9;                          // list_item_indentation
const R_TMP = 10;
const R_TMP2 = 11;
const R_N = 12;                           // counts: stars, minuses, level, digits, cells
const R_EXTRA = 13;                       // extra_indentation (uint8)
const R_DONT = 14;                        // dont_interrupt
const R_LINE = 15;                        // line_end
const R_OK = 16;                          // success / thematic_break / list_marker_*
const R_A = 17;                           // whitespace_after_minus / starting_slash / starting_pipe / had_ws
const R_B = 18;                           // minus_after_whitespace / tag_closed / ending_pipe / had_one_minus
const R_C = 19;                           // next_symbol_valid / matched_temp / delimiter
const R_D = 20;                           // name_length / one_will_be_matched / delimiter_cell_count
const R_E = 21;                           // partial_success / all_will_be_matched
const R_LA = 22;
const R_SYM = 23;

const CH = (c) => c.codePointAt(0);
const bytes = (s) => Array.from(s, (c) => c.charCodeAt(0));

const HTML_TAG_NAMES_RULE_1 = ['pre', 'script', 'style'];
const HTML_TAG_NAMES_RULE_7 = [
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote',
  'body', 'caption', 'center', 'col', 'colgroup', 'dd',
  'details', 'dialog', 'dir', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame',
  'frameset', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'head', 'header', 'hr', 'html', 'iframe',
  'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p',
  'param', 'section', 'source', 'summary', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'title', 'tr',
  'track', 'ul',
];

// `paragraph_interrupt_symbols`, upstream order. validSets[0] for RECURSE.
const PARAGRAPH_INTERRUPT = [
  false, // LINE_ENDING
  false, // SOFT_LINE_ENDING
  false, // BLOCK_CLOSE
  false, // BLOCK_CONTINUATION
  true,  // BLOCK_QUOTE_START
  false, // INDENTED_CHUNK_START
  true,  // ATX_H1_MARKER
  true,  // ATX_H2_MARKER
  true,  // ATX_H3_MARKER
  true,  // ATX_H4_MARKER
  true,  // ATX_H5_MARKER
  true,  // ATX_H6_MARKER
  true,  // SETEXT_H1_UNDERLINE
  true,  // SETEXT_H2_UNDERLINE
  true,  // THEMATIC_BREAK
  true,  // LIST_MARKER_MINUS
  true,  // LIST_MARKER_PLUS
  true,  // LIST_MARKER_STAR
  true,  // LIST_MARKER_PARENTHESIS
  true,  // LIST_MARKER_DOT
  false, // LIST_MARKER_MINUS_DONT_INTERRUPT
  false, // LIST_MARKER_PLUS_DONT_INTERRUPT
  false, // LIST_MARKER_STAR_DONT_INTERRUPT
  false, // LIST_MARKER_PARENTHESIS_DONT_INTERRUPT
  false, // LIST_MARKER_DOT_DONT_INTERRUPT
  true,  // FENCED_CODE_BLOCK_START_BACKTICK
  true,  // FENCED_CODE_BLOCK_START_TILDE
  true,  // BLANK_LINE_START
  false, // FENCED_CODE_BLOCK_END_BACKTICK
  false, // FENCED_CODE_BLOCK_END_TILDE
  true,  // HTML_BLOCK_1_START
  false, // HTML_BLOCK_1_END
  true,  // HTML_BLOCK_2_START
  true,  // HTML_BLOCK_3_START
  true,  // HTML_BLOCK_4_START
  true,  // HTML_BLOCK_5_START
  true,  // HTML_BLOCK_6_START
  false, // HTML_BLOCK_7_START
  false, // CLOSE_BLOCK
  false, // NO_INDENTED_CHUNK
  false, // ERROR
  false, // TRIGGER_ERROR
  false, // TOKEN_EOF
  false, // MINUS_METADATA
  false, // PLUS_METADATA
  true,  // PIPE_TABLE_START
  false, // PIPE_TABLE_LINE_ENDING
];

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

  const u8 = (r) => { a.alui('and', r, 0xff); };
  const ifFlag = (bit, t) => {
    a.mov(R_TMP, R_STATE);
    a.alui('and', R_TMP, bit);
    a.ifCmpI('ne', R_TMP, 0, t);
  };
  const ifNoFlag = (bit, t) => {
    a.mov(R_TMP, R_STATE);
    a.alui('and', R_TMP, bit);
    a.ifCmpI('eq', R_TMP, 0, t);
  };
  const setFlag = (bit) => { a.alui('or', R_STATE, bit); };
  const clearFlag = (bit) => { a.alui('and', R_STATE, ~bit); };

  // if (!s->simulate) push_block(s, block). `skip` is the fall-through label.
  const maybePush = (block, skip) => {
    a.ifCmpI('ne', R_SIM, 0, skip);
    a.const_(R_TMP, block);
    a.push(S_BLOCKS, R_TMP);
    a.label(skip);
  };
  const maybePushList = (skip) => {
    a.ifCmpI('ne', R_SIM, 0, skip);
    a.mov(R_TMP, R_EXTRA);
    a.alui('add', R_TMP, LIST_ITEM);
    a.push(S_BLOCKS, R_TMP);
    a.label(skip);
  };
  const maybePop = (skip) => {
    a.ifCmpI('ne', R_SIM, 0, skip);
    a.pop(S_BLOCKS, R_TMP);
    a.label(skip);
  };
  // if (!s->simulate) lexer->mark_end(lexer);
  const markEndSim = (skip) => {
    a.ifCmpI('ne', R_SIM, 0, skip);
    a.markEnd();
    a.label(skip);
  };
  const skipSpTab = (loop, after) => {
    a.label(loop);
    a.ifChar(CH(' '), `${loop}_go`);
    a.ifChar(CH('\t'), `${loop}_go`);
    a.jmp(after);
    a.label(`${loop}_go`);
    a.call('advance');
    a.jmp(loop);
  };
  const addIndSpTab = (loop, after) => {
    a.label(loop);
    a.ifChar(CH(' '), `${loop}_go`);
    a.ifChar(CH('\t'), `${loop}_go`);
    a.jmp(after);
    a.label(`${loop}_go`);
    a.call('advance');
    a.alu('add', R_IND, R_SIZE);
    u8(R_IND);
    a.jmp(loop);
  };
  const consumeLine = (loop, after) => {
    a.label(loop);
    a.ifChar(0x0a, after);
    a.ifChar(0x0d, after);
    a.ifEof(after);
    a.call('advance');
    a.jmp(loop);
  };
  // extra_indentation--; then the <=3 vs swap with s->indentation.
  const applyListIndent = (lab) => {
    a.alui('sub', R_EXTRA, 1);
    u8(R_EXTRA);
    a.ifCmpI('gt', R_EXTRA, 3, `${lab}_swap`);
    a.alu('add', R_EXTRA, R_IND);
    u8(R_EXTRA);
    a.const_(R_IND, 0);
    a.jmp(`${lab}_done`);
    a.label(`${lab}_swap`);
    a.mov(R_TMP2, R_IND);
    a.mov(R_IND, R_EXTRA);
    a.mov(R_EXTRA, R_TMP2);
    a.label(`${lab}_done`);
  };
  // dont_interrupt = dont_interrupt && s->matched == s->open_blocks.size
  const andDontEqSize = (skip) => {
    a.len(S_BLOCKS, R_TMP2);
    a.ifCmp('eq', R_MATCHED, R_TMP2, skip);
    a.const_(R_DONT, 0);
    a.label(skip);
  };

  // ======================================================================
  // scan (entry). simulate is NOT cleared here — see the header.
  // ======================================================================
  a.label('entry');

  //   if (valid_symbols[TRIGGER_ERROR]) return error(lexer);
  a.ifValid(TRIGGER_ERROR, 'error');

  //   if (valid_symbols[CLOSE_BLOCK]) {
  //     s->state |= STATE_CLOSE_BLOCK;
  //     lexer->result_symbol = CLOSE_BLOCK;
  //     return true;
  //   }
  a.ifNValid(CLOSE_BLOCK, 'eof_check');
  setFlag(STATE_CLOSE_BLOCK);
  a.emit(CLOSE_BLOCK);

  //   if (lexer->eof(lexer)) {
  //     if (valid_symbols[TOKEN_EOF]) { result = TOKEN_EOF; return true; }
  //     if (s->open_blocks.size > 0) {
  //       lexer->result_symbol = BLOCK_CLOSE;
  //       if (!s->simulate) pop_block(s);
  //       return true;
  //     }
  //     return false;
  //   }
  a.label('eof_check');
  a.ifNEof('not_eof');
  a.ifValid(TOKEN_EOF, 'emit_eof');
  a.len(S_BLOCKS, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'fail');
  a.ifCmpI('ne', R_SIM, 0, 'emit_block_close');
  a.pop(S_BLOCKS, R_TMP);
  a.label('emit_block_close');
  a.emit(BLOCK_CLOSE);

  a.label('emit_eof');
  a.emit(TOKEN_EOF);

  a.label('not_eof');

  //   if (!(s->state & STATE_MATCHING)) {
  ifFlag(STATE_MATCHING, 'sc_matching');

  //     for (;;) {
  //       if (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
  //         s->indentation += advance(s, lexer);
  //       } else break;
  //     }
  addIndSpTab('sc_ws', 'sc_ws_done');
  a.label('sc_ws_done');

  //     if (valid_symbols[INDENTED_CHUNK_START] &&
  //         !valid_symbols[NO_INDENTED_CHUNK]) {
  //       if (s->indentation >= 4 && lexer->lookahead != '\n' &&
  //           lexer->lookahead != '\r') {
  a.ifNValid(INDENTED_CHUNK_START, 'sc_switch');
  a.ifValid(NO_INDENTED_CHUNK, 'sc_switch');
  a.ifCmpI('lt', R_IND, 4, 'sc_switch');
  a.ifChar(0x0a, 'sc_switch');
  a.ifChar(0x0d, 'sc_switch');
  //         lexer->result_symbol = INDENTED_CHUNK_START;
  //         if (!s->simulate) push_block(s, INDENTED_CODE_BLOCK);
  //         s->indentation -= 4;
  //         return true;
  maybePush(INDENTED_CODE_BLOCK, 'sc_ic_pushed');
  a.alui('sub', R_IND, 4);
  u8(R_IND);
  a.emit(INDENTED_CHUNK_START);

  //     switch (lexer->lookahead) {
  a.label('sc_switch');
  a.ifChar(0x0d, 'sc_nl');
  a.ifChar(0x0a, 'sc_nl');
  a.ifChar(CH('`'), 'sc_tick');
  a.ifChar(CH('~'), 'sc_tilde');
  a.ifChar(CH('*'), 'parse_star');
  a.ifChar(CH('_'), 'parse_under');
  a.ifChar(CH('>'), 'parse_bq');
  a.ifChar(CH('#'), 'parse_atx');
  a.ifChar(CH('='), 'parse_setext');
  a.ifChar(CH('+'), 'parse_plus');
  a.ifClass(C_DIGIT, 'parse_ordered');
  a.ifChar(CH('-'), 'parse_minus');
  a.ifChar(CH('<'), 'parse_html');
  a.jmp('sc_after_switch');

  //       case '\r': case '\n':
  //         if (valid_symbols[BLANK_LINE_START]) {
  //           lexer->result_symbol = BLANK_LINE_START;
  //           return true;
  //         }
  //         break;
  a.label('sc_nl');
  a.ifNValid(BLANK_LINE_START, 'sc_after_switch');
  a.emit(BLANK_LINE_START);

  a.label('sc_tick');
  a.const_(R_C, CH('`'));
  a.jmp('parse_fence');
  a.label('sc_tilde');
  a.const_(R_C, CH('~'));
  a.jmp('parse_fence');

  //     if (lexer->lookahead != '\r' && lexer->lookahead != '\n' &&
  //         valid_symbols[PIPE_TABLE_START]) {
  //       return parse_pipe_table(...);
  //     }
  a.label('sc_after_switch');
  a.ifChar(0x0d, 'sc_line_end');
  a.ifChar(0x0a, 'sc_line_end');
  a.ifNValid(PIPE_TABLE_START, 'sc_line_end');
  a.jmp('parse_pipe');
  a.jmp('sc_line_end');

  //   } else { // matching
  a.label('sc_matching');
  //     bool partial_success = false;
  a.const_(R_E, 0);
  //     while (s->matched < (uint8_t)s->open_blocks.size) {
  a.label('sc_m_loop');
  a.len(S_BLOCKS, R_TMP);
  u8(R_TMP);
  a.ifCmp('ge', R_MATCHED, R_TMP, 'sc_m_loop_done');
  //       if (s->matched == (uint8_t)s->open_blocks.size - 1 &&
  //           (s->state & STATE_CLOSE_BLOCK)) {
  a.len(S_BLOCKS, R_TMP);
  u8(R_TMP);
  a.alui('sub', R_TMP, 1);
  a.ifCmp('ne', R_MATCHED, R_TMP, 'sc_m_try');
  ifNoFlag(STATE_CLOSE_BLOCK, 'sc_m_try');
  //         if (!partial_success) s->state &= ~STATE_CLOSE_BLOCK;
  //         break;
  a.ifCmpI('ne', R_E, 0, 'sc_m_loop_done');
  clearFlag(STATE_CLOSE_BLOCK);
  a.jmp('sc_m_loop_done');
  a.label('sc_m_try');
  //       if (match(s, lexer, s->open_blocks.items[s->matched])) {
  a.getidx(S_BLOCKS, R_BLOCK, R_MATCHED);
  a.call('match');
  a.ifCmpI('eq', R_RET, 0, 'sc_m_miss');
  //         partial_success = true;
  //         s->matched++;
  a.const_(R_E, 1);
  a.alui('add', R_MATCHED, 1);
  u8(R_MATCHED);
  a.jmp('sc_m_loop');
  a.label('sc_m_miss');
  //       } else {
  //         if (s->state & STATE_WAS_SOFT_LINE_BREAK) {
  //           s->state &= (~STATE_MATCHING);
  //         }
  //         break;
  //       }
  ifNoFlag(STATE_WAS_SOFT_LINE_BREAK, 'sc_m_loop_done');
  clearFlag(STATE_MATCHING);
  a.label('sc_m_loop_done');
  //     if (partial_success) {
  a.ifCmpI('eq', R_E, 0, 'sc_m_no_partial');
  //       if (s->matched == s->open_blocks.size) {
  //         s->state &= (~STATE_MATCHING);
  //       }
  a.len(S_BLOCKS, R_TMP);
  a.ifCmp('ne', R_MATCHED, R_TMP, 'sc_m_cont');
  clearFlag(STATE_MATCHING);
  a.label('sc_m_cont');
  //       lexer->result_symbol = BLOCK_CONTINUATION;
  //       return true;
  a.emit(BLOCK_CONTINUATION);
  a.label('sc_m_no_partial');
  //     if (!(s->state & STATE_WAS_SOFT_LINE_BREAK)) {
  ifFlag(STATE_WAS_SOFT_LINE_BREAK, 'sc_line_end');
  //       lexer->result_symbol = BLOCK_CLOSE;
  //       pop_block(s);
  //       if (s->matched == s->open_blocks.size) {
  //         s->state &= (~STATE_MATCHING);
  //       }
  //       return true;
  //     }
  a.pop(S_BLOCKS, R_TMP);
  a.len(S_BLOCKS, R_TMP);
  a.ifCmp('ne', R_MATCHED, R_TMP, 'sc_m_close');
  clearFlag(STATE_MATCHING);
  a.label('sc_m_close');
  a.emit(BLOCK_CLOSE);

  //   if ((valid_symbols[LINE_ENDING] || valid_symbols[SOFT_LINE_ENDING] ||
  //        valid_symbols[PIPE_TABLE_LINE_ENDING]) &&
  //       (lexer->lookahead == '\n' || lexer->lookahead == '\r')) {
  a.label('sc_line_end');
  a.ifValid(LINE_ENDING, 'sc_le_nl');
  a.ifValid(SOFT_LINE_ENDING, 'sc_le_nl');
  a.ifNValid(PIPE_TABLE_LINE_ENDING, 'fail');
  a.label('sc_le_nl');
  a.ifChar(0x0a, 'sc_le_go');
  a.ifNChar(0x0d, 'fail');
  a.label('sc_le_go');
  a.call('adv_nl');
  //     s->indentation = 0;
  //     s->column = 0;
  a.const_(R_IND, 0);
  a.const_(R_COLUMN, 0);
  //     if (!(s->state & STATE_CLOSE_BLOCK) &&
  //         (valid_symbols[SOFT_LINE_ENDING] ||
  //          valid_symbols[PIPE_TABLE_LINE_ENDING])) {
  ifFlag(STATE_CLOSE_BLOCK, 'sc_le_hard');
  a.ifValid(SOFT_LINE_ENDING, 'sc_le_softtry');
  a.ifNValid(PIPE_TABLE_LINE_ENDING, 'sc_le_hard');
  a.label('sc_le_softtry');
  //       lexer->mark_end(lexer);   // direct, ignores simulate
  a.markEnd();
  addIndSpTab('sc_le_ws', 'sc_le_ws_done');
  a.label('sc_le_ws_done');
  //       s->simulate = true;
  //       uint8_t matched_temp = s->matched;
  //       s->matched = 0;
  //       bool one_will_be_matched = false;
  a.const_(R_SIM, 1);
  a.mov(R_C, R_MATCHED);
  a.const_(R_MATCHED, 0);
  a.const_(R_D, 0);
  a.label('sc_le_mloop');
  a.len(S_BLOCKS, R_TMP);
  u8(R_TMP);
  a.ifCmp('ge', R_MATCHED, R_TMP, 'sc_le_mloop_done');
  a.getidx(S_BLOCKS, R_BLOCK, R_MATCHED);
  a.call('match');
  a.ifCmpI('eq', R_RET, 0, 'sc_le_mloop_done');
  a.alui('add', R_MATCHED, 1);
  u8(R_MATCHED);
  a.const_(R_D, 1);
  a.jmp('sc_le_mloop');
  a.label('sc_le_mloop_done');
  //       bool all_will_be_matched = s->matched == s->open_blocks.size;
  a.const_(R_E, 0);
  a.len(S_BLOCKS, R_TMP);
  a.ifCmp('ne', R_MATCHED, R_TMP, 'sc_le_all_done');
  a.const_(R_E, 1);
  a.label('sc_le_all_done');
  //       if (!lexer->eof(lexer) &&
  //           !scan(s, lexer, paragraph_interrupt_symbols)) {
  a.ifEof('sc_le_else');
  a.push(S_SAVE, R_C);
  a.push(S_SAVE, R_D);
  a.push(S_SAVE, R_E);
  a.recurse(0, R_RET);
  a.pop(S_SAVE, R_E);
  a.pop(S_SAVE, R_D);
  a.pop(S_SAVE, R_C);
  a.ifCmpI('ne', R_RET, 0, 'sc_le_else');
  //         s->matched = matched_temp;
  //         s->matched = 0;
  //         s->indentation = 0;
  //         s->column = 0;
  a.const_(R_MATCHED, 0);
  a.const_(R_IND, 0);
  a.const_(R_COLUMN, 0);
  //         if (one_will_be_matched) s->state |= STATE_MATCHING;
  //         else s->state &= (~STATE_MATCHING);
  a.ifCmpI('eq', R_D, 0, 'sc_le_nomatch');
  setFlag(STATE_MATCHING);
  a.jmp('sc_le_matchset');
  a.label('sc_le_nomatch');
  clearFlag(STATE_MATCHING);
  a.label('sc_le_matchset');
  //         if (valid_symbols[PIPE_TABLE_LINE_ENDING]) {
  //           if (all_will_be_matched) {
  //             lexer->result_symbol = PIPE_TABLE_LINE_ENDING;
  //             return true;
  //           }
  //         } else {
  //           lexer->result_symbol = SOFT_LINE_ENDING;
  //           s->state |= STATE_WAS_SOFT_LINE_BREAK;
  //           return true;
  //         }
  a.ifNValid(PIPE_TABLE_LINE_ENDING, 'sc_le_soft');
  a.ifCmpI('eq', R_E, 0, 'sc_le_hard');
  a.emit(PIPE_TABLE_LINE_ENDING);
  a.label('sc_le_soft');
  setFlag(STATE_WAS_SOFT_LINE_BREAK);
  a.emit(SOFT_LINE_ENDING);
  a.label('sc_le_else');
  //       } else {
  //         s->matched = matched_temp;
  //       }
  a.mov(R_MATCHED, R_C);
  //       s->indentation = 0;
  //       s->column = 0;
  a.const_(R_IND, 0);
  a.const_(R_COLUMN, 0);

  a.label('sc_le_hard');
  //     if (valid_symbols[LINE_ENDING]) {
  a.ifNValid(LINE_ENDING, 'fail');
  //       s->matched = 0;
  a.const_(R_MATCHED, 0);
  //       if (s->open_blocks.size > 0) s->state |= STATE_MATCHING;
  //       else s->state &= (~STATE_MATCHING);
  a.len(S_BLOCKS, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'sc_le_hard_nomatch');
  setFlag(STATE_MATCHING);
  a.jmp('sc_le_hard_matchset');
  a.label('sc_le_hard_nomatch');
  clearFlag(STATE_MATCHING);
  a.label('sc_le_hard_matchset');
  //       s->state &= (~STATE_WAS_SOFT_LINE_BREAK);
  //       lexer->result_symbol = LINE_ENDING;
  //       return true;
  clearFlag(STATE_WAS_SOFT_LINE_BREAK);
  a.emit(LINE_ENDING);

  a.label('error');
  a.emit(ERROR);

  a.label('fail');
  a.fail();

  // ======================================================================
  // parse_fenced_code_block(s, delimiter, ...)  — delimiter in R_C
  // ======================================================================
  a.label('parse_fence');
  //   uint8_t level = 0;
  //   while (lexer->lookahead == delimiter) { advance; level++; }
  a.const_(R_N, 0);
  a.label('pf_count');
  a.lookahead(R_LA);
  a.ifCmp('ne', R_LA, R_C, 'pf_counted');
  a.call('advance');
  a.alui('add', R_N, 1);
  u8(R_N);
  a.jmp('pf_count');
  a.label('pf_counted');
  markEndSim('pf_marked');
  //   if ((delimiter == '`' ? valid[END_BACKTICK] : valid[END_TILDE]) &&
  //       s->indentation < 4 && level >= s->fenced_code_block_delimiter_length)
  a.ifCmpI('eq', R_C, CH('`'), 'pf_end_tick');
  a.ifNValid(FENCED_CODE_BLOCK_END_TILDE, 'pf_start');
  a.jmp('pf_end_okv');
  a.label('pf_end_tick');
  a.ifNValid(FENCED_CODE_BLOCK_END_BACKTICK, 'pf_start');
  a.label('pf_end_okv');
  a.ifCmpI('ge', R_IND, 4, 'pf_start');
  a.ifCmp('lt', R_N, R_FENCE, 'pf_start');
  skipSpTab('pf_end_ws', 'pf_end_nl');
  a.label('pf_end_nl');
  a.ifChar(0x0a, 'pf_end_yes');
  a.ifChar(0x0d, 'pf_end_yes');
  a.jmp('pf_start');
  a.label('pf_end_yes');
  a.const_(R_FENCE, 0);
  a.ifCmpI('eq', R_C, CH('`'), 'pf_end_bt');
  a.emit(FENCED_CODE_BLOCK_END_TILDE);
  a.label('pf_end_bt');
  a.emit(FENCED_CODE_BLOCK_END_BACKTICK);

  //   if ((delimiter == '`' ? valid[START_BACKTICK] : valid[START_TILDE]) &&
  //       level >= 3)
  a.label('pf_start');
  a.ifCmpI('eq', R_C, CH('`'), 'pf_st_tick');
  a.ifNValid(FENCED_CODE_BLOCK_START_TILDE, 'fail');
  a.jmp('pf_st_okv');
  a.label('pf_st_tick');
  a.ifNValid(FENCED_CODE_BLOCK_START_BACKTICK, 'fail');
  a.label('pf_st_okv');
  a.ifCmpI('lt', R_N, 3, 'fail');
  //     bool info_string_has_backtick = false;
  //     if (delimiter == '`') {
  //       while (la != '\n' && la != '\r' && !eof) {
  //         if (la == '`') { info_string_has_backtick = true; break; }
  //         advance;
  //       }
  //     }
  a.const_(R_OK, 0);
  a.ifCmpI('ne', R_C, CH('`'), 'pf_st_emit');
  a.label('pf_info');
  a.ifChar(0x0a, 'pf_st_emit');
  a.ifChar(0x0d, 'pf_st_emit');
  a.ifEof('pf_st_emit');
  a.ifChar(CH('`'), 'pf_info_bt');
  a.call('advance');
  a.jmp('pf_info');
  a.label('pf_info_bt');
  a.const_(R_OK, 1);
  a.label('pf_st_emit');
  a.ifCmpI('ne', R_OK, 0, 'fail');
  maybePush(FENCED_CODE_BLOCK, 'pf_st_pushed');
  a.mov(R_FENCE, R_N);
  a.const_(R_IND, 0);
  a.ifCmpI('eq', R_C, CH('`'), 'pf_st_bt');
  a.emit(FENCED_CODE_BLOCK_START_TILDE);
  a.label('pf_st_bt');
  a.emit(FENCED_CODE_BLOCK_START_BACKTICK);

  // ======================================================================
  // parse_star
  // ======================================================================
  a.label('parse_star');
  a.call('advance');
  markEndSim('ps_marked');
  //   size_t star_count = 1;
  //   uint8_t extra_indentation = 0;
  a.const_(R_N, 1);
  a.const_(R_EXTRA, 0);
  a.label('ps_loop');
  a.ifChar(CH('*'), 'ps_star');
  a.ifChar(CH(' '), 'ps_sp');
  a.ifChar(CH('\t'), 'ps_sp');
  a.jmp('ps_loop_done');
  a.label('ps_star');
  //     if (star_count == 1 && extra_indentation >= 1 && valid[LIST_MARKER_STAR])
  //       mark_end;
  a.ifCmpI('ne', R_N, 1, 'ps_star_adv');
  a.ifCmpI('lt', R_EXTRA, 1, 'ps_star_adv');
  a.ifNValid(LIST_MARKER_STAR, 'ps_star_adv');
  markEndSim('ps_star_marked');
  a.label('ps_star_adv');
  a.alui('add', R_N, 1);
  a.call('advance');
  a.jmp('ps_loop');
  a.label('ps_sp');
  a.ifCmpI('ne', R_N, 1, 'ps_sp_other');
  a.call('advance');
  a.alu('add', R_EXTRA, R_SIZE);
  u8(R_EXTRA);
  a.jmp('ps_loop');
  a.label('ps_sp_other');
  a.call('advance');
  a.jmp('ps_loop');
  a.label('ps_loop_done');
  //   bool line_end = lookahead == '\n' || lookahead == '\r';
  a.const_(R_LINE, 0);
  a.ifChar(0x0a, 'ps_is_nl');
  a.ifNChar(0x0d, 'ps_nl_done');
  a.label('ps_is_nl');
  a.const_(R_LINE, 1);
  a.label('ps_nl_done');
  a.const_(R_DONT, 0);
  //   if (star_count == 1 && line_end) {
  //     extra_indentation = 1;
  //     dont_interrupt = s->matched == s->open_blocks.size;
  //   }
  a.ifCmpI('ne', R_N, 1, 'ps_flags');
  a.ifCmpI('eq', R_LINE, 0, 'ps_flags');
  a.const_(R_EXTRA, 1);
  a.const_(R_DONT, 1);
  andDontEqSize('ps_dont');
  a.label('ps_flags');
  //   bool thematic_break = star_count >= 3 && line_end;
  //   bool list_marker_star = star_count >= 1 && extra_indentation >= 1;
  a.ifNValid(THEMATIC_BREAK, 'ps_list');
  a.ifCmpI('lt', R_N, 3, 'ps_list');
  a.ifCmpI('eq', R_LINE, 0, 'ps_list');
  a.ifCmpI('ge', R_IND, 4, 'ps_list');
  markEndSim('ps_th_marked');
  a.const_(R_IND, 0);
  a.emit(THEMATIC_BREAK);
  a.label('ps_list');
  //   if ((dont_interrupt ? valid[LIST_MARKER_STAR_DONT_INTERRUPT]
  //                       : valid[LIST_MARKER_STAR]) && list_marker_star)
  a.ifCmpI('lt', R_N, 1, 'fail');
  a.ifCmpI('lt', R_EXTRA, 1, 'fail');
  a.ifCmpI('eq', R_DONT, 0, 'ps_list_int');
  a.ifNValid(LIST_MARKER_STAR_DONT_INTERRUPT, 'fail');
  a.jmp('ps_list_go');
  a.label('ps_list_int');
  a.ifNValid(LIST_MARKER_STAR, 'fail');
  a.label('ps_list_go');
  a.ifCmpI('ne', R_N, 1, 'ps_list_indent');
  markEndSim('ps_list_marked');
  a.label('ps_list_indent');
  applyListIndent('ps_li');
  maybePushList('ps_list_pushed');
  a.ifCmpI('eq', R_DONT, 0, 'ps_list_em');
  a.emit(LIST_MARKER_STAR_DONT_INTERRUPT);
  a.label('ps_list_em');
  a.emit(LIST_MARKER_STAR);

  // ======================================================================
  // parse_thematic_break_underscore
  // ======================================================================
  a.label('parse_under');
  a.call('advance');
  markEndSim('pu_marked');
  a.const_(R_N, 1);
  a.label('pu_loop');
  a.ifChar(CH('_'), 'pu_us');
  a.ifChar(CH(' '), 'pu_sp');
  a.ifChar(CH('\t'), 'pu_sp');
  a.jmp('pu_done');
  a.label('pu_us');
  a.alui('add', R_N, 1);
  a.call('advance');
  a.jmp('pu_loop');
  a.label('pu_sp');
  a.call('advance');
  a.jmp('pu_loop');
  a.label('pu_done');
  a.ifCmpI('lt', R_N, 3, 'fail');
  a.ifChar(0x0a, 'pu_nl');
  a.ifNChar(0x0d, 'fail');
  a.label('pu_nl');
  a.ifNValid(THEMATIC_BREAK, 'fail');
  markEndSim('pu_end');
  a.const_(R_IND, 0);
  a.emit(THEMATIC_BREAK);

  // ======================================================================
  // parse_block_quote
  // ======================================================================
  a.label('parse_bq');
  a.ifNValid(BLOCK_QUOTE_START, 'fail');
  a.call('advance');
  a.const_(R_IND, 0);
  a.ifChar(CH(' '), 'pb_sp');
  a.ifNChar(CH('\t'), 'pb_emit');
  a.label('pb_sp');
  a.call('advance');
  a.alui('sub', R_SIZE, 1);
  a.alu('add', R_IND, R_SIZE);
  u8(R_IND);
  a.label('pb_emit');
  maybePush(BLOCK_QUOTE, 'pb_pushed');
  a.emit(BLOCK_QUOTE_START);

  // ======================================================================
  // parse_atx_heading
  // ======================================================================
  a.label('parse_atx');
  a.ifNValid(ATX_H1_MARKER, 'fail');
  a.ifCmpI('gt', R_IND, 3, 'fail');
  markEndSim('pa_marked');
  a.const_(R_N, 0);
  a.label('pa_loop');
  a.ifNChar(CH('#'), 'pa_counted');
  a.ifCmpI('gt', R_N, 6, 'pa_counted');
  a.call('advance');
  a.alui('add', R_N, 1);
  a.jmp('pa_loop');
  a.label('pa_counted');
  a.ifCmpI('gt', R_N, 6, 'fail');
  a.ifCmpI('eq', R_N, 0, 'fail');
  a.ifChar(CH(' '), 'pa_ok');
  a.ifChar(CH('\t'), 'pa_ok');
  a.ifChar(0x0a, 'pa_ok');
  a.ifNChar(0x0d, 'fail');
  a.label('pa_ok');
  a.mov(R_SYM, R_N);
  a.alui('add', R_SYM, ATX_H1_MARKER - 1);
  a.const_(R_IND, 0);
  markEndSim('pa_end');
  a.emitR(R_SYM);

  // ======================================================================
  // parse_setext_underline  (equals / SETEXT_H1)
  // ======================================================================
  a.label('parse_setext');
  a.ifNValid(SETEXT_H1_UNDERLINE, 'fail');
  a.len(S_BLOCKS, R_TMP);
  a.ifCmp('ne', R_MATCHED, R_TMP, 'fail');
  markEndSim('pe_marked');
  a.label('pe_eq');
  a.ifNChar(CH('='), 'pe_ws');
  a.call('advance');
  a.jmp('pe_eq');
  a.label('pe_ws');
  a.ifChar(CH(' '), 'pe_sp');
  a.ifChar(CH('\t'), 'pe_sp');
  a.jmp('pe_nl');
  a.label('pe_sp');
  a.call('advance');
  a.jmp('pe_ws');
  a.label('pe_nl');
  a.ifChar(0x0a, 'pe_ok');
  a.ifNChar(0x0d, 'fail');
  a.label('pe_ok');
  markEndSim('pe_end');
  a.emit(SETEXT_H1_UNDERLINE);

  // ======================================================================
  // parse_plus
  // ======================================================================
  a.label('parse_plus');
  a.ifCmpI('gt', R_IND, 3, 'fail');
  a.ifValid(LIST_MARKER_PLUS, 'pp_go');
  a.ifValid(LIST_MARKER_PLUS_DONT_INTERRUPT, 'pp_go');
  a.ifNValid(PLUS_METADATA, 'fail');
  a.label('pp_go');
  a.call('advance');
  a.ifNValid(PLUS_METADATA, 'pp_list');
  a.ifNChar(CH('+'), 'pp_list');
  // metadata: we have '+' and PLUS_METADATA valid
  a.call('advance');
  a.ifNChar(CH('+'), 'fail');
  a.call('advance');
  skipSpTab('pp_meta_ws', 'pp_meta_nl');
  a.label('pp_meta_nl');
  a.ifChar(0x0a, 'pp_meta_loop');
  a.ifNChar(0x0d, 'fail');
  a.label('pp_meta_loop');
  a.call('adv_nl');
  a.const_(R_N, 0);
  a.label('pp_meta_plus');
  a.ifNChar(CH('+'), 'pp_meta_check');
  a.alui('add', R_N, 1);
  a.call('advance');
  a.jmp('pp_meta_plus');
  a.label('pp_meta_check');
  a.ifCmpI('ne', R_N, 3, 'pp_meta_rest');
  skipSpTab('pp_meta_ws2', 'pp_meta_nl2');
  a.label('pp_meta_nl2');
  a.ifChar(0x0a, 'pp_meta_yes');
  a.ifNChar(0x0d, 'pp_meta_rest');
  a.label('pp_meta_yes');
  a.call('adv_nl');
  markEndSim('pp_meta_end');
  a.emit(PLUS_METADATA);
  a.label('pp_meta_rest');
  consumeLine('pp_meta_line', 'pp_meta_eof');
  a.label('pp_meta_eof');
  a.ifEof('fail');
  a.jmp('pp_meta_loop');

  a.label('pp_list');
  a.const_(R_EXTRA, 0);
  a.label('pp_list_ws');
  a.ifChar(CH(' '), 'pp_list_sp');
  a.ifChar(CH('\t'), 'pp_list_sp');
  a.jmp('pp_list_after');
  a.label('pp_list_sp');
  a.call('advance');
  a.alu('add', R_EXTRA, R_SIZE);
  u8(R_EXTRA);
  a.jmp('pp_list_ws');
  a.label('pp_list_after');
  a.const_(R_DONT, 0);
  a.ifChar(0x0d, 'pp_list_nl');
  a.ifNChar(0x0a, 'pp_list_dont');
  a.label('pp_list_nl');
  a.const_(R_EXTRA, 1);
  a.const_(R_DONT, 1);
  a.label('pp_list_dont');
  andDontEqSize('pp_list_and');
  a.ifCmpI('lt', R_EXTRA, 1, 'fail');
  a.ifCmpI('eq', R_DONT, 0, 'pp_list_int');
  a.ifNValid(LIST_MARKER_PLUS_DONT_INTERRUPT, 'fail');
  a.jmp('pp_list_go2');
  a.label('pp_list_int');
  a.ifNValid(LIST_MARKER_PLUS, 'fail');
  a.label('pp_list_go2');
  applyListIndent('pp_li');
  maybePushList('pp_list_pushed');
  a.ifCmpI('eq', R_DONT, 0, 'pp_list_em');
  a.emit(LIST_MARKER_PLUS_DONT_INTERRUPT);
  a.label('pp_list_em');
  a.emit(LIST_MARKER_PLUS);

  // ======================================================================
  // parse_ordered_list_marker
  // ======================================================================
  a.label('parse_ordered');
  a.ifCmpI('gt', R_IND, 3, 'fail');
  a.ifValid(LIST_MARKER_PARENTHESIS, 'po_go');
  a.ifValid(LIST_MARKER_DOT, 'po_go');
  a.ifValid(LIST_MARKER_PARENTHESIS_DONT_INTERRUPT, 'po_go');
  a.ifNValid(LIST_MARKER_DOT_DONT_INTERRUPT, 'fail');
  a.label('po_go');
  //   size_t digits = 1;
  //   bool dont_interrupt = lexer->lookahead != '1';
  a.const_(R_N, 1);
  a.const_(R_DONT, 1);
  a.ifNChar(CH('1'), 'po_adv');
  a.const_(R_DONT, 0);
  a.label('po_adv');
  a.call('advance');
  a.label('po_digits');
  a.ifNClass(C_DIGIT, 'po_after_d');
  a.const_(R_DONT, 1);
  a.alui('add', R_N, 1);
  a.call('advance');
  a.jmp('po_digits');
  a.label('po_after_d');
  a.ifCmpI('lt', R_N, 1, 'fail');
  a.ifCmpI('gt', R_N, 9, 'fail');
  a.const_(R_OK, 0); // 1 = dot, 2 = paren
  a.ifChar(CH('.'), 'po_dot');
  a.ifNChar(CH(')'), 'fail');
  a.call('advance');
  a.const_(R_OK, 2);
  a.jmp('po_mark');
  a.label('po_dot');
  a.call('advance');
  a.const_(R_OK, 1);
  a.label('po_mark');
  a.const_(R_EXTRA, 0);
  a.label('po_ws');
  a.ifChar(CH(' '), 'po_sp');
  a.ifChar(CH('\t'), 'po_sp');
  a.jmp('po_after_ws');
  a.label('po_sp');
  a.call('advance');
  a.alu('add', R_EXTRA, R_SIZE);
  u8(R_EXTRA);
  a.jmp('po_ws');
  a.label('po_after_ws');
  a.ifChar(0x0a, 'po_nl');
  a.ifNChar(0x0d, 'po_dont');
  a.label('po_nl');
  a.const_(R_EXTRA, 1);
  a.const_(R_DONT, 1);
  a.label('po_dont');
  andDontEqSize('po_and');
  a.ifCmpI('lt', R_EXTRA, 1, 'fail');
  //   if (dot ? (dont ? DOT_DONT : DOT) : (dont ? PAREN_DONT : PAREN))
  a.ifCmpI('eq', R_OK, 1, 'po_dotv');
  a.ifCmpI('eq', R_DONT, 0, 'po_par_int');
  a.ifNValid(LIST_MARKER_PARENTHESIS_DONT_INTERRUPT, 'fail');
  a.jmp('po_ok');
  a.label('po_par_int');
  a.ifNValid(LIST_MARKER_PARENTHESIS, 'fail');
  a.jmp('po_ok');
  a.label('po_dotv');
  a.ifCmpI('eq', R_DONT, 0, 'po_dot_int');
  a.ifNValid(LIST_MARKER_DOT_DONT_INTERRUPT, 'fail');
  a.jmp('po_ok');
  a.label('po_dot_int');
  a.ifNValid(LIST_MARKER_DOT, 'fail');
  a.label('po_ok');
  // result_symbol = dot ? LIST_MARKER_DOT : LIST_MARKER_PARENTHESIS
  // NOTE: C always emits DOT or PAREN, never the DONT_INTERRUPT variants!
  applyListIndent('po_li');
  a.ifCmpI('ne', R_SIM, 0, 'po_pushed');
  a.mov(R_TMP, R_EXTRA);
  a.alui('add', R_TMP, LIST_ITEM);
  a.alu('add', R_TMP, R_N);
  a.push(S_BLOCKS, R_TMP);
  a.label('po_pushed');
  a.ifCmpI('eq', R_OK, 1, 'po_em_dot');
  a.emit(LIST_MARKER_PARENTHESIS);
  a.label('po_em_dot');
  a.emit(LIST_MARKER_DOT);

  // ======================================================================
  // parse_minus
  // ======================================================================
  a.label('parse_minus');
  a.ifCmpI('gt', R_IND, 3, 'fail');
  a.ifValid(LIST_MARKER_MINUS, 'pm_go');
  a.ifValid(LIST_MARKER_MINUS_DONT_INTERRUPT, 'pm_go');
  a.ifValid(SETEXT_H2_UNDERLINE, 'pm_go');
  a.ifValid(THEMATIC_BREAK, 'pm_go');
  a.ifNValid(MINUS_METADATA, 'fail');
  a.label('pm_go');
  markEndSim('pm_marked');
  a.const_(R_A, 0); // whitespace_after_minus
  a.const_(R_B, 0); // minus_after_whitespace
  a.const_(R_N, 0); // minus_count
  a.const_(R_EXTRA, 0);
  a.label('pm_loop');
  a.ifChar(CH('-'), 'pm_minus');
  a.ifChar(CH(' '), 'pm_sp');
  a.ifChar(CH('\t'), 'pm_sp');
  a.jmp('pm_loop_done');
  a.label('pm_minus');
  a.ifCmpI('ne', R_N, 1, 'pm_minus_adv');
  a.ifCmpI('lt', R_EXTRA, 1, 'pm_minus_adv');
  markEndSim('pm_minus_marked');
  a.label('pm_minus_adv');
  a.alui('add', R_N, 1);
  a.call('advance');
  a.mov(R_B, R_A);
  a.jmp('pm_loop');
  a.label('pm_sp');
  a.ifCmpI('ne', R_N, 1, 'pm_sp_other');
  a.call('advance');
  a.alu('add', R_EXTRA, R_SIZE);
  u8(R_EXTRA);
  a.const_(R_A, 1);
  a.jmp('pm_loop');
  a.label('pm_sp_other');
  a.call('advance');
  a.const_(R_A, 1);
  a.jmp('pm_loop');
  a.label('pm_loop_done');
  a.const_(R_LINE, 0);
  a.ifChar(0x0a, 'pm_is_nl');
  a.ifNChar(0x0d, 'pm_nl_done');
  a.label('pm_is_nl');
  a.const_(R_LINE, 1);
  a.label('pm_nl_done');
  a.const_(R_DONT, 0);
  a.ifCmpI('ne', R_N, 1, 'pm_dont');
  a.ifCmpI('eq', R_LINE, 0, 'pm_dont');
  a.const_(R_EXTRA, 1);
  a.const_(R_DONT, 1);
  a.label('pm_dont');
  andDontEqSize('pm_and');
  // success = false
  a.const_(R_OK, 0);
  // if (valid[SETEXT_H2_UNDERLINE] && underline)
  // underline = minus_count >= 1 && !minus_after_whitespace && line_end
  //             && matched == size
  a.ifNValid(SETEXT_H2_UNDERLINE, 'pm_th');
  a.ifCmpI('lt', R_N, 1, 'pm_th');
  a.ifCmpI('ne', R_B, 0, 'pm_th');
  a.ifCmpI('eq', R_LINE, 0, 'pm_th');
  a.len(S_BLOCKS, R_TMP2);
  a.ifCmp('ne', R_MATCHED, R_TMP2, 'pm_th');
  a.const_(R_SYM, SETEXT_H2_UNDERLINE);
  markEndSim('pm_ul_end');
  a.const_(R_IND, 0);
  a.const_(R_OK, 1);
  a.jmp('pm_after_list');
  a.label('pm_th');
  a.ifNValid(THEMATIC_BREAK, 'pm_list');
  a.ifCmpI('lt', R_N, 3, 'pm_list');
  a.ifCmpI('eq', R_LINE, 0, 'pm_list');
  a.const_(R_SYM, THEMATIC_BREAK);
  markEndSim('pm_th_end');
  a.const_(R_IND, 0);
  a.const_(R_OK, 1);
  a.jmp('pm_after_list');
  a.label('pm_list');
  a.ifCmpI('lt', R_N, 1, 'pm_after_list');
  a.ifCmpI('lt', R_EXTRA, 1, 'pm_after_list');
  a.ifCmpI('eq', R_DONT, 0, 'pm_list_int');
  a.ifNValid(LIST_MARKER_MINUS_DONT_INTERRUPT, 'pm_after_list');
  a.jmp('pm_list_go');
  a.label('pm_list_int');
  a.ifNValid(LIST_MARKER_MINUS, 'pm_after_list');
  a.label('pm_list_go');
  a.ifCmpI('ne', R_N, 1, 'pm_list_ind');
  markEndSim('pm_list_marked');
  a.label('pm_list_ind');
  applyListIndent('pm_li');
  maybePushList('pm_list_pushed');
  a.ifCmpI('eq', R_DONT, 0, 'pm_list_em');
  a.emit(LIST_MARKER_MINUS_DONT_INTERRUPT);
  a.label('pm_list_em');
  a.emit(LIST_MARKER_MINUS);

  a.label('pm_after_list');
  // if (minus_count == 3 && !minus_after_whitespace && line_end && valid[MINUS_METADATA])
  a.ifCmpI('ne', R_N, 3, 'pm_success');
  a.ifCmpI('ne', R_B, 0, 'pm_success');
  a.ifCmpI('eq', R_LINE, 0, 'pm_success');
  a.ifNValid(MINUS_METADATA, 'pm_success');
  a.label('pm_meta_loop');
  a.call('adv_nl');
  a.const_(R_N, 0);
  a.label('pm_meta_minus');
  a.ifNChar(CH('-'), 'pm_meta_check');
  a.alui('add', R_N, 1);
  a.call('advance');
  a.jmp('pm_meta_minus');
  a.label('pm_meta_check');
  a.ifCmpI('ne', R_N, 3, 'pm_meta_rest');
  skipSpTab('pm_meta_ws', 'pm_meta_nl');
  a.label('pm_meta_nl');
  a.ifChar(0x0a, 'pm_meta_yes');
  a.ifNChar(0x0d, 'pm_meta_rest');
  a.label('pm_meta_yes');
  a.call('adv_nl');
  markEndSim('pm_meta_end');
  a.emit(MINUS_METADATA);
  a.label('pm_meta_rest');
  consumeLine('pm_meta_line', 'pm_meta_eof');
  a.label('pm_meta_eof');
  a.ifEof('pm_success');
  a.jmp('pm_meta_loop');

  a.label('pm_success');
  a.ifCmpI('eq', R_OK, 0, 'fail');
  a.emitR(R_SYM);

  // ======================================================================
  // parse_html_block
  // ======================================================================
  a.label('parse_html');
  a.ifValid(HTML_BLOCK_1_START, 'ph_go');
  a.ifValid(HTML_BLOCK_1_END, 'ph_go');
  a.ifValid(HTML_BLOCK_2_START, 'ph_go');
  a.ifValid(HTML_BLOCK_3_START, 'ph_go');
  a.ifValid(HTML_BLOCK_4_START, 'ph_go');
  a.ifValid(HTML_BLOCK_5_START, 'ph_go');
  a.ifValid(HTML_BLOCK_6_START, 'ph_go');
  a.ifNValid(HTML_BLOCK_7_START, 'fail');
  a.label('ph_go');
  a.call('advance');
  //   if (lookahead == '?' && valid[HTML_BLOCK_3_START])
  a.ifNChar(CH('?'), 'ph_bang');
  a.ifNValid(HTML_BLOCK_3_START, 'ph_bang');
  a.call('advance');
  maybePush(ANONYMOUS, 'ph_b3');
  a.emit(HTML_BLOCK_3_START);

  a.label('ph_bang');
  a.ifNChar(CH('!'), 'ph_slash');
  a.call('advance');
  a.ifChar(CH('-'), 'ph_bang_dash');
  a.ifClass(C_AZ, 'ph_bang_az');
  a.ifChar(CH('['), 'ph_cdata');
  a.jmp('ph_slash');
  a.label('ph_bang_dash');
  a.call('advance');
  a.ifNChar(CH('-'), 'ph_slash');
  a.ifNValid(HTML_BLOCK_2_START, 'ph_slash');
  a.call('advance');
  maybePush(ANONYMOUS, 'ph_b2');
  a.emit(HTML_BLOCK_2_START);
  a.label('ph_bang_az');
  a.ifNValid(HTML_BLOCK_4_START, 'ph_slash');
  a.call('advance');
  maybePush(ANONYMOUS, 'ph_b4');
  a.emit(HTML_BLOCK_4_START);
  a.label('ph_cdata');
  a.call('advance');
  a.ifNChar(CH('C'), 'ph_slash');
  a.call('advance');
  a.ifNChar(CH('D'), 'ph_slash');
  a.call('advance');
  a.ifNChar(CH('A'), 'ph_slash');
  a.call('advance');
  a.ifNChar(CH('T'), 'ph_slash');
  a.call('advance');
  a.ifNChar(CH('A'), 'ph_slash');
  a.call('advance');
  a.ifNChar(CH('['), 'ph_slash');
  a.ifNValid(HTML_BLOCK_5_START, 'ph_slash');
  a.call('advance');
  maybePush(ANONYMOUS, 'ph_b5');
  a.emit(HTML_BLOCK_5_START);

  a.label('ph_slash');
  a.const_(R_A, 0); // starting_slash
  a.ifNChar(CH('/'), 'ph_name');
  a.call('advance');
  a.const_(R_A, 1);
  a.label('ph_name');
  a.bufClr();
  a.const_(R_D, 0); // name_length
  a.label('ph_name_loop');
  a.ifNClass(C_ALPHA, 'ph_name_done');
  a.ifCmpI('ge', R_D, 10, 'ph_name_long');
  a.lookahead(R_LA);
  a.ifCmpI('lt', R_LA, CH('A'), 'ph_name_push');
  a.ifCmpI('gt', R_LA, CH('Z'), 'ph_name_push');
  a.alui('add', R_LA, 32);
  a.label('ph_name_push');
  a.bufPush(R_LA);
  a.alui('add', R_D, 1);
  a.call('advance');
  a.jmp('ph_name_loop');
  a.label('ph_name_long');
  a.const_(R_D, 12);
  a.call('advance');
  a.jmp('ph_name_loop');
  a.label('ph_name_done');
  a.ifCmpI('eq', R_D, 0, 'fail');
  a.const_(R_B, 0); // tag_closed
  a.ifCmpI('ge', R_D, 11, 'ph_b7');
  // next_symbol_valid
  a.const_(R_C, 0);
  a.ifChar(CH(' '), 'ph_nsv');
  a.ifChar(CH('\t'), 'ph_nsv');
  a.ifChar(0x0a, 'ph_nsv');
  a.ifChar(0x0d, 'ph_nsv');
  a.ifNChar(CH('>'), 'ph_nsv_done');
  a.label('ph_nsv');
  a.const_(R_C, 1);
  a.label('ph_nsv_done');
  a.ifCmpI('eq', R_C, 0, 'ph_slashgt');
  // rule 1 names
  a.ifBufEq(0, 'ph_r1_hit');
  a.ifBufEq(1, 'ph_r1_hit');
  a.ifBufEq(2, 'ph_r1_hit');
  a.jmp('ph_slashgt');
  a.label('ph_r1_hit');
  a.ifCmpI('ne', R_A, 0, 'ph_r1_end');
  a.ifNValid(HTML_BLOCK_1_START, 'ph_slashgt');
  maybePush(ANONYMOUS, 'ph_r1s');
  a.emit(HTML_BLOCK_1_START);
  a.label('ph_r1_end');
  a.ifNValid(HTML_BLOCK_1_END, 'ph_slashgt');
  a.emit(HTML_BLOCK_1_END);

  a.label('ph_slashgt');
  a.ifCmpI('ne', R_C, 0, 'ph_r7');
  a.ifNChar(CH('/'), 'ph_r7');
  a.call('advance');
  a.ifNChar(CH('>'), 'ph_r7');
  a.call('advance');
  a.const_(R_B, 1);
  a.label('ph_r7');
  a.ifCmpI('ne', R_C, 0, 'ph_r7_try');
  a.ifCmpI('eq', R_B, 0, 'ph_b7');
  a.label('ph_r7_try');
  for (let i = 0; i < HTML_TAG_NAMES_RULE_7.length; i++) {
    a.ifBufEq(HTML_TAG_NAMES_RULE_1.length + i, 'ph_r7_hit');
  }
  a.jmp('ph_b7');
  a.label('ph_r7_hit');
  a.ifNValid(HTML_BLOCK_6_START, 'ph_b7');
  maybePush(ANONYMOUS, 'ph_r7s');
  a.emit(HTML_BLOCK_6_START);

  a.label('ph_b7');
  a.ifNValid(HTML_BLOCK_7_START, 'fail');
  a.ifCmpI('ne', R_B, 0, 'ph_b7_trail');
  // tag name (continued)
  a.label('ph_b7_name');
  a.ifNClass(C_NAME_CONT, 'ph_b7_after_name');
  a.call('advance');
  a.jmp('ph_b7_name');
  a.label('ph_b7_after_name');
  a.ifCmpI('ne', R_A, 0, 'ph_b7_close_ws');
  // attributes
  a.const_(R_A, 0); // had_whitespace
  a.label('ph_attr');
  a.label('ph_attr_ws');
  a.ifChar(CH(' '), 'ph_attr_sp');
  a.ifChar(CH('\t'), 'ph_attr_sp');
  a.jmp('ph_attr_body');
  a.label('ph_attr_sp');
  a.const_(R_A, 1);
  a.call('advance');
  a.jmp('ph_attr_ws');
  a.label('ph_attr_body');
  a.ifChar(CH('/'), 'ph_attr_slash');
  a.ifChar(CH('>'), 'ph_b7_gt');
  a.ifCmpI('eq', R_A, 0, 'fail');
  a.ifClass(C_ATTR_START, 'ph_attr_name');
  a.jmp('fail');
  a.label('ph_attr_name');
  a.const_(R_A, 0);
  a.call('advance');
  a.label('ph_attr_namec');
  a.ifNClass(C_ATTR_CHAR, 'ph_attr_val');
  a.call('advance');
  a.jmp('ph_attr_namec');
  a.label('ph_attr_val');
  a.label('ph_attr_valws');
  a.ifChar(CH(' '), 'ph_attr_valsp');
  a.ifChar(CH('\t'), 'ph_attr_valsp');
  a.jmp('ph_attr_eq');
  a.label('ph_attr_valsp');
  a.const_(R_A, 1);
  a.call('advance');
  a.jmp('ph_attr_valws');
  a.label('ph_attr_eq');
  a.ifNChar(CH('='), 'ph_attr');
  a.call('advance');
  a.const_(R_A, 0);
  skipSpTab('ph_attr_eqws', 'ph_attr_eqafter');
  a.label('ph_attr_eqafter');
  a.ifChar(CH("'"), 'ph_attr_q');
  a.ifChar(CH('"'), 'ph_attr_q');
  a.jmp('ph_attr_unq');
  a.label('ph_attr_q');
  a.lookahead(R_C);
  a.call('advance');
  a.label('ph_attr_qloop');
  a.lookahead(R_LA);
  a.ifCmp('eq', R_LA, R_C, 'ph_attr_qend');
  a.ifChar(0x0a, 'fail');
  a.ifChar(0x0d, 'fail');
  a.ifEof('fail');
  a.call('advance');
  a.jmp('ph_attr_qloop');
  a.label('ph_attr_qend');
  a.call('advance');
  a.jmp('ph_attr');
  a.label('ph_attr_unq');
  a.const_(R_OK, 0);
  a.label('ph_attr_unqloop');
  a.ifChar(CH(' '), 'ph_attr_unqdone');
  a.ifChar(CH('\t'), 'ph_attr_unqdone');
  a.ifChar(CH('"'), 'ph_attr_unqdone');
  a.ifChar(CH("'"), 'ph_attr_unqdone');
  a.ifChar(CH('='), 'ph_attr_unqdone');
  a.ifChar(CH('<'), 'ph_attr_unqdone');
  a.ifChar(CH('>'), 'ph_attr_unqdone');
  a.ifChar(CH('`'), 'ph_attr_unqdone');
  a.ifChar(0x0a, 'ph_attr_unqdone');
  a.ifChar(0x0d, 'ph_attr_unqdone');
  a.ifEof('ph_attr_unqdone');
  a.call('advance');
  a.const_(R_OK, 1);
  a.jmp('ph_attr_unqloop');
  a.label('ph_attr_unqdone');
  a.ifCmpI('eq', R_OK, 0, 'fail');
  a.jmp('ph_attr');
  a.label('ph_attr_slash');
  a.call('advance');
  a.jmp('ph_b7_gt');

  a.label('ph_b7_close_ws');
  skipSpTab('ph_b7_cws', 'ph_b7_gt');

  a.label('ph_b7_gt');
  a.ifNChar(CH('>'), 'fail');
  a.call('advance');
  a.label('ph_b7_trail');
  skipSpTab('ph_b7_tws', 'ph_b7_nl');
  a.label('ph_b7_nl');
  a.ifChar(0x0d, 'ph_b7_yes');
  a.ifNChar(0x0a, 'fail');
  a.label('ph_b7_yes');
  maybePush(ANONYMOUS, 'ph_b7s');
  a.emit(HTML_BLOCK_7_START);

  // ======================================================================
  // parse_pipe_table
  // ======================================================================
  a.label('parse_pipe');
  markEndSim('pt_marked');
  a.const_(R_N, 0); // cell_count
  a.const_(R_A, 0); // starting_pipe
  a.const_(R_B, 0); // ending_pipe
  a.ifNChar(CH('|'), 'pt_cells');
  a.const_(R_A, 1);
  a.call('advance');
  a.label('pt_cells');
  a.ifChar(0x0d, 'pt_cells_done');
  a.ifChar(0x0a, 'pt_cells_done');
  a.ifEof('pt_cells_done');
  a.ifChar(CH('|'), 'pt_pipe');
  a.ifChar(CH(' '), 'pt_notpipe');
  a.ifChar(CH('\t'), 'pt_notpipe');
  a.const_(R_B, 0);
  a.jmp('pt_esc');
  a.label('pt_notpipe');
  // space/tab: ending_pipe unchanged
  a.jmp('pt_esc');
  a.label('pt_pipe');
  a.alui('add', R_N, 1);
  a.const_(R_B, 1);
  a.call('advance');
  a.jmp('pt_cells');
  a.label('pt_esc');
  a.ifNChar(CH('\\'), 'pt_adv');
  a.call('advance');
  a.ifNClass(C_PUNCT, 'pt_cells');
  a.call('advance');
  a.jmp('pt_cells');
  a.label('pt_adv');
  a.call('advance');
  a.jmp('pt_cells');
  a.label('pt_cells_done');
  // empty is never cleared; condition is cell_count == 0 && !(starting && ending)
  a.ifCmpI('ne', R_N, 0, 'pt_endpipe');
  a.ifCmpI('eq', R_A, 0, 'fail');
  a.ifCmpI('eq', R_B, 0, 'fail');
  a.label('pt_endpipe');
  a.ifCmpI('ne', R_B, 0, 'pt_nl');
  a.alui('add', R_N, 1);
  a.label('pt_nl');
  a.ifChar(0x0a, 'pt_nl_lf');
  a.ifNChar(0x0d, 'fail');
  a.call('advance');
  a.ifNChar(0x0a, 'pt_after_nl');
  a.label('pt_nl_lf');
  a.call('advance');
  a.label('pt_after_nl');
  a.const_(R_IND, 0);
  a.const_(R_COLUMN, 0);
  addIndSpTab('pt_ind', 'pt_ind_done');
  a.label('pt_ind_done');
  a.const_(R_SIM, 1);
  a.const_(R_C, 0); // matched_temp
  a.label('pt_mloop');
  a.len(S_BLOCKS, R_TMP);
  u8(R_TMP);
  a.ifCmp('ge', R_C, R_TMP, 'pt_mdone');
  a.getidx(S_BLOCKS, R_BLOCK, R_C);
  a.call('match');
  a.ifCmpI('eq', R_RET, 0, 'fail');
  a.alui('add', R_C, 1);
  u8(R_C);
  a.jmp('pt_mloop');
  a.label('pt_mdone');
  a.const_(R_D, 0); // delimiter_cell_count
  a.ifNChar(CH('|'), 'pt_dloop');
  a.call('advance');
  a.label('pt_dloop');
  skipSpTab('pt_dws', 'pt_dws_done');
  a.label('pt_dws_done');
  a.ifChar(CH('|'), 'pt_dpipe');
  a.jmp('pt_dcolon');
  a.label('pt_dpipe');
  a.alui('add', R_D, 1);
  a.call('advance');
  a.jmp('pt_dloop');
  a.label('pt_dcolon');
  a.ifNChar(CH(':'), 'pt_dminus');
  a.call('advance');
  a.ifNChar(CH('-'), 'fail');
  a.label('pt_dminus');
  a.const_(R_OK, 0); // had_one_minus
  a.label('pt_dminus_loop');
  a.ifNChar(CH('-'), 'pt_dminus_done');
  a.const_(R_OK, 1);
  a.call('advance');
  a.jmp('pt_dminus_loop');
  a.label('pt_dminus_done');
  a.ifCmpI('eq', R_OK, 0, 'pt_dcolon2');
  a.alui('add', R_D, 1);
  a.label('pt_dcolon2');
  a.ifNChar(CH(':'), 'pt_dws2');
  a.ifCmpI('eq', R_OK, 0, 'fail');
  a.call('advance');
  a.label('pt_dws2');
  skipSpTab('pt_dws2l', 'pt_dws2_done');
  a.label('pt_dws2_done');
  a.ifChar(CH('|'), 'pt_dpipe2');
  a.ifChar(0x0d, 'pt_dcheck');
  a.ifChar(0x0a, 'pt_dcheck');
  a.jmp('fail');
  a.label('pt_dpipe2');
  a.ifCmpI('ne', R_OK, 0, 'pt_dpipe2_adv');
  a.alui('add', R_D, 1);
  a.label('pt_dpipe2_adv');
  a.call('advance');
  a.jmp('pt_dloop');
  a.label('pt_dcheck');
  a.ifCmp('ne', R_N, R_D, 'fail');
  a.emit(PIPE_TABLE_START);

  // ======================================================================
  //   static size_t advance(Scanner *s, TSLexer *lexer)
  //     size_t size = 1;
  //     if (lexer->lookahead == '\t') { size = 4 - s->column; s->column = 0; }
  //     else { s->column = (s->column + 1) % 4; }
  //     lexer->advance(lexer, false);
  //     return size;
  // ======================================================================
  a.label('advance');
  a.const_(R_SIZE, 1);
  a.ifNChar(0x09, 'adv_notab');
  a.const_(R_SIZE, 4);
  a.alu('sub', R_SIZE, R_COLUMN);
  a.const_(R_COLUMN, 0);
  a.jmp('adv_done');
  a.label('adv_notab');
  a.alui('add', R_COLUMN, 1);
  a.alui('mod', R_COLUMN, 4);
  a.label('adv_done');
  a.advance();
  a.ret();

  // ======================================================================
  //   static bool match(Scanner *s, TSLexer *lexer, Block block)
  // R_BLOCK is the block; R_RET is the result.
  // list_item_indentation is (block - LIST_ITEM + 2), written out rather than
  // folded to `block` — the identity only holds because LIST_ITEM happens to
  // be 2.
  // ======================================================================
  a.label('adv_nl');
  a.ifChar(0x0d, 'adv_nl_cr');
  a.call('advance');
  a.ret();
  a.label('adv_nl_cr');
  a.call('advance');
  a.ifNChar(0x0a, 'adv_nl_ret');
  a.call('advance');
  a.label('adv_nl_ret');
  a.ret();

  a.label('match');
  a.const_(R_RET, 0);
  a.ifCmpI('eq', R_BLOCK, BLOCK_QUOTE, 'm_bq');
  a.ifCmpI('eq', R_BLOCK, INDENTED_CODE_BLOCK, 'm_icb');
  // FENCED_CODE_BLOCK and ANONYMOUS only — not every value >= 18. A
  // LIST_ITEM + extra_indentation that overshoots the named constants falls
  // out of the switch and returns false.
  a.ifCmpI('eq', R_BLOCK, FENCED_CODE_BLOCK, 'm_true');
  a.ifCmpI('eq', R_BLOCK, ANONYMOUS, 'm_true');
  a.ifCmpI('lt', R_BLOCK, LIST_ITEM, 'm_ret');
  a.ifCmpI('gt', R_BLOCK, LIST_ITEM_MAX_INDENTATION, 'm_ret');

  // LIST_ITEM .. LIST_ITEM_MAX_INDENTATION.
  a.mov(R_LII, R_BLOCK);
  a.alui('sub', R_LII, LIST_ITEM);
  a.alui('add', R_LII, 2);
  u8(R_LII);
  a.label('m_li_loop');
  a.ifCmp('ge', R_IND, R_LII, 'm_li_done');
  a.ifChar(CH(' '), 'm_li_sp');
  a.ifChar(CH('\t'), 'm_li_sp');
  a.jmp('m_li_done');
  a.label('m_li_sp');
  a.call('advance');
  a.alu('add', R_IND, R_SIZE);
  u8(R_IND);
  a.jmp('m_li_loop');
  a.label('m_li_done');
  a.ifCmp('lt', R_IND, R_LII, 'm_li_nl');
  a.alu('sub', R_IND, R_LII);
  u8(R_IND);
  a.jmp('m_true');
  a.label('m_li_nl');
  a.ifChar(0x0a, 'm_li_zero');
  a.ifNChar(0x0d, 'm_ret');
  a.label('m_li_zero');
  a.const_(R_IND, 0);
  a.jmp('m_true');

  a.label('m_icb');
  a.label('m_icb_loop');
  a.ifCmpI('ge', R_IND, 4, 'm_icb_done');
  a.ifChar(CH(' '), 'm_icb_sp');
  a.ifChar(CH('\t'), 'm_icb_sp');
  a.jmp('m_icb_done');
  a.label('m_icb_sp');
  a.call('advance');
  a.alu('add', R_IND, R_SIZE);
  u8(R_IND);
  a.jmp('m_icb_loop');
  a.label('m_icb_done');
  a.ifCmpI('lt', R_IND, 4, 'm_ret');
  a.ifChar(0x0a, 'm_ret');
  a.ifChar(0x0d, 'm_ret');
  a.alui('sub', R_IND, 4);
  u8(R_IND);
  a.jmp('m_true');

  a.label('m_bq');
  a.label('m_bq_ws');
  a.ifChar(CH(' '), 'm_bq_sp');
  a.ifChar(CH('\t'), 'm_bq_sp');
  a.jmp('m_bq_gt');
  a.label('m_bq_sp');
  a.call('advance');
  a.alu('add', R_IND, R_SIZE);
  u8(R_IND);
  a.jmp('m_bq_ws');
  a.label('m_bq_gt');
  a.ifNChar(CH('>'), 'm_ret');
  a.call('advance');
  a.const_(R_IND, 0);
  a.ifChar(CH(' '), 'm_bq_after');
  a.ifNChar(CH('\t'), 'm_true');
  a.label('m_bq_after');
  a.call('advance');
  a.alui('sub', R_SIZE, 1);
  a.alu('add', R_IND, R_SIZE);
  u8(R_IND);

  a.label('m_true');
  a.const_(R_RET, 1);
  a.label('m_ret');
  a.ret();

  return {
    entry: 0,
    regPersist: (1 << R_STATE) | (1 << R_MATCHED) | (1 << R_IND) | (1 << R_COLUMN) | (1 << R_FENCE),
    stacks: [{ persist: true }, { persist: false }],
    stackInit: [],
    classes: [
      ctype.alpha,
      ctype.alnum,
      [CH('0'), CH('9')],
      // is_punctuation: '!'..'/'  ':'..'@'  '['..'`'  '{'..'~'
      [CH('!'), CH('/'), CH(':'), CH('@'), CH('['), CH('`'), CH('{'), CH('~')],
      [CH('A'), CH('Z')],
      union(ctype.alpha, one('_'), one(':')),
      union(ctype.alnum, one('_'), one('.'), one(':'), one('-')),
      union(ctype.alnum, one('-')),
    ],
    maps: [],
    strings: HTML_TAG_NAMES_RULE_1.concat(HTML_TAG_NAMES_RULE_7).map(bytes),
    validSets: [PARAGRAPH_INTERRUPT],
    jumpTable: [],
    code: a.build(),
  };
}

module.exports = { build };
