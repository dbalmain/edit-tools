// The web-tree-sitter runtime, and the one piece of arithmetic every consumer
// of it needs. Single source for both, so that swapping the runtime version
// (which the divergence experiment must do) cannot accidentally leave one
// caller on the other version.
//
// Set EDITOR_TOOLS_WTS to an alternate installation directory -- one holding
// node_modules/web-tree-sitter -- to run against a different runtime version.

'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const WASM_DIR = __dirname;
const runtimeDir = process.env.EDITOR_TOOLS_WTS
  ? path.resolve(process.env.EDITOR_TOOLS_WTS)
  : WASM_DIR;

const rigRequire = createRequire(path.join(runtimeDir, 'package.json'));
const { Parser, Language } = rigRequire('web-tree-sitter');

// web-tree-sitter does not export ./package.json, so read it off disk.
const version = JSON.parse(
  fs.readFileSync(path.join(runtimeDir, 'node_modules', 'web-tree-sitter', 'package.json'), 'utf8')
).version;

/**
 * UTF-16 index -> UTF-8 byte offset, for every index in `src` plus the end.
 *
 * web-tree-sitter's startIndex/endIndex are UTF-16 code-unit indices into the
 * JS string, NOT byte offsets, while gen_trees.py works entirely in bytes. The
 * .d.ts comment calling the parse argument "UTF8-encoded text" describes the
 * runtime's internals, not its return values. Verified rather than assumed:
 * `{"kéy": "vàl", "b": [1,2]}` is 26 UTF-16 units and 28 UTF-8 bytes, and its
 * document node comes back as [0,26].
 */
function byteOffsets(src) {
  const table = new Int32Array(src.length + 1);
  let bytes = 0;
  for (let i = 0; i < src.length; ) {
    table[i] = bytes;
    const code = src.codePointAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
    if (code >= 0x10000) {
      // A surrogate pair is one code point across two UTF-16 units. Stamp the
      // low surrogate with the same offset as the high one; no node boundary
      // can fall between them, so the value is never read, but a hole in the
      // table would be a silent zero.
      table[i + 1] = bytes;
      i += 2;
    } else {
      i += 1;
    }
  }
  table[src.length] = bytes;
  return table;
}

module.exports = { Parser, Language, version, byteOffsets, runtimeDir };
