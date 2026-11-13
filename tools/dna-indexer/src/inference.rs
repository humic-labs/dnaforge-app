
use crate::cluster_id::extract_stem;
use crate::error;
use crate::model::{Feature, Interval, Strand};
use std::collections::BTreeMap;

pub fn infer_parent_edges(features: &[Feature], cluster_ids: &[String]) -> Vec<Option<String>> {
    assert_eq!(
        features.len(),
        cluster_ids.len(),
        "feature/cluster_id slices must be parallel"
    );

    let mut groups: BTreeMap<(StrandKey, String), Vec<usize>> = BTreeMap::new();
    for (idx, f) in features.iter().enumerate() {
        if let Some(gene) = extract_stem(f) {
            groups.entry((strand_key(f), gene)).or_default().push(idx);
        }
    }

    let mut out = vec![None; features.len()];

    for ((_strand, gene), member_indices) in &groups {
        let candidates: Vec<usize> = member_indices
            .iter()
            .copied()
            .filter(|&i| is_transcript_like(&features[i]))
            .collect();

        if candidates.is_empty() {
            continue;
        }

        for &cds_idx in member_indices {
            if !is_cds(&features[cds_idx]) {
                continue;
            }
            let cds = &features[cds_idx];

            let matches: Vec<usize> = candidates
                .iter()
                .copied()
                .filter(|&pi| intervals_contained_in(&cds.intervals, &features[pi].intervals))
                .collect();

            match matches.len() {
                1 => {
                    out[cds_idx] = Some(cluster_ids[matches[0]].clone());
                }
                0 => {
                    emit_ambiguous(
                        gene,
                        &cluster_ids[cds_idx],
                        "CDS not contained in any candidate mRNA",
                        0,
                    );
                }
                _ => {
                    let cds_intervals = &features[cds_idx].intervals;
                    let mut best_score = -1i32;
                    let mut best_idx: Option<usize> = None;
                    let mut tier1_tied = false;
                    for &mi in &matches {
                        let score = junction_match_score(cds_intervals, &features[mi].intervals);
                        if score > best_score {
                            best_score = score;
                            best_idx = Some(mi);
                            tier1_tied = false;
                        } else if score == best_score {
                            tier1_tied = true;
                        }
                    }
                    if !tier1_tied && best_score > 0 {
                        if let Some(mi) = best_idx {
                            out[cds_idx] = Some(cluster_ids[mi].clone());
                            continue;
                        }
                    }
                    if let Some(tx_num) = transcript_num_from_cds_id(&cluster_ids[cds_idx]) {
                        let suffix = format!(".mrna.{tx_num}");
                        if let Some(&matched) = matches
                            .iter()
                            .find(|&&pi| cluster_ids[pi].ends_with(&suffix))
                        {
                            out[cds_idx] = Some(cluster_ids[matched].clone());
                            continue;
                        }
                    }
                    emit_ambiguous(
                        gene,
                        &cluster_ids[cds_idx],
                        "CDS could not be uniquely linked by junction matching or ordinal suffix",
                        matches.len(),
                    );
                }
            }
        }
    }
    out
}

fn intervals_contained_in(cds: &[Interval], mrna: &[Interval]) -> bool {
    if cds.is_empty() || mrna.is_empty() {
        return false;
    }
    let cds_min = cds.iter().map(|iv| iv.start).min().unwrap();
    let cds_max = cds.iter().map(|iv| iv.end).max().unwrap();
    let mrna_min = mrna.iter().map(|iv| iv.start).min().unwrap();
    let mrna_max = mrna.iter().map(|iv| iv.end).max().unwrap();
    if cds_min < mrna_min || cds_max > mrna_max {
        return false;
    }
    for cds_iv in cds {
        let contained = mrna
            .iter()
            .any(|mrna_iv| mrna_iv.start <= cds_iv.start && mrna_iv.end >= cds_iv.end);
        if !contained {
            return false;
        }
    }
    true
}

fn is_cds(f: &Feature) -> bool {
    f.feature_type.eq_ignore_ascii_case("CDS")
}

fn is_transcript_like(f: &Feature) -> bool {
    f.feature_type.eq_ignore_ascii_case("mRNA") || f.feature_type.eq_ignore_ascii_case("transcript")
}

#[derive(Debug, PartialOrd, PartialEq, Ord, Eq, Clone, Copy)]
enum StrandKey {
    Plus,
    Minus,
    Unknown,
}

fn strand_key(f: &Feature) -> StrandKey {
    match f.strand {
        Strand::Plus => StrandKey::Plus,
        Strand::Minus => StrandKey::Minus,
        Strand::Unknown => StrandKey::Unknown,
    }
}

fn transcript_num_from_cds_id(cds_id: &str) -> Option<u32> {
    let after_cds = cds_id.rsplit_once(".cds.")?.1;
    let n_str = after_cds.split('-').next()?;
    n_str.parse::<u32>().ok()
}

fn junction_match_score(cds_intervals: &[Interval], mrna_intervals: &[Interval]) -> i32 {
    if cds_intervals.len() < 2 {
        return 0;
    }
    let mrna_junctions: std::collections::HashSet<u64> = mrna_intervals
        .iter()
        .enumerate()
        .flat_map(|(i, iv)| {
            let mut pts = Vec::new();
            if i > 0 {
                pts.push(iv.start);
            }
            if i < mrna_intervals.len() - 1 {
                pts.push(iv.end);
            }
            pts
        })
        .collect();
    let mut score = 0;
    for (i, iv) in cds_intervals.iter().enumerate() {
        if i > 0 && mrna_junctions.contains(&iv.start) {
            score += 1;
        }
        if i < cds_intervals.len() - 1 && mrna_junctions.contains(&iv.end) {
            score += 1;
        }
    }
    score
}

fn emit_ambiguous(gene: &str, cds_id: &str, reason: &str, candidate_count: usize) {
    let mut ctx = BTreeMap::new();
    ctx.insert(
        "gene".to_string(),
        serde_json::Value::String(gene.to_string()),
    );
    ctx.insert(
        "cds_id".to_string(),
        serde_json::Value::String(cds_id.to_string()),
    );
    ctx.insert(
        "reason".to_string(),
        serde_json::Value::String(reason.to_string()),
    );
    if candidate_count > 0 {
        ctx.insert(
            "candidate_count".to_string(),
            serde_json::Value::from(candidate_count),
        );
    }
    error::warning_json_stderr(
        "INFERENCE_AMBIGUOUS",
        "CDS could not be linked to a unique parent mRNA",
        &ctx,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Feature, Interval, Strand};

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

    fn ids(parts: &[(usize, &str)]) -> Vec<String> {
        let mut v = vec![String::new(); parts.iter().map(|(i, _)| i + 1).max().unwrap_or(0)];
        for (i, s) in parts {
            v[*i] = s.to_string();
        }
        v
    }

    #[test]
    fn unambiguous_hbb_cds_links_to_mrna() {
        let features = vec![
            feat(
                "mRNA",
                vec![(100, 200), (300, 400)],
                Strand::Plus,
                vec![("gene", "HBB")],
            ),
            feat("CDS", vec![(150, 200)], Strand::Plus, vec![("gene", "HBB")]),
        ];
        let cids = ids(&[(0, "HBB.mrna.1"), (1, "HBB.cds.1")]);
        let parents = infer_parent_edges(&features, &cids);
        assert_eq!(
            parents[0], None,
            "mRNA shouldn't have a parent (gene parent comes later, slice 4+)"
        );
        assert_eq!(parents[1], Some("HBB.mrna.1".to_string()));
    }

    #[test]
    fn multi_isoform_selects_unique_match() {
        let features = vec![
            feat(
                "mRNA",
                vec![(100, 200), (300, 400)],
                Strand::Plus,
                vec![("gene", "X")],
            ),
            feat("mRNA", vec![(500, 900)], Strand::Plus, vec![("gene", "X")]),
            feat("CDS", vec![(150, 200)], Strand::Plus, vec![("gene", "X")]),
        ];
        let cids = ids(&[(0, "X.mrna.1"), (1, "X.mrna.2"), (2, "X.cds.1")]);
        let parents = infer_parent_edges(&features, &cids);
        assert_eq!(parents[2], Some("X.mrna.1".to_string()));
    }


    #[test]
    fn multi_isoform_cds_links_to_isoform_with_matching_junctions() {
        let features = vec![
            feat(
                "mRNA",
                vec![(100, 200), (300, 400), (500, 1000)],
                Strand::Plus,
                vec![("gene", "X")],
            ),
            feat(
                "mRNA",
                vec![(100, 250), (350, 420), (500, 1000)],
                Strand::Plus,
                vec![("gene", "X")],
            ),
            feat(
                "CDS",
                vec![(150, 200), (300, 400), (500, 900)],
                Strand::Plus,
                vec![("gene", "X")],
            ),
        ];
        let cids = ids(&[(0, "X.mrna.1"), (1, "X.mrna.2"), (2, "X.cds.1")]);
        let parents = infer_parent_edges(&features, &cids);
        assert_eq!(
            parents[2],
            Some("X.mrna.1".to_string()),
            "CDS junctions match mrna.1 exactly"
        );
    }

    #[test]
    fn single_segment_cds_falls_back_to_ordinal_tiebreaker() {
        let features = vec![
            feat("mRNA", vec![(100, 1000)], Strand::Plus, vec![("gene", "A")]),
            feat("mRNA", vec![(100, 1000)], Strand::Plus, vec![("gene", "A")]),
            feat("CDS", vec![(200, 800)], Strand::Plus, vec![("gene", "A")]),
        ];
        let cids = ids(&[(0, "A.mrna.1"), (1, "A.mrna.2"), (2, "A.cds.1")]);
        let parents = infer_parent_edges(&features, &cids);
        assert_eq!(
            parents[2],
            Some("A.mrna.1".to_string()),
            "ordinal tier-2 should link A.cds.1 → A.mrna.1"
        );
    }

    #[test]
    fn single_segment_cds_with_non_conforming_id_is_truly_ambiguous() {
        let features = vec![
            feat("mRNA", vec![(100, 1000)], Strand::Plus, vec![("gene", "A")]),
            feat("mRNA", vec![(100, 1000)], Strand::Plus, vec![("gene", "A")]),
            feat("CDS", vec![(200, 800)], Strand::Plus, vec![("gene", "A")]),
        ];
        let cids = ids(&[
            (0, "A.mrna.1"),
            (1, "A.mrna.2"),
            (2, "cA_200-800_F_cds"),
        ]);
        let parents = infer_parent_edges(&features, &cids);
        assert_eq!(parents[2], None, "no signal from either tier → ambiguous");
    }

    #[test]
    fn junction_match_score_counts_internal_alignments() {
        let mrna = vec![
            Interval { start: 100, end: 200 },
            Interval { start: 300, end: 400 },
            Interval { start: 500, end: 1000 },
        ];
        let cds_perfect = vec![
            Interval { start: 150, end: 200 },
            Interval { start: 300, end: 400 },
            Interval { start: 500, end: 900 },
        ];
        assert_eq!(junction_match_score(&cds_perfect, &mrna), 4);

        let cds_partial = vec![
            Interval { start: 150, end: 250 },
            Interval { start: 300, end: 400 },
            Interval { start: 500, end: 900 },
        ];
        assert_eq!(junction_match_score(&cds_partial, &mrna), 3);

        let cds_single = vec![Interval { start: 200, end: 800 }];
        assert_eq!(junction_match_score(&cds_single, &mrna), 0);
    }

    #[test]
    fn cds_with_no_mrna_in_group_leaves_standalone_silently() {
        let features = vec![feat(
            "CDS",
            vec![(100, 200)],
            Strand::Plus,
            vec![("gene", "Q")],
        )];
        let cids = ids(&[(0, "Q.cds.1")]);
        let parents = infer_parent_edges(&features, &cids);
        assert_eq!(parents[0], None);
    }

    #[test]
    fn cds_with_mrna_present_but_no_match_emits_warning() {
        let features = vec![
            feat("mRNA", vec![(100, 200)], Strand::Plus, vec![("gene", "Z")]),
            feat("CDS", vec![(500, 600)], Strand::Plus, vec![("gene", "Z")]),
        ];
        let cids = ids(&[(0, "Z.mrna.1"), (1, "Z.cds.1")]);
        let parents = infer_parent_edges(&features, &cids);
        assert_eq!(parents[1], None);
    }

    #[test]
    fn bbox_contained_but_interval_not_in_any_mrna_segment_no_match() {
        let features = vec![
            feat(
                "mRNA",
                vec![(100, 200), (400, 500)],
                Strand::Plus,
                vec![("gene", "Y")],
            ),
            feat(
                "CDS",
                vec![(150, 200), (250, 280), (400, 450)],
                Strand::Plus,
                vec![("gene", "Y")],
            ),
        ];
        let cids = ids(&[(0, "Y.mrna.1"), (1, "Y.cds.1")]);
        let parents = infer_parent_edges(&features, &cids);
        assert_eq!(parents[1], None, "intron-bleeding CDS should NOT match");
    }

    #[test]
    fn opposite_strand_excluded_from_group() {
        let features = vec![
            feat("mRNA", vec![(100, 1000)], Strand::Plus, vec![("gene", "Z")]),
            feat("CDS", vec![(200, 800)], Strand::Minus, vec![("gene", "Z")]),
        ];
        let cids = ids(&[(0, "Z.mrna.1"), (1, "Z.cds.1")]);
        let parents = infer_parent_edges(&features, &cids);
        assert_eq!(parents[1], None);
    }

    #[test]
    fn different_gene_qualifier_excluded_from_group() {
        let features = vec![
            feat("mRNA", vec![(100, 1000)], Strand::Plus, vec![("gene", "A")]),
            feat("CDS", vec![(200, 800)], Strand::Plus, vec![("gene", "B")]),
        ];
        let cids = ids(&[(0, "A.mrna.1"), (1, "B.cds.1")]);
        let parents = infer_parent_edges(&features, &cids);
        assert_eq!(parents[1], None);
    }

    #[test]
    fn locus_tag_fallback_groups_correctly() {
        let features = vec![
            feat(
                "mRNA",
                vec![(100, 1000)],
                Strand::Plus,
                vec![("locus_tag", "b0001")],
            ),
            feat(
                "CDS",
                vec![(200, 800)],
                Strand::Plus,
                vec![("locus_tag", "b0001")],
            ),
        ];
        let cids = ids(&[(0, "b0001.mrna.1"), (1, "b0001.cds.1")]);
        let parents = infer_parent_edges(&features, &cids);
        assert_eq!(parents[1], Some("b0001.mrna.1".to_string()));
    }

    #[test]
    fn transcript_synonym_acts_as_parent() {
        let features = vec![
            feat(
                "transcript",
                vec![(100, 1000)],
                Strand::Plus,
                vec![("gene", "T")],
            ),
            feat("CDS", vec![(200, 800)], Strand::Plus, vec![("gene", "T")]),
        ];
        let cids = ids(&[(0, "T.transcript.1"), (1, "T.cds.1")]);
        let parents = infer_parent_edges(&features, &cids);
        assert_eq!(parents[1], Some("T.transcript.1".to_string()));
    }

    #[test]
    fn unnamed_features_skip_inference() {
        let features = vec![
            feat("mRNA", vec![(100, 1000)], Strand::Plus, vec![]),
            feat("CDS", vec![(200, 800)], Strand::Plus, vec![]),
        ];
        let cids = ids(&[(0, "cX_100-1000_F_mrna"), (1, "cX_200-800_F_cds")]);
        let parents = infer_parent_edges(&features, &cids);
        assert_eq!(
            parents[1], None,
            "unnamed features don't participate in inference"
        );
    }
}
