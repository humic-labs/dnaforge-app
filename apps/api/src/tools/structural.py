"""
Structural Region Detection for Sequence Alignments

Detects and classifies structural variants in pairwise alignments:
- Deletions, insertions, inversions, duplications
- Truncations, replacements, chimeras
- Distinguishes point mutations from structural changes

Based on spec: tools/devops/plans/2026-01-23-structural-region-detection-spec.md
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class StructuralType(str, Enum):
    """Types of structural variants."""

    DELETION = "deletion"
    INSERTION = "insertion"
    TRUNCATION = "truncation"
    TANDEM_DUPLICATION = "tandem_duplication"
    DISPERSED_DUPLICATION = "dispersed_duplication"
    INVERSION = "inversion"
    REPLACEMENT = "replacement"
    CHIMERA = "chimera"
    COMPLEX = "complex"


class OverallAssessment(str, Enum):
    """Overall assessment of alignment quality."""

    PASS = "PASS"
    FAIL = "FAIL"
    REVIEW = "REVIEW"


@dataclass
class CoordinateMaps:
    """Bidirectional mappings between alignment columns and sequence positions."""

    column_to_ref: list[int]
    column_to_query: list[int]
    ref_to_column: list[int]
    query_to_column: list[int]


@dataclass
class HomopolymerRegion:
    """A homopolymer run in the sequence."""

    start: int
    end: int
    base: str
    length: int


@dataclass
class StructuralRegion:
    """A detected structural variant region."""

    id: str
    type: StructuralType
    confidence: float
    severity: str

    column_start: int
    column_end: int
    ref_start: Optional[int]
    ref_end: Optional[int]
    query_start: Optional[int]
    query_end: Optional[int]

    length_columns: int
    length_ref: int
    length_query: int
    forward_identity: float
    rc_identity: Optional[float] = None
    gap_ratio_ref: float = 0.0
    gap_ratio_query: float = 0.0

    classification_method: str = ""
    classification_details: str = ""

    mutation_indices: list[int] = field(default_factory=list)


def build_coordinate_maps(aligned_ref: str, aligned_query: str) -> dict:
    """
    Build bidirectional coordinate maps between alignment columns and positions.

    Returns dict with:
    - column_to_ref: list where index is column (0-indexed), value is ref position (1-indexed, -1 for gaps)
    - column_to_query: same for query
    - ref_to_column: list where index is ref position (0-indexed), value is first column
    - query_to_column: same for query
    """
    alignment_length = len(aligned_ref)

    column_to_ref = []
    column_to_query = []

    ref_pos = 0
    query_pos = 0

    for col in range(alignment_length):
        ref_base = aligned_ref[col]
        query_base = aligned_query[col]

        if ref_base == "-":
            column_to_ref.append(-1)
        else:
            ref_pos += 1
            column_to_ref.append(ref_pos)

        if query_base == "-":
            column_to_query.append(-1)
        else:
            query_pos += 1
            column_to_query.append(query_pos)

    ref_length = sum(1 for c in aligned_ref if c != "-")
    query_length = sum(1 for c in aligned_query if c != "-")

    ref_to_column = [-1] * (ref_length + 1)
    query_to_column = [-1] * (query_length + 1)

    for col, ref_p in enumerate(column_to_ref):
        if ref_p > 0 and ref_to_column[ref_p] == -1:
            ref_to_column[ref_p] = col

    for col, query_p in enumerate(column_to_query):
        if query_p > 0 and query_to_column[query_p] == -1:
            query_to_column[query_p] = col

    return {
        "column_to_ref": column_to_ref,
        "column_to_query": column_to_query,
        "ref_to_column": ref_to_column,
        "query_to_column": query_to_column,
    }


def find_homopolymer_regions(sequence: str, min_length: int = 5) -> list[dict]:
    """
    Find homopolymer runs in a sequence.

    Args:
        sequence: DNA sequence (may contain gaps)
        min_length: Minimum run length to report

    Returns:
        List of dicts with start, end (1-indexed), base, length
    """
    ungapped = sequence.replace("-", "")
    regions = []

    i = 0
    while i < len(ungapped):
        base = ungapped[i]
        run_length = 1

        while i + run_length < len(ungapped) and ungapped[i + run_length] == base:
            run_length += 1

        if run_length >= min_length:
            regions.append(
                {
                    "start": i + 1,
                    "end": i + run_length,
                    "base": base,
                    "length": run_length,
                }
            )

        i += run_length

    return regions


def apply_quality_trimming(
    alignment_length: int,
    quality_scores: Optional[list[int]] = None,
    default_trim_start: int = 30,
    default_trim_end: int = 50,
    quality_threshold: int = 20,
    window_size: int = 5,
) -> tuple[int, int]:
    """
    Determine trim positions based on quality scores.

    Returns (trim_start, trim_end) - positions outside these are untrusted.
    """
    if quality_scores is None:
        return default_trim_start, alignment_length - default_trim_end

    trim_start = 0
    for i in range(len(quality_scores) - window_size + 1):
        window = quality_scores[i : i + window_size]
        if sum(window) / len(window) >= quality_threshold:
            trim_start = i
            break

    trim_end = len(quality_scores)
    for i in range(len(quality_scores) - window_size, -1, -1):
        window = quality_scores[i : i + window_size]
        if sum(window) / len(window) >= quality_threshold:
            trim_end = i + window_size
            break

    return trim_start, trim_end


def calculate_window_identity(
    aligned_ref: str, aligned_query: str, start: int, end: int
) -> float:
    """
    Calculate identity within a window.

    CRITICAL: Gaps count against identity (included in denominator).

    Returns identity as float between 0.0 and 1.0.
    """
    if start >= end or start < 0 or end > len(aligned_ref):
        return 0.0

    matches = 0
    aligned_length = 0

    for i in range(start, end):
        ref_base = aligned_ref[i].upper()
        query_base = aligned_query[i].upper()

        if ref_base == "-" and query_base == "-":
            continue

        aligned_length += 1

        if ref_base != "-" and query_base != "-" and ref_base == query_base:
            matches += 1

    if aligned_length == 0:
        return 0.0

    return matches / aligned_length


def detect_structural_regions_from_mutations(
    aligned_ref: str,
    aligned_query: str,
    mutations: list[dict],
    gap_threshold: int = 10,
    min_mutations: int = 3,
    min_region_length: int = 30,
) -> list[dict]:
    """
    Detect structural regions by clustering mutations.

    This approach uses the actual mutation positions as boundaries, avoiding
    the overshoot problem of sliding window methods.

    Args:
        aligned_ref: Aligned reference sequence
        aligned_query: Aligned query sequence
        mutations: List of mutations with 'position' (1-indexed bio position)
        gap_threshold: Max gap between mutations to be in same cluster (columns)
        min_mutations: Minimum mutations to form a structural region
        min_region_length: Minimum length in columns

    Returns list of regions with column_start, column_end based on mutation positions.
    """
    if not mutations:
        return []

    alignment_length = len(aligned_ref)

    ref_pos_to_col = {}
    ref_pos = 0
    for col in range(alignment_length):
        if aligned_ref[col] != "-":
            ref_pos += 1
            ref_pos_to_col[ref_pos] = col

    mutation_cols = []
    for mut in mutations:
        pos = mut.get("position", 0)
        if pos in ref_pos_to_col:
            mutation_cols.append(ref_pos_to_col[pos])

    if not mutation_cols:
        return []

    mutation_cols.sort()

    clusters = []
    current_cluster = [mutation_cols[0]]

    for col in mutation_cols[1:]:
        if col - current_cluster[-1] <= gap_threshold:
            current_cluster.append(col)
        else:
            clusters.append(current_cluster)
            current_cluster = [col]
    clusters.append(current_cluster)

    regions = []
    for cluster in clusters:
        if len(cluster) >= min_mutations:
            col_start = cluster[0]
            col_end = cluster[-1] + 1

            length = col_end - col_start
            if length >= min_region_length:
                identity = calculate_window_identity(
                    aligned_ref, aligned_query, col_start, col_end
                )
                regions.append(
                    {
                        "column_start": col_start,
                        "column_end": col_end,
                        "length_columns": length,
                        "identity": identity,
                        "mutation_count": len(cluster),
                    }
                )

    return regions


def detect_structural_regions(
    aligned_ref: str,
    aligned_query: str,
    coarse_window: int = 100,
    coarse_step: int = 50,
    coarse_threshold: float = 0.85,
    min_region_length: int = 30,
    ignored_columns: Optional[set[int]] = None,
) -> list[dict]:
    """
    Detect structural regions by scanning for mismatches/gaps directly.

    Instead of using sliding window identity (which overshoots boundaries),
    this scans the alignment character-by-character to find exact boundaries
    where mismatches/gaps begin and end.

    Returns list of candidate regions with column_start, column_end, identity stats.
    """
    alignment_length = len(aligned_ref)

    if alignment_length == 0:
        return []

    mismatch_positions = []
    for col in range(alignment_length):
        if ignored_columns and col in ignored_columns:
            continue
        ref_base = aligned_ref[col].upper()
        query_base = aligned_query[col].upper()

        if ref_base != query_base:
            mismatch_positions.append(col)

    if not mismatch_positions:
        return []

    gap_threshold = coarse_window // 2

    clusters = []
    current_cluster = [mismatch_positions[0]]

    for col in mismatch_positions[1:]:
        crosses_unknown = ignored_columns and any(
            value in ignored_columns for value in range(current_cluster[-1] + 1, col)
        )
        if col - current_cluster[-1] <= gap_threshold and not crosses_unknown:
            current_cluster.append(col)
        else:
            clusters.append(current_cluster)
            current_cluster = [col]
    clusters.append(current_cluster)

    regions = []
    for cluster in clusters:
        col_start = cluster[0]
        col_end = cluster[-1] + 1

        length = col_end - col_start
        if length < min_region_length:
            continue

        density = len(cluster) / length
        if density < 0.1:
            continue

        identity = calculate_window_identity(
            aligned_ref, aligned_query, col_start, col_end
        )
        if identity >= coarse_threshold:
            continue

        regions.append(
            {
                "column_start": col_start,
                "column_end": col_end,
                "length_columns": length,
                "identity": identity,
                "mismatch_count": len(cluster),
                "density": density,
            }
        )

    return regions


def reverse_complement(sequence: str) -> str:
    """Return reverse complement of DNA sequence."""
    complement = {"A": "T", "T": "A", "G": "C", "C": "G", "N": "N", "-": "-"}
    return "".join(complement.get(b.upper(), "N") for b in reversed(sequence))


def extract_ungapped(sequence: str) -> str:
    """Extract sequence without gaps."""
    return sequence.replace("-", "")


def count_gaps(sequence: str) -> int:
    """Count gap characters in sequence."""
    return sequence.count("-")


def simple_local_align(seq1: str, seq2: str) -> dict:
    """
    Simple local alignment for classification purposes.

    Returns dict with matches, aligned_length, identity.

    Note: For production, use parasail library for SIMD-accelerated Smith-Waterman.
    This is a simplified implementation for initial development.
    """
    s1 = extract_ungapped(seq1).upper()
    s2 = extract_ungapped(seq2).upper()

    if not s1 or not s2:
        return {"matches": 0, "aligned_length": 0, "identity": 0.0}

    min_len = min(len(s1), len(s2))
    max_len = max(len(s1), len(s2))

    best_matches = 0
    for offset in range(max_len - min_len + 1):
        matches = 0
        for i in range(min_len):
            if len(s1) <= len(s2):
                if s1[i] == s2[i + offset]:
                    matches += 1
            else:
                if s1[i + offset] == s2[i]:
                    matches += 1
        best_matches = max(best_matches, matches)

    s2_rev = s2[::-1]
    for offset in range(max_len - min_len + 1):
        matches = 0
        for i in range(min_len):
            if len(s1) <= len(s2_rev):
                if s1[i] == s2_rev[i + offset]:
                    matches += 1
            else:
                if s1[i + offset] == s2_rev[i]:
                    matches += 1
        best_matches = max(best_matches, matches)

    identity = best_matches / min_len if min_len > 0 else 0.0

    return {"matches": best_matches, "aligned_length": min_len, "identity": identity}


def classify_structural_region(
    region_ref: str,
    region_query: str,
    left_flank: str = "",
    right_flank: str = "",
    check_inversion: bool = True,
    check_duplication: bool = False,
    is_at_end: bool = False,
    full_reference: str = "",
) -> dict:
    """
    Classify a structural region by type.

    Args:
        region_ref: Reference sequence in the region (may have gaps)
        region_query: Query sequence in the region (may have gaps)
        left_flank: Sequence to the left of region (for duplication check)
        right_flank: Sequence to the right of region
        check_inversion: Whether to check for inversions via RC alignment
        check_duplication: Whether to check for duplications
        is_at_end: Whether this region is at the alignment end
        full_reference: Full reference for dispersed duplication check

    Returns dict with type, confidence, and classification evidence.
    """
    region_length = len(region_ref)

    ref_gaps = count_gaps(region_ref)
    query_gaps = count_gaps(region_query)

    ref_gap_ratio = ref_gaps / region_length if region_length > 0 else 0
    query_gap_ratio = query_gaps / region_length if region_length > 0 else 0

    result = {
        "type": StructuralType.COMPLEX,
        "confidence": 0.5,
        "method": "gap_analysis",
        "details": "",
        "gap_ratio_ref": ref_gap_ratio,
        "gap_ratio_query": query_gap_ratio,
        "forward_identity": 0.0,
        "rc_identity": None,
    }

    if query_gap_ratio > 0.7 and ref_gap_ratio < 0.1:
        result["type"] = StructuralType.DELETION
        result["confidence"] = query_gap_ratio
        result["details"] = f"Query has {query_gap_ratio:.0%} gaps"
        return result

    if ref_gap_ratio > 0.7 and query_gap_ratio < 0.1:
        inserted_seq = extract_ungapped(region_query)

        if check_duplication and (left_flank or right_flank):
            if left_flank:
                left_match = simple_local_align(inserted_seq, left_flank)
                if left_match["identity"] > 0.8:
                    result["type"] = StructuralType.TANDEM_DUPLICATION
                    result["confidence"] = left_match["identity"]
                    result["method"] = "flank_alignment"
                    result["details"] = (
                        f"Insertion matches left flank ({left_match['identity']:.0%})"
                    )
                    return result

            if right_flank:
                right_match = simple_local_align(inserted_seq, right_flank)
                if right_match["identity"] > 0.8:
                    result["type"] = StructuralType.TANDEM_DUPLICATION
                    result["confidence"] = right_match["identity"]
                    result["method"] = "flank_alignment"
                    result["details"] = (
                        f"Insertion matches right flank ({right_match['identity']:.0%})"
                    )
                    return result

        result["type"] = StructuralType.INSERTION
        result["confidence"] = ref_gap_ratio
        result["details"] = f"Reference has {ref_gap_ratio:.0%} gaps"
        return result

    if is_at_end and query_gap_ratio > 0.5:
        result["type"] = StructuralType.TRUNCATION
        result["confidence"] = query_gap_ratio
        result["method"] = "end_analysis"
        result["details"] = "Query truncated before reference end"
        return result

    if check_inversion and region_length >= 30:
        ref_seq = extract_ungapped(region_ref)
        query_seq = extract_ungapped(region_query)

        if len(ref_seq) >= 20 and len(query_seq) >= 20:
            forward_result = simple_local_align(query_seq, ref_seq)
            forward_identity = forward_result["identity"]

            query_rc = reverse_complement(query_seq)
            rc_result = simple_local_align(query_rc, ref_seq)
            rc_identity = rc_result["identity"]

            result["forward_identity"] = forward_identity
            result["rc_identity"] = rc_identity

            if rc_identity > 0.8 and rc_identity > forward_identity + 0.3:
                result["type"] = StructuralType.INVERSION
                result["confidence"] = rc_identity
                result["method"] = "rc_realignment"
                result["details"] = (
                    f"RC alignment identity {rc_identity:.0%} vs forward {forward_identity:.0%}"
                )
                return result

    if ref_gap_ratio < 0.2 and query_gap_ratio < 0.2:
        ref_seq = extract_ungapped(region_ref)
        query_seq = extract_ungapped(region_query)
        match_result = simple_local_align(ref_seq, query_seq)
        result["forward_identity"] = match_result["identity"]

        result["type"] = StructuralType.REPLACEMENT
        result["confidence"] = 1.0 - match_result["identity"]
        result["method"] = "sequence_comparison"
        result["details"] = (
            f"Different sequences with {match_result['identity']:.0%} identity"
        )
        return result

    result["type"] = StructuralType.COMPLEX
    result["confidence"] = 0.5
    result["method"] = "pattern_analysis"
    result["details"] = "Mixed deletion/insertion pattern"
    return result


def determine_severity(region_type: StructuralType, length: int) -> str:
    """Determine severity based on type and size."""
    if region_type in [StructuralType.INVERSION, StructuralType.TRUNCATION]:
        return "high"

    if region_type == StructuralType.REPLACEMENT and length > 50:
        return "high"

    if length > 30:
        return "medium"

    return "low"


def analyze_alignment_structure(
    aligned_ref: str,
    aligned_query: str,
    mutations: list[dict],
    quality_scores: Optional[list[int]] = None,
    check_duplications: bool = False,
    ignored_columns: Optional[set[int]] = None,
) -> dict:
    """
    Full structural analysis of a pairwise alignment.

    Args:
        aligned_ref: Aligned reference sequence with gaps
        aligned_query: Aligned query sequence with gaps
        mutations: List of mutations from alignment (for grouping)
        quality_scores: Optional per-base quality scores
        check_duplications: Whether to check for duplication patterns

    Returns complete analysis dict matching the spec output schema.
    """
    alignment_length = len(aligned_ref)

    coord_maps = build_coordinate_maps(aligned_ref, aligned_query)
    homopolymers = find_homopolymer_regions(aligned_ref)
    trim_start, trim_end = apply_quality_trimming(alignment_length, quality_scores)

    candidate_regions = detect_structural_regions(
        aligned_ref, aligned_query, ignored_columns=ignored_columns
    )

    structural_regions = []

    for i, region in enumerate(candidate_regions):
        col_start = region["column_start"]
        col_end = region["column_end"]

        region_ref = aligned_ref[col_start:col_end]
        region_query = aligned_query[col_start:col_end]

        flank_size = min(200, col_start, alignment_length - col_end)
        left_flank = aligned_ref[max(0, col_start - flank_size) : col_start]
        right_flank = aligned_ref[col_end : min(alignment_length, col_end + flank_size)]

        is_at_end = col_end >= alignment_length - 50

        classification = classify_structural_region(
            region_ref,
            region_query,
            left_flank=extract_ungapped(left_flank),
            right_flank=extract_ungapped(right_flank),
            check_inversion=True,
            check_duplication=check_duplications,
            is_at_end=is_at_end,
        )

        ref_start = None
        ref_end = None
        query_start = None
        query_end = None

        for col in range(col_start, col_end):
            pos = coord_maps["column_to_ref"][col]
            if pos > 0:
                if ref_start is None:
                    ref_start = pos
                ref_end = pos

        for col in range(col_start, col_end):
            pos = coord_maps["column_to_query"][col]
            if pos > 0:
                if query_start is None:
                    query_start = pos
                query_end = pos

        length_ref = len(extract_ungapped(region_ref))
        length_query = len(extract_ungapped(region_query))

        severity = determine_severity(classification["type"], region["length_columns"])

        sr = {
            "id": f"sr_{i + 1:03d}",
            "type": classification["type"],
            "confidence": classification["confidence"],
            "severity": severity,
            "column_start": col_start,
            "column_end": col_end,
            "ref_start": ref_start,
            "ref_end": ref_end,
            "query_start": query_start,
            "query_end": query_end,
            "length_columns": region["length_columns"],
            "length_ref": length_ref,
            "length_query": length_query,
            "forward_identity": classification.get(
                "forward_identity", region["identity"]
            ),
            "rc_identity": classification.get("rc_identity"),
            "gap_ratio_ref": classification["gap_ratio_ref"],
            "gap_ratio_query": classification["gap_ratio_query"],
            "classification_method": classification["method"],
            "classification_details": classification["details"],
            "mutation_indices": [],
        }

        structural_regions.append(sr)

    point_mutations = []

    for mut_idx, mutation in enumerate(mutations):
        col = mutation.get("column", mutation.get("position", 0))
        assigned = False

        for sr in structural_regions:
            if sr["column_start"] <= col < sr["column_end"]:
                sr["mutation_indices"].append(mut_idx)
                assigned = True
                break

        if not assigned:
            point_mut = {
                "index": mut_idx,
                **mutation,
                "in_structural_region": False,
            }
            point_mutations.append(point_mut)

    overall = _compute_overall_assessment(structural_regions, point_mutations)

    warnings = []

    if trim_start > 0 or trim_end < alignment_length:
        warnings.append(
            {
                "type": "quality_trim",
                "message": f"Positions 1-{trim_start} and {trim_end}-{alignment_length} may have low quality",
                "severity": "info",
            }
        )

    for hp in homopolymers:
        warnings.append(
            {
                "type": "homopolymer",
                "message": f"Homopolymer run ({hp['base']}×{hp['length']}) at positions {hp['start']}-{hp['end']}",
                "position": hp["start"],
                "severity": "info",
            }
        )

    return {
        "structural_regions": structural_regions,
        "point_mutations": point_mutations,
        "warnings": warnings,
        "overall_assessment": overall,
        "quality_trim": {"start": trim_start, "end": trim_end},
        "homopolymer_regions": homopolymers,
    }


def _compute_overall_assessment(
    structural_regions: list[dict], point_mutations: list[dict]
) -> dict:
    """Compute overall PASS/FAIL/REVIEW assessment."""
    high_severity = [
        r
        for r in structural_regions
        if r["severity"] == "high" and r["confidence"] > 0.7
    ]

    if high_severity:
        top_issue = high_severity[0]
        return {
            "result": OverallAssessment.FAIL,
            "reason": f"Structural variant detected: {top_issue['length_columns']}bp {top_issue['type'].value} at column {top_issue['column_start']}-{top_issue['column_end']}",
        }

    needs_review = [
        r
        for r in structural_regions
        if r["severity"] == "medium" or r["confidence"] < 0.7
    ]

    if needs_review:
        return {
            "result": OverallAssessment.REVIEW,
            "reason": "Potential structural variants require manual review",
        }

    if point_mutations:
        return {
            "result": OverallAssessment.PASS,
            "reason": f"{len(point_mutations)} point mutation(s) detected",
        }

    return {"result": OverallAssessment.PASS, "reason": "Sequence matches reference"}
