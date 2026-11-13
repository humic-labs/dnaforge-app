"""
Tests for Structural Region Detection

Tests follow the spec at: tools/devops/plans/2026-01-23-structural-region-detection-spec.md

Test categories:
1. Coordinate mapping (Phase 0)
2. Multi-scale structural detection (Phase 1)
3. Structural type classification (Phase 2)
4. Mutation assignment (Phase 3)
5. Overall assessment (Phase 6)
"""

import pytest as pytest

from src.tools.structural import (
    OverallAssessment,
    StructuralType,
    analyze_alignment_structure,
    build_coordinate_maps,
    calculate_window_identity,
    classify_structural_region,
    detect_structural_regions,
    find_homopolymer_regions,
    reverse_complement,
)
from src.tools.structural import StructuralRegion as StructuralRegion


class TestCoordinateMapping:
    """Tests for coordinate map building."""

    def test_simple_ungapped_alignment(self):
        """Ungapped alignment should have 1:1 column to position mapping."""
        ref = "ATGCATGC"
        query = "ATGCATGC"
        maps = build_coordinate_maps(ref, query)

        assert maps["column_to_ref"] == [1, 2, 3, 4, 5, 6, 7, 8]
        assert maps["column_to_query"] == [1, 2, 3, 4, 5, 6, 7, 8]

    def test_reference_gap(self):
        """Gap in reference should yield -1 for that column's ref position."""
        ref = "ATG--CATGC"
        query = "ATGAACATGC"
        maps = build_coordinate_maps(ref, query)

        assert maps["column_to_ref"][3] == -1
        assert maps["column_to_ref"][4] == -1
        assert maps["column_to_query"][3] == 4
        assert maps["column_to_query"][4] == 5

    def test_query_gap(self):
        """Gap in query should yield -1 for that column's query position."""
        ref = "ATGCATGC"
        query = "ATG--TGC"
        maps = build_coordinate_maps(ref, query)

        assert maps["column_to_query"][3] == -1
        assert maps["column_to_query"][4] == -1
        assert maps["column_to_ref"][3] == 4
        assert maps["column_to_ref"][4] == 5

    def test_position_to_column_mapping(self):
        """Test reverse mapping from position to column."""
        ref = "ATG--CATGC"
        query = "ATGAACATGC"
        maps = build_coordinate_maps(ref, query)

        assert maps["ref_to_column"][4] == 5
        assert maps["query_to_column"][4] == 3


class TestHomopolymerDetection:
    """Tests for homopolymer region detection."""

    def test_no_homopolymers(self):
        """Normal sequence should have no homopolymer regions."""
        ref = "ATGCATGCATGC"
        regions = find_homopolymer_regions(ref, min_length=5)
        assert regions == []

    def test_poly_a_detection(self):
        """Poly-A run should be detected."""
        ref = "ATGAAAAATGC"
        regions = find_homopolymer_regions(ref, min_length=5)
        assert len(regions) == 1
        assert regions[0]["start"] == 4
        assert regions[0]["end"] == 8
        assert regions[0]["base"] == "A"

    def test_multiple_homopolymers(self):
        """Multiple homopolymer runs should all be detected."""
        ref = "AAAAATTTTTCCCCC"
        regions = find_homopolymer_regions(ref, min_length=5)
        assert len(regions) == 3

    def test_short_runs_excluded(self):
        """Runs shorter than threshold should not be detected."""
        ref = "AAAATTTGGGCCC"
        regions = find_homopolymer_regions(ref, min_length=5)
        assert regions == []


class TestWindowIdentity:
    """Tests for identity calculation within a window."""

    def test_perfect_match(self):
        """Perfect match should have 100% identity."""
        ref = "ATGCATGC"
        query = "ATGCATGC"
        identity = calculate_window_identity(ref, query, 0, 8)
        assert identity == 1.0

    def test_single_mismatch(self):
        """Single mismatch should reduce identity proportionally."""
        ref = "ATGCATGC"
        query = "ATGCATGG"
        identity = calculate_window_identity(ref, query, 0, 8)
        assert identity == 7 / 8

    def test_gap_counts_against_identity(self):
        """CRITICAL: Gaps must count against identity, not be excluded."""
        ref = "ATGC----ATGC"
        query = "ATGCAAAATGC-"
        identity = calculate_window_identity(ref, query, 0, 12)
        assert identity < 1.0
        assert identity < 0.7

    def test_all_gaps_window(self):
        """Window with all gaps should have 0 identity."""
        ref = "----"
        query = "ATGC"
        identity = calculate_window_identity(ref, query, 0, 4)
        assert identity == 0.0


class TestStructuralDetection:
    """Tests for multi-scale structural region detection."""

    def test_perfect_alignment_no_structural_regions(self):
        """Perfect alignment should detect no structural regions."""
        ref = "ATGC" * 50
        query = "ATGC" * 50
        regions = detect_structural_regions(ref, query)
        assert regions == []

    def test_single_snp_no_structural_region(self):
        """Single SNP should NOT trigger structural detection."""
        ref = "ATGC" * 50
        query = "ATGC" * 25 + "ATGG" + "ATGC" * 24
        regions = detect_structural_regions(ref, query)
        assert regions == []

    def test_50bp_deletion_detected(self):
        """50bp deletion should be detected as structural region."""
        good_left = "ATGC" * 25
        deleted_in_ref = "NNNN" * 12 + "NN"
        good_right = "ATGC" * 25
        ref = good_left + deleted_in_ref + good_right
        query = good_left + "-" * 50 + good_right
        regions = detect_structural_regions(ref, query)
        assert len(regions) >= 1
        assert any(30 <= r["length_columns"] <= 150 for r in regions)

    def test_100bp_insertion_detected(self):
        """100bp insertion should be detected as structural region."""
        ref = "ATGC" * 25 + "-" * 100 + "ATGC" * 25
        query = "ATGC" * 25 + "GGGG" * 25 + "ATGC" * 25
        regions = detect_structural_regions(ref, query)
        assert len(regions) >= 1
        assert any(80 <= r["length_columns"] <= 200 for r in regions)

    def test_low_identity_region_detected(self):
        """Region with many mismatches should be detected."""
        good = "ATGC" * 25
        bad_ref = "AAAA" * 25
        bad_query = "TTTT" * 25
        ref = good + bad_ref + good
        query = good + bad_query + good
        regions = detect_structural_regions(ref, query)
        assert len(regions) == 1

    def test_boundary_refinement(self):
        """Boundaries should be refined to transition points."""
        good = "ATGC" * 30
        ref = good + "A" * 120 + good
        query = good + "T" * 120 + good
        regions = detect_structural_regions(ref, query)
        assert len(regions) == 1
        assert regions[0]["column_start"] < 150
        assert regions[0]["column_end"] > 210


class TestClassification:
    """Tests for structural variant classification."""

    def test_classify_deletion(self):
        """Query with contiguous gaps should be classified as deletion."""
        region_ref = "ATGCATGCATGC" * 5
        region_query = "-" * 60
        result = classify_structural_region(region_ref, region_query)
        assert result["type"] == StructuralType.DELETION
        assert result["confidence"] > 0.7

    def test_classify_insertion(self):
        """Reference with contiguous gaps should be classified as insertion."""
        region_ref = "-" * 60
        region_query = "ATGCATGC" * 8
        result = classify_structural_region(region_ref, region_query)
        assert result["type"] == StructuralType.INSERTION
        assert result["confidence"] > 0.7

    def test_classify_replacement(self):
        """Both sequences present but mismatched = replacement."""
        region_ref = "ATGCATGC" * 8
        region_query = "GGGGCCCC" * 8
        result = classify_structural_region(
            region_ref, region_query, check_inversion=False
        )
        assert result["type"] == StructuralType.REPLACEMENT
        assert result["confidence"] > 0.3

    def test_classify_inversion(self):
        """Reverse complement match should classify as inversion."""
        region_ref = "ATGCAATTGCTAGCTAGCTAG" * 3
        rc = reverse_complement(region_ref)
        result = classify_structural_region(region_ref, rc, check_inversion=True)
        assert result["type"] == StructuralType.INVERSION
        assert result["rc_identity"] > 0.8

    def test_classify_tandem_duplication(self):
        """Insertion matching adjacent sequence = tandem duplication."""
        unit = "ATGCATGC"
        flank_left = "GGGG" * 10
        flank_right = "CCCC" * 10

        _ref = flank_left + unit + flank_right
        inserted_seq = unit

        result = classify_structural_region(
            "-" * len(inserted_seq),
            inserted_seq,
            left_flank=flank_left + unit,
            right_flank=flank_right,
            check_duplication=True,
        )
        assert result["type"] == StructuralType.TANDEM_DUPLICATION

    def test_classify_truncation(self):
        """Query ending early should classify as truncation."""
        region_ref = "ATGC" * 30
        region_query = "ATGC" * 10 + "-" * 80

        result = classify_structural_region(
            region_ref,
            region_query,
            is_at_end=True,
        )
        assert result["type"] == StructuralType.TRUNCATION


class TestComplexClassification:
    """Tests for complex/ambiguous classification scenarios."""

    def test_mixed_region_is_complex(self):
        """Region with both insertions and deletions is complex."""
        region_ref = "ATGC--ATGC--ATGC"
        region_query = "--ATGC--ATGC--AT"
        result = classify_structural_region(region_ref, region_query)
        assert result["type"] in [StructuralType.COMPLEX, StructuralType.REPLACEMENT]


class TestMutationAssignment:
    """Tests for assigning mutations to structural regions."""

    def test_mutations_in_structural_region_grouped(self):
        """Mutations within a structural region should be grouped."""
        aligned_ref = "ATGC" * 25 + "A" * 100 + "ATGC" * 25
        aligned_query = "ATGC" * 25 + "T" * 100 + "ATGC" * 25

        mutations = [
            {"type": "substitution", "position": 100 + i, "column": 100 + i}
            for i in range(100)
        ]

        result = analyze_alignment_structure(aligned_ref, aligned_query, mutations)

        assert len(result["structural_regions"]) == 1
        assert len(result["structural_regions"][0]["mutation_indices"]) == 100
        assert len(result["point_mutations"]) == 0

    def test_mutations_outside_structural_region_are_point_mutations(self):
        """Mutations outside structural regions should be point mutations."""
        aligned_ref = "ATGC" * 50
        aligned_query = "ATGC" * 24 + "ATGG" + "ATGC" * 25

        mutations = [{"type": "substitution", "position": 97, "column": 97}]

        result = analyze_alignment_structure(aligned_ref, aligned_query, mutations)

        assert len(result["structural_regions"]) == 0
        assert len(result["point_mutations"]) == 1


class TestOverallAssessment:
    """Tests for PASS/FAIL/REVIEW assessment."""

    def test_perfect_alignment_passes(self):
        """Perfect alignment should PASS."""
        aligned_ref = "ATGC" * 50
        aligned_query = "ATGC" * 50
        result = analyze_alignment_structure(aligned_ref, aligned_query, [])
        assert result["overall_assessment"]["result"] == OverallAssessment.PASS

    def test_high_severity_structural_fails(self):
        """High-severity structural variant should FAIL."""
        good = "ATGC" * 25
        wrong = "GGGG" * 25

        aligned_ref = good + "AAAA" * 25 + good
        aligned_query = good + wrong + good

        result = analyze_alignment_structure(aligned_ref, aligned_query, [])
        assert len(result["structural_regions"]) >= 1
        assert result["overall_assessment"]["result"] in [
            OverallAssessment.FAIL,
            OverallAssessment.REVIEW,
        ]

    def test_point_mutations_only_passes(self):
        """Only point mutations should PASS (with notes)."""
        aligned_ref = "ATGC" * 50
        query_list = list(aligned_ref)
        query_list[50] = "G"
        query_list[100] = "G"
        query_list[150] = "G"
        aligned_query = "".join(query_list)

        mutations = [
            {"type": "substitution", "position": 50, "column": 50},
            {"type": "substitution", "position": 100, "column": 100},
            {"type": "substitution", "position": 150, "column": 150},
        ]

        result = analyze_alignment_structure(aligned_ref, aligned_query, mutations)
        assert result["overall_assessment"]["result"] == OverallAssessment.PASS
        assert "3 point mutation" in result["overall_assessment"]["reason"]

    def test_medium_severity_needs_review(self):
        """Medium severity or low confidence should return REVIEW."""
        aligned_ref = "ATGC" * 25 + "AA" * 20 + "ATGC" * 25
        aligned_query = "ATGC" * 25 + "TT" * 20 + "ATGC" * 25

        result = analyze_alignment_structure(aligned_ref, aligned_query, [])
        if len(result["structural_regions"]) > 0:
            assert result["overall_assessment"]["result"] in [
                OverallAssessment.REVIEW,
                OverallAssessment.FAIL,
            ]


class TestRealWorldPatterns:
    """Tests based on real cloning failure patterns."""

    def test_wrong_insert_replacement(self):
        """
        Common cloning failure: correct backbone, wrong insert.

        Pattern:
        - Vector backbone aligns perfectly
        - Insert region has no homology (replacement)
        """
        backbone = "ATGC" * 125
        correct_insert = "GGGG" * 50
        wrong_insert = "CCCC" * 50

        aligned_ref = backbone + correct_insert + backbone
        aligned_query = backbone + wrong_insert + backbone

        result = analyze_alignment_structure(aligned_ref, aligned_query, [])

        assert len(result["structural_regions"]) >= 1
        assert result["structural_regions"][0]["type"] in [
            StructuralType.REPLACEMENT,
            StructuralType.INVERSION,
            StructuralType.COMPLEX,
        ]
        assert result["overall_assessment"]["result"] in [
            OverallAssessment.FAIL,
            OverallAssessment.REVIEW,
        ]

    def test_truncated_insert(self):
        """
        Common failure: insert is truncated (ends prematurely).

        Pattern:
        - Sequence starts matching
        - Then diverges and query ends
        """
        good = "ATGC" * 125
        truncated_ref = "NNNN" * 50
        truncated_query = "-" * 200

        aligned_ref = good + truncated_ref
        aligned_query = good + truncated_query

        result = analyze_alignment_structure(aligned_ref, aligned_query, [])

        assert len(result["structural_regions"]) == 1
        assert result["structural_regions"][0]["type"] in [
            StructuralType.TRUNCATION,
            StructuralType.DELETION,
        ]

    def test_tandem_duplication_detected(self):
        """
        PCR artifact: tandem duplication of a region.

        Pattern:
        - Normal sequence
        - Repeated copy of adjacent sequence (insertion that matches nearby)
        """
        flank = "ATGC" * 50
        unit = "GGGGCCCCAAAA" * 4

        aligned_ref = flank + unit + "-" * 48 + flank
        aligned_query = flank + unit + unit + flank

        result = analyze_alignment_structure(
            aligned_ref, aligned_query, [], check_duplications=True
        )

        assert len(result["structural_regions"]) >= 1
        valid_types = [
            StructuralType.INSERTION,
            StructuralType.TANDEM_DUPLICATION,
            StructuralType.DISPERSED_DUPLICATION,
            StructuralType.COMPLEX,
            StructuralType.REPLACEMENT,
        ]
        assert any(r["type"] in valid_types for r in result["structural_regions"])


class TestInvariants:
    """Tests for invariants that should always hold."""

    def test_regions_never_overlap(self):
        """Detected regions should never overlap."""
        good = "ATGC" * 25
        bad = "AAAA" * 25

        aligned_ref = good + bad + good + bad + good
        aligned_query = good + "TTTT" * 25 + good + "TTTT" * 25 + good

        result = analyze_alignment_structure(aligned_ref, aligned_query, [])

        regions = result["structural_regions"]
        for i, r1 in enumerate(regions):
            for r2 in regions[i + 1 :]:
                assert (
                    r1["column_end"] < r2["column_start"]
                    or r2["column_end"] < r1["column_start"]
                ), f"Regions overlap: {r1} and {r2}"

    def test_coordinate_mappings_consistent(self):
        """Coordinate mappings should be reversible and consistent."""
        ref = "ATG--CATGC--ATGC"
        query = "ATGAACATGC--ATGC"
        maps = build_coordinate_maps(ref, query)

        for col, ref_pos in enumerate(maps["column_to_ref"]):
            if ref_pos > 0:
                assert maps["ref_to_column"][ref_pos] <= col

    def test_perfect_alignment_never_triggers_detection(self):
        """Perfect alignment should never produce structural regions."""
        for length in [100, 500, 1000, 5000]:
            ref = "ATGC" * (length // 4)
            query = ref
            regions = detect_structural_regions(ref, query)
            assert regions == [], f"Perfect alignment of {length}bp triggered detection"

    def test_single_base_changes_never_structural(self):
        """Single base changes should never be classified as structural."""
        ref = "ATGC" * 100
        for pos in [50, 100, 200, 350]:
            query_list = list(ref)
            query_list[pos] = "N"
            query = "".join(query_list)
            regions = detect_structural_regions(ref, query)
            assert (
                regions == []
            ), f"Single change at {pos} triggered structural detection"
