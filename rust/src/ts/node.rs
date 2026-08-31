//! The node API -- `lib/src/node.c`: the visible children of a node, with
//! invisible nodes flattened away, aliases applied, and field names resolved
//! through both.

use super::blob::{Language, Symbol};
use super::subtree::{Arena, Subtree, SubtreeId};

/// One visible child, as `ts_check_trees.mjs` consumes it.
pub struct VisibleChild {
    pub subtree: SubtreeId,
    pub alias: Symbol,
    pub start: usize,
    pub field: Option<String>,
}

fn is_relevant(subtree: &Subtree, alias: Symbol) -> bool {
    subtree.visible || alias != 0
}

fn relevant_child_count(subtree: &Subtree) -> u32 {
    if subtree.child_count() > 0 {
        subtree.visible_child_count
    } else {
        0
    }
}

/// One level of `ts_node_iterate_children`, as an explicit cursor.
struct Frame {
    node: SubtreeId,
    production_id: u16,
    has_aliases: bool,
    index: usize,
    position: usize,
    structural_child_index: usize,
    inherited: Option<String>,
}

impl Frame {
    fn new(
        lang: &Language,
        arena: &Arena,
        node: SubtreeId,
        start: usize,
        inherited: Option<String>,
    ) -> Self {
        let production_id = arena.get(node).production_id;
        Frame {
            node,
            production_id,
            has_aliases: lang.has_alias_sequence(production_id),
            index: 0,
            position: start,
            structural_child_index: 0,
            inherited,
        }
    }
}

/// The visible children of a node, in order: exactly what py-tree-sitter's
/// `node.children` yields, paired with `node.field_name_for_child(i)`.
///
/// Iterative on purpose, as the JS is. A `repeat` rule builds a left-nested
/// chain of invisible aux nodes one level per element, so descending
/// recursively blows the stack on real files -- found on Go's
/// `x86asm/tables.go`, a single ~10,000 element generated literal.
/// tree-sitter's own `ts_node__child` is a `while (did_descend)` loop for the
/// same reason.
pub fn visible_children(
    lang: &Language,
    arena: &Arena,
    subtree: SubtreeId,
    start_byte: usize,
) -> Vec<VisibleChild> {
    let mut out = Vec::new();
    let mut stack = vec![Frame::new(lang, arena, subtree, start_byte, None)];
    while let Some(frame) = stack.last_mut() {
        let parent = arena.get(frame.node);
        if frame.index >= parent.child_count() {
            stack.pop();
            continue;
        }
        let child_id = parent.children[frame.index];
        let child = arena.get(child_id);

        let mut alias = 0;
        if !child.extra {
            if frame.has_aliases {
                alias = lang.alias_at(frame.production_id, frame.structural_child_index);
            }
            frame.structural_child_index += 1;
        }
        if frame.index > 0 {
            frame.position += child.padding;
        }
        let position = frame.position;
        frame.position += child.size;
        frame.index += 1;

        // The JS reads `child.structuralChildIndex - 1`, which is -1 for an
        // extra child and matches no entry in the field map. `checked_sub`
        // reproduces that as "no field" rather than underflowing.
        let field_index = frame.structural_child_index.checked_sub(1);
        let production_id = frame.production_id;
        let inherited = frame.inherited.clone();

        if is_relevant(child, alias) {
            let mut field = None;
            if !child.extra {
                field = field_index
                    .and_then(|i| lang.field_name_for(production_id, i))
                    .map(str::to_string)
                    .or(inherited);
            }
            out.push(VisibleChild {
                subtree: child_id,
                alias,
                start: position,
                field,
            });
        } else if relevant_child_count(child) > 0 {
            let field = field_index
                .and_then(|i| lang.field_name_for(production_id, i))
                .map(str::to_string)
                .or(inherited);
            stack.push(Frame::new(lang, arena, child_id, position, field));
        }
    }
    out
}
