
use crate::model::{Feature, Strand};

pub const MAX_LANES: u32 = 32;

pub const OVERFLOW_LANE: u32 = u32::MAX;

pub fn assign_lanes(features: &[Feature]) -> Vec<u32> {
    let mut out: Vec<u32> = vec![0; features.len()];
    for target_strand in [Strand::Plus, Strand::Minus, Strand::Unknown] {
        assign_lanes_within_strand(features, target_strand, &mut out);
    }
    out
}

fn assign_lanes_within_strand(features: &[Feature], target_strand: Strand, out: &mut [u32]) {
    let mut entries: Vec<(usize, u64, u64)> = features
        .iter()
        .enumerate()
        .filter(|(_, f)| f.strand == target_strand)
        .map(|(i, f)| (i, f.start(), f.end()))
        .collect();
    entries.sort_by_key(|&(i, s, e)| (s, e, i));

    let mut lane_max_end: Vec<u64> = Vec::new();
    for (orig_idx, start, end) in entries {
        let mut placed_lane: Option<u32> = None;
        for (lane_idx, max_end) in lane_max_end.iter_mut().enumerate() {
            if *max_end < start {
                *max_end = end;
                placed_lane = Some(lane_idx as u32);
                break;
            }
        }
        let lane = match placed_lane {
            Some(l) => l,
            None => {
                if (lane_max_end.len() as u32) < MAX_LANES {
                    lane_max_end.push(end);
                    (lane_max_end.len() - 1) as u32
                } else {
                    OVERFLOW_LANE
                }
            }
        };
        out[orig_idx] = lane;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Feature, Interval, Strand};

    fn feat(start: u64, end: u64) -> Feature {
        Feature {
            feature_type: "test".into(),
            strand: Strand::Plus,
            intervals: vec![Interval { start, end }],
            qualifiers: vec![],
            location_string: format!("{}..{}", start, end),
        }
    }

    #[test]
    fn non_overlapping_all_zero() {
        let features = vec![feat(1, 10), feat(20, 30), feat(40, 50)];
        assert_eq!(assign_lanes(&features), vec![0, 0, 0]);
    }

    #[test]
    fn overlap_pushes_next_lane() {
        let features = vec![feat(1, 10), feat(5, 15)];
        assert_eq!(assign_lanes(&features), vec![0, 1]);
    }

    #[test]
    fn three_way_overlap_uses_three_lanes() {
        let features = vec![feat(1, 10), feat(3, 12), feat(5, 20)];
        assert_eq!(assign_lanes(&features), vec![0, 1, 2]);
    }

    #[test]
    fn touching_features_stack_separately() {
        let features = vec![feat(1, 10), feat(10, 20)];
        assert_eq!(assign_lanes(&features), vec![0, 1]);
    }

    #[test]
    fn adjacent_non_overlapping_reuses_lane() {
        let features = vec![feat(1, 10), feat(11, 20)];
        assert_eq!(assign_lanes(&features), vec![0, 0]);
    }

    #[test]
    fn unsorted_input_produces_deterministic_lanes() {
        let a = vec![feat(1, 10), feat(20, 30), feat(15, 25)];
        let b = vec![feat(20, 30), feat(15, 25), feat(1, 10)];

        let lanes_a = assign_lanes(&a);
        let lanes_b = assign_lanes(&b);

        let mut set_a: Vec<(u64, u64, u32)> = a
            .iter()
            .zip(lanes_a)
            .map(|(f, l)| (f.start(), f.end(), l))
            .collect();
        let mut set_b: Vec<(u64, u64, u32)> = b
            .iter()
            .zip(lanes_b)
            .map(|(f, l)| (f.start(), f.end(), l))
            .collect();
        set_a.sort();
        set_b.sort();
        assert_eq!(set_a, set_b);
    }

    #[test]
    fn deterministic_across_runs() {
        let features = vec![feat(1, 100), feat(50, 200), feat(150, 250), feat(300, 400)];
        let run1 = assign_lanes(&features);
        let run2 = assign_lanes(&features);
        assert_eq!(run1, run2);
    }

    #[test]
    fn overflow_marker_when_too_many_overlap() {
        let features: Vec<Feature> = (0..(MAX_LANES + 1))
            .map(|i| feat(1, 100 + i as u64))
            .collect();
        let lanes = assign_lanes(&features);
        assert_eq!(lanes.len(), (MAX_LANES + 1) as usize);
        let max_assigned = lanes.iter().filter(|&&l| l != OVERFLOW_LANE).max().unwrap();
        assert_eq!(*max_assigned, MAX_LANES - 1);
        let overflow_count = lanes.iter().filter(|&&l| l == OVERFLOW_LANE).count();
        assert_eq!(overflow_count, 1);
    }

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(assign_lanes(&[]), Vec::<u32>::new());
    }

    fn feat_strand(start: u64, end: u64, strand: Strand) -> Feature {
        Feature {
            feature_type: "test".into(),
            strand,
            intervals: vec![Interval { start, end }],
            qualifiers: vec![],
            location_string: format!("{}..{}", start, end),
        }
    }

    #[test]
    fn plus_and_minus_at_same_coords_share_lane_zero() {
        let features = vec![
            feat_strand(100, 200, Strand::Plus),
            feat_strand(100, 200, Strand::Minus),
        ];
        let lanes = assign_lanes(&features);
        assert_eq!(
            lanes,
            vec![0, 0],
            "plus and minus at the same coords both get lane 0; got {:?}",
            lanes
        );
    }

    #[test]
    fn dense_overlap_on_minus_does_not_inflate_plus_lanes() {
        let mut features = Vec::new();
        for i in 0..5 {
            features.push(feat_strand(100 + i, 200 + i, Strand::Minus));
        }
        features.push(feat_strand(100, 200, Strand::Plus));
        let lanes = assign_lanes(&features);

        assert_eq!(*lanes.last().unwrap(), 0);

        let mut minus_lanes: Vec<u32> = lanes[..5].to_vec();
        minus_lanes.sort();
        assert_eq!(minus_lanes, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn unknown_strand_has_its_own_lane_stack() {
        let features = vec![
            feat_strand(100, 200, Strand::Plus),
            feat_strand(100, 200, Strand::Unknown),
            feat_strand(100, 200, Strand::Minus),
        ];
        let lanes = assign_lanes(&features);
        assert_eq!(lanes, vec![0, 0, 0]);
    }

    #[test]
    fn mixed_strand_input_preserves_per_strand_greedy() {
        let features = vec![
            feat_strand(100, 200, Strand::Plus),
            feat_strand(150, 250, Strand::Minus),
            feat_strand(300, 400, Strand::Plus),
        ];
        let lanes = assign_lanes(&features);
        assert_eq!(lanes, vec![0, 0, 0]);
    }
}
