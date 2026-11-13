
use dna_indexer::genbank;
use std::path::PathBuf;

fn fixture(name: &str) -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("test-fixtures")
        .join("genbank")
        .join(name);
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

#[test]
#[ignore]
fn parse_hbb_human() {
    let Some(p) = fixture("hbb_human.gb") else {
        panic!("hbb_human.gb missing — run scripts/fetch-fixtures.sh first");
    };
    let records = genbank::parse_genbank(&p).expect("HBB parse");
    assert!(!records.is_empty());
    let cds_count = records[0]
        .features
        .iter()
        .filter(|f| f.feature_type == "CDS")
        .count();
    assert!(cds_count >= 1, "HBB has at least one CDS");
}

#[test]
#[ignore]
fn parse_pax6_human_multi_isoform() {
    let Some(p) = fixture("pax6_human.gb") else {
        panic!("pax6_human.gb missing — run scripts/fetch-fixtures.sh");
    };
    let records = genbank::parse_genbank(&p).expect("PAX6 parse");
    let mrna_count = records[0]
        .features
        .iter()
        .filter(|f| f.feature_type.eq_ignore_ascii_case("mRNA"))
        .count();
    assert!(
        mrna_count >= 2,
        "PAX6 expected ≥2 mRNAs, got {}",
        mrna_count
    );
}

#[test]
#[ignore]
fn parse_mt_genome_human_complement_features() {
    let Some(p) = fixture("mt_genome_human.gb") else {
        panic!("mt_genome_human.gb missing — run scripts/fetch-fixtures.sh");
    };
    let records = genbank::parse_genbank(&p).expect("mt parse");
    assert!(records[0].length > 16_000, "mt genome expected ~16.5 Kb");
    let minus_strand_count = records[0]
        .features
        .iter()
        .filter(|f| matches!(f.strand, dna_indexer::model::Strand::Minus))
        .count();
    assert!(
        minus_strand_count >= 1,
        "mt genome has minus-strand features (e.g. ND6)"
    );
}

#[test]
#[ignore]
fn parse_pbr322_or_synthetic_circular() {
    let Some(p) = fixture("pbr322.gb") else {
        panic!("pbr322.gb missing — run scripts/fetch-fixtures.sh");
    };
    let records = genbank::parse_genbank(&p).expect("pBR322 parse");
    assert!(!records.is_empty());
    assert!(records[0].length > 4_000 && records[0].length < 5_000);
}
