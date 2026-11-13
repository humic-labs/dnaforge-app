
use dna_indexer::error::IndexerError;
use std::path::PathBuf;

fn read_doc() -> String {
    let doc_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("docs")
        .join("INDEXED_GENOME_FORMAT.md");
    std::fs::read_to_string(&doc_path)
        .unwrap_or_else(|e| panic!("Failed to read {}: {}", doc_path.display(), e))
}

#[test]
fn every_error_code_is_documented() {
    let doc = read_doc();
    let mut missing: Vec<&'static str> = Vec::new();
    for code in IndexerError::ALL_CODES {
        if !doc.contains(code) {
            missing.push(code);
        }
    }
    assert!(
        missing.is_empty(),
        "These error codes are NOT documented in docs/INDEXED_GENOME_FORMAT.md: {:?}.\n\
         Add a row to the 'Codes (enumerated)' table or remove the variant from IndexerError.",
        missing
    );
}

#[test]
fn every_warning_code_is_documented() {
    let doc = read_doc();
    let mut missing: Vec<&'static str> = Vec::new();
    for code in IndexerError::ALL_WARNING_CODES {
        if !doc.contains(code) {
            missing.push(code);
        }
    }
    assert!(
        missing.is_empty(),
        "These warning codes are NOT documented in docs/INDEXED_GENOME_FORMAT.md: {:?}.\n\
         Add a row to the 'Codes (enumerated)' table or remove from ALL_WARNING_CODES.",
        missing
    );
}
