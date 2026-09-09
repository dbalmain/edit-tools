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

/// The whole document: one frozen `.tree.json` file.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TreeDoc {
    pub language: String,
    pub source_file: String,
    pub source: String,
    pub root: TreeNode,
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
        };
        let want = format!(
            "{{\n \"language\": \"t\",\n \"source_file\": \"t\",\n \"source\": \"{escaped}\",\n \"root\": {{\n  \"type\": \"leaf\",\n  \"start\": 0,\n  \"end\": 1,\n  \"text\": \"{escaped}\"\n }}\n}}\n"
        );
        let got = String::from_utf8(to_frozen_bytes(&doc)).expect("utf-8 out");
        assert_eq!(got, want);
    }
}
