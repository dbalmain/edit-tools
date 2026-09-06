// Unit tests for the VM machinery TOML's scanner cannot reach.
//
// TOML is stateless (`serialize` returns 0 bytes) and uses no stack, no
// buffer, no recursion and no traps.  So the 45,678-call replay says nothing
// about any of those, and they are exactly where the hard scanners live.
// These drive them directly.
const assert = require('assert');
const { ScannerVM } = require('./vm.js');
const { Asm } = require('./asm.js');
const { ByteLexer } = require('./lexer.js');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

function prog(overrides, buildFn) {
  const a = new Asm();
  buildFn(a);
  return Object.assign(
    { abi: 1, entry: 0, classes: [], strings: [], validSets: [], jumpTable: [],
      regPersist: 0, stacks: [], stackInit: [], code: a.build() },
    overrides,
  );
}

// ---- serialize / deserialize ------------------------------------------------

t('serialize round-trips registers and stacks', () => {
  const p = prog(
    { regPersist: 0b101, stacks: [{ persist: true }, { persist: true }, {}, {}] },
    (a) => a.fail(),
  );
  const vm = new ScannerVM(p);
  vm.reg[0] = -7; vm.reg[2] = 300; vm.reg[1] = 999; // reg 1 is not persistent
  vm.stacks[0].push(1, -2, 3);
  vm.stacks[1].push(70000);
  const bytes = vm.serialize();

  const vm2 = new ScannerVM(p);
  vm2.deserialize(bytes);
  assert.strictEqual(vm2.reg[0], -7);
  assert.strictEqual(vm2.reg[2], 300);
  assert.strictEqual(vm2.reg[1], 0, 'non-persistent register must not survive');
  assert.deepStrictEqual(vm2.stacks[0], [1, -2, 3]);
  assert.deepStrictEqual(vm2.stacks[1], [70000]);
});

t('empty state serializes to nothing and deserializes from nothing', () => {
  const p = prog({}, (a) => a.fail());
  const vm = new ScannerVM(p);
  assert.strictEqual(vm.serialize().length, 0);
  vm.deserialize(new Uint8Array(0)); // must not throw
});

t('stackInit is restored by deserialize, matching python/yaml sentinels', () => {
  const p = prog(
    { stacks: [{ persist: true }, {}, {}, {}], stackInit: [{ stack: 0, values: [-1] }] },
    (a) => a.fail(),
  );
  const vm = new ScannerVM(p);
  assert.deepStrictEqual(vm.stacks[0], [-1]);
  vm.stacks[0].push(4, 5);
  const vm2 = new ScannerVM(p);
  vm2.deserialize(vm.serialize());
  assert.deepStrictEqual(vm2.stacks[0], [-1, 4, 5]);
});

t('over-long state drops from the top, as python and yaml do', () => {
  const p = prog({ stacks: [{ persist: true }, {}, {}, {}] }, (a) => a.fail());
  const vm = new ScannerVM(p);
  for (let i = 0; i < 250; i++) vm.stacks[0].push(i);
  const bytes = vm.serialize(32);
  assert.ok(bytes.length <= 32, `got ${bytes.length}`);
  const vm2 = new ScannerVM(p);
  vm2.deserialize(bytes);
  assert.ok(vm2.stacks[0].length < 250, 'must have dropped something');
  // What survives is the *bottom* of the stack -- the oldest entries.
  assert.strictEqual(vm2.stacks[0][0], 0);
  for (let i = 0; i < vm2.stacks[0].length; i++) assert.strictEqual(vm2.stacks[0][i], i);
});

// ---- arithmetic determinism -------------------------------------------------

t('ALU wraps at i32 rather than growing', () => {
  const p = prog({ regPersist: 1 }, (a) => {
    a.const_(0, 0x7fffffff).const_(1, 1).alu('add', 0, 1).fail();
  });
  const vm = new ScannerVM(p);
  vm.scan(new ByteLexer(Buffer.from('')), [true]);
  assert.strictEqual(vm.reg[0], -0x80000000);
});

t('shift counts are masked to 5 bits, so 32 is a no-op not a panic', () => {
  const p = prog({ regPersist: 1 }, (a) => {
    a.const_(0, 1).const_(1, 32).alu('shl', 0, 1).fail();
  });
  const vm = new ScannerVM(p);
  vm.scan(new ByteLexer(Buffer.from('')), [true]);
  assert.strictEqual(vm.reg[0], 1);
});

t('MOD by a non-positive value traps rather than diverging', () => {
  const p = prog({}, (a) => { a.const_(0, 5).const_(1, 0).alu('mod', 0, 1).emit(0); });
  const vm = new ScannerVM(p);
  const r = vm.scan(new ByteLexer(Buffer.from('')), [true]);
  assert.strictEqual(r.ok, false, 'trap must halt as false, not emit');
});

// ---- traps ------------------------------------------------------------------

t('stack underflow traps', () => {
  const p = prog({ stacks: [{}, {}, {}, {}] }, (a) => { a.pop(0, 0).emit(0); });
  assert.strictEqual(new ScannerVM(p).scan(new ByteLexer(Buffer.from('')), [true]).ok, false);
});

t('stack overflow traps', () => {
  const p = prog({ stacks: [{}, {}, {}, {}] }, (a) => {
    a.const_(0, 1).label('L').push(0, 0).skip().jmp('L');
  });
  const src = Buffer.from('x'.repeat(1000));
  assert.strictEqual(new ScannerVM(p).scan(new ByteLexer(src), [true]).ok, false);
});

t('a non-advancing loop hits the spin budget and traps', () => {
  const p = prog({}, (a) => { a.label('L').jmp('L'); });
  assert.strictEqual(new ScannerVM(p).scan(new ByteLexer(Buffer.from('')), [true]).ok, false);
});

t('unknown opcode traps', () => {
  const p = prog({}, (a) => a.fail());
  p.code = Uint8Array.from([0xfe]);
  assert.strictEqual(new ScannerVM(p).scan(new ByteLexer(Buffer.from('')), [true]).ok, false);
});

t('running off the end of the code traps', () => {
  const p = prog({}, (a) => a.ins(0x00)); // NOP, then nothing
  assert.strictEqual(new ScannerVM(p).scan(new ByteLexer(Buffer.from('')), [true]).ok, false);
});

// ---- classes, buffer, recursion, indirect call ------------------------------

t('IF_CLASS_R tests a register, not the lookahead', () => {
  const p = prog({ classes: [[0x30, 0x39]] }, (a) => {
    a.const_(0, 0x35).ifClassR(0, 0, 'yes').emit(1).label('yes').emit(0);
  });
  assert.strictEqual(new ScannerVM(p).scan(new ByteLexer(Buffer.from('!')), [true]).symbol, 0);
});

t('IF_CLASS binary-searches sorted ranges', () => {
  const p = prog({ classes: [[0x30, 0x39, 0x41, 0x5a, 0x61, 0x7a]] }, (a) => {
    a.ifClass(0, 'yes').emit(1).label('yes').emit(0);
  });
  const vm = new ScannerVM(p);
  for (const [ch, want] of [['5', 0], ['Q', 0], ['q', 0], ['!', 1], ['é', 1]]) {
    assert.strictEqual(vm.scan(new ByteLexer(Buffer.from(ch)), [true]).symbol, want, ch);
  }
});

t('BUF_PUSH takes the low byte only, so no case folding sneaks in', () => {
  const p = prog({ strings: [Uint8Array.from([0x70, 0x72, 0x65])] }, (a) => { // "pre"
    a.bufClr()
      .label('L').ifEof('done').lookahead(0).bufPush(0).advance().jmp('L')
      .label('done').ifBufEq(0, 'hit').emit(1).label('hit').emit(0);
  });
  const vm = new ScannerVM(p);
  assert.strictEqual(vm.scan(new ByteLexer(Buffer.from('pre')), [true]).symbol, 0);
  assert.strictEqual(vm.scan(new ByteLexer(Buffer.from('PRE')), [true]).symbol, 1);
});

t('RECURSE re-enters with a literal valid-symbol set and reports the verdict', () => {
  // Outer runs with valid[0] true, so it reaches RECURSE.  The inner run gets
  // validSets[0], where valid[0] is false, so it takes the other branch and
  // fails -- and R1 must come back 0 rather than the outer's own answer.
  const p = prog({ validSets: [[false, true]] }, (a) => {
    a.ifNValid(0, 'inner')
      .recurse(0, 1)
      .ifCmpI('ne', 1, 0, 'inner_emitted')
      .emit(1)
      .label('inner_emitted').emit(0)
      .label('inner').fail();
  });
  const vm = new ScannerVM(p);
  const r = vm.scan(new ByteLexer(Buffer.from('')), [true, true]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.symbol, 1, 'inner ran with the literal set and failed');
});

t('EMIT_IF halts either way, matching C\'s `return has_content`', () => {
  const p = prog({}, (a) => { a.const_(0, 0).emitIf(0, 3).emit(9); });
  const r = new ScannerVM(p).scan(new ByteLexer(Buffer.from('')), [true]);
  assert.strictEqual(r.ok, false, 'a false EMIT_IF is a return, not a fallthrough');
});

t('CALL_R dispatches through the jump table, covering yaml function pointers', () => {
  const a = new Asm();
  a.const_(0, 1).callR(0).emitR(1);
  a.label('f0').const_(1, 40).ret();
  a.label('f1').const_(1, 41).ret();
  const code = a.build();
  const p = { abi: 1, entry: 0, classes: [], strings: [], validSets: [],
              jumpTable: [a.labels.get('f0'), a.labels.get('f1')],
              regPersist: 0, stacks: [], stackInit: [], code };
  assert.strictEqual(new ScannerVM(p).scan(new ByteLexer(Buffer.from('')), [true]).symbol, 41);
});

t('CALL_R with an out-of-range index traps', () => {
  const a = new Asm();
  a.const_(0, 9).callR(0).emit(0);
  const p = { abi: 1, entry: 0, classes: [], strings: [], validSets: [],
              jumpTable: [0], regPersist: 0, stacks: [], stackInit: [], code: a.build() };
  assert.strictEqual(new ScannerVM(p).scan(new ByteLexer(Buffer.from('')), [true]).ok, false);
});

// ---- lexer host -------------------------------------------------------------

t('advance moves by UTF-8 length, so astral characters are one step', () => {
  const lx = new ByteLexer(Buffer.from('\u{1d400}b'));
  assert.strictEqual(lx.lookahead(), 0x1d400);
  lx.advance(false);
  assert.strictEqual(lx.cur, 4);
  assert.strictEqual(lx.lookahead(), 0x62);
});

t('skip moves the token start past what it consumed', () => {
  const lx = new ByteLexer(Buffer.from('  x'));
  lx.advance(true); lx.advance(true);
  assert.strictEqual(lx.tokenStart, 2);
  assert.strictEqual(lx.lookahead(), 0x78);
});

t('lookahead is 0 at EOF and atEof agrees', () => {
  const lx = new ByteLexer(Buffer.from('a'));
  lx.advance(false);
  assert.strictEqual(lx.lookahead(), 0);
  assert.strictEqual(lx.atEof(), true);
});

t('invalid UTF-8 decodes to -1 with a one-byte step, as tree-sitter does', () => {
  const lx = new ByteLexer(Uint8Array.from([0xff, 0x61]));
  assert.strictEqual(lx.lookahead(), -1);
  lx.advance(false);
  assert.strictEqual(lx.lookahead(), 0x61);
});

t('GET_COLUMN counts codepoints from the last newline, matching get_column', () => {
  const lx = new ByteLexer(Buffer.from('ab\ncdé', 'utf8'));
  assert.strictEqual(lx.column(), 0);
  lx.advance(false); lx.advance(false);
  assert.strictEqual(lx.column(), 2, 'two ASCII chars into row 0');
  lx.advance(false); // over the newline
  assert.strictEqual(lx.column(), 0, 'newline resets the column');
  lx.advance(false); lx.advance(false); lx.advance(false); // c, d, é
  assert.strictEqual(lx.column(), 3, 'é is one codepoint, two bytes');
  assert.strictEqual(lx.cur, 7);
});

t('GET_COLUMN skips a leading BOM the way ts_lexer__do_advance does', () => {
  const lx = new ByteLexer(Buffer.from('\uFEFFab', 'utf8'));
  lx.advance(false); // over the BOM
  assert.strictEqual(lx.column(), 0, 'a BOM is not a character');
  lx.advance(false); // 'a'
  assert.strictEqual(lx.column(), 1);
});

t('GET_COLUMN writes the host column into a register', () => {
  const p = prog({ regPersist: 1 }, (a) => {
    a.advance().advance().getColumn(0).fail();
  });
  const vm = new ScannerVM(p);
  vm.scan(new ByteLexer(Buffer.from('abc')), [true]);
  assert.strictEqual(vm.reg[0], 2);
});


t('GETIDX reads from the bottom of a stack by register index', () => {
  const p = prog({ stacks: [{}, {}, {}, {}] }, (a) => {
    a.const_(0, 10).push(0, 0).const_(0, 11).push(0, 0).const_(0, 12).push(0, 0)
      .const_(1, 1).getidx(0, 2, 1).emitR(2);
  });
  assert.strictEqual(new ScannerVM(p).scan(new ByteLexer(Buffer.from('')), [true]).symbol, 11);
});

t('GETIDX out of range traps', () => {
  const p = prog({ stacks: [{}, {}, {}, {}] }, (a) => {
    a.const_(0, 5).const_(1, 0).getidx(0, 2, 1).emit(0);
  });
  assert.strictEqual(new ScannerVM(p).scan(new ByteLexer(Buffer.from('')), [true]).ok, false);
});

t('registers above 16 are usable, which markdown-block needs', () => {
  const p = prog({}, (a) => { a.const_(31, 7).emitR(31); });
  assert.strictEqual(new ScannerVM(p).scan(new ByteLexer(Buffer.from('')), [true]).symbol, 7);
});

console.log(`vm.test.js: ${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
