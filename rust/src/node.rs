//! Corpus tree nodes.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct TreeDoc {
    pub language: String,
    #[serde(default)]
    pub source: String,
    pub root: Node,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Node {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub field: Option<String>,
    #[serde(default)]
    pub start: usize,
    #[serde(default)]
    pub end: usize,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub children: Vec<Node>,
    #[serde(default, skip_deserializing)]
    pub leading: Vec<String>,
    #[serde(default, skip_deserializing)]
    pub trailing: Vec<String>,
    #[serde(default, skip_deserializing)]
    pub dangling: Vec<String>,
}

impl Node {
    pub fn raw_text(&self) -> String {
        match &self.text {
            Some(t) => t.clone(),
            None => self.children.iter().map(Node::raw_text).collect(),
        }
    }

    /// Punctuation tokens are those whose type does not start with a letter
    /// or underscore — `{`, `,`, `==`, `->`, but not `identifier` / `true`.
    pub fn is_punct(&self) -> bool {
        self.text.is_some()
            && !self
                .kind
                .starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
    }

    pub fn is_token(&self, want: &str) -> bool {
        self.kind == want || self.text.as_deref() == Some(want)
    }
}

pub fn non_comments<'a>(node: &'a Node, comment_type: &str) -> Vec<&'a Node> {
    node.children
        .iter()
        .filter(|c| c.kind != comment_type)
        .collect()
}
