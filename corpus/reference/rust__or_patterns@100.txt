// An or-pattern that cannot fit one line. rustfmt packs alternatives per line
// and puts the `|` at the *start* of each continuation line, so the separator
// leads rather than trails. No arm carries a leading pipe here: token deletion
// is `leading_pipes.rs`, and mixing the two would hide this construct behind an
// incomparable declaration.
fn classify(tag: Tag) -> &'static str {
    match tag {
        LongVariantNameOne | LongVariantNameTwo | LongVariantNameThree | LongVariantNameFour => {
            "wide"
        }
        ShortOne | ShortTwo => "narrow",
        Alpha | Beta | Gamma | Delta | Epsilon | Zeta | Eta | Theta | Iota | Kappa => "greek",
        _ => "other",
    }
}
