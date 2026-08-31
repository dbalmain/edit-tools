//! The lexer -- `lib/src/lexer.c`, specialised to a single default included
//! range over a whole-buffer input, which is what `ts_parser_parse_string`
//! gives it.
//!
//! The recovered `ts_lex` DFA is interpreted here rather than compiled, so this
//! is the half of the port where the blob's op encoding is actually given
//! meaning. It is also the half the corpus covers least -- the frozen files
//! exercise 50% of the JSON blob's `lex` table and 23% of Go's -- so the tests
//! at the bottom carry more weight than usual.

use super::blob::{LexOp, LexState, Symbol};
use super::Unsupported;

const TS_DECODE_ERROR: i32 = -1;
const BYTE_ORDER_MARK: i32 = 0xfeff;

pub struct Lexer<'a> {
    buf: &'a [u8],
    len: usize,
    pub pos: usize,
    chunk_start: usize,
    chunk_size: usize,
    has_chunk: bool,
    at_eof: bool,
    lookahead: i32,
    lookahead_size: usize,
    pub token_start: usize,
    /// `None` is the JS's `tokenEnd = -1` sentinel: no end marked yet.
    pub token_end: Option<usize>,
    pub result_symbol: Symbol,
}

impl<'a> Lexer<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Lexer {
            buf,
            len: buf.len(),
            pos: 0,
            chunk_start: 0,
            chunk_size: 0,
            has_chunk: false,
            at_eof: false,
            lookahead: 0,
            lookahead_size: 0,
            token_start: 0,
            token_end: None,
            result_symbol: 0,
        }
    }

    /// The end of the accepted token. Only meaningful after `finish`, which
    /// guarantees one has been marked.
    pub fn token_end_or_pos(&self) -> usize {
        self.token_end.unwrap_or(self.pos)
    }

    /// `ts_lexer__get_chunk`: the input callback returns 0 bytes at or past the
    /// end, and that -- not a position comparison -- is what sets EOF.
    fn get_chunk(&mut self) {
        self.chunk_start = self.pos;
        self.chunk_size = self.len.saturating_sub(self.pos);
        if self.chunk_size == 0 {
            self.at_eof = true;
            self.has_chunk = false;
        } else {
            self.has_chunk = true;
        }
    }

    fn get_lookahead(&mut self) {
        let position_in_chunk = self.pos - self.chunk_start;
        let size = self.chunk_size - position_in_chunk;
        if size == 0 {
            self.lookahead_size = 1;
            self.lookahead = 0;
            return;
        }
        let (cp, width) = decode_utf8(self.buf, self.pos);
        self.lookahead = cp;
        self.lookahead_size = width;
    }

    /// `ts_lexer_goto`, specialised to the single default range: it always
    /// finds range 0, so it always clears EOF and invalidates the chunk.
    fn goto_pos(&mut self, position: usize) {
        self.pos = position;
        self.at_eof = false;
        if self.has_chunk
            && (self.pos < self.chunk_start || self.pos >= self.chunk_start + self.chunk_size)
        {
            self.has_chunk = false;
            self.chunk_size = 0;
            self.chunk_start = 0;
        }
        self.lookahead_size = 0;
        self.lookahead = 0;
    }

    pub fn reset(&mut self, position: usize) {
        if position != self.pos {
            self.goto_pos(position);
        }
    }

    pub fn start(&mut self) {
        self.token_start = self.pos;
        self.token_end = None;
        self.result_symbol = 0;
        if !self.at_eof {
            if self.chunk_size == 0 {
                self.get_chunk();
            }
            if self.lookahead_size == 0 {
                self.get_lookahead();
            }
            if self.pos == 0 && self.lookahead == BYTE_ORDER_MARK {
                self.advance(true);
            }
        }
    }

    pub fn finish(&mut self) {
        if self.token_end.is_none() {
            self.mark_end();
        }
        if let Some(end) = self.token_end {
            if end < self.token_start {
                self.token_start = end;
            }
        }
    }

    /// `ts_lexer__mark_end`, specialised: with one included range the boundary
    /// special case cannot fire.
    fn mark_end(&mut self) {
        self.token_end = Some(self.pos);
    }

    fn advance(&mut self, skip: bool) {
        if !self.has_chunk {
            return;
        }
        if self.lookahead_size != 0 {
            self.pos += self.lookahead_size;
        }
        // The included-range walk in ts_lexer__do_advance cannot fire here: the
        // default range's end_byte is UINT32_MAX.
        if skip {
            self.token_start = self.pos;
        }
        if self.pos < self.chunk_start || self.pos >= self.chunk_start + self.chunk_size {
            self.get_chunk();
        }
        self.get_lookahead();
    }

    /// `START_LEXER()`'s loop, driven by the recovered DFA rather than by C
    /// control flow. Returns whether a token was accepted; the symbol is in
    /// `result_symbol`.
    pub fn run(&mut self, states: &[LexState], start_state: u16) -> Result<bool, Unsupported> {
        let mut state = start_state as usize;
        let mut result = false;
        let mut skip = false;
        let mut first = true;
        loop {
            if !first {
                self.advance(skip);
            }
            first = false;
            skip = false;
            let lookahead = self.lookahead;
            let eof = self.at_eof;
            // `default: return false;`
            let Some(st) = states.get(state) else {
                return Ok(false);
            };
            let mut advanced = false;
            for op in &st.ops {
                let (act, target) = match op {
                    LexOp::AcceptToken(sym) => {
                        result = true;
                        self.result_symbol = *sym;
                        self.mark_end();
                        continue;
                    }
                    LexOp::AdvanceMap(map) => {
                        let hit = map
                            .chunks_exact(2)
                            .find(|pair| pair[0] == lookahead)
                            .map(|pair| pair[1]);
                        match hit {
                            Some(t) => {
                                state = t as usize;
                                advanced = true;
                                break;
                            }
                            None => continue,
                        }
                    }
                    LexOp::Guard {
                        eof_mode,
                        ranges,
                        act,
                        target,
                    } => {
                        if *eof_mode == 1 && !eof {
                            continue;
                        }
                        if *eof_mode == 2 && eof {
                            continue;
                        }
                        // Always test the set. An empty set means the guard is
                        // false, not that there is no guard -- a predicate
                        // false in both eof modes (`lookahead < 0 && lookahead
                        // >= 0`) collapses to one, and short-circuiting on
                        // length would invert it. A genuinely unconditional
                        // action is `Unconditional`, and the full domain has an
                        // explicit non-empty representation.
                        if !in_ranges(ranges, lookahead) {
                            continue;
                        }
                        (*act, *target)
                    }
                    LexOp::Unconditional { act, target } => (*act, *target),
                    LexOp::GuardEofSplit {
                        ranges,
                        eof_ranges,
                        act,
                        target,
                    } => {
                        // A guard whose truth differs at EOF: one interval set
                        // for each.
                        let set = if eof { eof_ranges } else { ranges };
                        if !in_ranges(set, lookahead) {
                            continue;
                        }
                        (*act, *target)
                    }
                    LexOp::Unknown(kind) => {
                        return Err(Unsupported(format!("lex op kind {kind}")));
                    }
                };
                match act {
                    0 => {
                        state = target as usize;
                        advanced = true;
                    }
                    1 => {
                        state = target as usize;
                        skip = true;
                        advanced = true;
                    }
                    // END_STATE()
                    2 => return Ok(result),
                    3 => {
                        result = true;
                        self.result_symbol = target;
                        self.mark_end();
                        continue;
                    }
                    other => return Err(Unsupported(format!("lex action {other}"))),
                }
                break;
            }
            if !advanced {
                // fell through to END_STATE()
                return Ok(result);
            }
        }
    }
}

/// Membership in a sorted, disjoint, flat list of inclusive intervals.
fn in_ranges(ranges: &[i32], value: i32) -> bool {
    for pair in ranges.chunks_exact(2) {
        if value < pair[0] {
            // ranges are sorted and disjoint
            return false;
        }
        if value <= pair[1] {
            return true;
        }
    }
    false
}

/// `ts_decode_utf8`, returning the code point and its width. Invalid input
/// yields `TS_DECODE_ERROR` with a width of 1, which is what `lexer.c` forces.
///
/// The JS guards the continuation bytes with an arithmetic pre-check *and* then
/// reads past the end anyway, where `undefined & 0xc0` is 0 and fails the
/// continuation test. Both paths reach the same error, so bounds-checked reads
/// below express the same function without the redundant guard.
fn decode_utf8(buf: &[u8], pos: usize) -> (i32, usize) {
    let Some(&b0) = buf.get(pos) else {
        return (TS_DECODE_ERROR, 1);
    };
    if b0 < 0x80 {
        return (i32::from(b0), 1);
    }
    let (need, mut cp, lo) = match b0 {
        0xc2..=0xdf => (1, u32::from(b0 & 0x1f), 0x80),
        0xe0..=0xef => (2, u32::from(b0 & 0x0f), 0x800),
        0xf0..=0xf4 => (3, u32::from(b0 & 0x07), 0x10000),
        _ => return (TS_DECODE_ERROR, 1),
    };
    for i in 1..=need {
        let Some(&b) = buf.get(pos + i) else {
            return (TS_DECODE_ERROR, 1);
        };
        if b & 0xc0 != 0x80 {
            return (TS_DECODE_ERROR, 1);
        }
        cp = (cp << 6) | u32::from(b & 0x3f);
    }
    if cp < lo || cp > 0x10ffff || (0xd800..=0xdfff).contains(&cp) {
        return (TS_DECODE_ERROR, 1);
    }
    (cp as i32, need + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INT32_MIN: i32 = i32::MIN;
    const INT32_MAX: i32 = i32::MAX;
    const ALL: [i32; 2] = [INT32_MIN, INT32_MAX];

    fn state(ops: Vec<LexOp>) -> LexState {
        LexState { ops }
    }

    fn accept(sym: Symbol) -> LexState {
        state(vec![LexOp::AcceptToken(sym)])
    }

    fn guard(eof_mode: u8, ranges: &[i32], act: u8, target: u16) -> LexOp {
        LexOp::Guard {
            eof_mode,
            ranges: ranges.to_vec(),
            act,
            target,
        }
    }

    fn run<'a>(states: &[LexState], bytes: &'a [u8]) -> (bool, Lexer<'a>) {
        let mut lexer = Lexer::new(bytes);
        lexer.start();
        let found = lexer.run(states, 0).expect("supported ops");
        (found, lexer)
    }

    // The five tests below are the Rust twins of `harness/ts_lr.test.mjs`.
    // Keeping them paired is the point: they are the cases the frozen corpus
    // cannot reach, so if the two runtimes are going to disagree in the lexer,
    // they disagree here first.

    #[test]
    fn empty_interval_set_is_a_false_guard_not_an_absent_one() {
        // `lookahead < 0 && lookahead >= 0` -- unsatisfiable, so the transcoder
        // collapses it to an empty set. Short-circuiting on "is the set empty"
        // would take the branch unconditionally and invert the predicate.
        let states = [state(vec![guard(0, &[], 0, 1)]), accept(1)];
        let (found, _) = run(&states, b"a");
        assert!(!found, "a guard that is false everywhere must not fire");
    }

    #[test]
    fn full_interval_set_does_fire() {
        let states = [state(vec![guard(0, &ALL, 0, 1)]), accept(1)];
        let (found, lexer) = run(&states, b"a");
        assert!(found);
        assert_eq!(lexer.result_symbol, 1);
    }

    #[test]
    fn eof_split_guard_distinguishes_a_nul_byte_from_end_of_input() {
        // What tree-sitter-python 0.25.0 emits:
        // `if ((!eof && lookahead == 00) || lookahead == '\n')`.
        // not-eof: {0, '\n'}; at eof: {'\n'}. One interval set cannot say this,
        // which is the whole reason op 4 exists.
        let states = [
            state(vec![LexOp::GuardEofSplit {
                ranges: vec![0, 0, 10, 10],
                eof_ranges: vec![10, 10],
                act: 0,
                target: 1,
            }]),
            accept(1),
        ];
        let (found, _) = run(&states, &[0]);
        assert!(found, "a real NUL byte must take the branch");

        let (found, _) = run(&states, &[]);
        assert!(!found, "EOF must not take the branch");
    }

    #[test]
    fn the_decode_error_value_is_inside_the_complement_of_zero() {
        // `lookahead != 0`, as the transcoder emits it: two intervals
        // straddling 0. Complementing over [0, 0x10FFFF] instead of over int32
        // would drop -1 and silently disagree with the C on malformed input.
        let not_zero = [INT32_MIN, -1, 1, INT32_MAX];
        let states = [state(vec![guard(0, &not_zero, 0, 1)]), accept(1)];
        // 0x80 alone is invalid UTF-8, so lookahead becomes -1.
        let (found, _) = run(&states, &[0x80]);
        assert!(found, "invalid UTF-8 must satisfy != 0");
    }

    #[test]
    fn accept_token_marks_the_end_and_a_later_failed_advance_keeps_it() {
        // state 0: consume 'a' -> state 1. state 1: accept, then consume 'b'.
        let states = [
            state(vec![guard(0, &[97, 97], 0, 1)]),
            state(vec![LexOp::AcceptToken(1), guard(0, &[98, 98], 0, 1)]),
        ];
        let (found, mut lexer) = run(&states, b"abz");
        assert!(found);
        lexer.finish();
        assert_eq!(lexer.token_start, 0);
        assert_eq!(
            lexer.token_end,
            Some(2),
            "longest match ends after 'ab', not at 'z'"
        );
    }

    #[test]
    fn skip_moves_the_token_start_so_leading_trivia_is_padding() {
        let states = [
            state(vec![guard(0, &[32, 32], 1, 0), guard(0, &[97, 97], 0, 1)]),
            accept(1),
        ];
        let (found, mut lexer) = run(&states, b"   a");
        assert!(found);
        lexer.finish();
        assert_eq!(lexer.token_start, 3, "the three spaces are padding");
        assert_eq!(lexer.token_end, Some(4));
    }

    // Cases beyond the JS test file, covering the encoding's other two ops and
    // the decoder, none of which any pinned grammar's corpus reaches.

    #[test]
    fn an_undefined_op_kind_or_action_errors_rather_than_being_skipped() {
        // A silently dropped arm is a lexer that is wrong on exactly the inputs
        // the corpus does not contain, so both runtimes must refuse.
        let states = [state(vec![LexOp::Unknown(9)])];
        let mut lexer = Lexer::new(b"a");
        lexer.start();
        assert!(lexer.run(&states, 0).is_err(), "unknown op kind must error");

        let states = [state(vec![LexOp::Unconditional { act: 7, target: 0 }])];
        let mut lexer = Lexer::new(b"a");
        lexer.start();
        assert!(lexer.run(&states, 0).is_err(), "unknown action must error");
    }

    #[test]
    fn an_unconditional_action_advances_without_consulting_the_lookahead() {
        let states = [
            state(vec![LexOp::Unconditional { act: 0, target: 1 }]),
            accept(3),
        ];
        let (found, lexer) = run(&states, b"\xff");
        assert!(found, "op 3 fires even on a byte no interval set matches");
        assert_eq!(lexer.result_symbol, 3);
    }

    #[test]
    fn a_missing_state_ends_the_run_the_way_the_c_default_arm_does() {
        let states = [state(vec![guard(0, &ALL, 0, 99)])];
        let (found, _) = run(&states, b"a");
        assert!(!found, "advancing to an undefined state returns no token");
    }

    #[test]
    fn utf8_decoding_matches_the_c_including_its_rejections() {
        // Width and code point for the valid cases...
        assert_eq!(decode_utf8("a".as_bytes(), 0), (0x61, 1));
        assert_eq!(decode_utf8("é".as_bytes(), 0), (0xe9, 2));
        assert_eq!(decode_utf8("€".as_bytes(), 0), (0x20ac, 3));
        assert_eq!(decode_utf8("\u{1d11e}".as_bytes(), 0), (0x1d11e, 4));
        // ...and TS_DECODE_ERROR, width 1, for every rejection: a bare
        // continuation byte, an overlong form, a surrogate, a truncated
        // sequence, and a lead byte past the U+10FFFF ceiling.
        for bad in [
            &[0x80u8][..],
            &[0xc0, 0x80][..],
            &[0xc1, 0xbf][..],
            &[0xed, 0xa0, 0x80][..],
            &[0xe2, 0x82][..],
            &[0xf5, 0x80, 0x80, 0x80][..],
            &[0xff][..],
        ] {
            assert_eq!(decode_utf8(bad, 0), (TS_DECODE_ERROR, 1), "{bad:x?}");
        }
    }

    #[test]
    fn a_byte_order_mark_is_skipped_before_the_first_token() {
        let states = [state(vec![guard(0, &[97, 97], 0, 1)]), accept(1)];
        let (found, mut lexer) = run(&states, "\u{feff}a".as_bytes());
        lexer.finish();
        assert!(found, "the BOM must not block the token after it");
        assert_eq!(lexer.token_start, 3, "the BOM's three bytes are padding");
    }
}
