// What does a *Rust* host's C library think a space is?
//
// tree-sitter's external scanners for css/javascript/kotlin/rust/markdown-block
// call iswspace()/iswalpha()/iswalnum() from <wctype.h>.  Those consult the
// process's LC_CTYPE.  Rust's std never calls setlocale, so a Rust binary runs
// in the C locale -- ASCII-only classification -- unless something else in the
// process sets one.  CPython *does* set it from the environment.
//
// Build and run:  rustc -O -o host_ctype host_ctype.rs && ./host_ctype
// No crates; the three symbols are declared directly.

use std::ffi::{c_char, c_int, CStr};

extern "C" {
    fn setlocale(category: c_int, locale: *const c_char) -> *mut c_char;
    fn iswspace(wc: c_int) -> c_int;
    fn iswalpha(wc: c_int) -> c_int;
}

const LC_CTYPE: c_int = 0; // glibc

fn main() {
    unsafe {
        let cur = setlocale(LC_CTYPE, std::ptr::null());
        println!("rust host default LC_CTYPE = {:?}", CStr::from_ptr(cur));
        for (name, cp) in [
            ("U+0020 SPACE (control)", 0x20),
            ("U+2003 EM SPACE", 0x2003),
            ("U+3000 IDEOGRAPHIC SPACE", 0x3000),
            ("U+03B1 GREEK SMALL ALPHA", 0x03B1),
            ("U+00E9 e-acute", 0x00E9),
        ] {
            println!(
                "  {name:26} iswspace={} iswalpha={}",
                iswspace(cp) != 0,
                iswalpha(cp) != 0
            );
        }
    }
}
