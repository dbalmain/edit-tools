// Moved to `harness/ts_scanner_vm.mjs` when the parser started driving it.
//
// Kept as a re-export rather than a copy: `replay.js`, `vm.test.js`, `asm.js`
// and `rust/README.md`'s workflow all name this path, and a second copy of the
// VM in the same runtime is exactly the divergence this route exists to
// prevent. Node resolves `require()` of an ES module since 22.12.
module.exports = require('../../harness/ts_scanner_vm.mjs');
