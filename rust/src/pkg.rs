//! The shipped language package: data only, no code.
//!
//! A package is a table from node type to a Doc-building expression, plus the
//! handful of language facts the runtime needs (which node types are
//! punctuation, which are comments, operator precedence and the field names
//! of a flattened chain).

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;

use crate::Refusal;

const FORMAT: &str = "et-doc-rules/1";
const MAX_MACRO_DEPTH: usize = 32;
const MAX_JSON_INTEGER: f64 = 9_007_199_254_740_991.0;
/// Ceiling on the two whitespace-shaped header fields. Neither can allocate
/// unboundedly -- `blank_cap` is clamped by the source's own newlines and
/// `comment_gap` is one string -- so this exists to make a typo a named error
/// rather than a silently strange package.
const MAX_GAP: usize = 8;

fn one() -> usize {
    1
}

#[derive(Deserialize)]
#[serde(try_from = "String")]
struct PackageFormat;

impl TryFrom<String> for PackageFormat {
    type Error = String;

    fn try_from(found: String) -> Result<Self, Self::Error> {
        if found == FORMAT {
            Ok(Self)
        } else {
            Err(format!(
                "unknown package format `{found}`; expected `{FORMAT}`"
            ))
        }
    }
}

#[derive(Deserialize)]
#[serde(try_from = "RawPackage")]
pub struct Package {
    pub indent: usize,
    /// Experimental rendered-text alignment. The only spike implementation
    /// is `go`; omitting this field leaves the printer byte-for-byte alone.
    pub alignment: Option<String>,
    /// Whether one indent level is a tab rather than `indent` spaces. gofmt
    /// is the first reference whose house style is tab-indented.
    #[serde(default)]
    pub tab_indent: bool,
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
    /// Field names of a left-nested operator spine. Defaults are
    /// tree-sitter-python's `left` / `operator` / `right`; a parser that
    /// uses different ones says so here, next to `precedence`.
    pub flatten_fields: FlattenFields,
    /// Spaces between code and a trailing comment on the same line. Black
    /// writes two, prettier writes one. A count rather than a string on
    /// purpose: no package may put arbitrary text in the output.
    pub comment_gap: usize,
    /// Ceiling on blank lines the runtime preserves next to a comment. Black
    /// keeps two, prettier keeps one. The `blank` opcode carries its own cap
    /// for gaps *between* items; this one governs the gaps the package never
    /// sees, because the runtime owns comment attachment.
    pub blank_cap: usize,
    pub rules: HashMap<String, Expr>,
}

#[derive(Deserialize)]
struct RawPackage {
    #[serde(rename = "format")]
    _format: PackageFormat,
    indent: usize,
    #[serde(default)]
    alignment: Option<String>,
    #[serde(default)]
    tab_indent: bool,
    #[serde(default)]
    tokens: HashSet<String>,
    #[serde(default)]
    comments: HashSet<String>,
    #[serde(default)]
    descend: HashSet<String>,
    #[serde(default)]
    optional_parens: HashSet<String>,
    #[serde(default)]
    precedence: HashMap<String, i64>,
    #[serde(default)]
    flatten_fields: Option<Value>,
    #[serde(default = "one")]
    comment_gap: usize,
    #[serde(default = "one")]
    blank_cap: usize,
    #[serde(default)]
    defs: HashMap<String, Value>,
    rules: HashMap<String, Value>,
}

impl TryFrom<RawPackage> for Package {
    type Error = String;

    fn try_from(raw: RawPackage) -> Result<Self, Self::Error> {
        for (name, value) in [
            ("comment_gap", raw.comment_gap),
            ("blank_cap", raw.blank_cap),
        ] {
            if value > MAX_GAP {
                return Err(format!(
                    "`{name}` is {value}; the most allowed is {MAX_GAP}"
                ));
            }
        }
        let flatten_fields = flatten_fields(raw.flatten_fields)?;
        if raw.alignment.as_deref().is_some_and(|value| value != "go") {
            return Err(format!(
                "unknown alignment mode `{}`; expected `go`",
                raw.alignment.as_deref().unwrap_or_default()
            ));
        }
        let rules = expand_rules(&raw.defs, raw.rules)?
            .into_iter()
            .map(|(name, value)| Ok((name, Expr::try_from(value)?)))
            .collect::<Result<_, String>>()?;
        Ok(Self {
            indent: raw.indent,
            alignment: raw.alignment,
            tab_indent: raw.tab_indent,
            tokens: raw.tokens,
            comments: raw.comments,
            descend: raw.descend,
            optional_parens: raw.optional_parens,
            precedence: raw.precedence,
            flatten_fields,
            comment_gap: raw.comment_gap,
            blank_cap: raw.blank_cap,
            rules,
        })
    }
}

/// The three labels `flatten` walks. A package that says nothing gets
/// tree-sitter's usual names, which is today's behaviour exactly.
#[derive(Debug, Clone)]
pub struct FlattenFields {
    pub left: String,
    pub operator: String,
    pub right: String,
}

impl Default for FlattenFields {
    fn default() -> Self {
        Self {
            left: "left".to_owned(),
            operator: "operator".to_owned(),
            right: "right".to_owned(),
        }
    }
}

const FLATTEN_FIELD_KEYS: [&str; 3] = ["left", "operator", "right"];

fn flatten_fields(value: Option<Value>) -> Result<FlattenFields, String> {
    let Some(value) = value else {
        return Ok(FlattenFields::default());
    };
    let Value::Object(map) = value else {
        return Err(format!("`flatten_fields` must be an object, got {value}"));
    };
    let mut unknown: Vec<String> = map
        .keys()
        .filter(|key| !FLATTEN_FIELD_KEYS.contains(&key.as_str()))
        .cloned()
        .collect();
    unknown.sort_unstable();
    if let Some(key) = unknown.first() {
        return Err(format!("`flatten_fields` has unknown field `{key}`"));
    }
    let name = |key: &str| -> Result<String, String> {
        let Some(raw) = map.get(key) else {
            return Err(format!("`flatten_fields` is missing `{key}`"));
        };
        match raw.as_str() {
            Some(s) if !s.is_empty() => Ok(s.to_owned()),
            _ => Err(format!(
                "`flatten_fields.{key}` must be a non-empty string, got {raw}"
            )),
        }
    };
    let left = name("left")?;
    let operator = name("operator")?;
    let right = name("right")?;
    if left == operator || left == right || operator == right {
        return Err("`flatten_fields` field names must be distinct".to_owned());
    }
    Ok(FlattenFields {
        left,
        operator,
        right,
    })
}

fn expand_rules(
    defs: &HashMap<String, Value>,
    rules: HashMap<String, Value>,
) -> Result<HashMap<String, Value>, String> {
    let mut arities = HashMap::new();
    for (name, body) in defs {
        if !body.is_array() {
            return Err(format!("definition `{name}` body must be an array"));
        }
        arities.insert(name.as_str(), macro_arity(body, true)?);
    }
    for rule in rules.values() {
        macro_arity(rule, false)?;
    }
    for body in defs.values().chain(rules.values()) {
        validate_uses(body, &arities)?;
    }
    for name in defs.keys() {
        validate_macro_path(name, defs, &mut Vec::new())?;
    }

    rules
        .into_iter()
        .map(|(name, rule)| {
            expand_value(&rule, defs, &arities, &mut Vec::new(), None)
                .map(|expanded| (name, expanded))
        })
        .collect()
}

fn macro_arity(value: &Value, holes_allowed: bool) -> Result<usize, String> {
    let Value::Array(parts) = value else {
        return Ok(0);
    };
    if parts.first().and_then(Value::as_str) == Some("$") {
        if !holes_allowed {
            return Err("`$` hole is only valid inside a `defs` body".to_owned());
        }
        if parts.len() != 2 {
            return Err(format!(
                "`$` hole takes 1 operand, got {}",
                parts.len().saturating_sub(1)
            ));
        }
        return macro_index(&parts[1])?
            .checked_add(1)
            .ok_or_else(|| "`$` hole index is too large".to_owned());
    }
    parts.iter().try_fold(0, |arity, part| {
        macro_arity(part, holes_allowed).map(|nested| arity.max(nested))
    })
}

fn macro_index(value: &Value) -> Result<usize, String> {
    json_integer(value)
        .ok_or_else(|| format!("`$` hole index must be a non-negative integer, got {value}"))
}

fn json_integer(value: &Value) -> Option<usize> {
    let number = value.as_f64()?;
    (number >= 0.0 && number.fract() == 0.0 && number <= MAX_JSON_INTEGER)
        .then_some(number as usize)
}

fn use_name(parts: &[Value]) -> Result<&str, String> {
    parts
        .get(1)
        .and_then(Value::as_str)
        .ok_or_else(|| "`use` requires a definition name as its first operand".to_owned())
}

fn validate_uses(value: &Value, arities: &HashMap<&str, usize>) -> Result<(), String> {
    let Value::Array(parts) = value else {
        return Ok(());
    };
    if parts.first().and_then(Value::as_str) == Some("use") {
        let name = use_name(parts)?;
        let Some(&expected) = arities.get(name) else {
            return Err(format!("unknown definition `{name}`"));
        };
        let actual = parts.len().saturating_sub(2);
        if actual < expected {
            return Err(format!(
                "`$` hole {} in definition `{name}` is out of range for {actual} arguments",
                expected - 1
            ));
        }
        if actual > expected {
            return Err(format!(
                "definition `{name}` expects {expected} arguments, got {actual}"
            ));
        }
    }
    for part in parts {
        validate_uses(part, arities)?;
    }
    Ok(())
}

fn direct_uses<'a>(value: &'a Value, names: &mut Vec<&'a str>) {
    let Value::Array(parts) = value else {
        return;
    };
    if parts.first().and_then(Value::as_str) == Some("use") {
        if let Some(name) = parts.get(1).and_then(Value::as_str) {
            names.push(name);
        }
    }
    for part in parts {
        direct_uses(part, names);
    }
}

fn validate_macro_path<'a>(
    name: &'a str,
    defs: &'a HashMap<String, Value>,
    stack: &mut Vec<&'a str>,
) -> Result<(), String> {
    if let Some(at) = stack.iter().position(|item| *item == name) {
        let mut cycle = stack[at..].to_vec();
        cycle.push(name);
        return Err(format!("definition cycle: {}", cycle.join(" -> ")));
    }
    if stack.len() >= MAX_MACRO_DEPTH {
        return Err(format!(
            "definition nesting exceeds the maximum depth of {MAX_MACRO_DEPTH}"
        ));
    }
    stack.push(name);
    let mut nested = Vec::new();
    direct_uses(&defs[name], &mut nested);
    for next in nested {
        validate_macro_path(next, defs, stack)?;
    }
    stack.pop();
    Ok(())
}

fn expand_value<'a>(
    value: &Value,
    defs: &'a HashMap<String, Value>,
    arities: &HashMap<&'a str, usize>,
    stack: &mut Vec<String>,
    args: Option<&[Value]>,
) -> Result<Value, String> {
    let Value::Array(parts) = value else {
        return Ok(value.clone());
    };
    match parts.first().and_then(Value::as_str) {
        Some("$") => {
            let index = macro_index(&parts[1])?;
            args.and_then(|values| values.get(index))
                .cloned()
                .ok_or_else(|| {
                    format!("`$` hole {index} is out of range outside a definition expansion")
                })
        }
        Some("use") => {
            let name = use_name(parts)?;
            let expanded_args = parts[2..]
                .iter()
                .map(|arg| expand_value(arg, defs, arities, stack, args))
                .collect::<Result<Vec<_>, _>>()?;
            let expected = arities[name];
            if expanded_args.len() != expected {
                return Err(format!(
                    "definition `{name}` expects {expected} arguments, got {}",
                    expanded_args.len()
                ));
            }
            if let Some(at) = stack.iter().position(|item| item == name) {
                let mut cycle = stack[at..].to_vec();
                cycle.push(name.to_owned());
                return Err(format!("definition cycle: {}", cycle.join(" -> ")));
            }
            if stack.len() >= MAX_MACRO_DEPTH {
                return Err(format!(
                    "definition nesting exceeds the maximum depth of {MAX_MACRO_DEPTH}"
                ));
            }
            stack.push(name.to_owned());
            let expanded = expand_value(&defs[name], defs, arities, stack, Some(&expanded_args));
            stack.pop();
            expanded
        }
        _ => parts
            .iter()
            .map(|part| expand_value(part, defs, arities, stack, args))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
    }
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

    /// The string one indent level writes. Resolved once per package, so a
    /// rule never picks between tab and space and nested language regions
    /// concatenate their own units.
    pub fn indent_unit(&self) -> String {
        if self.tab_indent {
            "\t".to_owned()
        } else {
            " ".repeat(self.indent)
        }
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

/// A static test on the node.
#[derive(Debug)]
pub enum Pred {
    Count(Sel, usize),
    ChildCount(Sel, Sel, usize),
}

/// One expression of the package language. Eighteen opcodes; see DESIGN.md.
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
    Fill(Sel, Box<Expr>),
    Tok(String),
    Verbatim,
    Opt(Sel, Box<Expr>),
    Trail(String, Sel),
    Paren(Vec<Expr>),
    AutoParen(Sel),
    When(Pred, Box<Expr>, Box<Expr>),
    Flatten(String, Box<Expr>),
    /// Up to `n` blank lines from the source. The first list, if any, is the
    /// types that force the gap open to exactly `n`. The second is exact leaf
    /// spellings after which the source gap is semantic and must not be capped.
    Blank(usize, Vec<String>, Vec<String>),
    /// A break that mirrors the source's line structure: space when flat,
    /// newline when the source had a line break before the cursor.
    SrcLine,
    /// `SrcLine`'s nothing-when-flat sibling.
    SrcSoft,
    /// The trailing-separator policy for a source-driven list (gofmt): consume
    /// the separator if the source has one, and emit it only when the source
    /// had a line break before the following token.
    SrcTrail(String),
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
            "srcline" => arity(0).map(|()| Expr::SrcLine),
            "srcsoft" => arity(0).map(|()| Expr::SrcSoft),
            "srctrail" => {
                arity(1)?;
                Ok(Expr::SrcTrail(literal(&parts[0])?))
            }
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
                if parts.is_empty() || parts.len() > 3 {
                    return Err(format!(
                        "`blank` takes 1 to 3 operands, got {}",
                        parts.len()
                    ));
                }
                let cap = count(&parts[0])?;
                let around = if parts.len() >= 2 {
                    node_types(&parts[1])?
                } else {
                    Vec::new()
                };
                let keep_after = if parts.len() == 3 {
                    node_types(&parts[2])?
                } else {
                    Vec::new()
                };
                Ok(Expr::Blank(cap, around, keep_after))
            }
            "each" | "fill" | "opt" => {
                arity(2)?;
                let sel = selector(&parts[0])?;
                let body = Box::new(Expr::try_from(parts.remove(1))?);
                Ok(match op.as_str() {
                    "each" => Expr::Each(sel, body),
                    "fill" => Expr::Fill(sel, body),
                    _ => Expr::Opt(sel, body),
                })
            }
            "flatten" => {
                arity(2)?;
                let kind = literal(&parts[0])?;
                Ok(Expr::Flatten(
                    kind,
                    Box::new(Expr::try_from(parts.remove(1))?),
                ))
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

fn node_types(value: &Value) -> Result<Vec<String>, String> {
    let Value::Array(items) = value else {
        return Err(format!("expected a list of node types, got {value}"));
    };
    items.iter().map(literal).collect()
}

fn count(value: &Value) -> Result<usize, String> {
    json_integer(value).ok_or_else(|| format!("expected a non-negative integer, got {value}"))
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
        Some("child-count") if parts.len() == 4 => Ok(Pred::ChildCount(
            selector(&parts[1])?,
            selector(&parts[2])?,
            count(&parts[3])?,
        )),
        _ => Err(format!("unknown predicate {value}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn package(format: &str) -> Value {
        json!({
            "format": format,
            "indent": 2,
            "rules": {},
        })
    }

    fn macro_package(defs: Value, rules: Value) -> Result<Package, serde_json::Error> {
        serde_json::from_value(json!({
            "format": FORMAT,
            "indent": 2,
            "defs": defs,
            "rules": rules,
        }))
    }

    #[test]
    fn accepts_the_current_package_format() {
        serde_json::from_value::<Package>(package(FORMAT)).expect("current format parses");
    }

    #[test]
    fn refuses_an_unknown_package_format() {
        let err = serde_json::from_value::<Package>(package("et-doc-rules/2"))
            .err()
            .expect("future format must be refused");
        assert!(
            err.to_string()
                .contains("unknown package format `et-doc-rules/2`; expected `et-doc-rules/1`"),
            "{err}"
        );
    }

    #[test]
    fn expands_nested_definitions_with_json_values_as_arguments() {
        let pkg = macro_package(
            json!({
                "emit": ["seq", ["tok", ["$", 0]], ["child", ["$", 1]], ["$", 2]],
                "wrapped": ["use", "emit", ["$", 0], "named", ["line"]],
            }),
            json!({ "list": ["use", "wrapped", "("] }),
        )
        .expect("macros expand");
        let Expr::Seq(parts) = &pkg.rules["list"] else {
            panic!("macro should expand to seq");
        };
        assert!(
            matches!(parts.as_slice(), [Expr::Tok(s), Expr::Child(Sel::Named), Expr::Line] if s == "(")
        );
    }

    fn refusal(defs: Value, rules: Value) -> String {
        macro_package(defs, rules)
            .err()
            .expect("package must be refused")
            .to_string()
    }

    #[test]
    fn refuses_unknown_definitions_and_bad_argument_counts() {
        assert!(refusal(json!({}), json!({ "x": ["use", "missing"] }))
            .contains("unknown definition `missing`"));
        assert!(refusal(
            json!({ "one": ["tok", ["$", 0]] }),
            json!({ "x": ["use", "one", "a", "b"] })
        )
        .contains("definition `one` expects 1 arguments, got 2"));
    }

    #[test]
    fn refuses_out_of_range_and_out_of_body_holes() {
        assert!(refusal(
            json!({ "one": ["tok", ["$", 0]] }),
            json!({ "x": ["use", "one"] })
        )
        .contains("`$` hole 0 in definition `one` is out of range for 0 arguments"));
        assert!(refusal(json!({}), json!({ "x": ["tok", ["$", 0]] }))
            .contains("`$` hole is only valid inside a `defs` body"));
    }

    #[test]
    fn refuses_definition_cycles() {
        let err = refusal(
            json!({
                "a": ["use", "b"],
                "b": ["use", "a"],
            }),
            json!({ "x": ["line"] }),
        );
        assert!(err.contains("definition cycle:"), "{err}");
        assert!(
            err.contains("a -> b -> a") || err.contains("b -> a -> b"),
            "{err}"
        );
    }

    #[test]
    fn refuses_definition_nesting_beyond_the_fixed_limit() {
        let mut defs = serde_json::Map::new();
        for index in 0..=MAX_MACRO_DEPTH {
            let body = if index == MAX_MACRO_DEPTH {
                json!(["line"])
            } else {
                json!(["use", format!("d{}", index + 1)])
            };
            defs.insert(format!("d{index}"), body);
        }
        let err = refusal(Value::Object(defs), json!({ "x": ["use", "d0"] }));
        assert!(
            err.contains("definition nesting exceeds the maximum depth of 32"),
            "{err}"
        );
    }

    #[test]
    fn flatten_fields_default_to_tree_sitters_usual_names() {
        let pkg: Package = serde_json::from_value(package(FORMAT)).expect("parses");
        assert_eq!(pkg.flatten_fields.left, "left");
        assert_eq!(pkg.flatten_fields.operator, "operator");
        assert_eq!(pkg.flatten_fields.right, "right");
    }

    #[test]
    fn flatten_fields_accepts_a_renamed_spine() {
        let mut raw = package(FORMAT);
        raw["flatten_fields"] = json!({
            "left": "lhs",
            "operator": "op",
            "right": "rhs",
        });
        let pkg: Package = serde_json::from_value(raw).expect("parses");
        assert_eq!(pkg.flatten_fields.left, "lhs");
        assert_eq!(pkg.flatten_fields.operator, "op");
        assert_eq!(pkg.flatten_fields.right, "rhs");
    }

    #[test]
    fn flatten_fields_refuses_a_bad_header() {
        let cases = [
            (
                json!(["left", "operator", "right"]),
                "`flatten_fields` must be an object, got [\"left\",\"operator\",\"right\"]",
            ),
            (
                json!({"left": "lhs", "operator": "op"}),
                "`flatten_fields` is missing `right`",
            ),
            (
                json!({"left": "lhs", "operator": "op", "right": "rhs", "mid": "x"}),
                "`flatten_fields` has unknown field `mid`",
            ),
            (
                json!({"left": "", "operator": "op", "right": "rhs"}),
                "`flatten_fields.left` must be a non-empty string, got \"\"",
            ),
            (
                json!({"left": "lhs", "operator": "lhs", "right": "rhs"}),
                "`flatten_fields` field names must be distinct",
            ),
        ];
        for (value, want) in cases {
            let mut raw = package(FORMAT);
            raw["flatten_fields"] = value;
            let err = serde_json::from_value::<Package>(raw)
                .err()
                .expect("must refuse")
                .to_string();
            assert!(err.contains(want), "wanted {want:?} in {err}");
        }
    }

    #[test]
    fn validates_every_expanded_rule_at_load_time() {
        let err = refusal(
            json!({}),
            json!({
                "used": ["line"],
                "unreachable": ["blank", 2, "notalist"],
            }),
        );
        assert!(
            err.contains("expected a list of node types, got \"notalist\""),
            "{err}"
        );
    }

    #[test]
    fn fill_takes_a_selector_and_separator_expression() {
        let pkg = macro_package(
            json!({}),
            json!({ "list": ["fill", "named", ["line"]] }),
        )
        .expect("fill parses");
        assert!(matches!(pkg.rules["list"], Expr::Fill(Sel::Named, _)));

        let err = refusal(json!({}), json!({ "list": ["fill", "named"] }));
        assert!(err.contains("`fill` takes 2 operands, got 1"), "{err}");
    }
}
