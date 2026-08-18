macro_rules! make_pair {
    ($name:ident, $value:expr) => {
        let $name = ($value, stringify!($name));
    };
}

fn macro_probe() {
    make_pair!(answer, 42);
    make_pair!(message, "hello");

    // Macro invocations are Rust-specific syntax with opaque token bodies.
    let values = vec![answer, message, another_value, yet_another_value];
    consume(values);
}
