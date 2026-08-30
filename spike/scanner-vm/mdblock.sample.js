// Pricing sample: two functions from markdown-block's 1,602-line scanner,
// hand-compiled to the same ISA that runs TOML.
//
// TOML alone is a bad basis for extrapolation -- it is almost all lexer calls
// and has no state, no arithmetic and no stack.  `advance` and `match` are the
// opposite: tab-stop arithmetic, a 20-arm switch, three loops, and the
// open-block stack.  Together they are 85 lines of the hardest scanner in the
// roster, and they are what the bytes-per-line figure in docs/scanner-vm.md is
// measured from.
//
// This is a pricing artifact, not a port.  It is exercised by the tests at the
// bottom so it cannot rot into a wrong number unnoticed.
const assert = require('assert');
const { Asm } = require('./asm.js');
const { ScannerVM } = require('./vm.js');
const { ByteLexer } = require('./lexer.js');

// Block enum, upstream order.
const BLOCK_QUOTE = 0, INDENTED_CODE_BLOCK = 1, LIST_ITEM = 2;
const LIST_ITEM_MAX_INDENTATION = 17, FENCED_CODE_BLOCK = 18;

// Persistent scalars from `Scanner` (upstream serializes all five).
const R_STATE = 0, R_MATCHED = 1, R_IND = 2, R_COLUMN = 3, R_FENCE = 4;
// Locals.
const R_BLOCK = 6, R_RET = 7, R_SIZE = 8, R_LII = 9;
const CLS_SPTAB = 0;
const S_BLOCKS = 0;

function buildSample() {
  const a = new Asm();

  // Driver, so the sample is executable: match(open_blocks[matched]).
  a.label('entry');
  a.getidx(S_BLOCKS, R_BLOCK, R_MATCHED);
  a.call('match');
  a.emitIf(R_RET, 0);

  // --- static size_t advance(Scanner *s, TSLexer *lexer) -------------------
  //   size_t size = 1;
  //   if (lexer->lookahead == '\t') { size = 4 - s->column; s->column = 0; }
  //   else { s->column = (s->column + 1) % 4; }
  //   lexer->advance(lexer, false);
  //   return size;
  a.label('advance');
  a.const_(R_SIZE, 1);
  a.ifNChar(0x09, 'adv_notab');
  a.const_(R_SIZE, 4).alu('sub', R_SIZE, R_COLUMN).const_(R_COLUMN, 0);
  a.jmp('adv_done');
  a.label('adv_notab');
  a.alui('add', R_COLUMN, 1).alui('mod', R_COLUMN, 4);
  a.label('adv_done');
  a.advance().ret();

  // --- static bool match(Scanner *s, TSLexer *lexer, Block block) ----------
  a.label('match');
  a.const_(R_RET, 0);
  a.ifCmpI('eq', R_BLOCK, BLOCK_QUOTE, 'm_bq');
  a.ifCmpI('eq', R_BLOCK, INDENTED_CODE_BLOCK, 'm_icb');
  a.ifCmpI('ge', R_BLOCK, FENCED_CODE_BLOCK, 'm_true'); // FENCED_CODE_BLOCK, ANONYMOUS
  // fall through: LIST_ITEM .. LIST_ITEM_MAX_INDENTATION

  //   while (s->indentation < list_item_indentation(block)) { ... }
  //   list_item_indentation(b) is (b - LIST_ITEM + 2), written out rather than
  //   folded to `b` -- the identity only holds because LIST_ITEM happens to be
  //   2, and folding it would silently break if the enum were reordered.
  a.label('m_li');
  a.mov(R_LII, R_BLOCK).alui('sub', R_LII, LIST_ITEM).alui('add', R_LII, 2);
  a.label('m_li_loop');
  a.ifCmp('ge', R_IND, R_LII, 'm_li_done');
  a.ifNClass(CLS_SPTAB, 'm_li_done');
  a.call('advance').alu('add', R_IND, R_SIZE).jmp('m_li_loop');
  a.label('m_li_done');
  a.ifCmp('lt', R_IND, R_LII, 'm_li_nl');
  a.alu('sub', R_IND, R_LII).jmp('m_true');
  a.label('m_li_nl');
  a.ifChar(0x0a, 'm_li_zero');
  a.ifNChar(0x0d, 'm_ret');
  a.label('m_li_zero');
  a.const_(R_IND, 0).jmp('m_true');

  //   case INDENTED_CODE_BLOCK
  a.label('m_icb');
  a.label('m_icb_loop');
  a.ifCmpI('ge', R_IND, 4, 'm_icb_done');
  a.ifNClass(CLS_SPTAB, 'm_icb_done');
  a.call('advance').alu('add', R_IND, R_SIZE).jmp('m_icb_loop');
  a.label('m_icb_done');
  a.ifCmpI('lt', R_IND, 4, 'm_ret');
  a.ifChar(0x0a, 'm_ret').ifChar(0x0d, 'm_ret');
  a.alui('sub', R_IND, 4).jmp('m_true');

  //   case BLOCK_QUOTE
  a.label('m_bq');
  a.label('m_bq_ws');
  a.ifNClass(CLS_SPTAB, 'm_bq_gt');
  a.call('advance').alu('add', R_IND, R_SIZE).jmp('m_bq_ws');
  a.label('m_bq_gt');
  a.ifNChar(0x3e, 'm_ret');
  a.call('advance').const_(R_IND, 0);
  a.ifNClass(CLS_SPTAB, 'm_true');
  a.call('advance').alui('sub', R_SIZE, 1).alu('add', R_IND, R_SIZE);

  a.label('m_true');
  a.const_(R_RET, 1);
  a.label('m_ret');
  a.ret();

  const code = a.build();
  return {
    prog: {
      abi: 1, entry: a.labels.get('entry'),
      regPersist: 0b11111,
      stacks: [{ persist: true }, {}, {}, {}],
      stackInit: [], classes: [[0x09, 0x09, 0x20, 0x20]],
      strings: [], validSets: [], jumpTable: [], code,
    },
    labels: a.labels,
    code,
  };
}

// --- what the sample costs ---------------------------------------------------
const { prog, labels, code } = buildSample();
const advanceBytes = labels.get('match') - labels.get('advance');
const matchBytes = code.length - labels.get('match');

// --- and that it actually runs ----------------------------------------------
function runMatch(block, src, indentation = 0, column = 0) {
  const vm = new ScannerVM(prog);
  vm.stacks[S_BLOCKS].push(block);
  vm.reg[R_MATCHED] = 0;
  const lx = new ByteLexer(Buffer.from(src));
  vm.reg[R_IND] = indentation;
  vm.reg[R_COLUMN] = column;
  // enterScan would clear the non-persistent half; set state after it runs by
  // driving run() directly through scan with persistent regs already loaded.
  const res = vm.scan(lx, [true]);
  return { matched: res.ok, indentation: vm.reg[R_IND], cur: lx.cur };
}

if (require.main === module) {
  let pass = 0;
  const t = (name, fn) => {
    try { fn(); pass++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
  };

  t('BLOCK_QUOTE matches "> " and consumes the marker', () => {
    const r = runMatch(BLOCK_QUOTE, '> x');
    assert.strictEqual(r.matched, true);
    assert.strictEqual(r.cur, 2, 'consumes ">" and one following space');
  });

  t('BLOCK_QUOTE does not match a line with no ">"', () => {
    assert.strictEqual(runMatch(BLOCK_QUOTE, 'x').matched, false);
  });

  t('INDENTED_CODE_BLOCK stops the moment it has four columns', () => {
    const r = runMatch(INDENTED_CODE_BLOCK, '     x'); // five spaces
    assert.strictEqual(r.matched, true);
    assert.strictEqual(r.cur, 4, 'the fifth space is left in the input');
    assert.strictEqual(r.indentation, 0);
  });

  t('a tab that overshoots the stop leaves the remainder in indentation', () => {
    // Carried indentation of 2 with the column at 0: the tab is worth a full
    // four, so the counter reaches 6 and 2 survives the subtraction.  This is
    // the "sometimes a tab needs to be split across two tokens" case the
    // upstream comment describes, and it is the only way to get a remainder.
    const r = runMatch(INDENTED_CODE_BLOCK, '\tx', 2, 0);
    assert.strictEqual(r.matched, true);
    assert.strictEqual(r.indentation, 2);
    assert.strictEqual(r.cur, 1);
  });

  t('INDENTED_CODE_BLOCK does not match a blank line', () => {
    assert.strictEqual(runMatch(INDENTED_CODE_BLOCK, '    \n').matched, false);
  });

  t('a tab counts to the next stop of four, not as one column', () => {
    const r = runMatch(INDENTED_CODE_BLOCK, '\tx');
    assert.strictEqual(r.matched, true);
    assert.strictEqual(r.cur, 1, 'one byte consumed');
    assert.strictEqual(r.indentation, 0, 'the tab supplied exactly four columns');
  });

  t('FENCED_CODE_BLOCK and above match unconditionally', () => {
    assert.strictEqual(runMatch(FENCED_CODE_BLOCK, 'anything').matched, true);
  });

  t('a list item consumes its own indentation', () => {
    const r = runMatch(LIST_ITEM_MAX_INDENTATION, ' '.repeat(20) + 'x');
    assert.strictEqual(r.matched, true);
  });

  console.log(`mdblock.sample.js: ${pass} passed`);
  console.log(`  advance()  ${advanceBytes} bytes`);
  console.log(`  match()    ${matchBytes} bytes`);
  console.log(`  total      ${advanceBytes + matchBytes} bytes of bytecode`);
}

module.exports = { buildSample, advanceBytes, matchBytes };
