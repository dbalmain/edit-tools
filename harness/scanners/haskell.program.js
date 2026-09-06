// tree-sitter-haskell's scanner, hand-compiled to scanner-VM bytecode.
// Upstream source is reproduced in comments so the two can be diffed by eye;
// that is the only review this port gets.
//
// The largest of the sixteen, and the one that spent opcode 0x06 (GET_COLUMN)
// and forced IF_CLASS_R: peek() returns a cached codepoint while the lexer's
// lookahead has already moved on, so IF_CLASS would classify the wrong
// character. Layout indent at an interior token is
// `get_column() - lookahead.size`.
//
// ## State
//
// Upstream serializes `Persist { unsigned contexts; Newline newline; }` then
// the `Context { sort, indent }` array. `#ifdef TREE_SITTER_DEBUG` also writes
// `parse`; the recorded traces are a non-debug build (empty state is 20 bytes
// = sizeof(Persist) without that field).
//
//   stack 0  Context.sort, persistent
//   stack 1  Context.indent, persistent
//   stack 2  lookahead.contents, transient -- only peek-driven advances
//
// Newline scalars are persistent registers. Empty deserialize is VM reset
// (all zeros), but upstream's empty deserialize sets `newline.state = NResume`
// rather than NInactive. The encoding swaps those two tags so 0 is NResume:
//
//   0 NResume    1 NInit    2 NProcess    3 NInactive
//
// NInit and NProcess keep their upstream values. reset_newline writes 3, not 0.
//
// Lookahead.size is a transient register, not stack 2's length. take_line,
// consume_block_comment, take_line_escaped_newline and qq_body can advance
// past STACK_MAX (corpus max is 317 A-ops in one scan); those loops use PEEK
// not peek() and reset_lookahead before anything reads the body, so they
// increment size without pushing. Peek-driven advances still push.
'use strict';
const fs = require('fs');
const path = require('path');
const { Asm } = require('../../spike/scanner-vm/asm.js');

const UNI = JSON.parse(fs.readFileSync(path.join(__dirname, 'haskell_unicode.json'), 'utf8')).classes;

// Upstream's `typedef enum { FAIL, SEMICOLON, ... UPDATE }` -- order is
// load-bearing: valid_symbols is indexed by it. 49 symbols.
const FAIL = 0;
const SEMICOLON = 1;
const START = 2;
const START_DO = 3;
const START_CASE = 4;
const START_IF = 5;
const START_LET = 6;
const START_QUOTE = 7;
const START_EXPLICIT = 8;
const END = 9;
const END_EXPLICIT = 10;
const START_BRACE = 11;
const END_BRACE = 12;
const START_TEXP = 13;
const END_TEXP = 14;
const WHERE = 15;
const IN = 16;
const ARROW = 17;
const BAR = 18;
const DERIVING = 19;
const COMMENT = 20;
const HADDOCK = 21;
const CPP = 22;
const PRAGMA = 23;
const QQ_START = 24;
const QQ_BODY = 25;
const SPLICE = 26;
const QUAL_DOT = 27;
const TIGHT_DOT = 28;
const PREFIX_DOT = 29;
const DOTDOT = 30;
const TIGHT_AT = 31;
const PREFIX_AT = 32;
const TIGHT_BANG = 33;
const PREFIX_BANG = 34;
const TIGHT_TILDE = 35;
const PREFIX_TILDE = 36;
const PREFIX_PERCENT = 37;
const QUALIFIED_OP = 38;
const LEFT_SECTION_OP = 39;
const NO_SECTION_OP = 40;
const MINUS = 41;
const CONTEXT = 42;
const INFIX = 43;
const DATA_INFIX = 44;
const TYPE_INSTANCE = 45;
const VARSYM = 46;
const CONSYM = 47;
const UPDATE = 48;

// ContextSort. `< Braces` is a layout; `< MultiWayIfLayout` needs semicolons.
const DeclLayout = 0;
const DoLayout = 1;
const CaseLayout = 2;
const LetLayout = 3;
const QuoteLayout = 4;
const MultiWayIfLayout = 5;
const Braces = 6;
const TExp = 7;
const ModuleHeader = 8;
const NoContext = 9;

// Lexed.
const LNothing = 0;
const LEof = 1;
const LWhere = 2;
const LIn = 3;
const LThen = 4;
const LElse = 5;
const LDeriving = 6;
const LModule = 7;
const LUpper = 8;
const LTick = 9;
const LSymop = 10;
const LSymopSpecial = 11;
const LDotDot = 12;
const LDotId = 13;
const LDotSymop = 14;
const LDotOpen = 15;
const LDollar = 16;
const LBang = 17;
const LTilde = 18;
const LAt = 19;
const LPercent = 20;
const LHash = 21;
const LBar = 22;
const LArrow = 23;
const LCArrow = 24;
const LTexpCloser = 25;
const LQuoteClose = 26;
const LPragma = 27;
const LBlockComment = 28;
const LLineComment = 29;
const LBraceClose = 30;
const LBraceOpen = 31;
const LBracketOpen = 32;
const LUnboxedClose = 33;
const LSemi = 34;
const LCppElse = 35;
const LCpp = 36;

// NewlineState, swapped so empty deserialize (all zeros) is NResume.
const NResume = 0;
const NInit = 1;
const NProcess = 2;
const NInactive = 3;

const NoSpace = 0;
const Indented = 1;
const BOL = 2;

const CppNothing = 0;
const CppStart = 1;
const CppElse = 2;
const CppEnd = 3;
const CppOther = 4;

const CtrUndecided = 0;
const CtrImpossible = 1;
const CtrArrowFound = 2;
const CtrInfixFound = 3;
const CtrEqualsFound = 4;
const CtrBarFound = 5;

const NoQualifiedName = 0;
const QualifiedTarget = 1;
const QualifiedConid = 2;

// Classes.
const C_SPACE = 0;
const C_NEWLINE = 1;
const C_ID = 2;
const C_INNER = 3;
const C_VARID = 4;
const C_CONID = 5;
const C_SYMOP = 6;
const C_QUOTER = 7;
const C_SPC_TAB = 8;

const S_SORT = 0;
const S_INDENT = 1;
const S_LA = 2;

// Persistent: 0..6. Transient: the rest, zeroed each scan (lookahead reset).
const R_NL_STATE = 0;
const R_NL_END = 1;
const R_NL_INDENT = 2;
const R_NL_EOF = 3;
const R_NL_NO_SEMI = 4;
const R_NL_SKIP_SEMI = 5;
const R_NL_UNSAFE = 6;
const R_LA_OFF = 7;
const R_LA_SIZE = 8;
const R_SYMOP = 9;
const R_PEEK = 10;
const R_REL = 11;
const R_ABS = 12;
const R_I = 13;
const R_N = 14;
const R_TMP = 15;
const R_TMP2 = 16;
const R_NEXT = 17;
const R_RESULT = 18;
const R_WS = 19;
const R_SORT = 20;
const R_INDENT = 21;
const R_SYM = 22;
const R_NEST = 23;
const R_LEVEL = 24;
const R_COL = 25;
const R_BOL = 26;
const R_CTR_RESET = 27;
const R_BRACKETS = 28;
const R_FLAGS = 29;
const R_SAVED = 30;
const R_OK = 31;

const CH = (c) => c.codePointAt(0);
const STACK_MAX = 256;

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
const one = (c) => [typeof c === 'number' ? c : CH(c), typeof c === 'number' ? c : CH(c)];

function subtract(list, drop) {
  const dropSet = new Set(drop);
  const out = [];
  for (let i = 0; i < list.length; i += 2) {
    let lo = list[i], hi = list[i + 1];
    for (let c = lo; c <= hi; c++) {
      if (dropSet.has(c)) {
        if (lo <= c - 1) out.push(lo, c - 1);
        lo = c + 1;
      }
    }
    if (lo <= hi) out.push(lo, hi);
  }
  return out;
}

function build() {
  const a = new Asm();
  let uid = 0;
  const U = (s) => `${s}_${uid++}`;

  // ---- tiny emitters -------------------------------------------------------
  const peekAt = (rel) => { a.const_(R_REL, rel); a.call('peek'); };
  const seq = (s, yes, no) => {
    for (let i = 0; i < s.length; i++) {
      const ok = U('sq');
      peekAt(i);
      a.ifCmpI('eq', R_PEEK, s.charCodeAt(i), ok);
      a.jmp(no);
      a.label(ok);
    }
    peekAt(s.length);
    a.jmp(yes);
  };
  const token = (s, yes, no) => {
    const hit = U('tk');
    seq(s, hit, no);
    a.label(hit);
    peekAt(s.length);
    a.ifClassR(C_INNER, R_PEEK, no);
    a.jmp(yes);
  };
  const finish = (sym) => { a.const_(R_RESULT, sym); a.ret(); };
  const emitOrFail = () => {
    a.ifCmpI('eq', R_RESULT, FAIL, 'fail');
    a.emitR(R_RESULT);
  };

  // ======================================================================
  // scan / scan_main / process_result
  // ======================================================================
  a.label('entry');
  //   if (after_error(env)) return false;   // valid(FAIL)
  a.ifValid(FAIL, 'fail');
  a.call('scan_main');
  a.call('process_result');
  emitOrFail();

  a.label('fail');
  a.fail();

  // static bool process_result(Env *env, Symbol result)
  a.label('process_result');
  a.ifCmpI('ne', R_RESULT, FAIL, 'pr_ok');
  a.ifNEof('pr_ok');
  a.ifCmpI('ne', R_LA_SIZE, 0, 'pr_ok');
  a.markEnd();
  a.ifNValid(END, 'pr_semi');
  a.call('end_layout_unchecked');
  a.ret();
  a.label('pr_semi');
  a.ifNValid(SEMICOLON, 'pr_force');
  a.const_(R_RESULT, SEMICOLON);
  a.ret();
  a.label('pr_force');
  a.call('force_end_context');
  a.ret();
  a.label('pr_ok');
  a.ret();

  // static Symbol scan_main(Env *env)
  a.label('scan_main');
  a.markEnd();
  a.call('pre_ws_commands');
  a.ifCmpI('ne', R_RESULT, FAIL, 'sm_ret');
  a.call('skip_space');
  a.mov(R_WS, R_OK);
  a.ifClass(C_NEWLINE, 'sm_nl');
  a.ifEof('sm_ret');
  a.call('interior');
  a.label('sm_ret');
  a.ret();
  a.label('sm_nl');
  a.call('newline_start');
  a.ret();

  // static Symbol pre_ws_commands(Env *env)
  a.label('pre_ws_commands');
  a.call('texp_context');
  a.ifCmpI('ne', R_RESULT, FAIL, 'pws_ret');
  a.call('start_brace');
  a.ifCmpI('ne', R_RESULT, FAIL, 'pws_ret');
  a.call('end_brace');
  a.ifCmpI('ne', R_RESULT, FAIL, 'pws_ret');
  a.ifNValid(QQ_BODY, 'pws_nl');
  a.call('qq_body');
  a.ret();
  a.label('pws_nl');
  // newline_active: NInit || NProcess
  a.ifCmpI('eq', R_NL_STATE, NInit, 'pws_post');
  a.ifCmpI('eq', R_NL_STATE, NProcess, 'pws_post');
  a.ifCmpI('eq', R_NL_STATE, NResume, 'pws_resume');
  a.const_(R_RESULT, FAIL);
  a.ret();
  a.label('pws_post');
  a.call('newline_post');
  a.ret();
  a.label('pws_resume');
  a.call('newline_resume');
  a.label('pws_ret');
  a.ret();

  // ======================================================================
  // Lookahead primitives
  // ======================================================================

  // S_ADVANCE: if (not_eof) { push PEEK; lexer.advance(false); size++ }
  // When the stack is at cap, skip the push (consume loops). Peek-driven
  // fills stay well under 256.
  a.label('do_advance');
  a.ifEof('da_ret');
  a.lookahead(R_TMP);
  a.len(S_LA, R_TMP2);
  a.ifCmpI('ge', R_TMP2, STACK_MAX, 'da_nopush');
  a.push(S_LA, R_TMP);
  a.label('da_nopush');
  a.advance();
  a.alui('add', R_LA_SIZE, 1);
  a.label('da_ret');
  a.ret();

  // Count-only advance for take_line / comments / cpp / qq_body.
  a.label('do_advance_count');
  a.ifEof('dac_ret');
  a.advance();
  a.alui('add', R_LA_SIZE, 1);
  a.label('dac_ret');
  a.ret();

  // advance_over_abs(R_ABS): for i = size; i <= abs; i++ S_ADVANCE
  a.label('advance_over_abs');
  a.mov(R_I, R_LA_SIZE);
  a.label('aoa_loop');
  a.ifCmp('gt', R_I, R_ABS, 'aoa_ret');
  a.call('do_advance');
  a.alui('add', R_I, 1);
  a.jmp('aoa_loop');
  a.label('aoa_ret');
  a.ret();

  // peek(R_REL) -> R_PEEK. Matches scanner.c peek().
  a.label('peek');
  a.mov(R_ABS, R_LA_OFF);
  a.alu('add', R_ABS, R_REL);
  a.len(S_LA, R_TMP);
  a.ifCmp('ge', R_ABS, R_TMP, 'pk_fill');
  a.getidx(S_LA, R_PEEK, R_ABS);
  a.ret();
  a.label('pk_fill');
  a.ifCmpI('eq', R_ABS, 0, 'pk_front');
  a.alui('sub', R_ABS, 1);
  a.call('advance_over_abs');
  a.mov(R_ABS, R_LA_OFF);
  a.alu('add', R_ABS, R_REL);
  a.label('pk_front');
  a.ifEof('pk_zero');
  a.lookahead(R_PEEK);
  a.ret();
  a.label('pk_zero');
  a.const_(R_PEEK, 0);
  a.ret();

  // unsafe_peek(R_REL) -> R_PEEK, 0 if abs >= stored length.
  a.label('unsafe_peek');
  a.mov(R_ABS, R_LA_OFF);
  a.alu('add', R_ABS, R_REL);
  a.len(S_LA, R_TMP);
  a.ifCmp('ge', R_ABS, R_TMP, 'up_zero');
  a.getidx(S_LA, R_PEEK, R_ABS);
  a.ret();
  a.label('up_zero');
  a.const_(R_PEEK, 0);
  a.ret();

  // skip_over(R_REL)
  a.label('skip_over');
  a.ifCmp('le', R_LA_OFF, R_LA_SIZE, 'so_skip');
  a.mov(R_ABS, R_LA_OFF);
  a.alui('sub', R_ABS, 1);
  a.call('advance_over_abs');
  a.label('so_skip');
  a.mov(R_ABS, R_LA_OFF);
  a.alu('add', R_ABS, R_REL);
  a.mov(R_I, R_LA_SIZE);
  a.label('so_loop');
  a.ifCmp('gt', R_I, R_ABS, 'so_ret');
  a.skip();
  a.alui('add', R_I, 1);
  a.jmp('so_loop');
  a.label('so_ret');
  a.ret();

  // reset_lookahead_abs(R_ABS)
  a.label('reset_abs');
  a.mov(R_LA_OFF, R_ABS);
  a.const_(R_SYMOP, 0);
  a.ret();

  // reset_lookahead(): offset = size
  a.label('reset_la');
  a.mov(R_LA_OFF, R_LA_SIZE);
  a.const_(R_SYMOP, 0);
  a.ret();

  // reset_lookahead_to(R_REL): offset += rel
  a.label('reset_to');
  a.alu('add', R_LA_OFF, R_REL);
  a.const_(R_SYMOP, 0);
  a.ret();

  // advance_while class k starting at R_REL -> R_N. Class-tested at the
  // frontier (each peek(i) with size==i).
  const advWhile = (cls, name) => {
    a.label(name);
    a.mov(R_N, R_REL);
    const loop = name + '_loop';
    const done = name + '_done';
    a.label(loop);
    a.mov(R_REL, R_N);
    a.call('peek');
    a.ifNClassR(cls, R_PEEK, done);
    a.alui('add', R_N, 1);
    a.jmp(loop);
    a.label(done);
    a.ret();
  };
  advWhile(C_INNER, 'aw_inner');
  advWhile(C_SYMOP, 'aw_symop');
  advWhile(C_SPACE, 'aw_space');
  advWhile(C_QUOTER, 'aw_quoter');
  advWhile(C_ID, 'aw_id');

  // advance_until_char(R_REL start, R_TMP2 char) -> R_N
  a.label('advance_until_char');
  a.mov(R_N, R_REL);
  a.label('auc_loop');
  a.ifEof('auc_ret');
  a.mov(R_REL, R_N);
  a.call('peek');
  a.ifCmp('eq', R_PEEK, R_TMP2, 'auc_ret');
  a.alui('add', R_N, 1);
  a.jmp('auc_loop');
  a.label('auc_ret');
  a.ret();

  // start_column: column() - lookahead.size
  a.label('start_column');
  a.ifEof('sc_zero');
  a.getColumn(R_N);
  a.alu('sub', R_N, R_LA_SIZE);
  a.ret();
  a.label('sc_zero');
  a.const_(R_N, 0);
  a.alu('sub', R_N, R_LA_SIZE);
  a.ret();

  // ======================================================================
  // skip_space / skip_newlines / skip_whitespace
  // ======================================================================
  a.label('skip_space');
  a.const_(R_OK, 0);
  a.ifNClass(C_SPACE, 'ss_ret');
  a.skip();
  a.const_(R_OK, 1);
  a.label('ss_more');
  a.ifNClass(C_SPACE, 'ss_ret');
  a.skip();
  a.jmp('ss_more');
  a.label('ss_ret');
  a.ret();

  a.label('skip_newlines');
  a.const_(R_OK, 0);
  a.ifNClass(C_NEWLINE, 'sn_ret');
  a.skip();
  a.const_(R_OK, 1);
  a.label('sn_more');
  a.ifNClass(C_NEWLINE, 'sn_ret');
  a.skip();
  a.jmp('sn_more');
  a.label('sn_ret');
  a.ret();

  a.label('skip_whitespace');
  a.const_(R_WS, NoSpace);
  a.label('sw_loop');
  a.call('skip_space');
  a.ifCmpI('eq', R_OK, 0, 'sw_nl');
  a.const_(R_WS, Indented);
  a.jmp('sw_loop');
  a.label('sw_nl');
  a.call('skip_newlines');
  a.ifCmpI('eq', R_OK, 0, 'sw_ret');
  a.const_(R_WS, BOL);
  a.jmp('sw_loop');
  a.label('sw_ret');
  a.ret();

  // take_line: while (not_eof && !is_newline(PEEK)) S_ADVANCE
  a.label('take_line');
  a.label('tl_loop');
  a.ifEof('tl_ret');
  a.ifClass(C_NEWLINE, 'tl_ret');
  a.call('do_advance_count');
  a.jmp('tl_loop');
  a.label('tl_ret');
  a.ret();

  // take_line_escaped_newline
  a.label('take_line_esc');
  a.label('tle_loop');
  a.label('tle_run');
  a.ifEof('tle_ret');
  a.ifClass(C_NEWLINE, 'tle_ret');
  a.ifChar(CH('\\'), 'tle_bs');
  a.call('do_advance_count');
  a.jmp('tle_run');
  a.label('tle_bs');
  a.call('do_advance_count');
  a.ifClass(C_SPC_TAB, 'tle_sp');
  a.call('do_advance_count');
  a.jmp('tle_loop');
  a.label('tle_sp');
  a.label('tle_sp_loop');
  a.ifNClass(C_SPC_TAB, 'tle_sp_nl');
  a.call('do_advance_count');
  a.jmp('tle_sp_loop');
  a.label('tle_sp_nl');
  a.ifNClass(C_NEWLINE, 'tle_loop');
  a.call('do_advance_count');
  a.jmp('tle_loop');
  a.label('tle_ret');
  a.ret();

  // ======================================================================
  // Context stack
  // ======================================================================
  a.label('push_context'); // R_SORT, R_INDENT
  a.push(S_SORT, R_SORT);
  a.push(S_INDENT, R_INDENT);
  a.ret();

  a.label('pop_context');
  a.len(S_SORT, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'pop_ret');
  a.pop(S_SORT, R_TMP);
  a.pop(S_INDENT, R_TMP);
  a.label('pop_ret');
  a.ret();

  a.label('current_context'); // -> R_SORT
  a.len(S_SORT, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'cc_none');
  a.peek(S_SORT, R_SORT, 0);
  a.ret();
  a.label('cc_none');
  a.const_(R_SORT, NoContext);
  a.ret();

  a.label('current_indent'); // -> R_N
  a.len(S_SORT, R_I);
  a.label('ci_loop');
  a.ifCmpI('eq', R_I, 0, 'ci_zero');
  a.alui('sub', R_I, 1);
  a.getidx(S_SORT, R_TMP, R_I);
  a.ifCmpI('ge', R_TMP, Braces, 'ci_loop');
  a.getidx(S_INDENT, R_N, R_I);
  a.ret();
  a.label('ci_zero');
  a.const_(R_N, 0);
  a.ret();

  a.label('reset_newline');
  a.const_(R_NL_STATE, NInactive);
  a.const_(R_NL_END, 0);
  a.const_(R_NL_INDENT, 0);
  a.const_(R_NL_EOF, 0);
  a.const_(R_NL_NO_SEMI, 0);
  a.const_(R_NL_SKIP_SEMI, 0);
  a.const_(R_NL_UNSAFE, 0);
  a.ret();

  // ======================================================================
  // Layout start / end
  // ======================================================================
  a.label('valid_layout_start_sym'); // -> R_SYM
  a.ifValid(START, 'vls_start');
  a.ifValid(START_DO, 'vls_do');
  a.ifValid(START_CASE, 'vls_case');
  a.ifValid(START_IF, 'vls_if');
  a.ifValid(START_LET, 'vls_let');
  a.ifValid(START_QUOTE, 'vls_quote');
  a.ifValid(START_EXPLICIT, 'vls_exp');
  a.const_(R_SYM, FAIL);
  a.ret();
  a.label('vls_start'); a.const_(R_SYM, START); a.ret();
  a.label('vls_do'); a.const_(R_SYM, START_DO); a.ret();
  a.label('vls_case'); a.const_(R_SYM, START_CASE); a.ret();
  a.label('vls_if'); a.const_(R_SYM, START_IF); a.ret();
  a.label('vls_let'); a.const_(R_SYM, START_LET); a.ret();
  a.label('vls_quote'); a.const_(R_SYM, START_QUOTE); a.ret();
  a.label('vls_exp'); a.const_(R_SYM, START_EXPLICIT); a.ret();

  a.label('layout_sort'); // R_SYM -> R_SORT
  a.ifCmpI('eq', R_SYM, START_DO, 'ls_do');
  a.ifCmpI('eq', R_SYM, START_CASE, 'ls_case');
  a.ifCmpI('eq', R_SYM, START_IF, 'ls_if');
  a.ifCmpI('eq', R_SYM, START_LET, 'ls_let');
  a.ifCmpI('eq', R_SYM, START_QUOTE, 'ls_quote');
  a.const_(R_SORT, DeclLayout);
  a.ret();
  a.label('ls_do'); a.const_(R_SORT, DoLayout); a.ret();
  a.label('ls_case'); a.const_(R_SORT, CaseLayout); a.ret();
  a.label('ls_if'); a.const_(R_SORT, MultiWayIfLayout); a.ret();
  a.label('ls_let'); a.const_(R_SORT, LetLayout); a.ret();
  a.label('ls_quote'); a.const_(R_SORT, QuoteLayout); a.ret();

  // valid_layout_start(R_NEXT) -> R_SYM, R_SORT (NoContext if none)
  a.label('valid_layout_start');
  a.call('valid_layout_start_sym');
  a.len(S_SORT, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'vla_none');
  a.ifCmpI('eq', R_SYM, FAIL, 'vla_none');
  a.call('layout_sort');
  a.ifCmpI('eq', R_NEXT, LBar, 'vla_ok');
  a.ifCmpI('eq', R_NEXT, LBraceOpen, 'vla_brace');
  a.ifCmpI('eq', R_SORT, MultiWayIfLayout, 'vla_none');
  a.jmp('vla_ok');
  a.label('vla_brace');
  a.ifCmpI('eq', R_NL_STATE, NInit, 'vla_none');
  a.ifCmpI('eq', R_NL_STATE, NProcess, 'vla_none');
  a.const_(R_SORT, Braces);
  a.const_(R_SYM, START_EXPLICIT);
  a.jmp('vla_ok');
  a.label('vla_none');
  a.const_(R_SORT, NoContext);
  a.label('vla_ok');
  a.ret();

  a.label('indent_can_start'); // R_SORT = new sort, R_INDENT -> R_OK
  a.mov(R_LEVEL, R_SORT);
  a.call('current_context');
  a.ifCmpI('eq', R_SORT, Braces, 'ics_yes');
  a.call('current_indent');
  a.ifCmp('gt', R_INDENT, R_N, 'ics_yes');
  a.ifCmp('ne', R_INDENT, R_N, 'ics_no');
  a.ifCmpI('eq', R_LEVEL, DoLayout, 'ics_yes');
  a.label('ics_no');
  a.mov(R_SORT, R_LEVEL);
  a.const_(R_OK, 0);
  a.ret();
  a.label('ics_yes');
  a.mov(R_SORT, R_LEVEL);
  a.const_(R_OK, 1);
  a.ret();

  a.label('start_layout'); // R_SYM, R_SORT (new), R_INDENT
  a.mov(R_LEVEL, R_SORT);
  a.call('current_context');
  a.ifCmpI('eq', R_SORT, ModuleHeader, 'sl_pop');
  a.ifCmpI('eq', R_LEVEL, Braces, 'sl_mark');
  a.mov(R_SORT, R_LEVEL);
  a.call('indent_can_start');
  a.ifCmpI('eq', R_OK, 0, 'sl_fail');
  a.jmp('sl_push');
  a.label('sl_pop');
  a.call('pop_context');
  a.jmp('sl_push');
  a.label('sl_mark');
  a.markEnd();
  a.label('sl_push');
  a.mov(R_SORT, R_LEVEL);
  a.call('push_context');
  a.mov(R_RESULT, R_SYM);
  a.ret();
  a.label('sl_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('start_layout_interior');
  a.call('valid_layout_start');
  a.ifCmpI('eq', R_SORT, NoContext, 'sli_fail');
  a.call('start_column');
  a.mov(R_INDENT, R_N);
  a.call('start_layout');
  a.ret();
  a.label('sli_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('start_layout_newline');
  a.mov(R_NEXT, R_NL_END);
  a.call('valid_layout_start');
  a.ifCmpI('eq', R_SORT, NoContext, 'sln_fail');
  a.mov(R_INDENT, R_NL_INDENT);
  a.call('start_layout');
  a.ifCmpI('eq', R_RESULT, FAIL, 'sln_ret');
  a.const_(R_NL_NO_SEMI, 1);
  a.label('sln_ret');
  a.ret();
  a.label('sln_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('texp_context');
  a.ifNValid(START_TEXP, 'tc_end');
  a.const_(R_SORT, TExp);
  a.const_(R_INDENT, 0);
  a.call('push_context');
  a.const_(R_RESULT, START_TEXP);
  a.ret();
  a.label('tc_end');
  a.ifNValid(END_TEXP, 'tc_fail');
  a.call('current_context');
  a.ifCmpI('ne', R_SORT, TExp, 'tc_fail');
  a.call('pop_context');
  a.const_(R_RESULT, END_TEXP);
  a.ret();
  a.label('tc_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('start_brace');
  a.ifNValid(START_BRACE, 'sb_fail');
  a.const_(R_SORT, Braces);
  a.const_(R_INDENT, 0);
  a.call('push_context');
  a.const_(R_RESULT, START_BRACE);
  a.ret();
  a.label('sb_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('end_brace');
  a.ifNValid(END_BRACE, 'eb_fail');
  a.call('current_context');
  a.ifCmpI('ne', R_SORT, Braces, 'eb_fail');
  a.call('pop_context');
  a.const_(R_RESULT, END_BRACE);
  a.ret();
  a.label('eb_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('end_layout_unchecked');
  a.call('pop_context');
  a.const_(R_RESULT, END);
  a.ret();

  a.label('end_layout');
  a.ifNValid(END, 'el_fail');
  a.call('end_layout_unchecked');
  a.ret();
  a.label('el_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('end_layout_brace');
  a.ifNValid(END_EXPLICIT, 'elb_fail');
  a.call('current_context');
  a.ifCmpI('ne', R_SORT, Braces, 'elb_fail');
  a.const_(R_REL, 0);
  a.mov(R_ABS, R_LA_OFF);
  a.alu('add', R_ABS, R_REL);
  a.call('advance_over_abs');
  a.markEnd();
  a.call('pop_context');
  a.const_(R_RESULT, END_EXPLICIT);
  a.ret();
  a.label('elb_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('end_layout_indent');
  a.ifNValid(END, 'eli_fail');
  a.call('current_context');
  a.ifCmpI('ge', R_SORT, Braces, 'eli_fail');
  a.call('current_indent');
  a.ifCmp('ge', R_NL_INDENT, R_N, 'eli_fail');
  a.len(S_SORT, R_TMP);
  a.ifCmpI('ne', R_TMP, 1, 'eli_pop');
  // top_layout: update indent, UPDATE
  a.len(S_SORT, R_TMP);
  a.alui('sub', R_TMP, 1);
  a.mov(R_I, R_TMP);
  a.getidx(S_INDENT, R_TMP2, R_I);
  a.settop(S_INDENT, R_NL_INDENT);
  a.const_(R_RESULT, UPDATE);
  a.ret();
  a.label('eli_pop');
  a.const_(R_NL_SKIP_SEMI, 0);
  a.call('end_layout_unchecked');
  a.ret();
  a.label('eli_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('end_layout_infix');
  a.ifValid(VARSYM, 'eli2_fail');
  a.ifValid(CONSYM, 'eli2_fail');
  a.call('end_layout');
  a.ret();
  a.label('eli2_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('end_layout_where');
  a.ifNValid(END, 'elw_fail');
  a.ifValid(WHERE, 'elw_fail');
  a.call('current_context');
  a.ifCmpI('ge', R_SORT, Braces, 'elw_fail');
  a.call('end_layout');
  a.ret();
  a.label('elw_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('end_layout_in');
  a.ifNValid(END, 'elin_fail');
  a.ifNValid(IN, 'elin_yes');
  a.call('current_context');
  a.ifCmpI('eq', R_SORT, LetLayout, 'elin_yes');
  a.jmp('elin_fail');
  a.label('elin_yes');
  a.call('end_layout');
  a.ret();
  a.label('elin_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('end_layout_deriving');
  a.ifNValid(END, 'eld_fail');
  a.ifValid(DERIVING, 'eld_fail');
  a.len(S_SORT, R_TMP);
  a.ifCmpI('eq', R_TMP, 1, 'eld_fail');
  a.call('current_context');
  a.ifCmpI('ne', R_SORT, DeclLayout, 'eld_fail');
  a.call('end_layout');
  a.ret();
  a.label('eld_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('layouts_in_texp'); // -> R_OK
  a.const_(R_OK, 0);
  a.call('current_context');
  a.ifCmpI('ge', R_SORT, Braces, 'lit_ret');
  a.len(S_SORT, R_TMP);
  a.ifCmpI('le', R_TMP, 1, 'lit_ret');
  a.mov(R_I, R_TMP);
  a.alui('sub', R_I, 2);
  a.label('lit_loop');
  a.ifCmpI('lt', R_I, 0, 'lit_ret');
  a.getidx(S_SORT, R_TMP, R_I);
  a.ifCmpI('eq', R_TMP, TExp, 'lit_yes');
  a.ifCmpI('eq', R_TMP, Braces, 'lit_yes');
  a.ifCmpI('gt', R_TMP, Braces, 'lit_ret');
  a.alui('sub', R_I, 1);
  a.jmp('lit_loop');
  a.label('lit_yes');
  a.const_(R_OK, 1);
  a.label('lit_ret');
  a.ret();

  a.label('token_end_layout_texp');
  a.ifNValid(END, 'telt_fail');
  a.call('layouts_in_texp');
  a.ifCmpI('eq', R_OK, 0, 'telt_fail');
  a.call('end_layout');
  a.ret();
  a.label('telt_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('force_end_context');
  a.label('fec_loop');
  a.len(S_SORT, R_I);
  a.ifCmpI('eq', R_I, 0, 'fec_fail');
  a.alui('sub', R_I, 1);
  a.getidx(S_SORT, R_TMP, R_I);
  a.call('pop_context');
  // context_end_sym
  a.ifCmpI('eq', R_TMP, TExp, 'fec_texp');
  a.ifCmpI('eq', R_TMP, Braces, 'fec_brace');
  a.ifCmpI('ge', R_TMP, Braces, 'fec_loop');
  a.const_(R_SYM, END);
  a.jmp('fec_try');
  a.label('fec_texp');
  a.const_(R_SYM, END_TEXP);
  a.jmp('fec_try');
  a.label('fec_brace');
  a.const_(R_SYM, END_BRACE);
  a.label('fec_try');
  a.ifValidR(R_SYM, 'fec_hit');
  a.jmp('fec_loop');
  a.label('fec_hit');
  a.mov(R_RESULT, R_SYM);
  a.ret();
  a.label('fec_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  // ======================================================================
  // Operators / lex
  // ======================================================================
  a.label('symop_lookahead'); // -> R_N, caches in R_SYMOP
  a.ifCmpI('ne', R_SYMOP, 0, 'slo_hit');
  a.const_(R_REL, 0);
  a.call('aw_symop');
  a.mov(R_SYMOP, R_N);
  a.ifCmpI('eq', R_N, 0, 'slo_ret');
  a.label('slo_hit');
  a.mov(R_N, R_SYMOP);
  a.label('slo_ret');
  a.ret();

  a.label('opening_token'); // R_REL = i -> R_OK
  a.call('peek');
  a.ifCmpI('eq', R_PEEK, 0x27e6, 'ot_yes');
  a.ifCmpI('eq', R_PEEK, 0x2987, 'ot_yes');
  a.ifCmpI('eq', R_PEEK, CH('('), 'ot_yes');
  a.ifCmpI('eq', R_PEEK, CH('['), 'ot_yes');
  a.ifCmpI('eq', R_PEEK, CH('"'), 'ot_yes');
  a.ifCmpI('eq', R_PEEK, CH('{'), 'ot_brace');
  a.ifClassR(C_ID, R_PEEK, 'ot_yes');
  a.const_(R_OK, 0);
  a.ret();
  a.label('ot_brace');
  a.alui('add', R_REL, 1);
  a.call('peek');
  a.ifCmpI('eq', R_PEEK, CH('-'), 'ot_no');
  a.label('ot_yes');
  a.const_(R_OK, 1);
  a.ret();
  a.label('ot_no');
  a.const_(R_OK, 0);
  a.ret();

  a.label('lex_prefix'); // R_NEXT in as t, out as t or LSymop
  a.const_(R_REL, 1);
  a.call('opening_token');
  a.ifCmpI('eq', R_OK, 1, 'lpx_ret');
  a.const_(R_NEXT, LSymop);
  a.label('lpx_ret');
  a.ret();

  a.label('lex_symop'); // -> R_NEXT
  a.call('symop_lookahead');
  a.ifCmpI('eq', R_N, 0, 'lsy_nothing');
  a.const_(R_REL, 0);
  a.call('unsafe_peek');
  a.mov(R_LEVEL, R_PEEK); // c1 -- must survive seq/peek
  a.ifCmpI('ne', R_N, 1, 'lsy_len2');
  // len == 1
  a.ifCmpI('eq', R_LEVEL, CH('?'), 'lsy_q');
  a.ifCmpI('eq', R_LEVEL, CH('#'), 'lsy_hash');
  a.ifCmpI('eq', R_LEVEL, CH('|'), 'lsy_bar');
  a.ifCmpI('eq', R_LEVEL, CH('!'), 'lsy_bang');
  a.ifCmpI('eq', R_LEVEL, CH('~'), 'lsy_tilde');
  a.ifCmpI('eq', R_LEVEL, CH('@'), 'lsy_at');
  a.ifCmpI('eq', R_LEVEL, CH('%'), 'lsy_pct');
  a.ifCmpI('eq', R_LEVEL, CH('$'), 'lsy_dol');
  a.ifCmpI('eq', R_LEVEL, CH('.'), 'lsy_dot');
  a.ifCmpI('eq', R_LEVEL, 0x2192, 'lsy_arrow');
  a.ifCmpI('eq', R_LEVEL, 0x22b8, 'lsy_arrow');
  a.ifCmpI('eq', R_LEVEL, 0x21d2, 'lsy_carrow');
  a.ifCmpI('eq', R_LEVEL, CH('='), 'lsy_texp');
  a.ifCmpI('eq', R_LEVEL, 0x27e7, 'lsy_texp');
  a.ifCmpI('eq', R_LEVEL, 0x2988, 'lsy_texp');
  a.ifCmpI('eq', R_LEVEL, CH('*'), 'lsy_special');
  a.ifCmpI('eq', R_LEVEL, CH('-'), 'lsy_special');
  a.ifCmpI('eq', R_LEVEL, CH('\\'), 'lsy_nothing');
  a.ifCmpI('eq', R_LEVEL, 0x2190, 'lsy_nothing');
  a.ifCmpI('eq', R_LEVEL, 0x2200, 'lsy_nothing');
  a.ifCmpI('eq', R_LEVEL, 0x2237, 'lsy_nothing');
  a.ifCmpI('eq', R_LEVEL, 0x2605, 'lsy_nothing');
  a.ifCmpI('eq', R_LEVEL, 0x27e6, 'lsy_nothing');
  a.ifCmpI('eq', R_LEVEL, 0x2919, 'lsy_nothing');
  a.ifCmpI('eq', R_LEVEL, 0x291a, 'lsy_nothing');
  a.ifCmpI('eq', R_LEVEL, 0x291b, 'lsy_nothing');
  a.ifCmpI('eq', R_LEVEL, 0x291c, 'lsy_nothing');
  a.ifCmpI('eq', R_LEVEL, 0x2987, 'lsy_nothing');
  a.const_(R_NEXT, LSymop);
  a.ret();
  a.label('lsy_q');
  peekAt(1);
  a.ifClassR(C_VARID, R_PEEK, 'lsy_nothing');
  a.const_(R_NEXT, LSymop);
  a.ret();
  a.label('lsy_hash');
  peekAt(1);
  a.ifCmpI('eq', R_PEEK, CH(')'), 'lsy_unboxed');
  a.const_(R_NEXT, LHash);
  a.ret();
  a.label('lsy_unboxed');
  a.const_(R_NEXT, LUnboxedClose);
  a.ret();
  a.label('lsy_bar');
  peekAt(1);
  a.ifCmpI('eq', R_PEEK, CH(']'), 'lsy_quote');
  a.const_(R_NEXT, LBar);
  a.ret();
  a.label('lsy_quote');
  a.const_(R_NEXT, LQuoteClose);
  a.ret();
  a.label('lsy_bang');
  a.const_(R_NEXT, LBang);
  a.call('lex_prefix');
  a.ret();
  a.label('lsy_tilde');
  a.const_(R_NEXT, LTilde);
  a.call('lex_prefix');
  a.ret();
  a.label('lsy_at');
  a.const_(R_NEXT, LAt);
  a.call('lex_prefix');
  a.ret();
  a.label('lsy_pct');
  a.const_(R_NEXT, LPercent);
  a.call('lex_prefix');
  a.ret();
  a.label('lsy_dol');
  peekAt(1);
  a.ifClassR(C_VARID, R_PEEK, 'lsy_dollar');
  a.ifCmpI('eq', R_PEEK, CH('('), 'lsy_dollar');
  a.const_(R_NEXT, LSymop);
  a.ret();
  a.label('lsy_dollar');
  a.const_(R_NEXT, LDollar);
  a.ret();
  a.label('lsy_dot');
  peekAt(1);
  a.ifClassR(C_ID, R_PEEK, 'lsy_dotid');
  a.const_(R_REL, 1);
  a.call('opening_token');
  a.ifCmpI('eq', R_OK, 1, 'lsy_dotopen');
  a.const_(R_NEXT, LSymop);
  a.ret();
  a.label('lsy_dotid');
  a.const_(R_NEXT, LDotId);
  a.ret();
  a.label('lsy_dotopen');
  a.const_(R_NEXT, LDotOpen);
  a.ret();
  a.label('lsy_arrow');
  a.const_(R_NEXT, LArrow);
  a.ret();
  a.label('lsy_carrow');
  a.const_(R_NEXT, LCArrow);
  a.ret();
  a.label('lsy_texp');
  a.const_(R_NEXT, LTexpCloser);
  a.ret();
  a.label('lsy_special');
  a.const_(R_NEXT, LSymopSpecial);
  a.ret();
  a.label('lsy_nothing');
  a.const_(R_NEXT, LNothing);
  a.ret();

  a.label('lsy_len2');
  a.ifCmpI('ne', R_N, 2, 'lsy_long');
  {
    const yes = U('arr'), no = U('arrn');
    seq('->', yes, no);
    a.label(yes);
    a.const_(R_NEXT, LArrow);
    a.ret();
    a.label(no);
  }
  {
    const yes = U('ca'), no = U('can');
    seq('=>', yes, no);
    a.label(yes);
    a.const_(R_NEXT, LCArrow);
    a.ret();
    a.label(no);
  }
  a.const_(R_REL, 1);
  a.call('unsafe_peek');
  a.mov(R_NEST, R_PEEK); // c2
  a.ifCmpI('eq', R_LEVEL, CH('$'), 'lsy2_dol');
  a.ifCmpI('eq', R_LEVEL, CH('|'), 'lsy2_bar');
  a.ifCmpI('eq', R_LEVEL, CH('.'), 'lsy2_dot');
  a.ifCmpI('eq', R_LEVEL, CH('#'), 'lsy2_hash');
  // valid_symop_two_chars
  a.ifCmpI('eq', R_LEVEL, CH('='), 'lsy2_eq');
  a.ifCmpI('eq', R_LEVEL, CH('<'), 'lsy2_lt');
  a.ifCmpI('eq', R_LEVEL, CH(':'), 'lsy2_col');
  a.const_(R_NEXT, LSymop);
  a.ret();
  a.label('lsy2_eq');
  a.ifCmpI('eq', R_NEST, CH('>'), 'lsy_nothing');
  a.const_(R_NEXT, LSymop);
  a.ret();
  a.label('lsy2_lt');
  a.ifCmpI('eq', R_NEST, CH('-'), 'lsy_nothing');
  a.const_(R_NEXT, LSymop);
  a.ret();
  a.label('lsy2_col');
  a.ifCmpI('eq', R_NEST, CH(':'), 'lsy_nothing');
  a.const_(R_NEXT, LSymop);
  a.ret();
  a.label('lsy2_dol');
  a.ifCmpI('ne', R_NEST, CH('$'), 'lsy_sym');
  peekAt(2);
  a.ifClassR(C_VARID, R_PEEK, 'lsy_dollar');
  a.ifCmpI('eq', R_PEEK, CH('('), 'lsy_dollar');
  a.const_(R_NEXT, LSymop);
  a.ret();
  a.label('lsy2_bar');
  a.ifCmpI('ne', R_NEST, CH('|'), 'lsy_sym');
  peekAt(2);
  a.ifCmpI('eq', R_PEEK, CH(']'), 'lsy_quote');
  a.const_(R_NEXT, LSymop);
  a.ret();
  a.label('lsy2_dot');
  a.ifCmpI('eq', R_NEST, CH('.'), 'lsy_dotdot');
  a.const_(R_NEXT, LDotSymop);
  a.ret();
  a.label('lsy_dotdot');
  a.const_(R_NEXT, LDotDot);
  a.ret();
  a.label('lsy2_hash');
  a.ifCmpI('eq', R_NEST, CH('#'), 'lsy_special');
  a.ifCmpI('eq', R_NEST, CH('|'), 'lsy_special');
  a.const_(R_NEXT, LSymop);
  a.ret();
  a.label('lsy_sym');
  a.const_(R_NEXT, LSymop);
  a.ret();

  a.label('lsy_long');
  a.ifCmpI('ne', R_LEVEL, CH('-'), 'lsy_ldot');
  {
    const yes = U('aro'), no = U('aron');
    seq('->.', yes, no);
    a.label(yes);
    a.const_(R_NEXT, LArrow);
    a.ret();
    a.label(no);
  }
  a.const_(R_NEXT, LSymop);
  a.ret();
  a.label('lsy_ldot');
  a.ifCmpI('eq', R_LEVEL, CH('.'), 'lsy_ldots');
  a.const_(R_NEXT, LSymop);
  a.ret();
  a.label('lsy_ldots');
  a.const_(R_NEXT, LDotSymop);
  a.ret();

  // line_comment_herald: seq("--") && only_minus
  a.label('only_minus');
  a.const_(R_COL, 2);
  a.label('om_loop');
  a.mov(R_REL, R_COL);
  a.call('peek');
  a.ifCmpI('ne', R_PEEK, CH('-'), 'om_end');
  a.alui('add', R_COL, 1);
  a.jmp('om_loop');
  a.label('om_end');
  a.ifClassR(C_SYMOP, R_PEEK, 'om_no');
  a.const_(R_OK, 1);
  a.ret();
  a.label('om_no');
  a.const_(R_OK, 0);
  a.ret();

  a.label('line_comment_herald');
  {
    const yes = U('lch'), no = U('lchn');
    seq('--', yes, no);
    a.label(no);
    a.const_(R_OK, 0);
    a.ret();
    a.label(yes);
    a.call('only_minus');
    a.ret();
  }

  // cpp_directive -> R_N
  a.label('cpp_directive');
  peekAt(0);
  a.ifCmpI('ne', R_PEEK, CH('#'), 'cpp_nothing');
  a.const_(R_REL, 1);
  a.call('aw_space');
  a.mov(R_SAVED, R_N); // start
  // try tokens
  const cppTok = (words, hit) => {
    for (const w of words) {
      const yes = U('cp'), no = U('cpn');
      // token_from at start: temporarily set offset? token_from uses peek(start+i)
      // Our seq/token always peek from offset+i with i from 0.
      // Need peek(start+i). Use a local: set R_LA_OFF += start, token, restore?
      // Simpler: custom loop with start in R_SAVED.
      a.mov(R_COL, R_SAVED);
      let fail = no;
      for (let i = 0; i < w.length; i++) {
        const ok = U('cpc');
        a.mov(R_REL, R_COL);
        a.call('peek');
        a.ifCmpI('eq', R_PEEK, w.charCodeAt(i), ok);
        a.jmp(fail);
        a.label(ok);
        a.alui('add', R_COL, 1);
      }
      a.mov(R_REL, R_COL);
      a.call('peek');
      a.ifClassR(C_INNER, R_PEEK, fail);
      a.jmp(hit);
      a.label(fail);
    }
  };
  cppTok(['if', 'ifdef', 'ifndef'], 'cpp_start');
  cppTok(['else', 'elif', 'elifdef', 'elifndef'], 'cpp_else');
  cppTok(['endif'], 'cpp_end');
  cppTok(['define', 'undef', 'include', 'pragma', 'error', 'warning', 'line'], 'cpp_other');
  // newline at start, or shebang
  a.mov(R_REL, R_SAVED);
  a.call('peek');
  a.ifClassR(C_NEWLINE, R_PEEK, 'cpp_other');
  peekAt(1);
  a.ifCmpI('ne', R_PEEK, CH('!'), 'cpp_nothing');
  a.len(S_SORT, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'cpp_other');
  a.label('cpp_nothing');
  a.const_(R_N, CppNothing);
  a.ret();
  a.label('cpp_start');
  a.const_(R_N, CppStart);
  a.ret();
  a.label('cpp_else');
  a.const_(R_N, CppElse);
  a.ret();
  a.label('cpp_end');
  a.const_(R_N, CppEnd);
  a.ret();
  a.label('cpp_other');
  a.const_(R_N, CppOther);
  a.ret();

  a.label('lex_cpp');
  a.call('cpp_directive');
  a.ifCmpI('eq', R_N, CppElse, 'lc_else');
  a.ifCmpI('eq', R_N, CppNothing, 'lc_noth');
  a.const_(R_NEXT, LCpp);
  a.ret();
  a.label('lc_else');
  a.const_(R_NEXT, LCppElse);
  a.ret();
  a.label('lc_noth');
  a.const_(R_NEXT, LNothing);
  a.ret();

  a.label('lex_extras'); // R_BOL in
  peekAt(0);
  a.ifCmpI('eq', R_PEEK, CH('{'), 'le_brace');
  a.ifCmpI('eq', R_PEEK, CH('#'), 'le_hash');
  a.ifCmpI('eq', R_PEEK, CH('-'), 'le_minus');
  a.const_(R_NEXT, LNothing);
  a.ret();
  a.label('le_brace');
  peekAt(1);
  a.ifCmpI('ne', R_PEEK, CH('-'), 'le_noth');
  peekAt(2);
  a.ifCmpI('eq', R_PEEK, CH('#'), 'le_pragma');
  a.const_(R_NEXT, LBlockComment);
  a.ret();
  a.label('le_pragma');
  a.const_(R_NEXT, LPragma);
  a.ret();
  a.label('le_hash');
  a.ifCmpI('eq', R_BOL, 0, 'le_noth');
  a.call('lex_cpp');
  a.ret();
  a.label('le_minus');
  a.call('line_comment_herald');
  a.ifCmpI('eq', R_OK, 0, 'le_noth');
  a.const_(R_NEXT, LLineComment);
  a.ret();
  a.label('le_noth');
  a.const_(R_NEXT, LNothing);
  a.ret();

  a.label('try_end_token'); // uses a small dispatch from lex
  // inlined in lex

  a.label('is_qq_start');
  a.const_(R_REL, 1);
  a.call('aw_quoter');
  a.mov(R_REL, R_N);
  a.call('peek');
  a.ifCmpI('eq', R_PEEK, CH('|'), 'iqs_yes');
  a.const_(R_OK, 0);
  a.ret();
  a.label('iqs_yes');
  a.const_(R_OK, 1);
  a.ret();

  a.label('lex'); // R_BOL
  a.call('lex_extras');
  a.ifCmpI('ne', R_NEXT, LNothing, 'lex_ret');
  peekAt(0);
  a.ifClassR(C_SYMOP, R_PEEK, 'lex_sy');
  a.ifCmpI('eq', R_PEEK, CH('w'), 'lex_w');
  a.ifCmpI('eq', R_PEEK, CH('i'), 'lex_i');
  a.ifCmpI('eq', R_PEEK, CH('t'), 'lex_t');
  a.ifCmpI('eq', R_PEEK, CH('e'), 'lex_e');
  a.ifCmpI('eq', R_PEEK, CH('d'), 'lex_d');
  a.ifCmpI('eq', R_PEEK, CH('m'), 'lex_m');
  a.ifCmpI('eq', R_PEEK, CH('{'), 'lex_bo');
  a.ifCmpI('eq', R_PEEK, CH('}'), 'lex_bc');
  a.ifCmpI('eq', R_PEEK, CH(';'), 'lex_semi');
  a.ifCmpI('eq', R_PEEK, CH('`'), 'lex_tick');
  a.ifCmpI('eq', R_PEEK, CH('['), 'lex_br');
  a.ifCmpI('eq', R_PEEK, CH(']'), 'lex_texp');
  a.ifCmpI('eq', R_PEEK, CH(')'), 'lex_texp');
  a.ifCmpI('eq', R_PEEK, CH(','), 'lex_texp');
  a.ifClassR(C_CONID, R_PEEK, 'lex_upper');
  a.const_(R_NEXT, LNothing);
  a.ret();
  a.label('lex_sy');
  a.call('lex_symop');
  a.ret();
  a.label('lex_w');
  {
    const yes = U('wh'), no = U('whn');
    token('where', yes, no);
    a.label(yes); a.const_(R_NEXT, LWhere); a.ret();
    a.label(no); a.const_(R_NEXT, LNothing); a.ret();
  }
  a.label('lex_i');
  {
    const yes = U('in'), no = U('inn');
    token('in', yes, no);
    a.label(yes); a.const_(R_NEXT, LIn); a.ret();
    a.label(no); a.const_(R_NEXT, LNothing); a.ret();
  }
  a.label('lex_t');
  {
    const yes = U('th'), no = U('thn');
    token('then', yes, no);
    a.label(yes); a.const_(R_NEXT, LThen); a.ret();
    a.label(no); a.const_(R_NEXT, LNothing); a.ret();
  }
  a.label('lex_e');
  {
    const yes = U('el'), no = U('eln');
    token('else', yes, no);
    a.label(yes); a.const_(R_NEXT, LElse); a.ret();
    a.label(no); a.const_(R_NEXT, LNothing); a.ret();
  }
  a.label('lex_d');
  {
    const yes = U('de'), no = U('den');
    token('deriving', yes, no);
    a.label(yes); a.const_(R_NEXT, LDeriving); a.ret();
    a.label(no); a.const_(R_NEXT, LNothing); a.ret();
  }
  a.label('lex_m');
  a.len(S_SORT, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'lex_mod');
  a.call('current_context');
  a.ifCmpI('eq', R_SORT, ModuleHeader, 'lex_mod');
  a.const_(R_NEXT, LNothing);
  a.ret();
  a.label('lex_mod');
  {
    const yes = U('mo'), no = U('mon');
    token('module', yes, no);
    a.label(yes); a.const_(R_NEXT, LModule); a.ret();
    a.label(no); a.const_(R_NEXT, LNothing); a.ret();
  }
  a.label('lex_bo');
  a.const_(R_NEXT, LBraceOpen);
  a.ret();
  a.label('lex_bc');
  a.const_(R_NEXT, LBraceClose);
  a.ret();
  a.label('lex_semi');
  a.const_(R_NEXT, LSemi);
  a.ret();
  a.label('lex_tick');
  a.const_(R_NEXT, LTick);
  a.ret();
  a.label('lex_br');
  a.ifNValid(QQ_START, 'lex_noth2');
  a.call('is_qq_start');
  a.ifCmpI('eq', R_OK, 0, 'lex_noth2');
  a.const_(R_NEXT, LBracketOpen);
  a.ret();
  a.label('lex_texp');
  a.const_(R_NEXT, LTexpCloser);
  a.ret();
  a.label('lex_upper');
  a.const_(R_NEXT, LUpper);
  a.ret();
  a.label('lex_noth2');
  a.const_(R_NEXT, LNothing);
  a.label('lex_ret');
  a.ret();

  // ======================================================================
  // Comments, CPP, pragma, qq
  // ======================================================================
  a.label('comment_type'); // -> R_RESULT COMMENT or HADDOCK
  a.const_(R_COL, 2);
  a.label('ct_dash');
  a.mov(R_REL, R_COL);
  a.call('peek');
  a.ifCmpI('ne', R_PEEK, CH('-'), 'ct_body');
  a.alui('add', R_COL, 1);
  a.jmp('ct_dash');
  a.label('ct_body');
  a.ifEof('ct_comment');
  a.mov(R_REL, R_COL);
  a.call('peek');
  a.alui('add', R_COL, 1);
  a.ifCmpI('eq', R_PEEK, CH('|'), 'ct_had');
  a.ifCmpI('eq', R_PEEK, CH('^'), 'ct_had');
  a.ifClassR(C_SPACE, R_PEEK, 'ct_body');
  a.label('ct_comment');
  a.const_(R_RESULT, COMMENT);
  a.ret();
  a.label('ct_had');
  a.const_(R_RESULT, HADDOCK);
  a.ret();

  a.label('inline_comment');
  a.call('comment_type');
  a.mov(R_SAVED, R_RESULT);
  a.label('ic_loop');
  a.call('take_line');
  a.markEnd();
  a.call('do_advance_count');
  a.call('reset_la');
  a.call('line_comment_herald');
  a.ifCmpI('ne', R_OK, 0, 'ic_loop');
  a.mov(R_RESULT, R_SAVED);
  a.ret();

  a.label('consume_block_comment'); // R_COL in/out
  a.const_(R_LEVEL, 0);
  a.label('cbc_loop');
  a.ifEof('cbc_ret');
  a.alui('add', R_COL, 1);
  a.ifChar(CH('{'), 'cbc_open');
  a.ifChar(CH('-'), 'cbc_close');
  a.ifClass(C_NEWLINE, 'cbc_nl');
  a.ifChar(CH('\t'), 'cbc_tab');
  a.call('do_advance_count');
  a.jmp('cbc_loop');
  a.label('cbc_open');
  a.call('do_advance_count');
  a.ifNChar(CH('-'), 'cbc_loop');
  a.call('do_advance_count');
  a.alui('add', R_COL, 1);
  a.alui('add', R_LEVEL, 1);
  a.jmp('cbc_loop');
  a.label('cbc_close');
  a.call('do_advance_count');
  a.ifNChar(CH('}'), 'cbc_loop');
  a.call('do_advance_count');
  a.alui('add', R_COL, 1);
  a.ifCmpI('eq', R_LEVEL, 0, 'cbc_ret');
  a.alui('sub', R_LEVEL, 1);
  a.jmp('cbc_loop');
  a.label('cbc_nl');
  a.call('do_advance_count');
  a.const_(R_COL, 0);
  a.jmp('cbc_loop');
  a.label('cbc_tab');
  a.call('do_advance_count');
  a.alui('add', R_COL, 7);
  a.jmp('cbc_loop');
  a.label('cbc_ret');
  a.ret();

  a.label('block_comment');
  a.call('comment_type');
  a.mov(R_SAVED, R_RESULT);
  a.mov(R_COL, R_LA_SIZE);
  a.call('consume_block_comment');
  a.markEnd();
  a.mov(R_RESULT, R_SAVED);
  a.ret();

  a.label('consume_pragma');
  {
    const yes = U('pr'), no = U('prn');
    seq('{-#', yes, no);
    a.label(no);
    a.const_(R_OK, 0);
    a.ret();
    a.label(yes);
  }
  a.label('cpg_loop');
  {
    const yes = U('pe'), no = U('pen');
    seq('#-}', yes, no);
    a.label(yes);
    a.const_(R_OK, 1);
    a.ret();
    a.label(no);
  }
  a.ifEof('cpg_done');
  a.call('reset_la');
  a.const_(R_REL, 0);
  a.mov(R_ABS, R_LA_OFF);
  a.call('advance_over_abs');
  a.jmp('cpg_loop');
  a.label('cpg_done');
  a.const_(R_OK, 1);
  a.ret();

  a.label('pragma');
  a.call('consume_pragma');
  a.ifCmpI('eq', R_OK, 0, 'pg_fail');
  a.markEnd();
  a.ifCmpI('eq', R_NL_STATE, NInactive, 'pg_fin');
  a.const_(R_NL_STATE, NResume);
  a.label('pg_fin');
  a.const_(R_RESULT, PRAGMA);
  a.ret();
  a.label('pg_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('qq_body');
  a.label('qq_loop');
  a.ifEof('qq_eof');
  a.ifChar(0x27e7, 'qq_mark');
  a.ifChar(CH('|'), 'qq_bar');
  a.call('do_advance_count');
  a.jmp('qq_loop');
  a.label('qq_bar');
  a.markEnd();
  a.call('do_advance_count');
  a.ifChar(CH(']'), 'qq_eof');
  a.jmp('qq_loop');
  a.label('qq_mark');
  a.markEnd();
  a.label('qq_eof');
  a.const_(R_RESULT, QQ_BODY);
  a.ret();

  a.label('cpp_else_fn'); // R_OK = emit? saved in R_LEVEL
  a.mov(R_LEVEL, R_OK);
  a.const_(R_NEST, 1);
  a.label('ce_loop');
  a.call('take_line_esc');
  a.ifCmpI('eq', R_LEVEL, 0, 'ce_no_mark');
  a.markEnd();
  a.label('ce_no_mark');
  a.call('do_advance_count');
  a.call('reset_la');
  a.call('cpp_directive');
  a.ifCmpI('eq', R_N, CppStart, 'ce_inc');
  a.ifCmpI('eq', R_N, CppEnd, 'ce_dec');
  a.jmp('ce_next');
  a.label('ce_inc');
  a.alui('add', R_NEST, 1);
  a.jmp('ce_next');
  a.label('ce_dec');
  a.alui('sub', R_NEST, 1);
  a.label('ce_next');
  a.ifEof('ce_done');
  a.ifCmpI('gt', R_NEST, 0, 'ce_loop');
  a.label('ce_done');
  a.ifCmpI('eq', R_LEVEL, 0, 'ce_fail');
  a.const_(R_RESULT, CPP);
  a.ret();
  a.label('ce_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('cpp_line');
  a.call('take_line_esc');
  a.markEnd();
  a.const_(R_RESULT, CPP);
  a.ret();

  // ======================================================================
  // Semicolon
  // ======================================================================
  a.label('explicit_semicolon');
  a.ifNValid(SEMICOLON, 'es_fail');
  a.ifCmpI('ne', R_NL_SKIP_SEMI, 0, 'es_fail');
  a.const_(R_NL_SKIP_SEMI, 1);
  a.const_(R_RESULT, UPDATE);
  a.ret();
  a.label('es_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('resolve_semicolon');
  a.ifCmpI('eq', R_NL_SKIP_SEMI, 0, 'rs_fail');
  a.ifCmpI('eq', R_NEXT, LLineComment, 'rs_fail');
  a.ifCmpI('eq', R_NEXT, LBlockComment, 'rs_fail');
  a.ifCmpI('eq', R_NEXT, LPragma, 'rs_fail');
  a.ifCmpI('eq', R_NEXT, LSemi, 'rs_fail');
  a.const_(R_NL_SKIP_SEMI, 0);
  a.const_(R_RESULT, UPDATE);
  a.ret();
  a.label('rs_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('semicolon');
  a.call('current_context');
  a.ifCmpI('ge', R_SORT, MultiWayIfLayout, 'sc_fail');
  a.ifCmpI('ne', R_NL_NO_SEMI, 0, 'sc_fail');
  a.ifCmpI('ne', R_NL_SKIP_SEMI, 0, 'sc_fail');
  a.call('current_indent');
  a.ifCmp('gt', R_NL_INDENT, R_N, 'sc_fail');
  a.const_(R_NL_NO_SEMI, 1);
  a.const_(R_RESULT, SEMICOLON);
  a.ret();
  a.label('sc_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  // ======================================================================
  // process_token_*
  // ======================================================================
  a.label('process_token_safe');
  a.ifCmpI('eq', R_NEXT, LWhere, 'pts_where');
  a.ifCmpI('eq', R_NEXT, LIn, 'pts_in');
  a.ifCmpI('eq', R_NEXT, LThen, 'pts_then');
  a.ifCmpI('eq', R_NEXT, LElse, 'pts_then');
  a.ifCmpI('eq', R_NEXT, LDeriving, 'pts_der');
  a.ifCmpI('eq', R_NEXT, LBar, 'pts_bar');
  a.ifCmpI('eq', R_NEXT, LPragma, 'pts_pr');
  a.ifCmpI('eq', R_NEXT, LBlockComment, 'pts_bc');
  a.ifCmpI('eq', R_NEXT, LLineComment, 'pts_lc');
  a.ifCmpI('eq', R_NEXT, LCppElse, 'pts_ce');
  a.ifCmpI('eq', R_NEXT, LCpp, 'pts_cpp');
  a.ifCmpI('eq', R_NEXT, LSymop, 'pts_inf');
  a.ifCmpI('eq', R_NEXT, LTick, 'pts_inf');
  a.ifCmpI('eq', R_NEXT, LHash, 'pts_inf');
  a.ifCmpI('eq', R_NEXT, LUnboxedClose, 'pts_ub');
  a.ifCmpI('eq', R_NEXT, LArrow, 'pts_arr');
  a.ifCmpI('eq', R_NEXT, LTexpCloser, 'pts_texp');
  a.ifCmpI('eq', R_NEXT, LQuoteClose, 'pts_qc');
  a.const_(R_RESULT, FAIL);
  a.ret();
  a.label('pts_where'); a.call('end_layout_where'); a.ret();
  a.label('pts_in'); a.call('end_layout_in'); a.ret();
  a.label('pts_then'); a.call('end_layout'); a.ret();
  a.label('pts_der'); a.call('end_layout_deriving'); a.ret();
  a.label('pts_bar');
  a.ifValid(BAR, 'pts_fail');
  a.call('end_layout');
  a.ret();
  a.label('pts_pr'); a.call('pragma'); a.ret();
  a.label('pts_bc'); a.call('block_comment'); a.ret();
  a.label('pts_lc'); a.call('inline_comment'); a.ret();
  a.label('pts_ce'); a.const_(R_OK, 1); a.call('cpp_else_fn'); a.ret();
  a.label('pts_cpp'); a.call('cpp_line'); a.ret();
  a.label('pts_inf'); a.call('end_layout_infix'); a.ret();
  a.label('pts_ub');
  a.call('token_end_layout_texp');
  a.ifCmpI('ne', R_RESULT, FAIL, 'pts_ret');
  a.call('end_layout_infix');
  a.ret();
  a.label('pts_arr');
  a.ifValid(ARROW, 'pts_fail');
  a.call('token_end_layout_texp');
  a.ret();
  a.label('pts_texp'); a.call('token_end_layout_texp'); a.ret();
  a.label('pts_qc'); a.call('end_layout'); a.ret();
  a.label('pts_fail'); a.const_(R_RESULT, FAIL);
  a.label('pts_ret'); a.ret();

  a.label('left_section_op'); // R_N = start
  a.ifNValid(LEFT_SECTION_OP, 'lso_fail');
  a.mov(R_ABS, R_LA_OFF);
  a.alu('add', R_ABS, R_N);
  a.ifCmpI('eq', R_ABS, 0, 'lso_skip');
  a.alui('sub', R_ABS, 1);
  a.call('advance_over_abs');
  a.label('lso_skip');
  a.call('skip_whitespace');
  a.mov(R_REL, R_N);
  a.call('peek');
  a.ifCmpI('eq', R_PEEK, CH(')'), 'lso_yes');
  a.ifCmpI('eq', R_WS, NoSpace, 'lso_fail');
  a.ifNValid(NO_SECTION_OP, 'lso_fail');
  a.const_(R_RESULT, NO_SECTION_OP);
  a.ret();
  a.label('lso_yes');
  a.const_(R_RESULT, LEFT_SECTION_OP);
  a.ret();
  a.label('lso_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('left_section_ticked');
  a.ifNValid(LEFT_SECTION_OP, 'lst_fail');
  a.const_(R_REL, 1);
  a.const_(R_TMP2, CH('`'));
  a.call('advance_until_char');
  a.mov(R_REL, R_N);
  a.call('peek');
  a.ifCmpI('ne', R_PEEK, CH('`'), 'lst_fail');
  a.alui('add', R_N, 1);
  a.call('left_section_op');
  a.ret();
  a.label('lst_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('finish_symop'); // R_SYM
  a.ifValidR(R_SYM, 'fs_go');
  a.ifNValid(LEFT_SECTION_OP, 'fs_fail');
  a.label('fs_go');
  a.call('symop_lookahead');
  a.call('left_section_op');
  a.ifCmpI('ne', R_RESULT, FAIL, 'fs_ret');
  a.markEnd();
  a.mov(R_RESULT, R_SYM);
  a.ret();
  a.label('fs_fail');
  a.const_(R_RESULT, FAIL);
  a.label('fs_ret');
  a.ret();

  a.label('tight_op'); // R_SYM, uses R_WS
  a.ifCmpI('ne', R_WS, 0, 'to_fail');
  a.ifValidR(R_SYM, 'to_yes');
  a.label('to_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();
  a.label('to_yes');
  a.mov(R_RESULT, R_SYM);
  a.ret();

  a.label('prefix_or_varsym'); // R_SYM = prefix
  a.ifCmpI('eq', R_WS, 0, 'pov_var');
  a.ifNValidR(R_SYM, 'pov_var');
  a.mov(R_RESULT, R_SYM);
  a.ret();
  a.label('pov_var');
  a.const_(R_SYM, VARSYM);
  a.call('finish_symop');
  a.ret();

  a.label('tight_or_varsym'); // R_SYM = tight
  a.call('tight_op');
  a.ifCmpI('ne', R_RESULT, FAIL, 'tov_ret');
  a.const_(R_SYM, VARSYM);
  a.call('finish_symop');
  a.label('tov_ret');
  a.ret();

  a.label('infix_or_varsym'); // R_SYM = prefix, R_TMP2 = tight
  a.ifCmpI('eq', R_WS, 0, 'iov_tight');
  a.ifNValidR(R_SYM, 'iov_var');
  a.mov(R_RESULT, R_SYM);
  a.ret();
  a.label('iov_tight');
  a.mov(R_SYM, R_TMP2);
  a.ifNValidR(R_SYM, 'iov_var');
  a.mov(R_RESULT, R_SYM);
  a.ret();
  a.label('iov_var');
  a.const_(R_SYM, VARSYM);
  a.call('finish_symop');
  a.ret();

  a.label('conid'); // -> R_N  0 if not
  peekAt(0);
  a.ifNClassR(C_CONID, R_PEEK, 'con_no');
  a.const_(R_REL, 1);
  a.call('aw_inner');
  a.ret();
  a.label('con_no');
  a.const_(R_N, 0);
  a.ret();

  a.label('is_symop');
  a.call('symop_lookahead');
  a.ifCmpI('gt', R_N, 0, 'iso_yes');
  a.const_(R_OK, 0);
  a.ret();
  a.label('iso_yes');
  a.const_(R_OK, 1);
  a.ret();

  a.label('qualified_op');
  // qualified_name with is_symop
  a.const_(R_OK, 0); // qualified flag in R_FLAGS
  a.const_(R_FLAGS, 0);
  a.label('qo_loop');
  a.call('conid');
  a.ifCmpI('eq', R_N, 0, 'qo_break');
  a.mov(R_REL, R_N);
  a.call('peek');
  a.ifCmpI('eq', R_PEEK, CH('.'), 'qo_dot');
  a.ifCmpI('eq', R_FLAGS, 0, 'qo_break');
  a.const_(R_RESULT, FAIL); // QualifiedConid, not a target
  a.ret();
  a.label('qo_dot');
  a.const_(R_FLAGS, 1);
  a.mov(R_REL, R_N);
  a.alui('add', R_REL, 1);
  a.call('reset_to');
  a.call('is_symop');
  a.ifCmpI('eq', R_OK, 0, 'qo_loop');
  a.call('symop_lookahead');
  a.call('left_section_op');
  a.ifCmpI('ne', R_RESULT, FAIL, 'qo_ret');
  a.const_(R_RESULT, QUALIFIED_OP);
  a.ret();
  a.label('qo_break');
  a.const_(R_RESULT, FAIL);
  a.label('qo_ret');
  a.ret();

  a.label('match_symop'); // compare R_SYMOP length to a literal, seq it. uses R_SAVED as len target - inlined at calls

  a.label('process_token_symop');
  a.ifCmpI('eq', R_NEXT, LDotDot, 'psy_dd');
  a.ifCmpI('eq', R_NEXT, LDotId, 'psy_di');
  a.ifCmpI('eq', R_NEXT, LDotSymop, 'psy_ds');
  a.ifCmpI('eq', R_NEXT, LDotOpen, 'psy_do');
  a.ifCmpI('eq', R_NEXT, LBang, 'psy_bang');
  a.ifCmpI('eq', R_NEXT, LTilde, 'psy_tilde');
  a.ifCmpI('eq', R_NEXT, LAt, 'psy_at');
  a.ifCmpI('eq', R_NEXT, LPercent, 'psy_pct');
  a.ifCmpI('eq', R_NEXT, LSymop, 'psy_sym');
  a.ifCmpI('eq', R_NEXT, LSymopSpecial, 'psy_ss');
  a.ifCmpI('eq', R_NEXT, LUnboxedClose, 'psy_lso');
  a.ifCmpI('eq', R_NEXT, LHash, 'psy_lso');
  a.ifCmpI('eq', R_NEXT, LTick, 'psy_tick');
  a.ifCmpI('eq', R_NEXT, LUpper, 'psy_up');
  a.const_(R_RESULT, FAIL);
  a.ret();
  a.label('psy_dd');
  a.ifValid(DOTDOT, 'psy_dd_yes');
  a.const_(R_SYM, QUAL_DOT);
  a.call('tight_op');
  a.ret();
  a.label('psy_dd_yes');
  a.const_(R_RESULT, DOTDOT);
  a.ret();
  a.label('psy_di');
  a.ifCmpI('eq', R_WS, 0, 'psy_di_t');
  a.ifValid(PREFIX_DOT, 'psy_di_p');
  a.jmp('psy_di_q');
  a.label('psy_di_t');
  a.ifValid(TIGHT_DOT, 'psy_di_tt');
  a.label('psy_di_q');
  a.const_(R_SYM, QUAL_DOT);
  a.call('tight_op');
  a.ret();
  a.label('psy_di_p');
  a.const_(R_RESULT, PREFIX_DOT);
  a.ret();
  a.label('psy_di_tt');
  a.const_(R_RESULT, TIGHT_DOT);
  a.ret();
  a.label('psy_ds');
  a.const_(R_SYM, QUAL_DOT);
  a.call('tight_or_varsym');
  a.ret();
  a.label('psy_do');
  a.const_(R_SYM, PREFIX_DOT);
  a.call('prefix_or_varsym');
  a.ret();
  a.label('psy_bang');
  a.const_(R_SYM, PREFIX_BANG);
  a.const_(R_TMP2, TIGHT_BANG);
  a.call('infix_or_varsym');
  a.ret();
  a.label('psy_tilde');
  a.const_(R_SYM, PREFIX_TILDE);
  a.const_(R_TMP2, TIGHT_TILDE);
  a.call('infix_or_varsym');
  a.ret();
  a.label('psy_at');
  a.const_(R_SYM, PREFIX_AT);
  a.const_(R_TMP2, TIGHT_AT);
  a.call('infix_or_varsym');
  a.ret();
  a.label('psy_pct');
  a.const_(R_SYM, PREFIX_PERCENT);
  a.call('prefix_or_varsym');
  a.ret();
  a.label('psy_sym');
  peekAt(0);
  a.ifCmpI('eq', R_PEEK, CH(':'), 'psy_con');
  a.const_(R_SYM, VARSYM);
  a.call('finish_symop');
  a.ret();
  a.label('psy_con');
  a.const_(R_SYM, CONSYM);
  a.call('finish_symop');
  a.ret();
  a.label('psy_ss');
  a.call('symop_lookahead');
  a.call('left_section_op');
  a.ifCmpI('ne', R_RESULT, FAIL, 'psy_ret');
  a.ifNValid(MINUS, 'psy_fail');
  a.call('symop_lookahead');
  a.ifCmpI('ne', R_N, 1, 'psy_fail');
  {
    const yes = U('mn'), no = U('mnn');
    seq('-', yes, no);
    a.label(yes);
    a.const_(R_RESULT, MINUS);
    a.ret();
    a.label(no);
  }
  a.jmp('psy_fail');
  a.label('psy_lso');
  a.call('symop_lookahead');
  a.call('left_section_op');
  a.ret();
  a.label('psy_tick');
  a.call('left_section_ticked');
  a.ret();
  a.label('psy_up');
  a.ifValid(QUALIFIED_OP, 'psy_qo');
  a.ifValid(LEFT_SECTION_OP, 'psy_qo');
  a.jmp('psy_fail');
  a.label('psy_qo');
  a.call('qualified_op');
  a.ret();
  a.label('psy_fail');
  a.const_(R_RESULT, FAIL);
  a.label('psy_ret');
  a.ret();

  a.label('process_token_splice');
  a.ifCmpI('ne', R_NEXT, LDollar, 'ptspl_fail');
  a.ifNValid(SPLICE, 'ptspl_fail');
  a.const_(R_RESULT, SPLICE);
  a.ret();
  a.label('ptspl_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();

  a.label('process_token_interior');
  a.ifCmpI('eq', R_NEXT, LBraceClose, 'pti_bc');
  a.ifCmpI('eq', R_NEXT, LModule, 'pti_fail');
  a.ifCmpI('eq', R_NEXT, LSemi, 'pti_semi');
  a.ifCmpI('eq', R_NEXT, LBracketOpen, 'pti_qq');
  a.call('process_token_safe');
  a.ifCmpI('ne', R_RESULT, FAIL, 'pti_ret');
  a.call('start_layout_interior');
  a.ret();
  a.label('pti_bc');
  a.call('end_layout_brace');
  a.ifCmpI('ne', R_RESULT, FAIL, 'pti_ret');
  a.call('token_end_layout_texp');
  a.ret();
  a.label('pti_semi');
  a.call('explicit_semicolon');
  a.ret();
  a.label('pti_qq');
  a.const_(R_RESULT, QQ_START);
  a.ret();
  a.label('pti_fail');
  a.const_(R_RESULT, FAIL);
  a.label('pti_ret');
  a.ret();

  a.label('process_token_init'); // R_INDENT, R_NEXT
  a.ifCmpI('eq', R_NEXT, LModule, 'pti2_mod');
  a.ifCmpI('eq', R_NEXT, LBraceOpen, 'pti2_br');
  a.const_(R_SORT, DeclLayout);
  a.call('push_context');
  a.const_(R_RESULT, START);
  a.ret();
  a.label('pti2_mod');
  a.const_(R_SORT, ModuleHeader);
  a.const_(R_INDENT, 0);
  a.call('push_context');
  a.const_(R_RESULT, UPDATE);
  a.ret();
  a.label('pti2_br');
  a.const_(R_REL, 0);
  a.mov(R_ABS, R_LA_OFF);
  a.call('advance_over_abs');
  a.markEnd();
  a.const_(R_SORT, Braces);
  a.call('push_context');
  a.const_(R_RESULT, START_EXPLICIT);
  a.ret();

  // ======================================================================
  // Newline
  // ======================================================================
  a.label('newline_extras'); // R_WS
  a.const_(R_BOL, 0);
  a.ifCmpI('eq', R_WS, BOL, 'ne_bol');
  a.ifCmpI('ne', R_WS, NoSpace, 'ne_lex');
  a.ifCmpI('ne', R_NL_STATE, NInit, 'ne_lex');
  a.label('ne_bol');
  a.const_(R_BOL, 1);
  a.label('ne_lex');
  a.call('lex_extras');
  a.call('process_token_safe');
  a.ret();

  a.label('newline_process');
  a.mov(R_COL, R_NL_INDENT);
  a.mov(R_SAVED, R_NL_END);
  a.mov(R_NEXT, R_NL_END);
  a.call('end_layout_indent');
  a.ifCmpI('ne', R_RESULT, FAIL, 'np_ret');
  a.call('process_token_safe');
  a.ifCmpI('ne', R_RESULT, FAIL, 'np_ret');
  a.call('skip_whitespace');
  a.markEnd();
  a.ifCmpI('eq', R_NL_UNSAFE, 0, 'np_lay');
  a.call('newline_extras');
  a.ifCmpI('ne', R_RESULT, FAIL, 'np_ret');
  a.label('np_lay');
  a.ifCmpI('ne', R_NL_EOF, 0, 'np_semi');
  a.call('start_layout_newline');
  a.ifCmpI('ne', R_RESULT, FAIL, 'np_ret');
  a.label('np_semi');
  a.call('semicolon');
  a.ifCmpI('ne', R_RESULT, FAIL, 'np_ret');
  a.call('reset_newline');
  a.len(S_SORT, R_TMP);
  a.ifCmpI('ne', R_TMP, 0, 'np_sym');
  a.mov(R_INDENT, R_COL);
  a.mov(R_NEXT, R_SAVED);
  a.call('process_token_init');
  a.ifCmpI('ne', R_RESULT, FAIL, 'np_ret');
  a.jmp('np_upd');
  a.label('np_sym');
  a.mov(R_NEXT, R_SAVED);
  a.const_(R_WS, 1);
  a.call('process_token_symop');
  a.ifCmpI('ne', R_RESULT, FAIL, 'np_ret');
  a.call('process_token_splice');
  a.ifCmpI('ne', R_RESULT, FAIL, 'np_ret');
  a.label('np_upd');
  a.const_(R_RESULT, UPDATE);
  a.label('np_ret');
  a.ret();

  a.label('newline_post');
  a.call('newline_process');
  a.ifCmpI('ne', R_NL_STATE, NInit, 'npo_ret');
  a.const_(R_NL_STATE, NProcess);
  a.label('npo_ret');
  a.ret();

  a.label('newline_lookahead');
  a.label('nll_loop');
  peekAt(0);
  a.ifClassR(C_NEWLINE, R_PEEK, 'nll_nl');
  a.ifCmpI('eq', R_PEEK, CH('\t'), 'nll_tab');
  a.ifClassR(C_SPACE, R_PEEK, 'nll_sp');
  a.const_(R_BOL, 0);
  a.ifCmpI('eq', R_NL_INDENT, 0, 'nll_bol');
  a.jmp('nll_lex');
  a.label('nll_bol');
  a.const_(R_BOL, 1);
  a.label('nll_lex');
  a.call('lex');
  a.mov(R_NL_END, R_NEXT);
  a.ifCmpI('eq', R_LA_SIZE, 0, 'nll_safe');
  a.const_(R_NL_UNSAFE, 1);
  a.label('nll_safe');
  a.ifCmpI('eq', R_NEXT, LEof, 'nll_eof');
  a.ifCmpI('eq', R_NEXT, LThen, 'nll_nosemi');
  a.ifCmpI('eq', R_NEXT, LElse, 'nll_nosemi');
  a.ifCmpI('eq', R_NEXT, LSemi, 'nll_nosemi');
  a.ifCmpI('eq', R_NEXT, LBlockComment, 'nll_bc');
  a.ifCmpI('eq', R_NEXT, LLineComment, 'nll_lc');
  a.ifCmpI('eq', R_NEXT, LCppElse, 'nll_ce');
  a.ifCmpI('eq', R_NEXT, LCpp, 'nll_cpp');
  a.ret();
  a.label('nll_nl');
  a.const_(R_REL, 0);
  a.call('skip_over');
  a.const_(R_NL_INDENT, 0);
  a.jmp('nll_reset');
  a.label('nll_tab');
  a.const_(R_REL, 0);
  a.call('skip_over');
  a.alui('add', R_NL_INDENT, 8);
  a.jmp('nll_reset');
  a.label('nll_sp');
  a.const_(R_REL, 0);
  a.call('skip_over');
  a.alui('add', R_NL_INDENT, 1);
  a.jmp('nll_reset');
  a.label('nll_eof');
  a.const_(R_NL_INDENT, 0);
  a.const_(R_NL_EOF, 1);
  a.ret();
  a.label('nll_nosemi');
  a.const_(R_NL_NO_SEMI, 1);
  a.ret();
  a.label('nll_bc');
  a.mov(R_COL, R_NL_INDENT);
  a.alui('add', R_COL, 2);
  a.call('consume_block_comment');
  a.mov(R_NL_INDENT, R_COL);
  a.jmp('nll_reset');
  a.label('nll_lc');
  a.const_(R_NL_INDENT, 0);
  a.call('take_line');
  a.jmp('nll_reset');
  a.label('nll_ce');
  a.const_(R_OK, 0);
  a.call('cpp_else_fn');
  a.call('take_line_esc');
  a.jmp('nll_reset');
  a.label('nll_cpp');
  a.call('take_line_esc');
  a.label('nll_reset');
  a.call('reset_la');
  a.jmp('nll_loop');

  a.label('newline_start');
  a.const_(R_NL_STATE, NInit);
  a.call('newline_lookahead');
  a.ifCmpI('eq', R_NL_UNSAFE, 0, 'ns_post');
  a.const_(R_RESULT, UPDATE);
  a.ret();
  a.label('ns_post');
  a.call('newline_post');
  a.ret();

  a.label('newline_resume');
  a.mov(R_SAVED, R_NL_INDENT);
  a.call('skip_space');
  a.call('reset_newline');
  a.mov(R_NL_INDENT, R_SAVED);
  a.call('newline_start');
  a.ret();

  // ======================================================================
  // Interior / constraint (simplified but complete enough to drive)
  // ======================================================================
  a.label('interior');
  a.const_(R_BOL, 0);
  a.call('lex');
  a.call('resolve_semicolon');
  a.ifCmpI('ne', R_RESULT, FAIL, 'int_ret');
  a.call('process_token_interior');
  a.ifCmpI('ne', R_RESULT, FAIL, 'int_ret');
  a.call('process_token_symop');
  a.ifCmpI('ne', R_RESULT, FAIL, 'int_ret');
  a.call('process_token_constraint');
  a.ifCmpI('ne', R_RESULT, FAIL, 'int_ret');
  a.call('process_token_splice');
  a.label('int_ret');
  a.ret();

  a.label('process_token_constraint');
  a.ifValid(CONTEXT, 'ptc_go');
  a.ifValid(INFIX, 'ptc_go');
  a.ifValid(DATA_INFIX, 'ptc_go');
  a.ifValid(TYPE_INSTANCE, 'ptc_go');
  a.const_(R_RESULT, FAIL);
  a.ret();
  a.label('ptc_go');
  a.call('constraint_lookahead');
  a.ret();

  // Constraint lookahead -- transcribed from ctr_* .
  a.label('save_nl');
  a.push(3, R_NL_STATE);
  a.push(3, R_NL_END);
  a.push(3, R_NL_INDENT);
  a.push(3, R_NL_EOF);
  a.push(3, R_NL_NO_SEMI);
  a.push(3, R_NL_SKIP_SEMI);
  a.push(3, R_NL_UNSAFE);
  a.ret();
  a.label('restore_nl');
  a.pop(3, R_NL_UNSAFE);
  a.pop(3, R_NL_SKIP_SEMI);
  a.pop(3, R_NL_NO_SEMI);
  a.pop(3, R_NL_EOF);
  a.pop(3, R_NL_INDENT);
  a.pop(3, R_NL_END);
  a.pop(3, R_NL_STATE);
  a.ret();

  a.label('constraint_lookahead');
  a.const_(R_CTR_RESET, 0);
  a.const_(R_BRACKETS, 0);
  a.const_(R_FLAGS, 0); // bit0 context, bit1 infix, bit2 data_infix, bit3 type_instance
  a.label('cl_loop');
  a.ifEof('cl_done');
  // Local Newline {.state = 0, .indent = 99999}; do not mutate env->newline.
  a.call('save_nl');
  a.call('reset_newline');
  a.const_(R_NL_INDENT, 99999);
  a.call('newline_lookahead');
  a.mov(R_COL, R_NL_INDENT);
  a.mov(R_NEXT, R_NL_END);
  a.call('restore_nl');
  a.call('current_indent');
  a.ifCmp('gt', R_COL, R_N, 'cl_step');
  a.call('current_context');
  a.ifCmpI('eq', R_SORT, Braces, 'cl_step');
  a.jmp('cl_done');
  a.label('cl_step');
  a.call('ctr_lookahead_step');
  a.ifCmpI('eq', R_N, CtrArrowFound, 'cl_arr');
  a.ifCmpI('eq', R_N, CtrInfixFound, 'cl_inf');
  a.ifCmpI('eq', R_N, CtrEqualsFound, 'cl_eq');
  a.ifCmpI('eq', R_N, CtrBarFound, 'cl_bar');
  a.ifCmpI('eq', R_N, CtrImpossible, 'cl_imp');
  a.jmp('cl_cont');
  a.label('cl_arr');
  a.alui('or', R_FLAGS, 1);
  a.jmp('cl_done');
  a.label('cl_inf');
  peekAt(0);
  a.ifCmpI('eq', R_PEEK, CH(':'), 'cl_dinf');
  a.ifCmpI('eq', R_PEEK, CH('`'), 'cl_dinf');
  a.jmp('cl_inf2');
  a.label('cl_dinf');
  a.alui('or', R_FLAGS, 4);
  a.label('cl_inf2');
  a.alui('or', R_FLAGS, 2);
  a.ifNValid(CONTEXT, 'cl_done');
  a.jmp('cl_cont');
  a.label('cl_eq');
  a.ifNValid(TYPE_INSTANCE, 'cl_done');
  a.alui('or', R_FLAGS, 8);
  a.jmp('cl_cont');
  a.label('cl_bar');
  a.mov(R_TMP, R_FLAGS);
  a.alui('and', R_TMP, ~8);
  a.mov(R_FLAGS, R_TMP);
  a.jmp('cl_done');
  a.label('cl_imp');
  a.jmp('cl_done');
  a.label('cl_cont');
  a.mov(R_REL, R_CTR_RESET);
  a.call('reset_to');
  a.const_(R_CTR_RESET, 0);
  a.jmp('cl_loop');
  a.label('cl_done');
  a.mov(R_TMP, R_FLAGS);
  a.alui('and', R_TMP, 1);
  a.ifCmpI('eq', R_TMP, 0, 'cl_i');
  a.ifValid(CONTEXT, 'cl_ctx');
  a.label('cl_i');
  a.mov(R_TMP, R_FLAGS);
  a.alui('and', R_TMP, 2);
  a.ifCmpI('eq', R_TMP, 0, 'cl_di');
  a.ifValid(INFIX, 'cl_infix');
  a.label('cl_di');
  a.mov(R_TMP, R_FLAGS);
  a.alui('and', R_TMP, 4);
  a.ifCmpI('eq', R_TMP, 0, 'cl_ti');
  a.ifValid(DATA_INFIX, 'cl_dinfix');
  a.label('cl_ti');
  a.mov(R_TMP, R_FLAGS);
  a.alui('and', R_TMP, 8);
  a.ifCmpI('eq', R_TMP, 0, 'cl_fail');
  a.ifValid(TYPE_INSTANCE, 'cl_ty');
  a.label('cl_fail');
  a.const_(R_RESULT, FAIL);
  a.ret();
  a.label('cl_ctx');
  a.const_(R_RESULT, CONTEXT);
  a.ret();
  a.label('cl_infix');
  a.const_(R_RESULT, INFIX);
  a.ret();
  a.label('cl_dinfix');
  a.const_(R_RESULT, DATA_INFIX);
  a.ret();
  a.label('cl_ty');
  a.const_(R_RESULT, TYPE_INSTANCE);
  a.ret();

  a.label('ctr_lookahead_step'); // R_NEXT -> R_N CtrResult
  a.const_(R_CTR_RESET, 1);
  a.ifCmpI('eq', R_NEXT, LBraceClose, 'cls_bc');
  a.ifCmpI('eq', R_NEXT, LUnboxedClose, 'cls_ub');
  a.ifCmpI('eq', R_NEXT, LBraceOpen, 'cls_bo');
  a.ifCmpI('eq', R_NEXT, LSymopSpecial, 'cls_sy');
  a.ifCmpI('eq', R_NEXT, LSymop, 'cls_sy');
  a.ifCmpI('eq', R_NEXT, LUpper, 'cls_up');
  a.ifCmpI('eq', R_NEXT, LDotId, 'cls_und');
  a.ifCmpI('eq', R_NEXT, LPragma, 'cls_pr');
  a.ifCmpI('eq', R_NEXT, LTexpCloser, 'cls_texp');
  a.ifCmpI('eq', R_NEXT, LNothing, 'cls_texp');
  a.jmp('cls_topchk');
  a.label('cls_bc');
  a.call('ctr_bracket_close');
  a.ret();
  a.label('cls_ub');
  a.call('ctr_bracket_close');
  a.ifCmpI('ne', R_N, CtrUndecided, 'cls_ret');
  a.const_(R_CTR_RESET, 2);
  a.const_(R_N, CtrUndecided);
  a.ret();
  a.label('cls_bo');
  a.call('ctr_bracket_open');
  a.ret();
  a.label('cls_sy');
  a.call('symop_lookahead');
  a.mov(R_CTR_RESET, R_N);
  a.jmp('cls_topchk');
  a.label('cls_up');
  a.call('conid');
  a.mov(R_CTR_RESET, R_N);
  a.const_(R_N, CtrUndecided);
  a.ret();
  a.label('cls_pr');
  a.call('consume_pragma');
  a.ifCmpI('eq', R_OK, 0, 'cls_und');
  a.const_(R_CTR_RESET, 3);
  a.label('cls_und');
  a.const_(R_N, CtrUndecided);
  a.ret();
  a.label('cls_texp');
  peekAt(0);
  a.ifCmpI('eq', R_PEEK, CH(')'), 'cls_bc');
  a.ifCmpI('eq', R_PEEK, CH(']'), 'cls_bc');
  a.ifCmpI('eq', R_PEEK, CH('('), 'cls_bo');
  a.ifCmpI('eq', R_PEEK, CH('['), 'cls_bo');
  a.ifCmpI('eq', R_PEEK, CH('"'), 'cls_str');
  a.ifCmpI('eq', R_PEEK, CH('\''), 'cls_chr');
  a.ifClassR(C_VARID, R_PEEK, 'cls_var');
  a.jmp('cls_topchk');
  a.label('cls_str');
  a.call('take_string_literal');
  a.mov(R_CTR_RESET, R_N);
  a.const_(R_N, CtrUndecided);
  a.ret();
  a.label('cls_chr');
  a.call('take_char_literal');
  a.mov(R_CTR_RESET, R_N);
  a.const_(R_N, CtrUndecided);
  a.ret();
  a.label('cls_var');
  a.const_(R_REL, 1);
  a.call('aw_id');
  a.mov(R_CTR_RESET, R_N);
  a.label('cls_topchk');
  a.ifCmpI('ne', R_BRACKETS, 0, 'cls_und');
  a.call('ctr_top');
  a.label('cls_ret');
  a.ret();

  a.label('ctr_bracket_open');
  a.alui('add', R_BRACKETS, 1);
  a.const_(R_CTR_RESET, 1);
  a.const_(R_N, CtrUndecided);
  a.ret();

  a.label('ctr_bracket_close');
  a.ifCmpI('eq', R_BRACKETS, 0, 'cbc2_imp');
  a.alui('sub', R_BRACKETS, 1);
  a.const_(R_CTR_RESET, 1);
  a.const_(R_N, CtrUndecided);
  a.ret();
  a.label('cbc2_imp');
  a.const_(R_N, CtrImpossible);
  a.ret();

  a.label('ctr_top');
  a.ifCmpI('eq', R_NEXT, LCArrow, 'ctt_arr');
  a.ifCmpI('eq', R_NEXT, LSymop, 'ctt_inf');
  a.ifCmpI('eq', R_NEXT, LSymopSpecial, 'ctt_inf');
  a.ifCmpI('eq', R_NEXT, LTilde, 'ctt_inf');
  a.ifCmpI('eq', R_NEXT, LTick, 'ctt_inf');
  a.ifCmpI('eq', R_NEXT, LBar, 'ctt_bar');
  a.ifCmpI('eq', R_NEXT, LArrow, 'ctt_imp');
  a.ifCmpI('eq', R_NEXT, LWhere, 'ctt_imp');
  a.ifCmpI('eq', R_NEXT, LDotDot, 'ctt_imp');
  a.ifCmpI('eq', R_NEXT, LSemi, 'ctt_imp');
  a.ifCmpI('eq', R_NEXT, LTexpCloser, 'ctt_texp');
  peekAt(0);
  a.ifCmpI('eq', R_PEEK, CH('='), 'ctt_eq');
  a.ifCmpI('eq', R_PEEK, 0x2200, 'ctt_imp');
  a.ifCmpI('eq', R_PEEK, CH(':'), 'ctt_col');
  a.ifCmpI('eq', R_PEEK, CH('f'), 'ctt_f');
  a.ifCmpI('eq', R_PEEK, CH('i'), 'ctt_i');
  a.const_(R_N, CtrUndecided);
  a.ret();
  a.label('ctt_arr');
  a.const_(R_N, CtrArrowFound);
  a.ret();
  a.label('ctt_inf');
  a.const_(R_N, CtrInfixFound);
  a.ret();
  a.label('ctt_bar');
  a.const_(R_N, CtrBarFound);
  a.ret();
  a.label('ctt_eq');
  a.const_(R_N, CtrEqualsFound);
  a.ret();
  a.label('ctt_texp');
  peekAt(0);
  a.ifCmpI('eq', R_PEEK, CH('='), 'ctt_eq');
  a.const_(R_N, CtrImpossible);
  a.ret();
  a.label('ctt_col');
  peekAt(1);
  a.ifCmpI('eq', R_PEEK, CH(':'), 'ctt_imp');
  a.const_(R_N, CtrUndecided);
  a.ret();
  a.label('ctt_f');
  {
    const yes = U('fa'), no = U('fan');
    token('forall', yes, no);
    a.label(yes); a.const_(R_N, CtrImpossible); a.ret();
    a.label(no);
  }
  {
    const yes = U('fm'), no = U('fmn');
    token('family', yes, no);
    a.label(yes); a.const_(R_N, CtrImpossible); a.ret();
    a.label(no);
  }
  a.const_(R_N, CtrUndecided);
  a.ret();
  a.label('ctt_i');
  {
    const yes = U('ins'), no = U('insn');
    token('instance', yes, no);
    a.label(yes); a.const_(R_N, CtrImpossible); a.ret();
    a.label(no);
  }
  a.const_(R_N, CtrUndecided);
  a.ret();
  a.label('ctt_imp');
  a.const_(R_N, CtrImpossible);
  a.ret();

  a.label('take_string_literal');
  a.const_(R_N, 1);
  a.label('tsl_loop');
  a.mov(R_REL, R_N);
  a.const_(R_TMP2, CH('"'));
  a.call('advance_until_char');
  a.alui('add', R_N, 1);
  a.ifEof('tsl_ret');
  // odd_backslashes_before(end-2)
  a.mov(R_COL, R_N);
  a.alui('sub', R_COL, 2);
  a.const_(R_OK, 0);
  a.label('obb_loop');
  a.ifCmpI('lt', R_COL, 0, 'obb_done');
  a.mov(R_REL, R_COL);
  a.call('peek');
  a.ifCmpI('ne', R_PEEK, CH('\\'), 'obb_done');
  a.const_(R_TMP, 1);
  a.alu('xor', R_OK, R_TMP);
  a.alui('sub', R_COL, 1);
  a.jmp('obb_loop');
  a.label('obb_done');
  a.ifCmpI('ne', R_OK, 0, 'tsl_loop');
  a.label('tsl_ret');
  a.ret();

  a.label('take_char_literal');
  peekAt(1);
  a.ifCmpI('eq', R_PEEK, CH('\\'), 'tcl_esc');
  peekAt(2);
  a.ifCmpI('eq', R_PEEK, CH('\''), 'tcl_3');
  a.const_(R_N, 1);
  a.ret();
  a.label('tcl_3');
  a.const_(R_N, 3);
  a.ret();
  a.label('tcl_esc');
  a.const_(R_REL, 2);
  a.const_(R_TMP2, CH('\''));
  a.call('advance_until_char');
  a.alui('add', R_N, 2);
  a.ret();

  // ======================================================================
  const reserved = [CH('('), CH(')'), CH(','), CH(';'), CH('['), CH(']'),
    CH('`'), CH('{'), CH('}'), CH('"'), CH('\''), CH('_')];

  return {
    entry: 0,
    regPersist: 0x7f, // registers 0..6
    stacks: [{ persist: true }, { persist: true }, { persist: false }, { persist: false }],
    stackInit: [],
    classes: [
      UNI.space,
      union(one('\n'), one('\r'), one('\f')),
      union(UNI.identifier, one('_'), one("'")),
      union(UNI.identifier, one('_'), one("'"), one('#')),
      union(UNI.varid_start, one('_')),
      UNI.conid_start,
      subtract(UNI.symop, reserved),
      union(UNI.identifier, one('_'), one("'"), one('.')),
      union(one(' '), one('\t')),
    ],
    maps: [],
    strings: [],
    validSets: [],
    jumpTable: [],
    code: a.build(),
  };
}

module.exports = { build };
