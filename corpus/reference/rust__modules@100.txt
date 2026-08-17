pub mod parser {
    pub mod tokens {
        pub struct Token {
            pub kind: Kind,
            pub text: String,
        }
    }

    pub enum Kind {
        Identifier,
        Punctuation,
    }
}

// The use forms are written in rustfmt's own order: it sorts import siblings,
// which linearity forbids a package from reproducing, so only their layout is
// measured here. The braced group is 85 columns, so it breaks at width 60 and
// stays flat at 100.
pub use crate::parser::tokens::Token as PublicToken;
use crate::parser::tokens::{Token, TokenBuffer, TokenCursor, TokenKind, TokenStream};
use crate::parser::Kind as TokenCategory;
use std::collections::hash_map::{self, Entry, HashMap};
use std::fmt;
use std::io::prelude::*;

// Module paths and visibility are characteristic Rust item structure.
impl fmt::Display for Token {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(output, "{}", self.text)
    }
}
