// requires every emitted row to have a stable `ID=<stem>.<type>.<ordinal>`

use crate::model::{Feature, Strand};
use std::collections::HashMap;

pub fn extract_stem(feature: &Feature) -> Option<String> {
    feature
        .qualifier("gene")
        .or_else(|| feature.qualifier("locus_tag"))
        .map(|s| s.to_string())
}

pub fn type_id(feature: &Feature) -> String {
    feature.feature_type.to_lowercase()
}

fn coordinate_hash_id(feature: &Feature, chromosome: &str) -> String {
    let strand_char = match feature.strand {
        Strand::Plus => "F",
        Strand::Minus => "R",
        Strand::Unknown => "U",
    };
    format!(
        "c{}_{}-{}_{}_{}",
        chromosome,
        feature.start(),
        feature.end(),
        strand_char,
        type_id(feature),
    )
}

pub fn build_cluster_ids(features: &[Feature], chromosome: &str) -> Vec<String> {
    let mut entries: Vec<(usize, Option<String>, String, u64)> = features
        .iter()
        .enumerate()
        .map(|(i, f)| (i, extract_stem(f), type_id(f), f.start()))
        .collect();

    entries.sort_by(|a, b| {
        match (a.1.as_deref(), b.1.as_deref()) {
            (Some(sa), Some(sb)) => (sa, a.2.as_str(), a.3, a.0).cmp(&(sb, b.2.as_str(), b.3, b.0)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => (a.2.as_str(), a.3, a.0).cmp(&(b.2.as_str(), b.3, b.0)),
        }
    });

    let mut fallback_counts: HashMap<String, u32> = HashMap::new();
    for feature in features {
        if extract_stem(feature).is_none() {
            *fallback_counts
                .entry(coordinate_hash_id(feature, chromosome))
                .or_insert(0) += 1;
        }
    }

    let mut ids: Vec<Option<String>> = (0..features.len()).map(|_| None).collect();
    let mut ordinal: HashMap<(String, String), u32> = HashMap::new();
    let mut fallback_ordinal: HashMap<String, u32> = HashMap::new();

    for (orig_idx, stem_opt, t_id, _start) in entries {
        let id = match stem_opt {
            Some(stem) => {
                let key = (stem.clone(), t_id.clone());
                let n = ordinal.entry(key).or_insert(0);
                *n += 1;
                format!("{}.{}.{}", stem, t_id, n)
            }
            None => {
                let base = coordinate_hash_id(&features[orig_idx], chromosome);
                if fallback_counts.get(&base).copied().unwrap_or(0) == 1 {
                    base
                } else {
                    let n = fallback_ordinal.entry(base.clone()).or_insert(0);
                    *n += 1;
                    format!("{base}.{n}")
                }
            }
        };
        ids[orig_idx] = Some(id);
    }
    ids.into_iter()
        .map(|o| o.expect("every feature gets an ID"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Feature, Interval, Strand};

    fn feat(ftype: &str, start: u64, end: u64, qualifiers: Vec<(&str, &str)>) -> Feature {
        Feature {
            feature_type: ftype.to_string(),
            strand: Strand::Plus,
            intervals: vec![Interval { start, end }],
            qualifiers: qualifiers
                .into_iter()
                .map(|(k, v)| (k.to_string(), Some(v.to_string())))
                .collect(),
            location_string: format!("{}..{}", start, end),
        }
    }

    #[test]
    fn cluster_id_scheme_basic_hbb() {
        let features = vec![
            feat("gene", 100, 1000, vec![("gene", "HBB")]),
            feat("mRNA", 100, 1000, vec![("gene", "HBB")]),
            feat("CDS", 200, 900, vec![("gene", "HBB")]),
        ];
        let ids = build_cluster_ids(&features, "chr11");
        assert_eq!(ids, vec!["HBB.gene.1", "HBB.mrna.1", "HBB.cds.1"]);
    }

    #[test]
    fn cluster_id_multiple_isoforms_ordered_by_start() {
        let features = vec![
            feat("mRNA", 200, 800, vec![("gene", "PAX6")]),
            feat("mRNA", 100, 900, vec![("gene", "PAX6")]),
            feat("mRNA", 300, 700, vec![("gene", "PAX6")]),
        ];
        let ids = build_cluster_ids(&features, "chr11");
        assert_eq!(ids[0], "PAX6.mrna.2");
        assert_eq!(ids[1], "PAX6.mrna.1");
        assert_eq!(ids[2], "PAX6.mrna.3");
    }

    #[test]
    fn cluster_id_locus_tag_fallback() {
        let features = vec![feat("CDS", 100, 200, vec![("locus_tag", "b0001")])];
        let ids = build_cluster_ids(&features, "chr1");
        assert_eq!(ids, vec!["b0001.cds.1"]);
    }

    #[test]
    fn cluster_id_coordinate_hash_fallback() {
        let mut f = feat("misc_feature", 100, 200, vec![]);
        f.strand = Strand::Minus;
        let ids = build_cluster_ids(&[f], "chrM");
        assert_eq!(ids, vec!["cchrM_100-200_R_misc_feature"]);
    }

    #[test]
    fn cluster_id_disambiguates_colocated_unnamed_features() {
        let features = vec![
            feat("primer_bind", 603, 619, vec![("label", "M13 rev")]),
            feat("primer_bind", 603, 619, vec![("label", "M13 Reverse")]),
        ];
        let ids = build_cluster_ids(&features, "puc19");
        assert_eq!(
            ids,
            vec![
                "cpuc19_603-619_F_primer_bind.1",
                "cpuc19_603-619_F_primer_bind.2",
            ]
        );
    }

    #[test]
    fn cluster_id_deterministic_across_runs() {
        let features = vec![
            feat("CDS", 200, 300, vec![("gene", "HBB")]),
            feat("gene", 100, 400, vec![("gene", "HBB")]),
            feat("mRNA", 100, 400, vec![("gene", "HBB")]),
        ];
        let a = build_cluster_ids(&features, "chr11");
        let b = build_cluster_ids(&features, "chr11");
        assert_eq!(a, b, "rerunning on same input must produce same IDs");
    }

    #[test]
    fn cluster_id_different_chrom_changes_fallback() {
        let f = feat("misc_feature", 100, 200, vec![]);
        let on_chr1 = build_cluster_ids(std::slice::from_ref(&f), "chr1");
        let on_chr2 = build_cluster_ids(std::slice::from_ref(&f), "chr2");
        assert_ne!(on_chr1[0], on_chr2[0]);
    }

    #[test]
    fn cluster_id_lowercases_type() {
        let features = vec![
            feat("CDS", 100, 200, vec![("gene", "X")]),
            feat("ncRNA", 300, 400, vec![("gene", "X")]),
        ];
        let ids = build_cluster_ids(&features, "chrZ");
        assert_eq!(ids[0], "X.cds.1");
        assert_eq!(ids[1], "X.ncrna.1");
    }
}
