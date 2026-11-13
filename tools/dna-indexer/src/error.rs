// requires that every failure mode write one JSON object per line to stderr

use serde::Serialize;
use std::collections::BTreeMap;
use std::io::Write;
use thiserror::Error;

#[derive(Debug, Clone, Error)]
pub enum IndexerError {
    #[error("GENBANK_PARSE_FAILED: {0}")]
    GenbankParseFailed(String),

    #[error("OUTPUT_WRITE_FAILED: {0}")]
    OutputWriteFailed(String),

    #[error("BGZF_WRITE_FAILED: {0}")]
    BgzfWriteFailed(String),

    #[error("UNSUPPORTED_INPUT_FORMAT: {0}")]
    UnsupportedInputFormat(String),

    #[error("WORKSPACE_CONTAINMENT_VIOLATION: {0}")]
    WorkspaceContainmentViolation(String),
}

impl IndexerError {
    pub fn code(&self) -> &'static str {
        match self {
            IndexerError::GenbankParseFailed(_) => "GENBANK_PARSE_FAILED",
            IndexerError::OutputWriteFailed(_) => "OUTPUT_WRITE_FAILED",
            IndexerError::BgzfWriteFailed(_) => "BGZF_WRITE_FAILED",
            IndexerError::UnsupportedInputFormat(_) => "UNSUPPORTED_INPUT_FORMAT",
            IndexerError::WorkspaceContainmentViolation(_) => "WORKSPACE_CONTAINMENT_VIOLATION",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            IndexerError::GenbankParseFailed(m)
            | IndexerError::OutputWriteFailed(m)
            | IndexerError::BgzfWriteFailed(m)
            | IndexerError::UnsupportedInputFormat(m)
            | IndexerError::WorkspaceContainmentViolation(m) => m,
        }
    }

    pub const ALL_CODES: &'static [&'static str] = &[
        "GENBANK_PARSE_FAILED",
        "OUTPUT_WRITE_FAILED",
        "BGZF_WRITE_FAILED",
        "UNSUPPORTED_INPUT_FORMAT",
        "WORKSPACE_CONTAINMENT_VIOLATION",
    ];

    pub const ALL_WARNING_CODES: &'static [&'static str] =
        &["INFERENCE_AMBIGUOUS", "FEATURE_SKIPPED_EXTERNAL_LOCATION"];
}

#[derive(Debug, Serialize)]
struct ErrorJson<'a> {
    level: &'a str,
    code: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    context: &'a BTreeMap<String, serde_json::Value>,
}

pub fn to_json_stderr(err: &IndexerError, context: &BTreeMap<String, serde_json::Value>) {
    let obj = ErrorJson {
        level: "error",
        code: err.code(),
        message: err.message(),
        context,
    };
    let line = serde_json::to_string(&obj).unwrap_or_else(|_| {
        format!(
            "{{\"level\":\"error\",\"code\":\"{}\",\"message\":\"<serialize failed>\"}}",
            err.code()
        )
    });
    let _ = writeln!(std::io::stderr(), "{}", line);
}

pub fn warning_json_stderr(
    code: &str,
    message: &str,
    context: &BTreeMap<String, serde_json::Value>,
) {
    #[derive(Serialize)]
    struct W<'a> {
        level: &'a str,
        code: &'a str,
        message: &'a str,
        #[serde(skip_serializing_if = "BTreeMap::is_empty")]
        context: &'a BTreeMap<String, serde_json::Value>,
    }
    let payload = W {
        level: "warning",
        code,
        message,
        context,
    };
    if let Ok(line) = serde_json::to_string(&payload) {
        let _ = writeln!(std::io::stderr(), "{}", line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_code_strings_match_variants() {
        assert_eq!(
            IndexerError::GenbankParseFailed("x".into()).code(),
            "GENBANK_PARSE_FAILED"
        );
        assert_eq!(
            IndexerError::OutputWriteFailed("x".into()).code(),
            "OUTPUT_WRITE_FAILED"
        );
        assert_eq!(
            IndexerError::BgzfWriteFailed("x".into()).code(),
            "BGZF_WRITE_FAILED"
        );
        assert_eq!(
            IndexerError::UnsupportedInputFormat("x".into()).code(),
            "UNSUPPORTED_INPUT_FORMAT"
        );
        assert_eq!(
            IndexerError::WorkspaceContainmentViolation("x".into()).code(),
            "WORKSPACE_CONTAINMENT_VIOLATION"
        );
    }

    #[test]
    fn error_display_includes_code_prefix() {
        let e = IndexerError::GenbankParseFailed("bad header".into());
        let s = format!("{}", e);
        assert!(s.starts_with("GENBANK_PARSE_FAILED: "));
        assert!(s.contains("bad header"));
        assert_eq!(e.message(), "bad header");
    }

    #[test]
    fn all_codes_constant_matches_variants() {
        let variants_count = 5;
        assert_eq!(IndexerError::ALL_CODES.len(), variants_count);
    }
}
