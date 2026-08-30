//! A table-driven GLR parser over the JSON blob `harness/ts_transcode.py` emits.
//!
//! This is the Rust half of route C3 in `docs/parse-layer.md`. The JS half is
//! `harness/ts_lr.mjs`, and it is the reference: this module is a port of it,
//! not an independent design. The project's defining constraint is that the two
//! runtimes produce **byte-identical** output, so where the JS silently skips
//! something this skips it the same way, and where it throws this errors.
//!
//! Supported projection, identical to the JS: **byte offsets, and the visible
//! tree of a clean full parse.** Out of scope, and rejected rather than guessed
//! at -- error recovery, external scanners, incremental reparse. Repeat
//! rebalancing is skipped and row/column state is never tracked, exactly as in
//! the JS, because neither can affect this projection.

pub mod blob;
pub mod doc;
pub mod lexer;

use std::fmt;

/// The JS reference's `Unsupported` error, and it carries the same meaning:
/// behaviour outside the supported projection that could change the tree, so
/// the parse refuses rather than guessing. Error recovery, external scanners
/// and undefined table encodings all arrive here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unsupported(pub String);

impl fmt::Display for Unsupported {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Unsupported {}
