
use anyhow::Context;
use dna_indexer::error::IndexerError;
use dna_indexer::{genbank, gff_emit, model::Topology, output};
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

fn tmpfile(test: &str, contents: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "dna-indexer-edge-{}-{}-{}.gb",
        test,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut f = File::create(&path).unwrap();
    f.write_all(contents.as_bytes()).unwrap();
    path
}

fn synth_genbank(
    name: &str,
    length: usize,
    topology: &str,
    features: &str,
    sequence: &str,
) -> String {
    let mut s = format!(
        "LOCUS       {:24}{} bp    DNA     {} SYN 01-JAN-2026\n",
        name, length, topology
    );
    s.push_str("FEATURES             Location/Qualifiers\n");
    s.push_str(features);
    s.push_str("ORIGIN\n");
    for (i, chunk) in sequence.as_bytes().chunks(60).enumerate() {
        s.push_str(&format!("{:>9} ", i * 60 + 1));
        let line = std::str::from_utf8(chunk).unwrap();
        s.push_str(line);
        s.push('\n');
    }
    s.push_str("//\n");
    s
}

#[test]
fn empty_features_table_parses_to_zero_features() {
    let gb = synth_genbank("empty", 100, "linear", "", &"a".repeat(100));
    let path = tmpfile("empty_features", &gb);
    let records = genbank::parse_genbank(&path).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].features.len(), 0);
    assert_eq!(records[0].length, 100);
    let _ = std::fs::remove_file(path);
}

#[test]
fn non_ascii_in_qualifier_value_does_not_panic() {
    let features = "     source          1..50\n\
                    \x20                    /organism=\"Caenorhabditis elegans\"\n";
    let gb = synth_genbank("ascii", 50, "linear", features, &"a".repeat(50));
    let path = tmpfile("non_ascii", &gb);
    let records = genbank::parse_genbank(&path).unwrap();
    let f = &records[0].features[0];
    let organism = f.qualifier("organism").unwrap_or("");
    assert!(
        organism.contains("Caenorhabditis"),
        "ASCII subset of qualifier preserved: got {:?}",
        organism
    );

    let _out = gff_emit::emit_gff3(&records[0], "test", "0.0.0");
    let _ = std::fs::remove_file(path);
}

#[test]
fn long_qualifier_value_parses_and_survives_emit() {
    let long_value: String = "M".repeat(10_000);
    let features = format!(
        "     CDS             1..3000\n                     /translation=\"{}\"\n",
        long_value
    );
    let gb = synth_genbank("longq", 3000, "linear", &features, &"a".repeat(3000));
    let path = tmpfile("long_qualifier", &gb);
    let records = genbank::parse_genbank(&path).unwrap();
    let f = &records[0].features[0];
    let translation = f.qualifier("translation").unwrap();
    assert_eq!(translation.len(), 10_000, "qualifier value preserved");

    let out = gff_emit::emit_gff3(&records[0], "test", "0.0.0");
    assert!(
        out.len() > 10_000,
        "emit output should contain the long qualifier"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn multi_record_file_parses_every_record() {
    let mut gb = synth_genbank("first", 50, "linear", "", &"a".repeat(50));
    gb.push_str(&synth_genbank("second", 30, "linear", "", &"c".repeat(30)));
    let path = tmpfile("multi_record", &gb);
    let records = genbank::parse_genbank(&path).unwrap();
    assert_eq!(records.len(), 2, "parser surfaces all records");
    assert_eq!(records[0].name, "first");
    assert_eq!(records[0].length, 50);
    assert_eq!(records[1].name, "second");
    assert_eq!(records[1].length, 30);
    let _ = std::fs::remove_file(path);
}

#[test]
fn invalid_genbank_returns_structured_error() {
    let path = tmpfile("invalid", "this is not GenBank format at all\n");
    let err = genbank::parse_genbank(&path).unwrap_err();
    let typed = err.downcast_ref::<IndexerError>();
    assert!(
        typed.is_some(),
        "expected IndexerError, got plain anyhow: {}",
        err
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn nonexistent_input_returns_structured_error() {
    let path = PathBuf::from("/this/path/does/not/exist.gb");
    let err = genbank::parse_genbank(&path).unwrap_err();
    let typed = err.downcast_ref::<IndexerError>();
    assert!(typed.is_some(), "expected IndexerError, got: {}", err);
    if let Some(e) = typed {
        assert_eq!(e.code(), "GENBANK_PARSE_FAILED");
    }
}

#[test]
fn feature_with_no_qualifiers_emits_minimal_row() {
    let features = "     misc_feature    100..200\n";
    let gb = synth_genbank("noqual", 500, "linear", features, &"a".repeat(500));
    let path = tmpfile("no_qualifiers", &gb);
    let records = genbank::parse_genbank(&path).unwrap();
    assert_eq!(records[0].features.len(), 1);
    assert!(records[0].features[0].qualifiers.is_empty());

    let out = gff_emit::emit_gff3(&records[0], "chrX", "0.0.0");
    let data_line = out.lines().find(|l| !l.starts_with("##")).unwrap();
    assert!(
        data_line.contains("ID=cchrX_100-200_F_misc_feature"),
        "missing coordinate-hash ID; got: {}",
        data_line
    );
    assert!(data_line.contains("_lane="));
    let _ = std::fs::remove_file(path);
}

#[test]
fn header_only_record_has_empty_sequence() {
    let mut gb = String::new();
    gb.push_str("LOCUS       hdronly                  50 bp    DNA     linear SYN 01-JAN-2026\n");
    gb.push_str("FEATURES             Location/Qualifiers\n");
    gb.push_str("     misc_feature    1..50\n");
    gb.push_str("//\n");
    let path = tmpfile("header_only", &gb);
    let records = genbank::parse_genbank(&path).unwrap();
    assert_eq!(
        records[0].sequence.len(),
        0,
        "header-only record has empty seq"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn very_short_sequence_indexes_cleanly() {
    let features = "     CDS             1..9\n                     /gene=\"tiny\"\n";
    let gb = synth_genbank("short", 10, "linear", features, "acgtacgtac");
    let path = tmpfile("very_short", &gb);
    let records = genbank::parse_genbank(&path).unwrap();
    assert_eq!(records[0].length, 10);

    let mut out_dir = std::env::temp_dir();
    out_dir.push(format!("dna-indexer-short-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out_dir);
    let outcome = output::write_bundle(&records[0], &out_dir, "short", "0.0.0").unwrap();
    assert!(outcome.fa_path.exists());
    assert!(outcome.gz_path.exists());
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_dir_all(&out_dir);
}

#[test]
fn circular_topology_preserved_through_parse() {
    let gb = synth_genbank("circ", 100, "circular", "", &"a".repeat(100));
    let path = tmpfile("circular", &gb);
    let records = genbank::parse_genbank(&path).unwrap();
    assert_eq!(records[0].topology, Topology::Circular);
    let _ = std::fs::remove_file(path);
}

#[test]
fn linear_topology_preserved_through_parse() {
    let gb = synth_genbank("lin", 100, "linear", "", &"a".repeat(100));
    let path = tmpfile("linear", &gb);
    let records = genbank::parse_genbank(&path).unwrap();
    assert_eq!(records[0].topology, Topology::Linear);
    let _ = std::fs::remove_file(path);
}

#[test]
fn multipart_minus_strand_mrna_emits_exons_in_reading_order() {
    let mut features = String::new();
    features.push_str("     mRNA            complement(join(50..100,200..300,400..500))\n");
    features.push_str("                     /gene=\"X\"\n");
    let gb = synth_genbank("multmin", 500, "linear", &features, &"a".repeat(500));
    let path = tmpfile("multipart_minus", &gb);
    let records = genbank::parse_genbank(&path).unwrap();

    let out = gff_emit::emit_gff3(&records[0], "chrX", "0.0.0");
    let exon_rows: Vec<&str> = out
        .lines()
        .filter(|l| !l.starts_with("##"))
        .filter(|l| l.split('\t').nth(2) == Some("exon"))
        .collect();
    assert_eq!(
        exon_rows.len(),
        3,
        "expected 3 derived exons, got {}",
        exon_rows.len()
    );

    for row in &exon_rows {
        let cols: Vec<&str> = row.split('\t').collect();
        assert_eq!(cols[6], "-", "exon row not minus strand: {}", row);
    }

    let suffix_for = |range: &str| -> Option<String> {
        out.lines()
            .filter(|l| !l.starts_with("##") && l.contains(range))
            .find(|l| l.split('\t').nth(2) == Some("exon"))
            .and_then(|l| {
                l.split('\t')
                    .nth(8)?
                    .split(';')
                    .find(|a| a.starts_with("ID="))
                    .map(|s| s.to_string())
            })
    };
    let high_part = suffix_for("\t400\t500\t").expect("400..500 exon row");
    let mid_part = suffix_for("\t200\t300\t").expect("200..300 exon row");
    let low_part = suffix_for("\t50\t100\t").expect("50..100 exon row");
    assert!(
        high_part.contains("-0"),
        "5' part should be -0: {}",
        high_part
    );
    assert!(
        mid_part.contains("-1"),
        "middle part should be -1: {}",
        mid_part
    );
    assert!(
        low_part.contains("-2"),
        "3' part should be -2: {}",
        low_part
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn empty_value_qualifier_skipped_in_emit() {
    let mut features = String::new();
    features.push_str("     gene            1..100\n");
    features.push_str("                     /gene=\"P\"\n");
    features.push_str("                     /pseudo\n");
    let gb = synth_genbank("pseudo", 100, "linear", &features, &"a".repeat(100));
    let path = tmpfile("empty_value_qual", &gb);
    let records = genbank::parse_genbank(&path).unwrap();

    let out = gff_emit::emit_gff3(&records[0], "chrX", "0.0.0");
    let data_line = out
        .lines()
        .find(|l| !l.starts_with("##") && l.contains("gene=P"))
        .unwrap();
    assert!(
        !data_line.contains(";pseudo=") && !data_line.contains(";pseudo;"),
        "empty-value qualifier leaked into GFF3 attributes: {}",
        data_line
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn two_mrnas_each_get_own_derived_exon_clusters() {
    let mut features = String::new();
    features.push_str("     mRNA            join(100..200,400..500)\n");
    features.push_str("                     /gene=\"HBB\"\n");
    features.push_str("     mRNA            join(150..250,450..550)\n");
    features.push_str("                     /gene=\"HBB\"\n");
    let gb = synth_genbank("twomrna", 600, "linear", &features, &"a".repeat(600));
    let path = tmpfile("two_mrnas", &gb);
    let records = genbank::parse_genbank(&path).unwrap();

    let out = gff_emit::emit_gff3(&records[0], "chrZ", "0.0.0");
    let ids: Vec<String> = out
        .lines()
        .filter(|l| !l.starts_with("##"))
        .filter(|l| l.split('\t').nth(2) == Some("exon"))
        .filter_map(|l| {
            l.split('\t')
                .nth(8)?
                .split(';')
                .find(|a| a.starts_with("ID=HBB.exon."))
                .map(|s| s.to_string())
        })
        .collect();
    assert_eq!(
        ids.len(),
        4,
        "expected 4 exon rows total, got {}: {:?}",
        ids.len(),
        ids
    );
    let cluster1 = ids.iter().filter(|s| s.contains("HBB.exon.1-")).count();
    let cluster2 = ids.iter().filter(|s| s.contains("HBB.exon.2-")).count();
    assert_eq!(cluster1, 2, "HBB.exon.1 should have 2 part rows");
    assert_eq!(cluster2, 2, "HBB.exon.2 should have 2 part rows");
    let _ = std::fs::remove_file(path);
}

#[test]
fn parent_links_match_corresponding_mrna_ordinals() {
    let mut features = String::new();
    features.push_str("     mRNA            join(100..200,400..500)\n");
    features.push_str("                     /gene=\"HBB\"\n");
    features.push_str("     mRNA            join(150..250,450..550)\n");
    features.push_str("                     /gene=\"HBB\"\n");
    let gb = synth_genbank("parentmap", 600, "linear", &features, &"a".repeat(600));
    let path = tmpfile("parent_links", &gb);
    let records = genbank::parse_genbank(&path).unwrap();

    let out = gff_emit::emit_gff3(&records[0], "chrZ", "0.0.0");

    let row_100 = out
        .lines()
        .find(|l| !l.starts_with("##") && l.contains("\t100\t200\t") && l.contains("\texon\t"))
        .expect("exon row at 100..200");
    assert!(
        row_100.contains("Parent=HBB.mrna.1"),
        "100..200 exon should Parent=HBB.mrna.1: {}",
        row_100
    );

    let row_150 = out
        .lines()
        .find(|l| !l.starts_with("##") && l.contains("\t150\t250\t") && l.contains("\texon\t"))
        .expect("exon row at 150..250");
    assert!(
        row_150.contains("Parent=HBB.mrna.2"),
        "150..250 exon should Parent=HBB.mrna.2: {}",
        row_150
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn anyhow_with_context_preserves_indexer_error_downcast() {
    let path = PathBuf::from("/nonexistent.gb");
    let err = genbank::parse_genbank(&path)
        .with_context(|| "outer context layer")
        .unwrap_err();

    let typed = err.downcast_ref::<IndexerError>();
    assert!(
        typed.is_some(),
        "IndexerError must survive .with_context() wrap; got plain anyhow: {}",
        err
    );
    assert_eq!(
        typed.unwrap().code(),
        "GENBANK_PARSE_FAILED",
        "downcast yielded wrong variant"
    );
}

#[test]
fn external_location_feature_skipped_with_warning_not_panic() {
    let gb = synth_genbank(
        "noext",
        100,
        "linear",
        "     source          1..100\n                     /organism=\"test\"\n",
        &"a".repeat(100),
    );
    let path = tmpfile("no_external", &gb);
    let records = genbank::parse_genbank(&path).unwrap();
    assert_eq!(
        records[0].features.len(),
        1,
        "non-External features unaffected"
    );
    let _ = std::fs::remove_file(path);
}
