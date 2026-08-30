//! The data blob, and the accessors over it -- `lib/src/language.{c,h}`.
//!
//! Mirrors the `Language` class in `harness/ts_lr.mjs`. The blob is whatever
//! `harness/ts_transcode.py` wrote; unknown keys are ignored rather than
//! rejected, because the JS reads it the same loose way and a table added for
//! one runtime must not break the other.

use std::fmt;

use serde::de::{self, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

pub type Symbol = u16;
pub type StateId = u16;

pub const TS_BUILTIN_SYM_END: Symbol = 0;
pub const TS_BUILTIN_SYM_ERROR: Symbol = 0xffff;
pub const TS_BUILTIN_SYM_ERROR_REPEAT: Symbol = 0xfffe;
pub const ERROR_STATE: StateId = 0;
pub const NO_LEX_STATE: u16 = 0xffff;
pub const TS_TREE_STATE_NONE: u16 = 0xffff;

/// One parse action. The wire form is a positional array whose arity depends on
/// the kind: `[0,state,extra,repetition]`, `[1,symbol,count,precedence,
/// production]`, `[2]`, `[3]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Shift {
        state: StateId,
        extra: bool,
        repetition: bool,
    },
    Reduce {
        symbol: Symbol,
        child_count: u32,
        dynamic_precedence: i32,
        production_id: u16,
    },
    Accept,
    Recover,
    /// A kind the encoding does not define. Kept rather than rejected at load
    /// so that, exactly as in the JS, it errors when *interpreted* -- a blob
    /// carrying an unreachable oddity must load in both runtimes or neither.
    Unknown(i64),
}

impl<'de> Deserialize<'de> for Action {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Action;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a parse action array")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Action, A::Error> {
                let kind: i64 = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::custom("empty parse action"))?;
                let mut next = |what: &'static str| -> Result<i64, A::Error> {
                    seq.next_element()?
                        .ok_or_else(|| de::Error::custom(format!("parse action missing {what}")))
                };
                let action = match kind {
                    0 => Action::Shift {
                        state: next("state")? as StateId,
                        extra: next("extra")? != 0,
                        repetition: next("repetition")? != 0,
                    },
                    1 => Action::Reduce {
                        symbol: next("symbol")? as Symbol,
                        child_count: next("child count")? as u32,
                        dynamic_precedence: next("dynamic precedence")? as i32,
                        production_id: next("production id")? as u16,
                    },
                    2 => Action::Accept,
                    3 => Action::Recover,
                    other => Action::Unknown(other),
                };
                while seq.next_element::<de::IgnoredAny>()?.is_some() {}
                Ok(action)
            }
        }
        d.deserialize_seq(V)
    }
}

/// A row of the parse-action table: `TSParseActionEntry`.
#[derive(Debug, Clone, Deserialize)]
pub struct ActionEntry {
    /// The declared action count. Kept distinct from `actions.len()` because
    /// the JS loops to `entry.c`; every blob checked has them equal.
    #[serde(rename = "c")]
    pub count: usize,
    #[serde(rename = "r")]
    pub reusable: u8,
    #[serde(rename = "a")]
    pub actions: Vec<Action>,
}

/// The `EMPTY_ENTRY` the JS falls back to for an absent or error-symbol entry.
/// A `static` rather than an associated const so callers can borrow it.
pub static EMPTY_ENTRY: ActionEntry = ActionEntry {
    count: 0,
    reusable: 0,
    actions: Vec::new(),
};

impl ActionEntry {
    /// The actions the interpreter may take, bounded by the declared count
    /// exactly as `for (i = 0; i < tableEntry.c; i++)` does in the JS.
    pub fn actions(&self) -> &[Action] {
        let n = self.count.min(self.actions.len());
        &self.actions[..n]
    }
}

/// A flat, sorted, disjoint list of inclusive `[lo, hi]` int32 intervals.
///
/// The domain is the whole int32 line rather than the Unicode range: the lexer
/// reports 0 at EOF and -1 (`TS_DECODE_ERROR`) on invalid UTF-8, so a
/// complement taken over `[0, 0x10FFFF]` would silently disagree with the C.
pub type Ranges = Vec<i32>;

/// One transition in a recovered `ts_lex` state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LexOp {
    /// `[0, sym]` -- ACCEPT_TOKEN.
    AcceptToken(Symbol),
    /// `[1, [char, target, ...]]` -- ADVANCE_MAP.
    AdvanceMap(Vec<i32>),
    /// `[2, eofMode, ranges, act, target]`. `eofMode` is 0 both / 1 only at EOF
    /// / 2 only when not at EOF.
    Guard {
        eof_mode: u8,
        ranges: Ranges,
        act: u8,
        target: u16,
    },
    /// `[3, act, target]` -- a genuinely unconditional action.
    Unconditional { act: u8, target: u16 },
    /// `[4, ranges, eofRanges, act, target]` -- a guard whose truth differs at
    /// EOF, which one interval set cannot express.
    GuardEofSplit {
        ranges: Ranges,
        eof_ranges: Ranges,
        act: u8,
        target: u16,
    },
    /// An op kind the encoding does not define; errors when interpreted, as in
    /// the JS, rather than at load.
    Unknown(i64),
}

impl<'de> Deserialize<'de> for LexOp {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = LexOp;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a lexer op array")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<LexOp, A::Error> {
                let kind: i64 = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::custom("empty lex op"))?;
                let missing =
                    |what: &'static str| de::Error::custom(format!("lex op missing {what}"));
                let op = match kind {
                    0 => LexOp::AcceptToken(
                        seq.next_element::<i64>()?
                            .ok_or_else(|| missing("symbol"))? as Symbol,
                    ),
                    1 => LexOp::AdvanceMap(
                        seq.next_element()?.ok_or_else(|| missing("advance map"))?,
                    ),
                    2 => LexOp::Guard {
                        eof_mode: seq
                            .next_element::<i64>()?
                            .ok_or_else(|| missing("eof mode"))?
                            as u8,
                        ranges: seq.next_element()?.ok_or_else(|| missing("ranges"))?,
                        act: seq
                            .next_element::<i64>()?
                            .ok_or_else(|| missing("action"))? as u8,
                        target: seq
                            .next_element::<i64>()?
                            .ok_or_else(|| missing("target"))?
                            as u16,
                    },
                    3 => LexOp::Unconditional {
                        act: seq
                            .next_element::<i64>()?
                            .ok_or_else(|| missing("action"))? as u8,
                        target: seq
                            .next_element::<i64>()?
                            .ok_or_else(|| missing("target"))?
                            as u16,
                    },
                    4 => LexOp::GuardEofSplit {
                        ranges: seq.next_element()?.ok_or_else(|| missing("ranges"))?,
                        eof_ranges: seq.next_element()?.ok_or_else(|| missing("eof ranges"))?,
                        act: seq
                            .next_element::<i64>()?
                            .ok_or_else(|| missing("action"))? as u8,
                        target: seq
                            .next_element::<i64>()?
                            .ok_or_else(|| missing("target"))?
                            as u16,
                    },
                    other => LexOp::Unknown(other),
                };
                while seq.next_element::<de::IgnoredAny>()?.is_some() {}
                Ok(op)
            }
        }
        d.deserialize_seq(V)
    }
}

/// One recovered `ts_lex` state: an ordered op list.
#[derive(Debug, Clone, Deserialize)]
pub struct LexState {
    #[serde(rename = "o")]
    pub ops: Vec<LexOp>,
}

/// The blob. Only the tables the supported projection reads are declared;
/// `publicSymbolMap` and `aliasMap` are transcoded but never read by either
/// runtime, so they are simply not named here.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blob {
    pub symbol_count: usize,
    pub token_count: usize,
    pub large_state_count: usize,
    pub max_alias_sequence_length: usize,
    pub max_reserved_word_set_size: usize,
    pub field_count: usize,
    pub keyword_capture_token: Symbol,
    pub symbol_names: Vec<String>,
    pub symbol_metadata: Vec<u8>,
    pub field_names: Vec<Option<String>>,
    pub field_map_slices: Vec<u32>,
    pub field_map_entries: Vec<u32>,
    pub alias_sequences: Vec<Symbol>,
    pub lex_states: Vec<u16>,
    pub external_lex_states: Vec<u16>,
    pub reserved_word_set_ids: Vec<u16>,
    pub reserved_words: Vec<Symbol>,
    pub parse_table: Vec<u16>,
    pub small_parse_table: Vec<u16>,
    pub small_parse_table_map: Vec<u32>,
    pub parse_actions: Vec<Option<ActionEntry>>,
    pub lex: Vec<LexState>,
    pub keyword_lex: Option<Vec<LexState>>,
}

/// Accessors over the blob, mirroring `lib/src/language.{c,h}`.
pub struct Language {
    pub b: Blob,
}

impl Language {
    pub fn new(b: Blob) -> Self {
        Language { b }
    }

    /// `ts_language_lookup`.
    pub fn lookup(&self, state: StateId, symbol: Symbol) -> u16 {
        let b = &self.b;
        let state = state as usize;
        if state >= b.large_state_count {
            let Some(&start) = b.small_parse_table_map.get(state - b.large_state_count) else {
                return 0;
            };
            let t = &b.small_parse_table;
            let mut i = start as usize;
            let Some(&group_count) = t.get(i) else {
                return 0;
            };
            i += 1;
            for _ in 0..group_count {
                let (Some(&section_value), Some(&symbol_count)) = (t.get(i), t.get(i + 1)) else {
                    return 0;
                };
                i += 2;
                for _ in 0..symbol_count {
                    match t.get(i) {
                        Some(&s) => {
                            i += 1;
                            if s == symbol {
                                return section_value;
                            }
                        }
                        None => return 0,
                    }
                }
            }
            return 0;
        }
        b.parse_table
            .get(state * b.symbol_count + symbol as usize)
            .copied()
            .unwrap_or(0)
    }

    /// `ts_language_table_entry`.
    pub fn table_entry(&self, state: StateId, symbol: Symbol) -> &ActionEntry {
        if symbol == TS_BUILTIN_SYM_ERROR || symbol == TS_BUILTIN_SYM_ERROR_REPEAT {
            return &EMPTY_ENTRY;
        }
        match self
            .b
            .parse_actions
            .get(self.lookup(state, symbol) as usize)
        {
            Some(Some(entry)) => entry,
            _ => &EMPTY_ENTRY,
        }
    }

    pub fn has_actions(&self, state: StateId, symbol: Symbol) -> bool {
        self.lookup(state, symbol) != 0
    }

    /// `ts_language_next_state`.
    pub fn next_state(&self, state: StateId, symbol: Symbol) -> StateId {
        if symbol == TS_BUILTIN_SYM_ERROR || symbol == TS_BUILTIN_SYM_ERROR_REPEAT {
            return 0;
        }
        if (symbol as usize) < self.b.token_count {
            let entry = self.table_entry(state, symbol);
            let actions = entry.actions();
            if let Some(&Action::Shift {
                state: target,
                extra,
                ..
            }) = actions.last()
            {
                return if extra { state } else { target };
            }
            return 0;
        }
        self.lookup(state, symbol)
    }

    pub fn lex_state(&self, state: StateId) -> u16 {
        self.b.lex_states.get(state as usize).copied().unwrap_or(0)
    }

    pub fn external_lex_state(&self, state: StateId) -> u16 {
        self.b
            .external_lex_states
            .get(state as usize)
            .copied()
            .unwrap_or(0)
    }

    pub fn reserved_word_set_id(&self, state: StateId) -> u16 {
        self.b
            .reserved_word_set_ids
            .get(state as usize)
            .copied()
            .unwrap_or(0)
    }

    /// `ts_language_is_reserved_word`.
    pub fn is_reserved_word(&self, state: StateId, symbol: Symbol) -> bool {
        let set_id = self.reserved_word_set_id(state) as usize;
        if set_id > 0 {
            let size = self.b.max_reserved_word_set_size;
            let start = set_id * size;
            for i in start..start + size {
                match self.b.reserved_words.get(i) {
                    Some(&w) if w == symbol => return true,
                    Some(&0) | None => break,
                    Some(_) => {}
                }
            }
        }
        false
    }

    /// `ts_language_symbol_metadata`: bit 0 visible, bit 1 named.
    pub fn visible(&self, symbol: Symbol) -> bool {
        match symbol {
            TS_BUILTIN_SYM_ERROR => true,
            TS_BUILTIN_SYM_ERROR_REPEAT => false,
            _ => self
                .b
                .symbol_metadata
                .get(symbol as usize)
                .is_some_and(|m| m & 1 != 0),
        }
    }

    pub fn named(&self, symbol: Symbol) -> bool {
        match symbol {
            TS_BUILTIN_SYM_ERROR => true,
            TS_BUILTIN_SYM_ERROR_REPEAT => false,
            _ => self
                .b
                .symbol_metadata
                .get(symbol as usize)
                .is_some_and(|m| m & 2 != 0),
        }
    }

    pub fn symbol_name(&self, symbol: Symbol) -> &str {
        if symbol == TS_BUILTIN_SYM_ERROR {
            return "ERROR";
        }
        self.b
            .symbol_names
            .get(symbol as usize)
            .map_or("", String::as_str)
    }

    /// `ts_language_alias_at`.
    pub fn alias_at(&self, production_id: u16, child_index: usize) -> Symbol {
        if production_id == 0 {
            return 0;
        }
        self.b
            .alias_sequences
            .get(production_id as usize * self.b.max_alias_sequence_length + child_index)
            .copied()
            .unwrap_or(0)
    }

    pub fn has_alias_sequence(&self, production_id: u16) -> bool {
        production_id != 0
    }

    /// `ts_language_field_map`, resolved to the field's name.
    pub fn field_name_for(
        &self,
        production_id: u16,
        structural_child_index: usize,
    ) -> Option<&str> {
        if self.b.field_count == 0 {
            return None;
        }
        let slices = &self.b.field_map_slices;
        let index = *slices.get(2 * production_id as usize)? as usize;
        let length = *slices.get(2 * production_id as usize + 1)? as usize;
        let e = &self.b.field_map_entries;
        for i in index..index + length {
            // [fieldId, childIndex, inherited]
            let (Some(&field_id), Some(&child_index), Some(&inherited)) =
                (e.get(3 * i), e.get(3 * i + 1), e.get(3 * i + 2))
            else {
                return None;
            };
            if inherited == 0 && child_index as usize == structural_child_index {
                return self.b.field_names.get(field_id as usize)?.as_deref();
            }
        }
        None
    }
}
