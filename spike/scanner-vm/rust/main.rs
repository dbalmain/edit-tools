//! Replays the same recorded scanner traces the JS side replays, through the
//! Rust VM, against the same `toml.svm` blob.  Same bytes in, same bytes out,
//! or the project's central claim is false.
//!
//!   rustc -O -o replay main.rs && ./replay ../toml.svm <trace-dir> <src-dir>

mod vm;
use std::fs;
use std::path::Path;
use vm::{Lexer, Program, ScannerVm, StackSpec};

// ---- lexer host, transcribed from lexer.js ---------------------------------
struct ByteLexer<'a> {
    b: &'a [u8],
    cur: usize,
    token_start: usize,
    token_end: usize,
    ops: String,
}

impl<'a> ByteLexer<'a> {
    fn new(b: &'a [u8], start: usize) -> Self {
        ByteLexer { b, cur: start, token_start: start, token_end: start, ops: String::new() }
    }
    fn decode(&self) -> (i32, usize) {
        let (b, i) = (self.b, self.cur);
        if i >= b.len() { return (0, 1); }
        let c = b[i];
        if c < 0x80 { return (c as i32, 1); }
        let cont = |k: usize| i + k < b.len() && (b[i + k] & 0xc0) == 0x80;
        if (0xc2..=0xdf).contains(&c) && cont(1) {
            return ((((c & 0x1f) as i32) << 6) | (b[i + 1] & 0x3f) as i32, 2);
        }
        if (0xe0..=0xef).contains(&c) && cont(1) && cont(2) {
            let cp = (((c & 0x0f) as i32) << 12) | (((b[i + 1] & 0x3f) as i32) << 6) | (b[i + 2] & 0x3f) as i32;
            if cp >= 0x800 && !(0xd800..=0xdfff).contains(&cp) { return (cp, 3); }
        }
        if (0xf0..=0xf4).contains(&c) && cont(1) && cont(2) && cont(3) {
            let cp = (((c & 0x07) as i32) << 18)
                | (((b[i + 1] & 0x3f) as i32) << 12)
                | (((b[i + 2] & 0x3f) as i32) << 6)
                | (b[i + 3] & 0x3f) as i32;
            if (0x10000..=0x10ffff).contains(&cp) { return (cp, 4); }
        }
        (-1, 1)
    }
}

impl<'a> Lexer for ByteLexer<'a> {
    fn lookahead(&self) -> i32 { self.decode().0 }
    fn at_eof(&self) -> bool { self.cur >= self.b.len() }
    fn advance(&mut self, skip: bool) {
        self.ops.push(if skip { 'S' } else { 'A' });
        self.ops.push_str(&self.cur.to_string());
        self.ops.push(';');
        self.cur += self.decode().1;
        if skip { self.token_start = self.cur; }
    }
    fn mark_end(&mut self) {
        self.ops.push('M');
        self.ops.push_str(&self.cur.to_string());
        self.ops.push(';');
        self.token_end = self.cur;
    }
}

// ---- package decoder, mirroring pack.js ------------------------------------
struct Rd<'a> { b: &'a [u8], p: usize }
impl<'a> Rd<'a> {
    fn u8(&mut self) -> u8 { let v = self.b[self.p]; self.p += 1; v }
    fn u16(&mut self) -> u16 { let v = self.b[self.p] as u16 | (self.b[self.p + 1] as u16) << 8; self.p += 2; v }
    fn u32(&mut self) -> u32 {
        let v = self.b[self.p] as u32 | (self.b[self.p + 1] as u32) << 8
            | (self.b[self.p + 2] as u32) << 16 | (self.b[self.p + 3] as u32) << 24;
        self.p += 4; v
    }
    fn uleb(&mut self) -> u32 {
        let (mut v, mut s) = (0u32, 0u32);
        loop { let b = self.u8(); v |= ((b & 0x7f) as u32) << s; s += 7; if b & 0x80 == 0 { return v; } }
    }
    fn sleb(&mut self) -> i32 {
        let (mut v, mut s) = (0i32, 0u32);
        loop {
            let b = self.u8();
            v |= ((b & 0x7f) as i32).wrapping_shl(s);
            s += 7;
            if b & 0x80 == 0 {
                if s < 32 && b & 0x40 != 0 { v |= (-1i32).wrapping_shl(s); }
                return v;
            }
        }
    }
}

fn decode_program(bytes: &[u8]) -> Program {
    let mut r = Rd { b: bytes, p: 0 };
    assert_eq!(&bytes[0..4], b"SVM1", "bad magic");
    r.p = 4;
    let entry = r.u16();
    let reg_persist = r.u32();
    let n = r.u8();
    let stacks = (0..n).map(|_| StackSpec { persist: r.u8() == 1 }).collect();
    let n = r.u8();
    let mut stack_init = Vec::new();
    for _ in 0..n {
        let idx = r.u8() as usize;
        let cnt = r.u16();
        stack_init.push((idx, (0..cnt).map(|_| r.sleb()).collect()));
    }
    let n = r.u16();
    let mut classes = Vec::new();
    for _ in 0..n {
        let nr = r.u16();
        classes.push((0..nr * 2).map(|_| r.uleb()).collect());
    }
    let n = r.u16();
    let mut strings = Vec::new();
    for _ in 0..n {
        let l = r.u8();
        strings.push((0..l).map(|_| r.u8()).collect());
    }
    let n = r.u16();
    let mut valid_sets = Vec::new();
    for _ in 0..n {
        let l = r.u16() as usize;
        let mut set = vec![false; l];
        for i in (0..l).step_by(8) {
            let b = r.u8();
            for k in 0..8 {
                if i + k < l { set[i + k] = (b >> k) & 1 == 1; }
            }
        }
        valid_sets.push(set);
    }
    let n = r.u16();
    let jump_table = (0..n).map(|_| r.u16()).collect();
    let cl = r.u16() as usize;
    let code = bytes[r.p..r.p + cl].to_vec();
    Program { entry, reg_persist, stacks, stack_init, classes, strings, valid_sets, jump_table, code }
}

// ---- trace parsing ---------------------------------------------------------
fn field(line: &str, key: &str) -> Option<String> {
    let pat = format!("\"{}\":", key);
    let i = line.find(&pat)? + pat.len();
    let rest = &line[i..];
    let end = rest.find(|c| c == ',' || c == '}').unwrap_or(rest.len());
    Some(rest[..end].trim().to_string())
}

fn str_field(line: &str, key: &str) -> String {
    let pat = format!("\"{}\":\"", key);
    match line.find(&pat) {
        Some(i) => {
            let rest = &line[i + pat.len()..];
            rest[..rest.find('"').unwrap_or(0)].to_string()
        }
        None => String::new(),
    }
}

fn valid_field(line: &str) -> Vec<bool> {
    let pat = "\"valid\":[";
    let i = line.find(pat).unwrap() + pat.len();
    let rest = &line[i..];
    let end = rest.find(']').unwrap();
    rest[..end].split(',').map(|s| s.trim() == "1").collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: replay <pkg.svm> <trace-dir> <src-dir>");
        std::process::exit(2);
    }
    let prog = decode_program(&fs::read(&args[1]).expect("read pkg"));
    let trace_dir = Path::new(&args[2]);
    let src_dir = Path::new(&args[3]);

    let mut entries: Vec<_> = fs::read_dir(trace_dir)
        .expect("trace dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect();
    entries.sort();

    let (mut calls, mut files, mut bad) = (0u64, 0u64, 0u64);
    let mut hist: std::collections::BTreeMap<i32, u64> = Default::default();
    let mut vm = ScannerVm::new(&prog);

    for path in entries {
        let stem = path.file_stem().unwrap().to_string_lossy().to_string();
        let src = match fs::read(src_dir.join(format!("{stem}.toml"))) {
            Ok(s) => s,
            Err(_) => continue,
        };
        files += 1;
        for line in fs::read_to_string(&path).unwrap().lines() {
            if line.trim().is_empty() { continue; }
            calls += 1;
            let cur0: usize = field(line, "cur0").unwrap().parse().unwrap();
            let want_ret: i32 = field(line, "ret").unwrap().parse().unwrap();
            let want_sym: i32 = field(line, "sym").unwrap().parse().unwrap();
            let want_cur1: usize = field(line, "cur1").unwrap().parse().unwrap();
            let want_ops = str_field(line, "ops");
            let valid = valid_field(line);
            *hist.entry(want_sym).or_insert(0) += 1;

            let mut lx = ByteLexer::new(&src, cur0);
            let (ok, sym) = vm.scan(&mut lx, &valid);
            let got_ret = i32::from(ok);
            if got_ret != want_ret || sym != want_sym || lx.ops != want_ops || lx.cur != want_cur1 {
                bad += 1;
                if bad <= 10 {
                    println!("MISMATCH {stem} @{cur0}");
                    println!("  want ret={want_ret} sym={want_sym} ops={want_ops} cur1={want_cur1}");
                    println!("  got  ret={got_ret} sym={sym} ops={} cur1={}", lx.ops, lx.cur);
                }
            }
        }
    }
    let h: Vec<String> = hist.iter().map(|(k, v)| format!("{k}:{v}")).collect();
    println!("files {files}  calls {calls}  mismatches {bad}");
    println!("result_symbol histogram (-1 = returned false): {}", h.join(" "));
    std::process::exit(if bad == 0 { 0 } else { 1 });
}
