
use crate::cluster_id::build_cluster_ids;
use crate::exon_derive::derive_all_exons;
use crate::inference::infer_parent_edges;
use crate::lane_assign::{assign_lanes, OVERFLOW_LANE};
use crate::model::{Feature, ParsedRecord, Strand, Topology};
use crate::ORIGIN_SPANNING_ATTR;

pub const GFF3_SOURCE: &str = "DNAForge";

pub const SCHEMA_VERSION: u32 = 2;

pub(crate) fn is_segment_emit_type(feature_type: &str) -> bool {
    let lc = feature_type.to_lowercase();
    matches!(lc.as_str(), "exon" | "cds")
}

fn wraps_circular_origin(record: &ParsedRecord, feature: &Feature) -> bool {
    record.topology == Topology::Circular
        && feature.intervals.len() > 1
        && feature.intervals.iter().any(|interval| interval.start == 1)
        && feature
            .intervals
            .iter()
            .any(|interval| interval.end == record.length)
}

pub(crate) fn has_distinct_source_interval_qualifiers(
    source_interval_qualifiers: Option<&[Vec<(String, Option<String>)>]>,
) -> bool {
    source_interval_qualifiers
        .is_some_and(|intervals| intervals.windows(2).any(|pair| pair[0] != pair[1]))
}

pub(crate) fn has_distinct_source_interval_strands(
    source_interval_strands: Option<&[Strand]>,
) -> bool {
    source_interval_strands.is_some_and(|strands| strands.windows(2).any(|pair| pair[0] != pair[1]))
}

pub fn escape_gff3_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b';' => out.push_str("%3B"),
            b'=' => out.push_str("%3D"),
            b'&' => out.push_str("%26"),
            b',' => out.push_str("%2C"),
            b'%' => out.push_str("%25"),
            b'\t' => out.push_str("%09"),
            b'\n' => out.push_str("%0A"),
            b'\r' => out.push_str("%0D"),
            _ => out.push(b as char),
        }
    }
    out
}

fn strand_str(s: Strand) -> &'static str {
    match s {
        Strand::Plus => "+",
        Strand::Minus => "-",
        Strand::Unknown => ".",
    }
}

fn build_row(
    feature: &Feature,
    seqid: &str,
    start: u64,
    end: u64,
    row_id: &str,
    parent_id: Option<&str>,
    lane: u32,
    origin_spanning: bool,
    source_strand: Option<Strand>,
    source_phase: Option<u8>,
    source_qualifiers: Option<&[(String, Option<String>)]>,
) -> EmittedRow {
    let mut attributes = String::new();
    attributes.push_str("ID=");
    attributes.push_str(&escape_gff3_attr(row_id));
    if let Some(p) = parent_id {
        attributes.push_str(";Parent=");
        attributes.push_str(&escape_gff3_attr(p));
    }
    if lane != OVERFLOW_LANE {
        attributes.push_str(&format!(";_lane={}", lane));
    } else {
        attributes.push_str(";_lane=overflow");
    }
    if origin_spanning {
        attributes.push(';');
        attributes.push_str(ORIGIN_SPANNING_ATTR);
        attributes.push_str("=true");
    }
    // requires key=value form.
    for (k, v) in source_qualifiers.unwrap_or(&feature.qualifiers) {
        if matches!(k.as_str(), "ID" | "Parent" | "_lane") || k.as_str() == ORIGIN_SPANNING_ATTR {
            continue;
        }
        if let Some(val) = v {
            attributes.push(';');
            attributes.push_str(&escape_gff3_attr(k));
            attributes.push('=');
            attributes.push_str(&escape_gff3_attr(val));
        }
    }
    let phase = if feature.feature_type.eq_ignore_ascii_case("CDS") {
        match source_phase {
            Some(1) => "1",
            Some(2) => "2",
            _ => "0",
        }
    } else {
        "."
    };
    EmittedRow {
        seqid: seqid.to_string(),
        feature_type: feature.feature_type.clone(),
        start,
        end,
        strand: strand_str(source_strand.unwrap_or(feature.strand)),
        phase,
        attributes,
    }
}

#[derive(Debug, Clone)]
struct EmittedRow {
    seqid: String,
    feature_type: String,
    start: u64,
    end: u64,
    strand: &'static str,
    phase: &'static str,
    attributes: String,
}

impl EmittedRow {
    fn render(&self, out: &mut String) {
        out.push_str(&self.seqid);
        out.push('\t');
        out.push_str(GFF3_SOURCE);
        out.push('\t');
        out.push_str(&self.feature_type);
        out.push('\t');
        out.push_str(&self.start.to_string());
        out.push('\t');
        out.push_str(&self.end.to_string());
        out.push('\t');
        out.push('.');
        out.push('\t');
        out.push_str(self.strand);
        out.push('\t');
        out.push_str(self.phase);
        out.push('\t');
        out.push_str(&self.attributes);
    }
}

pub fn emit_gff3(record: &ParsedRecord, seqid: &str, indexer_version: &str) -> String {
    emit_gff3_with_opts(record, seqid, indexer_version, &EmitOpts::default())
}

#[derive(Default, Clone)]
pub struct EmitOpts {
    pub source_ids: Option<Vec<Option<String>>>,
    pub explicit_parent_source_ids: Option<Vec<Option<String>>>,
    pub source_phases: Option<Vec<Vec<Option<u8>>>>,
    pub source_strands: Option<Vec<Vec<Strand>>>,
    pub source_interval_qualifiers: Option<Vec<Vec<Vec<(String, Option<String>)>>>>,
    pub source_origin_spanning: Option<Vec<bool>>,
}

pub fn emit_gff3_with_opts(
    record: &ParsedRecord,
    seqid: &str,
    indexer_version: &str,
    opts: &EmitOpts,
) -> String {
    let use_explicit_parents =
        opts.source_ids.is_some() && opts.explicit_parent_source_ids.is_some();

    let origin_spanning_by_feature: Vec<bool> = match opts.source_origin_spanning.as_ref() {
        Some(markers) => markers.clone(),
        None => record
            .features
            .iter()
            .map(|feature| wraps_circular_origin(record, feature))
            .collect(),
    };

    let derived: Vec<_> = derive_all_exons(&record.features)
        .into_iter()
        .filter(|(parent_idx, _)| {
            !origin_spanning_by_feature
                .get(*parent_idx)
                .copied()
                .unwrap_or(false)
        })
        .collect();
    let mut all_features: Vec<Feature> = record.features.clone();
    let derived_start_idx = all_features.len();
    let mut derived_parent_idx: Vec<usize> = Vec::with_capacity(derived.len());
    for (parent_idx, exon) in derived {
        derived_parent_idx.push(parent_idx);
        all_features.push(exon);
    }

    let ids = build_cluster_ids(&all_features, seqid);

    let lanes = assign_lanes(&all_features);

    let inferred_parents: Vec<Option<String>> = if use_explicit_parents {
        let source_ids = opts.source_ids.as_ref().unwrap();
        let explicit_parents = opts.explicit_parent_source_ids.as_ref().unwrap();
        let mut source_to_cluster: std::collections::HashMap<&str, &str> =
            std::collections::HashMap::new();
        for i in 0..derived_start_idx {
            if let Some(Some(src_id)) = source_ids.get(i) {
                source_to_cluster.insert(src_id.as_str(), ids[i].as_str());
            }
        }
        let mut out = vec![None; all_features.len()];
        for i in 0..derived_start_idx {
            if let Some(Some(parent_src)) = explicit_parents.get(i) {
                if let Some(cluster) = source_to_cluster.get(parent_src.as_str()) {
                    out[i] = Some((*cluster).to_string());
                }
            }
        }
        out
    } else {
        infer_parent_edges(&all_features, &ids)
    };
    let referenced_source_ids: std::collections::HashSet<&str> = opts
        .explicit_parent_source_ids
        .as_ref()
        .into_iter()
        .flatten()
        .filter_map(Option::as_deref)
        .collect();

    let mut rows = Vec::new();
    for (feature_idx, feature) in all_features.iter().enumerate() {
        let cluster_id = &ids[feature_idx];
        let lane = lanes[feature_idx];

        let parent_id = if feature_idx >= derived_start_idx {
            let parent_orig_idx = derived_parent_idx[feature_idx - derived_start_idx];
            Some(ids[parent_orig_idx].clone())
        } else {
            inferred_parents[feature_idx].clone()
        };

        let source_interval_qualifiers = opts
            .source_interval_qualifiers
            .as_ref()
            .and_then(|features| features.get(feature_idx))
            .map(Vec::as_slice);
        let source_interval_strands = opts
            .source_strands
            .as_ref()
            .and_then(|features| features.get(feature_idx))
            .map(Vec::as_slice);
        let origin_spanning = origin_spanning_by_feature
            .get(feature_idx)
            .copied()
            .unwrap_or(false);
        let segment_emit = is_segment_emit_type(&feature.feature_type)
            || has_distinct_source_interval_qualifiers(source_interval_qualifiers)
            || has_distinct_source_interval_strands(source_interval_strands)
            || origin_spanning;
        let multipart = feature.intervals.len() > 1;
        let shared_parent_identity = origin_spanning
            || opts
                .source_ids
                .as_ref()
                .and_then(|source_ids| source_ids.get(feature_idx))
                .and_then(Option::as_deref)
                .is_some_and(|source_id| referenced_source_ids.contains(source_id));

        if segment_emit {
            for (part_idx, iv) in feature.intervals.iter().enumerate() {
                let row_id = if multipart && !shared_parent_identity {
                    format!("{}-{}", cluster_id, part_idx)
                } else {
                    cluster_id.clone()
                };
                rows.push(build_row(
                    feature,
                    seqid,
                    iv.start,
                    iv.end,
                    &row_id,
                    parent_id.as_deref(),
                    lane,
                    origin_spanning,
                    opts.source_strands
                        .as_ref()
                        .and_then(|features| features.get(feature_idx))
                        .and_then(|strands| strands.get(part_idx))
                        .copied(),
                    opts.source_phases
                        .as_ref()
                        .and_then(|features| features.get(feature_idx))
                        .and_then(|phases| phases.get(part_idx))
                        .copied()
                        .flatten(),
                    opts.source_interval_qualifiers
                        .as_ref()
                        .and_then(|features| features.get(feature_idx))
                        .and_then(|intervals| intervals.get(part_idx))
                        .map(Vec::as_slice),
                ));
            }
        } else {
            let bbox_start = feature.intervals.iter().map(|i| i.start).min().unwrap_or(0);
            let bbox_end = feature.intervals.iter().map(|i| i.end).max().unwrap_or(0);
            rows.push(build_row(
                feature,
                seqid,
                bbox_start,
                bbox_end,
                cluster_id,
                parent_id.as_deref(),
                lane,
                false,
                None,
                None,
                None,
            ));
        }
    }

    rows.sort_by(|a, b| {
        a.seqid
            .cmp(&b.seqid)
            .then(a.start.cmp(&b.start))
            .then(a.end.cmp(&b.end))
    });

    let mut out = String::with_capacity(64 + rows.len() * 100);
    out.push_str("##gff-version 3\n");
    out.push_str(&format!("##dna-indexer-version {}\n", indexer_version));
    out.push_str(&format!("##dna-indexer-schema {}\n", SCHEMA_VERSION));
    out.push_str(&format!(
        "##dna-indexer-topology {}\n",
        match record.topology {
            Topology::Linear => "linear",
            Topology::Circular => "circular",
        }
    ));
    for row in &rows {
        row.render(&mut out);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Feature, Interval, ParsedRecord, Strand, Topology};

    fn feat(
        ftype: &str,
        intervals: Vec<(u64, u64)>,
        strand: Strand,
        qualifiers: Vec<(&str, &str)>,
    ) -> Feature {
        Feature {
            feature_type: ftype.to_string(),
            strand,
            intervals: intervals
                .into_iter()
                .map(|(s, e)| Interval { start: s, end: e })
                .collect(),
            qualifiers: qualifiers
                .into_iter()
                .map(|(k, v)| (k.to_string(), Some(v.to_string())))
                .collect(),
            location_string: "test".to_string(),
        }
    }

    fn record_with(features: Vec<Feature>, length: u64) -> ParsedRecord {
        ParsedRecord {
            name: "test".to_string(),
            length,
            topology: Topology::Linear,
            features,
            sequence: Vec::new(),
        }
    }

    #[test]
    fn pragma_format_is_four_lines() {
        let rec = record_with(vec![], 100);
        let out = emit_gff3(&rec, "chrZ", "0.1.0");
        let lines: Vec<&str> = out.lines().take(4).collect();
        assert_eq!(lines[0], "##gff-version 3");
        assert_eq!(lines[1], "##dna-indexer-version 0.1.0");
        assert_eq!(lines[2], "##dna-indexer-schema 2");
        assert_eq!(lines[3], "##dna-indexer-topology linear");
    }

    #[test]
    fn topology_pragma_reflects_record_circular() {
        let mut rec = record_with(vec![], 100);
        rec.topology = Topology::Circular;
        let out = emit_gff3(&rec, "chrZ", "0.1.0");
        let topology_line = out
            .lines()
            .find(|l| l.starts_with("##dna-indexer-topology"))
            .unwrap();
        assert_eq!(topology_line, "##dna-indexer-topology circular");
    }

    #[test]
    fn genbank_origin_wrap_splits_at_the_origin_under_one_id() {
        let mut record = record_with(
            vec![feat(
                "rep_origin",
                vec![(8, 10), (1, 3)],
                Strand::Plus,
                vec![],
            )],
            10,
        );
        record.topology = Topology::Circular;
        let out = emit_gff3(&record, "circle", "0.1.0");
        let rows: Vec<Vec<&str>> = out
            .lines()
            .filter(|line| !line.starts_with('#'))
            .map(|line| line.split('\t').collect())
            .collect();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0][3], rows[0][4]), ("1", "3"));
        assert_eq!((rows[1][3], rows[1][4]), ("8", "10"));
        let id = |columns: &Vec<&str>| columns[8].split(';').next().unwrap().to_string();
        assert_eq!(id(&rows[0]), id(&rows[1]));
        assert!(rows
            .iter()
            .all(|columns| columns[8].contains("_dnaforge_origin_spanning=true")));
    }

    #[test]
    fn circular_multipart_feature_inside_the_molecule_keeps_bbox_shape() {
        let mut record = record_with(
            vec![feat(
                "misc_feature",
                vec![(2, 4), (6, 8)],
                Strand::Plus,
                vec![],
            )],
            10,
        );
        record.topology = Topology::Circular;
        let out = emit_gff3(&record, "circle", "0.1.0");
        let rows: Vec<Vec<&str>> = out
            .lines()
            .filter(|line| !line.starts_with('#'))
            .map(|line| line.split('\t').collect())
            .collect();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0][3], rows[0][4]), ("2", "8"));
    }

    #[test]
    fn origin_spanning_mrna_does_not_gain_synthetic_exons() {
        let mut record = record_with(
            vec![feat("mRNA", vec![(8, 10), (1, 3)], Strand::Plus, vec![])],
            10,
        );
        record.topology = Topology::Circular;
        let opts = EmitOpts {
            source_origin_spanning: Some(vec![true]),
            ..EmitOpts::default()
        };
        let out = emit_gff3_with_opts(&record, "circle", "0.1.0", &opts);
        let rows: Vec<Vec<&str>> = out
            .lines()
            .filter(|line| !line.starts_with('#'))
            .map(|line| line.split('\t').collect())
            .collect();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|columns| columns[2] == "mRNA"));
        assert!(rows
            .iter()
            .all(|columns| columns[8].contains("_dnaforge_origin_spanning=true")));
    }

    #[test]
    fn empty_record_emits_only_pragmas() {
        let rec = record_with(vec![], 100);
        let out = emit_gff3(&rec, "chrZ", "0.1.0");
        assert_eq!(out.lines().count(), 4);
    }

    #[test]
    fn rows_sorted_by_start_for_tabix() {
        let features = vec![
            feat("gene", vec![(500, 600)], Strand::Plus, vec![("gene", "C")]),
            feat("gene", vec![(100, 200)], Strand::Plus, vec![("gene", "A")]),
            feat("gene", vec![(300, 400)], Strand::Plus, vec![("gene", "B")]),
        ];
        let out = emit_gff3(&record_with(features, 1000), "chrZ", "0.1.0");
        let starts: Vec<u64> = out
            .lines()
            .filter(|l| !l.starts_with("##"))
            .map(|l| l.split('\t').nth(3).unwrap().parse::<u64>().unwrap())
            .collect();
        assert_eq!(starts, vec![100, 300, 500]);
    }

    #[test]
    fn multipart_feature_explodes_to_n_rows_with_part_suffix() {
        let features = vec![feat(
            "exon",
            vec![(100, 200), (300, 400), (500, 600)],
            Strand::Plus,
            vec![("gene", "X")],
        )];
        let out = emit_gff3(&record_with(features, 1000), "chrZ", "0.1.0");
        let id_attrs: Vec<String> = out
            .lines()
            .filter(|l| !l.starts_with("##"))
            .map(|l| {
                let attrs = l.split('\t').nth(8).unwrap();
                attrs
                    .split(';')
                    .find(|a| a.starts_with("ID="))
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(id_attrs.len(), 3);
        assert_eq!(id_attrs[0], "ID=X.exon.1-0");
        assert_eq!(id_attrs[1], "ID=X.exon.1-1");
        assert_eq!(id_attrs[2], "ID=X.exon.1-2");
    }

    #[test]
    fn derived_exons_carry_parent_link_to_mrna() {
        let features = vec![feat(
            "mRNA",
            vec![(100, 200), (300, 400)],
            Strand::Plus,
            vec![("gene", "HBB")],
        )];
        let out = emit_gff3(&record_with(features, 500), "chr11", "0.1.0");

        let exon_rows: Vec<&str> = out
            .lines()
            .filter(|l| !l.starts_with("##"))
            .filter(|l| l.split('\t').nth(2) == Some("exon"))
            .collect();
        assert_eq!(exon_rows.len(), 2);
        for row in &exon_rows {
            assert!(
                row.contains("Parent=HBB.mrna.1"),
                "derived exon row missing Parent=HBB.mrna.1: {}",
                row
            );
        }
    }

    #[test]
    fn lane_attribute_present_on_every_row() {
        let features = vec![
            feat("gene", vec![(100, 200)], Strand::Plus, vec![("gene", "A")]),
            feat("gene", vec![(150, 250)], Strand::Plus, vec![("gene", "B")]),
        ];
        let out = emit_gff3(&record_with(features, 1000), "chrZ", "0.1.0");
        let lanes: Vec<&str> = out
            .lines()
            .filter(|l| !l.starts_with("##"))
            .map(|l| {
                l.split('\t')
                    .nth(8)
                    .unwrap()
                    .split(';')
                    .find(|a| a.starts_with("_lane="))
                    .unwrap_or("")
            })
            .collect();
        assert_eq!(lanes.len(), 2);
        assert!(lanes.iter().all(|l| !l.is_empty()));
    }

    #[test]
    fn cds_gets_phase_zero_others_get_dot() {
        let features = vec![
            feat("CDS", vec![(100, 200)], Strand::Plus, vec![("gene", "A")]),
            feat("gene", vec![(300, 400)], Strand::Plus, vec![("gene", "B")]),
        ];
        let out = emit_gff3(&record_with(features, 1000), "chrZ", "0.1.0");
        let by_type: std::collections::HashMap<&str, &str> = out
            .lines()
            .filter(|l| !l.starts_with("##"))
            .map(|l| {
                let cols: Vec<&str> = l.split('\t').collect();
                (cols[2], cols[7])
            })
            .collect();
        assert_eq!(by_type.get("CDS"), Some(&"0"));
        assert_eq!(by_type.get("gene"), Some(&"."));
    }

    #[test]
    fn canonical_gff3_cds_retains_each_source_segment_phase() {
        let features = vec![feat(
            "CDS",
            vec![(100, 150), (200, 250), (300, 350)],
            Strand::Plus,
            vec![("gene", "A")],
        )];
        let opts = EmitOpts {
            source_ids: Some(vec![Some("source-cds".into())]),
            explicit_parent_source_ids: Some(vec![None]),
            source_phases: Some(vec![vec![Some(0), Some(1), Some(2)]]),
            source_strands: Some(vec![vec![Strand::Plus; 3]]),
            source_interval_qualifiers: Some(vec![vec![
                vec![("part".into(), Some("1/3".into()))],
                vec![("part".into(), Some("2/3".into()))],
                vec![("part".into(), Some("3/3".into()))],
            ]]),
            ..EmitOpts::default()
        };
        let out = emit_gff3_with_opts(&record_with(features, 1000), "chrZ", "0.1.0", &opts);
        let rows: Vec<Vec<&str>> = out
            .lines()
            .filter(|line| !line.starts_with('#'))
            .map(|line| line.split('\t').collect())
            .collect();
        assert_eq!(
            rows.iter().map(|row| row[7]).collect::<Vec<_>>(),
            vec!["0", "1", "2"]
        );
        assert_eq!(
            rows.iter()
                .map(|row| row[8]
                    .split(';')
                    .find(|attribute| attribute.starts_with("part="))
                    .unwrap())
                .collect::<Vec<_>>(),
            vec!["part=1/3", "part=2/3", "part=3/3"]
        );
        let ids = rows
            .iter()
            .map(|row| {
                row[8]
                    .split(';')
                    .find_map(|attribute| attribute.strip_prefix("ID="))
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            ids.iter()
                .copied()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3
        );
        assert!(ids
            .iter()
            .enumerate()
            .all(|(index, id)| id.ends_with(&format!("-{index}"))));
    }

    #[test]
    fn canonical_mixed_strand_parent_forces_segments_with_one_shared_id() {
        let features = vec![
            feat(
                "gene",
                vec![(501, 600), (401, 500), (301, 400), (201, 300), (101, 200)],
                Strand::Unknown,
                vec![],
            ),
            feat("mRNA", vec![(101, 600)], Strand::Minus, vec![]),
        ];
        let opts = EmitOpts {
            source_ids: Some(vec![
                Some("gene-Dmel_CG32491".into()),
                Some("rna-NM_163881.2".into()),
            ]),
            explicit_parent_source_ids: Some(vec![None, Some("gene-Dmel_CG32491".into())]),
            source_phases: Some(vec![vec![None; 5], vec![None]]),
            source_strands: Some(vec![
                vec![
                    Strand::Minus,
                    Strand::Plus,
                    Strand::Minus,
                    Strand::Plus,
                    Strand::Minus,
                ],
                vec![Strand::Minus],
            ]),
            source_interval_qualifiers: Some(vec![vec![vec![]; 5], vec![vec![]]]),
            source_origin_spanning: Some(vec![false, false]),
        };
        let out = emit_gff3_with_opts(&record_with(features, 1000), "chrZ", "0.1.0", &opts);
        let rows: Vec<Vec<&str>> = out
            .lines()
            .filter(|line| !line.starts_with('#'))
            .map(|line| line.split('\t').collect())
            .collect();
        let gene_rows: Vec<&Vec<&str>> = rows.iter().filter(|row| row[2] == "gene").collect();
        assert_eq!(gene_rows.len(), 5);
        assert_eq!(
            gene_rows.iter().map(|row| row[6]).collect::<Vec<_>>(),
            vec!["-", "+", "-", "+", "-"]
        );
        let gene_ids: std::collections::HashSet<&str> = gene_rows
            .iter()
            .map(|row| {
                row[8]
                    .split(';')
                    .find_map(|attribute| attribute.strip_prefix("ID="))
                    .unwrap()
            })
            .collect();
        assert_eq!(gene_ids.len(), 1);
        let shared_gene_id = *gene_ids.iter().next().unwrap();
        let child_parent = rows
            .iter()
            .find(|row| row[2] == "mRNA")
            .and_then(|row| {
                row[8]
                    .split(';')
                    .find_map(|attribute| attribute.strip_prefix("Parent="))
            })
            .unwrap();
        assert_eq!(child_parent, shared_gene_id);
    }

    #[test]
    fn strand_column_renders_plus_minus_dot() {
        let features = vec![
            feat("gene", vec![(100, 200)], Strand::Plus, vec![]),
            feat("gene", vec![(300, 400)], Strand::Minus, vec![]),
            feat("gene", vec![(500, 600)], Strand::Unknown, vec![]),
        ];
        let out = emit_gff3(&record_with(features, 1000), "chrZ", "0.1.0");
        let strands: Vec<&str> = out
            .lines()
            .filter(|l| !l.starts_with("##"))
            .map(|l| l.split('\t').nth(6).unwrap())
            .collect();
        assert_eq!(strands, vec!["+", "-", "."]);
    }

    #[test]
    fn byte_identical_regeneration() {
        let features = vec![
            feat("CDS", vec![(100, 200)], Strand::Plus, vec![("gene", "A")]),
            feat(
                "mRNA",
                vec![(100, 200), (300, 400)],
                Strand::Plus,
                vec![("gene", "A")],
            ),
            feat("gene", vec![(50, 500)], Strand::Plus, vec![("gene", "A")]),
        ];
        let rec = record_with(features, 1000);
        let a = emit_gff3(&rec, "chrZ", "0.1.0");
        let b = emit_gff3(&rec, "chrZ", "0.1.0");
        assert_eq!(
            a, b,
            "rerunning emit on the same record must be byte-identical"
        );
    }

    #[test]
    fn attribute_escaping_unit() {
        assert_eq!(escape_gff3_attr("ok"), "ok");
        assert_eq!(escape_gff3_attr("a;b"), "a%3Bb");
        assert_eq!(escape_gff3_attr("a=b"), "a%3Db");
        assert_eq!(escape_gff3_attr("a&b"), "a%26b");
        assert_eq!(escape_gff3_attr("a,b"), "a%2Cb");
        assert_eq!(escape_gff3_attr("100%"), "100%25");
        assert_eq!(escape_gff3_attr("a\tb"), "a%09b");
        assert_eq!(escape_gff3_attr("a\nb"), "a%0Ab");
        assert_eq!(escape_gff3_attr("a\rb"), "a%0Db");
        assert_eq!(escape_gff3_attr("spaces ok"), "spaces ok");
    }

    #[test]
    fn attribute_escaping_applied_to_qualifier_values() {
        let features = vec![feat(
            "gene",
            vec![(100, 200)],
            Strand::Plus,
            vec![("note", "splits=here;and=here")],
        )];
        let out = emit_gff3(&record_with(features, 1000), "chrZ", "0.1.0");
        assert!(
            out.contains("note=splits%3Dhere%3Band%3Dhere"),
            "qualifier escaping failed; output:\n{}",
            out
        );
    }

    #[test]
    fn single_segment_feature_id_has_no_suffix() {
        let features = vec![feat(
            "gene",
            vec![(100, 200)],
            Strand::Plus,
            vec![("gene", "X")],
        )];
        let out = emit_gff3(&record_with(features, 1000), "chrZ", "0.1.0");
        let id_line = out
            .lines()
            .find(|l| !l.starts_with("##") && l.split('\t').nth(2) == Some("gene"))
            .unwrap();
        assert!(id_line.contains("ID=X.gene.1;"), "got: {}", id_line);
        assert!(
            !id_line.contains("ID=X.gene.1-"),
            "single-segment feature got a -N suffix: {}",
            id_line
        );
    }

    #[test]
    fn coordinate_hash_fallback_id_for_unnamed_feature() {
        let features = vec![feat(
            "misc_feature",
            vec![(100, 200)],
            Strand::Plus,
            vec![("note", "orphan")],
        )];
        let out = emit_gff3(&record_with(features, 1000), "chrZ", "0.1.0");
        let data_line = out.lines().find(|l| !l.starts_with("##")).unwrap();
        assert!(
            data_line.contains("ID=cchrZ_100-200_F_misc_feature"),
            "coordinate-hash ID missing; got: {}",
            data_line
        );
    }

    #[test]
    fn pragmas_appear_before_data_rows() {
        let features = vec![feat("gene", vec![(100, 200)], Strand::Plus, vec![])];
        let out = emit_gff3(&record_with(features, 1000), "chrZ", "0.1.0");
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines[0].starts_with("##"));
        assert!(lines[1].starts_with("##"));
        assert!(lines[2].starts_with("##"));
        assert!(lines[3].starts_with("##"));
        assert!(!lines[4].starts_with("##"));
    }

    #[test]
    fn cds_row_gets_inferred_parent_mrna_link() {
        let features = vec![
            feat(
                "mRNA",
                vec![(100, 200), (300, 500)],
                Strand::Plus,
                vec![("gene", "HBB")],
            ),
            feat(
                "CDS",
                vec![(150, 200), (300, 450)],
                Strand::Plus,
                vec![("gene", "HBB")],
            ),
        ];
        let out = emit_gff3(&record_with(features, 1000), "chr11", "0.0.0");

        let cds_rows: Vec<&str> = out
            .lines()
            .filter(|l| !l.starts_with("##"))
            .filter(|l| l.split('\t').nth(2) == Some("CDS"))
            .collect();
        assert_eq!(
            cds_rows.len(),
            2,
            "expected 2 CDS rows from join(); got {}",
            cds_rows.len()
        );
        for row in &cds_rows {
            assert!(
                row.contains("Parent=HBB.mrna.1"),
                "CDS row missing Parent=HBB.mrna.1: {}",
                row
            );
        }

        let mrna_row = out
            .lines()
            .find(|l| !l.starts_with("##") && l.split('\t').nth(2) == Some("mRNA"))
            .unwrap();
        assert!(
            !mrna_row.contains(";Parent="),
            "mRNA should not have Parent= (gene-level inference is v1.1): {}",
            mrna_row
        );
    }

    #[test]
    fn cds_with_no_matching_mrna_emits_no_parent_attribute() {
        let features = vec![
            feat("mRNA", vec![(100, 200)], Strand::Plus, vec![("gene", "Z")]),
            feat("CDS", vec![(500, 600)], Strand::Plus, vec![("gene", "Z")]),
        ];
        let out = emit_gff3(&record_with(features, 1000), "chrZ", "0.0.0");
        let cds_row = out
            .lines()
            .find(|l| !l.starts_with("##") && l.split('\t').nth(2) == Some("CDS"))
            .unwrap();
        assert!(
            !cds_row.contains(";Parent="),
            "CDS should be standalone (no matching mRNA): {}",
            cds_row
        );
    }

    #[test]
    fn mrna_multipart_emits_one_wide_bbox_row() {
        let features = vec![feat(
            "mRNA",
            vec![(100, 200), (300, 400), (500, 600)],
            Strand::Plus,
            vec![("gene", "HBB")],
        )];
        let out = emit_gff3(&record_with(features, 1000), "chr11", "0.0.0");

        let mrna_rows: Vec<&str> = out
            .lines()
            .filter(|l| !l.starts_with("##"))
            .filter(|l| l.split('\t').nth(2) == Some("mRNA"))
            .collect();
        assert_eq!(mrna_rows.len(), 1, "mRNA must emit exactly 1 wide bbox row");

        let cols: Vec<&str> = mrna_rows[0].split('\t').collect();
        assert_eq!(cols[3], "100", "bbox start = min of intervals");
        assert_eq!(cols[4], "600", "bbox end = max of intervals");
        let attrs = cols[8];
        let id_attr = attrs.split(';').find(|a| a.starts_with("ID=")).unwrap();
        assert_eq!(
            id_attr, "ID=HBB.mrna.1",
            "mRNA ID is un-suffixed: {}",
            id_attr
        );
    }

    #[test]
    fn promoter_multipart_emits_one_wide_bbox_row() {
        let features = vec![feat(
            "promoter",
            vec![(541, 546), (547, 564), (565, 571)],
            Strand::Plus,
            vec![("label", "lac promoter")],
        )];
        let out = emit_gff3(&record_with(features, 1000), "puc19", "0.0.0");

        let promoter_rows: Vec<&str> = out
            .lines()
            .filter(|l| !l.starts_with("##"))
            .filter(|l| l.split('\t').nth(2) == Some("promoter"))
            .collect();
        assert_eq!(
            promoter_rows.len(),
            1,
            "promoter with join() must emit 1 wide bbox row, not N parts"
        );
        let cols: Vec<&str> = promoter_rows[0].split('\t').collect();
        assert_eq!(cols[3], "541");
        assert_eq!(cols[4], "571");
    }

    #[test]
    fn exon_multipart_still_emits_n_rows() {
        let features = vec![feat(
            "mRNA",
            vec![(100, 200), (300, 400), (500, 600)],
            Strand::Plus,
            vec![("gene", "X")],
        )];
        let out = emit_gff3(&record_with(features, 1000), "chrX", "0.0.0");
        let exon_rows: Vec<&str> = out
            .lines()
            .filter(|l| !l.starts_with("##"))
            .filter(|l| l.split('\t').nth(2) == Some("exon"))
            .collect();
        assert_eq!(exon_rows.len(), 3, "3 derived exons from 3-part mRNA");
        for row in &exon_rows {
            assert!(
                row.contains("Parent=X.mrna.1"),
                "exon row missing Parent=X.mrna.1: {}",
                row
            );
        }
    }

    #[test]
    fn cds_multipart_still_emits_n_rows() {
        let features = vec![
            feat(
                "mRNA",
                vec![(100, 200), (300, 400)],
                Strand::Plus,
                vec![("gene", "X")],
            ),
            feat(
                "CDS",
                vec![(150, 200), (300, 350)],
                Strand::Plus,
                vec![("gene", "X")],
            ),
        ];
        let out = emit_gff3(&record_with(features, 1000), "chrX", "0.0.0");
        let cds_rows: Vec<&str> = out
            .lines()
            .filter(|l| !l.starts_with("##"))
            .filter(|l| l.split('\t').nth(2) == Some("CDS"))
            .collect();
        assert_eq!(cds_rows.len(), 2);
        for row in &cds_rows {
            assert!(
                row.contains("Parent=X.mrna.1"),
                "CDS row missing Parent=X.mrna.1: {}",
                row
            );
        }
    }

    #[test]
    fn gene_emits_one_bbox_row() {
        let features = vec![feat(
            "gene",
            vec![(100, 500)],
            Strand::Plus,
            vec![("gene", "X")],
        )];
        let out = emit_gff3(&record_with(features, 1000), "chrX", "0.0.0");
        let gene_rows: Vec<&str> = out
            .lines()
            .filter(|l| !l.starts_with("##"))
            .filter(|l| l.split('\t').nth(2) == Some("gene"))
            .collect();
        assert_eq!(gene_rows.len(), 1);
        let attrs = gene_rows[0].split('\t').nth(8).unwrap();
        let id_attr = attrs.split(';').find(|a| a.starts_with("ID=")).unwrap();
        assert_eq!(id_attr, "ID=X.gene.1");
    }

    #[test]
    fn source_column_is_dnaforge() {
        let features = vec![feat("gene", vec![(100, 200)], Strand::Plus, vec![])];
        let out = emit_gff3(&record_with(features, 1000), "chrZ", "0.1.0");
        let data_line = out.lines().find(|l| !l.starts_with("##")).unwrap();
        assert_eq!(data_line.split('\t').nth(1), Some(GFF3_SOURCE));
    }
}
