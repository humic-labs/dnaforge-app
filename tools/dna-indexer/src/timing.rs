
use std::sync::OnceLock;
use std::time::Instant;

fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("DNA_INDEXER_TIMINGS").is_some_and(|v| v != "0"))
}

pub struct Span {
    label: String,
    started: Instant,
}

pub fn span(label: impl Into<String>) -> Option<Span> {
    enabled().then(|| Span {
        label: label.into(),
        started: Instant::now(),
    })
}

impl Drop for Span {
    fn drop(&mut self) {
        eprintln!(
            "{{\"timing\":\"{}\",\"ms\":{:.1}}}",
            self.label,
            self.started.elapsed().as_secs_f64() * 1000.0
        );
    }
}
