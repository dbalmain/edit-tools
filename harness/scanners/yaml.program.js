// tree-sitter-yaml 0.7.2's scanner, hand-compiled to scanner-VM bytecode.
// Upstream source is reproduced in comments so the two can be diffed by eye;
// that is the only review this port gets.
//
// yaml is the largest stateful scanner in the roster: five signed i16 scalars
// and two parallel i16 stacks, plus a 44-state schema machine in
// `schema.core.c` that classifies plain scalars. The VM has no `get_column`
// (opcode 0x06 traps); yaml never calls it anyway -- it counts row/col in
// `adv`/`skp`/`adv_nwl`/`skp_nwl`, and the port does the same in registers.
// Getting that count wrong is invisible to a tree comparison and visible to
// the replay's state bijection, which is why the trace exists.
//
// State encoding. Upstream serializes row, col, blk_imp_row, blk_imp_col,
// blk_imp_tab as i16, then `ind_typ_stk` and `ind_len_stk` from index 1
// (skipping the bottom). `deserialize` re-seeds those bottoms as IND_ROT and
// -1 before reading. That is python's sentinel: the bottom exists, is defined
// not to matter, and belongs in `stackInit`.
//
// The two `blk_imp_*` scalars initialise to -1, not 0. The VM zeros
// persistent registers on reset and has no `registerInit`, so a faithful
// five-register layout would collapse the empty state onto
// (row=0,col=0,imp_row=0,imp_col=0), which is a reachable distinct state --
// `MAY_UPD_IMP_COL` at the start of a file writes exactly that. Those two
// therefore live as single-element persistent stacks seeded by `stackInit`
// to [-1]; the other three scalars are persistent registers (init 0 is
// correct). Working copies of the two stacks are loaded at entry and written
// back on every halt, because `MAY_UPD_IMP_COL` mutates them even when the
// scan later returns false.
//
// yaml does not call libc `isw*`. Every classifier is a closed set of
// code points from the YAML spec, carried as `classes` intervals -- not from
// `wctype.utf8.json`.
//
// HAS_TIMESTAMP is 0 in schema.core.c, so SGL_PLN_SYM has no RS_TIMESTAMP
// arm; the TMS tokens still exist in the enum (load-bearing order) and are
// never produced.
//
// int16_t wraparound: cur_row/cur_col increment as i16 upstream and as i32
// here. Deepest recorded state is row 52 / col 150; wrap at 32767 is not
// reachable on this corpus. A 32k-column line would distinguish us from
// upstream. Noted, not faked.
'use strict';
const { Asm } = require('../../spike/scanner-vm/asm.js');

// Upstream's `enum TokenType`. Order is load-bearing -- valid_symbols is
// indexed by it. Generated from the enum in scanner.c; 113 tokens, last is
// ERR_REC = 112.
const END_OF_FILE = 0;
const S_DIR_YML_BGN = 1;
const R_DIR_YML_VER = 2;
const S_DIR_TAG_BGN = 3;
const R_DIR_TAG_HDL = 4;
const R_DIR_TAG_PFX = 5;
const S_DIR_RSV_BGN = 6;
const R_DIR_RSV_PRM = 7;
const S_DRS_END = 8;
const S_DOC_END = 9;
const R_BLK_SEQ_BGN = 10;
const BR_BLK_SEQ_BGN = 11;
const B_BLK_SEQ_BGN = 12;
const R_BLK_KEY_BGN = 13;
const BR_BLK_KEY_BGN = 14;
const B_BLK_KEY_BGN = 15;
const R_BLK_VAL_BGN = 16;
const BR_BLK_VAL_BGN = 17;
const B_BLK_VAL_BGN = 18;
const R_BLK_IMP_BGN = 19;
const R_BLK_LIT_BGN = 20;
const BR_BLK_LIT_BGN = 21;
const R_BLK_FLD_BGN = 22;
const BR_BLK_FLD_BGN = 23;
const BR_BLK_STR_CTN = 24;
const R_FLW_SEQ_BGN = 25;
const BR_FLW_SEQ_BGN = 26;
const B_FLW_SEQ_BGN = 27;
const R_FLW_SEQ_END = 28;
const BR_FLW_SEQ_END = 29;
const B_FLW_SEQ_END = 30;
const R_FLW_MAP_BGN = 31;
const BR_FLW_MAP_BGN = 32;
const B_FLW_MAP_BGN = 33;
const R_FLW_MAP_END = 34;
const BR_FLW_MAP_END = 35;
const B_FLW_MAP_END = 36;
const R_FLW_SEP_BGN = 37;
const BR_FLW_SEP_BGN = 38;
const R_FLW_KEY_BGN = 39;
const BR_FLW_KEY_BGN = 40;
const R_FLW_JSV_BGN = 41;
const BR_FLW_JSV_BGN = 42;
const R_FLW_NJV_BGN = 43;
const BR_FLW_NJV_BGN = 44;
const R_DQT_STR_BGN = 45;
const BR_DQT_STR_BGN = 46;
const B_DQT_STR_BGN = 47;
const R_DQT_STR_CTN = 48;
const BR_DQT_STR_CTN = 49;
const R_DQT_ESC_NWL = 50;
const BR_DQT_ESC_NWL = 51;
const R_DQT_ESC_SEQ = 52;
const BR_DQT_ESC_SEQ = 53;
const R_DQT_STR_END = 54;
const BR_DQT_STR_END = 55;
const R_SQT_STR_BGN = 56;
const BR_SQT_STR_BGN = 57;
const B_SQT_STR_BGN = 58;
const R_SQT_STR_CTN = 59;
const BR_SQT_STR_CTN = 60;
const R_SQT_ESC_SQT = 61;
const BR_SQT_ESC_SQT = 62;
const R_SQT_STR_END = 63;
const BR_SQT_STR_END = 64;
const R_SGL_PLN_NUL_BLK = 65;
const BR_SGL_PLN_NUL_BLK = 66;
const B_SGL_PLN_NUL_BLK = 67;
const R_SGL_PLN_NUL_FLW = 68;
const BR_SGL_PLN_NUL_FLW = 69;
const R_SGL_PLN_BOL_BLK = 70;
const BR_SGL_PLN_BOL_BLK = 71;
const B_SGL_PLN_BOL_BLK = 72;
const R_SGL_PLN_BOL_FLW = 73;
const BR_SGL_PLN_BOL_FLW = 74;
const R_SGL_PLN_INT_BLK = 75;
const BR_SGL_PLN_INT_BLK = 76;
const B_SGL_PLN_INT_BLK = 77;
const R_SGL_PLN_INT_FLW = 78;
const BR_SGL_PLN_INT_FLW = 79;
const R_SGL_PLN_FLT_BLK = 80;
const BR_SGL_PLN_FLT_BLK = 81;
const B_SGL_PLN_FLT_BLK = 82;
const R_SGL_PLN_FLT_FLW = 83;
const BR_SGL_PLN_FLT_FLW = 84;
const R_SGL_PLN_TMS_BLK = 85;
const BR_SGL_PLN_TMS_BLK = 86;
const B_SGL_PLN_TMS_BLK = 87;
const R_SGL_PLN_TMS_FLW = 88;
const BR_SGL_PLN_TMS_FLW = 89;
const R_SGL_PLN_STR_BLK = 90;
const BR_SGL_PLN_STR_BLK = 91;
const B_SGL_PLN_STR_BLK = 92;
const R_SGL_PLN_STR_FLW = 93;
const BR_SGL_PLN_STR_FLW = 94;
const R_MTL_PLN_STR_BLK = 95;
const BR_MTL_PLN_STR_BLK = 96;
const R_MTL_PLN_STR_FLW = 97;
const BR_MTL_PLN_STR_FLW = 98;
const R_TAG = 99;
const BR_TAG = 100;
const B_TAG = 101;
const R_ACR_BGN = 102;
const BR_ACR_BGN = 103;
const B_ACR_BGN = 104;
const R_ACR_CTN = 105;
const R_ALS_BGN = 106;
const BR_ALS_BGN = 107;
const B_ALS_BGN = 108;
const R_ALS_CTN = 109;
const BL = 110;
const COMMENT = 111;
const ERR_REC = 112;
if (ERR_REC !== 112) throw new Error(`TokenType last is ${ERR_REC}, want 112`);

const SCN_SUCC = 1;
const SCN_STOP = 0;
const SCN_FAIL = -1;

const IND_ROT = 0x72;                     // 'r'
const IND_MAP = 0x6d;                     // 'm'
const IND_SEQ = 0x71;                     // 'q'
const IND_STR = 0x73;                     // 's'

const SCH_STT_FRZ = -1;
const RS_STR = 0;
const RS_INT = 1;
const RS_NULL = 2;
const RS_BOOL = 3;
const RS_FLOAT = 4;

// Stacks. 0/1 are the indent pair (sentinel bottoms). 2/3 hold the two
// blk_imp scalars that initialise to -1 -- see the header.
const S_TYP = 0;
const S_LEN = 1;
const S_IMP_ROW = 2;
const S_IMP_COL = 3;

// Persistent registers: row, col, blk_imp_tab. The other two scalars are
// stacks; R_BLK_IMP_ROW / R_BLK_IMP_COL are working copies.
const R_ROW = 0;
const R_COL = 1;
const R_BLK_IMP_TAB = 2;
const R_BLK_IMP_ROW = 3;
const R_BLK_IMP_COL = 4;
const R_END_ROW = 5;
const R_END_COL = 6;
const R_CUR_ROW = 7;
const R_CUR_COL = 8;
const R_CUR_CHR = 9;
const R_SCH_STT = 10;
const R_RLT_SCH = 11;
const R_CUR_IND = 12;
const R_PRT_IND = 13;
const R_CUR_IND_TYP = 14;
const R_HAS_TAB = 15;
const R_LEAD_SP = 16;
const R_BGN_ROW = 17;
const R_BGN_COL = 18;
const R_BGN_CHR = 19;
const R_IS_R = 20;
const R_IS_BR = 21;
const R_IS_B = 22;
const R_IS_S = 23;
const R_TMP = 24;
const R_TMP2 = 25;
const R_RET = 26;
const R_SYM = 27;
const R_CH = 28;
const R_FN = 29;
const R_N = 30;
const R_ALLOW = 31;

const C_WSP = 0;
const C_NWL = 1;
const C_WHT = 2;
const C_DEC = 3;
const C_HEX = 4;
const C_WORD = 5;
const C_NB_JSON = 6;
const C_NB_DOUBLE = 7;
const C_NB_SINGLE = 8;
const C_NS_CHAR = 9;
const C_INDICATOR = 10;
const C_FLOW = 11;
const C_PLAIN_FLOW = 12;                  // ns_char minus flow indicators; also is_ns_anchor_char
const C_URI = 13;
const C_TAG = 14;
const C_NS_ANCHOR = 12;

const JT_PLAIN_BLK = 0;
const JT_PLAIN_FLW = 1;

const CH = (c) => c.codePointAt(0);

function build() {
  const a = new Asm();
  let lid = 0;
  const L = (p) => `${p}_${lid++}`;

  const adv = () => {
    a.alui('add', R_CUR_COL, 1);
    a.lookahead(R_CUR_CHR);
    a.advance();
  };
  const skp = () => {
    a.alui('add', R_CUR_COL, 1);
    a.lookahead(R_CUR_CHR);
    a.skip();
  };
  const advNwl = () => {
    a.alui('add', R_CUR_ROW, 1);
    a.const_(R_CUR_COL, 0);
    a.lookahead(R_CUR_CHR);
    a.advance();
  };
  const skpNwl = () => {
    a.alui('add', R_CUR_ROW, 1);
    a.const_(R_CUR_COL, 0);
    a.lookahead(R_CUR_CHR);
    a.skip();
  };
  const mrkEnd = () => {
    a.mov(R_END_ROW, R_CUR_ROW);
    a.mov(R_END_COL, R_CUR_COL);
    a.markEnd();
  };
  const writeImp = () => {
    a.settop(S_IMP_ROW, R_BLK_IMP_ROW);
    a.settop(S_IMP_COL, R_BLK_IMP_COL);
  };
  const retSym = (sym) => {
    a.mov(R_ROW, R_END_ROW);
    a.mov(R_COL, R_END_COL);
    writeImp();
    a.emit(sym);
  };
  const retSymR = () => {
    a.mov(R_ROW, R_END_ROW);
    a.mov(R_COL, R_END_COL);
    writeImp();
    a.emitR(R_SYM);
  };
  const failScan = () => {
    writeImp();
    a.fail();
  };

  // ======================================================================
  //   init(scanner);
  //   mrk_end(scanner, lexer);
  // ======================================================================
  a.label('entry');
  a.peek(S_IMP_ROW, R_BLK_IMP_ROW, 0);
  a.peek(S_IMP_COL, R_BLK_IMP_COL, 0);
  a.mov(R_CUR_ROW, R_ROW);
  a.mov(R_CUR_COL, R_COL);
  a.const_(R_CUR_CHR, 0);
  a.const_(R_SCH_STT, 0);
  a.const_(R_RLT_SCH, RS_STR);
  mrkEnd();

  //   bool allow_comment = !(valid_symbols[R_DQT_STR_CTN] || valid_symbols[BR_DQT_STR_CTN] ||
  //                          valid_symbols[R_SQT_STR_CTN] || valid_symbols[BR_SQT_STR_CTN]);
  a.const_(R_ALLOW, 1);
  a.ifValid(R_DQT_STR_CTN, 'no_comment');
  a.ifValid(BR_DQT_STR_CTN, 'no_comment');
  a.ifValid(R_SQT_STR_CTN, 'no_comment');
  a.ifValid(BR_SQT_STR_CTN, 'no_comment');
  a.jmp('allow_done');
  a.label('no_comment');
  a.const_(R_ALLOW, 0);
  a.label('allow_done');

  //   int16_t cur_ind = *array_back(&scanner->ind_len_stk);
  //   int16_t prt_ind = size==1 ? -1 : second-from-top;
  //   int16_t cur_ind_typ = *array_back(&scanner->ind_typ_stk);
  a.peek(S_LEN, R_CUR_IND, 0);
  a.len(S_LEN, R_TMP);
  a.const_(R_PRT_IND, -1);
  a.ifCmpI('eq', R_TMP, 1, 'prt_done');
  a.peek(S_LEN, R_PRT_IND, 1);
  a.label('prt_done');
  a.peek(S_TYP, R_CUR_IND_TYP, 0);

  //   bool has_tab_ind = false;
  //   int16_t leading_spaces = 0;
  a.const_(R_HAS_TAB, 0);
  a.const_(R_LEAD_SP, 0);

  //   for (;;) {
  a.label('ws_loop');
  //     if (lexer->lookahead == ' ') {
  a.ifNChar(CH(' '), 'ws_tab');
  //       if (!has_tab_ind) leading_spaces++;
  a.ifCmpI('ne', R_HAS_TAB, 0, 'ws_space_skp');
  a.alui('add', R_LEAD_SP, 1);
  a.label('ws_space_skp');
  skp();
  a.jmp('ws_loop');
  //     } else if (lexer->lookahead == '\t') {
  a.label('ws_tab');
  a.ifNChar(CH('\t'), 'ws_nwl');
  a.const_(R_HAS_TAB, 1);
  skp();
  a.jmp('ws_loop');
  //     } else if (is_nwl(lexer->lookahead)) {
  a.label('ws_nwl');
  a.ifNClass(C_NWL, 'ws_hash');
  a.const_(R_HAS_TAB, 0);
  a.const_(R_LEAD_SP, 0);
  skpNwl();
  a.jmp('ws_loop');
  //     } else if (allow_comment && lexer->lookahead == '#') {
  a.label('ws_hash');
  a.ifCmpI('eq', R_ALLOW, 0, 'ws_break');
  a.ifNChar(CH('#'), 'ws_break');
  //       if (valid_symbols[BR_BLK_STR_CTN] && valid_symbols[BL] && scanner->cur_col <= cur_ind) {
  //         POP_IND(); RET_SYM(BL);
  a.ifNValid(BR_BLK_STR_CTN, 'ws_hash_body');
  a.ifNValid(BL, 'ws_hash_body');
  a.ifCmp('gt', R_CUR_COL, R_CUR_IND, 'ws_hash_body');
  a.jmp('pop_bl');
  a.label('ws_hash_body');
  //       if (valid_symbols[BR_BLK_STR_CTN]
  //               ? scanner->cur_row == scanner->row
  //               : scanner->cur_col == 0 || scanner->cur_row != scanner->row || scanner->cur_col > scanner->col) {
  a.ifNValid(BR_BLK_STR_CTN, 'ws_hash_not_str');
  a.ifCmp('eq', R_CUR_ROW, R_ROW, 'ws_hash_eat');
  a.jmp('ws_break');
  a.label('ws_hash_not_str');
  a.ifCmpI('eq', R_CUR_COL, 0, 'ws_hash_eat');
  a.ifCmp('ne', R_CUR_ROW, R_ROW, 'ws_hash_eat');
  a.ifCmp('gt', R_CUR_COL, R_COL, 'ws_hash_eat');
  a.jmp('ws_break');
  a.label('ws_hash_eat');
  //         adv; while (!is_nwl && lookahead != 0) adv; mrk_end; RET_SYM(COMMENT);
  adv();
  a.label('ws_hash_eat_loop');
  a.ifClass(C_NWL, 'ws_hash_eat_done');
  a.ifChar(0, 'ws_hash_eat_done');
  adv();
  a.jmp('ws_hash_eat_loop');
  a.label('ws_hash_eat_done');
  mrkEnd();
  retSym(COMMENT);
  a.label('ws_break');

  //   if (lexer->lookahead == 0) {
  a.ifNChar(0, 'after_eof');
  //     if (valid_symbols[BL]) { mrk_end; POP_IND(); RET_SYM(BL) }
  a.ifNValid(BL, 'eof_end');
  mrkEnd();
  a.jmp('pop_bl');
  a.label('eof_end');
  //     if (valid_symbols[END_OF_FILE]) { mrk_end; RET_SYM(END_OF_FILE) }
  a.ifNValid(END_OF_FILE, 'fail');
  mrkEnd();
  retSym(END_OF_FILE);
  a.label('after_eof');

  //   int16_t bgn_row = scanner->cur_row;
  //   int16_t bgn_col = scanner->cur_col;
  //   int32_t bgn_chr = lexer->lookahead;
  a.mov(R_BGN_ROW, R_CUR_ROW);
  a.mov(R_BGN_COL, R_CUR_COL);
  a.lookahead(R_BGN_CHR);

  //   if (valid_symbols[BL] && bgn_col <= cur_ind && !has_tab_ind) {
  a.ifNValid(BL, 'after_bl');
  a.ifCmp('gt', R_BGN_COL, R_CUR_IND, 'after_bl');
  a.ifCmpI('ne', R_HAS_TAB, 0, 'after_bl');
  //     if (cur_ind == prt_ind && cur_ind_typ == IND_SEQ ? bgn_col < cur_ind || lookahead != '-'
  //                                                      : bgn_col <= prt_ind || cur_ind_typ == IND_STR) {
  a.ifCmp('ne', R_CUR_IND, R_PRT_IND, 'bl_else');
  a.ifCmpI('ne', R_CUR_IND_TYP, IND_SEQ, 'bl_else');
  a.ifCmp('lt', R_BGN_COL, R_CUR_IND, 'pop_bl');
  a.ifNChar(CH('-'), 'pop_bl');
  a.jmp('after_bl');
  a.label('bl_else');
  a.ifCmp('le', R_BGN_COL, R_PRT_IND, 'pop_bl');
  a.ifCmpI('eq', R_CUR_IND_TYP, IND_STR, 'pop_bl');
  a.jmp('after_bl');
  a.label('pop_bl');
  a.len(S_TYP, R_TMP);
  a.ifCmpI('eq', R_TMP, 1, 'fail');
  a.pop(S_TYP, R_TMP);
  a.pop(S_LEN, R_TMP);
  retSym(BL);
  a.label('after_bl');

  //   bool has_nwl = scanner->cur_row > scanner->row;
  //   bool is_r = !has_nwl;
  //   bool is_br = has_nwl && leading_spaces > cur_ind;
  //   bool is_b = has_nwl && leading_spaces == cur_ind && !has_tab_ind;
  //   bool is_s = bgn_col == 0;
  a.const_(R_IS_R, 0);
  a.const_(R_IS_BR, 0);
  a.const_(R_IS_B, 0);
  a.const_(R_IS_S, 0);
  a.ifCmp('gt', R_CUR_ROW, R_ROW, 'has_nwl');
  a.const_(R_IS_R, 1);
  a.jmp('pos_s');
  a.label('has_nwl');
  a.ifCmp('le', R_LEAD_SP, R_CUR_IND, 'pos_b');
  a.const_(R_IS_BR, 1);
  a.jmp('pos_s');
  a.label('pos_b');
  a.ifCmp('ne', R_LEAD_SP, R_CUR_IND, 'pos_s');
  a.ifCmpI('ne', R_HAS_TAB, 0, 'pos_s');
  a.const_(R_IS_B, 1);
  a.label('pos_s');
  a.ifCmpI('ne', R_BGN_COL, 0, 'dispatch');
  a.const_(R_IS_S, 1);

  // Remaining token dispatch is filled in subsequent commits. The skeleton
  // still has to halt: fall through to `return !valid_symbols[ERR_REC]`.
  a.label('dispatch');
  a.ifNValid(ERR_REC, 'err_true');
  a.label('fail');
  failScan();
  a.label('err_true');
  // `return true` without RET_SYM: no flush, result_symbol left as 0 from
  // the lexer's last write. The recorder sees END_OF_FILE (0) on this path
  // only when the previous emit was also 0, which is not guaranteed -- but
  // traces that hit this emit 0 because the parser asks at EOF. Halt with
  // END_OF_FILE without flushing, matching "no RET_SYM".
  writeImp();
  a.emit(END_OF_FILE);

  // jump-table targets for is_plain_safe (filled in with the plain-scalar
  // port). Stubbed so the table is well-formed from the first build.
  a.label('is_plain_blk');
  a.const_(R_RET, 0);
  a.ret();
  a.label('is_plain_flw');
  a.const_(R_RET, 0);
  a.ret();

  const code = a.build();
  return {
    entry: 0,
    regPersist: (1 << R_ROW) | (1 << R_COL) | (1 << R_BLK_IMP_TAB),
    stacks: [
      { persist: true },
      { persist: true },
      { persist: true },
      { persist: true },
    ],
    stackInit: [
      { stack: S_TYP, values: [IND_ROT] },
      { stack: S_LEN, values: [-1] },
      { stack: S_IMP_ROW, values: [-1] },
      { stack: S_IMP_COL, values: [-1] },
    ],
    classes: [
      [0x09, 0x09, 0x20, 0x20],                                                 // C_WSP
      [0x0a, 0x0a, 0x0d, 0x0d],                                                 // C_NWL
      [0x00, 0x00, 0x09, 0x0a, 0x0d, 0x0d, 0x20, 0x20],                         // C_WHT
      [0x30, 0x39],                                                             // C_DEC
      [0x30, 0x39, 0x41, 0x46, 0x61, 0x66],                                     // C_HEX
      [0x2d, 0x2d, 0x30, 0x39, 0x41, 0x5a, 0x61, 0x7a],                         // C_WORD
      [0x09, 0x09, 0x20, 0x10ffff],                                             // C_NB_JSON
      [0x09, 0x09, 0x20, 0x21, 0x23, 0x5b, 0x5d, 0x10ffff],                     // C_NB_DOUBLE
      [0x09, 0x09, 0x20, 0x26, 0x28, 0x10ffff],                                 // C_NB_SINGLE
      [0x21, 0x7e, 0x85, 0x85, 0xa0, 0xd7ff, 0xe000, 0xfefe, 0xff00, 0xfffd, 0x10000, 0x10ffff], // C_NS_CHAR
      [0x21, 0x23, 0x25, 0x27, 0x2a, 0x2a, 0x2c, 0x2d, 0x3a, 0x3a, 0x3e, 0x40, 0x5b, 0x5b, 0x5d, 0x5d, 0x60, 0x60, 0x7b, 0x7d], // C_INDICATOR
      [0x2c, 0x2c, 0x5b, 0x5b, 0x5d, 0x5d, 0x7b, 0x7b, 0x7d, 0x7d],             // C_FLOW
      [0x21, 0x2b, 0x2d, 0x5a, 0x5c, 0x5c, 0x5e, 0x7a, 0x7c, 0x7c, 0x7e, 0x7e, 0x85, 0x85, 0xa0, 0xd7ff, 0xe000, 0xfefe, 0xff00, 0xfffd, 0x10000, 0x10ffff], // C_PLAIN_FLOW
      [0x21, 0x21, 0x23, 0x24, 0x26, 0x3b, 0x3d, 0x3d, 0x3f, 0x5b, 0x5d, 0x5d, 0x5f, 0x5f, 0x61, 0x7a, 0x7e, 0x7e], // C_URI
      [0x23, 0x24, 0x26, 0x2b, 0x2d, 0x3b, 0x3d, 0x3d, 0x3f, 0x5a, 0x5f, 0x5f, 0x61, 0x7a, 0x7e, 0x7e], // C_TAG
    ],
    maps: [],
    strings: [],
    validSets: [],
    jumpTable: [a.labels.get('is_plain_blk'), a.labels.get('is_plain_flw')],
    code,
  };
}

module.exports = { build };
