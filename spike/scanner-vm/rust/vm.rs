//! Scanner VM, Rust side.  Deliberately a transcription of `vm.js` rather than
//! idiomatic Rust: the two must agree instruction for instruction, and the
//! cheapest way to keep them agreeing is for the diff between them to be
//! readable.
//!
//! Every value is a wrapping i32.  Every trap halts the scan as `false`.
//! Nothing here panics, indexes out of bounds, or overflows in debug builds --
//! that is the whole point, since a Rust panic where JS returns a value is
//! exactly the silent, input-dependent divergence this project keeps hitting.

pub const NREG: usize = 32;
pub const NSTACK: usize = 4;
pub const STACK_MAX: usize = 256;
pub const BUF_MAX: usize = 32;
pub const CALL_MAX: usize = 32;
pub const RECURSE_MAX: u32 = 4;
pub const SPIN_BUDGET: u32 = 4096;

pub trait Lexer {
    fn lookahead(&self) -> i32;
    fn advance(&mut self, skip: bool);
    fn mark_end(&mut self);
    fn at_eof(&self) -> bool;
    /// ts_lexer__is_at_included_range_start; only javascript asks.
    fn at_range_start(&self) -> bool;
}

pub struct StackSpec {
    pub persist: bool,
}

pub struct Program {
    pub entry: u16,
    pub reg_persist: u32,
    pub stacks: Vec<StackSpec>,
    pub stack_init: Vec<(usize, Vec<i32>)>,
    pub classes: Vec<Vec<u32>>,
    /// Case-mapping tables: inclusive runs of constant delta as
    /// `[lo, hi, delta, ...]`, identity outside them.
    pub maps: Vec<Vec<i32>>,
    pub strings: Vec<Vec<u8>>,
    pub valid_sets: Vec<Vec<bool>>,
    pub jump_table: Vec<u16>,
    pub code: Vec<u8>,
}

pub struct ScannerVm<'p> {
    p: &'p Program,
    pub reg: [i32; NREG],
    pub stacks: Vec<Vec<i32>>,
    buf: [u8; BUF_MAX],
    buflen: usize,
    call_stack: Vec<usize>,
    depth: u32,
    symbol: i32,
}

enum Halt {
    Done(bool),
}

type R<T> = Result<T, Halt>;

impl<'p> ScannerVm<'p> {
    pub fn new(p: &'p Program) -> Self {
        let mut vm = ScannerVm {
            p,
            reg: [0; NREG],
            stacks: (0..NSTACK).map(|_| Vec::new()).collect(),
            buf: [0; BUF_MAX],
            buflen: 0,
            call_stack: Vec::new(),
            depth: 0,
            symbol: -1,
        };
        vm.reset();
        vm
    }

    pub fn reset(&mut self) {
        self.reg = [0; NREG];
        for s in self.stacks.iter_mut() {
            s.clear();
        }
        for (idx, values) in &self.p.stack_init {
            if let Some(s) = self.stacks.get_mut(*idx) {
                for v in values {
                    s.push(*v);
                }
            }
        }
        self.buflen = 0;
    }

    fn enter_scan(&mut self) {
        for i in 0..NREG {
            if (self.p.reg_persist >> i) & 1 == 0 {
                self.reg[i] = 0;
            }
        }
        for i in 0..NSTACK {
            let persist = self.p.stacks.get(i).map(|s| s.persist).unwrap_or(false);
            if !persist {
                self.stacks[i].clear();
            }
        }
        self.buflen = 0;
        self.call_stack.clear();
    }

    // ---- serialize / deserialize ------------------------------------------
    // VM-defined and canonical, so no per-scanner code can get it wrong.  Order
    // is fixed: persistent registers by index, then persistent stacks by index.
    // Over-long state drops elements from the *top* of the deepest stack, which
    // is what python's and yaml's own truncation does.
    //
    // Transcribed from `harness/ts_scanner_vm.mjs` line for line, including the
    // out-of-range read: JS's `bytes[pos++]` past the end yields `undefined`,
    // and `undefined & 0x7f` is 0, so the LEB loop terminates with the position
    // still advanced.  `byte_at` reproduces that rather than clamping, because
    // a truncated state must decode to the same thing in both runtimes.
    pub fn serialize(&self, limit: usize) -> Vec<u8> {
        let mut head = Vec::new();
        for i in 0..NREG {
            if (self.p.reg_persist >> i) & 1 == 1 {
                write_sleb(&mut head, self.reg[i]);
            }
        }
        let mut bodies: Vec<Vec<i32>> = Vec::new();
        for i in 0..NSTACK {
            if self.p.stacks.get(i).map(|s| s.persist).unwrap_or(false) {
                bodies.push(self.stacks[i].clone());
            }
        }
        loop {
            let mut buf = head.clone();
            for values in &bodies {
                write_uleb(&mut buf, values.len() as u32);
                for v in values {
                    write_sleb(&mut buf, *v);
                }
            }
            if buf.len() <= limit {
                return buf;
            }
            let mut deepest: Option<usize> = None;
            for i in 0..bodies.len() {
                let floor = deepest.map(|d| bodies[d].len()).unwrap_or(0);
                if bodies[i].len() > floor {
                    deepest = Some(i);
                }
            }
            match deepest {
                Some(d) if !bodies[d].is_empty() => {
                    bodies[d].pop();
                }
                _ => {
                    buf.truncate(limit);
                    return buf;
                }
            }
        }
    }

    pub fn deserialize(&mut self, bytes: &[u8]) {
        self.reset();
        if bytes.is_empty() {
            return;
        }
        let mut pos = 0usize;
        for i in 0..NREG {
            if (self.p.reg_persist >> i) & 1 == 1 {
                if pos >= bytes.len() {
                    return;
                }
                self.reg[i] = read_sleb(bytes, &mut pos);
            }
        }
        for i in 0..NSTACK {
            if !self.p.stacks.get(i).map(|s| s.persist).unwrap_or(false) {
                continue;
            }
            if pos >= bytes.len() {
                return;
            }
            let n = read_uleb(bytes, &mut pos);
            self.stacks[i].clear();
            let mut k = 0u32;
            while k < n && pos < bytes.len() {
                let v = read_sleb(bytes, &mut pos);
                self.stacks[i].push(v);
                k += 1;
            }
        }
    }

    /// Returns (emitted, result_symbol).
    pub fn scan(&mut self, lx: &mut dyn Lexer, valid: &[bool]) -> (bool, i32) {
        self.enter_scan();
        self.symbol = -1;
        self.depth = 0;
        let entry = self.p.entry as usize;
        match self.run(entry, valid, lx) {
            Err(Halt::Done(ok)) => (ok, if ok { self.symbol } else { -1 }),
            Ok(()) => (false, -1),
        }
    }

    fn trap<T>(&mut self) -> R<T> {
        self.symbol = -1;
        Err(Halt::Done(false))
    }

    fn get_reg(&mut self, i: u8) -> R<i32> {
        if (i as usize) < NREG {
            Ok(self.reg[i as usize])
        } else {
            self.trap()
        }
    }
    fn set_reg(&mut self, i: u8, v: i32) -> R<()> {
        if (i as usize) < NREG {
            self.reg[i as usize] = v;
            Ok(())
        } else {
            self.trap()
        }
    }

    /// Triples are sorted, inclusive and non-overlapping.  Anything not in a
    /// run maps to itself, which is what keeps glibc's 1,477 moved code points
    /// down to 690 entries.
    fn mapped(&mut self, k: u32, cp: i32) -> R<i32> {
        let m = match self.p.maps.get(k as usize) {
            Some(m) => m,
            None => return self.trap(),
        };
        let (mut lo, mut hi) = (0isize, (m.len() / 3) as isize - 1);
        while lo <= hi {
            let mid = ((lo + hi) / 2) as usize;
            if cp < m[mid * 3] {
                hi = mid as isize - 1;
            } else if cp > m[mid * 3 + 1] {
                lo = mid as isize + 1;
            } else {
                return Ok(cp.wrapping_add(m[mid * 3 + 2]));
            }
        }
        Ok(cp)
    }

    fn in_class(&mut self, k: u32, cp: i32) -> R<bool> {
        let r = match self.p.classes.get(k as usize) {
            Some(r) => r,
            None => return self.trap(),
        };
        if cp < 0 {
            return Ok(false);
        }
        let cp = cp as u32;
        let n = r.len() / 2;
        let (mut lo, mut hi) = (0i64, n as i64 - 1);
        while lo <= hi {
            let mid = ((lo + hi) / 2) as usize;
            if cp < r[mid * 2] {
                hi = mid as i64 - 1;
            } else if cp > r[mid * 2 + 1] {
                lo = mid as i64 + 1;
            } else {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn run(&mut self, mut pc: usize, valid: &[bool], lx: &mut dyn Lexer) -> R<()> {
        let base = self.call_stack.len();
        let mut spin: u32 = 0;
        loop {
            let code = &self.p.code;
            if pc >= code.len() {
                return self.trap();
            }
            spin += 1;
            if spin > SPIN_BUDGET {
                return self.trap();
            }
            let op = code[pc];
            pc += 1;
            match op {
                0x00 => {}

                0x01 => { lx.advance(false); spin = 0; }
                0x02 => { lx.advance(true); spin = 0; }
                0x03 => lx.mark_end(),
                0x04 => { let r = self.byte(&mut pc)?; let v = lx.lookahead(); self.set_reg(r, v)?; }
                0x05 => { let r = self.byte(&mut pc)?; let v = i32::from(lx.at_eof()); self.set_reg(r, v)?; }
                // MAP: case mapping is a host property in exactly the way
                // classification is -- html stores towupper(lookahead) in every
                // tag name it compares.
                0x07 => {
                    let k = self.uleb(&mut pc)?;
                    let (d, sr) = (self.byte(&mut pc)?, self.byte(&mut pc)?);
                    let v = self.get_reg(sr)?;
                    let m = self.mapped(k, v)?;
                    self.set_reg(d, m)?;
                }

                0x08 => { let s = self.uleb(&mut pc)?; self.symbol = s as i32; return Err(Halt::Done(true)); }
                0x09 => { let r = self.byte(&mut pc)?; self.symbol = self.get_reg(r)?; return Err(Halt::Done(true)); }
                0x0a => return Err(Halt::Done(false)),
                0x0b => {
                    let r = self.byte(&mut pc)?;
                    let s = self.uleb(&mut pc)?;
                    self.symbol = s as i32;
                    return Err(Halt::Done(self.get_reg(r)? != 0));
                }
                0x0c => {
                    let r = self.byte(&mut pc)?;
                    let rs = self.byte(&mut pc)?;
                    self.symbol = self.get_reg(rs)?;
                    return Err(Halt::Done(self.get_reg(r)? != 0));
                }

                0x10 | 0x11 => {
                    let c = self.uleb(&mut pc)?;
                    let t = self.target(&mut pc)?;
                    let hit = lx.lookahead() == c as i32;
                    if hit == (op == 0x10) { pc = t; }
                }
                0x12 | 0x13 => {
                    let c = self.uleb(&mut pc)?;
                    let t = self.target(&mut pc)?;
                    let hit = self.in_class(c, lx.lookahead())?;
                    if hit == (op == 0x12) { pc = t; }
                }
                0x14 | 0x15 => {
                    let t = self.target(&mut pc)?;
                    if lx.at_eof() == (op == 0x14) { pc = t; }
                }
                0x16 => {
                    let t = self.target(&mut pc)?;
                    if lx.at_range_start() { pc = t; }
                }
                0x18 | 0x19 => {
                    let c = self.uleb(&mut pc)? as usize;
                    let t = self.target(&mut pc)?;
                    let v = *valid.get(c).unwrap_or(&false);
                    if v == (op == 0x18) { pc = t; }
                }
                0x1a | 0x1b => {
                    let r = self.byte(&mut pc)?;
                    let t = self.target(&mut pc)?;
                    let i = self.get_reg(r)?;
                    if i < 0 || i as usize >= valid.len() {
                        return self.trap();
                    }
                    if valid[i as usize] == (op == 0x1a) { pc = t; }
                }

                0x20 => { let r = self.byte(&mut pc)?; let v = self.sleb(&mut pc)?; self.set_reg(r, v)?; }
                0x21 => { let d = self.byte(&mut pc)?; let s = self.byte(&mut pc)?; let v = self.get_reg(s)?; self.set_reg(d, v)?; }
                0x22 => {
                    let o = self.byte(&mut pc)?;
                    let d = self.byte(&mut pc)?;
                    let s = self.byte(&mut pc)?;
                    let (a, b) = (self.get_reg(d)?, self.get_reg(s)?);
                    let v = self.alu(o, a, b)?;
                    self.set_reg(d, v)?;
                }
                0x23 => {
                    let o = self.byte(&mut pc)?;
                    let d = self.byte(&mut pc)?;
                    let b = self.sleb(&mut pc)?;
                    let a = self.get_reg(d)?;
                    let v = self.alu(o, a, b)?;
                    self.set_reg(d, v)?;
                }

                0x28 => {
                    let o = self.byte(&mut pc)?;
                    let ra = self.byte(&mut pc)?;
                    let rb = self.byte(&mut pc)?;
                    let t = self.target(&mut pc)?;
                    let (a, b) = (self.get_reg(ra)?, self.get_reg(rb)?);
                    if self.cmp(o, a, b)? { pc = t; }
                }
                0x29 => {
                    let o = self.byte(&mut pc)?;
                    let ra = self.byte(&mut pc)?;
                    let b = self.sleb(&mut pc)?;
                    let t = self.target(&mut pc)?;
                    let a = self.get_reg(ra)?;
                    if self.cmp(o, a, b)? { pc = t; }
                }

                0x30 => {
                    let k = self.byte(&mut pc)? as usize;
                    let r = self.byte(&mut pc)?;
                    let v = self.get_reg(r)?;
                    if k >= NSTACK || self.stacks[k].len() >= STACK_MAX { return self.trap(); }
                    self.stacks[k].push(v);
                }
                0x31 => {
                    let k = self.byte(&mut pc)? as usize;
                    let r = self.byte(&mut pc)?;
                    if k >= NSTACK { return self.trap(); }
                    match self.stacks[k].pop() {
                        Some(v) => self.set_reg(r, v)?,
                        None => return self.trap(),
                    }
                }
                0x32 => {
                    let k = self.byte(&mut pc)? as usize;
                    let r = self.byte(&mut pc)?;
                    let off = self.uleb(&mut pc)? as usize;
                    if k >= NSTACK { return self.trap(); }
                    let len = self.stacks[k].len();
                    if off + 1 > len { return self.trap(); }
                    let v = self.stacks[k][len - 1 - off];
                    self.set_reg(r, v)?;
                }
                0x33 => {
                    let k = self.byte(&mut pc)? as usize;
                    let r = self.byte(&mut pc)?;
                    let v = self.get_reg(r)?;
                    if k >= NSTACK || self.stacks[k].is_empty() { return self.trap(); }
                    let n = self.stacks[k].len();
                    self.stacks[k][n - 1] = v;
                }
                0x34 => {
                    let k = self.byte(&mut pc)? as usize;
                    let r = self.byte(&mut pc)?;
                    if k >= NSTACK { return self.trap(); }
                    let n = self.stacks[k].len() as i32;
                    self.set_reg(r, n)?;
                }
                0x35 => {
                    let k = self.byte(&mut pc)? as usize;
                    if k >= NSTACK { return self.trap(); }
                    self.stacks[k].clear();
                }
                0x36 => {
                    let k = self.byte(&mut pc)? as usize;
                    let r = self.byte(&mut pc)?;
                    let ri = self.byte(&mut pc)?;
                    let i = self.get_reg(ri)?;
                    if k >= NSTACK { return self.trap(); }
                    if i < 0 || i as usize >= self.stacks[k].len() { return self.trap(); }
                    let v = self.stacks[k][i as usize];
                    self.set_reg(r, v)?;
                }

                0x38 => self.buflen = 0,
                0x39 => {
                    let r = self.byte(&mut pc)?;
                    let v = self.get_reg(r)?;
                    if self.buflen >= BUF_MAX { return self.trap(); }
                    self.buf[self.buflen] = (v & 0xff) as u8;
                    self.buflen += 1;
                }
                0x3a => { let r = self.byte(&mut pc)?; let n = self.buflen as i32; self.set_reg(r, n)?; }
                0x3b => {
                    let c = self.uleb(&mut pc)? as usize;
                    let t = self.target(&mut pc)?;
                    let s = match self.p.strings.get(c) {
                        Some(s) => s,
                        None => return self.trap(),
                    };
                    if s.len() == self.buflen && s[..] == self.buf[..self.buflen] { pc = t; }
                }

                0x40 => { pc = self.target(&mut pc)?; }
                0x41 => {
                    let t = self.target(&mut pc)?;
                    if self.call_stack.len() >= CALL_MAX { return self.trap(); }
                    self.call_stack.push(pc);
                    pc = t;
                }
                0x42 => {
                    if self.call_stack.len() <= base { return self.trap(); }
                    pc = self.call_stack.pop().unwrap_or(usize::MAX);
                }
                0x43 => {
                    let r = self.byte(&mut pc)?;
                    let i = self.get_reg(r)?;
                    if i < 0 || i as usize >= self.p.jump_table.len() { return self.trap(); }
                    if self.call_stack.len() >= CALL_MAX { return self.trap(); }
                    self.call_stack.push(pc);
                    pc = self.p.jump_table[i as usize] as usize;
                }
                0x44 => {
                    let c = self.uleb(&mut pc)? as usize;
                    let r = self.byte(&mut pc)?;
                    if c >= self.p.valid_sets.len() || self.depth >= RECURSE_MAX {
                        return self.trap();
                    }
                    self.depth += 1;
                    let saved = self.symbol;
                    let entry = self.p.entry as usize;
                    let vs: Vec<bool> = self.p.valid_sets[c].clone();
                    let inner = match self.run(entry, &vs, lx) {
                        Err(Halt::Done(ok)) => ok,
                        Ok(()) => false,
                    };
                    self.depth -= 1;
                    self.symbol = saved;
                    self.set_reg(r, i32::from(inner))?;
                }

                _ => return self.trap(),
            }
        }
    }

    // Shift counts are masked to 5 bits so `1 << 32` is a no-op rather than a
    // panic; JS masks silently and Rust does not, and that difference is
    // exactly the class of bug this VM exists to remove.  There is no logical
    // right shift and no division: no scanner needs either.
    fn alu(&mut self, o: u8, a: i32, b: i32) -> R<i32> {
        Ok(match o {
            0 => a.wrapping_add(b),
            1 => a.wrapping_sub(b),
            2 => a & b,
            3 => a | b,
            4 => a ^ b,
            5 => a.wrapping_shl((b & 31) as u32),
            6 => a.wrapping_shr((b & 31) as u32),
            7 => {
                if b <= 0 { return self.trap(); }
                a.wrapping_rem(b)
            }
            _ => return self.trap(),
        })
    }

    fn cmp(&mut self, o: u8, a: i32, b: i32) -> R<bool> {
        Ok(match o {
            0 => a == b,
            1 => a != b,
            2 => a < b,
            3 => a <= b,
            4 => a > b,
            5 => a >= b,
            _ => return self.trap(),
        })
    }

    fn byte(&mut self, pc: &mut usize) -> R<u8> {
        match self.p.code.get(*pc) {
            Some(b) => { *pc += 1; Ok(*b) }
            None => self.trap(),
        }
    }
    fn target(&mut self, pc: &mut usize) -> R<usize> {
        let lo = self.byte(pc)? as usize;
        let hi = self.byte(pc)? as usize;
        Ok(lo | (hi << 8))
    }
    fn uleb(&mut self, pc: &mut usize) -> R<u32> {
        let (mut v, mut s) = (0u32, 0u32);
        loop {
            let b = self.byte(pc)?;
            if s < 32 { v |= ((b & 0x7f) as u32) << s; }
            s += 7;
            if b & 0x80 == 0 { return Ok(v); }
            if s > 35 { return self.trap(); }
        }
    }
    fn sleb(&mut self, pc: &mut usize) -> R<i32> {
        let (mut v, mut s) = (0i32, 0u32);
        loop {
            let b = self.byte(pc)?;
            if s < 32 { v |= ((b & 0x7f) as i32).wrapping_shl(s); }
            s += 7;
            if b & 0x80 == 0 {
                if s < 32 && b & 0x40 != 0 { v |= (-1i32).wrapping_shl(s); }
                return Ok(v);
            }
            if s > 35 { return self.trap(); }
        }
    }
}

// LEB128, the same four helpers `harness/ts_scanner_vm.mjs` carries.
fn write_uleb(out: &mut Vec<u8>, v: u32) {
    let mut x = v;
    loop {
        let mut b = (x & 0x7f) as u8;
        x >>= 7;
        if x != 0 {
            b |= 0x80;
        }
        out.push(b);
        if x == 0 {
            return;
        }
    }
}

fn write_sleb(out: &mut Vec<u8>, v: i32) {
    let mut x = v;
    loop {
        let b = (x & 0x7f) as u8;
        x >>= 7;
        if (x == 0 && b & 0x40 == 0) || (x == -1 && b & 0x40 != 0) {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

/// Out of range reads as 0 and still advances, matching JS's `undefined & 0x7f`.
fn byte_at(b: &[u8], pos: &mut usize) -> u8 {
    let v = b.get(*pos).copied().unwrap_or(0);
    *pos += 1;
    v
}

fn read_uleb(b: &[u8], pos: &mut usize) -> u32 {
    let (mut v, mut s) = (0u32, 0u32);
    loop {
        let byte = byte_at(b, pos);
        v |= ((byte & 0x7f) as u32).wrapping_shl(s);
        s += 7;
        if byte & 0x80 == 0 {
            return v;
        }
    }
}

fn read_sleb(b: &[u8], pos: &mut usize) -> i32 {
    let (mut v, mut s) = (0i32, 0u32);
    loop {
        let byte = byte_at(b, pos);
        v |= ((byte & 0x7f) as i32).wrapping_shl(s);
        s += 7;
        if byte & 0x80 == 0 {
            if s < 32 && byte & 0x40 != 0 {
                v |= (-1i32).wrapping_shl(s);
            }
            return v;
        }
    }
}
