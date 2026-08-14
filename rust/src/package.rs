//! Language package: a map from node type to a named layout kind.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::Deserialize;

use crate::Refuse;

#[derive(Debug, Deserialize)]
pub struct Package {
    #[allow(dead_code)]
    pub language: String,
    #[serde(default = "default_indent")]
    pub indent: usize,
    #[serde(default)]
    pub comment_type: Option<String>,
    #[serde(default)]
    pub opaque: Vec<String>,
    #[serde(default)]
    pub blank: Blank,
    #[serde(default)]
    pub nodes: BTreeMap<String, Rule>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Blank {
    #[serde(default)]
    #[allow(dead_code)]
    pub max: usize,
    #[serde(default)]
    pub before_top: Vec<String>,
}

fn default_indent() -> usize {
    2
}

/// Kind parameters. Unknown fields are ignored so a Python package can
/// grow without a lock-step change to this struct for every new key.
#[derive(Debug, Deserialize)]
pub struct Rule {
    pub kind: String,
    #[serde(default)]
    pub open: Option<String>,
    #[serde(default)]
    pub close: Option<String>,
    #[serde(default)]
    pub sep: Option<String>,
    #[serde(default)]
    pub trailing: Option<String>,
    #[serde(default)]
    pub singleton_comma: bool,
    #[serde(default)]
    pub flat_pad: bool,
    #[serde(default)]
    pub op: Option<String>,
    #[serde(default)]
    pub op_field: Option<String>,
    #[serde(default)]
    pub tight: bool,
    #[serde(default)]
    pub kw: Option<String>,
    #[serde(default)]
    pub sp: bool,
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub already_flat: bool,
    #[serde(rename = "break", default)]
    pub break_style: Option<String>,
    #[serde(default)]
    pub paren: bool,
}

impl Package {
    pub fn comment_type(&self) -> &str {
        self.comment_type.as_deref().unwrap_or("\0")
    }

    pub fn is_opaque(&self, ty: &str) -> bool {
        self.opaque.iter().any(|s| s == ty)
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

pub fn load(language: &str) -> Result<Package, Refuse> {
    let path = find_packages()?.join(format!("{language}.json"));
    let raw = fs::read_to_string(&path)
        .map_err(|_| Refuse(format!("no package for language {language}")))?;
    serde_json::from_str(&raw).map_err(|e| Refuse(format!("malformed package {language}: {e}")))
}
