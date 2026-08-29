#!/usr/bin/env node
// Does the host's locale change the tree? Three parses of the same bytes:
// native under a UTF-8 locale, native under LC_CTYPE=C, and wasm.
//
//     harness/wasm/locale_probe.js
//
// Why this is a separate probe rather than another mutation in the divergence
// rig: the frozen corpus cannot reach it, and neither can the mutants. Every
// non-ASCII character in corpus/src sits inside a string literal, where the
// generated lexer consumes it without ever asking whether it is a letter. The
// case has to be constructed.
//
// The mechanism. tree-sitter's generated `ts_lex` classifies characters with
// explicit codepoint ranges compiled into parser.c, which is why identifiers
// like `é = 1` are locale-proof in every grammar. External scanners are hand-
// written C, and seven of the sixteen pinned grammars reach for <wctype.h>
// there -- css, html, javascript, kotlin, markdown, ruby and rust all call
// iswalpha/iswalnum/iswspace on `lexer->lookahead`. Those functions answer
// according to LC_CTYPE: glibc's iswalpha returns 0 for U+00E9 in the C locale
// and 1 under any UTF-8 locale. Compiled to wasm against wasi-libc there is no
// locale to consult and the answer is a fixed Unicode table.
//
// So a grammar is only affected where a scanner's isw* call is on the decision
// path for the input at hand. Finding the case means reading the call sites,
// not guessing: of four constructed candidates only the Rust one discriminates,
// because css/html/kotlin/ruby route the equivalent input through ts_lex
// instead. The Rust site is scanner.c's float rule --
//
//     if (lexer->lookahead == '.') { advance(lexer);
//         if (iswalpha(lexer->lookahead)) return false;  // 1.max(2), not 1.0
//
// -- so `1.é` is a field access if é is a letter and a float followed by
// garbage if it is not.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Parser, Language, version } = require(path.join(__dirname, 'runtime.js'));

// Each case names the grammar whose scanner decides it. Keep the non-
// discriminating ones: they are the evidence that the mechanism needs a
// scanner on the decision path, not merely a non-ASCII character.
const CASES = {
  rust: 'fn f() { let x = 1.é; }\n',
  css: 'é { color: red }\n',
  ruby: 'x = 1.é\n',
  kotlin: 'fun f() { val x = 1.é }\n',
};

const PINS = {
  rust: 'tree-sitter-rust==0.24.0',
  css: 'tree-sitter-css==0.25.0',
  ruby: 'tree-sitter-ruby==0.23.1',
  kotlin: 'tree-sitter-kotlin==1.1.0',
};

const NATIVE = `
import json, locale, sys
from tree_sitter import Language, Parser
mods = {"rust": "tree_sitter_rust", "css": "tree_sitter_css",
        "ruby": "tree_sitter_ruby", "kotlin": "tree_sitter_kotlin"}
cases = json.loads(open(sys.argv[1], encoding="utf-8").read())
out = {"_lc_ctype": locale.setlocale(locale.LC_CTYPE)}
for name, src in cases.items():
    mod = __import__(mods[name])
    out[name] = str(Parser(Language(mod.language())).parse(src.encode()).root_node)
print(json.dumps(out))
`;

function native(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-probe-'));
  const casesFile = path.join(dir, 'cases.json');
  const script = path.join(dir, 'probe.py');
  fs.writeFileSync(casesFile, JSON.stringify(CASES));
  fs.writeFileSync(script, NATIVE);
  const args = ['run', '--quiet', '--with', 'tree-sitter==0.26.0'];
  for (const pin of Object.values(PINS)) args.push('--with', pin);
  args.push('python', script, casesFile);
  const out = execFileSync('uv', args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 1 << 24,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return JSON.parse(out);
}

async function wasm() {
  await Parser.init();
  const out = { _lc_ctype: `wasm (web-tree-sitter ${version}; no locale)` };
  for (const [name, src] of Object.entries(CASES)) {
    const parser = new Parser();
    parser.setLanguage(await Language.load(path.join(__dirname, 'build', `tree-sitter-${name}.wasm`)));
    out[name] = parser.parse(src).rootNode.toString();
  }
  return out;
}

async function main() {
  const utf8 = native({ LC_ALL: 'en_AU.UTF-8', LANG: 'en_AU.UTF-8' });
  // PYTHONCOERCECLOCALE=0 and PYTHONUTF8=0 are load-bearing: without them
  // CPython's PEP 538 locale coercion silently rewrites LC_CTYPE=C to
  // C.UTF-8, the probe reports "no divergence", and the conclusion is wrong.
  const c = native({
    LC_ALL: 'C',
    LANG: 'C',
    PYTHONCOERCECLOCALE: '0',
    PYTHONUTF8: '0',
  });
  const w = await wasm();

  console.log(`native A: LC_CTYPE=${utf8._lc_ctype}`);
  console.log(`native B: LC_CTYPE=${c._lc_ctype}`);
  console.log(`wasm    : ${w._lc_ctype}\n`);
  if (c._lc_ctype !== 'C') {
    console.log(`!! LC_CTYPE came back as ${c._lc_ctype}, not C -- the C-locale arm did not run.\n`);
  }

  let diverged = 0;
  for (const name of Object.keys(CASES)) {
    const sameLocale = utf8[name] === c[name];
    const wasmSide = w[name] === utf8[name] ? 'native-UTF-8' : w[name] === c[name] ? 'native-C' : 'neither';
    console.log(`${name.padEnd(8)} locale-sensitive: ${sameLocale ? 'no ' : 'YES'}   wasm agrees with: ${wasmSide}`);
    if (!sameLocale) {
      diverged++;
      console.log(`  UTF-8 : ${utf8[name]}`);
      console.log(`  C     : ${c[name]}`);
    }
  }
  console.log(
    diverged
      ? `\n${diverged}/${Object.keys(CASES).length} constructed cases produce a different tree from the same ` +
          `bytes depending only on the host's LC_CTYPE.`
      : '\nNo locale sensitivity found in these cases.'
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  }
);
