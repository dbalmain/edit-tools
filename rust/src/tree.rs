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
    pub fn languages(&self) -> BTreeSet<&str> {
        fn collect<'a>(node: &'a Node, languages: &mut BTreeSet<&'a str>) {
            if let Some(language) = node.language.as_deref() {
                languages.insert(language);
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

impl Node {
    pub fn child_with_field(&self, field: &str) -> Option<&Node> {
        self.children
            .iter()
            .find(|c| c.field.as_deref() == Some(field))
    }
}
