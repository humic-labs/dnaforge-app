use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

pub const DEFAULT_MIN_BIND_LENGTH: usize = 18;
pub const SEED_MAX_EDIT: usize = 2;
pub const SEGMENT_COUNT: usize = 3;
pub const SEGMENT_LENGTH: usize = DEFAULT_MIN_BIND_LENGTH / SEGMENT_COUNT;
pub const MAX_HITS_PER_PRIMER: usize = 10;

#[derive(Debug, Clone, Deserialize)]
pub struct Primer {
    pub name: String,
    pub sequence: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Binding {
    pub primer_name: String,
    pub primer_sequence: String,
    pub target_start: i64,
    pub target_end: i64,
    pub strand: i8,
    pub edit_distance: usize,
    pub identity: f64,
    pub binding_length: usize,
    pub tail: String,
    #[serde(skip)]
    pub seed_start: i64,
}

mod iupac_complements;
use iupac_complements::complement;

pub fn reverse_complement(seq: &[u8]) -> Vec<u8> {
    seq.iter().rev().map(|&b| complement(b)).collect()
}

struct PrimerPlan {
    primer_index: usize,
    primer_sequence: Vec<u8>,
    seed: Vec<u8>,
    rc_seed: Vec<u8>,
    seed_len: usize,
    tail_len: usize,
}

#[derive(Clone)]
struct SegmentPlan {
    primer_index: usize,
    strand: i8,
    seed_offset: i64,
}

struct PrimerIndex {
    plans: Vec<PrimerPlan>,
    fallback_indices: Vec<usize>,
    segment_lookup: HashMap<[u8; SEGMENT_LENGTH], Vec<SegmentPlan>>,
    max_primer_len: usize,
}

fn seed_segments(seed: &[u8]) -> impl Iterator<Item = (usize, [u8; SEGMENT_LENGTH])> + '_ {
    (0..seed.len())
        .step_by(SEGMENT_LENGTH)
        .filter_map(move |offset| {
            let end = offset + SEGMENT_LENGTH;
            if end <= seed.len() {
                let mut seg = [0u8; SEGMENT_LENGTH];
                seg.copy_from_slice(&seed[offset..end]);
                Some((offset, seg))
            } else {
                None
            }
        })
}

fn build_segment_lookup(plans: &[PrimerPlan]) -> HashMap<[u8; SEGMENT_LENGTH], Vec<SegmentPlan>> {
    let mut lookup: HashMap<[u8; SEGMENT_LENGTH], Vec<SegmentPlan>> = HashMap::new();
    for (plan_pos, plan) in plans.iter().enumerate() {
        for (offset, segment) in seed_segments(&plan.seed) {
            lookup.entry(segment).or_default().push(SegmentPlan {
                primer_index: plan_pos,
                strand: 1,
                seed_offset: offset as i64,
            });
            let rc = reverse_complement(&segment);
            let mut rc_key = [0u8; SEGMENT_LENGTH];
            rc_key.copy_from_slice(&rc);
            lookup.entry(rc_key).or_default().push(SegmentPlan {
                primer_index: plan_pos,
                strand: -1,
                seed_offset: plan.seed_len as i64 - offset as i64 - SEGMENT_LENGTH as i64,
            });
        }
    }
    lookup
}

fn prepare_primer_index(primers: &[Primer]) -> PrimerIndex {
    let mut plans: Vec<PrimerPlan> = Vec::new();
    let mut fallback_indices: Vec<usize> = Vec::new();
    let mut max_primer_len = 0usize;

    for (primer_index, primer) in primers.iter().enumerate() {
        let primer_seq = primer.sequence.to_ascii_uppercase().into_bytes();
        if primer_seq.len() < 6 {
            continue;
        }
        let seed_len = DEFAULT_MIN_BIND_LENGTH.min(primer_seq.len());
        if seed_len < DEFAULT_MIN_BIND_LENGTH {
            fallback_indices.push(primer_index);
            continue;
        }
        let seed = primer_seq[primer_seq.len() - seed_len..].to_vec();
        let rc_seed = reverse_complement(&seed);
        max_primer_len = max_primer_len.max(primer_seq.len());
        plans.push(PrimerPlan {
            primer_index,
            tail_len: primer_seq.len() - seed_len,
            primer_sequence: primer_seq,
            seed,
            rc_seed,
            seed_len,
        });
    }

    let segment_lookup = build_segment_lookup(&plans);
    PrimerIndex {
        plans,
        fallback_indices,
        segment_lookup,
        max_primer_len,
    }
}

fn hamming_at_most(left: &[u8], right: &[u8], max_distance: usize) -> Option<usize> {
    if left.len() != right.len() {
        return None;
    }
    let mut distance = 0usize;
    for (l, r) in left.iter().zip(right.iter()) {
        if l != r {
            distance += 1;
            if distance > max_distance {
                return None;
            }
        }
    }
    Some(distance)
}

fn extend_5prime(primer: &[u8], search: &[u8], seed_start: i64, seed_len: usize) -> usize {
    let primer_len = primer.len();
    let tail_len = primer_len - seed_len;
    let mut ext: usize = 0;
    while ext < tail_len && seed_start - 1 - ext as i64 >= 0 {
        let p_idx = primer_len - seed_len - 1 - ext;
        let t_idx = (seed_start - 1 - ext as i64) as usize;
        if primer[p_idx] != search[t_idx] {
            break;
        }
        ext += 1;
    }
    ext
}

fn extend_reverse_5prime(plan: &PrimerPlan, search: &[u8], seed_start: i64) -> usize {
    let mut ext: usize = 0;
    while ext < plan.tail_len {
        let primer_idx = plan.primer_sequence.len() - plan.seed_len - 1 - ext;
        let target_idx = seed_start as usize + plan.seed_len + ext;
        if target_idx >= search.len() {
            break;
        }
        if plan.primer_sequence[primer_idx] != complement(search[target_idx]) {
            break;
        }
        ext += 1;
    }
    ext
}

#[inline]
fn normalize_end(raw_end: i64, target_len: i64) -> i64 {
    if raw_end % target_len == 0 && raw_end > 0 {
        target_len
    } else {
        raw_end % target_len
    }
}

fn make_binding(
    plan: &PrimerPlan,
    primer_name: &str,
    target_start: i64,
    target_end: i64,
    strand: i8,
    seed_ed: usize,
    binding_length: usize,
    seed_start: i64,
) -> Binding {
    let tail_end = plan.primer_sequence.len() - binding_length;
    let tail = if tail_end > 0 {
        String::from_utf8_lossy(&plan.primer_sequence[..tail_end]).into_owned()
    } else {
        String::new()
    };
    let identity = if binding_length > 0 {
        1.0 - (seed_ed as f64 / binding_length as f64)
    } else {
        0.0
    };
    Binding {
        primer_name: primer_name.to_string(),
        primer_sequence: String::from_utf8_lossy(&plan.primer_sequence).into_owned(),
        target_start,
        target_end,
        strand,
        edit_distance: seed_ed,
        identity,
        binding_length,
        tail,
        seed_start,
    }
}

#[allow(clippy::too_many_arguments)]
fn forward_hit(
    plan: &PrimerPlan,
    primer_name: &str,
    search: &[u8],
    target_len: i64,
    seed_start: i64,
) -> Option<Binding> {
    let observed = &search[seed_start as usize..seed_start as usize + plan.seed_len];
    let seed_ed = hamming_at_most(&plan.seed, observed, SEED_MAX_EDIT)?;
    let ext = extend_5prime(&plan.primer_sequence, search, seed_start, plan.seed_len);
    let binding_length = plan.seed_len + ext;
    let match_start = seed_start - ext as i64;
    let match_end = seed_start + plan.seed_len as i64;
    if match_start < 0 {
        return None;
    }
    let target_start = match_start % target_len;
    let target_end = normalize_end(match_end, target_len);
    Some(make_binding(
        plan,
        primer_name,
        target_start,
        target_end,
        1,
        seed_ed,
        binding_length,
        seed_start,
    ))
}

fn reverse_hit(
    plan: &PrimerPlan,
    primer_name: &str,
    search: &[u8],
    target_len: i64,
    seed_start: i64,
) -> Option<Binding> {
    let observed = &search[seed_start as usize..seed_start as usize + plan.seed_len];
    let seed_ed = hamming_at_most(&plan.rc_seed, observed, SEED_MAX_EDIT)?;
    let ext = extend_reverse_5prime(plan, search, seed_start);
    let binding_length = plan.seed_len + ext;
    let match_start = seed_start;
    let match_end = seed_start + plan.seed_len as i64 + ext as i64;
    let target_start = match_start % target_len;
    let target_end = normalize_end(match_end, target_len);
    Some(make_binding(
        plan,
        primer_name,
        target_start,
        target_end,
        -1,
        seed_ed,
        binding_length,
        seed_start,
    ))
}

fn best_seed_hits_by_strand(hits: Vec<Binding>) -> Vec<Binding> {
    let mut selected: Vec<Binding> = Vec::new();
    for strand in [1i8, -1] {
        let min_edit = hits
            .iter()
            .filter(|h| h.strand == strand)
            .map(|h| h.edit_distance)
            .min();
        if let Some(min_edit) = min_edit {
            selected.extend(
                hits.iter()
                    .filter(|h| h.strand == strand && h.edit_distance == min_edit)
                    .cloned(),
            );
        }
    }
    selected.sort_by_key(|h| (if h.strand == 1 { 0 } else { 1 }, h.seed_start));
    selected
}

pub fn bind_one_target(
    target: &str,
    primers: &[Primer],
    max_edit: u32,
) -> (Vec<Binding>, Vec<usize>) {
    let target_upper = target.to_ascii_uppercase().into_bytes();
    let target_len = target_upper.len();
    if target_len == 0 {
        return (Vec::new(), Vec::new());
    }
    let index = prepare_primer_index(primers);
    if index.plans.is_empty() {
        return (Vec::new(), index.fallback_indices);
    }

    let overlap = index.max_primer_len.min(target_len);
    let mut search = target_upper.clone();
    search.extend_from_slice(&target_upper[..overlap]);
    let target_len_i = target_len as i64;

    let mut hits_by_primer: Vec<Vec<Binding>> = vec![Vec::new(); index.plans.len()];
    let mut seen_by_primer: Vec<HashSet<(i64, i64, i8)>> = vec![HashSet::new(); index.plans.len()];
    let mut checked: HashSet<(usize, i8, i64)> = HashSet::new();

    if search.len() >= SEGMENT_LENGTH {
        for pos in 0..=(search.len() - SEGMENT_LENGTH) {
            let mut seg = [0u8; SEGMENT_LENGTH];
            seg.copy_from_slice(&search[pos..pos + SEGMENT_LENGTH]);
            let Some(segment_plans) = index.segment_lookup.get(&seg) else {
                continue;
            };
            for sp in segment_plans {
                let plan = &index.plans[sp.primer_index];
                let seed_start = pos as i64 - sp.seed_offset;
                if seed_start < 0 || seed_start + plan.seed_len as i64 > search.len() as i64 {
                    continue;
                }
                let checked_key = (sp.primer_index, sp.strand, seed_start);
                if !checked.insert(checked_key) {
                    continue;
                }
                let primer_name = &primers[plan.primer_index].name;
                let maybe = if sp.strand == 1 {
                    forward_hit(plan, primer_name, &search, target_len_i, seed_start)
                } else {
                    reverse_hit(plan, primer_name, &search, target_len_i, seed_start)
                };
                let Some(hit) = maybe else { continue };
                if hit.edit_distance > max_edit as usize {
                    continue;
                }
                let pos_key = (hit.target_start, hit.target_end, hit.strand);
                if seen_by_primer[sp.primer_index].insert(pos_key) {
                    hits_by_primer[sp.primer_index].push(hit);
                }
            }
        }
    }

    let mut results: Vec<Binding> = Vec::new();
    for primer_hits in hits_by_primer {
        let best = best_seed_hits_by_strand(primer_hits);
        results.extend(best.into_iter().take(MAX_HITS_PER_PRIMER));
    }
    (results, index.fallback_indices)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn primer(name: &str, seq: &str) -> Primer {
        Primer {
            name: name.into(),
            sequence: seq.into(),
        }
    }

    #[test]
    fn revcomp_basic() {
        assert_eq!(reverse_complement(b"AATTGC"), b"GCAATT");
        assert_eq!(reverse_complement(b"NNAC"), b"GTNN");
    }

    fn independent_base_set(base: u8) -> u8 {
        match base {
            b'A' => 1,
            b'C' => 2,
            b'G' => 4,
            b'T' => 8,
            b'R' => 1 | 4,
            b'Y' => 2 | 8,
            b'S' => 2 | 4,
            b'W' => 1 | 8,
            b'K' => 4 | 8,
            b'M' => 1 | 2,
            b'B' => 2 | 4 | 8,
            b'D' => 1 | 4 | 8,
            b'H' => 1 | 2 | 8,
            b'V' => 1 | 2 | 4,
            b'N' => 1 | 2 | 4 | 8,
            _ => panic!("Unsupported independent DNA code"),
        }
    }

    fn independent_reverse_complement(sequence: &[u8]) -> Vec<u8> {
        let alphabet = b"ACGTRYSWKMBDHVN";
        sequence
            .iter()
            .rev()
            .map(|base| {
                let set = independent_base_set(*base);
                let complementary =
                    ((set & 1) << 3) | ((set & 2) << 1) | ((set & 4) >> 1) | ((set & 8) >> 3);
                *alphabet
                    .iter()
                    .find(|code| independent_base_set(**code) == complementary)
                    .unwrap()
            })
            .collect()
    }

    #[test]
    fn iupac_triplets_preserve_base_sets_and_dna_involution() {
        let alphabet = b"ACGTRYSWKMBDHVN";
        for a in alphabet {
            for b in alphabet {
                for c in alphabet {
                    let source = [*a, *b, *c];
                    let actual = reverse_complement(&source);
                    assert_eq!(actual, independent_reverse_complement(&source));
                    assert_eq!(reverse_complement(&actual), source);
                }
            }
        }
        assert_eq!(reverse_complement(b"acgturyswkmbdhvn"), b"NBDHVKMWSRYAACGT");
        assert_eq!(reverse_complement(b"-. *?X"), b"NNNNNN");
    }

    #[test]
    fn restricted_seed_and_reverse_tail_keep_independent_binding_coordinates() {
        for sequence in ["ACGTRYSWKMBDHVNACG", "RYSWKMACGTCAGTCAGATCGTAC"] {
            let reverse =
                String::from_utf8(independent_reverse_complement(sequence.as_bytes())).unwrap();
            let target = format!("TTTTGGGG{reverse}CCCCAAAA");
            let (hits, deferred) = bind_one_target(&target, &[primer("iupac", sequence)], 2);
            assert!(deferred.is_empty());
            assert!(hits.iter().any(|hit| hit.strand == -1
                && hit.edit_distance == 0
                && hit.target_start == 8
                && hit.target_end == 8 + sequence.len() as i64
                && hit.binding_length == sequence.len()
                && hit.tail.is_empty()));
        }
    }

    #[test]
    fn iupac_reverse_origin_crossing_retains_ordered_coordinates() {
        let sequence = "ACGTRYSWKMBDHVNACG";
        let reverse =
            String::from_utf8(independent_reverse_complement(sequence.as_bytes())).unwrap();
        let split = 7;
        let target = format!("{}TTTTGGGGCCCCAAAA{}", &reverse[split..], &reverse[..split]);
        let (hits, deferred) = bind_one_target(&target, &[primer("origin", sequence)], 2);
        assert!(deferred.is_empty());
        assert!(hits.iter().any(|hit| hit.strand == -1
            && hit.edit_distance == 0
            && hit.target_start == (target.len() - split) as i64
            && hit.target_end == (sequence.len() - split) as i64
            && hit.binding_length == sequence.len()));
    }

    #[test]
    fn reverse_seed_cannot_claim_exact_from_coerced_unknown_symbols() {
        let (hits, deferred) = bind_one_target(
            "TTTTGGGGCGTNNNNNNNNNNNACGTCCCCAAAA",
            &[primer("restricted", "ACGTRYSWKMBDHVNACG")],
            2,
        );
        assert!(deferred.is_empty());
        assert!(!hits
            .iter()
            .any(|hit| hit.strand == -1 && hit.edit_distance == 0));
    }

    #[test]
    fn iupac_short_primers_stay_explicitly_deferred() {
        let (hits, deferred) = bind_one_target(
            "ACGTRYSWKMBDHVNACG",
            &[
                primer("six", "ACGTRY"),
                primer("eleven", "ACGTRYSWKMB"),
                primer("seventeen", "ACGTRYSWKMBDHVNAC"),
            ],
            2,
        );
        assert!(hits.is_empty());
        assert_eq!(deferred, vec![0, 1, 2]);
    }

    #[test]
    fn requested_bound_precedes_cap_and_preserves_reverse_exact_hit() {
        let seed = "ACGTCAGTCAGATCGTAC";
        let target = format!(
            "{}GTACGATCTGACTGACGT",
            "ACGTCAGTCAGATCGTATGGGGGGGGGG".repeat(11)
        );
        let (hits, deferred) = bind_one_target(&target, &[primer("p", seed)], 0);
        assert!(deferred.is_empty());
        assert_eq!(hits.len(), 1);
        let h = &hits[0];
        assert_eq!(
            (h.target_start, h.target_end, h.strand, h.edit_distance),
            (308, 326, -1, 0)
        );
    }

    #[test]
    fn requested_bound_preserves_fixed_substitution_ceiling() {
        let seed = "ACGTCAGTCAGATCGTAC";
        for (observed, distance) in [
            (seed, 0),
            ("ACGTCAGTCAGATCGTAT", 1),
            ("ACGTCAGTCAGATCGTCT", 2),
            ("ACGTCAGTCAGATCGACT", 3),
        ] {
            for bound in [0, 1, 2, 3, 5, 40] {
                let target = format!("GGGGGG{observed}CCCCCC");
                let (hits, _) = bind_one_target(&target, &[primer("p", seed)], bound);
                assert!(hits.iter().all(|h| h.edit_distance <= bound as usize));
                let forward: Vec<_> = hits.iter().filter(|h| h.strand == 1).collect();
                if distance <= bound.min(2) as usize {
                    assert!(forward.iter().any(|h| h.target_start == 6
                        && h.target_end == 24
                        && h.edit_distance == distance));
                } else {
                    assert!(forward.is_empty());
                }
            }
        }
    }

    #[test]
    fn forward_exact_18mer_binds_at_offset() {
        let seed = "ACGTACGTACGTACGTAC";
        let target = format!("CCCC{seed}GGGG");
        let (hits, deferred) = bind_one_target(&target, &[primer("p", seed)], 2);
        assert!(deferred.is_empty());
        let fwd: Vec<_> = hits.iter().filter(|h| h.strand == 1).collect();
        assert_eq!(fwd.len(), 1, "one forward hit, got {hits:?}");
        let h = fwd[0];
        assert_eq!(h.target_start, 4);
        assert_eq!(h.target_end, 22);
        assert_eq!(h.binding_length, 18);
        assert_eq!(h.edit_distance, 0);
        assert_eq!(h.tail, "");
        assert!((h.identity - 1.0).abs() < 1e-9);
    }

    #[test]
    fn tail_terminates_extension_and_is_reported() {
        let seed = "ACGTACGTACGTACGTAC";
        let primer_seq = format!("TTTT{seed}");
        let target = format!("GGGG{seed}CCCC");
        let (hits, _) = bind_one_target(&target, &[primer("p", &primer_seq)], 2);
        let fwd: Vec<_> = hits.iter().filter(|h| h.strand == 1).collect();
        assert_eq!(fwd.len(), 1);
        let h = fwd[0];
        assert_eq!(h.binding_length, 18, "no extension into GGGG");
        assert_eq!(h.tail, "TTTT");
        assert_eq!(h.target_start, 4);
    }

    #[test]
    fn tail_extends_when_template_matches() {
        let seed = "ACGTACGTACGTACGTAC";
        let primer_seq = format!("TTTT{seed}");
        let target = format!("GGGGTTTT{seed}CCCC");
        let (hits, _) = bind_one_target(&target, &[primer("p", &primer_seq)], 2);
        let fwd: Vec<_> = hits.iter().filter(|h| h.strand == 1).collect();
        assert_eq!(fwd.len(), 1);
        let h = fwd[0];
        assert_eq!(h.binding_length, 22, "extended through TTTT");
        assert_eq!(h.tail, "");
        assert_eq!(h.target_start, 4);
    }

    #[test]
    fn reverse_strand_binds() {
        let seed = "ACGTACGTACGTACGTAC";
        let rc = String::from_utf8(reverse_complement(seed.as_bytes())).unwrap();
        let target = format!("CCCC{rc}GGGG");
        let (hits, _) = bind_one_target(&target, &[primer("p", seed)], 2);
        let rev: Vec<_> = hits.iter().filter(|h| h.strand == -1).collect();
        assert_eq!(rev.len(), 1, "one reverse hit, got {hits:?}");
        assert_eq!(rev[0].binding_length, 18);
    }

    #[test]
    fn short_primer_deferred_not_silently_dropped() {
        let (hits, deferred) = bind_one_target("ACGTACGTACGT", &[primer("short", "ACGTAC")], 2);
        assert!(hits.is_empty());
        assert_eq!(
            deferred,
            vec![0],
            "short primers are surfaced for the reference path"
        );
    }

    #[test]
    fn one_substitution_in_seed_is_tolerated() {
        let seed = "ACGTACGTACGTACGTAC";
        let mut t = seed.as_bytes().to_vec();
        t[0] = b'G';
        let target = format!("CCCC{}GGGG", String::from_utf8(t).unwrap());
        let (hits, _) = bind_one_target(&target, &[primer("p", seed)], 2);
        let fwd: Vec<_> = hits.iter().filter(|h| h.strand == 1).collect();
        assert_eq!(fwd.len(), 1);
        assert_eq!(fwd[0].edit_distance, 1);
    }
}
