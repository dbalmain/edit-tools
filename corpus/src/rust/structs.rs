#[derive(Clone, Debug, PartialEq)]
struct Settings {
    short: bool, // enable the short path
    much_longer_setting_name: String, // preserve the user's label
    retries: u32, // number of attempts
    timeout_millis: u64, // network timeout
}

impl Settings {
    fn with_defaults() -> Self {
        Self {
            short: true,
            much_longer_setting_name: String::from("default"),
            retries: 3,
            timeout_millis: 5000,
        }
    }
}

fn struct_probe(settings: Settings) {
    // Trailing comments make rustfmt align sibling fields.
    consume(settings);
}
