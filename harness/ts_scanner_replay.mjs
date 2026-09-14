#!/usr/bin/env node
// Replay recorded scanner calls through the VM, for any language.
//
//     ./harness/ts_scanner_replay.mjs <language> [more languages...]
//     ./harness/ts_scanner_replay.mjs --all
//
// The oracle is not "the tree matches". It is: for every invocation the real C
// scanner received, the VM makes the *same lexer calls in the same order* and
// returns the same verdict -- and serializes the same bytes. That is strictly
// stronger than tree comparison, which only sees the calls surviving into the
// tree shape, and it is what tells a port that is right from a port that is
// merely right on this corpus. `get_column` is recorded as `C<pos>=<col>;`
// (haskell is the language that uses it).
//
// Traces come from `harness/ts_scanner_record.py` and are committed under
// `corpus/scanner-traces/`, so this needs no compiler and no network. The
// program is decoded from the packed `.svm` rather than built from its source,
// because the Rust replay reads those same bytes: "one artifact, two runtimes"
// is only tested if the encoder sits on both paths.
//
// ## State is checked by correspondence, not by bytes
//
// The recorded bytes are *upstream's* serialization format. The VM has its own
// -- persistent registers by index, then persistent stacks -- so for a scanner
// that carries state the two differ by construction, and comparing them
// directly would fail a correct port. For a stateless program the comparison
// is still worth making literally, because there the right answer is "no bytes
// at all" in either format; the state count is printed so a scanner that
// silently starts carrying state stops being invisible.
//
// For a stateful program the check becomes a **bijection**, which is the
// property that actually matters: every time upstream serialized the same
// bytes we must have serialized the same bytes, and vice versa. A port that
// forgot to push something would collapse two upstream states onto one of
// ours; a port that carried junk would split one of theirs across two of ours.
// Both are caught, and neither requires the two formats to agree. Replay then
// restores state through that mapping, so a `deserialize` of bytes upstream
// never emitted is itself a failure rather than a silent reset.
//
// Empty state is the one special case: upstream writes it as a length-0 buffer
// *and* as an all-zeros header, so it is not a single key. A length-0
// deserialize is a reset in every scanner (upstream's own deserialize returns
// early on it), which is what the VM does too.
//
// The formats being free to differ is survivable rather than fatal, and that
// was measured. tree-sitter truncates serialized state at 1024 bytes, and
// python, yaml, xml and html all behave differently once truncated -- so a VM
// format that packs state differently truncates at a different point. But
// across every recorded trace, the **largest serialized state any scanner
// reaches is 92 bytes** (haskell); every other language stays at or below 35,
// and five are stateless. Worst-case headroom to the limit is 11x.
//
// So on this corpus the formats cannot diverge, and the VM is free to use its
// own. That is a fact about the corpus rather than a guarantee: a file nesting
// a few hundred tags deep would reach the limit, and xml and html carry that
// as a known bound rather than a silent assumption.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScannerVM } from './ts_scanner_vm.mjs';
import { decode } from './ts_scanner_pack.mjs';
import { ByteLexer } from '../spike/scanner-vm/lexer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TRACES = path.join(ROOT, 'corpus', 'scanner-traces');
const SCANNERS = path.join(HERE, 'scanners');

// The recorder writes the valid-symbols vector as a bit string; yaml has 113
// external tokens and an array of ints per call outweighs the file it came
// from.
const bits = (s) => Array.from(s, (c) => c === '1');

const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

function sourceFor(language, stem) {
  // `gen_trees.py` refuses two corpus files that share a stem, so the glob is
  // unambiguous by construction.
  const dir = path.join(ROOT, 'corpus', 'src', language);
  const found = fs.readdirSync(dir).filter((n) => n.slice(0, n.lastIndexOf('.')) === stem);
  if (found.length !== 1) {
    throw new Error(`${language}/${stem}: ${found.length} source files match`);
  }
  return fs.readFileSync(path.join(dir, found[0]));
}

function replay(language, { traceDir = null, sourceLanguage = language } = {}) {
  const svm = path.join(SCANNERS, `${language}.svm`);
  if (!fs.existsSync(svm)) return { language, skipped: 'no port yet' };
  traceDir ??= path.join(TRACES, language);
  if (!fs.existsSync(traceDir)) return { language, skipped: 'no recorded traces' };

  const program = decode(new Uint8Array(fs.readFileSync(svm)));
  const vm = new ScannerVM(program);
  const stateful =
    program.regPersist !== 0 || (program.stacks || []).some((s) => s && s.persist);
  let files = 0, calls = 0, bad = 0, states = 0;
  const shown = [];

  for (const name of fs.readdirSync(traceDir).filter((n) => n.endsWith('.jsonl')).sort()) {
    const stem = path.basename(name, '.jsonl');
    const src = sourceFor(sourceLanguage, stem);
    files++;
    // Scanner state is per-parse, and the trace is one parse: reset once per
    // file, then let serialize/deserialize drive it exactly as recorded.
    vm.reset();
    // The two halves of the state bijection, rebuilt per file: one parse is one
    // scanner lifetime, so nothing should carry across.
    const oursFor = new Map();
    const theirsFor = new Map();
    for (const line of fs.readFileSync(path.join(traceDir, name), 'utf8').split('\n')) {
      if (!line) continue;
      const t = JSON.parse(line);
      if (t.op === 'deserialize') {
        if (!stateful || t.bytes === '') {
          vm.deserialize(unhex(t.bytes));
          continue;
        }
        const ours = oursFor.get(t.bytes);
        if (ours === undefined) {
          bad++;
          if (shown.length < 10) {
            shown.push(`${stem} deserialize: upstream state ${t.bytes} was never serialized`);
          }
          continue;
        }
        vm.deserialize(unhex(ours));
        continue;
      }
      if (t.op === 'serialize') {
        states++;
        const got = hex(vm.serialize());
        if (!stateful) {
          if (got !== t.bytes) {
            bad++;
            if (shown.length < 10) shown.push(`${stem} serialize: want ${t.bytes}, got ${got}`);
          }
          continue;
        }
        const seenOurs = oursFor.get(t.bytes);
        const seenTheirs = theirsFor.get(got);
        if (seenOurs !== undefined && seenOurs !== got) {
          bad++;
          if (shown.length < 10) {
            shown.push(`${stem} state: upstream ${t.bytes} was ${seenOurs}, now ${got}`);
          }
        } else if (seenTheirs !== undefined && seenTheirs !== t.bytes) {
          bad++;
          if (shown.length < 10) {
            shown.push(`${stem} state: ours ${got} was upstream ${seenTheirs}, now ${t.bytes}`);
          }
        }
        oursFor.set(t.bytes, got);
        theirsFor.set(got, t.bytes);
        continue;
      }
      calls++;
      const lexer = new ByteLexer(src, t.cur0);
      const la = lexer.lookahead();
      // If the recorder and we are not looking at the same character, nothing
      // below this line means anything.
      const expectedLa = t.la0 === 0 && lexer.atEof() ? 0 : t.la0;
      const result = vm.scan(lexer, bits(t.valid));
      const got = {
        ret: result.ok ? 1 : 0,
        sym: result.ok ? result.symbol : -1,
        ops: lexer.ops.join(''),
        cur1: lexer.cur,
      };
      const want = { ret: t.ret, sym: t.sym, ops: t.ops, cur1: t.cur1 };
      if (
        la !== expectedLa ||
        got.ret !== want.ret || got.sym !== want.sym ||
        got.ops !== want.ops || got.cur1 !== want.cur1
      ) {
        bad++;
        if (shown.length < 10) {
          shown.push(
            `${stem} @${t.cur0} la=${la}/${expectedLa} valid=[${t.valid}]\n` +
            `    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`,
          );
        }
      }
    }
  }
  return { language, files, calls, bad, states, shown };
}

const args = process.argv.slice(2);
const valueOf = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  if (i + 1 >= args.length) throw new Error(`${name} needs a value`);
  return args[i + 1];
};
const traceDir = valueOf('--trace-dir');
const sourceLanguage = valueOf('--source-language');
const positional = args.filter((a, i) =>
  !a.startsWith('--') && args[i - 1] !== '--trace-dir' && args[i - 1] !== '--source-language'
);
if ((traceDir || sourceLanguage) && (args.includes('--all') || positional.length !== 1)) {
  console.error('--trace-dir/--source-language require exactly one scanner language');
  process.exit(2);
}
const languages = args.includes('--all')
  ? fs.readdirSync(SCANNERS).filter((n) => n.endsWith('.svm')).map((n) => n.slice(0, -4)).sort()
  : positional;
if (languages.length === 0) {
  console.error('usage: ts_scanner_replay.mjs <language>... | --all');
  process.exit(2);
}

let failed = 0;
for (const language of languages) {
  const r = replay(language, { traceDir, sourceLanguage: sourceLanguage ?? language });
  if (r.skipped) {
    console.log(`${language.padEnd(12)} skipped -- ${r.skipped}`);
    continue;
  }
  for (const line of r.shown) console.log(`  MISMATCH ${line}`);
  console.log(
    `${language.padEnd(12)} ${String(r.files).padStart(3)} files  ` +
    `${String(r.calls).padStart(7)} calls  ` +
    `${String(r.states).padStart(6)} states  ` +
    (r.bad === 0 ? 'no mismatches' : `${r.bad} MISMATCHES`),
  );
  if (r.bad) failed++;
}
process.exit(failed ? 1 : 0);
