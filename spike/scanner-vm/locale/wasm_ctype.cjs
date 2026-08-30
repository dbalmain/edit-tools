// The third host: what does the *wasm* build think a space is?
//
// web-tree-sitter is compiled with emscripten, whose libc is musl.  musl's
// iswspace() is a fixed Unicode table and ignores LC_CTYPE entirely, so it
// agrees with neither glibc-C nor glibc-UTF-8.  Same four CSS snippets as
// locale_divergence.py.
//
//   npm install web-tree-sitter@0.22.6 tree-sitter-wasms@0.1.13
//   node wasm_ctype.cjs
//
// CAVEAT: the css.wasm in tree-sitter-wasms is NOT built from tree-sitter-css
// 0.25.0, so grammar version is not controlled here.  The U+00A0 row is still
// a pure libc difference -- no glibc locale calls NBSP a space -- but the
// U+2003 and U+3000 rows would need a 0.25.0 wasm build to be airtight.
const TS = require('web-tree-sitter');
(async () => {
  const Parser = TS.Parser || TS;
  await Parser.init();
  const load = (TS.Language && TS.Language.load) ? TS.Language.load : Parser.Language.load;
  const lang = await load('./node_modules/tree-sitter-wasms/out/tree-sitter-css.wasm');
  const p = new Parser();
  p.setLanguage(lang);
  const cases = [
    ['control: ASCII space U+0020', 'a b { c: d; }'],
    ['EM SPACE U+2003', 'a b { c: d; }'],
    ['NO-BREAK SPACE U+00A0', 'a b { c: d; }'],
    ['IDEOGRAPHIC SPACE U+3000', 'a　b { c: d; }'],
  ];
  for (const [label, src] of cases) {
    console.log('  ' + label.padEnd(32), '->', p.parse(src).rootNode.toString());
  }
})().catch((e) => console.log('  ERR', e.message));
