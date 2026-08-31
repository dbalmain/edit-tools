//! Subtrees -- `lib/src/subtree.c`.
//!
//! The JS leans on the garbage collector: subtrees are objects, shared freely
//! between stack versions, and compared with `===`. This port uses an arena of
//! `Subtree` values addressed by index instead, for three reasons that all
//! matter to a faithful port rather than to taste:
//!
//!   * index equality *is* the JS's reference equality, so
//!     `subtree_is_equivalent`'s identity fast path ports exactly;
//!   * sharing a subtree between versions is a copied `usize`, as it is a
//!     copied pointer in the C;
//!   * nothing recurses on drop. A `repeat` rule builds a left-nested chain one
//!     level per element, and Go's `x86asm/tables.go` is a single ~10,000
//!     element literal -- the shape that already blew the JS stack once.

use super::blob::{Language, Symbol, TS_BUILTIN_SYM_END, TS_BUILTIN_SYM_ERROR};
use super::blob::{TS_BUILTIN_SYM_ERROR_REPEAT, TS_TREE_STATE_NONE};
use super::Unsupported;

pub type SubtreeId = usize;

/// What the lexer establishes about one token: `ts_subtree_new_leaf`'s
/// arguments, grouped because they always travel together.
#[derive(Debug, Clone, Copy)]
pub struct Leaf {
    pub symbol: Symbol,
    pub padding: usize,
    pub size: usize,
    pub lookahead_bytes: usize,
    pub parse_state: u16,
    pub is_keyword: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Subtree {
    pub symbol: Symbol,
    pub children: Vec<SubtreeId>,
    pub padding: usize,
    pub size: usize,
    pub lookahead_bytes: usize,
    pub visible: bool,
    pub named: bool,
    pub extra: bool,
    pub is_keyword: bool,
    pub is_missing: bool,
    pub error_cost: u32,
    pub dynamic_precedence: i32,
    pub production_id: u16,
    pub visible_child_count: u32,
    pub named_child_count: u32,
    pub visible_descendant_count: u32,
    pub fragile_left: bool,
    pub fragile_right: bool,
    pub parse_state: u16,
    pub repeat_depth: u32,
    pub first_leaf_symbol: Symbol,
    pub first_leaf_parse_state: u16,
}

impl Subtree {
    pub fn child_count(&self) -> usize {
        self.children.len()
    }

    pub fn total_size(&self) -> usize {
        self.padding + self.size
    }

    pub fn leaf_symbol(&self) -> Symbol {
        if self.children.is_empty() {
            self.symbol
        } else {
            self.first_leaf_symbol
        }
    }

    pub fn leaf_parse_state(&self) -> u16 {
        if self.children.is_empty() {
            self.parse_state
        } else {
            self.first_leaf_parse_state
        }
    }
}

/// Storage for every subtree built during one parse. Nothing is ever freed --
/// the JS relies on the collector for the same lifetime, and a parse is
/// bounded.
#[derive(Debug, Default)]
pub struct Arena {
    trees: Vec<Subtree>,
}

impl Arena {
    pub fn new() -> Self {
        Arena::default()
    }

    pub fn get(&self, id: SubtreeId) -> &Subtree {
        &self.trees[id]
    }

    pub fn alloc(&mut self, tree: Subtree) -> SubtreeId {
        self.trees.push(tree);
        self.trees.len() - 1
    }

    // The JS builds a subtree and then mutates it in place before anyone else
    // can see it -- `parent.extra = true`, `parent.parseState = ...`, and the
    // keyword remap on a cloned lookahead. With an arena those become explicit
    // setters. This is the one place the two runtimes genuinely cannot look
    // alike; every setter below has a named counterpart in `ts_lr.mjs`, and
    // each is applied to a tree that is not yet shared.

    /// `parent.extra = value`.
    pub fn set_extra(&mut self, id: SubtreeId, value: bool) {
        self.trees[id].extra = value;
    }

    /// `parent.parseState = state`.
    pub fn set_parse_state(&mut self, id: SubtreeId, state: u16) {
        self.trees[id].parse_state = state;
    }

    /// The JS's three-line fragile marking:
    /// `fragileLeft = fragileRight = true; parseState = TS_TREE_STATE_NONE`.
    pub fn set_fragile(&mut self, id: SubtreeId, parse_state: u16) {
        let tree = &mut self.trees[id];
        tree.fragile_left = true;
        tree.fragile_right = true;
        tree.parse_state = parse_state;
    }

    /// `parent.dynamicPrecedence += value`.
    pub fn add_dynamic_precedence(&mut self, id: SubtreeId, value: i32) {
        self.trees[id].dynamic_precedence += value;
    }

    /// The keyword remap: `mutable.symbol = ...` and the two metadata bits the
    /// JS recomputes alongside it.
    pub fn set_symbol(&mut self, id: SubtreeId, symbol: Symbol, visible: bool, named: bool) {
        let tree = &mut self.trees[id];
        tree.symbol = symbol;
        tree.visible = visible;
        tree.named = named;
    }

    /// The JS's `Object.assign(new Subtree(), this)`: a shallow copy, sharing
    /// the children, at a fresh identity.
    pub fn clone_tree(&mut self, id: SubtreeId) -> SubtreeId {
        let copy = self.trees[id].clone();
        self.alloc(copy)
    }

    pub fn new_leaf(&mut self, lang: &Language, leaf: &Leaf) -> SubtreeId {
        let symbol = leaf.symbol;
        let tree = Subtree {
            symbol,
            padding: leaf.padding,
            size: leaf.size,
            lookahead_bytes: leaf.lookahead_bytes,
            parse_state: leaf.parse_state,
            visible: lang.visible(symbol),
            named: lang.named(symbol),
            extra: symbol == TS_BUILTIN_SYM_END,
            is_keyword: leaf.is_keyword,
            ..Subtree::default()
        };
        self.alloc(tree)
    }

    pub fn new_node(
        &mut self,
        lang: &Language,
        symbol: Symbol,
        children: Vec<SubtreeId>,
        production_id: u16,
    ) -> Result<SubtreeId, Unsupported> {
        let fragile = symbol == TS_BUILTIN_SYM_ERROR || symbol == TS_BUILTIN_SYM_ERROR_REPEAT;
        let mut tree = Subtree {
            symbol,
            children,
            visible: lang.visible(symbol),
            named: lang.named(symbol),
            production_id,
            fragile_left: fragile,
            fragile_right: fragile,
            ..Subtree::default()
        };
        summarize_children(&mut tree, lang, self)?;
        Ok(self.alloc(tree))
    }
}

/// `ts_subtree_summarize_children`.
///
/// Takes the node under construction by value rather than by id: it is not in
/// the arena yet, so reading its children needs no aliasing dance.
fn summarize_children(
    this: &mut Subtree,
    lang: &Language,
    arena: &Arena,
) -> Result<(), Unsupported> {
    this.named_child_count = 0;
    this.visible_child_count = 0;
    this.error_cost = 0;
    this.repeat_depth = 0;
    this.visible_descendant_count = 0;
    this.dynamic_precedence = 0;

    let mut structural_index = 0usize;
    let has_aliases = lang.has_alias_sequence(this.production_id);
    let mut lookahead_end_byte = 0usize;

    for i in 0..this.children.len() {
        let child = arena.get(this.children[i]);
        if i == 0 {
            this.padding = child.padding;
            this.size = child.size;
        } else {
            this.size += child.total_size();
        }

        let child_lookahead_end = this.padding + this.size + child.lookahead_bytes;
        if child_lookahead_end > lookahead_end_byte {
            lookahead_end_byte = child_lookahead_end;
        }

        if child.symbol != TS_BUILTIN_SYM_ERROR_REPEAT {
            this.error_cost += child.error_cost;
        }

        let grandchild_count = child.child_count();
        if this.symbol == TS_BUILTIN_SYM_ERROR || this.symbol == TS_BUILTIN_SYM_ERROR_REPEAT {
            return Err(Unsupported(
                "error node construction: error recovery is out of scope".into(),
            ));
        }

        this.dynamic_precedence += child.dynamic_precedence;
        this.visible_descendant_count += child.visible_descendant_count;

        let alias = if has_aliases && !child.extra && child.symbol != 0 {
            lang.alias_at(this.production_id, structural_index)
        } else {
            0
        };
        if alias != 0 {
            this.visible_descendant_count += 1;
            this.visible_child_count += 1;
            if lang.named(alias) {
                this.named_child_count += 1;
            }
        } else if child.visible {
            this.visible_descendant_count += 1;
            this.visible_child_count += 1;
            if child.named {
                this.named_child_count += 1;
            }
        } else if grandchild_count > 0 {
            this.visible_child_count += child.visible_child_count;
            this.named_child_count += child.named_child_count;
        }

        if child.symbol == TS_BUILTIN_SYM_ERROR || child.is_missing {
            this.fragile_left = true;
            this.fragile_right = true;
            this.parse_state = TS_TREE_STATE_NONE;
        }

        if !child.extra {
            structural_index += 1;
        }
    }

    this.lookahead_bytes = lookahead_end_byte - this.size - this.padding;

    if let (Some(&first), Some(&last)) = (this.children.first(), this.children.last()) {
        let first_child = arena.get(first);
        let last_child = arena.get(last);
        this.first_leaf_symbol = first_child.leaf_symbol();
        this.first_leaf_parse_state = first_child.leaf_parse_state();
        let (first_fragile_left, first_repeat, first_symbol) = (
            first_child.fragile_left,
            first_child.repeat_depth,
            first_child.symbol,
        );
        let (last_fragile_right, last_repeat) = (last_child.fragile_right, last_child.repeat_depth);
        if first_fragile_left {
            this.fragile_left = true;
        }
        if last_fragile_right {
            this.fragile_right = true;
        }
        if this.children.len() >= 2 && !this.visible && !this.named && first_symbol == this.symbol {
            this.repeat_depth = first_repeat.max(last_repeat) + 1;
        }
    }

    Ok(())
}

/// `ts_subtree_compare`, iterative for the same reason the C is.
pub fn subtree_compare(arena: &Arena, left: SubtreeId, right: SubtreeId) -> i32 {
    let mut stack = vec![left, right];
    while !stack.is_empty() {
        let (Some(r), Some(l)) = (stack.pop(), stack.pop()) else {
            break;
        };
        let (l, r) = (arena.get(l), arena.get(r));
        let result = if l.symbol < r.symbol {
            -1
        } else if r.symbol < l.symbol {
            1
        } else if l.child_count() < r.child_count() {
            -1
        } else if r.child_count() < l.child_count() {
            1
        } else {
            0
        };
        if result != 0 {
            return result;
        }
        for i in (0..l.child_count()).rev() {
            stack.push(l.children[i]);
            stack.push(r.children[i]);
        }
    }
    0
}

/// Splits the trailing extras off a child list, returning them in order.
pub fn remove_trailing_extras(arena: &Arena, children: &mut Vec<SubtreeId>) -> Vec<SubtreeId> {
    let mut extras = Vec::new();
    while children.last().is_some_and(|&id| arena.get(id).extra) {
        if let Some(id) = children.pop() {
            extras.push(id);
        }
    }
    extras.reverse();
    extras
}

pub fn subtree_node_count(tree: &Subtree) -> u32 {
    let mut count = tree.visible_descendant_count;
    if tree.visible {
        count += 1;
    }
    if tree.symbol == TS_BUILTIN_SYM_ERROR_REPEAT {
        count += 1;
    }
    count
}
