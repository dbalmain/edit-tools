// Replay recorded tree-sitter scanner calls through the VM.
//
// The oracle is not "the tree matches".  It is: for every single invocation
// the real scanner received, the VM makes the *same lexer calls in the same
// order* and returns the same verdict.  That is strictly stronger than tree
// comparison, which only sees the calls that survive into the tree shape.
//
//   node replay.js <trace-dir> <corpus-dir>
//
// This is the *spike's* replay, over the *spike's* recorder in
// `record/trace_scanner.c`, which is toml-only and writes `valid` as a JSON
// array.  `run.sh` needs it for the two things the harness track has no
// equivalent of: the fuzz corpus and the incremental-reparse traces, both
// generated on the fly.
//
// For the committed cross-language traces under `corpus/scanner-traces/`, use
// `harness/ts_scanner_replay.mjs` instead -- those write `valid` as a bit
// string, and every character of a JS string is truthy, so feeding one to this
// file would pass every valid-symbol test and report a confident green.  The
// assertion below is there because that failure is silent.
const fs = require('fs');
const path = require('path');
const { ScannerVM } = require('./vm.js');
const { decode } = require('./pack.js');
const { ByteLexer } = require('./lexer.js');

function main(traceDir, corpusDir) {
  // Decoded from the packed artifact, not built from `toml.program.js`.
  // The Rust replay reads these same bytes, so "one artifact, two runtimes" is
  // now what is actually being tested; before this it was one program written
  // twice, and the encoder sat on only one of the two paths.
  const svm = fs.readFileSync(path.join(__dirname, '..', '..', 'harness', 'scanners', 'toml.svm'));
  const prog = decode(new Uint8Array(svm));
  const vm = new ScannerVM(prog);
  let calls = 0, files = 0, bad = 0;
  const symCount = new Map();

  for (const f of fs.readdirSync(traceDir).filter((n) => n.endsWith('.jsonl')).sort()) {
    const stem = path.basename(f, '.jsonl');
    const src = fs.readFileSync(path.join(corpusDir, stem + '.toml'));
    const lines = fs.readFileSync(path.join(traceDir, f), 'utf8').split('\n').filter(Boolean);
    files++;
    for (const line of lines) {
      const t = JSON.parse(line);
      if (!Array.isArray(t.valid)) {
        throw new Error(
          `${stem}: valid-symbols is not an array -- these look like the ` +
          'cross-language traces; replay them with harness/ts_scanner_replay.mjs',
        );
      }
      calls++;
      symCount.set(t.sym, (symCount.get(t.sym) || 0) + 1);

      const lx = new ByteLexer(src, t.cur0);
      // Sanity: the recorder's lookahead must match ours, or the two are not
      // looking at the same character and nothing below means anything.
      const la = lx.lookahead();
      const laExpected = t.la0 === 0 && lx.atEof() ? 0 : t.la0;
      const res = vm.scan(lx, t.valid);
      const got = {
        ret: res.ok ? 1 : 0,
        sym: res.ok ? res.symbol : -1,
        ops: lx.ops.join(''),
        cur1: lx.cur,
      };
      const want = { ret: t.ret, sym: t.sym, ops: t.ops, cur1: t.cur1 };
      const mismatch =
        la !== laExpected ||
        got.ret !== want.ret || got.sym !== want.sym ||
        got.ops !== want.ops || got.cur1 !== want.cur1;
      if (mismatch) {
        bad++;
        if (bad <= 10) {
          console.log(`MISMATCH ${stem} @${t.cur0} la=${la}/${laExpected} valid=[${t.valid}]`);
          console.log(`  want ${JSON.stringify(want)}`);
          console.log(`  got  ${JSON.stringify(got)}`);
        }
      }
    }
  }
  const hist = [...symCount.entries()].sort((a, b) => a[0] - b[0])
    .map(([s, n]) => `${s}:${n}`).join(' ');
  console.log(`files ${files}  calls ${calls}  mismatches ${bad}`);
  console.log(`result_symbol histogram (-1 = returned false): ${hist}`);
  return bad === 0 ? 0 : 1;
}

process.exit(main(process.argv[2], process.argv[3]));
