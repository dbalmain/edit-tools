// The wire format for a package's `scanner` section.
//
// A binary blob rather than JSON-with-base64: base64 costs 33% before gzip,
// and the whole point is that a package is data both runtimes read the same
// way.  Little-endian throughout, LEB128 for anything variable.
function encode(prog) {
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

  out.push(0x53, 0x56, 0x4d, 0x31); // "SVM1"
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
module.exports = { encode };
