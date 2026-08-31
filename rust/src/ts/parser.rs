//! The parse loop -- `lib/src/parser.c`.

use super::blob::{Action, ActionEntry, Language, StateId, Symbol, EMPTY_ENTRY};
use super::blob::{ERROR_STATE, NO_LEX_STATE, TS_BUILTIN_SYM_END, TS_TREE_STATE_NONE};
use super::lexer::Lexer;
use super::stack::Stack;
use super::subtree::{remove_trailing_extras, subtree_compare, Arena, Leaf, SubtreeId};
use super::Unsupported;

const MAX_VERSION_COUNT: usize = 6;
const MAX_VERSION_COUNT_OVERFLOW: usize = 4;
/// `18 * ERROR_COST_PER_SKIPPED_TREE`.
const MAX_COST_DIFFERENCE: u32 = 18 * 100;
/// The cost `ts_parser__condense_stack` charges a paused version.
const ERROR_COST_PER_SKIPPED_TREE: u32 = 100;

/// `ts_parser__condense_stack`'s verdict on a pair of versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cmp {
    TakeLeft,
    PreferLeft,
    None,
    PreferRight,
    TakeRight,
}

#[derive(Debug, Clone, Copy)]
struct VersionStatus {
    cost: u32,
    node_count: u32,
    dynamic_precedence: i32,
    is_in_error: bool,
}

/// The arguments of one REDUCE action, grouped as they travel together.
#[derive(Debug, Clone, Copy)]
struct Reduction {
    symbol: Symbol,
    count: u32,
    dynamic_precedence: i32,
    production_id: u16,
    is_fragile: bool,
    end_of_non_terminal_extra: bool,
}

pub struct Parser<'a> {
    pub lang: &'a Language,
    pub arena: Arena,
    lexer: Lexer<'a>,
    stack: Stack,
    finished_tree: Option<SubtreeId>,
    accept_count: usize,
    cached_token: Option<SubtreeId>,
    cached_token_byte_index: usize,
}

impl<'a> Parser<'a> {
    pub fn new(lang: &'a Language, source: &'a [u8]) -> Self {
        Parser {
            lang,
            arena: Arena::new(),
            lexer: Lexer::new(source),
            stack: Stack::new(),
            finished_tree: None,
            accept_count: 0,
            cached_token: None,
            cached_token_byte_index: 0,
        }
    }

    /// `ts_parser__lex`.
    fn lex(
        &mut self,
        version: usize,
        parse_state: StateId,
    ) -> Result<Option<SubtreeId>, Unsupported> {
        let lang = self.lang;
        let mut lex_state = lang.lex_state(parse_state);
        if lex_state == NO_LEX_STATE {
            return Ok(None);
        }
        if lang.external_lex_state(parse_state) != 0 {
            return Err(Unsupported("external scanner state reached".into()));
        }
        // Upstream also tracks a reserved-word set id here and switches it in
        // error mode. The JS reference computes it and never reads it -- the
        // keyword check below re-derives the set from `parse_state` instead --
        // so it is left out rather than reproduced as dead code. See the
        // done-note: this is a place the JS may diverge from upstream, and it
        // is not this port's to change unilaterally.

        let start_position = self.stack.position(version);
        let mut error_mode = parse_state == ERROR_STATE;
        let mut lookahead_end_byte = 0usize;
        self.lexer.reset(start_position);

        loop {
            self.lexer.start();
            let found = self.lexer.run(&lang.b.lex, lex_state)?;
            self.lexer.finish();
            if self.lexer.pos + 1 > lookahead_end_byte {
                lookahead_end_byte = self.lexer.pos + 1;
            }
            if found {
                break;
            }
            if !error_mode {
                error_mode = true;
                lex_state = lang.lex_state(ERROR_STATE);
                self.lexer.reset(start_position);
                continue;
            }
            return Err(Unsupported(format!(
                "no token at byte {}: error recovery is out of scope",
                self.lexer.pos
            )));
        }

        let mut is_keyword = false;
        let mut symbol = self.lexer.result_symbol;
        let token_start = self.lexer.token_start;
        let token_end = self.lexer.token_end_or_pos();
        let padding = token_start - start_position;
        let size = token_end - token_start;
        let lookahead_bytes = lookahead_end_byte - token_end;

        if symbol == lang.b.keyword_capture_token && symbol != 0 {
            let end_byte = token_end;
            self.lexer.reset(token_start);
            self.lexer.start();
            let keyword_lex = lang.b.keyword_lex.as_deref().unwrap_or(&[]);
            is_keyword = self.lexer.run(keyword_lex, 0)?;
            self.lexer.finish();
            let result_symbol = self.lexer.result_symbol;
            if is_keyword
                && self.lexer.token_end_or_pos() == end_byte
                && (lang.has_actions(parse_state, result_symbol)
                    || lang.is_reserved_word(parse_state, result_symbol))
            {
                symbol = result_symbol;
            } else {
                is_keyword = false;
            }
        }

        Ok(Some(self.arena.new_leaf(
            lang,
            &Leaf {
                symbol,
                padding,
                size,
                lookahead_bytes,
                parse_state,
                is_keyword,
            },
        )))
    }

    /// `ts_parser__can_reuse_first_leaf`.
    fn can_reuse_first_leaf(&self, state: StateId, tree: SubtreeId, entry: &ActionEntry) -> bool {
        let lang = self.lang;
        let t = self.arena.get(tree);
        let leaf_symbol = t.leaf_symbol();
        let leaf_state = t.leaf_parse_state();
        if lang.lex_state(state) == NO_LEX_STATE {
            return false;
        }
        if entry.count > 0
            && lang.lex_state(leaf_state) == lang.lex_state(state)
            && lang.external_lex_state(leaf_state) == lang.external_lex_state(state)
            && lang.reserved_word_set_id(leaf_state) == lang.reserved_word_set_id(state)
            && (leaf_symbol != lang.b.keyword_capture_token
                || (!t.is_keyword && t.parse_state == state))
        {
            return true;
        }
        if t.size == 0 && leaf_symbol != TS_BUILTIN_SYM_END {
            return false;
        }
        lang.external_lex_state(state) == 0 && entry.reusable != 0
    }

    fn get_cached_token(&self, state: StateId, position: usize) -> Option<SubtreeId> {
        let cached = self.cached_token?;
        if self.cached_token_byte_index != position {
            return None;
        }
        let symbol = self.arena.get(cached).symbol;
        let entry = self.lang.table_entry(state, symbol);
        if self.can_reuse_first_leaf(state, cached, entry) {
            Some(cached)
        } else {
            None
        }
    }

    /// `ts_parser__shift`.
    fn shift(&mut self, version: usize, state: StateId, lookahead: SubtreeId, extra: bool) {
        let (is_leaf, was_extra) = {
            let t = self.arena.get(lookahead);
            (t.child_count() == 0, t.extra)
        };
        let mut to_push = lookahead;
        if extra != was_extra && is_leaf {
            to_push = self.arena.clone_tree(lookahead);
            self.arena.set_extra(to_push, extra);
        }
        self.stack
            .push(version, Some(to_push), !is_leaf, state, &self.arena);
    }

    /// `ts_parser__select_tree`: true when `right` should replace `left`.
    fn select_tree(&self, left: Option<SubtreeId>, right: Option<SubtreeId>) -> bool {
        let Some(left) = left else { return true };
        let Some(right) = right else { return false };
        let (l, r) = (self.arena.get(left), self.arena.get(right));
        if r.error_cost < l.error_cost {
            return true;
        }
        if l.error_cost < r.error_cost {
            return false;
        }
        if r.dynamic_precedence > l.dynamic_precedence {
            return true;
        }
        if l.dynamic_precedence > r.dynamic_precedence {
            return false;
        }
        if l.error_cost > 0 {
            return true;
        }
        match subtree_compare(&self.arena, left, right) {
            -1 => false,
            1 => true,
            _ => false,
        }
    }

    /// `ts_parser__reduce`. Returns the version to renumber, or `None`.
    fn reduce(&mut self, version: usize, r: Reduction) -> Result<Option<usize>, Unsupported> {
        let initial_version_count = self.stack.version_count();
        let pop = self.stack.pop_count(version, r.count, &self.arena);
        let mut removed_version_count = 0usize;
        let halted_version_count = self.stack.halted_version_count();

        let mut i = 0usize;
        while i < pop.len() {
            let slice_version = pop[i].version - removed_version_count;

            if slice_version > MAX_VERSION_COUNT + MAX_VERSION_COUNT_OVERFLOW + halted_version_count
            {
                self.stack.remove_version(slice_version);
                removed_version_count += 1;
                let v = pop[i].version;
                while i + 1 < pop.len() && pop[i + 1].version == v {
                    i += 1;
                }
                i += 1;
                continue;
            }

            let mut children = pop[i].subtrees.clone();
            let mut trailing_extras = remove_trailing_extras(&self.arena, &mut children);
            let mut parent = self
                .arena
                .new_node(self.lang, r.symbol, children, r.production_id)?;

            let v = pop[i].version;
            while i + 1 < pop.len() && pop[i + 1].version == v {
                i += 1;
                let mut next_children = pop[i].subtrees.clone();
                let next_trailing_extras = remove_trailing_extras(&self.arena, &mut next_children);
                let candidate =
                    self.arena
                        .new_node(self.lang, r.symbol, next_children, r.production_id)?;
                if self.select_tree(Some(parent), Some(candidate)) {
                    trailing_extras = next_trailing_extras;
                    parent = candidate;
                }
            }

            let state = self.stack.state(slice_version);
            let next_state = self.lang.next_state(state, r.symbol);
            if r.end_of_non_terminal_extra && next_state == state {
                self.arena.set_extra(parent, true);
            }
            if r.is_fragile || pop.len() > 1 || initial_version_count > 1 {
                self.arena.set_fragile(parent, TS_TREE_STATE_NONE);
            } else {
                self.arena.set_parse_state(parent, state);
            }
            self.arena
                .add_dynamic_precedence(parent, r.dynamic_precedence);

            self.stack
                .push(slice_version, Some(parent), false, next_state, &self.arena);
            for extra in trailing_extras {
                self.stack
                    .push(slice_version, Some(extra), false, next_state, &self.arena);
            }

            for j in 0..slice_version {
                if j == version {
                    continue;
                }
                if self.stack.merge(j, slice_version, &self.arena) {
                    removed_version_count += 1;
                    break;
                }
            }
            i += 1;
        }

        Ok(if self.stack.version_count() > initial_version_count {
            Some(initial_version_count)
        } else {
            None
        })
    }

    /// `ts_parser__accept`.
    fn accept(&mut self, version: usize, lookahead: Option<SubtreeId>) -> Result<(), Unsupported> {
        self.stack.push(version, lookahead, false, 1, &self.arena);
        let pop = self.stack.pop_all(version, &self.arena);
        for slice in &pop {
            let trees = &slice.subtrees;
            let mut root = None;
            for j in (0..trees.len()).rev() {
                let tree = trees[j];
                if self.arena.get(tree).extra {
                    continue;
                }
                let (symbol, production_id, children) = {
                    let t = self.arena.get(tree);
                    (t.symbol, t.production_id, t.children.clone())
                };
                let mut spliced: Vec<SubtreeId> = trees[..j].to_vec();
                spliced.extend_from_slice(&children);
                spliced.extend_from_slice(&trees[j + 1..]);
                root = Some(
                    self.arena
                        .new_node(self.lang, symbol, spliced, production_id)?,
                );
                break;
            }
            let Some(root) = root else {
                return Err(Unsupported("accept produced no root".into()));
            };
            self.accept_count += 1;
            if self.finished_tree.is_some() {
                if self.select_tree(self.finished_tree, Some(root)) {
                    self.finished_tree = Some(root);
                }
            } else {
                self.finished_tree = Some(root);
            }
        }
        if let Some(first) = pop.first() {
            self.stack.remove_version(first.version);
        }
        self.stack.halt(version);
        Ok(())
    }

    /// `ts_parser__advance`.
    fn advance(&mut self, version: usize) -> Result<(), Unsupported> {
        let lang = self.lang;
        let mut state = self.stack.state(version);
        let position = self.stack.position(version);

        let mut lookahead: Option<SubtreeId> = None;
        // Borrowed from the language, not from `self`, so the parse loop stays
        // free to mutate the stack and the arena while holding it.
        let mut table_entry: &ActionEntry = &EMPTY_ENTRY;
        if let Some(cached) = self.get_cached_token(state, position) {
            lookahead = Some(cached);
            table_entry = lang.table_entry(state, self.arena.get(cached).symbol);
        }

        let mut needs_lex = lookahead.is_none();
        loop {
            if needs_lex {
                needs_lex = false;
                lookahead = self.lex(version, state)?;
                match lookahead {
                    Some(token) => {
                        self.cached_token = Some(token);
                        self.cached_token_byte_index = position;
                        table_entry = lang.table_entry(state, self.arena.get(token).symbol);
                    }
                    None => {
                        table_entry = lang.table_entry(state, TS_BUILTIN_SYM_END);
                    }
                }
            }

            let mut did_reduce = false;
            let mut last_reduction_version: Option<usize> = None;
            for &action in table_entry.actions() {
                match action {
                    Action::Shift {
                        state: target,
                        extra,
                        repetition,
                    } => {
                        if repetition {
                            continue;
                        }
                        let next_state = if extra { state } else { target };
                        let Some(token) = lookahead else {
                            return Err(Unsupported("shift with no lookahead".into()));
                        };
                        if self.arena.get(token).child_count() > 0 {
                            return Err(Unsupported(
                                "shifting a non-leaf lookahead needs breakdown".into(),
                            ));
                        }
                        self.shift(version, next_state, token, extra);
                        return Ok(());
                    }
                    Action::Reduce {
                        symbol,
                        child_count,
                        dynamic_precedence,
                        production_id,
                    } => {
                        let reduction = Reduction {
                            symbol,
                            count: child_count,
                            dynamic_precedence,
                            production_id,
                            is_fragile: table_entry.count > 1,
                            end_of_non_terminal_extra: lookahead.is_none(),
                        };
                        let reduction_version = self.reduce(version, reduction)?;
                        did_reduce = true;
                        if let Some(v) = reduction_version {
                            last_reduction_version = Some(v);
                        }
                    }
                    Action::Accept => {
                        self.accept(version, lookahead)?;
                        return Ok(());
                    }
                    Action::Recover => {
                        return Err(Unsupported(
                            "RECOVER action: error recovery is out of scope".into(),
                        ));
                    }
                    Action::Unknown(kind) => {
                        return Err(Unsupported(format!("parse action {kind}")));
                    }
                }
            }

            if let Some(v) = last_reduction_version {
                self.stack.renumber_version(v, version);
                state = self.stack.state(version);
                match lookahead {
                    None => needs_lex = true,
                    Some(token) => {
                        let leaf = self.arena.get(token).leaf_symbol();
                        table_entry = lang.table_entry(state, leaf);
                    }
                }
                continue;
            }

            if did_reduce {
                self.stack.halt(version);
                return Ok(());
            }

            if let Some(token) = lookahead {
                let (is_keyword, symbol) = {
                    let t = self.arena.get(token);
                    (t.is_keyword, t.symbol)
                };
                if is_keyword
                    && symbol != lang.b.keyword_capture_token
                    && !lang.is_reserved_word(state, symbol)
                {
                    let entry = lang.table_entry(state, lang.b.keyword_capture_token);
                    if entry.count > 0 {
                        let mutable = self.arena.clone_tree(token);
                        let capture = lang.b.keyword_capture_token;
                        self.arena.set_symbol(
                            mutable,
                            capture,
                            lang.visible(capture),
                            lang.named(capture),
                        );
                        lookahead = Some(mutable);
                        table_entry = entry;
                        continue;
                    }
                }
            }

            // ts_parser__breakdown_top_of_stack always fails here: it pops
            // *pending* links, and links are only pending when a reused
            // non-leaf subtree was shifted, which needs an old tree.
            //
            // So: this version cannot proceed. That is not an error -- under
            // GLR it is the ordinary way a speculative version dies. Pause it
            // and let the others run; condense_stack discards it once a better
            // version exists, and only escalates to recovery if every version
            // is paused.
            self.stack.pause(version, lookahead);
            return Ok(());
        }
    }

    fn version_status(&mut self, version: usize) -> VersionStatus {
        let mut cost = self.stack.error_cost(version);
        let is_paused = self.stack.is_paused(version);
        if is_paused {
            cost += ERROR_COST_PER_SKIPPED_TREE;
        }
        VersionStatus {
            cost,
            node_count: self.stack.node_count_since_error(version),
            dynamic_precedence: self.stack.dynamic_precedence(version),
            is_in_error: is_paused || self.stack.state(version) == ERROR_STATE,
        }
    }

    fn compare_versions(a: VersionStatus, b: VersionStatus) -> Cmp {
        if !a.is_in_error && b.is_in_error {
            return if a.cost < b.cost {
                Cmp::TakeLeft
            } else {
                Cmp::PreferLeft
            };
        }
        if a.is_in_error && !b.is_in_error {
            return if b.cost < a.cost {
                Cmp::TakeRight
            } else {
                Cmp::PreferRight
            };
        }
        if a.cost < b.cost {
            return if (b.cost - a.cost) * (1 + a.node_count) > MAX_COST_DIFFERENCE {
                Cmp::TakeLeft
            } else {
                Cmp::PreferLeft
            };
        }
        if b.cost < a.cost {
            return if (a.cost - b.cost) * (1 + b.node_count) > MAX_COST_DIFFERENCE {
                Cmp::TakeRight
            } else {
                Cmp::PreferRight
            };
        }
        if a.dynamic_precedence > b.dynamic_precedence {
            return Cmp::PreferLeft;
        }
        if b.dynamic_precedence > a.dynamic_precedence {
            return Cmp::PreferRight;
        }
        Cmp::None
    }

    /// `ts_parser__condense_stack`.
    fn condense_stack(&mut self) -> Result<u32, Unsupported> {
        let mut min_error_cost = u32::MAX;
        let mut i = 0usize;
        while i < self.stack.version_count() {
            if self.stack.is_halted(i) {
                self.stack.remove_version(i);
                continue;
            }
            let status_i = self.version_status(i);
            if !status_i.is_in_error && status_i.cost < min_error_cost {
                min_error_cost = status_i.cost;
            }

            // status_i is computed once, before the inner loop, exactly as the
            // JS does. Recomputing it per candidate would read a stack the
            // merges and removals below have already changed.
            let mut j = 0usize;
            let mut removed = false;
            while j < i {
                let status_j = self.version_status(j);
                match Self::compare_versions(status_j, status_i) {
                    Cmp::TakeLeft => {
                        self.stack.remove_version(i);
                        removed = true;
                        break;
                    }
                    Cmp::PreferLeft | Cmp::None => {
                        if self.stack.merge(j, i, &self.arena) {
                            removed = true;
                            break;
                        }
                    }
                    Cmp::PreferRight => {
                        if self.stack.merge(j, i, &self.arena) {
                            removed = true;
                            break;
                        }
                        self.stack.swap_versions(i, j);
                    }
                    Cmp::TakeRight => {
                        self.stack.remove_version(j);
                        i -= 1;
                        continue;
                    }
                }
                j += 1;
            }
            if !removed {
                i += 1;
            }
        }

        while self.stack.version_count() > MAX_VERSION_COUNT {
            self.stack.remove_version(MAX_VERSION_COUNT);
        }

        // Paused versions: upstream resumes the best one into error recovery
        // and drops the rest. Dropping the rest is ordinary GLR pruning and is
        // implemented; resuming one means the whole parse is in error, which is
        // out of scope, so say so instead of inventing a recovery.
        let mut has_unpaused_version = false;
        let mut i = 0usize;
        while i < self.stack.version_count() {
            if self.stack.is_paused(i) {
                if !has_unpaused_version && self.accept_count < MAX_VERSION_COUNT {
                    // Upstream resumes the *best-ranked* paused version into
                    // recovery. Versions are ordered best-first by this point,
                    // so reaching here with no unpaused predecessor is exactly
                    // upstream's resume trigger.
                    let head = self.stack.heads[i].clone();
                    let node = self.stack.node(head.node);
                    let (position, state) = (node.position, node.state);
                    let token = head.lookahead_when_paused.map(|t| {
                        format!(
                            ", lookahead {}",
                            self.lang.symbol_name(self.arena.get(t).symbol)
                        )
                    });
                    return Err(Unsupported(format!(
                        "parse needs error recovery at byte {position}{}, state {state}: out of scope",
                        token.unwrap_or_default()
                    )));
                }
                self.stack.remove_version(i);
            } else {
                has_unpaused_version = true;
                i += 1;
            }
        }
        Ok(min_error_cost)
    }

    /// `ts_parser_parse`.
    pub fn parse(&mut self) -> Result<SubtreeId, Unsupported> {
        let mut last_position = 0usize;
        let mut version_count;
        loop {
            let mut version = 0usize;
            loop {
                version_count = self.stack.version_count();
                if version >= version_count {
                    break;
                }
                while self.stack.is_active(version) {
                    self.advance(version)?;
                    let position = self.stack.position(version);
                    if position > last_position || (version > 0 && position == last_position) {
                        last_position = position;
                        break;
                    }
                }
                version += 1;
            }
            let min_error_cost = self.condense_stack()?;
            if let Some(tree) = self.finished_tree {
                if self.arena.get(tree).error_cost < min_error_cost {
                    self.stack.clear();
                    break;
                }
            }
            if version_count == 0 {
                break;
            }
        }

        // ts_parser__balance_subtree is skipped: it rotates same-symbol
        // invisible repeat nodes, which preserves leaf order and therefore the
        // visible tree.
        self.finished_tree
            .ok_or_else(|| Unsupported("parse produced no tree".into()))
    }
}
