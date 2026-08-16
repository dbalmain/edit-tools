//! Comment attachment and blank-line measurement.
//!
//! Comments arrive as ordinary children. The runtime -- not the package --
//! consumes them, by one language-independent rule: a comment alone on its
//! line becomes a leading item of the next sibling that is not punctuation,
//! and a comment sharing a line with preceding code becomes a line suffix of
//! the sibling before it. A comment with nothing left to lead trails the last
//! non-punctuation sibling instead.
//!
//! They are consumed exactly once and in order, so the partition the linearity
//! invariant asks for still holds; the package simply never sees them.

use crate::pkg::Package;
use crate::tree::Node;

pub struct Comment {
    pub text: String,
    /// Blank lines between this comment and whatever precedes it.
    pub blanks: usize,
}

/// One direct child of a node, with the comments the runtime attached to it.
pub struct Item<'a> {
    pub node: &'a Node,
    pub lead: Vec<Comment>,
    pub suffix: Vec<String>,
    pub after: Vec<Comment>,
    /// Blank lines before this item, counting from its first leading comment.
    pub blanks: usize,
    /// Blank lines between the last leading comment and the item itself.
    pub gap: usize,
}

impl Item<'_> {
    pub fn decorated(&self) -> bool {
        !self.lead.is_empty() || !self.suffix.is_empty() || !self.after.is_empty()
    }
}

fn newlines(src: &[u8], from: usize, to: usize) -> usize {
    if from >= to || to > src.len() {
        return 0;
    }
    src[from..to].iter().filter(|&&b| b == b'\n').count()
}

/// A node's children, split into items with every comment attached to one of
/// them -- or, for a node that holds nothing but comments, left dangling.
pub struct Split<'a> {
    pub items: Vec<Item<'a>>,
    pub dangling: Vec<Comment>,
    /// Blank lines between the last child and the node's end.
    ///
    /// Some grammars (tree-sitter-toml's `table` is the first) include the
    /// blank line before the next sibling *inside* this node. `blank` between
    /// the parent's children cannot see that gap; a `blank` at the end of
    /// this node's rule can.
    pub trailing_blanks: usize,
}

pub fn split<'a>(node: &'a Node, src: &[u8], pkg: &Package) -> Split<'a> {
    let mut items: Vec<Item<'a>> = Vec::new();
    let mut lead: Vec<Comment> = Vec::new();
    let mut prev_end = node.start;

    for child in &node.children {
        let gap = newlines(src, prev_end, child.start);
        prev_end = child.end;

        if pkg.comments.contains(&child.kind) {
            let text = child.text.clone().unwrap_or_default();
            match items.last_mut() {
                Some(last) if gap == 0 => last.suffix.push(text),
                _ => lead.push(Comment {
                    text,
                    blanks: gap.saturating_sub(1),
                }),
            }
            continue;
        }
        let blanks = gap.saturating_sub(1);
        // Punctuation cannot carry a leading comment: emitting it there would
        // put the comment at the wrong indent, outside the bracket it closes.
        let take = if pkg.is_token(&child.kind) {
            Vec::new()
        } else {
            std::mem::take(&mut lead)
        };
        items.push(Item {
            node: child,
            blanks: take.first().map_or(blanks, |c| c.blanks),
            gap: if take.is_empty() { 0 } else { blanks },
            lead: take,
            suffix: Vec::new(),
            after: Vec::new(),
        });
    }

    let mut dangling = Vec::new();
    if !lead.is_empty() {
        match items
            .iter_mut()
            .rev()
            .find(|item| !pkg.is_token(&item.node.kind))
        {
            Some(host) => host.after = lead,
            // A file that is nothing but comments is still a file.
            None => dangling = lead,
        }
    }
    let trailing_blanks = newlines(src, prev_end, node.end).saturating_sub(1);
    Split {
        items,
        dangling,
        trailing_blanks,
    }
}
