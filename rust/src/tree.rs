//! The corpus tree format. The harness owns all parsing; we only read.

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
    // Read by the highlighter; formatter binaries deserialize the same tree.
    #[allow(dead_code)]
    #[serde(default)]
    pub language: Option<String>,
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

impl Node {
    pub fn child_with_field(&self, field: &str) -> Option<&Node> {
        self.children
            .iter()
            .find(|c| c.field.as_deref() == Some(field))
    }
}
