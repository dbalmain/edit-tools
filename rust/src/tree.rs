//! The corpus tree format. The harness owns all parsing; we only read.

use std::collections::BTreeSet;

use serde::Deserialize;

#[derive(Deserialize)]
pub struct TreeDoc {
    pub language: String,
    /// The original text. Load-bearing: byte offsets alone cannot tell two
    /// spaces from two newlines, so blank-line runs need the text itself.
    #[serde(default)]
    pub source: String,
    pub root: Node,
}

#[derive(Deserialize)]
pub struct Node {
    #[serde(rename = "type")]
    pub kind: String,
    /// Starts a formatter/highlighter language region at this node.
    #[serde(default)]
    pub language: Option<String>,
    /// A language region the formatter must not lay out again: the guest parse
    /// is spliced for readers (the highlighter, an editor), and the formatter
    /// reproduces the region's original bytes. See docs/injection.md.
    #[serde(default)]
    pub opaque: bool,
    pub start: usize,
    pub end: usize,
    #[serde(default)]
    pub field: Option<String>,
    /// Leaves carry `text`, interior nodes carry `children`; never both.
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub children: Vec<Node>,
}

impl TreeDoc {
    pub fn load(raw: &str) -> Result<Self, String> {
        let tree: Self = serde_json::from_str(raw).map_err(|error| error.to_string())?;
        tree.validate()?;
        Ok(tree)
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_node(&self.root, &self.source)
    }

    pub fn languages(&self) -> BTreeSet<&str> {
        fn collect<'a>(node: &'a Node, languages: &mut BTreeSet<&'a str>) {
            if let Some(language) = node.language.as_deref() {
                // An opaque region is emitted from source, so its package is
                // never loaded: a host must not depend on shipping one.
                if !node.opaque {
                    languages.insert(language);
                }
            }
            for child in &node.children {
                collect(child, languages);
            }
        }

        let mut languages = BTreeSet::from([self.language.as_str()]);
        collect(&self.root, &mut languages);
        languages
    }
}

fn validate_node(node: &Node, source: &str) -> Result<(), String> {
    if node.start > node.end {
        return Err(format!(
            "node `{}` has reversed range {}..{}",
            node.kind, node.start, node.end
        ));
    }
    if node.end > source.len() {
        return Err(format!(
            "node `{}` range {}..{} ends past the source length {}",
            node.kind,
            node.start,
            node.end,
            source.len()
        ));
    }
    // `source` is already valid UTF-8, so boundary queries check one byte;
    // decoding every node slice would turn this load-time walk into the cost
    // this invariant is meant to avoid at the twelve downstream slice sites.
    if !source.is_char_boundary(node.start) {
        return Err(format!(
            "node `{}` start offset {} splits a UTF-8 character",
            node.kind, node.start
        ));
    }
    if !source.is_char_boundary(node.end) {
        return Err(format!(
            "node `{}` end offset {} splits a UTF-8 character",
            node.kind, node.end
        ));
    }
    for child in &node.children {
        validate_node(child, source)?;
    }
    Ok(())
}

impl Node {
    pub fn child_with_field(&self, field: &str) -> Option<&Node> {
        self.children
            .iter()
            .find(|c| c.field.as_deref() == Some(field))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::TreeDoc;

    fn raw_tree(source: &str, root: Value) -> String {
        json!({ "language": "toy", "source": source, "root": root }).to_string()
    }

    fn node(start: Value, end: Value) -> Value {
        json!({ "type": "marker", "start": start, "end": end })
    }

    fn load_error(source: &str, root: Value) -> String {
        match TreeDoc::load(&raw_tree(source, root)) {
            Ok(_) => panic!("tree must be refused"),
            Err(error) => error,
        }
    }

    fn assert_invalid_range(source: &str, root: Value, details: &[&str]) {
        let error = load_error(source, root);
        assert!(error.contains("node `marker`"), "{error}");
        for detail in details {
            assert!(error.contains(detail), "{error}");
        }
    }

    fn assert_invalid_offset(root: Value, details: &[&str]) {
        let error = load_error("hello", root);
        for detail in details {
            assert!(error.contains(detail), "{error}");
        }
    }

    #[test]
    fn tree_loader_accepts_a_well_formed_utf8_range() {
        TreeDoc::load(&raw_tree("xéy", node(json!(1), json!(3))))
            .expect("character-aligned range loads");
    }

    #[test]
    fn tree_loader_refuses_invalid_numeric_ranges() {
        // These are loader regressions: letting any one through restores the
        // `get`/`subarray` coercion split at downstream source-byte sites.
        assert_invalid_range(
            "hello",
            node(json!(4), json!(2)),
            &["reversed range", "4..2"],
        );
        assert_invalid_range(
            "hello",
            node(json!(0), json!(6)),
            &["past the source", "0..6"],
        );
        assert_invalid_offset(node(json!(-1), json!(2)), &["-1", "expected usize"]);
        assert_invalid_offset(node(json!(1.5), json!(2)), &["1.5", "expected usize"]);
        assert_invalid_offset(node(Value::Null, json!(2)), &["null", "expected usize"]);
        assert_invalid_offset(node(json!(true), json!(2)), &["true", "expected usize"]);
        assert_invalid_offset(node(json!("0"), json!(2)), &["\"0\"", "expected usize"]);

        let missing = json!({ "type": "marker", "end": 2 });
        assert_invalid_offset(missing, &["missing field `start`"]);
    }

    #[test]
    fn tree_loader_refuses_utf8_splits_at_either_edge() {
        assert_invalid_range(
            "xéy",
            node(json!(2), json!(4)),
            &["start offset 2", "UTF-8"],
        );
        assert_invalid_range("xéy", node(json!(0), json!(2)), &["end offset 2", "UTF-8"]);
    }
}
