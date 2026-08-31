//! The graph-structured stack -- `lib/src/stack.c`.
//!
//! Go needs all of this. Its grammar is genuinely ambiguous and tree-sitter
//! resolves that at parse time rather than at table-generation time, so an
//! interpreter for it is not an LR interpreter: it needs version forking and
//! merging, dynamic precedence, and pausing a version that cannot proceed.
//!
//! Stack nodes are arena-addressed for the same reason subtrees are -- the JS
//! mutates shared nodes in place through `stackNodeAddLink`, which is a
//! pointer graph, not a tree.

use super::blob::{StateId, ERROR_STATE};
use super::subtree::{subtree_node_count, Arena, SubtreeId};

pub const MAX_LINK_COUNT: usize = 8;
pub const MAX_ITERATOR_COUNT: usize = 64;
/// `ERROR_COST_PER_RECOVERY`.
const ERROR_COST_PER_RECOVERY: u32 = 500;

pub type StackNodeId = usize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Active,
    Paused,
    Halted,
}

#[derive(Debug, Clone, Copy)]
pub struct StackLink {
    pub node: StackNodeId,
    pub subtree: Option<SubtreeId>,
    pub is_pending: bool,
}

#[derive(Debug, Clone)]
pub struct StackNode {
    pub state: StateId,
    pub links: Vec<StackLink>,
    pub position: usize,
    pub error_cost: u32,
    pub node_count: u32,
    pub dynamic_precedence: i32,
}

#[derive(Debug, Clone)]
pub struct Head {
    pub node: StackNodeId,
    pub status: Status,
    pub node_count_at_last_error: u32,
    pub lookahead_when_paused: Option<SubtreeId>,
}

#[derive(Debug)]
pub struct Slice {
    pub subtrees: Vec<SubtreeId>,
    pub version: usize,
}

/// What `stack__iter` is looking for. An enum rather than a closure so the
/// walk can borrow the stack mutably while deciding.
#[derive(Debug, Clone, Copy)]
pub enum PopCriterion {
    /// `stack_pop_count`: stop and pop once this many non-extra subtrees have
    /// been walked past.
    Count(u32),
    /// `stack_pop_all`: walk to the bottom of the stack.
    All,
}

#[derive(Debug, Clone)]
struct Iterator_ {
    node: StackNodeId,
    subtrees: Vec<SubtreeId>,
    subtree_count: u32,
    is_pending: bool,
}

pub struct Stack {
    nodes: Vec<StackNode>,
    pub heads: Vec<Head>,
    base_node: StackNodeId,
}

impl Stack {
    pub fn new() -> Self {
        let mut stack = Stack {
            nodes: Vec::new(),
            heads: Vec::new(),
            base_node: 0,
        };
        // The base node's state is 1, as in the JS and the C.
        stack.base_node = stack.new_node(None, None, false, 1, &Arena::new());
        stack.clear();
        stack
    }

    pub fn node(&self, id: StackNodeId) -> &StackNode {
        &self.nodes[id]
    }

    fn new_node(
        &mut self,
        previous: Option<StackNodeId>,
        subtree: Option<SubtreeId>,
        is_pending: bool,
        state: StateId,
        arena: &Arena,
    ) -> StackNodeId {
        let mut node = StackNode {
            state,
            links: Vec::new(),
            position: 0,
            error_cost: 0,
            node_count: 0,
            dynamic_precedence: 0,
        };
        if let Some(prev) = previous {
            node.links.push(StackLink {
                node: prev,
                subtree,
                is_pending,
            });
            let p = &self.nodes[prev];
            node.position = p.position;
            node.error_cost = p.error_cost;
            node.dynamic_precedence = p.dynamic_precedence;
            node.node_count = p.node_count;
            if let Some(id) = subtree {
                let t = arena.get(id);
                node.error_cost += t.error_cost;
                node.position += t.total_size();
                node.node_count += subtree_node_count(t);
                node.dynamic_precedence += t.dynamic_precedence;
            }
        }
        self.nodes.push(node);
        self.nodes.len() - 1
    }

    pub fn clear(&mut self) {
        self.heads = vec![Head {
            node: self.base_node,
            status: Status::Active,
            node_count_at_last_error: 0,
            lookahead_when_paused: None,
        }];
    }

    pub fn version_count(&self) -> usize {
        self.heads.len()
    }

    pub fn state(&self, v: usize) -> StateId {
        self.nodes[self.heads[v].node].state
    }

    pub fn position(&self, v: usize) -> usize {
        self.nodes[self.heads[v].node].position
    }

    pub fn dynamic_precedence(&self, v: usize) -> i32 {
        self.nodes[self.heads[v].node].dynamic_precedence
    }

    pub fn is_active(&self, v: usize) -> bool {
        self.heads[v].status == Status::Active
    }

    pub fn is_paused(&self, v: usize) -> bool {
        self.heads[v].status == Status::Paused
    }

    pub fn is_halted(&self, v: usize) -> bool {
        self.heads[v].status == Status::Halted
    }

    pub fn halt(&mut self, v: usize) {
        self.heads[v].status = Status::Halted;
    }

    pub fn pause(&mut self, v: usize, lookahead: Option<SubtreeId>) {
        let node_count = self.nodes[self.heads[v].node].node_count;
        let head = &mut self.heads[v];
        head.status = Status::Paused;
        head.lookahead_when_paused = lookahead;
        head.node_count_at_last_error = node_count;
    }

    pub fn halted_version_count(&self) -> usize {
        self.heads
            .iter()
            .filter(|h| h.status == Status::Halted)
            .count()
    }

    pub fn error_cost(&self, v: usize) -> u32 {
        let head = &self.heads[v];
        let node = &self.nodes[head.node];
        let mut result = node.error_cost;
        if head.status == Status::Paused
            || (node.state == ERROR_STATE
                && node.links.first().is_some_and(|l| l.subtree.is_none()))
        {
            result += ERROR_COST_PER_RECOVERY;
        }
        result
    }

    pub fn node_count_since_error(&mut self, v: usize) -> u32 {
        let node_count = self.nodes[self.heads[v].node].node_count;
        let head = &mut self.heads[v];
        if node_count < head.node_count_at_last_error {
            head.node_count_at_last_error = node_count;
        }
        node_count - head.node_count_at_last_error
    }

    pub fn push(
        &mut self,
        v: usize,
        subtree: Option<SubtreeId>,
        pending: bool,
        state: StateId,
        arena: &Arena,
    ) {
        let previous = self.heads[v].node;
        let node = self.new_node(Some(previous), subtree, pending, state, arena);
        if subtree.is_none() {
            self.heads[v].node_count_at_last_error = self.nodes[node].node_count;
        }
        self.heads[v].node = node;
    }

    fn add_version(&mut self, original_version: usize, node: StackNodeId) -> usize {
        self.heads.push(Head {
            node,
            node_count_at_last_error: self.heads[original_version].node_count_at_last_error,
            status: Status::Active,
            lookahead_when_paused: None,
        });
        self.heads.len() - 1
    }

    fn add_slice(
        &mut self,
        slices: &mut Vec<Slice>,
        original_version: usize,
        node: StackNodeId,
        subtrees: Vec<SubtreeId>,
    ) {
        for i in (0..slices.len()).rev() {
            let version = slices[i].version;
            if self.heads[version].node == node {
                slices.insert(i + 1, Slice { subtrees, version });
                return;
            }
        }
        let version = self.add_version(original_version, node);
        slices.push(Slice { subtrees, version });
    }

    /// `stack__iter`.
    fn iter(
        &mut self,
        version: usize,
        criterion: PopCriterion,
        include_subtrees: bool,
        arena: &Arena,
    ) -> Vec<Slice> {
        let mut slices: Vec<Slice> = Vec::new();
        let mut iterators = vec![Iterator_ {
            node: self.heads[version].node,
            subtrees: Vec::new(),
            subtree_count: 0,
            is_pending: true,
        }];
        while !iterators.is_empty() {
            let mut size = iterators.len();
            let mut i = 0;
            while i < size {
                let node_id = iterators[i].node;
                let link_count = self.nodes[node_id].links.len();
                let action = match criterion {
                    PopCriterion::Count(count) => {
                        if iterators[i].subtree_count == count {
                            3
                        } else {
                            0
                        }
                    }
                    PopCriterion::All => {
                        if link_count == 0 {
                            2
                        } else {
                            0
                        }
                    }
                };
                let should_pop = action & 2 != 0;
                let should_stop = (action & 1 != 0) || link_count == 0;

                if should_pop {
                    let mut subtrees = if should_stop {
                        std::mem::take(&mut iterators[i].subtrees)
                    } else {
                        iterators[i].subtrees.clone()
                    };
                    subtrees.reverse();
                    self.add_slice(&mut slices, version, node_id, subtrees);
                }
                if should_stop {
                    iterators.remove(i);
                    size -= 1;
                    continue;
                }

                for j in 1..=link_count {
                    let (link, target) = if j == link_count {
                        (self.nodes[node_id].links[0], i)
                    } else {
                        if iterators.len() >= MAX_ITERATOR_COUNT {
                            continue;
                        }
                        let copy = iterators[i].clone();
                        iterators.push(copy);
                        (self.nodes[node_id].links[j], iterators.len() - 1)
                    };
                    let it = &mut iterators[target];
                    it.node = link.node;
                    match link.subtree {
                        Some(subtree) => {
                            if include_subtrees {
                                it.subtrees.push(subtree);
                            }
                            if !arena.get(subtree).extra {
                                it.subtree_count += 1;
                                if !link.is_pending {
                                    it.is_pending = false;
                                }
                            }
                        }
                        None => {
                            it.subtree_count += 1;
                            it.is_pending = false;
                        }
                    }
                }
                i += 1;
            }
        }
        slices
    }

    pub fn pop_count(&mut self, version: usize, count: u32, arena: &Arena) -> Vec<Slice> {
        self.iter(version, PopCriterion::Count(count), true, arena)
    }

    pub fn pop_all(&mut self, version: usize, arena: &Arena) -> Vec<Slice> {
        self.iter(version, PopCriterion::All, true, arena)
    }

    pub fn can_merge(&self, v1: usize, v2: usize) -> bool {
        let (h1, h2) = (&self.heads[v1], &self.heads[v2]);
        let (n1, n2) = (&self.nodes[h1.node], &self.nodes[h2.node]);
        h1.status == Status::Active
            && h2.status == Status::Active
            && n1.state == n2.state
            && n1.position == n2.position
            && n1.error_cost == n2.error_cost
    }

    pub fn merge(&mut self, v1: usize, v2: usize, arena: &Arena) -> bool {
        if !self.can_merge(v1, v2) {
            return false;
        }
        let target = self.heads[v1].node;
        let source_links = self.nodes[self.heads[v2].node].links.clone();
        for link in source_links {
            self.add_link(target, link, arena);
        }
        if self.nodes[target].state == ERROR_STATE {
            self.heads[v1].node_count_at_last_error = self.nodes[target].node_count;
        }
        self.remove_version(v2);
        true
    }

    /// `stack_node_add_link`.
    fn add_link(&mut self, self_id: StackNodeId, link: StackLink, arena: &Arena) {
        if link.node == self_id {
            return;
        }
        let dp_of = |s: Option<SubtreeId>| s.map_or(0, |id| arena.get(id).dynamic_precedence);
        for i in 0..self.nodes[self_id].links.len() {
            let existing = self.nodes[self_id].links[i];
            if !subtree_is_equivalent(arena, existing.subtree, link.subtree) {
                continue;
            }
            if existing.node == link.node {
                if dp_of(link.subtree) > dp_of(existing.subtree) {
                    self.nodes[self_id].links[i].subtree = link.subtree;
                    self.nodes[self_id].dynamic_precedence =
                        self.nodes[link.node].dynamic_precedence + dp_of(link.subtree);
                }
                return;
            }
            let (e, l) = (&self.nodes[existing.node], &self.nodes[link.node]);
            if e.state == l.state && e.position == l.position && e.error_cost == l.error_cost {
                let inner = self.nodes[link.node].links.clone();
                for l in inner {
                    self.add_link(existing.node, l, arena);
                }
                let dp = self.nodes[link.node].dynamic_precedence + dp_of(link.subtree);
                if dp > self.nodes[self_id].dynamic_precedence {
                    self.nodes[self_id].dynamic_precedence = dp;
                }
                return;
            }
        }
        if self.nodes[self_id].links.len() == MAX_LINK_COUNT {
            return;
        }
        let mut node_count = self.nodes[link.node].node_count;
        let mut dp = self.nodes[link.node].dynamic_precedence;
        self.nodes[self_id].links.push(link);
        if let Some(id) = link.subtree {
            let t = arena.get(id);
            node_count += subtree_node_count(t);
            dp += t.dynamic_precedence;
        }
        if node_count > self.nodes[self_id].node_count {
            self.nodes[self_id].node_count = node_count;
        }
        if dp > self.nodes[self_id].dynamic_precedence {
            self.nodes[self_id].dynamic_precedence = dp;
        }
    }

    pub fn renumber_version(&mut self, v1: usize, v2: usize) {
        if v1 == v2 {
            return;
        }
        self.heads[v2] = self.heads[v1].clone();
        self.heads.remove(v1);
    }

    pub fn remove_version(&mut self, v: usize) {
        self.heads.remove(v);
    }

    pub fn swap_versions(&mut self, v1: usize, v2: usize) {
        self.heads.swap(v1, v2);
    }
}

fn subtree_is_equivalent(arena: &Arena, left: Option<SubtreeId>, right: Option<SubtreeId>) -> bool {
    if left == right {
        return true;
    }
    let (Some(left), Some(right)) = (left, right) else {
        return false;
    };
    let (l, r) = (arena.get(left), arena.get(right));
    if l.symbol != r.symbol {
        return false;
    }
    if l.error_cost > 0 && r.error_cost > 0 {
        return true;
    }
    l.padding == r.padding
        && l.size == r.size
        && l.child_count() == r.child_count()
        && l.extra == r.extra
}
