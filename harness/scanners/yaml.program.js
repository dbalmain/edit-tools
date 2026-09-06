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
  const mayUpdImpCol = () => {
    const skip = L('upd');
    a.ifCmp('eq', R_BLK_IMP_ROW, R_BGN_ROW, skip);
    a.mov(R_BLK_IMP_ROW, R_BGN_ROW);
    a.mov(R_BLK_IMP_COL, R_BGN_COL);
    a.mov(R_BLK_IMP_TAB, R_HAS_TAB);
    a.label(skip);
  };
  const pushInd = (typ, lenReg) => {
    a.const_(R_TMP, typ);
    a.push(S_LEN, lenReg);
    a.push(S_TYP, R_TMP);
  };
  const pushBgnInd = (typ) => {
    a.ifCmpI('ne', R_HAS_TAB, 0, 'fail');
    pushInd(typ, R_BGN_COL);
  };
  const mayPushImpInd = () => {
    const skip = L('mpi');
    a.ifCmp('eq', R_CUR_IND, R_BLK_IMP_COL, skip);
    a.ifCmpI('ne', R_BLK_IMP_TAB, 0, 'fail');
    pushInd(IND_MAP, R_BLK_IMP_COL);
    a.label(skip);
  };
  const mayPushSpcSeqInd = () => {
    const skip = L('mps');
    a.ifCmpI('ne', R_CUR_IND_TYP, IND_MAP, skip);
    pushInd(IND_SEQ, R_BGN_COL);
    a.label(skip);
  };
  const ifBoth = (sym, isReg, yes) => {
    const skip = L('ib');
    a.ifNValid(sym, skip);
    a.ifCmpI('ne', isReg, 0, yes);
    a.label(skip);
  };
  const popIndOrFail = () => {
    a.len(S_TYP, R_TMP);
    a.ifCmpI('eq', R_TMP, 1, 'fail');
    a.pop(S_TYP, R_TMP);
    a.pop(S_LEN, R_TMP);
  };
  const asEq = (ch, sch, st) => {
    const n = L('ae');
    a.ifCmpI('ne', R_CUR_CHR, typeof ch === 'number' ? ch : CH(ch), n);
    a.const_(R_RLT_SCH, sch);
    a.const_(R_SCH_STT, st);
    a.ret();
    a.label(n);
  };
  const asRange = (lo, hi, sch, st) => {
    const n = L('ar');
    a.ifCmpI('lt', R_CUR_CHR, typeof lo === 'number' ? lo : CH(lo), n);
    a.ifCmpI('gt', R_CUR_CHR, typeof hi === 'number' ? hi : CH(hi), n);
    a.const_(R_RLT_SCH, sch);
    a.const_(R_SCH_STT, st);
    a.ret();
    a.label(n);
  };
  const asOr = (chars, sch, st) => {
    const hit = L('hit');
    const n = L('ao');
    for (const c of chars) a.ifCmpI('eq', R_CUR_CHR, CH(c), hit);
    a.jmp(n);
    a.label(hit);
    a.const_(R_RLT_SCH, sch);
    a.const_(R_SCH_STT, st);
    a.ret();
    a.label(n);
  };
  const sglPlnSym = (posOff) => {
    const done = L('sgl');
    a.const_(R_SYM, R_SGL_PLN_NUL_BLK + posOff);
    a.ifCmpI('eq', R_RLT_SCH, RS_NULL, done);
    a.const_(R_SYM, R_SGL_PLN_BOL_BLK + posOff);
    a.ifCmpI('eq', R_RLT_SCH, RS_BOOL, done);
    a.const_(R_SYM, R_SGL_PLN_INT_BLK + posOff);
    a.ifCmpI('eq', R_RLT_SCH, RS_INT, done);
    a.const_(R_SYM, R_SGL_PLN_FLT_BLK + posOff);
    a.ifCmpI('eq', R_RLT_SCH, RS_FLOAT, done);
    a.const_(R_SYM, R_SGL_PLN_STR_BLK + posOff);
    a.label(done);
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

  a.label('dispatch');

  //   if (valid_symbols[R_DIR_YML_VER] && is_r) return scn_dir_yml_ver(..., R_DIR_YML_VER);
  ifBoth(R_DIR_YML_VER, R_IS_R, 'call_dir_ver');
  ifBoth(R_DIR_TAG_HDL, R_IS_R, 'call_dir_hdl');
  ifBoth(R_DIR_TAG_PFX, R_IS_R, 'call_dir_pfx');
  ifBoth(R_DIR_RSV_PRM, R_IS_R, 'call_dir_prm');
  a.jmp('after_dir');
  a.label('call_dir_ver');
  a.const_(R_SYM, R_DIR_YML_VER);
  a.jmp('scn_dir_yml_ver');
  a.label('call_dir_hdl');
  a.const_(R_SYM, R_DIR_TAG_HDL);
  a.jmp('scn_dir_tag_hdl');
  a.label('call_dir_pfx');
  a.const_(R_SYM, R_DIR_TAG_PFX);
  a.jmp('scn_dir_tag_pfx');
  a.label('call_dir_prm');
  a.const_(R_SYM, R_DIR_RSV_PRM);
  a.jmp('scn_dir_rsv_prm');
  a.label('after_dir');

  //   if (valid_symbols[BR_BLK_STR_CTN] && is_br && scn_blk_str_cnt(..., BR_BLK_STR_CTN)) return true;
  a.ifNValid(BR_BLK_STR_CTN, 'after_blk_str_cnt');
  a.ifCmpI('eq', R_IS_BR, 0, 'after_blk_str_cnt');
  a.const_(R_SYM, BR_BLK_STR_CTN);
  a.call('scn_blk_str_cnt');
  a.label('after_blk_str_cnt');

  //   if ((valid[R_DQT_STR_CTN] && is_r && scn_dqt_str_cnt(..., R_DQT_STR_CTN)) ||
  //       (valid[BR_DQT_STR_CTN] && is_br && scn_dqt_str_cnt(..., BR_DQT_STR_CTN))) return true;
  a.ifNValid(R_DQT_STR_CTN, 'dqt_cnt_br');
  a.ifCmpI('eq', R_IS_R, 0, 'dqt_cnt_br');
  a.const_(R_SYM, R_DQT_STR_CTN);
  a.call('scn_dqt_str_cnt');
  a.label('dqt_cnt_br');
  a.ifNValid(BR_DQT_STR_CTN, 'after_dqt_cnt');
  a.ifCmpI('eq', R_IS_BR, 0, 'after_dqt_cnt');
  a.const_(R_SYM, BR_DQT_STR_CTN);
  a.call('scn_dqt_str_cnt');
  a.label('after_dqt_cnt');

  a.ifNValid(R_SQT_STR_CTN, 'sqt_cnt_br');
  a.ifCmpI('eq', R_IS_R, 0, 'sqt_cnt_br');
  a.const_(R_SYM, R_SQT_STR_CTN);
  a.call('scn_sqt_str_cnt');
  a.label('sqt_cnt_br');
  a.ifNValid(BR_SQT_STR_CTN, 'after_sqt_cnt');
  a.ifCmpI('eq', R_IS_BR, 0, 'after_sqt_cnt');
  a.const_(R_SYM, BR_SQT_STR_CTN);
  a.call('scn_sqt_str_cnt');
  a.label('after_sqt_cnt');

  //   if (valid[R_ACR_CTN] && is_r) return scn_acr_ctn(..., R_ACR_CTN);
  ifBoth(R_ACR_CTN, R_IS_R, 'call_acr_ctn');
  ifBoth(R_ALS_CTN, R_IS_R, 'call_als_ctn');
  a.jmp('after_ctn');
  a.label('call_acr_ctn');
  a.const_(R_SYM, R_ACR_CTN);
  a.jmp('scn_acr_ctn');
  a.label('call_als_ctn');
  a.const_(R_SYM, R_ALS_CTN);
  a.jmp('scn_als_ctn');
  a.label('after_ctn');

  //   if (lexer->lookahead == '%') {
  a.ifNChar(CH('%'), 'ch_star');
  ifBoth(S_DIR_YML_BGN, R_IS_S, 'call_dir_bgn');
  a.jmp('plain');
  a.label('call_dir_bgn');
  a.jmp('scn_dir_bgn');

  //   } else if (lexer->lookahead == '*') {
  a.label('ch_star');
  a.ifNChar(CH('*'), 'ch_amp');
  ifBoth(R_ALS_BGN, R_IS_R, 'als_r');
  ifBoth(BR_ALS_BGN, R_IS_BR, 'als_br');
  ifBoth(B_ALS_BGN, R_IS_B, 'als_b');
  a.jmp('plain');
  a.label('als_r');
  mayUpdImpCol();
  a.const_(R_SYM, R_ALS_BGN);
  a.jmp('scn_als_bgn');
  a.label('als_br');
  mayUpdImpCol();
  a.const_(R_SYM, BR_ALS_BGN);
  a.jmp('scn_als_bgn');
  a.label('als_b');
  mayUpdImpCol();
  a.const_(R_SYM, B_ALS_BGN);
  a.jmp('scn_als_bgn');

  //   } else if (lexer->lookahead == '&') {
  a.label('ch_amp');
  a.ifNChar(CH('&'), 'ch_bang');
  ifBoth(R_ACR_BGN, R_IS_R, 'acr_r');
  ifBoth(BR_ACR_BGN, R_IS_BR, 'acr_br');
  ifBoth(B_ACR_BGN, R_IS_B, 'acr_b');
  a.jmp('plain');
  a.label('acr_r');
  mayUpdImpCol();
  a.const_(R_SYM, R_ACR_BGN);
  a.jmp('scn_acr_bgn');
  a.label('acr_br');
  mayUpdImpCol();
  a.const_(R_SYM, BR_ACR_BGN);
  a.jmp('scn_acr_bgn');
  a.label('acr_b');
  mayUpdImpCol();
  a.const_(R_SYM, B_ACR_BGN);
  a.jmp('scn_acr_bgn');

  //   } else if (lexer->lookahead == '!') {
  a.label('ch_bang');
  a.ifNChar(CH('!'), 'ch_lbra');
  ifBoth(R_TAG, R_IS_R, 'tag_r');
  ifBoth(BR_TAG, R_IS_BR, 'tag_br');
  ifBoth(B_TAG, R_IS_B, 'tag_b');
  a.jmp('plain');
  a.label('tag_r');
  mayUpdImpCol();
  a.const_(R_SYM, R_TAG);
  a.jmp('scn_tag');
  a.label('tag_br');
  mayUpdImpCol();
  a.const_(R_SYM, BR_TAG);
  a.jmp('scn_tag');
  a.label('tag_b');
  mayUpdImpCol();
  a.const_(R_SYM, B_TAG);
  a.jmp('scn_tag');

  //   } else if (lexer->lookahead == '[') {
  a.label('ch_lbra');
  a.ifNChar(CH('['), 'ch_rbra');
  ifBoth(R_FLW_SEQ_BGN, R_IS_R, 'fsb_r');
  ifBoth(BR_FLW_SEQ_BGN, R_IS_BR, 'fsb_br');
  ifBoth(B_FLW_SEQ_BGN, R_IS_B, 'fsb_b');
  a.jmp('plain');
  a.label('fsb_r');
  mayUpdImpCol();
  adv();
  mrkEnd();
  retSym(R_FLW_SEQ_BGN);
  a.label('fsb_br');
  mayUpdImpCol();
  adv();
  mrkEnd();
  retSym(BR_FLW_SEQ_BGN);
  a.label('fsb_b');
  mayUpdImpCol();
  adv();
  mrkEnd();
  retSym(B_FLW_SEQ_BGN);

  //   } else if (lexer->lookahead == ']') {
  a.label('ch_rbra');
  a.ifNChar(CH(']'), 'ch_lcur');
  ifBoth(R_FLW_SEQ_END, R_IS_R, 'fse_r');
  ifBoth(BR_FLW_SEQ_END, R_IS_BR, 'fse_br');
  ifBoth(B_FLW_SEQ_END, R_IS_B, 'fse_b');
  a.jmp('plain');
  a.label('fse_r');
  adv();
  mrkEnd();
  retSym(R_FLW_SEQ_END);
  a.label('fse_br');
  adv();
  mrkEnd();
  retSym(BR_FLW_SEQ_END);
  a.label('fse_b');
  adv();
  mrkEnd();
  // Upstream emits BR_FLW_SEQ_END here, not B_FLW_SEQ_END.
  retSym(BR_FLW_SEQ_END);

  //   } else if (lexer->lookahead == '{') {
  a.label('ch_lcur');
  a.ifNChar(CH('{'), 'ch_rcur');
  ifBoth(R_FLW_MAP_BGN, R_IS_R, 'fmb_r');
  ifBoth(BR_FLW_MAP_BGN, R_IS_BR, 'fmb_br');
  ifBoth(B_FLW_MAP_BGN, R_IS_B, 'fmb_b');
  a.jmp('plain');
  a.label('fmb_r');
  mayUpdImpCol();
  adv();
  mrkEnd();
  retSym(R_FLW_MAP_BGN);
  a.label('fmb_br');
  mayUpdImpCol();
  adv();
  mrkEnd();
  retSym(BR_FLW_MAP_BGN);
  a.label('fmb_b');
  mayUpdImpCol();
  adv();
  mrkEnd();
  retSym(B_FLW_MAP_BGN);

  //   } else if (lexer->lookahead == '}') {
  a.label('ch_rcur');
  a.ifNChar(CH('}'), 'ch_comma');
  ifBoth(R_FLW_MAP_END, R_IS_R, 'fme_r');
  ifBoth(BR_FLW_MAP_END, R_IS_BR, 'fme_br');
  ifBoth(B_FLW_MAP_END, R_IS_B, 'fme_b');
  a.jmp('plain');
  a.label('fme_r');
  adv();
  mrkEnd();
  retSym(R_FLW_MAP_END);
  a.label('fme_br');
  adv();
  mrkEnd();
  retSym(BR_FLW_MAP_END);
  a.label('fme_b');
  adv();
  mrkEnd();
  retSym(B_FLW_MAP_END);

  //   } else if (lexer->lookahead == ',') {
  a.label('ch_comma');
  a.ifNChar(CH(','), 'ch_dqt');
  ifBoth(R_FLW_SEP_BGN, R_IS_R, 'sep_r');
  ifBoth(BR_FLW_SEP_BGN, R_IS_BR, 'sep_br');
  a.jmp('plain');
  a.label('sep_r');
  adv();
  mrkEnd();
  retSym(R_FLW_SEP_BGN);
  a.label('sep_br');
  adv();
  mrkEnd();
  retSym(BR_FLW_SEP_BGN);

  //   } else if (lexer->lookahead == '"') {
  a.label('ch_dqt');
  a.ifNChar(CH('"'), 'ch_sqt');
  ifBoth(R_DQT_STR_BGN, R_IS_R, 'dqb_r');
  ifBoth(BR_DQT_STR_BGN, R_IS_BR, 'dqb_br');
  ifBoth(B_DQT_STR_BGN, R_IS_B, 'dqb_b');
  ifBoth(R_DQT_STR_END, R_IS_R, 'dqe_r');
  ifBoth(BR_DQT_STR_END, R_IS_BR, 'dqe_br');
  a.jmp('plain');
  a.label('dqb_r');
  mayUpdImpCol();
  adv();
  mrkEnd();
  retSym(R_DQT_STR_BGN);
  a.label('dqb_br');
  mayUpdImpCol();
  adv();
  mrkEnd();
  retSym(BR_DQT_STR_BGN);
  a.label('dqb_b');
  mayUpdImpCol();
  adv();
  mrkEnd();
  retSym(B_DQT_STR_BGN);
  a.label('dqe_r');
  adv();
  mrkEnd();
  retSym(R_DQT_STR_END);
  a.label('dqe_br');
  adv();
  mrkEnd();
  retSym(BR_DQT_STR_END);

  //   } else if (lexer->lookahead == '\'') {
  a.label('ch_sqt');
  a.ifNChar(CH('\''), 'ch_qst');
  ifBoth(R_SQT_STR_BGN, R_IS_R, 'sqb_r');
  ifBoth(BR_SQT_STR_BGN, R_IS_BR, 'sqb_br');
  ifBoth(B_SQT_STR_BGN, R_IS_B, 'sqb_b');
  ifBoth(R_SQT_STR_END, R_IS_R, 'sqe_r');
  ifBoth(BR_SQT_STR_END, R_IS_BR, 'sqe_br');
  a.jmp('plain');
  a.label('sqb_r');
  mayUpdImpCol();
  adv();
  mrkEnd();
  retSym(R_SQT_STR_BGN);
  a.label('sqb_br');
  mayUpdImpCol();
  adv();
  mrkEnd();
  retSym(BR_SQT_STR_BGN);
  a.label('sqb_b');
  mayUpdImpCol();
  adv();
  mrkEnd();
  retSym(B_SQT_STR_BGN);
  a.label('sqe_r');
  adv();
  a.ifNChar(CH('\''), 'sqe_r_end');
  adv();
  mrkEnd();
  retSym(R_SQT_ESC_SQT);
  a.label('sqe_r_end');
  mrkEnd();
  retSym(R_SQT_STR_END);
  a.label('sqe_br');
  adv();
  a.ifNChar(CH('\''), 'sqe_br_end');
  adv();
  mrkEnd();
  retSym(BR_SQT_ESC_SQT);
  a.label('sqe_br_end');
  mrkEnd();
  retSym(BR_SQT_STR_END);

  //   } else if (lexer->lookahead == '?') {
  a.label('ch_qst');
  a.ifNChar(CH('?'), 'ch_col');
  a.const_(R_N, 0);                        // any of the five key-bgn flags
  a.ifNValid(R_BLK_KEY_BGN, 'q_br');
  a.ifCmpI('eq', R_IS_R, 0, 'q_br');
  a.const_(R_N, 1);
  a.label('q_br');
  a.ifNValid(BR_BLK_KEY_BGN, 'q_b');
  a.ifCmpI('eq', R_IS_BR, 0, 'q_b');
  a.const_(R_N, 1);
  a.label('q_b');
  a.ifNValid(B_BLK_KEY_BGN, 'q_fr');
  a.ifCmpI('eq', R_IS_B, 0, 'q_fr');
  a.const_(R_N, 1);
  a.label('q_fr');
  a.ifNValid(R_FLW_KEY_BGN, 'q_fbr');
  a.ifCmpI('eq', R_IS_R, 0, 'q_fbr');
  a.const_(R_N, 1);
  a.label('q_fbr');
  a.ifNValid(BR_FLW_KEY_BGN, 'q_any');
  a.ifCmpI('eq', R_IS_BR, 0, 'q_any');
  a.const_(R_N, 1);
  a.label('q_any');
  a.ifCmpI('eq', R_N, 0, 'plain');
  adv();
  a.ifNClass(C_WHT, 'plain');
  mrkEnd();
  ifBoth(R_BLK_KEY_BGN, R_IS_R, 'q_emit_r');
  ifBoth(BR_BLK_KEY_BGN, R_IS_BR, 'q_emit_br');
  ifBoth(B_BLK_KEY_BGN, R_IS_B, 'q_emit_b');
  ifBoth(R_FLW_KEY_BGN, R_IS_R, 'q_emit_fr');
  ifBoth(BR_FLW_KEY_BGN, R_IS_BR, 'q_emit_fbr');
  a.jmp('plain');
  a.label('q_emit_r');
  pushBgnInd(IND_MAP);
  retSym(R_BLK_KEY_BGN);
  a.label('q_emit_br');
  pushBgnInd(IND_MAP);
  retSym(BR_BLK_KEY_BGN);
  a.label('q_emit_b');
  retSym(B_BLK_KEY_BGN);
  a.label('q_emit_fr');
  retSym(R_FLW_KEY_BGN);
  a.label('q_emit_fbr');
  retSym(BR_FLW_KEY_BGN);

  //   } else if (lexer->lookahead == ':') {
  a.label('ch_col');
  a.ifNChar(CH(':'), 'ch_dash');
  ifBoth(R_FLW_JSV_BGN, R_IS_R, 'jsv_r');
  ifBoth(BR_FLW_JSV_BGN, R_IS_BR, 'jsv_br');
  a.jmp('col_val');
  a.label('jsv_r');
  adv();
  mrkEnd();
  retSym(R_FLW_JSV_BGN);
  a.label('jsv_br');
  adv();
  mrkEnd();
  retSym(BR_FLW_JSV_BGN);
  a.label('col_val');
  a.const_(R_N, 0);
  a.ifNValid(R_BLK_VAL_BGN, 'cv_br');
  a.ifCmpI('eq', R_IS_R, 0, 'cv_br');
  a.const_(R_N, 1);
  a.label('cv_br');
  a.ifNValid(BR_BLK_VAL_BGN, 'cv_b');
  a.ifCmpI('eq', R_IS_BR, 0, 'cv_b');
  a.const_(R_N, 1);
  a.label('cv_b');
  a.ifNValid(B_BLK_VAL_BGN, 'cv_imp');
  a.ifCmpI('eq', R_IS_B, 0, 'cv_imp');
  a.const_(R_N, 1);
  a.label('cv_imp');
  a.ifNValid(R_BLK_IMP_BGN, 'cv_njv');
  a.ifCmpI('eq', R_IS_R, 0, 'cv_njv');
  a.const_(R_N, 1);
  a.label('cv_njv');
  a.ifNValid(R_FLW_NJV_BGN, 'cv_njvbr');
  a.ifCmpI('eq', R_IS_R, 0, 'cv_njvbr');
  a.const_(R_N, 1);
  a.label('cv_njvbr');
  a.ifNValid(BR_FLW_NJV_BGN, 'cv_any');
  a.ifCmpI('eq', R_IS_BR, 0, 'cv_any');
  a.const_(R_N, 1);
  a.label('cv_any');
  a.ifCmpI('eq', R_N, 0, 'plain');
  adv();
  a.const_(R_TMP2, 0);                     // is_lka_wht
  a.ifNClass(C_WHT, 'cv_after_wht');
  a.const_(R_TMP2, 1);
  a.label('cv_after_wht');
  a.ifCmpI('eq', R_TMP2, 0, 'cv_flow');
  ifBoth(R_BLK_VAL_BGN, R_IS_R, 'cv_r');
  ifBoth(BR_BLK_VAL_BGN, R_IS_BR, 'cv_br_e');
  ifBoth(B_BLK_VAL_BGN, R_IS_B, 'cv_b_e');
  ifBoth(R_BLK_IMP_BGN, R_IS_R, 'cv_imp_e');
  a.label('cv_flow');
  a.ifCmpI('ne', R_TMP2, 0, 'cv_njv_try');
  a.ifChar(CH(','), 'cv_njv_try');
  a.ifChar(CH(']'), 'cv_njv_try');
  a.ifChar(CH('}'), 'cv_njv_try');
  a.jmp('plain');
  a.label('cv_njv_try');
  ifBoth(R_FLW_NJV_BGN, R_IS_R, 'cv_njv_r');
  ifBoth(BR_FLW_NJV_BGN, R_IS_BR, 'cv_njv_br');
  a.jmp('plain');
  a.label('cv_r');
  pushBgnInd(IND_MAP);
  mrkEnd();
  retSym(R_BLK_VAL_BGN);
  a.label('cv_br_e');
  pushBgnInd(IND_MAP);
  mrkEnd();
  retSym(BR_BLK_VAL_BGN);
  a.label('cv_b_e');
  mrkEnd();
  retSym(B_BLK_VAL_BGN);
  a.label('cv_imp_e');
  mayPushImpInd();
  mrkEnd();
  retSym(R_BLK_IMP_BGN);
  a.label('cv_njv_r');
  mrkEnd();
  retSym(R_FLW_NJV_BGN);
  a.label('cv_njv_br');
  mrkEnd();
  retSym(BR_FLW_NJV_BGN);

  //   } else if (lexer->lookahead == '-') {
  a.label('ch_dash');
  a.ifNChar(CH('-'), 'ch_dot');
  a.const_(R_N, 0);
  a.ifNValid(R_BLK_SEQ_BGN, 'ds_br');
  a.ifCmpI('eq', R_IS_R, 0, 'ds_br');
  a.const_(R_N, 1);
  a.label('ds_br');
  a.ifNValid(BR_BLK_SEQ_BGN, 'ds_b');
  a.ifCmpI('eq', R_IS_BR, 0, 'ds_b');
  a.const_(R_N, 1);
  a.label('ds_b');
  a.ifNValid(B_BLK_SEQ_BGN, 'ds_s');
  a.ifCmpI('eq', R_IS_B, 0, 'ds_s');
  a.const_(R_N, 1);
  a.label('ds_s');
  a.ifCmpI('eq', R_IS_S, 0, 'ds_any');
  a.const_(R_N, 1);
  a.label('ds_any');
  a.ifCmpI('eq', R_N, 0, 'plain');
  adv();
  a.ifNClass(C_WHT, 'ds_doc');
  ifBoth(R_BLK_SEQ_BGN, R_IS_R, 'ds_r');
  ifBoth(BR_BLK_SEQ_BGN, R_IS_BR, 'ds_br_e');
  ifBoth(B_BLK_SEQ_BGN, R_IS_B, 'ds_b_e');
  a.jmp('plain');
  a.label('ds_r');
  pushBgnInd(IND_SEQ);
  mrkEnd();
  retSym(R_BLK_SEQ_BGN);
  a.label('ds_br_e');
  pushBgnInd(IND_SEQ);
  mrkEnd();
  retSym(BR_BLK_SEQ_BGN);
  a.label('ds_b_e');
  mayPushSpcSeqInd();
  mrkEnd();
  retSym(B_BLK_SEQ_BGN);
  a.label('ds_doc');
  a.ifNChar(CH('-'), 'plain');
  a.ifCmpI('eq', R_IS_S, 0, 'plain');
  adv();
  a.ifNChar(CH('-'), 'plain');
  adv();
  a.ifNClass(C_WHT, 'plain');
  a.ifNValid(BL, 'ds_drs');
  a.jmp('pop_bl');
  a.label('ds_drs');
  mrkEnd();
  retSym(S_DRS_END);

  //   } else if (lexer->lookahead == '.') {
  a.label('ch_dot');
  a.ifNChar(CH('.'), 'ch_bs');
  a.ifCmpI('eq', R_IS_S, 0, 'plain');
  adv();
  a.ifNChar(CH('.'), 'plain');
  adv();
  a.ifNChar(CH('.'), 'plain');
  adv();
  a.ifNClass(C_WHT, 'plain');
  a.ifNValid(BL, 'dot_doc');
  a.jmp('pop_bl');
  a.label('dot_doc');
  mrkEnd();
  retSym(S_DOC_END);

  //   } else if (lexer->lookahead == '\\') {
  a.label('ch_bs');
  a.ifNChar(CH('\\'), 'ch_pipe');
  a.const_(R_N, 0);
  a.ifNValid(R_DQT_ESC_NWL, 'bs_brn');
  a.ifCmpI('eq', R_IS_R, 0, 'bs_brn');
  a.const_(R_N, 1);
  a.label('bs_brn');
  a.ifNValid(BR_DQT_ESC_NWL, 'bs_rs');
  a.ifCmpI('eq', R_IS_BR, 0, 'bs_rs');
  a.const_(R_N, 1);
  a.label('bs_rs');
  a.ifNValid(R_DQT_ESC_SEQ, 'bs_brs');
  a.ifCmpI('eq', R_IS_R, 0, 'bs_brs');
  a.const_(R_N, 1);
  a.label('bs_brs');
  a.ifNValid(BR_DQT_ESC_SEQ, 'bs_any');
  a.ifCmpI('eq', R_IS_BR, 0, 'bs_any');
  a.const_(R_N, 1);
  a.label('bs_any');
  a.ifCmpI('eq', R_N, 0, 'plain');
  adv();
  a.ifNClass(C_NWL, 'bs_seq');
  ifBoth(R_DQT_ESC_NWL, R_IS_R, 'bs_nwl_r');
  ifBoth(BR_DQT_ESC_NWL, R_IS_BR, 'bs_nwl_br');
  a.label('bs_seq');
  ifBoth(R_DQT_ESC_SEQ, R_IS_R, 'bs_seq_r');
  ifBoth(BR_DQT_ESC_SEQ, R_IS_BR, 'bs_seq_br');
  a.jmp('fail');
  a.label('bs_nwl_r');
  mrkEnd();
  retSym(R_DQT_ESC_NWL);
  a.label('bs_nwl_br');
  mrkEnd();
  retSym(BR_DQT_ESC_NWL);
  a.label('bs_seq_r');
  a.const_(R_SYM, R_DQT_ESC_SEQ);
  a.jmp('scn_dqt_esc_seq');
  a.label('bs_seq_br');
  a.const_(R_SYM, BR_DQT_ESC_SEQ);
  a.jmp('scn_dqt_esc_seq');

  //   } else if (lexer->lookahead == '|') {
  a.label('ch_pipe');
  a.ifNChar(CH('|'), 'ch_gt');
  ifBoth(R_BLK_LIT_BGN, R_IS_R, 'lit_r');
  ifBoth(BR_BLK_LIT_BGN, R_IS_BR, 'lit_br');
  a.jmp('plain');
  a.label('lit_r');
  a.const_(R_SYM, R_BLK_LIT_BGN);
  a.jmp('scn_blk_str_bgn');
  a.label('lit_br');
  a.const_(R_SYM, BR_BLK_LIT_BGN);
  a.jmp('scn_blk_str_bgn');

  //   } else if (lexer->lookahead == '>') {
  a.label('ch_gt');
  a.ifNChar(CH('>'), 'plain');
  ifBoth(R_BLK_FLD_BGN, R_IS_R, 'fld_r');
  ifBoth(BR_BLK_FLD_BGN, R_IS_BR, 'fld_br');
  a.jmp('plain');
  a.label('fld_r');
  a.const_(R_SYM, R_BLK_FLD_BGN);
  a.jmp('scn_blk_str_bgn');
  a.label('fld_br');
  a.const_(R_SYM, BR_BLK_FLD_BGN);
  a.jmp('scn_blk_str_bgn');

  // ---- plain scalars ----------------------------------------------------
  //   maybe_sgl_pln_blk = (valid[R_SGL_PLN_STR_BLK] && is_r) ||
  //                       (valid[BR_SGL_PLN_STR_BLK] && is_br) ||
  //                       (valid[B_SGL_PLN_STR_BLK] && is_b);
  // packed into R_ALLOW bits: 0 blk-sgl, 1 flw-sgl, 2 blk-mtl, 3 flw-mtl
  a.label('plain');
  a.const_(R_ALLOW, 0);
  a.ifNValid(R_SGL_PLN_STR_BLK, 'psb_br');
  a.ifCmpI('eq', R_IS_R, 0, 'psb_br');
  a.alui('or', R_ALLOW, 1);
  a.label('psb_br');
  a.ifNValid(BR_SGL_PLN_STR_BLK, 'psb_b');
  a.ifCmpI('eq', R_IS_BR, 0, 'psb_b');
  a.alui('or', R_ALLOW, 1);
  a.label('psb_b');
  a.ifNValid(B_SGL_PLN_STR_BLK, 'psf');
  a.ifCmpI('eq', R_IS_B, 0, 'psf');
  a.alui('or', R_ALLOW, 1);
  a.label('psf');
  a.ifNValid(R_SGL_PLN_STR_FLW, 'psf_br');
  a.ifCmpI('eq', R_IS_R, 0, 'psf_br');
  a.alui('or', R_ALLOW, 2);
  a.label('psf_br');
  a.ifNValid(BR_SGL_PLN_STR_FLW, 'pmb');
  a.ifCmpI('eq', R_IS_BR, 0, 'pmb');
  a.alui('or', R_ALLOW, 2);
  a.label('pmb');
  a.ifNValid(R_MTL_PLN_STR_BLK, 'pmb_br');
  a.ifCmpI('eq', R_IS_R, 0, 'pmb_br');
  a.alui('or', R_ALLOW, 4);
  a.label('pmb_br');
  a.ifNValid(BR_MTL_PLN_STR_BLK, 'pmf');
  a.ifCmpI('eq', R_IS_BR, 0, 'pmf');
  a.alui('or', R_ALLOW, 4);
  a.label('pmf');
  a.ifNValid(R_MTL_PLN_STR_FLW, 'pmf_br');
  a.ifCmpI('eq', R_IS_R, 0, 'pmf_br');
  a.alui('or', R_ALLOW, 8);
  a.label('pmf_br');
  a.ifNValid(BR_MTL_PLN_STR_FLW, 'plain_any');
  a.ifCmpI('eq', R_IS_BR, 0, 'plain_any');
  a.alui('or', R_ALLOW, 8);
  a.label('plain_any');
  a.ifCmpI('eq', R_ALLOW, 0, 'err_rec');

  //   is_in_blk = maybe_sgl_pln_blk || maybe_mtl_pln_blk  (bits 0 and 2)
  //   is_plain_safe = is_in_blk ? block : flow
  a.mov(R_TMP, R_ALLOW);
  a.alui('and', R_TMP, 5);
  a.const_(R_FN, JT_PLAIN_FLW);
  a.ifCmpI('eq', R_TMP, 0, 'plain_go');
  a.const_(R_FN, JT_PLAIN_BLK);
  a.label('plain_go');

  //   if (scanner->cur_col - bgn_col == 0) adv;
  a.mov(R_TMP, R_CUR_COL);
  a.alu('sub', R_TMP, R_BGN_COL);
  a.ifCmpI('ne', R_TMP, 0, 'plain_first');
  adv();
  a.label('plain_first');
  //   if (scanner->cur_col - bgn_col == 1) {
  a.mov(R_TMP, R_CUR_COL);
  a.alu('sub', R_TMP, R_BGN_COL);
  a.ifCmpI('ne', R_TMP, 1, 'plain_frz');
  //     is_plain_first = (is_ns_char(bgn_chr) && !is_c_indicator(bgn_chr)) ||
  //       ((bgn_chr == '-' || '?' || ':') && is_plain_safe(lookahead));
  a.const_(R_N, 0);
  a.mov(R_CH, R_BGN_CHR);
  a.call('is_ns_char_r');
  a.ifCmpI('eq', R_RET, 0, 'pf_ind');
  a.mov(R_CH, R_BGN_CHR);
  a.call('is_indicator_r');
  a.ifCmpI('ne', R_RET, 0, 'pf_ind');
  a.const_(R_N, 1);
  a.jmp('pf_chk');
  a.label('pf_ind');
  a.ifCmpI('eq', R_BGN_CHR, CH('-'), 'pf_safe');
  a.ifCmpI('eq', R_BGN_CHR, CH('?'), 'pf_safe');
  a.ifCmpI('eq', R_BGN_CHR, CH(':'), 'pf_safe');
  a.jmp('pf_chk');
  a.label('pf_safe');
  a.lookahead(R_CH);
  a.callR(R_FN);
  a.mov(R_N, R_RET);
  a.label('pf_chk');
  a.ifCmpI('eq', R_N, 0, 'fail');
  a.call('adv_sch');
  a.jmp('plain_mrk');
  a.label('plain_frz');
  //     sch_stt = SCH_STT_FRZ; // must be RS_STR
  a.const_(R_SCH_STT, SCH_STT_FRZ);
  a.label('plain_mrk');
  mrkEnd();

  a.label('plain_loop');
  a.ifClass(C_NWL, 'plain_nwl');
  a.call('scn_pln_cnt');
  a.ifCmpI('ne', R_RET, SCN_SUCC, 'plain_done');
  a.label('plain_nwl');
  a.ifChar(0, 'plain_done');
  a.ifNClass(C_NWL, 'plain_done');
  a.label('plain_skip_ws');
  a.ifClass(C_NWL, 'plain_skip_nwl');
  a.ifClass(C_WSP, 'plain_skip_wsp');
  a.jmp('plain_after_ws');
  a.label('plain_skip_nwl');
  advNwl();
  a.jmp('plain_skip_ws');
  a.label('plain_skip_wsp');
  adv();
  a.jmp('plain_skip_ws');
  a.label('plain_after_ws');
  a.ifChar(0, 'plain_done');
  a.ifCmp('le', R_CUR_COL, R_CUR_IND, 'plain_done');
  a.ifCmpI('ne', R_CUR_COL, 0, 'plain_loop');
  a.call('scn_drs_doc_end');
  a.ifCmpI('ne', R_RET, 0, 'plain_done');
  a.jmp('plain_loop');

  a.label('plain_done');
  //   if (scanner->end_row == bgn_row) { sgl } else { mtl }
  a.ifCmp('ne', R_END_ROW, R_BGN_ROW, 'plain_mtl');
  a.mov(R_TMP, R_ALLOW);
  a.alui('and', R_TMP, 1);
  a.ifCmpI('eq', R_TMP, 0, 'plain_sgl_flw');
  mayUpdImpCol();
  a.ifCmpI('ne', R_IS_R, 0, 'plain_sgl_r');
  a.ifCmpI('ne', R_IS_BR, 0, 'plain_sgl_br');
  sglPlnSym(2);                            // B_BLK
  retSymR();
  a.label('plain_sgl_r');
  sglPlnSym(0);
  retSymR();
  a.label('plain_sgl_br');
  sglPlnSym(1);
  retSymR();
  a.label('plain_sgl_flw');
  a.mov(R_TMP, R_ALLOW);
  a.alui('and', R_TMP, 2);
  a.ifCmpI('eq', R_TMP, 0, 'fail');
  a.ifCmpI('ne', R_IS_R, 0, 'plain_sgl_fr');
  sglPlnSym(4);                            // BR_FLW
  retSymR();
  a.label('plain_sgl_fr');
  sglPlnSym(3);
  retSymR();
  a.label('plain_mtl');
  a.mov(R_TMP, R_ALLOW);
  a.alui('and', R_TMP, 4);
  a.ifCmpI('eq', R_TMP, 0, 'plain_mtl_flw');
  mayUpdImpCol();
  a.ifCmpI('ne', R_IS_R, 0, 'plain_mtl_r');
  retSym(BR_MTL_PLN_STR_BLK);
  a.label('plain_mtl_r');
  retSym(R_MTL_PLN_STR_BLK);
  a.label('plain_mtl_flw');
  a.mov(R_TMP, R_ALLOW);
  a.alui('and', R_TMP, 8);
  a.ifCmpI('eq', R_TMP, 0, 'fail');
  a.ifCmpI('ne', R_IS_R, 0, 'plain_mtl_fr');
  retSym(BR_MTL_PLN_STR_FLW);
  a.label('plain_mtl_fr');
  retSym(R_MTL_PLN_STR_FLW);

  //   return !valid_symbols[ERR_REC];
  a.label('err_rec');
  a.ifNValid(ERR_REC, 'err_true');
  a.label('fail');
  failScan();
  a.label('err_true');
  writeImp();
  a.emit(END_OF_FILE);

  // ======================================================================
  // Register classifiers. IF_CLASS tests lookahead; these test R_CH.
  // ======================================================================
  a.label('is_ns_char_r');
  a.const_(R_RET, 0);
  a.ifCmpI('lt', R_CH, 0x21, 'ns_r_no');
  a.ifCmpI('le', R_CH, 0x7e, 'ns_r_yes');
  a.ifCmpI('eq', R_CH, 0x85, 'ns_r_yes');
  a.ifCmpI('lt', R_CH, 0xa0, 'ns_r_no');
  a.ifCmpI('le', R_CH, 0xd7ff, 'ns_r_yes');
  a.ifCmpI('lt', R_CH, 0xe000, 'ns_r_no');
  a.ifCmpI('le', R_CH, 0xfefe, 'ns_r_yes');
  a.ifCmpI('lt', R_CH, 0xff00, 'ns_r_no');
  a.ifCmpI('le', R_CH, 0xfffd, 'ns_r_yes');
  a.ifCmpI('lt', R_CH, 0x10000, 'ns_r_no');
  a.ifCmpI('le', R_CH, 0x10ffff, 'ns_r_yes');
  a.label('ns_r_no');
  a.ret();
  a.label('ns_r_yes');
  a.const_(R_RET, 1);
  a.ret();

  a.label('is_indicator_r');
  a.const_(R_RET, 1);
  a.ifCmpI('eq', R_CH, CH('-'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('?'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH(':'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH(','), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('['), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH(']'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('{'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('}'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('#'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('&'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('*'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('!'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('|'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('>'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('\''), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('"'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('%'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('@'), 'ind_r_yes');
  a.ifCmpI('eq', R_CH, CH('`'), 'ind_r_yes');
  a.const_(R_RET, 0);
  a.label('ind_r_yes');
  a.ret();

  a.label('is_wsp_r');
  a.const_(R_RET, 0);
  a.ifCmpI('eq', R_CH, CH(' '), 'wsp_r_yes');
  a.ifCmpI('eq', R_CH, CH('\t'), 'wsp_r_yes');
  a.ret();
  a.label('wsp_r_yes');
  a.const_(R_RET, 1);
  a.ret();

  // is_plain_safe_in_block / in_flow -- CALL_R targets, R_CH in, R_RET out.
  a.label('is_plain_blk');
  a.jmp('is_ns_char_r');
  a.label('is_plain_flw');
  a.call('is_ns_char_r');
  a.ifCmpI('eq', R_RET, 0, 'pflw_no');
  a.ifCmpI('eq', R_CH, CH(','), 'pflw_no');
  a.ifCmpI('eq', R_CH, CH('['), 'pflw_no');
  a.ifCmpI('eq', R_CH, CH(']'), 'pflw_no');
  a.ifCmpI('eq', R_CH, CH('{'), 'pflw_no');
  a.ifCmpI('eq', R_CH, CH('}'), 'pflw_no');
  a.ret();
  a.label('pflw_no');
  a.const_(R_RET, 0);
  a.ret();

  // ======================================================================
  //   char scn_uri_esc / scn_ns_uri_char / scn_ns_tag_char
  // ======================================================================
  a.label('scn_uri_esc');
  a.ifNChar(CH('%'), 'uri_esc_stop');
  mrkEnd();
  adv();
  a.ifNClass(C_HEX, 'uri_esc_fail');
  adv();
  a.ifNClass(C_HEX, 'uri_esc_fail');
  adv();
  a.const_(R_RET, SCN_SUCC);
  a.ret();
  a.label('uri_esc_stop');
  a.const_(R_RET, SCN_STOP);
  a.ret();
  a.label('uri_esc_fail');
  a.const_(R_RET, SCN_FAIL);
  a.ret();

  a.label('scn_ns_uri_char');
  a.ifNClass(C_URI, 'uri_char_esc');
  adv();
  a.const_(R_RET, SCN_SUCC);
  a.ret();
  a.label('uri_char_esc');
  a.jmp('scn_uri_esc');

  a.label('scn_ns_tag_char');
  a.ifNClass(C_TAG, 'tag_char_esc');
  adv();
  a.const_(R_RET, SCN_SUCC);
  a.ret();
  a.label('tag_char_esc');
  a.jmp('scn_uri_esc');

  // ======================================================================
  //   scn_dir_bgn
  // ======================================================================
  a.label('scn_dir_bgn');
  adv();
  a.ifNChar(CH('Y'), 'dir_bgn_T');
  adv();
  a.ifNChar(CH('A'), 'dir_bgn_rsv');
  adv();
  a.ifNChar(CH('M'), 'dir_bgn_rsv');
  adv();
  a.ifNChar(CH('L'), 'dir_bgn_rsv');
  adv();
  a.ifNClass(C_WHT, 'dir_bgn_rsv');
  mrkEnd();
  retSym(S_DIR_YML_BGN);
  a.label('dir_bgn_T');
  a.ifNChar(CH('T'), 'dir_bgn_rsv');
  adv();
  a.ifNChar(CH('A'), 'dir_bgn_rsv');
  adv();
  a.ifNChar(CH('G'), 'dir_bgn_rsv');
  adv();
  a.ifNClass(C_WHT, 'dir_bgn_rsv');
  mrkEnd();
  retSym(S_DIR_TAG_BGN);
  a.label('dir_bgn_rsv');
  a.ifNClass(C_NS_CHAR, 'dir_bgn_end');
  adv();
  a.jmp('dir_bgn_rsv');
  a.label('dir_bgn_end');
  a.ifCmpI('le', R_CUR_COL, 1, 'fail');
  a.ifNClass(C_WHT, 'fail');
  mrkEnd();
  retSym(S_DIR_RSV_BGN);

  // ======================================================================
  //   scn_dir_yml_ver -- n1/n2 in R_N / R_TMP2
  // ======================================================================
  a.label('scn_dir_yml_ver');
  a.const_(R_N, 0);
  a.label('ver_n1');
  a.ifNClass(C_DEC, 'ver_dot');
  adv();
  a.alui('add', R_N, 1);
  a.jmp('ver_n1');
  a.label('ver_dot');
  a.ifNChar(CH('.'), 'fail');
  adv();
  a.const_(R_TMP2, 0);
  a.label('ver_n2');
  a.ifNClass(C_DEC, 'ver_chk');
  adv();
  a.alui('add', R_TMP2, 1);
  a.jmp('ver_n2');
  a.label('ver_chk');
  a.ifCmpI('eq', R_N, 0, 'fail');
  a.ifCmpI('eq', R_TMP2, 0, 'fail');
  mrkEnd();
  retSymR();

  // ======================================================================
  //   scn_tag_hdl_tal -- bool in R_RET
  // ======================================================================
  a.label('scn_tag_hdl_tal');
  a.ifNChar(CH('!'), 'hdl_words');
  adv();
  a.const_(R_RET, 1);
  a.ret();
  a.label('hdl_words');
  a.const_(R_N, 0);
  a.label('hdl_wloop');
  a.ifNClass(C_WORD, 'hdl_after');
  adv();
  a.alui('add', R_N, 1);
  a.jmp('hdl_wloop');
  a.label('hdl_after');
  a.ifCmpI('eq', R_N, 0, 'hdl_true');
  a.ifNChar(CH('!'), 'hdl_false');
  adv();
  a.label('hdl_true');
  a.const_(R_RET, 1);
  a.ret();
  a.label('hdl_false');
  a.const_(R_RET, 0);
  a.ret();

  a.label('scn_dir_tag_hdl');
  a.ifNChar(CH('!'), 'fail');
  adv();
  a.call('scn_tag_hdl_tal');
  a.ifCmpI('eq', R_RET, 0, 'fail');
  mrkEnd();
  retSymR();

  //   scn_dir_tag_pfx: STOP falls into FAIL, both RET_SYM
  a.label('scn_dir_tag_pfx');
  a.ifNChar(CH('!'), 'pfx_tag');
  adv();
  a.jmp('pfx_loop');
  a.label('pfx_tag');
  a.call('scn_ns_tag_char');
  a.ifCmpI('ne', R_RET, SCN_SUCC, 'fail');
  a.label('pfx_loop');
  a.call('scn_ns_uri_char');
  a.ifCmpI('eq', R_RET, SCN_SUCC, 'pfx_loop');
  a.ifCmpI('eq', R_RET, SCN_FAIL, 'pfx_emit');
  mrkEnd();
  a.label('pfx_emit');
  retSymR();

  a.label('scn_dir_rsv_prm');
  a.ifNClass(C_NS_CHAR, 'fail');
  adv();
  a.label('prm_loop');
  a.ifNClass(C_NS_CHAR, 'prm_end');
  adv();
  a.jmp('prm_loop');
  a.label('prm_end');
  mrkEnd();
  retSymR();

  // ======================================================================
  //   scn_tag
  // ======================================================================
  a.label('scn_tag');
  a.ifNChar(CH('!'), 'fail');
  adv();
  a.ifNClass(C_WHT, 'tag_lt');
  mrkEnd();
  retSymR();
  a.label('tag_lt');
  a.ifNChar(CH('<'), 'tag_shorthand');
  adv();
  a.call('scn_ns_uri_char');
  a.ifCmpI('ne', R_RET, SCN_SUCC, 'fail');
  a.label('tag_uri_loop');
  a.call('scn_ns_uri_char');
  a.ifCmpI('eq', R_RET, SCN_SUCC, 'tag_uri_loop');
  a.ifCmpI('eq', R_RET, SCN_FAIL, 'fail');
  // SCN_STOP
  a.ifNChar(CH('>'), 'fail');
  adv();
  mrkEnd();
  retSymR();
  a.label('tag_shorthand');
  a.call('scn_tag_hdl_tal');
  a.ifCmpI('eq', R_RET, 0, 'tag_sh_loop');
  a.call('scn_ns_tag_char');
  a.ifCmpI('ne', R_RET, SCN_SUCC, 'fail');
  a.label('tag_sh_loop');
  a.call('scn_ns_tag_char');
  a.ifCmpI('eq', R_RET, SCN_SUCC, 'tag_sh_loop');
  a.ifCmpI('eq', R_RET, SCN_FAIL, 'tag_sh_emit');
  mrkEnd();
  a.label('tag_sh_emit');
  retSymR();

  // ======================================================================
  //   scn_acr_bgn / scn_acr_ctn / scn_als_bgn / scn_als_ctn
  // ======================================================================
  a.label('scn_acr_bgn');
  a.ifNChar(CH('&'), 'fail');
  adv();
  a.ifNClass(C_NS_ANCHOR, 'fail');
  mrkEnd();
  retSymR();

  a.label('scn_acr_ctn');
  a.label('acr_ctn_loop');
  a.ifNClass(C_NS_ANCHOR, 'acr_ctn_end');
  adv();
  a.jmp('acr_ctn_loop');
  a.label('acr_ctn_end');
  mrkEnd();
  retSymR();

  a.label('scn_als_bgn');
  a.ifNChar(CH('*'), 'fail');
  adv();
  a.ifNClass(C_NS_ANCHOR, 'fail');
  mrkEnd();
  retSymR();

  a.label('scn_als_ctn');
  a.label('als_ctn_loop');
  a.ifNClass(C_NS_ANCHOR, 'als_ctn_end');
  adv();
  a.jmp('als_ctn_loop');
  a.label('als_ctn_end');
  mrkEnd();
  retSymR();

  // ======================================================================
  //   scn_dqt_esc_seq
  // ======================================================================
  a.label('scn_dqt_esc_seq');
  a.ifChar(CH('0'), 'esc_one');
  a.ifChar(CH('a'), 'esc_one');
  a.ifChar(CH('b'), 'esc_one');
  a.ifChar(CH('t'), 'esc_one');
  a.ifChar(CH('\t'), 'esc_one');
  a.ifChar(CH('n'), 'esc_one');
  a.ifChar(CH('v'), 'esc_one');
  a.ifChar(CH('r'), 'esc_one');
  a.ifChar(CH('e'), 'esc_one');
  a.ifChar(CH('f'), 'esc_one');
  a.ifChar(CH(' '), 'esc_one');
  a.ifChar(CH('"'), 'esc_one');
  a.ifChar(CH('/'), 'esc_one');
  a.ifChar(CH('\\'), 'esc_one');
  a.ifChar(CH('N'), 'esc_one');
  a.ifChar(CH('_'), 'esc_one');
  a.ifChar(CH('L'), 'esc_one');
  a.ifChar(CH('P'), 'esc_one');
  a.ifChar(CH('U'), 'esc_U');
  a.ifChar(CH('u'), 'esc_u');
  a.ifChar(CH('x'), 'esc_x');
  a.jmp('fail');
  a.label('esc_one');
  adv();
  a.jmp('esc_done');
  a.label('esc_U');
  adv();
  a.const_(R_N, 8);
  a.jmp('esc_hex');
  a.label('esc_u');
  adv();
  a.const_(R_N, 4);
  a.jmp('esc_hex');
  a.label('esc_x');
  adv();
  a.const_(R_N, 2);
  a.label('esc_hex');
  a.ifCmpI('eq', R_N, 0, 'esc_done');
  a.ifNClass(C_HEX, 'fail');
  adv();
  a.alui('sub', R_N, 1);
  a.jmp('esc_hex');
  a.label('esc_done');
  mrkEnd();
  retSymR();

  // ======================================================================
  //   scn_drs_doc_end -- bool in R_RET. May adv and mrk_end on a partial match.
  // ======================================================================
  a.label('scn_drs_doc_end');
  a.ifChar(CH('-'), 'drs_go');
  a.ifChar(CH('.'), 'drs_go');
  a.const_(R_RET, 0);
  a.ret();
  a.label('drs_go');
  a.lookahead(R_N);                        // delimiter
  adv();
  a.lookahead(R_CH);
  a.ifCmp('ne', R_CH, R_N, 'drs_partial');
  adv();
  a.lookahead(R_CH);
  a.ifCmp('ne', R_CH, R_N, 'drs_partial');
  adv();
  a.ifNClass(C_WHT, 'drs_partial');
  a.const_(R_RET, 1);
  a.ret();
  a.label('drs_partial');
  mrkEnd();
  a.const_(R_RET, 0);
  a.ret();

  // ======================================================================
  //   scn_dqt_str_cnt / scn_sqt_str_cnt -- if-style: emit or ret
  // ======================================================================
  a.label('scn_dqt_str_cnt');
  a.ifNClass(C_NB_DOUBLE, 'cnt_no');
  a.ifCmpI('ne', R_CUR_COL, 0, 'dqt_adv');
  a.call('scn_drs_doc_end');
  a.ifCmpI('eq', R_RET, 0, 'dqt_adv');
  mrkEnd();
  a.ifCmpI('eq', R_CUR_CHR, CH('-'), 'dqt_drs');
  retSym(S_DOC_END);
  a.label('dqt_drs');
  retSym(S_DRS_END);
  a.label('dqt_adv');
  adv();
  a.label('dqt_loop');
  a.ifNClass(C_NB_DOUBLE, 'dqt_end');
  adv();
  a.jmp('dqt_loop');
  a.label('dqt_end');
  mrkEnd();
  retSymR();
  a.label('cnt_no');
  a.ret();

  a.label('scn_sqt_str_cnt');
  a.ifNClass(C_NB_SINGLE, 'cnt_no');
  a.ifCmpI('ne', R_CUR_COL, 0, 'sqt_adv');
  a.call('scn_drs_doc_end');
  a.ifCmpI('eq', R_RET, 0, 'sqt_adv');
  mrkEnd();
  a.ifCmpI('eq', R_CUR_CHR, CH('-'), 'sqt_drs');
  retSym(S_DOC_END);
  a.label('sqt_drs');
  retSym(S_DRS_END);
  a.label('sqt_adv');
  adv();
  a.label('sqt_loop');
  a.ifNClass(C_NB_SINGLE, 'sqt_end');
  adv();
  a.jmp('sqt_loop');
  a.label('sqt_end');
  mrkEnd();
  retSymR();

  // ======================================================================
  //   scn_blk_str_bgn -- local `ind` in R_N, local cur_ind re-peeked to R_TMP2
  // ======================================================================
  a.label('scn_blk_str_bgn');
  a.ifChar(CH('|'), 'bsb_go');
  a.ifChar(CH('>'), 'bsb_go');
  a.jmp('fail');
  a.label('bsb_go');
  adv();
  a.peek(S_LEN, R_TMP2, 0);                // cur_ind
  a.const_(R_N, -1);                       // ind
  a.lookahead(R_CH);
  a.ifCmpI('lt', R_CH, CH('1'), 'bsb_chom');
  a.ifCmpI('gt', R_CH, CH('9'), 'bsb_chom');
  a.mov(R_N, R_CH);
  a.alui('sub', R_N, CH('1'));
  adv();
  a.ifChar(CH('+'), 'bsb_chom_adv');
  a.ifChar(CH('-'), 'bsb_chom_adv');
  a.jmp('bsb_wht');
  a.label('bsb_chom_adv');
  adv();
  a.jmp('bsb_wht');
  a.label('bsb_chom');
  a.ifChar(CH('+'), 'bsb_chom2');
  a.ifChar(CH('-'), 'bsb_chom2');
  a.jmp('bsb_wht');
  a.label('bsb_chom2');
  adv();
  a.lookahead(R_CH);
  a.ifCmpI('lt', R_CH, CH('1'), 'bsb_wht');
  a.ifCmpI('gt', R_CH, CH('9'), 'bsb_wht');
  a.mov(R_N, R_CH);
  a.alui('sub', R_N, CH('1'));
  adv();
  a.label('bsb_wht');
  a.ifNClass(C_WHT, 'fail');
  mrkEnd();
  a.ifCmpI('eq', R_N, -1, 'bsb_scan');
  a.alu('add', R_N, R_TMP2);
  a.jmp('bsb_push');
  a.label('bsb_scan');
  a.mov(R_N, R_TMP2);
  a.label('bsb_wsp');
  a.ifNClass(C_WSP, 'bsb_hash');
  adv();
  a.jmp('bsb_wsp');
  a.label('bsb_hash');
  a.ifNChar(CH('#'), 'bsb_nwl');
  adv();
  a.label('bsb_hash_loop');
  a.ifClass(C_NWL, 'bsb_nwl');
  a.ifChar(0, 'bsb_nwl');
  adv();
  a.jmp('bsb_hash_loop');
  a.label('bsb_nwl');
  a.ifNClass(C_NWL, 'bsb_body');
  advNwl();
  a.label('bsb_body');
  a.ifChar(0, 'bsb_push');
  a.ifNChar(CH(' '), 'bsb_body_nwl');
  adv();
  a.jmp('bsb_body');
  a.label('bsb_body_nwl');
  a.ifNClass(C_NWL, 'bsb_body_other');
  a.mov(R_TMP, R_CUR_COL);
  a.alui('sub', R_TMP, 1);
  a.ifCmp('lt', R_TMP, R_N, 'bsb_push');
  a.mov(R_N, R_TMP);
  advNwl();
  a.jmp('bsb_body');
  a.label('bsb_body_other');
  a.mov(R_TMP, R_CUR_COL);
  a.alui('sub', R_TMP, 1);
  a.ifCmp('le', R_TMP, R_N, 'bsb_push');
  a.mov(R_N, R_TMP);
  a.label('bsb_push');
  pushInd(IND_STR, R_N);
  retSymR();

  // ======================================================================
  //   scn_blk_str_cnt -- if-style
  // ======================================================================
  a.label('scn_blk_str_cnt');
  a.ifNClass(C_NS_CHAR, 'cnt_no');
  a.ifCmpI('ne', R_CUR_COL, 0, 'bsc_adv');
  a.call('scn_drs_doc_end');
  a.ifCmpI('eq', R_RET, 0, 'bsc_adv');
  popIndOrFail();
  retSym(BL);
  a.label('bsc_adv');
  adv();
  mrkEnd();
  a.label('bsc_loop');
  a.ifNClass(C_NS_CHAR, 'bsc_wsp');
  adv();
  a.label('bsc_ns');
  a.ifNClass(C_NS_CHAR, 'bsc_mrk');
  adv();
  a.jmp('bsc_ns');
  a.label('bsc_mrk');
  mrkEnd();
  a.label('bsc_wsp');
  a.ifNClass(C_WSP, 'bsc_end');
  adv();
  a.label('bsc_wsp_loop');
  a.ifNClass(C_WSP, 'bsc_loop');
  adv();
  a.jmp('bsc_wsp_loop');
  a.label('bsc_end');
  retSymR();

  // ======================================================================
  //   scn_pln_cnt -- R_FN is the is_plain_safe index. Returns SCN_*.
  //   Locals: R_LEAD_SP=cur_wsp, R_PRT_IND=cur_saf, R_TMP2=lka_wsp, R_N=lka_saf
  //   (parent indent / leading_spaces are finished with before this call).
  // ======================================================================
  a.label('scn_pln_cnt');
  a.mov(R_CH, R_CUR_CHR);
  a.call('is_wsp_r');
  a.mov(R_LEAD_SP, R_RET);
  a.mov(R_CH, R_CUR_CHR);
  a.callR(R_FN);
  a.mov(R_PRT_IND, R_RET);
  a.lookahead(R_CH);
  a.call('is_wsp_r');
  a.mov(R_TMP2, R_RET);
  a.lookahead(R_CH);
  a.callR(R_FN);
  a.mov(R_N, R_RET);
  a.ifCmpI('ne', R_N, 0, 'pln_loop');
  a.ifCmpI('ne', R_TMP2, 0, 'pln_loop');
  a.const_(R_RET, SCN_STOP);
  a.ret();
  a.label('pln_loop');
  // if (is_lka_saf && la != '#' && la != ':')
  a.ifCmpI('eq', R_N, 0, 'pln_hash');
  a.ifChar(CH('#'), 'pln_hash');
  a.ifChar(CH(':'), 'pln_hash');
  adv();
  mrkEnd();
  a.call('adv_sch');
  a.jmp('pln_next');
  a.label('pln_hash');
  // else if (is_cur_saf && la == '#')
  a.ifCmpI('eq', R_PRT_IND, 0, 'pln_wsp');
  a.ifNChar(CH('#'), 'pln_wsp');
  adv();
  mrkEnd();
  a.call('adv_sch');
  a.jmp('pln_next');
  a.label('pln_wsp');
  // else if (is_lka_wsp)
  a.ifCmpI('eq', R_TMP2, 0, 'pln_colon');
  adv();
  a.call('adv_sch');
  a.jmp('pln_next');
  a.label('pln_colon');
  // else if (la == ':') adv; // check later
  a.ifNChar(CH(':'), 'pln_break');
  adv();
  a.jmp('pln_next');
  a.label('pln_break');
  a.const_(R_RET, SCN_SUCC);
  a.ret();
  a.label('pln_next');
  a.mov(R_LEAD_SP, R_TMP2);
  a.mov(R_PRT_IND, R_N);
  a.lookahead(R_CH);
  a.call('is_wsp_r');
  a.mov(R_TMP2, R_RET);
  a.lookahead(R_CH);
  a.callR(R_FN);
  a.mov(R_N, R_RET);
  a.ifCmpI('ne', R_CUR_CHR, CH(':'), 'pln_loop');
  a.ifCmpI('eq', R_N, 0, 'pln_fail');
  mrkEnd();
  a.call('adv_sch');
  a.jmp('pln_loop');
  a.label('pln_fail');
  a.const_(R_RET, SCN_FAIL);
  a.ret();

  // ======================================================================
  //   adv_sch_stt(sch_stt, cur_chr, &rlt_sch) -- schema.core.c
  // ======================================================================
  a.label('adv_sch');
  a.ifCmpI('eq', R_SCH_STT, SCH_STT_FRZ, 'as_break');
  a.ifCmpI('eq', R_SCH_STT, 0, 'as_0');
  a.ifCmpI('eq', R_SCH_STT, 1, 'as_1');
  a.ifCmpI('eq', R_SCH_STT, 2, 'as_2');
  a.ifCmpI('eq', R_SCH_STT, 3, 'as_3');
  a.ifCmpI('eq', R_SCH_STT, 4, 'as_4');
  a.ifCmpI('eq', R_SCH_STT, 5, 'as_5');
  a.ifCmpI('eq', R_SCH_STT, 6, 'as_6');
  a.ifCmpI('eq', R_SCH_STT, 7, 'as_7');
  a.ifCmpI('eq', R_SCH_STT, 8, 'as_8');
  a.ifCmpI('eq', R_SCH_STT, 9, 'as_9');
  a.ifCmpI('eq', R_SCH_STT, 10, 'as_10');
  a.ifCmpI('eq', R_SCH_STT, 11, 'as_11');
  a.ifCmpI('eq', R_SCH_STT, 12, 'as_12');
  a.ifCmpI('eq', R_SCH_STT, 13, 'as_13');
  a.ifCmpI('eq', R_SCH_STT, 14, 'as_14');
  a.ifCmpI('eq', R_SCH_STT, 15, 'as_15');
  a.ifCmpI('eq', R_SCH_STT, 16, 'as_16');
  a.ifCmpI('eq', R_SCH_STT, 17, 'as_17');
  a.ifCmpI('eq', R_SCH_STT, 18, 'as_18');
  a.ifCmpI('eq', R_SCH_STT, 19, 'as_19');
  a.ifCmpI('eq', R_SCH_STT, 20, 'as_20');
  a.ifCmpI('eq', R_SCH_STT, 21, 'as_21');
  a.ifCmpI('eq', R_SCH_STT, 22, 'as_22');
  a.ifCmpI('eq', R_SCH_STT, 23, 'as_23');
  a.ifCmpI('eq', R_SCH_STT, 24, 'as_24');
  a.ifCmpI('eq', R_SCH_STT, 25, 'as_25');
  a.ifCmpI('eq', R_SCH_STT, 26, 'as_26');
  a.ifCmpI('eq', R_SCH_STT, 27, 'as_27');
  a.ifCmpI('eq', R_SCH_STT, 28, 'as_28');
  a.ifCmpI('eq', R_SCH_STT, 29, 'as_29');
  a.ifCmpI('eq', R_SCH_STT, 30, 'as_30');
  a.ifCmpI('eq', R_SCH_STT, 31, 'as_31');
  a.ifCmpI('eq', R_SCH_STT, 32, 'as_32');
  a.ifCmpI('eq', R_SCH_STT, 33, 'as_33');
  a.ifCmpI('eq', R_SCH_STT, 34, 'as_34');
  a.ifCmpI('eq', R_SCH_STT, 35, 'as_35');
  a.ifCmpI('eq', R_SCH_STT, 36, 'as_36');
  a.ifCmpI('eq', R_SCH_STT, 37, 'as_37');
  a.ifCmpI('eq', R_SCH_STT, 38, 'as_38');
  a.ifCmpI('eq', R_SCH_STT, 39, 'as_39');
  a.ifCmpI('eq', R_SCH_STT, 40, 'as_40');
  a.ifCmpI('eq', R_SCH_STT, 41, 'as_41');
  a.ifCmpI('eq', R_SCH_STT, 42, 'as_42');
  a.ifCmpI('eq', R_SCH_STT, 43, 'as_43');
  // default: *rlt_sch = RS_STR; return FRZ;
  a.const_(R_RLT_SCH, RS_STR);
  a.const_(R_SCH_STT, SCH_STT_FRZ);
  a.ret();

  a.label('as_0');
  asEq('.', RS_STR, 6);
  asEq('0', RS_INT, 37);
  asEq('F', RS_STR, 2);
  asEq('N', RS_STR, 16);
  asEq('T', RS_STR, 13);
  asEq('f', RS_STR, 17);
  asEq('n', RS_STR, 29);
  asEq('t', RS_STR, 26);
  asEq('~', RS_NULL, 35);
  asEq('+', RS_STR, 1);
  asEq('-', RS_STR, 1);
  asRange('1', '9', RS_INT, 38);
  a.jmp('as_break');
  a.label('as_1');
  asEq('.', RS_STR, 7);
  asRange('0', '9', RS_INT, 38);
  a.jmp('as_break');
  a.label('as_2');
  asEq('A', RS_STR, 9);
  asEq('a', RS_STR, 22);
  a.jmp('as_break');
  a.label('as_3');
  asEq('A', RS_STR, 12);
  asEq('a', RS_STR, 12);
  a.jmp('as_break');
  a.label('as_4');
  asEq('E', RS_BOOL, 36);
  a.jmp('as_break');
  a.label('as_5');
  asEq('F', RS_FLOAT, 41);
  a.jmp('as_break');
  a.label('as_6');
  asEq('I', RS_STR, 11);
  asEq('N', RS_STR, 3);
  asEq('i', RS_STR, 24);
  asEq('n', RS_STR, 18);
  asRange('0', '9', RS_FLOAT, 42);
  a.jmp('as_break');
  a.label('as_7');
  asEq('I', RS_STR, 11);
  asEq('i', RS_STR, 24);
  asRange('0', '9', RS_FLOAT, 42);
  a.jmp('as_break');
  a.label('as_8');
  asEq('L', RS_NULL, 35);
  a.jmp('as_break');
  a.label('as_9');
  asEq('L', RS_STR, 14);
  a.jmp('as_break');
  a.label('as_10');
  asEq('L', RS_STR, 8);
  a.jmp('as_break');
  a.label('as_11');
  asEq('N', RS_STR, 5);
  asEq('n', RS_STR, 20);
  a.jmp('as_break');
  a.label('as_12');
  asEq('N', RS_FLOAT, 41);
  a.jmp('as_break');
  a.label('as_13');
  asEq('R', RS_STR, 15);
  asEq('r', RS_STR, 28);
  a.jmp('as_break');
  a.label('as_14');
  asEq('S', RS_STR, 4);
  a.jmp('as_break');
  a.label('as_15');
  asEq('U', RS_STR, 4);
  a.jmp('as_break');
  a.label('as_16');
  asEq('U', RS_STR, 10);
  asEq('u', RS_STR, 23);
  a.jmp('as_break');
  a.label('as_17');
  asEq('a', RS_STR, 22);
  a.jmp('as_break');
  a.label('as_18');
  asEq('a', RS_STR, 25);
  a.jmp('as_break');
  a.label('as_19');
  asEq('e', RS_BOOL, 36);
  a.jmp('as_break');
  a.label('as_20');
  asEq('f', RS_FLOAT, 41);
  a.jmp('as_break');
  a.label('as_21');
  asEq('l', RS_NULL, 35);
  a.jmp('as_break');
  a.label('as_22');
  asEq('l', RS_STR, 27);
  a.jmp('as_break');
  a.label('as_23');
  asEq('l', RS_STR, 21);
  a.jmp('as_break');
  a.label('as_24');
  asEq('n', RS_STR, 20);
  a.jmp('as_break');
  a.label('as_25');
  asEq('n', RS_FLOAT, 41);
  a.jmp('as_break');
  a.label('as_26');
  asEq('r', RS_STR, 28);
  a.jmp('as_break');
  a.label('as_27');
  asEq('s', RS_STR, 19);
  a.jmp('as_break');
  a.label('as_28');
  asEq('u', RS_STR, 19);
  a.jmp('as_break');
  a.label('as_29');
  asEq('u', RS_STR, 23);
  a.jmp('as_break');
  a.label('as_30');
  asOr(['+', '-'], RS_STR, 32);
  asRange('0', '9', RS_FLOAT, 43);
  a.jmp('as_break');
  a.label('as_31');
  asRange('0', '7', RS_INT, 39);
  a.jmp('as_break');
  a.label('as_32');
  asRange('0', '9', RS_FLOAT, 43);
  a.jmp('as_break');
  a.label('as_33');
  asRange('0', '9', RS_INT, 40);
  asRange('A', 'F', RS_INT, 40);
  asRange('a', 'f', RS_INT, 40);
  a.jmp('as_break');
  a.label('as_34');
  a.jmp('fail');                            // abort()
  a.label('as_35');
  a.const_(R_RLT_SCH, RS_NULL);
  a.jmp('as_break');
  a.label('as_36');
  a.const_(R_RLT_SCH, RS_BOOL);
  a.jmp('as_break');
  a.label('as_37');
  a.const_(R_RLT_SCH, RS_INT);
  asEq('.', RS_FLOAT, 42);
  asEq('o', RS_STR, 31);
  asEq('x', RS_STR, 33);
  asOr(['E', 'e'], RS_STR, 30);
  asRange('0', '9', RS_INT, 38);
  a.jmp('as_break');
  a.label('as_38');
  a.const_(R_RLT_SCH, RS_INT);
  asEq('.', RS_FLOAT, 42);
  asOr(['E', 'e'], RS_STR, 30);
  asRange('0', '9', RS_INT, 38);
  a.jmp('as_break');
  a.label('as_39');
  a.const_(R_RLT_SCH, RS_INT);
  asRange('0', '7', RS_INT, 39);
  a.jmp('as_break');
  a.label('as_40');
  a.const_(R_RLT_SCH, RS_INT);
  asRange('0', '9', RS_INT, 40);
  asRange('A', 'F', RS_INT, 40);
  asRange('a', 'f', RS_INT, 40);
  a.jmp('as_break');
  a.label('as_41');
  a.const_(R_RLT_SCH, RS_FLOAT);
  a.jmp('as_break');
  a.label('as_42');
  a.const_(R_RLT_SCH, RS_FLOAT);
  asOr(['E', 'e'], RS_STR, 30);
  asRange('0', '9', RS_FLOAT, 42);
  a.jmp('as_break');
  a.label('as_43');
  a.const_(R_RLT_SCH, RS_FLOAT);
  asRange('0', '9', RS_FLOAT, 43);
  a.jmp('as_break');

  a.label('as_break');
  a.ifCmpI('eq', R_CUR_CHR, CH('\r'), 'as_keep');
  a.ifCmpI('eq', R_CUR_CHR, CH('\n'), 'as_keep');
  a.ifCmpI('eq', R_CUR_CHR, CH(' '), 'as_keep');
  a.ifCmpI('eq', R_CUR_CHR, 0, 'as_keep');
  a.const_(R_RLT_SCH, RS_STR);
  a.label('as_keep');
  a.const_(R_SCH_STT, SCH_STT_FRZ);
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
