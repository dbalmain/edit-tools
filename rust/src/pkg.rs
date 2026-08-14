//! The shipped language package: data only, no code.
//!
//! A package is a table from node type to a Doc-building expression, plus the
//! handful of language facts the runtime needs (which node types are
//! punctuation, which are comments, operator precedence for chain flattening).

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;

use crate::Refusal;

#[derive(Deserialize)]
pub struct Package {
    pub indent: usize,
    /// Node types that are punctuation or keywords; `named` skips them.
    #[serde(default)]
    pub tokens: HashSet<String>,
    /// Node types the runtime attaches rather than formats.
    #[serde(default)]
    pub comments: HashSet<String>,
    /// Node types a leading comment is pushed *into* rather than emitted
    /// before -- a comment before a suite belongs inside it.
    #[serde(default)]
    pub descend: HashSet<String>,
    /// Node types that get a balanced paren pair when their layout breaks.
    #[serde(default)]
    pub optional_parens: HashSet<String>,
    /// Operator text -> binding tightness; smaller binds tighter. `flatten`
    /// stops descending when the tightness changes.
    #[serde(default)]
    pub precedence: HashMap<String, i64>,
    pub rules: HashMap<String, Expr>,
}

impl Package {
    pub fn load(dir: &std::path::Path, language: &str) -> Result<Package, Refusal> {
        let path = dir.join(format!("{language}.json"));
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| Refusal(format!("no package for language `{language}`: {e}")))?;
        serde_json::from_str(&raw)
            .map_err(|e| Refusal(format!("malformed package {}: {e}", path.display())))
    }

    pub fn is_token(&self, kind: &str) -> bool {
        self.tokens.contains(kind)
    }

    pub fn tightness(&self, op: &str) -> i64 {
        self.precedence.get(op).copied().unwrap_or(0)
    }
}

/// Which of a node's direct children an opcode addresses.
#[derive(Debug, Clone)]
pub enum Sel {
    Field(String),
    Type(String),
    Named,
    Any,
}

#[derive(Debug)]
pub enum Pred {
    Count(Sel, usize),
    CountOver(Sel, usize),
    Has(Sel),
}

/// One expression of the package language. Nineteen opcodes; see DESIGN.md.
#[derive(Debug, Deserialize)]
#[serde(try_from = "Value")]
pub enum Expr {
    Seq(Vec<Expr>),
    Group(Vec<Expr>),
    Indent(Vec<Expr>),
    Line,
    Soft,
    Hard,
    Sp,
    Child(Sel),
    Each(Sel, Box<Expr>),
    Tok(String),
    Verbatim,
    Opt(Sel, Box<Expr>),
    Trail(String, Sel),
    Paren(Vec<Expr>),
    AutoParen(Sel),
    When(Pred, Box<Expr>, Box<Expr>),
    Flatten(String, Box<Expr>),
    Blank(usize),
}

impl TryFrom<Value> for Expr {
    type Error = String;

    fn try_from(value: Value) -> Result<Expr, String> {
        let Value::Array(mut parts) = value else {
            return Err(format!("expression must be an array, got {value}"));
        };
        if parts.is_empty() {
            return Ok(Expr::Seq(Vec::new()));
        }
        let op = match parts.remove(0) {
            Value::String(s) => s,
            other => return Err(format!("opcode must be a string, got {other}")),
        };
        let arity = |n: usize| -> Result<(), String> {
            if parts.len() == n {
                Ok(())
            } else {
                Err(format!("`{op}` takes {n} operands, got {}", parts.len()))
            }
        };
        let rest = |parts: Vec<Value>| -> Result<Vec<Expr>, String> {
            parts.into_iter().map(Expr::try_from).collect()
        };

        match op.as_str() {
            "seq" => Ok(Expr::Seq(rest(parts)?)),
            "group" => Ok(Expr::Group(rest(parts)?)),
            "indent" => Ok(Expr::Indent(rest(parts)?)),
            "paren" => Ok(Expr::Paren(rest(parts)?)),
            "line" => arity(0).map(|()| Expr::Line),
            "soft" => arity(0).map(|()| Expr::Soft),
            "hard" => arity(0).map(|()| Expr::Hard),
            "sp" => arity(0).map(|()| Expr::Sp),
            "verbatim" => arity(0).map(|()| Expr::Verbatim),
            "child" => {
                arity(1)?;
                Ok(Expr::Child(selector(&parts[0])?))
            }
            "autoparen" => {
                arity(1)?;
                Ok(Expr::AutoParen(selector(&parts[0])?))
            }
            "tok" => {
                arity(1)?;
                Ok(Expr::Tok(literal(&parts[0])?))
            }
            "trail" => {
                arity(2)?;
                Ok(Expr::Trail(literal(&parts[0])?, selector(&parts[1])?))
            }
            "blank" => {
                arity(1)?;
                Ok(Expr::Blank(count(&parts[0])?))
            }
            "each" | "opt" => {
                arity(2)?;
                let sel = selector(&parts[0])?;
                let body = Box::new(Expr::try_from(parts.remove(1))?);
                Ok(if op == "each" {
                    Expr::Each(sel, body)
                } else {
                    Expr::Opt(sel, body)
                })
            }
            "flatten" => {
                arity(2)?;
                let kind = literal(&parts[0])?;
                Ok(Expr::Flatten(kind, Box::new(Expr::try_from(parts.remove(1))?)))
            }
            "when" => {
                arity(3)?;
                let pred = predicate(&parts[0])?;
                let alt = Box::new(Expr::try_from(parts.remove(2))?);
                let then = Box::new(Expr::try_from(parts.remove(1))?);
                Ok(Expr::When(pred, then, alt))
            }
            _ => Err(format!("unknown opcode `{op}`")),
        }
    }
}

fn literal(value: &Value) -> Result<String, String> {
    value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("expected a string, got {value}"))
}

fn count(value: &Value) -> Result<usize, String> {
    value
        .as_u64()
        .map(|n| n as usize)
        .ok_or_else(|| format!("expected a non-negative integer, got {value}"))
}

fn selector(value: &Value) -> Result<Sel, String> {
    let raw = literal(value)?;
    match raw.split_once(':') {
        Some(("f", name)) => Ok(Sel::Field(name.to_owned())),
        Some(("t", name)) => Ok(Sel::Type(name.to_owned())),
        _ if raw == "named" => Ok(Sel::Named),
        _ if raw == "*" => Ok(Sel::Any),
        _ => Err(format!("unknown selector `{raw}`")),
    }
}

fn predicate(value: &Value) -> Result<Pred, String> {
    let Value::Array(parts) = value else {
        return Err(format!("predicate must be an array, got {value}"));
    };
    match parts.first().and_then(Value::as_str) {
        Some("count") if parts.len() == 3 => {
            Ok(Pred::Count(selector(&parts[1])?, count(&parts[2])?))
        }
        Some("count>") if parts.len() == 3 => {
            Ok(Pred::CountOver(selector(&parts[1])?, count(&parts[2])?))
        }
        Some("has") if parts.len() == 2 => Ok(Pred::Has(selector(&parts[1])?)),
        _ => Err(format!("unknown predicate {value}")),
    }
}
