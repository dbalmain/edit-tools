//! Error-tolerant tree walk from CST defaults and contextual leaves to spans.

use std::collections::HashMap;

use serde::Serialize;

use crate::hl_pkg::{ContextRule, Package};
use crate::tree::{Node, TreeDoc};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub scope: String,
}

impl Span {
    fn new(start: usize, end: usize, scope: &str) -> Self {
        Self {
            start,
            end,
            scope: scope.to_owned(),
        }
    }
}

pub type PackageMap = HashMap<String, Package>;

pub fn highlight(tree: &TreeDoc, packages: &PackageMap) -> Vec<Span> {
    let mut spans = Vec::new();
    let empty = Package::empty();
    let package = package_for(&tree.language, packages, &empty);
    walk(
        &tree.root,
        None,
        &mut Vec::new(),
        package,
        packages,
        &empty,
        &mut spans,
    );
    spans.sort_by_key(|span| (span.start, span.end));
    merge_adjacent(spans)
}

fn package_for<'a>(language: &str, packages: &'a PackageMap, empty: &'a Package) -> &'a Package {
    packages.get(language).unwrap_or(empty)
}

fn walk<'a>(
    node: &'a Node,
    parent: Option<&'a Node>,
    ancestors: &mut Vec<&'a Node>,
    package: &Package,
    packages: &PackageMap,
    empty: &Package,
    spans: &mut Vec<Span>,
) {
    if let Some(language) = node.language.as_deref() {
        walk_current(
            node,
            parent,
            &mut Vec::new(),
            package_for(language, packages, empty),
            packages,
            empty,
            spans,
        );
    } else {
        walk_current(node, parent, ancestors, package, packages, empty, spans);
    }
}

fn walk_current<'a>(
    node: &'a Node,
    parent: Option<&'a Node>,
    ancestors: &mut Vec<&'a Node>,
    package: &Package,
    packages: &PackageMap,
    empty: &Package,
    spans: &mut Vec<Span>,
) {
    if node.children.is_empty() {
        if matches!(node.kind.as_str(), "ERROR" | "MISSING") {
            emit(node.start, node.end, "error", spans);
            return;
        }
        if let Some(scope) = leaf_scope(node, parent, ancestors, package) {
            emit(node.start, node.end, scope, spans);
        }
        return;
    }

    ancestors.push(node);
    for child in &node.children {
        walk(
            child,
            Some(node),
            ancestors,
            package,
            packages,
            empty,
            spans,
        );
    }
    ancestors.pop();

    if node.kind == "ERROR" {
        backfill(node, "error", spans);
    } else if let Some(scope) = package.background.get(&node.kind) {
        backfill(node, scope, spans);
    }
}

fn leaf_scope<'a>(
    node: &Node,
    parent: Option<&Node>,
    ancestors: &[&Node],
    package: &'a Package,
) -> Option<&'a str> {
    package
        .context
        .iter()
        .find(|rule| context_matches(rule, node, parent, ancestors))
        .map(|rule| rule.scope.as_str())
        .or_else(|| package.leaf.get(&node.kind).map(String::as_str))
        .or_else(|| package.background.get(&node.kind).map(String::as_str))
}

fn context_matches(
    rule: &ContextRule,
    node: &Node,
    parent: Option<&Node>,
    ancestors: &[&Node],
) -> bool {
    optional_eq(
        rule.parent.as_deref(),
        parent.map(|node| node.kind.as_str()),
    ) && optional_eq(rule.field.as_deref(), node.field.as_deref())
        && optional_eq(
            rule.parent_field.as_deref(),
            parent.and_then(|node| node.field.as_deref()),
        )
        && optional_eq(rule.kind.as_deref(), Some(node.kind.as_str()))
        && rule.ancestor.as_ref().is_none_or(|kind| {
            ancestors
                .iter()
                .any(|ancestor| ancestor.kind.as_str() == kind)
        })
}

fn optional_eq(expected: Option<&str>, actual: Option<&str>) -> bool {
    expected.is_none_or(|expected| actual == Some(expected))
}

fn emit(start: usize, end: usize, scope: &str, spans: &mut Vec<Span>) {
    if start < end {
        spans.push(Span::new(start, end, scope));
    }
}

fn backfill(node: &Node, scope: &str, spans: &mut Vec<Span>) {
    if node.start >= node.end {
        return;
    }
    let mut ranges: Vec<_> = node
        .children
        .iter()
        .filter_map(|child| {
            let start = child.start.max(node.start);
            let end = child.end.min(node.end);
            (start < end).then_some((start, end))
        })
        .collect();
    ranges.sort_unstable();

    let mut cursor = node.start;
    for (start, end) in ranges {
        emit(cursor, start, scope, spans);
        cursor = cursor.max(end);
    }
    emit(cursor, node.end, scope, spans);
}

fn merge_adjacent(spans: Vec<Span>) -> Vec<Span> {
    let mut merged: Vec<Span> = Vec::with_capacity(spans.len());
    for span in spans {
        if let Some(previous) = merged.last_mut() {
            if previous.end == span.start && previous.scope == span.scope {
                previous.end = span.end;
                continue;
            }
        }
        merged.push(span);
    }
    merged
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn packages() -> PackageMap {
        HashMap::from([
            (
                "json".to_owned(),
                Package::load(include_str!("../../packages/json.highlight.json"))
                    .expect("shipped JSON package loads"),
            ),
            (
                "python".to_owned(),
                Package::load(include_str!("../../packages/python.highlight.json"))
                    .expect("shipped Python package loads"),
            ),
        ])
    }

    fn tree(raw: &str) -> TreeDoc {
        serde_json::from_str(raw).expect("test tree parses")
    }

    fn corpus_in(directory: &str, name: &str) -> TreeDoc {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../corpus")
            .join(directory)
            .join(name);
        let raw = std::fs::read_to_string(path).expect("corpus tree exists");
        tree(&raw)
    }

    fn corpus(name: &str) -> TreeDoc {
        corpus_in("trees", name)
    }

    fn dirty_corpus(name: &str) -> TreeDoc {
        corpus_in("trees-dirty", name)
    }

    fn injected_corpus(name: &str) -> TreeDoc {
        corpus_in("trees-injected", name)
    }

    fn span_scope(spans: &[Span], start: usize, end: usize) -> &str {
        spans
            .iter()
            .find(|span| span.start == start && span.end == end)
            .map(|span| span.scope.as_str())
            .expect("expected exact span")
    }

    fn scope_of_after(tree: &TreeDoc, spans: &[Span], text: &str, after: usize) -> String {
        let start = tree.source[after..]
            .find(text)
            .map(|start| start + after)
            .expect("text occurs in source region");
        span_scope(spans, start, start + text.len()).to_owned()
    }

    fn assert_partition(tree: &TreeDoc, package: &Package, spans: &[Span]) {
        for span in spans {
            assert!(span.start < span.end, "zero-width span: {span:?}");
            assert!(
                span.end <= tree.source.len(),
                "span outside source: {span:?}"
            );
            assert!(
                package.scopes.contains(&span.scope),
                "scope missing from package: {span:?}"
            );
        }
        for pair in spans.windows(2) {
            assert!(pair[0].end <= pair[1].start, "overlapping spans: {pair:?}");
            assert!(
                pair[0].end != pair[1].start || pair[0].scope != pair[1].scope,
                "unmerged spans: {pair:?}"
            );
        }
    }

    fn assert_map_partition(tree: &TreeDoc, packages: &PackageMap, spans: &[Span]) {
        for span in spans {
            assert!(
                span.scope == "error"
                    || packages
                        .values()
                        .any(|package| package.scopes.contains(&span.scope)),
                "scope missing from package map: {span:?}"
            );
        }
        for pair in spans.windows(2) {
            assert!(pair[0].end <= pair[1].start, "overlapping spans: {pair:?}");
        }
        assert!(
            spans.iter().all(|span| span.end <= tree.source.len()),
            "span outside source"
        );
    }

    #[test]
    fn compute_is_a_function_and_alpha_is_a_variable() {
        let tree = corpus("python__calls.tree.json");
        let packages = packages();
        let spans = highlight(&tree, &packages);
        assert_eq!(span_scope(&spans, 9, 16), "function");
        assert_eq!(span_scope(&spans, 17, 22), "variable");
        assert_partition(&tree, &packages["python"], &spans);
    }

    #[test]
    fn parent_field_distinguishes_chain_calls_from_plain_properties() {
        let tree = corpus("python__chains.tree.json");
        let packages = packages();
        let spans = highlight(&tree, &packages);
        let chain = tree.source.find("method_chain =").expect("method chain");
        for name in ["filter", "order_by", "limit", "offset", "all"] {
            assert_eq!(
                scope_of_after(&tree, &spans, name, chain),
                "function",
                "{name}"
            );
        }
        assert_eq!(scope_of_after(&tree, &spans, "attr", 0), "property");
        assert_partition(&tree, &packages["python"], &spans);
    }

    #[test]
    fn splat_names_are_parameters() {
        let tree = corpus("python__defs.tree.json");
        let packages = packages();
        let spans = highlight(&tree, &packages);
        let args = tree.source.find("*args").expect("args splat") + 1;
        let kwargs = tree.source.find("**kwargs").expect("kwargs splat") + 2;
        assert_eq!(span_scope(&spans, args, args + 4), "parameter");
        assert_eq!(span_scope(&spans, kwargs, kwargs + 6), "parameter");
        assert_partition(&tree, &packages["python"], &spans);
    }

    #[test]
    fn an_interior_background_paints_around_refined_children() {
        let tree = corpus("python__strings.tree.json");
        let packages = packages();
        let spans = highlight(&tree, &packages);
        let line_one = tree.source.find("line one").expect("escaped string");
        let newline = tree.source[line_one..]
            .find("\\n")
            .map(|offset| offset + line_one)
            .expect("newline escape");
        let line_two = newline + 2;
        let tab = tree.source[line_two..]
            .find("\\t")
            .map(|offset| offset + line_two)
            .expect("tab escape");
        let closing_quote = tree.source[tab + 2..]
            .find('"')
            .map(|offset| offset + tab + 3)
            .expect("closing quote");
        assert_eq!(span_scope(&spans, line_one - 1, newline), "string");
        assert_eq!(span_scope(&spans, newline, line_two), "string.escape");
        assert_eq!(span_scope(&spans, line_two, tab), "string");
        assert_eq!(span_scope(&spans, tab, tab + 2), "string.escape");
        assert_eq!(span_scope(&spans, tab + 2, closing_quote), "string");
        assert_partition(&tree, &packages["python"], &spans);
    }

    #[test]
    fn an_interior_leaf_default_does_not_paint_around_children() {
        let package = Package::load(
            r#"{
              "format":"et-highlight/1",
              "scopes":["keyword","parameter","punctuation","variable"],
              "leaf":{"lambda":"keyword",":":"punctuation","identifier":"variable"},
              "context":[
                {"parent":"lambda_parameters","type":"identifier","scope":"parameter"}
              ]
            }"#,
        )
        .expect("package loads");
        let tree = tree(
            r#"{
              "language":"toy", "source":"lambda x: x",
              "root":{"type":"module","start":0,"end":11,"children":[
                {"type":"lambda","start":0,"end":11,"children":[
                  {"type":"lambda","start":0,"end":6,"text":"lambda"},
                  {"type":"lambda_parameters","start":7,"end":8,"children":[
                    {"type":"identifier","start":7,"end":8,"text":"x"}
                  ]},
                  {"type":":","start":8,"end":9,"text":":"},
                  {"type":"identifier","start":10,"end":11,"text":"x"}
                ]}
              ]}
            }"#,
        );
        let packages = HashMap::from([("toy".to_owned(), package)]);
        let spans = highlight(&tree, &packages);
        assert_eq!(
            spans,
            vec![
                Span::new(0, 6, "keyword"),
                Span::new(7, 8, "parameter"),
                Span::new(8, 9, "punctuation"),
                Span::new(10, 11, "variable"),
            ]
        );
        assert_partition(&tree, &packages["toy"], &spans);
    }

    #[test]
    fn ancestor_is_existential_on_the_inclusive_parent_to_root_path() {
        let tree = tree(
            r#"{
              "language":"python", "source":"name",
              "root":{"type":"type","start":0,"end":4,"children":[
                {"type":"wrapper","start":0,"end":4,"children":[
                  {"type":"identifier","start":0,"end":4,"text":"name"}
                ]}
              ]}
            }"#,
        );
        let packages = packages();
        let spans = highlight(&tree, &packages);
        assert_eq!(span_scope(&spans, 0, 4), "type");
        assert_partition(&tree, &packages["python"], &spans);
    }

    #[test]
    fn a_missing_root_package_still_reaches_known_nested_languages() {
        let tree = injected_corpus("outer__injected_missing_root.tree.json");
        let packages = packages();
        let spans = highlight(&tree, &packages);
        assert_eq!(
            spans,
            vec![Span::new(0, 5, "property"), Span::new(8, 12, "constant"),]
        );
        assert_map_partition(&tree, &packages, &spans);
    }

    #[test]
    fn package_switches_are_nested_and_ancestor_stays_in_its_language_region() {
        let tree = injected_corpus("python__injected_json.tree.json");
        let packages = packages();
        let spans = highlight(&tree, &packages);
        assert_eq!(
            spans,
            vec![
                Span::new(0, 5, "type"),
                Span::new(6, 7, "punctuation"),
                Span::new(7, 11, "constant"),
                Span::new(12, 17, "variable"),
                Span::new(17, 18, "punctuation"),
                Span::new(19, 23, "type"),
            ]
        );
        assert_map_partition(&tree, &packages, &spans);
    }

    #[test]
    fn error_children_are_walked_and_only_child_range_leftovers_are_backfilled() {
        let tree = dirty_corpus("python__dirty_error_recovery.tree.json");
        let packages = packages();
        let spans = highlight(&tree, &packages);
        assert_eq!(
            spans,
            vec![
                Span::new(0, 3, "function"),
                Span::new(3, 4, "punctuation"),
                Span::new(5, 6, "number"),
                Span::new(6, 7, "error"),
                Span::new(7, 8, "operator"),
            ]
        );
        assert_partition(&tree, &packages["python"], &spans);
    }

    #[test]
    fn unknown_nodes_are_unpainted_and_never_stop_the_walk() {
        let tree = dirty_corpus("python__dirty_unknown_interior.tree.json");
        let packages = packages();
        let spans = highlight(&tree, &packages);
        assert_eq!(spans, vec![Span::new(0, 1, "variable")]);
        assert_partition(&tree, &packages["python"], &spans);
    }

    #[test]
    fn leaf_errors_are_painted_and_zero_width_missing_nodes_are_ignored() {
        let tree = dirty_corpus("python__dirty_leaf_error_missing.tree.json");
        let packages = packages();
        let spans = highlight(&tree, &packages);
        assert_eq!(spans, vec![Span::new(0, 3, "error")]);
        assert_partition(&tree, &packages["python"], &spans);
    }

    #[test]
    fn error_backfill_keeps_separated_leftover_runs_separate() {
        let tree = dirty_corpus("python__dirty_error_two_runs.tree.json");
        let packages = packages();
        let spans = highlight(&tree, &packages);
        assert_eq!(
            spans,
            vec![
                Span::new(0, 1, "error"),
                Span::new(1, 2, "variable"),
                Span::new(2, 3, "error"),
            ]
        );
        assert_partition(&tree, &packages["python"], &spans);
    }

    #[test]
    fn first_listed_context_rule_wins_and_adjacent_scopes_merge() {
        let package = Package::load(
            r#"{
              "format":"et-highlight/1", "scopes":["first","second","error"],
              "leaf":{"name":"second"},
              "context":[
                {"type":"name","scope":"first"},
                {"type":"name","scope":"second"}
              ]
            }"#,
        )
        .expect("package loads");
        let tree = tree(
            r#"{
              "language":"toy", "source":"ab",
              "root":{"type":"file","start":0,"end":2,"children":[
                {"type":"name","start":0,"end":1,"text":"a"},
                {"type":"name","start":1,"end":2,"text":"b"}
              ]}
            }"#,
        );
        let packages = HashMap::from([("toy".to_owned(), package)]);
        let spans = highlight(&tree, &packages);
        assert_eq!(spans, vec![Span::new(0, 2, "first")]);
        assert_partition(&tree, &packages["toy"], &spans);
    }
}
