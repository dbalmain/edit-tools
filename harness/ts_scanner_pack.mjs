// The wire format for a package's `scanner` section, both directions.
//
// A binary blob rather than JSON-with-base64: base64 costs 33% before gzip,
// and the whole point is that a package is data both runtimes read the same
// way.  Little-endian throughout, LEB128 for anything variable.
//
// `decode` is the half that was missing until the parser needed it, and its
// absence mattered more than it looks.  `spike/scanner-vm/replay.js` used to
// hand the VM the in-memory object from `toml.program.js`, while
// `spike/scanner-vm/rust/main.rs` decoded `toml.svm` -- so the two runtimes
// were executing one program expressed twice rather than one artifact, and an
// encoder bug would have left all 45,678 replayed calls green.  Everything now
// runs off the bytes; `encode` is used only to produce them, by
// `spike/scanner-vm/build-svm.js`.
//
// Round-tripped against the committed `toml.svm` in `harness/ts_lr.test.mjs`,
// which is the test that would catch drift between the program source and the
// artifact.

const MAGIC = [0x53, 0x56, 0x4d, 0x31]; // "SVM1"

export function encode(prog) {
  const out = [];
  const u8 = (v) => out.push(v & 0xff);
  const u16 = (v) => { out.push(v & 0xff, (v >> 8) & 0xff); };
  const u32 = (v) => { out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); };
  const uleb = (v) => { let x = v >>> 0; do { let b = x & 0x7f; x >>>= 7; if (x) b |= 0x80; out.push(b); } while (x); };
  const sleb = (v) => {
    let x = v | 0;
    for (;;) { const b = x & 0x7f; x >>= 7;
      if ((x === 0 && !(b & 0x40)) || (x === -1 && (b & 0x40))) { out.push(b); return; }
      out.push(b | 0x80); }
  };

  out.push(...MAGIC);
  u16(prog.entry);
  u32(prog.regPersist);

  const stacks = prog.stacks || [];
  u8(stacks.length);
  for (const s of stacks) u8(s && s.persist ? 1 : 0);

  const init = prog.stackInit || [];
  u8(init.length);
  for (const i of init) { u8(i.stack); u16(i.values.length); for (const v of i.values) sleb(v); }

  const classes = prog.classes || [];
  u16(classes.length);
  for (const c of classes) { u16(c.length >> 1); for (const v of c) uleb(v); }

  const strings = prog.strings || [];
  u16(strings.length);
  for (const s of strings) { u8(s.length); for (const b of s) u8(b); }

  const vs = prog.validSets || [];
  u16(vs.length);
  for (const set of vs) {
    u16(set.length);
    for (let i = 0; i < set.length; i += 8) {
      let b = 0;
      for (let k = 0; k < 8 && i + k < set.length; k++) if (set[i + k]) b |= 1 << k;
      u8(b);
    }
  }

  const jt = prog.jumpTable || [];
  u16(jt.length);
  for (const t of jt) u16(t);

  u16(prog.code.length);
  for (const b of prog.code) u8(b);

  return Uint8Array.from(out);
}

// The exact mirror of `encode`, and structurally the same walk as
// `spike/scanner-vm/rust/main.rs::decode_program`.  Deliberately reads every
// field in the same order rather than seeking, so a format change that breaks
// one side breaks the other loudly.
export function decode(bytes) {
  let p = 0;
  const need = (n) => { if (p + n > bytes.length) throw new Error(`truncated scanner package at byte ${p}`); };
  const u8 = () => { need(1); return bytes[p++]; };
  const u16 = () => { need(2); const v = bytes[p] | (bytes[p + 1] << 8); p += 2; return v; };
  const u32 = () => { need(4); const v = (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0; p += 4; return v; };
  const uleb = () => { let v = 0, s = 0, b; do { b = u8(); v |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return v >>> 0; };
  const sleb = () => {
    let v = 0, s = 0, b;
    do { b = u8(); v |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
    if (s < 32 && (b & 0x40)) v |= -1 << s;
    return v | 0;
  };

  for (const m of MAGIC) if (u8() !== m) throw new Error("not a scanner package: bad magic");
  const entry = u16();
  const regPersist = u32();

  const stacks = [];
  for (let n = u8(), i = 0; i < n; i++) stacks.push({ persist: u8() === 1 });

  const stackInit = [];
  for (let n = u8(), i = 0; i < n; i++) {
    const stack = u8();
    const count = u16();
    const values = [];
    for (let k = 0; k < count; k++) values.push(sleb());
    stackInit.push({ stack, values });
  }

  const classes = [];
  for (let n = u16(), i = 0; i < n; i++) {
    const ranges = u16() * 2;
    const c = [];
    for (let k = 0; k < ranges; k++) c.push(uleb());
    classes.push(c);
  }

  const strings = [];
  for (let n = u16(), i = 0; i < n; i++) {
    const l = u8();
    const s = [];
    for (let k = 0; k < l; k++) s.push(u8());
    strings.push(s);
  }

  const validSets = [];
  for (let n = u16(), i = 0; i < n; i++) {
    const l = u16();
    const set = new Array(l).fill(false);
    for (let j = 0; j < l; j += 8) {
      const b = u8();
      for (let k = 0; k < 8 && j + k < l; k++) set[j + k] = ((b >> k) & 1) === 1;
    }
    validSets.push(set);
  }

  const jumpTable = [];
  for (let n = u16(), i = 0; i < n; i++) jumpTable.push(u16());

  const codeLength = u16();
  need(codeLength);
  const code = bytes.slice(p, p + codeLength);
  p += codeLength;
  if (p !== bytes.length) {
    throw new Error(`scanner package has ${bytes.length - p} trailing bytes`);
  }

  return { entry, regPersist, stacks, stackInit, classes, strings, validSets, jumpTable, code };
}
