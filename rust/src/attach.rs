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
use crate::Refusal;

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

/// Split a node's children into items, attaching every comment to one of them.
pub fn items<'a>(node: &'a Node, src: &[u8], pkg: &Package) -> Result<Vec<Item<'a>>, Refusal> {
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
            lead: take,
            suffix: Vec::new(),
            after: Vec::new(),
        });
    }

    if !lead.is_empty() {
        let host = items
            .iter_mut()
            .rev()
            .find(|item| !pkg.is_token(&item.node.kind));
        let Some(host) = host else {
            return Err(Refusal(format!(
                "`{}` holds nothing but comments; nowhere to attach them",
                node.kind
            )));
        };
        host.after = lead;
    }
    Ok(items)
}
