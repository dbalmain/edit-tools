// A lexer host for the VM, over a UTF-8 byte buffer.  Mirrors tree-sitter's
// lib/src/lexer.c: advance moves by the UTF-8 length of the current code
// point, `skip` moves the token start to *after* the advance, and a decode
// failure yields -1 with a size of 1.
//
// This is the replay/test host.  In production the same four methods would be
// implemented over whatever buffer the runtime already holds.
class ByteLexer {
  constructor(bytes, start = 0) {
    this.b = bytes;
    this.cur = start;
    this.tokenStart = start;
    this.tokenEnd = start;
    this.ops = [];
  }
  decode() {
    const b = this.b, i = this.cur;
    if (i >= b.length) return { cp: 0, size: 1 };
    const c = b[i];
    if (c < 0x80) return { cp: c, size: 1 };
    const cont = (k) => i + k < b.length && (b[i + k] & 0xc0) === 0x80;
    if (c >= 0xc2 && c <= 0xdf && cont(1)) return { cp: ((c & 0x1f) << 6) | (b[i + 1] & 0x3f), size: 2 };
    if (c >= 0xe0 && c <= 0xef && cont(1) && cont(2)) {
      const cp = ((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f);
      if (cp >= 0x800 && !(cp >= 0xd800 && cp <= 0xdfff)) return { cp, size: 3 };
    }
    if (c >= 0xf0 && c <= 0xf4 && cont(1) && cont(2) && cont(3)) {
      const cp = ((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f);
      if (cp >= 0x10000 && cp <= 0x10ffff) return { cp, size: 4 };
    }
    return { cp: -1, size: 1 };
  }
  lookahead() { return this.decode().cp; }
  atEof() { return this.cur >= this.b.length; }
  advance(skip) {
    this.ops.push((skip ? 'S' : 'A') + this.cur + ';');
    this.cur += this.decode().size;
    if (skip) this.tokenStart = this.cur;
  }
  markEnd() {
    this.ops.push('M' + this.cur + ';');
    this.tokenEnd = this.cur;
  }
}
module.exports = { ByteLexer };
