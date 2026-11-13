
use crate::model::Feature;

fn is_mrna_like(f: &Feature) -> bool {
    f.feature_type.eq_ignore_ascii_case("mRNA") || f.feature_type.eq_ignore_ascii_case("transcript")
}

pub fn derive_exon_feature(mrna: &Feature) -> Option<Feature> {
    if mrna.intervals.len() <= 1 {
        return None;
    }
    Some(Feature {
        feature_type: "exon".to_string(),
        strand: mrna.strand,
        intervals: mrna.intervals.clone(),
        qualifiers: mrna.qualifiers.clone(),
        location_string: format!("derived from mRNA: {}", mrna.location_string),
    })
}

pub fn derive_all_exons(features: &[Feature]) -> Vec<(usize, Feature)> {
    let mut out = Vec::new();
    for (idx, f) in features.iter().enumerate() {
        if is_mrna_like(f) {
            if let Some(exon) = derive_exon_feature(f) {
                out.push((idx, exon));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Feature, Interval, Strand};

    fn mrna_feat(ftype: &str, intervals: Vec<(u64, u64)>, strand: Strand) -> Feature {
        Feature {
            feature_type: ftype.to_string(),
            strand,
            intervals: intervals
                .into_iter()
                .map(|(s, e)| Interval { start: s, end: e })
                .collect(),
            qualifiers: vec![("gene".to_string(), Some("HBB".to_string()))],
            location_string: "test".to_string(),
        }
    }

    #[test]
    fn derivation_from_three_part_mrna() {
        let mrna = mrna_feat(
            "mRNA",
            vec![(100, 200), (300, 400), (500, 600)],
            Strand::Plus,
        );
        let exon = derive_exon_feature(&mrna).expect("multipart mRNA → exon");
        assert_eq!(exon.feature_type, "exon");
        assert_eq!(exon.intervals.len(), 3);
        assert_eq!(exon.intervals[0].start, 100);
        assert_eq!(exon.intervals[2].end, 600);
    }

    #[test]
    fn derivation_strand_preserved_on_minus() {
        let mrna = mrna_feat(
            "mRNA",
            vec![(500, 600), (300, 400), (100, 200)],
            Strand::Minus,
        );
        let exon = derive_exon_feature(&mrna).unwrap();
        assert_eq!(exon.strand, Strand::Minus);
        assert_eq!(exon.intervals[0].start, 500);
        assert_eq!(exon.intervals[2].start, 100);
    }

    #[test]
    fn single_segment_mrna_does_not_spawn_exon() {
        let mrna = mrna_feat("mRNA", vec![(100, 1000)], Strand::Plus);
        assert!(derive_exon_feature(&mrna).is_none());
    }

    #[test]
    fn qualifiers_copied_to_derived_exon() {
        let mrna = mrna_feat("mRNA", vec![(100, 200), (300, 400)], Strand::Plus);
        let exon = derive_exon_feature(&mrna).unwrap();
        assert_eq!(exon.qualifier("gene"), Some("HBB"));
    }

    #[test]
    fn derive_all_skips_non_mrna_features() {
        let features = vec![
            mrna_feat("gene", vec![(100, 1000)], Strand::Plus),
            mrna_feat("CDS", vec![(100, 200), (300, 400)], Strand::Plus),
            mrna_feat("source", vec![(1, 5000)], Strand::Plus),
        ];
        let derived = derive_all_exons(&features);
        assert!(
            derived.is_empty(),
            "non-mRNA features should not spawn exons; got {:?}",
            derived
        );
    }

    #[test]
    fn transcript_synonym_triggers_derivation() {
        let features = vec![mrna_feat(
            "transcript",
            vec![(100, 200), (300, 400)],
            Strand::Plus,
        )];
        let derived = derive_all_exons(&features);
        assert_eq!(derived.len(), 1);
        assert_eq!(derived[0].1.feature_type, "exon");
    }

    #[test]
    fn derive_all_preserves_parent_index() {
        let features = vec![
            mrna_feat("gene", vec![(100, 1000)], Strand::Plus),
            mrna_feat("mRNA", vec![(100, 200), (300, 400)], Strand::Plus),
            mrna_feat("CDS", vec![(150, 350)], Strand::Plus),
            mrna_feat("mRNA", vec![(500, 600), (700, 800)], Strand::Plus),
        ];
        let derived = derive_all_exons(&features);
        assert_eq!(derived.len(), 2, "two multipart mRNAs → two derived exons");
        assert_eq!(
            derived[0].0, 1,
            "first derived exon's parent is features[1]"
        );
        assert_eq!(
            derived[1].0, 3,
            "second derived exon's parent is features[3]"
        );
    }

    #[test]
    fn case_insensitive_mrna_matching() {
        for variant in &["mRNA", "mrna", "MRNA", "Mrna"] {
            let f = mrna_feat(variant, vec![(100, 200), (300, 400)], Strand::Plus);
            assert!(
                is_mrna_like(&f),
                "{} should be recognized as mRNA-like",
                variant
            );
        }
    }
}
