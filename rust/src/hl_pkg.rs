//! The highlight package: leaf defaults plus ordered context overrides.

use std::collections::{HashMap, HashSet};
use std::fmt;

use serde::Deserialize;

const FORMAT: &str = "et-highlight/1";

#[derive(Debug)]
pub struct LoadError(String);

impl fmt::Display for LoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for LoadError {}

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
pub struct ContextRule {
    pub parent: Option<String>,
    pub field: Option<String>,
    pub parent_field: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub ancestor: Option<String>,
    pub scope: String,
}

#[derive(Debug, Deserialize)]
#[serde(try_from = "RawPackage")]
pub struct Package {
    pub scopes: HashSet<String>,
    pub leaf: HashMap<String, String>,
    pub context: Vec<ContextRule>,
}

#[derive(Deserialize)]
struct RawPackage {
    #[serde(rename = "format")]
    _format: PackageFormat,
    scopes: HashSet<String>,
    #[serde(default)]
    keyword: Vec<String>,
    #[serde(default)]
    operator: Vec<String>,
    #[serde(default)]
    punctuation: Vec<String>,
    #[serde(default)]
    leaf: HashMap<String, String>,
    #[serde(default)]
    context: Vec<ContextRule>,
}

impl TryFrom<RawPackage> for Package {
    type Error = String;

    fn try_from(raw: RawPackage) -> Result<Self, Self::Error> {
        validate_scope_prefixes(&raw.scopes)?;

        let mut leaf = raw.leaf;
        for (scope, kinds) in [
            ("keyword", raw.keyword),
            ("operator", raw.operator),
            ("punctuation", raw.punctuation),
        ] {
            for kind in kinds {
                leaf.insert(kind, scope.to_owned());
            }
        }

        for scope in leaf
            .values()
            .chain(raw.context.iter().map(|rule| &rule.scope))
        {
            if !raw.scopes.contains(scope) {
                return Err(format!("emitted scope `{scope}` is not in `scopes`"));
            }
        }

        Ok(Self {
            scopes: raw.scopes,
            leaf,
            context: raw.context,
        })
    }
}

fn validate_scope_prefixes(scopes: &HashSet<String>) -> Result<(), String> {
    for scope in scopes {
        if let Some((prefix, _)) = scope.rsplit_once('.') {
            if !scopes.contains(prefix) {
                return Err(format!(
                    "dotted scope `{scope}` requires prefix `{prefix}` in `scopes`"
                ));
            }
        }
    }
    Ok(())
}

impl Package {
    pub fn load(raw: &str) -> Result<Self, LoadError> {
        serde_json::from_str(raw).map_err(|error| LoadError(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(raw: serde_json::Value) -> Result<Package, LoadError> {
        Package::load(&raw.to_string())
    }

    #[test]
    fn loads_the_json_package_from_the_design() {
        let raw = include_str!("../../packages/json.highlight.json");
        let package = Package::load(raw).expect("shipped JSON package loads");
        assert!(package.scopes.contains("string.escape"));
        assert_eq!(package.leaf["string_content"], "string");
        assert_eq!(package.context.len(), 2);
        assert_eq!(package.context[0].parent.as_deref(), Some("string"));
        assert_eq!(package.context[0].field, None);
        assert_eq!(package.context[0].parent_field.as_deref(), Some("key"));
        assert_eq!(package.context[0].kind.as_deref(), Some("string_content"));
        assert_eq!(package.context[0].ancestor, None);
        assert_eq!(package.context[1].kind.as_deref(), Some("\""));
        assert_eq!(package.context[1].scope, "property");
    }

    #[test]
    fn refuses_an_unknown_package_format() {
        let error = Package::load(r#"{"format":"et-highlight/2","scopes":[]}"#)
            .expect_err("future package must be refused");
        assert!(
            error
                .to_string()
                .contains("unknown package format `et-highlight/2`; expected `et-highlight/1`"),
            "{error}"
        );
    }

    #[test]
    fn expands_sugar_in_order_with_later_lists_winning() {
        let package = load(serde_json::json!({
            "format": FORMAT,
            "scopes": ["base", "keyword", "operator", "punctuation"],
            "keyword": ["shared"],
            "operator": ["shared"],
            "punctuation": ["shared"],
            "leaf": { "shared": "base" }
        }))
        .expect("package loads");
        assert_eq!(package.leaf["shared"], "punctuation");
    }

    #[test]
    fn preserves_context_order() {
        let package = load(serde_json::json!({
            "format": FORMAT,
            "scopes": ["first", "second"],
            "context": [
                { "type": "name", "scope": "first" },
                { "type": "name", "scope": "second" }
            ]
        }))
        .expect("package loads");
        assert_eq!(package.context[0].scope, "first");
        assert_eq!(package.context[1].scope, "second");
    }

    #[test]
    fn refuses_every_kind_of_unlisted_emitted_scope() {
        for field in ["leaf", "keyword", "operator", "punctuation", "context"] {
            let mut raw = serde_json::json!({
                "format": FORMAT,
                "scopes": ["listed"]
            });
            raw[field] = match field {
                "leaf" => serde_json::json!({ "name": "missing" }),
                "context" => serde_json::json!([{ "type": "name", "scope": "missing" }]),
                _ => serde_json::json!(["name"]),
            };
            let error = load(raw).expect_err("unlisted emitted scope must be refused");
            let missing = match field {
                "leaf" | "context" => "missing",
                other => other,
            };
            assert!(
                error
                    .to_string()
                    .contains(&format!("emitted scope `{missing}` is not in `scopes`")),
                "{field}: {error}"
            );
        }
    }

    #[test]
    fn accepts_only_complete_dotted_scope_prefix_chains() {
        load(serde_json::json!({
            "format": FORMAT,
            "scopes": ["string", "string.escape", "string.escape.unicode"]
        }))
        .expect("complete prefix chain loads");

        let error = load(serde_json::json!({
            "format": FORMAT,
            "scopes": ["string", "string.escape.unicode"]
        }))
        .expect_err("missing immediate prefix must be refused");
        assert!(
            error.to_string().contains(
                "dotted scope `string.escape.unicode` requires prefix `string.escape` in `scopes`"
            ),
            "{error}"
        );
    }
}
