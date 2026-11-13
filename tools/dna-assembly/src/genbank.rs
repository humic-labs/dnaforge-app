
use std::io::{BufRead, BufReader, Cursor, Read};
use std::path::Path;

use gb_io::reader::SeqReader;
use gb_io::seq::{Location, Seq, Topology};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ParsedPart {
    pub start: i64,
    pub end: i64,
    pub strand: i32,
}

#[derive(Debug, Serialize)]
pub struct ParsedFeature {
    #[serde(rename = "type")]
    pub kind: String,
    pub label: Option<String>,
    pub note: Vec<String>,
    pub gene: Option<String>,
    pub product: Option<String>,
    pub locus_tag: Option<String>,
    pub start: i64,
    pub end: i64,
    pub strand: i32,
    pub parts: Vec<ParsedPart>,
    pub extracted: String,
}

#[derive(Debug, Serialize)]
pub struct ParsedRecord {
    pub file_path: String,
    pub name: String,
    pub sequence: String,
    pub length: usize,
    pub circular: bool,
    pub date: Option<String>,
    pub keywords: Option<String>,
    pub features: Vec<ParsedFeature>,
    pub has_more_records: bool,
    pub error: Option<String>,
}

fn join_wrapped(value: &str) -> String {
    value.replace('\n', " ")
}

fn qualifier_first(feature: &gb_io::seq::Feature, key: &str) -> Option<String> {
    feature
        .qualifier_values(key.into())
        .next()
        .map(join_wrapped)
}

fn qualifier_all(feature: &gb_io::seq::Feature, key: &str) -> Vec<String> {
    feature.qualifier_values(key.into()).map(join_wrapped).collect()
}

fn location_strand(location: &Location) -> i32 {
    match location {
        Location::Complement(_) => -1,
        _ => 1,
    }
}

fn collect_parts(location: &Location, strand: i32, seq_len: i64, out: &mut Vec<ParsedPart>) {
    match location {
        Location::Complement(inner) => collect_parts(inner, -strand, seq_len, out),
        Location::Join(list) | Location::Order(list) => {
            for inner in list {
                collect_parts(inner, strand, seq_len, out);
            }
        }
        leaf => {
            if let Ok((start, end)) = leaf.find_bounds() {
                if start > end {
                    out.push(ParsedPart { start, end: seq_len, strand });
                    out.push(ParsedPart { start: 0, end, strand });
                } else {
                    out.push(ParsedPart { start, end, strand });
                }
            }
        }
    }
}

fn build_feature(feature: &gb_io::seq::Feature, seq: &Seq) -> ParsedFeature {
    let (raw_start, raw_end) = feature.location.find_bounds().unwrap_or((0, 0));
    let (start, end) = if raw_start > raw_end {
        (0, seq.seq.len() as i64)
    } else {
        (raw_start, raw_end)
    };
    let extracted = seq
        .extract_location(&feature.location)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).to_ascii_uppercase())
        .unwrap_or_default();
    let mut parts = Vec::new();
    collect_parts(&feature.location, 1, seq.seq.len() as i64, &mut parts);
    if parts.is_empty() {
        parts.push(ParsedPart { start, end, strand: location_strand(&feature.location) });
    }
    ParsedFeature {
        kind: feature.kind.to_string(),
        label: qualifier_first(feature, "label"),
        note: qualifier_all(feature, "note"),
        gene: qualifier_first(feature, "gene"),
        product: qualifier_first(feature, "product"),
        locus_tag: qualifier_first(feature, "locus_tag"),
        start,
        end,
        strand: location_strand(&feature.location),
        parts,
        extracted,
    }
}

fn build_record(seq: &Seq, path: &Path) -> ParsedRecord {
    let sequence = String::from_utf8_lossy(&seq.seq).to_string();
    ParsedRecord {
        file_path: path.display().to_string(),
        name: seq.name.clone().unwrap_or_default(),
        length: sequence.len(),
        circular: matches!(seq.topology, Topology::Circular),
        date: seq.date.as_ref().map(|date| date.to_string()),
        keywords: seq.keywords.as_ref().map(|kw| join_wrapped(kw)),
        features: seq.features.iter().map(|f| build_feature(f, seq)).collect(),
        has_more_records: false,
        error: None,
        sequence,
    }
}

fn error_record(path: &Path, message: String) -> ParsedRecord {
    ParsedRecord {
        file_path: path.display().to_string(),
        name: String::new(),
        sequence: String::new(),
        length: 0,
        circular: false,
        date: None,
        keywords: None,
        features: Vec::new(),
        has_more_records: false,
        error: Some(message),
    }
}

pub fn parse_genbank_file(path: &Path) -> ParsedRecord {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(err) => return error_record(path, format!("open failed: {err}")),
    };
    parse_genbank_reader(BufReader::new(file), path)
}

fn locus_name_bounds(line: &[u8]) -> Option<(usize, usize)> {
    let rest = line.strip_prefix(b"LOCUS")?;
    let offset = line.len() - rest.len();
    let start = offset + rest.iter().position(|byte| *byte != b' ' && *byte != b'\t')?;
    let end = line[start..]
        .iter()
        .position(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
        .map_or(line.len(), |length| start + length);
    Some((start, end))
}

fn parse_genbank_reader<R: BufRead>(mut input: R, path: &Path) -> ParsedRecord {
    let mut head = Vec::new();
    let mut original_name = None;
    loop {
        let before = head.len();
        match input.read_until(b'\n', &mut head) {
            Ok(0) => break,
            Ok(_) => {}
            Err(err) => return error_record(path, format!("read failed: {err}")),
        }
        if let Some((start, end)) = locus_name_bounds(&head[before..]) {
            let name = &mut head[before + start..before + end];
            if name.contains(&b':') {
                original_name = Some(String::from_utf8_lossy(name).into_owned());
                for byte in name.iter_mut().filter(|byte| **byte == b':') {
                    *byte = b'_';
                }
            }
            break;
        }
    }
    let mut reader = SeqReader::new(Cursor::new(head).chain(input));
    match reader.next() {
        Some(Ok(mut seq)) => {
            if original_name.is_some() {
                seq.name = original_name;
            }
            let mut record = build_record(&seq, path);
            record.has_more_records = reader.next().is_some();
            record
        }
        Some(Err(err)) => error_record(path, format!("parse failed: {err}")),
        None => error_record(path, "no records in file".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> ParsedRecord {
        parse_genbank_reader(Cursor::new(text.as_bytes().to_vec()), Path::new("record.gb"))
    }

    const BODY: &str = "FEATURES             Location/Qualifiers\n     misc_feature    1..4\n                     /label=\"part\"\nORIGIN\n        1 acgtacgtac\n//\n";

    #[test]
    fn locus_name_with_colon_keeps_name_and_topology() {
        let record = parse(&format!(
            "LOCUS       pJ02B2Gm:Rm_AF          10 bp    ds-DNA  circular SYN 06-AUG-2018\n{BODY}"
        ));
        assert_eq!(record.error, None);
        assert_eq!(record.name, "pJ02B2Gm:Rm_AF");
        assert!(record.circular);
        assert_eq!(record.date.as_deref(), Some("06-AUG-2018"));
        assert_eq!(record.sequence, "acgtacgtac");
        assert_eq!(record.features.len(), 1);
    }

    #[test]
    fn plain_locus_name_is_unchanged() {
        let record = parse(&format!(
            "LOCUS       pUC19          10 bp    DNA     linear   SYN 06-AUG-2018\n{BODY}"
        ));
        assert_eq!(record.name, "pUC19");
        assert!(!record.circular);
    }

    #[test]
    fn preamble_before_locus_is_kept() {
        let record = parse(&format!(
            "exported by a tool\nLOCUS       a:b:c          10 bp    DNA     circular SYN 06-AUG-2018\n{BODY}"
        ));
        assert_eq!(record.name, "a:b:c");
        assert!(record.circular);
    }
}
