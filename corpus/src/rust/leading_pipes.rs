// rustfmt deletes a leading `|` on a match arm, which
// linearity forbids a package from reproducing. Every
// arm carries a leading pipe; the file is declared
// incomparable rather than omitting the construct.
fn classify(value: i32) -> &'static str {
    match value {
        | 1 => "one",
        | 2 | 3 => "two or three",
        | _ => "other",
    }
}
