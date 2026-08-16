enum Event {
    Started,
    Received { source: String, bytes: usize },
    Failed { code: u16, message: String },
    Finished,
}

fn describe(event: Event) -> &'static str {
    match event {
        Event::Started => "started",
        Event::Received { source, bytes } => {
            // A comment inside a block arm must stay attached to the arm.
            consume(source, bytes);
            "received"
        }
        Event::Failed { code, message } if code >= 500 => {
            consume(message);
            "server failure"
        }
        Event::Failed { code, message } => {
            consume(code, message);
            "failure"
        }
        Event::Finished => "finished",
    }
}
