//! Compiled bytecode package: load and verify.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use serde::Deserialize;

use crate::Refuse;

#[derive(Debug, Deserialize)]
pub struct Bytecode {
    #[allow(dead_code)]
    pub language: String,
    #[serde(default = "default_indent")]
    pub indent: usize,
    #[serde(default)]
    pub comment_type: Option<String>,
    #[serde(default)]
    pub opaque: Vec<String>,
    #[serde(default)]
    pub steal_into_body: Vec<String>,
    #[serde(default)]
    pub blank: Blank,
    #[serde(default)]
    pub consts: Vec<String>,
    #[serde(default)]
    pub entry: BTreeMap<String, usize>,
    #[serde(default)]
    pub kinds: BTreeMap<String, String>,
    #[serde(default)]
    pub defaults: Defaults,
    #[serde(default)]
    pub code: Vec<i32>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Defaults {
    pub leaf: usize,
    pub opaque: usize,
    pub fwd: usize,
}

#[derive(Debug, Default, Deserialize)]
pub struct Blank {
    #[serde(default)]
    pub max: usize,
    #[serde(default)]
    pub before_top: Vec<String>,
}

fn default_indent() -> usize {
    2
}

impl Bytecode {
    pub fn comment_type(&self) -> &str {
        self.comment_type.as_deref().unwrap_or("\0")
    }

    pub fn is_opaque(&self, ty: &str) -> bool {
        self.opaque.iter().any(|s| s == ty)
    }

    pub fn const_at(&self, idx: i32) -> Result<&str, Refuse> {
        let i = usize::try_from(idx).map_err(|_| Refuse(format!("const {idx} oob")))?;
        self.consts
            .get(i)
            .map(String::as_str)
            .ok_or_else(|| Refuse(format!("const {idx} oob")))
    }
}

pub fn find_packages() -> Result<PathBuf, Refuse> {
    let mut starts = Vec::new();
    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
    {
        starts.push(parent.to_path_buf());
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    for start in starts {
        let mut dir = start;
        loop {
            let cand = dir.join("packages");
            if cand.is_dir() {
                return Ok(cand);
            }
            if !dir.pop() {
                break;
            }
        }
    }
    Err(Refuse("packages/ directory not found".into()))
}

pub fn load(language: &str) -> Result<Bytecode, Refuse> {
    let path = find_packages()?.join(format!("{language}.json"));
    let raw = fs::read_to_string(&path)
        .map_err(|_| Refuse(format!("no package for language {language}")))?;
    let bc: Bytecode = serde_json::from_str(&raw)
        .map_err(|e| Refuse(format!("malformed package {language}: {e}")))?;
    verify(&bc)?;
    Ok(bc)
}

// Opcode numbers — keep in lockstep with tools/opcodes.js.
pub const HALT: i32 = 0;
pub const TAKE: i32 = 1;
pub const SKIP: i32 = 2;
pub const FINISH: i32 = 3;
pub const EMPTY: i32 = 4;
pub const PEEK_PUNCT: i32 = 5;
pub const NODE_PUNCT: i32 = 6;
pub const DROP_N: i32 = 7;
pub const DUP_N: i32 = 8;
pub const DROP_D: i32 = 9;
pub const DUP_D: i32 = 10;
pub const DROP_I: i32 = 11;
pub const DUP_I: i32 = 12;
pub const NOT: i32 = 13;
pub const LEAF: i32 = 14;
pub const OPAQUE: i32 = 15;
pub const LINE: i32 = 16;
pub const SOFTLINE: i32 = 17;
pub const HARDLINE: i32 = 18;
pub const GROUP: i32 = 19;
pub const INDENT: i32 = 20;
pub const IF_BREAK: i32 = 21;
pub const FORMAT: i32 = 22;
pub const NODE_TEXT: i32 = 23;
pub const FORMAT_OP: i32 = 24;
pub const ITEMS_NEW: i32 = 25;
pub const ITEMS_PUSH: i32 = 26;
pub const ITEMS_LEN: i32 = 27;
pub const ITEMS_FORMAT: i32 = 28;
pub const CONCAT_DYN: i32 = 29;
pub const JOIN_DYN: i32 = 30;
pub const PAREN: i32 = 31;
pub const TAKE_ALL: i32 = 32;
pub const EQ: i32 = 33;
pub const LT: i32 = 34;
pub const ADD: i32 = 35;
pub const SUB: i32 = 36;
pub const APPEND_DANGLING: i32 = 37;
pub const SWAP_D: i32 = 38;
pub const GROUP_BREAK: i32 = 39;
pub const HOST_FROM_IMPORT: i32 = 40;
pub const NODE_RAW: i32 = 41;
pub const BAG_LEN: i32 = 42;
pub const BAG_GET: i32 = 43;

pub const JZ: i32 = 50;
pub const JMP: i32 = 51;
pub const JNZ: i32 = 52;
pub const PUSH_I: i32 = 53;
pub const TEXT: i32 = 54;
pub const REFUSE: i32 = 55;
pub const PEEK_TOKEN: i32 = 56;
pub const NODE_TOKEN: i32 = 57;
pub const NODE_FIELD: i32 = 58;
pub const NODE_KIND: i32 = 59;
pub const STORE: i32 = 60;
pub const LOAD: i32 = 61;
pub const CONCAT: i32 = 62;
pub const BAG_FIELD: i32 = 63;
pub const BAG_KIND: i32 = 64;
pub const BAG_TOKEN: i32 = 65;
pub const BAG_INDEX: i32 = 66;
pub const BAG_FMT_KIND: i32 = 67;
pub const HOST_CHAIN: i32 = 68;
pub const DSTORE: i32 = 69;
pub const DLOAD: i32 = 70;
pub const ITEMS_GET: i32 = 71;
pub const BLANK_EXTRA: i32 = 72;

pub const BAG_ONLY_FIELDS: i32 = 80;

pub fn op_len(op: i32, code: &[i32], pc: usize) -> Result<usize, Refuse> {
    if op == BAG_ONLY_FIELDS {
        let n = *code
            .get(pc + 1)
            .ok_or_else(|| Refuse(format!("truncated BAG_ONLY_FIELDS at {pc}")))?;
        if n < 0 {
            return Err(Refuse(format!("BAG_ONLY_FIELDS n<{n} at {pc}")));
        }
        return Ok(2 + n as usize);
    }
    Ok(if has_imm(op) { 2 } else { 1 })
}

fn has_imm(op: i32) -> bool {
    matches!(
        op,
        JZ | JMP
            | JNZ
            | PUSH_I
            | TEXT
            | REFUSE
            | PEEK_TOKEN
            | NODE_TOKEN
            | NODE_FIELD
            | NODE_KIND
            | STORE
            | LOAD
            | CONCAT
            | BAG_FIELD
            | BAG_KIND
            | BAG_TOKEN
            | BAG_INDEX
            | BAG_FMT_KIND
            | HOST_CHAIN
            | DSTORE
            | DLOAD
    )
}

fn known_op(op: i32) -> bool {
    matches!(
        op,
        HALT | TAKE
            | SKIP
            | FINISH
            | EMPTY
            | PEEK_PUNCT
            | NODE_PUNCT
            | DROP_N
            | DUP_N
            | DROP_D
            | DUP_D
            | DROP_I
            | DUP_I
            | NOT
            | LEAF
            | OPAQUE
            | LINE
            | SOFTLINE
            | HARDLINE
            | GROUP
            | INDENT
            | IF_BREAK
            | FORMAT
            | NODE_TEXT
            | FORMAT_OP
            | ITEMS_NEW
            | ITEMS_PUSH
            | ITEMS_LEN
            | ITEMS_FORMAT
            | CONCAT_DYN
            | JOIN_DYN
            | PAREN
            | TAKE_ALL
            | EQ
            | LT
            | ADD
            | SUB
            | APPEND_DANGLING
            | SWAP_D
            | GROUP_BREAK
            | HOST_FROM_IMPORT
            | NODE_RAW
            | BAG_LEN
            | BAG_GET
            | JZ
            | JMP
            | JNZ
            | PUSH_I
            | TEXT
            | REFUSE
            | PEEK_TOKEN
            | NODE_TOKEN
            | NODE_FIELD
            | NODE_KIND
            | STORE
            | LOAD
            | CONCAT
            | BAG_FIELD
            | BAG_KIND
            | BAG_TOKEN
            | BAG_INDEX
            | BAG_FMT_KIND
            | HOST_CHAIN
            | DSTORE
            | DLOAD
            | ITEMS_GET
            | BLANK_EXTRA
            | BAG_ONLY_FIELDS
    )
}

/// Structural checks: well-formed ops, in-range immediates, jumps land on
/// instruction boundaries, every path hits HALT or REFUSE. Stack depths are
/// *not* proved — CONCAT_DYN / BAG_FIELD have data-dependent height.
/// Linearity is structural in a different sense: the ISA has one forward
/// cursor and HALT always finishes it.
pub fn verify(bc: &Bytecode) -> Result<(), Refuse> {
    let code = &bc.code;
    if code.is_empty() {
        return Err(Refuse("empty code section".into()));
    }
    let mut starts = BTreeSet::new();
    let mut pc = 0usize;
    while pc < code.len() {
        let op = code[pc];
        if !known_op(op) {
            return Err(Refuse(format!("unknown opcode {op} at {pc}")));
        }
        let len = op_len(op, code, pc)?;
        if pc + len > code.len() {
            return Err(Refuse(format!("truncated op {op} at {pc}")));
        }
        match op {
            TEXT | REFUSE | PEEK_TOKEN | NODE_TOKEN | NODE_FIELD | NODE_KIND | BAG_FIELD
            | BAG_KIND | BAG_TOKEN | BAG_FMT_KIND => {
                let idx = code[pc + 1];
                bc.const_at(idx)?;
            }
            STORE | LOAD => {
                let s = code[pc + 1];
                if !(0..8).contains(&s) {
                    return Err(Refuse(format!("int slot {s} oob at {pc}")));
                }
            }
            DSTORE | DLOAD => {
                let s = code[pc + 1];
                if !(0..4).contains(&s) {
                    return Err(Refuse(format!("doc slot {s} oob at {pc}")));
                }
            }
            CONCAT if code[pc + 1] < 0 => {
                return Err(Refuse(format!("CONCAT n<0 at {pc}")));
            }
            BAG_ONLY_FIELDS => {
                let n = code[pc + 1];
                for k in 0..n {
                    bc.const_at(code[pc + 2 + k as usize])?;
                }
            }
            _ => {}
        }
        starts.insert(pc);
        pc += len;
    }

    pc = 0;
    while pc < code.len() {
        let op = code[pc];
        let len = op_len(op, code, pc)?;
        if matches!(op, JZ | JMP | JNZ) {
            let t = code[pc + 1];
            if t < 0 || !starts.contains(&(t as usize)) {
                return Err(Refuse(format!("bad jump {t} at {pc}")));
            }
        }
        pc += len;
    }

    for (name, &entry) in &bc.entry {
        if !starts.contains(&entry) {
            return Err(Refuse(format!("entry {name} pc {entry} not an op")));
        }
    }
    for (label, pc) in [
        ("defaults.leaf", bc.defaults.leaf),
        ("defaults.opaque", bc.defaults.opaque),
        ("defaults.fwd", bc.defaults.fwd),
    ] {
        if !starts.contains(&pc) {
            return Err(Refuse(format!("{label} pc {pc} not an op")));
        }
    }

    // Every path from an entry (and the defaults) must hit HALT or REFUSE.
    let mut roots: Vec<usize> = bc.entry.values().copied().collect();
    roots.extend([bc.defaults.leaf, bc.defaults.opaque, bc.defaults.fwd]);
    for root in roots {
        check_halts(code, &starts, root)?;
    }
    Ok(())
}

fn check_halts(code: &[i32], starts: &BTreeSet<usize>, root: usize) -> Result<(), Refuse> {
    let mut seen = BTreeSet::new();
    let mut stack = vec![root];
    while let Some(pc) = stack.pop() {
        if !seen.insert(pc) {
            continue;
        }
        if pc >= code.len() || !starts.contains(&pc) {
            return Err(Refuse(format!("fall off code at {pc}")));
        }
        let op = code[pc];
        let len = op_len(op, code, pc)?;
        match op {
            HALT | REFUSE => {}
            JMP => stack.push(code[pc + 1] as usize),
            JZ | JNZ => {
                stack.push(code[pc + 1] as usize);
                stack.push(pc + len);
            }
            _ => stack.push(pc + len),
        }
    }
    Ok(())
}
