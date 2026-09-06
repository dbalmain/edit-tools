// tree-sitter-css 0.25.0's 100-line scanner, hand-compiled to scanner-VM
// bytecode. Upstream source is reproduced in comments so the two can be diffed
// by eye; that is the only review this port gets.
//
// External token order is upstream's enum, and it is load-bearing -- the parser
// passes `valid_symbols` indexed by it.
//
// css is the worked example in `docs/host-ctype-divergence.md`: whether `a b`
// in a selector is one `descendant_selector` or two unrelated tokens is decided
// by `iswspace`, and three hosts give three answers. That is exactly why the
// classes below come from `harness/ctype/wctype.utf8.json` -- glibc's answer
// under UTF-8, which is what froze the corpus -- rather than from whatever
// `isw*` the runtime happens to be sitting on.
'use strict';
const fs = require('fs');
const path = require('path');
const { Asm } = require('../../spike/scanner-vm/asm.js');

const CTYPE = path.join(__dirname, '..', 'ctype', 'wctype.utf8.json');

// Upstream's `enum TokenType`.
const DESCENDANT_OP = 0;
const PSEUDO_CLASS_SELECTOR_COLON = 1;
const ERROR_RECOVERY = 2;

// Class table slots. `space` is 8 ranges; `alnum` is 802, which is the bulk of
// this program's size and is shared with eight other scanners -- see
// `harness/ts_ctype_tables.py` on where that table should live.
const C_SPACE = 0;
const C_ALNUM = 1;

// Registers.
const R_IN_COMMENT = 0;
const R_EOF = 1;

function build() {
  const ctype = JSON.parse(fs.readFileSync(CTYPE, 'utf8')).classes;
  const a = new Asm();

  //   if (valid_symbols[ERROR_RECOVERY]) return false;
  a.label('entry');
  a.ifValid(ERROR_RECOVERY, 'fail');

  //   if (iswspace(lexer->lookahead) && valid_symbols[DESCENDANT_OP]) {
  // Both operands are pure, so the cheaper test goes first.
  a.ifNValid(DESCENDANT_OP, 'pseudo');
  a.ifNClass(C_SPACE, 'pseudo');

  //     lexer->result_symbol = DESCENDANT_OP;
  // Deferred: the VM sets the symbol as it halts, and upstream only ever reads
  // result_symbol on a true return.
  //
  //     skip(lexer);
  //     while (iswspace(lexer->lookahead)) skip(lexer);
  a.skip();
  a.label('d_ws');
  a.ifNClass(C_SPACE, 'd_marked');
  a.skip();
  a.jmp('d_ws');

  //     lexer->mark_end(lexer);
  // Note this survives the fall-through below into the pseudo-class branch,
  // exactly as it does upstream -- mark_end is a lexer call, not local state.
  a.label('d_marked');
  a.markEnd();

  //     if (lookahead == '#' || '.' || '[' || '-' || '*' || iswalnum(...))
  //       return true;
  for (const ch of '#.[-*') a.ifChar(ch.codePointAt(0), 'emit_descendant');
  a.ifClass(C_ALNUM, 'emit_descendant');

  //     if (lexer->lookahead == ':') {
  a.ifNChar(0x3a, 'pseudo');
  //       advance(lexer);
  //       if (iswspace(lexer->lookahead)) return false;
  a.advance();
  a.ifClass(C_SPACE, 'fail');
  //       for (;;) {
  //         if (lookahead == ';' || '}' || eof) return false;
  //         if (lookahead == '{') return true;
  //         advance(lexer);
  //       }
  a.label('d_loop');
  a.ifChar(0x3b, 'fail');
  a.ifChar(0x7d, 'fail');
  a.ifEof('fail');
  a.ifChar(0x7b, 'emit_descendant');
  a.advance();
  a.jmp('d_loop');

  a.label('emit_descendant');
  a.emit(DESCENDANT_OP);

  //   if (valid_symbols[PSEUDO_CLASS_SELECTOR_COLON]) {
  a.label('pseudo');
  a.ifNValid(PSEUDO_CLASS_SELECTOR_COLON, 'fail');

  //     while (iswspace(lexer->lookahead)) skip(lexer);
  a.label('p_ws');
  a.ifNClass(C_SPACE, 'p_colon');
  a.skip();
  a.jmp('p_ws');

  //     if (lexer->lookahead == ':') {
  //       advance(lexer);
  //       if (lexer->lookahead == ':') return false;
  //       lexer->mark_end(lexer);
  //       lexer->result_symbol = PSEUDO_CLASS_SELECTOR_COLON;
  a.label('p_colon');
  a.ifNChar(0x3a, 'fail');
  a.advance();
  a.ifChar(0x3a, 'fail');
  a.markEnd();

  //       bool in_comment = false;
  a.const_(R_IN_COMMENT, 0);

  //       while (lookahead != ';' && lookahead != '}' && !eof) {
  a.label('p_loop');
  a.ifChar(0x3b, 'p_end');
  a.ifChar(0x7d, 'p_end');
  a.ifEof('p_end');
  //         advance(lexer);
  a.advance();

  //         if (lookahead == '{' && !in_comment) return true;
  a.ifNChar(0x7b, 'p_slash');
  a.ifCmpI('eq', R_IN_COMMENT, 0, 'emit_pseudo');

  //         if (lookahead == '/' && !in_comment) {
  //           advance(lexer);
  //           if (lookahead == '*') in_comment = true;
  //         } else if (lookahead == '*' && in_comment) {
  //           advance(lexer);
  //           if (lookahead == '/') in_comment = false;
  //         }
  // The else-if is why the in_comment test guards a jump back to the loop
  // rather than falling into the second arm: `/` while already in a comment
  // takes neither branch upstream.
  a.label('p_slash');
  a.ifNChar(0x2f, 'p_star');
  a.ifCmpI('ne', R_IN_COMMENT, 0, 'p_loop');
  a.advance();
  a.ifNChar(0x2a, 'p_loop');
  a.const_(R_IN_COMMENT, 1);
  a.jmp('p_loop');

  a.label('p_star');
  a.ifNChar(0x2a, 'p_loop');
  a.ifCmpI('eq', R_IN_COMMENT, 0, 'p_loop');
  a.advance();
  a.ifNChar(0x2f, 'p_loop');
  a.const_(R_IN_COMMENT, 0);
  a.jmp('p_loop');

  //       return lexer->eof(lexer);
  // Upstream returns a pseudo-class colon at EOF on purpose, so a malformed
  // tail parses as an erroneous selector rather than an erroneous property.
  a.label('p_end');
  a.eof(R_EOF);
  a.emitIf(R_EOF, PSEUDO_CLASS_SELECTOR_COLON);

  a.label('emit_pseudo');
  a.emit(PSEUDO_CLASS_SELECTOR_COLON);

  //   return false;
  a.label('fail');
  a.fail();

  return {
    regPersist: 0,          // css's serialize() returns 0 bytes
    stacks: [],
    stackInit: [],
    classes: [ctype.space, ctype.alnum],
    strings: [],
    validSets: [],
    jumpTable: [],
    code: a.build(),
  };
}

module.exports = { build };
