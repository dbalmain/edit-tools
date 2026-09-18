//! The tree document -- the artifact the two runtimes must agree on, byte for
//! byte.
//!
//! `harness/gen_trees.py` froze `corpus/trees/*.tree.json` with Python's
//! `json.dumps(indent=1, ensure_ascii=False)`; `harness/ts_check_trees.mjs`
//! reproduces those bytes with `JSON.stringify(x, null, 1)`. Rust is the third
//! serialiser that has to land on the same bytes, and serde's defaults do not:
//! the indent is two spaces, not one.
//!
//! `PrettyFormatter::with_indent(b" ")` closes that gap exactly. Verified
//! against both other serialisers over quote, backslash, `\n \t \r \b \f`,
//! U+0000, U+001F, an unescaped DEL, unescaped non-ASCII, an astral-plane
//! scalar, an empty array, and omitted optional keys -- see the two tests
//! below, which are the standing guard on that agreement.

use serde::{Deserialize, Serialize};
use serde_json::ser::{PrettyFormatter, Serializer};

/// One node of the frozen document, in `gen_trees.convert()`'s shape.
///
/// Field order here *is* the serialised key order, and the frozen bytes depend
/// on it: `type`, `start`, `end`, then `field` when the production names one,
/// then either `children` or `text`, then `language` where the injection track
/// added one. `children` and `text` are mutually exclusive -- `convert()` emits
/// `text` only on a leaf -- so declaring both after `field` reproduces the
/// order in every case.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TreeNode {
    #[serde(rename = "type")]
    pub kind: String,
    pub start: usize,
    pub end: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Set only by the injection track, on the node holding an injected
    /// region: 39 nodes across 20 markdown trees carry it. The interpreter
    /// never emits one -- it is modelled so that the round-trip test below can
    /// cover every frozen tree rather than a subset that happens to fit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Set with `language` on a region spliced for readers but not laid out
    /// again: 25 of those 39 nodes are markdown's `html_block`s. Written only
    /// when true, so a formatted region serialises exactly as it did before
    /// the field existed.
    #[serde(default, skip_serializing_if = "is_false")]
    pub opaque: bool,
}

fn is_false(flag: &bool) -> bool {
    !*flag
}

/// One manifest-declared parallel parse of a contiguous host range.
///
/// A secondary grammar never replaces host nodes: the block CST stays the
/// formatter's tree and each rebased root is retained *beside* it, so a later
/// projection can consult both grammars at one gap. See
/// `harness/ts_secondary.mjs`, which writes this shape, and `gen_trees.py`,
/// which froze it. Field order here is the serialised key order, as above.
/// Whether a host range's parse produced a tree worth trusting.
///
/// Two states, and only two. The array is total -- every host range the
/// declaration matches gets a record -- so this is what separates "parsed and
/// trustworthy" from "parsed and not". A host range with *no* record is a
/// producer bug, and must never be read as ordinary dirtiness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Clean,
    Dirty,
}

/// The deserialisation shadow of [`TreeSecondary`]: the same fields, with no
/// invariant. It exists only because serde cannot express "root is present
/// exactly when clean" on a struct, and a tagged enum would reorder the keys
/// away from the frozen files' byte order. Nothing constructs it directly --
/// `try_from` turns one into a `TreeSecondary` or rejects it.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TreeSecondaryWire {
    language: String,
    within: String,
    start: usize,
    end: usize,
    outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    root: Option<TreeNode>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "TreeSecondaryWire")]
pub struct TreeSecondary {
    /// The secondary grammar's manifest name -- `markdown_inline`, not the
    /// host's `markdown`.
    pub language: String,
    /// The host node kind whose byte range was reparsed.
    pub within: String,
    pub start: usize,
    pub end: usize,
    pub outcome: Outcome,
    /// Present exactly when `outcome` is [`Outcome::Clean`] -- enforced on the
    /// way in, not merely documented. A dirty range is recorded without a tree
    /// rather than omitted, because omitting it would make it indistinguishable
    /// from a range that was never a host range.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<TreeNode>,
}

impl TryFrom<TreeSecondaryWire> for TreeSecondary {
    type Error = String;

    fn try_from(wire: TreeSecondaryWire) -> Result<Self, Self::Error> {
        match (wire.outcome, &wire.root) {
            (Outcome::Clean, None) => {
                return Err(format!(
                    "{}:{}..{}: clean outcome with no root",
                    wire.language, wire.start, wire.end
                ))
            }
            (Outcome::Dirty, Some(_)) => {
                return Err(format!(
                    "{}:{}..{}: dirty outcome carrying a root",
                    wire.language, wire.start, wire.end
                ))
            }
            _ => {}
        }
        Ok(Self {
            language: wire.language,
            within: wire.within,
            start: wire.start,
            end: wire.end,
            outcome: wire.outcome,
            root: wire.root,
        })
    }
}


/// The whole document: one frozen `.tree.json` file.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TreeDoc {
    pub language: String,
    pub source_file: String,
    pub source: String,
    pub root: TreeNode,
    /// Set only by the secondary-grammar track: 21 markdown trees carry one.
    /// The interpreter never emits it, for the same reason it never emits a
    /// node `language` -- it runs one pass -- and it is modelled here so the
    /// round-trip test below keeps covering every frozen tree rather than the
    /// subset that predates the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary: Option<Vec<TreeSecondary>>,
}

/// Serialise to the exact bytes of a frozen `.tree.json`, trailing newline and
/// all. This is the byte-identity bar; nothing here may be "close enough".
pub fn to_frozen_bytes(doc: &TreeDoc) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut ser = Serializer::with_formatter(&mut buf, PrettyFormatter::with_indent(b" "));
    doc.serialize(&mut ser)
        .expect("serialising a TreeDoc to a Vec cannot fail");
    buf.push(b'\n');
    buf
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("rust/ has a parent")
            .to_path_buf()
    }

    /// The clean/dirty invariant is enforced, not merely documented.
    ///
    /// `outcome` is an enum, so `"banana"` cannot deserialise; the two
    /// half-states can, as far as serde is concerned, which is why they go
    /// through `try_from`. Round three of the review found this struct
    /// accepting all three, and "Rust only round-trips the field today" is a
    /// reason to fix it before something reads it, not a reason to wait.
    #[test]
    fn a_secondary_record_must_carry_a_tree_exactly_when_clean() {
        let base = r#"{"language":"markdown_inline","within":"inline","start":0,"end":2"#;
        let leaf = r#","root":{"type":"inline","start":0,"end":2,"text":"ab"}"#;

        let clean: TreeSecondary =
            serde_json::from_str(&format!(r#"{base},"outcome":"clean"{leaf}}}"#))
                .expect("clean with a root is the whole point");
        assert_eq!(clean.outcome, Outcome::Clean);
        assert!(clean.root.is_some());

        let dirty: TreeSecondary =
            serde_json::from_str(&format!(r#"{base},"outcome":"dirty"}}"#))
                .expect("dirty without a root is the other point");
        assert_eq!(dirty.outcome, Outcome::Dirty);
        assert!(dirty.root.is_none());

        for (json, why) in [
            (format!(r#"{base},"outcome":"clean"}}"#), "clean with no root"),
            (format!(r#"{base},"outcome":"dirty"{leaf}}}"#), "dirty with a root"),
            (format!(r#"{base},"outcome":"banana"{leaf}}}"#), "an outcome that is neither"),
        ] {
            assert!(
                serde_json::from_str::<TreeSecondary>(&json).is_err(),
                "{why} deserialised, and must not"
            );
        }
    }

    /// Every frozen tree in the corpus, round-tripped through the Rust
    /// serialiser. This drives the real `to_frozen_bytes`, and it is an
    /// equality against bytes Python wrote -- not against a normalised form and
    /// not against a second Rust implementation of the same rule.
    ///
    /// It covers all 16 languages rather than the three the interpreter parses:
    /// the shape is `gen_trees.convert()`'s in every case, so the wider set is
    /// free coverage of escapes the three-language subset happens not to hold.
    #[test]
    fn every_frozen_tree_round_trips_byte_for_byte() {
        let dir = repo_root().join("corpus").join("trees");
        let mut checked = 0usize;
        for entry in std::fs::read_dir(&dir).expect("corpus/trees exists") {
            let path = entry.expect("readable dir entry").path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let want = std::fs::read(&path).expect("readable frozen tree");
            let doc: TreeDoc = serde_json::from_slice(&want)
                .unwrap_or_else(|e| panic!("{} does not fit TreeDoc: {e}", path.display()));
            let got = to_frozen_bytes(&doc);
            assert!(
                got == want,
                "{} did not round-trip byte for byte",
                path.display()
            );
            checked += 1;
        }
        // Guard the gate itself: an empty or half-read directory would pass
        // every assertion above while proving nothing.
        assert!(
            checked >= 234,
            "expected at least 234 frozen trees, walked {checked}"
        );
    }

    /// The escapes the corpus cannot reach.
    ///
    /// A grep over all 234 frozen trees (2026-08-30) finds only `\n`, `\t`,
    /// `\"` and `\\`. So the cases that actually separate three JSON
    /// serialisers have no corpus coverage: `\r \b \f`, the `\u00xx` form for
    /// the remaining C0 controls, and -- the ones a stricter escaper would get
    /// wrong -- DEL and non-ASCII, which all three leave *unescaped*.
    ///
    /// The expectation below is written out rather than computed, so this test
    /// cannot pass by re-implementing the serialiser it checks. It is the
    /// transcription of a three-way `cmp` between this formatter,
    /// `JSON.stringify(x, null, 1)` and `json.dumps(indent=1,
    /// ensure_ascii=False)`, which agreed on all 479 bytes.
    #[test]
    fn control_characters_escape_the_way_javascript_and_python_escape_them() {
        // Built from code points so this source file holds no control bytes.
        let raw: String = [34u32, 92, 10, 9, 13, 8, 12, 0, 31, 127]
            .iter()
            .map(|&n| char::from_u32(n).expect("valid scalar value").to_string())
            .collect::<Vec<_>>()
            .join(" ");
        let text = format!("{raw} é \u{1d11e} /");

        // DEL, é and 𝄞 appear here literally: all three serialisers emit them
        // as themselves. The forward slash is never escaped either.
        let escaped = "\\\" \\\\ \\n \\t \\r \\b \\f \\u0000 \\u001f \u{7f} é \u{1d11e} /";

        let doc = TreeDoc {
            language: "t".into(),
            source_file: "t".into(),
            source: text.clone(),
            root: TreeNode {
                kind: "leaf".into(),
                start: 0,
                end: 1,
                field: None,
                children: None,
                text: Some(text),
                language: None,
                opaque: false,
            },
            // Omitted, and `skip_serializing_if` therefore keeps `want` the
            // same 479 bytes it was before the field existed. The frozen-tree
            // test above is what covers a populated one: Python wrote the 21
            // that carry it, and Rust reproduces those bytes.
            secondary: None,
        };
        let want = format!(
            "{{\n \"language\": \"t\",\n \"source_file\": \"t\",\n \"source\": \"{escaped}\",\n \"root\": {{\n  \"type\": \"leaf\",\n  \"start\": 0,\n  \"end\": 1,\n  \"text\": \"{escaped}\"\n }}\n}}\n"
        );
        let got = String::from_utf8(to_frozen_bytes(&doc)).expect("utf-8 out");
        assert_eq!(got, want);
    }
}
