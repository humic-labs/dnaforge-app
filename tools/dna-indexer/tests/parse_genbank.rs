
use dna_indexer::{
    genbank,
    model::{Strand, Topology},
};
use std::path::PathBuf;

fn fixture(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(rel)
}

#[test]
fn parse_puc19_smoke() {
    let path = fixture("test-fixtures/sequences/circular/pUC19.gb");
    let records = genbank::parse_genbank(&path).expect("pUC19 should parse");
    assert_eq!(records.len(), 1, "pUC19 is a single-record GenBank file");
    let rec = &records[0];
    assert_eq!(rec.length, 2686, "pUC19 is 2686 bp");
    assert_eq!(rec.topology, Topology::Circular);
    assert!(!rec.features.is_empty(), "pUC19 has annotated features");
    let cds_count = rec
        .features
        .iter()
        .filter(|f| f.feature_type == "CDS")
        .count();
    assert!(
        cds_count >= 1,
        "pUC19 should have at least one CDS, got {}",
        cds_count
    );
}

#[test]
fn parse_forward_strand_two_exon_synthetic() {
    let path = fixture("test-fixtures/sequences/circular/forward-strand-two-exon-synthetic.gb");
    let records = genbank::parse_genbank(&path).unwrap();
    let rec = &records[0];
    assert_eq!(rec.length, 500);
    assert_eq!(rec.topology, Topology::Circular);

    let cds = rec
        .features
        .iter()
        .find(|f| f.feature_type == "CDS")
        .expect("forward_two_exon CDS should be present");

    assert_eq!(cds.strand, Strand::Plus, "forward-strand CDS");
    assert_eq!(
        cds.intervals.len(),
        2,
        "join(1..50, 451..500) flattens to 2 intervals"
    );
    assert_eq!(cds.intervals[0].start, 1);
    assert_eq!(cds.intervals[0].end, 50);
    assert_eq!(cds.intervals[1].start, 451);
    assert_eq!(cds.intervals[1].end, 500);
    assert_eq!(cds.qualifier("label"), Some("fwd_two_exon"));
    assert!(cds.location_string.contains("join"));
}

#[test]
fn parse_complement_order_boundary_synthetic() {
    let path = fixture("test-fixtures/sequences/circular/complement-order-boundary-synthetic.gb");
    let records = genbank::parse_genbank(&path).unwrap();
    let rec = &records[0];
    assert_eq!(rec.length, 500);

    let cds = rec
        .features
        .iter()
        .find(|f| f.feature_type == "CDS")
        .expect("order_test CDS should be present");

    assert_eq!(cds.strand, Strand::Minus, "complement-strand CDS");
    assert!(
        cds.location_string.contains("order"),
        "location_string should preserve order(...), got: {}",
        cds.location_string
    );
    assert!(cds.location_string.starts_with("complement("));
    assert_eq!(cds.qualifier("label"), Some("order_test"));
}

#[test]
fn parse_origin_wrap_join_three_features() {
    let path = fixture("test-fixtures/sequences/circular/origin-wrap-join-synthetic.gb");
    let records = genbank::parse_genbank(&path).unwrap();
    let rec = &records[0];
    assert_eq!(rec.length, 500);
    assert_eq!(rec.topology, Topology::Circular);

    let labels: Vec<&str> = rec
        .features
        .iter()
        .filter(|f| f.feature_type == "CDS")
        .filter_map(|f| f.qualifier("label"))
        .collect();
    assert!(labels.contains(&"ura3_like"), "ura3_like CDS present");
    assert!(
        labels.contains(&"interior_splice"),
        "interior_splice CDS present"
    );
    assert!(labels.contains(&"forward_wrap"), "forward_wrap CDS present");

    let ura3 = rec
        .features
        .iter()
        .find(|f| f.qualifier("label") == Some("ura3_like"))
        .unwrap();
    assert_eq!(ura3.strand, Strand::Minus);
    assert_eq!(ura3.intervals.len(), 2);
    assert_eq!(ura3.intervals[0].start, 451);
    assert_eq!(ura3.intervals[0].end, 500);
    assert_eq!(ura3.intervals[1].start, 1);
    assert_eq!(ura3.intervals[1].end, 50);

    let fwd = rec
        .features
        .iter()
        .find(|f| f.qualifier("label") == Some("forward_wrap"))
        .unwrap();
    assert_eq!(fwd.strand, Strand::Plus);
    assert_eq!(fwd.intervals[0].start, 451);
    assert_eq!(fwd.intervals[1].start, 1);
}

#[test]
fn parse_origin_spanning_synthetic() {
    let path = fixture("test-fixtures/sequences/circular/origin-spanning-synthetic.gb");
    let records = genbank::parse_genbank(&path).expect("origin-spanning fixture parses");
    assert!(!records.is_empty());
}

#[test]
fn colon_locus_names_keep_name_and_circular_topology() {
    let kit = "apps/desktop/resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-cidar";
    for (stem, expected) in [
        ("pJ02B2Gm_Rm_AF", "pJ02B2Gm:Rm_AF"),
        ("pJ02B2Rm_Gm_AF", "pJ02B2Rm:Gm_AF"),
    ] {
        let records = genbank::parse_genbank(&fixture(&format!("{kit}/{stem}/{stem}.gb"))).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, expected);
        assert_eq!(records[0].topology, Topology::Circular);
        assert_eq!(records[0].length, 4033);
    }
}

#[test]
fn colon_locus_names_map_to_their_own_records() {
    let body = "FEATURES             Location/Qualifiers\n     misc_feature    1..4\n                     /label=\"part\"\nORIGIN\n        1 acgtacgtac\n//\n";
    let text = [
        format!("LOCUS       a:b          10 bp    DNA     circular SYN 06-AUG-2018\n{body}"),
        format!("LOCUS       plain        10 bp    DNA     linear   SYN 06-AUG-2018\n{body}"),
        format!("LOCUS       c:d:e        10 bp    DNA     circular SYN 06-AUG-2018\n{body}"),
    ]
    .concat();
    let path = std::env::temp_dir().join(format!("dna-indexer-colon-locus-{}.gb", std::process::id()));
    std::fs::write(&path, text).unwrap();
    let records = genbank::parse_genbank(&path);
    std::fs::remove_file(&path).unwrap();
    let records = records.unwrap();
    let summary: Vec<(&str, Topology)> = records.iter().map(|r| (r.name.as_str(), r.topology)).collect();
    assert_eq!(
        summary,
        vec![
            ("a:b", Topology::Circular),
            ("plain", Topology::Linear),
            ("c:d:e", Topology::Circular),
        ]
    );
}
