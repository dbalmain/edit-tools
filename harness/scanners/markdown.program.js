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

  // if (!s->simulate) push_block(s, block)
  const maybePush = (block, skip) => {
    a.ifCmpI('ne', R_SIM, 0, skip);
    a.const_(R_TMP, block);
    a.push(S_BLOCKS, R_TMP);
  };
  // if (!s->simulate) lexer->mark_end(lexer);
  const markEndSim = (skip) => {
    a.ifCmpI('ne', R_SIM, 0, skip);
    a.markEnd();
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
  // Skeleton: the rest of scan is filled in subsequent commits.
  a.jmp('fail');

  a.label('error');
  a.emit(ERROR);

  a.label('fail');
  a.fail();

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
  a.label('match');
  a.const_(R_RET, 0);
  a.ifCmpI('eq', R_BLOCK, BLOCK_QUOTE, 'm_bq');
  a.ifCmpI('eq', R_BLOCK, INDENTED_CODE_BLOCK, 'm_icb');
  a.ifCmpI('ge', R_BLOCK, FENCED_CODE_BLOCK, 'm_true');

  // LIST_ITEM .. LIST_ITEM_MAX_INDENTATION (and any LIST_ITEM+n that still
  // falls below FENCED_CODE_BLOCK).
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
