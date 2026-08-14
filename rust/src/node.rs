//! Corpus tree nodes and the linearity cursor.

use serde::Deserialize;

use crate::Refuse;

#[derive(Debug, Deserialize)]
pub struct TreeDoc {
    pub language: String,
    /// Original source; comment attachment reads the gaps. Unused until Python.
    #[serde(default)]
    #[allow(dead_code)]
    pub source: String,
    pub root: Node,
}

#[derive(Debug, Deserialize)]
pub struct Node {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub field: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub start: usize,
    #[serde(default)]
    #[allow(dead_code)]
    pub end: usize,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub children: Vec<Node>,
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

/// Ordered walk over a node's direct children. Exhaustion or leftovers
/// are linearity failures.
pub struct Cursor<'a> {
    kids: &'a [&'a Node],
    i: usize,
}

impl<'a> Cursor<'a> {
    pub fn new(kids: &'a [&'a Node]) -> Self {
        Self { kids, i: 0 }
    }

    pub fn peek(&self) -> Option<&'a Node> {
        self.kids.get(self.i).copied()
    }

    pub fn is_empty(&self) -> bool {
        self.i >= self.kids.len()
    }

    pub fn take(&mut self, what: &str) -> Result<&'a Node, Refuse> {
        match self.kids.get(self.i) {
            Some(n) => {
                self.i += 1;
                Ok(n)
            }
            None => Err(Refuse(format!("expected {what}, found end"))),
        }
    }

    pub fn finish(self, where_: &str) -> Result<(), Refuse> {
        if let Some(n) = self.kids.get(self.i) {
            Err(Refuse(format!("unconsumed {} in {where_}", n.kind)))
        } else {
            Ok(())
        }
    }
}

pub fn non_comments<'a>(node: &'a Node, comment_type: &str) -> Vec<&'a Node> {
    node.children
        .iter()
        .filter(|c| c.kind != comment_type)
        .collect()
}
