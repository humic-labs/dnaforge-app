"""
Comprehensive Synthetic Test Cases for Structural Region Detection

Tests the detect_structural_regions() algorithm with constructed alignments
where boundaries are known exactly. Verifies that detected boundaries match
constructed boundaries regardless of:

1. Sequence length (100bp, 1kb, 10kb, 50kb)
2. Region size (30bp, 100bp, 500bp, 5kb)
3. Mismatch density (10%, 25%, 50%, 100%)
4. Gap patterns (pure deletion, pure insertion, mixed)
5. Multiple regions per alignment (2, 3, 5 regions)
6. Edge cases (region at position 0, region at end)

Each test constructs aligned_ref and aligned_query strings with known boundaries,
calls detect_structural_regions(), and verifies exact boundary matching.
"""

import random

import pytest as pytest

from src.tools.structural import detect_structural_regions


def make_perfect_region(length: int, seed: int = 42) -> str:
    """Generate a random DNA sequence of given length."""
    random.seed(seed)
    return "".join(random.choice("ATGC") for _ in range(length))


def make_mismatch_region(ref_seq: str, density: float, seed: int = 42) -> str:
    """
    Generate query sequence with given mismatch density against reference.

    Args:
        ref_seq: Reference sequence
        density: Fraction of positions to mismatch (0.0 - 1.0)
        seed: Random seed for reproducibility

    Returns:
        Query sequence with specified mismatch density
    """
    random.seed(seed)
    bases = "ATGC"
    result = []

    for base in ref_seq:
        if random.random() < density:
            other_bases = [b for b in bases if b != base]
            result.append(random.choice(other_bases))
        else:
            result.append(base)

    return "".join(result)


def make_gap_region(length: int) -> str:
    """Generate a string of gaps."""
    return "-" * length


def verify_single_region_boundaries(
    aligned_ref: str,
    aligned_query: str,
    expected_start: int,
    expected_end: int,
    description: str = "",
):
    """
    Verify that exactly one structural region is detected with exact boundaries.

    Args:
        aligned_ref: Aligned reference sequence
        aligned_query: Aligned query sequence
        expected_start: Expected column_start (inclusive, 0-indexed)
        expected_end: Expected column_end (exclusive, 0-indexed)
        description: Test description for error messages
    """
    regions = detect_structural_regions(aligned_ref, aligned_query)

    assert (
        len(regions) == 1
    ), f"{description}: Expected 1 region, got {len(regions)}. Regions: {regions}"

    region = regions[0]

    assert region["column_start"] == expected_start, (
        f"{description}: column_start mismatch. "
        f"Expected {expected_start}, got {region['column_start']} "
        f"(diff: {region['column_start'] - expected_start})"
    )

    assert region["column_end"] == expected_end, (
        f"{description}: column_end mismatch. "
        f"Expected {expected_end}, got {region['column_end']} "
        f"(diff: {region['column_end'] - expected_end})"
    )


def verify_multiple_region_boundaries(
    aligned_ref: str,
    aligned_query: str,
    expected_regions: list[tuple[int, int]],
    description: str = "",
):
    """
    Verify that multiple structural regions are detected with exact boundaries.

    Args:
        aligned_ref: Aligned reference sequence
        aligned_query: Aligned query sequence
        expected_regions: List of (start, end) tuples for expected regions
        description: Test description for error messages
    """
    regions = detect_structural_regions(aligned_ref, aligned_query)

    regions = sorted(regions, key=lambda r: r["column_start"])
    expected_regions = sorted(expected_regions)

    assert len(regions) == len(expected_regions), (
        f"{description}: Expected {len(expected_regions)} regions, got {len(regions)}. "
        f"Detected: {[(r['column_start'], r['column_end']) for r in regions]}, "
        f"Expected: {expected_regions}"
    )

    for i, (region, (exp_start, exp_end)) in enumerate(
        zip(regions, expected_regions, strict=False)
    ):
        assert region["column_start"] == exp_start, (
            f"{description}: Region {i + 1} column_start mismatch. "
            f"Expected {exp_start}, got {region['column_start']}"
        )
        assert region["column_end"] == exp_end, (
            f"{description}: Region {i + 1} column_end mismatch. "
            f"Expected {exp_end}, got {region['column_end']}"
        )


class TestSequenceLengths:
    """
    Test structural detection across various alignment lengths.

    Each test places a 50bp heterology region in the middle of alignments
    of different total lengths.
    """

    def test_100bp_alignment(self):
        """100bp alignment with 30bp heterology in middle."""
        flank_len = 35
        het_len = 30

        flank = make_perfect_region(flank_len, seed=1)
        het_ref = make_perfect_region(het_len, seed=2)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=3)

        aligned_ref = flank + het_ref + flank
        aligned_query = flank + het_query + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + het_len,
            description="100bp alignment",
        )

    def test_1kb_alignment(self):
        """1kb alignment with 100bp heterology in middle."""
        flank_len = 450
        het_len = 100

        flank_left = make_perfect_region(flank_len, seed=10)
        flank_right = make_perfect_region(flank_len, seed=11)
        het_ref = make_perfect_region(het_len, seed=12)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=13)

        aligned_ref = flank_left + het_ref + flank_right
        aligned_query = flank_left + het_query + flank_right

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + het_len,
            description="1kb alignment",
        )

    def test_10kb_alignment(self):
        """10kb alignment with 500bp heterology in middle."""
        flank_len = 4750
        het_len = 500

        flank_left = make_perfect_region(flank_len, seed=20)
        flank_right = make_perfect_region(flank_len, seed=21)
        het_ref = make_perfect_region(het_len, seed=22)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=23)

        aligned_ref = flank_left + het_ref + flank_right
        aligned_query = flank_left + het_query + flank_right

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + het_len,
            description="10kb alignment",
        )

    def test_50kb_alignment(self):
        """50kb alignment with 1kb heterology in middle."""
        flank_len = 24500
        het_len = 1000

        flank_left = make_perfect_region(flank_len, seed=30)
        flank_right = make_perfect_region(flank_len, seed=31)
        het_ref = make_perfect_region(het_len, seed=32)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=33)

        aligned_ref = flank_left + het_ref + flank_right
        aligned_query = flank_left + het_query + flank_right

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + het_len,
            description="50kb alignment",
        )


class TestRegionSizes:
    """
    Test structural detection with various heterology region sizes.

    Uses 1kb total alignment with heterology regions of different sizes.
    """

    def test_30bp_region(self):
        """30bp heterology region (minimum for detection)."""
        het_len = 30
        flank_len = (1000 - het_len) // 2

        flank = make_perfect_region(flank_len, seed=100)
        het_ref = make_perfect_region(het_len, seed=101)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=102)

        aligned_ref = flank + het_ref + flank
        aligned_query = flank + het_query + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + het_len,
            description="30bp region",
        )

    def test_100bp_region(self):
        """100bp heterology region."""
        het_len = 100
        flank_len = (1000 - het_len) // 2

        flank = make_perfect_region(flank_len, seed=110)
        het_ref = make_perfect_region(het_len, seed=111)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=112)

        aligned_ref = flank + het_ref + flank
        aligned_query = flank + het_query + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + het_len,
            description="100bp region",
        )

    def test_500bp_region(self):
        """500bp heterology region."""
        het_len = 500
        total_len = 2000
        flank_len = (total_len - het_len) // 2

        flank = make_perfect_region(flank_len, seed=120)
        het_ref = make_perfect_region(het_len, seed=121)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=122)

        aligned_ref = flank + het_ref + flank
        aligned_query = flank + het_query + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + het_len,
            description="500bp region",
        )

    def test_5kb_region(self):
        """5kb heterology region."""
        het_len = 5000
        total_len = 15000
        flank_len = (total_len - het_len) // 2

        flank = make_perfect_region(flank_len, seed=130)
        het_ref = make_perfect_region(het_len, seed=131)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=132)

        aligned_ref = flank + het_ref + flank
        aligned_query = flank + het_query + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + het_len,
            description="5kb region",
        )


class TestMismatchDensities:
    """
    Test structural detection with various mismatch densities.

    Uses 1kb alignment with 200bp heterology region at different densities.
    Lower densities (<10%) should NOT be detected as structural regions.
    """

    def test_100_percent_mismatch(self):
        """100% mismatch density - all bases different."""
        het_len = 200
        flank_len = 400

        flank = make_perfect_region(flank_len, seed=200)
        het_ref = make_perfect_region(het_len, seed=201)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=202)

        aligned_ref = flank + het_ref + flank
        aligned_query = flank + het_query + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + het_len,
            description="100% mismatch",
        )

    def test_50_percent_mismatch(self):
        """50% mismatch density - boundaries based on actual mismatch positions."""
        het_len = 200
        flank_len = 400

        flank = make_perfect_region(flank_len, seed=210)
        het_ref = make_perfect_region(het_len, seed=211)
        het_query = make_mismatch_region(het_ref, density=0.5, seed=212)

        aligned_ref = flank + het_ref + flank
        aligned_query = flank + het_query + flank

        first_mismatch = None
        last_mismatch = None
        for i in range(flank_len, flank_len + het_len):
            if aligned_ref[i] != aligned_query[i]:
                if first_mismatch is None:
                    first_mismatch = i
                last_mismatch = i

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=first_mismatch,
            expected_end=last_mismatch + 1,
            description="50% mismatch",
        )

    def test_25_percent_mismatch(self):
        """25% mismatch density - boundaries based on actual mismatch positions."""
        het_len = 200
        flank_len = 400

        flank = make_perfect_region(flank_len, seed=220)
        het_ref = make_perfect_region(het_len, seed=221)
        het_query = make_mismatch_region(het_ref, density=0.25, seed=222)

        aligned_ref = flank + het_ref + flank
        aligned_query = flank + het_query + flank

        first_mismatch = None
        last_mismatch = None
        for i in range(flank_len, flank_len + het_len):
            if aligned_ref[i] != aligned_query[i]:
                if first_mismatch is None:
                    first_mismatch = i
                last_mismatch = i

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=first_mismatch,
            expected_end=last_mismatch + 1,
            description="25% mismatch",
        )

    def test_10_percent_mismatch(self):
        """10% mismatch density - borderline for detection."""
        het_len = 200
        flank_len = 400

        flank = make_perfect_region(flank_len, seed=230)
        het_ref = make_perfect_region(het_len, seed=231)
        het_query = make_mismatch_region(het_ref, density=0.10, seed=232)

        aligned_ref = flank + het_ref + flank
        aligned_query = flank + het_query + flank

        regions = detect_structural_regions(aligned_ref, aligned_query)

        if len(regions) == 1:
            assert regions[0]["column_start"] == flank_len
            assert regions[0]["column_end"] == flank_len + het_len
        else:
            assert len(regions) == 0, f"Expected 0 or 1 region, got {len(regions)}"


class TestGapPatterns:
    """
    Test structural detection with various gap patterns.

    - Pure deletion: gaps in query (ref has sequence)
    - Pure insertion: gaps in reference (query has sequence)
    - Mixed: gaps in both
    """

    def test_pure_deletion_100bp(self):
        """100bp deletion - gaps in query."""
        gap_len = 100
        flank_len = 500

        flank = make_perfect_region(flank_len, seed=300)
        deletion_seq = make_perfect_region(gap_len, seed=301)

        aligned_ref = flank + deletion_seq + flank
        aligned_query = flank + make_gap_region(gap_len) + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + gap_len,
            description="100bp pure deletion",
        )

    def test_pure_deletion_500bp(self):
        """500bp deletion - gaps in query."""
        gap_len = 500
        flank_len = 1000

        flank = make_perfect_region(flank_len, seed=305)
        deletion_seq = make_perfect_region(gap_len, seed=306)

        aligned_ref = flank + deletion_seq + flank
        aligned_query = flank + make_gap_region(gap_len) + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + gap_len,
            description="500bp pure deletion",
        )

    def test_pure_insertion_100bp(self):
        """100bp insertion - gaps in reference."""
        gap_len = 100
        flank_len = 500

        flank = make_perfect_region(flank_len, seed=310)
        insertion_seq = make_perfect_region(gap_len, seed=311)

        aligned_ref = flank + make_gap_region(gap_len) + flank
        aligned_query = flank + insertion_seq + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + gap_len,
            description="100bp pure insertion",
        )

    def test_pure_insertion_500bp(self):
        """500bp insertion - gaps in reference."""
        gap_len = 500
        flank_len = 1000

        flank = make_perfect_region(flank_len, seed=315)
        insertion_seq = make_perfect_region(gap_len, seed=316)

        aligned_ref = flank + make_gap_region(gap_len) + flank
        aligned_query = flank + insertion_seq + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + gap_len,
            description="500bp pure insertion",
        )

    def test_mixed_gaps_deletion_then_insertion(self):
        """Mixed: 50bp deletion followed by 50bp insertion (100bp total)."""
        del_len = 50
        ins_len = 50
        total_het = del_len + ins_len
        flank_len = 500

        flank = make_perfect_region(flank_len, seed=320)
        del_seq = make_perfect_region(del_len, seed=321)
        ins_seq = make_perfect_region(ins_len, seed=322)

        aligned_ref = flank + del_seq + make_gap_region(ins_len) + flank
        aligned_query = flank + make_gap_region(del_len) + ins_seq + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + total_het,
            description="mixed deletion+insertion",
        )

    def test_mixed_gaps_interspersed(self):
        """Interspersed gaps: alternating small deletions and insertions."""
        unit_len = 20
        num_units = 4
        total_het = unit_len * num_units
        flank_len = 500

        flank = make_perfect_region(flank_len, seed=330)

        ref_het = ""
        query_het = ""
        for i in range(num_units):
            seq = make_perfect_region(unit_len, seed=331 + i)
            if i % 2 == 0:
                ref_het += seq
                query_het += make_gap_region(unit_len)
            else:
                ref_het += make_gap_region(unit_len)
                query_het += seq

        aligned_ref = flank + ref_het + flank
        aligned_query = flank + query_het + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + total_het,
            description="interspersed gaps",
        )


class TestMultipleRegions:
    """
    Test detection of multiple structural regions in single alignment.

    Verifies that each region has exact boundaries independent of others.
    """

    def test_two_regions_100bp_gap(self):
        """Two 50bp regions separated by 100bp good alignment."""
        het_len = 50
        sep_len = 100
        flank_len = 500

        flank = make_perfect_region(flank_len, seed=400)
        separator = make_perfect_region(sep_len, seed=401)

        het1_ref = make_perfect_region(het_len, seed=402)
        het1_query = make_mismatch_region(het1_ref, density=1.0, seed=403)

        het2_ref = make_perfect_region(het_len, seed=404)
        het2_query = make_mismatch_region(het2_ref, density=1.0, seed=405)

        aligned_ref = flank + het1_ref + separator + het2_ref + flank
        aligned_query = flank + het1_query + separator + het2_query + flank

        expected_regions = [
            (flank_len, flank_len + het_len),
            (flank_len + het_len + sep_len, flank_len + het_len + sep_len + het_len),
        ]

        verify_multiple_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_regions,
            description="two regions 100bp gap",
        )

    def test_two_regions_1kb_gap(self):
        """Two 100bp regions separated by 1kb good alignment."""
        het_len = 100
        sep_len = 1000
        flank_len = 500

        flank = make_perfect_region(flank_len, seed=410)
        separator = make_perfect_region(sep_len, seed=411)

        het1_ref = make_perfect_region(het_len, seed=412)
        het1_query = make_mismatch_region(het1_ref, density=1.0, seed=413)

        het2_ref = make_perfect_region(het_len, seed=414)
        het2_query = make_mismatch_region(het2_ref, density=1.0, seed=415)

        aligned_ref = flank + het1_ref + separator + het2_ref + flank
        aligned_query = flank + het1_query + separator + het2_query + flank

        expected_regions = [
            (flank_len, flank_len + het_len),
            (flank_len + het_len + sep_len, flank_len + het_len + sep_len + het_len),
        ]

        verify_multiple_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_regions,
            description="two regions 1kb gap",
        )

    def test_three_regions(self):
        """Three heterology regions with different separations."""
        het_len = 50
        sep1_len = 100
        sep2_len = 200
        flank_len = 300

        flank = make_perfect_region(flank_len, seed=420)
        sep1 = make_perfect_region(sep1_len, seed=421)
        sep2 = make_perfect_region(sep2_len, seed=422)

        het1_ref = make_perfect_region(het_len, seed=423)
        het1_query = make_mismatch_region(het1_ref, density=1.0, seed=424)

        het2_ref = make_perfect_region(het_len, seed=425)
        het2_query = make_mismatch_region(het2_ref, density=1.0, seed=426)

        het3_ref = make_perfect_region(het_len, seed=427)
        het3_query = make_mismatch_region(het3_ref, density=1.0, seed=428)

        aligned_ref = flank + het1_ref + sep1 + het2_ref + sep2 + het3_ref + flank
        aligned_query = (
            flank + het1_query + sep1 + het2_query + sep2 + het3_query + flank
        )

        pos1_start = flank_len
        pos1_end = pos1_start + het_len
        pos2_start = pos1_end + sep1_len
        pos2_end = pos2_start + het_len
        pos3_start = pos2_end + sep2_len
        pos3_end = pos3_start + het_len

        expected_regions = [
            (pos1_start, pos1_end),
            (pos2_start, pos2_end),
            (pos3_start, pos3_end),
        ]

        verify_multiple_region_boundaries(
            aligned_ref, aligned_query, expected_regions, description="three regions"
        )

    def test_five_regions(self):
        """Five heterology regions spread across alignment."""
        het_len = 40
        sep_len = 100
        flank_len = 200

        flank = make_perfect_region(flank_len, seed=430)
        sep = make_perfect_region(sep_len, seed=431)

        aligned_ref = flank
        aligned_query = flank
        expected_regions = []

        for i in range(5):
            het_ref = make_perfect_region(het_len, seed=432 + i * 2)
            het_query = make_mismatch_region(het_ref, density=1.0, seed=433 + i * 2)

            start_pos = len(aligned_ref)
            end_pos = start_pos + het_len
            expected_regions.append((start_pos, end_pos))

            aligned_ref += het_ref
            aligned_query += het_query

            if i < 4:
                aligned_ref += sep
                aligned_query += sep

        aligned_ref += flank
        aligned_query += flank

        verify_multiple_region_boundaries(
            aligned_ref, aligned_query, expected_regions, description="five regions"
        )

    def test_two_regions_different_types(self):
        """Two regions: one deletion, one mismatch."""
        del_len = 60
        mismatch_len = 50
        sep_len = 200
        flank_len = 500

        flank = make_perfect_region(flank_len, seed=450)
        separator = make_perfect_region(sep_len, seed=451)
        del_seq = make_perfect_region(del_len, seed=452)
        mismatch_ref = make_perfect_region(mismatch_len, seed=453)
        mismatch_query = make_mismatch_region(mismatch_ref, density=1.0, seed=454)

        aligned_ref = flank + del_seq + separator + mismatch_ref + flank
        aligned_query = (
            flank + make_gap_region(del_len) + separator + mismatch_query + flank
        )

        expected_regions = [
            (flank_len, flank_len + del_len),
            (
                flank_len + del_len + sep_len,
                flank_len + del_len + sep_len + mismatch_len,
            ),
        ]

        verify_multiple_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_regions,
            description="deletion + mismatch regions",
        )


class TestEdgeCases:
    """
    Test edge cases for boundary detection.

    - Region at position 0 (alignment start)
    - Region at alignment end
    - Region spanning entire alignment
    - Very small gaps between regions
    """

    def test_region_at_position_0(self):
        """Heterology region starts at column 0."""
        het_len = 100
        flank_len = 500

        flank = make_perfect_region(flank_len, seed=500)
        het_ref = make_perfect_region(het_len, seed=501)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=502)

        aligned_ref = het_ref + flank
        aligned_query = het_query + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=0,
            expected_end=het_len,
            description="region at position 0",
        )

    def test_region_at_end(self):
        """Heterology region ends at last column."""
        het_len = 100
        flank_len = 500

        flank = make_perfect_region(flank_len, seed=510)
        het_ref = make_perfect_region(het_len, seed=511)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=512)

        aligned_ref = flank + het_ref
        aligned_query = flank + het_query

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + het_len,
            description="region at end",
        )

    def test_region_spans_entire_alignment(self):
        """Single region covering entire alignment."""
        het_len = 500

        het_ref = make_perfect_region(het_len, seed=520)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=521)

        verify_single_region_boundaries(
            het_ref,
            het_query,
            expected_start=0,
            expected_end=het_len,
            description="region spans entire alignment",
        )

    def test_both_edges_have_regions(self):
        """Regions at both start and end of alignment."""
        het_len = 50
        middle_len = 500

        middle = make_perfect_region(middle_len, seed=530)

        het1_ref = make_perfect_region(het_len, seed=531)
        het1_query = make_mismatch_region(het1_ref, density=1.0, seed=532)

        het2_ref = make_perfect_region(het_len, seed=533)
        het2_query = make_mismatch_region(het2_ref, density=1.0, seed=534)

        aligned_ref = het1_ref + middle + het2_ref
        aligned_query = het1_query + middle + het2_query

        expected_regions = [
            (0, het_len),
            (het_len + middle_len, het_len + middle_len + het_len),
        ]

        verify_multiple_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_regions,
            description="regions at both edges",
        )

    def test_deletion_at_position_0(self):
        """Deletion (gaps in query) starting at column 0."""
        gap_len = 100
        flank_len = 500

        flank = make_perfect_region(flank_len, seed=540)
        deletion_seq = make_perfect_region(gap_len, seed=541)

        aligned_ref = deletion_seq + flank
        aligned_query = make_gap_region(gap_len) + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=0,
            expected_end=gap_len,
            description="deletion at position 0",
        )

    def test_insertion_at_end(self):
        """Insertion (gaps in ref) at alignment end."""
        gap_len = 100
        flank_len = 500

        flank = make_perfect_region(flank_len, seed=550)
        insertion_seq = make_perfect_region(gap_len, seed=551)

        aligned_ref = flank + make_gap_region(gap_len)
        aligned_query = flank + insertion_seq

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + gap_len,
            description="insertion at end",
        )

    def test_minimum_separation_between_regions(self):
        """Two regions with minimum separation that keeps them distinct."""
        het_len = 40
        sep_len = 60
        flank_len = 200

        flank = make_perfect_region(flank_len, seed=560)
        separator = make_perfect_region(sep_len, seed=561)

        het1_ref = make_perfect_region(het_len, seed=562)
        het1_query = make_mismatch_region(het1_ref, density=1.0, seed=563)

        het2_ref = make_perfect_region(het_len, seed=564)
        het2_query = make_mismatch_region(het2_ref, density=1.0, seed=565)

        aligned_ref = flank + het1_ref + separator + het2_ref + flank
        aligned_query = flank + het1_query + separator + het2_query + flank

        expected_regions = [
            (flank_len, flank_len + het_len),
            (flank_len + het_len + sep_len, flank_len + het_len + sep_len + het_len),
        ]

        verify_multiple_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_regions,
            description="minimum separation",
        )


class TestBoundaryPrecision:
    """
    Stress tests to verify boundary precision under various conditions.

    These tests specifically check that boundaries don't "drift" or "overshoot"
    due to window-based calculations.
    """

    def test_sharp_transition_to_heterology(self):
        """
        Sharp transition from perfect match to 100% mismatch.
        Boundary should be EXACTLY at transition point.
        """
        flank_len = 1000
        het_len = 200

        flank = "A" * flank_len
        het_ref = "G" * het_len
        het_query = "T" * het_len

        aligned_ref = flank + het_ref + flank
        aligned_query = flank + het_query + flank

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + het_len,
            description="sharp transition",
        )

    def test_heterology_surrounded_by_different_sequences(self):
        """
        Heterology region with different flanking sequences on each side.
        Ensures boundary detection doesn't depend on flank composition.
        """
        flank_left_len = 500
        flank_right_len = 700
        het_len = 150

        flank_left = "A" * flank_left_len
        flank_right = "C" * flank_right_len
        het_ref = "G" * het_len
        het_query = "T" * het_len

        aligned_ref = flank_left + het_ref + flank_right
        aligned_query = flank_left + het_query + flank_right

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_left_len,
            expected_end=flank_left_len + het_len,
            description="asymmetric flanks",
        )

    def test_single_base_perfect_match_before_heterology(self):
        """
        Verify that even a single perfect-match base is enough to end a region.
        """
        flank_len = 200
        het_len = 100
        single_match_len = 1

        flank = make_perfect_region(flank_len, seed=600)
        single_match = "A"

        het_ref = make_perfect_region(het_len, seed=601)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=602)

        aligned_ref = flank + het_ref + single_match + het_ref + flank
        aligned_query = flank + het_query + single_match + het_query + flank

        total_het = het_len + single_match_len + het_len

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + total_het,
            description="single match between het regions",
        )

    def test_exact_boundary_with_random_content(self):
        """
        Test with pseudo-random content (not repetitive patterns).
        Boundaries should still be exact.
        """
        flank_len = 800
        het_len = 300

        flank_left = make_perfect_region(flank_len, seed=610)
        flank_right = make_perfect_region(flank_len, seed=611)
        het_ref = make_perfect_region(het_len, seed=612)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=613)

        aligned_ref = flank_left + het_ref + flank_right
        aligned_query = flank_left + het_query + flank_right

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=flank_len,
            expected_end=flank_len + het_len,
            description="random content",
        )


class TestRegressions:
    """
    Regression tests for specific boundary detection issues that were
    discovered and fixed.
    """

    def test_original_bug_50bp_heterology(self):
        """
        Original test case that revealed boundary overshoot.
        100bp good | 50bp heterology | 100bp good
        """
        good_seq = "A" * 100
        heterology_ref = "G" * 50
        heterology_query = "T" * 50

        aligned_ref = good_seq + heterology_ref + good_seq
        aligned_query = good_seq + heterology_query + good_seq

        verify_single_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_start=100,
            expected_end=150,
            description="original bug case",
        )

    def test_two_regions_no_boundary_overlap(self):
        """
        Two regions should never have overlapping boundaries.
        100bp good | 30bp het1 | 100bp good | 40bp het2 | 100bp good
        """
        good = "A" * 100
        het1_ref = "G" * 30
        het1_query = "T" * 30
        het2_ref = "C" * 40
        het2_query = "A" * 40

        aligned_ref = good + het1_ref + good + het2_ref + good
        aligned_query = good + het1_query + good + het2_query + good

        expected_regions = [
            (100, 130),
            (230, 270),
        ]

        verify_multiple_region_boundaries(
            aligned_ref,
            aligned_query,
            expected_regions,
            description="two regions no overlap",
        )


class TestParameterSensitivity:
    """
    Test how detection behaves with different parameter values.

    These tests verify that boundary precision is maintained across
    different parameter configurations.
    """

    def test_custom_min_region_length_20(self):
        """Detection with min_region_length=20."""
        het_len = 25
        flank_len = 300

        flank = make_perfect_region(flank_len, seed=700)
        het_ref = make_perfect_region(het_len, seed=701)
        het_query = make_mismatch_region(het_ref, density=1.0, seed=702)

        aligned_ref = flank + het_ref + flank
        aligned_query = flank + het_query + flank

        regions = detect_structural_regions(
            aligned_ref, aligned_query, min_region_length=20
        )

        assert len(regions) == 1, f"Expected 1 region, got {len(regions)}"
        assert regions[0]["column_start"] == flank_len
        assert regions[0]["column_end"] == flank_len + het_len

    def test_smaller_coarse_window(self):
        """Detection with smaller coarse_window allows detecting closer regions."""
        het_len = 30
        sep_len = 30
        flank_len = 200

        flank = make_perfect_region(flank_len, seed=710)
        separator = make_perfect_region(sep_len, seed=711)

        het1_ref = make_perfect_region(het_len, seed=712)
        het1_query = make_mismatch_region(het1_ref, density=1.0, seed=713)

        het2_ref = make_perfect_region(het_len, seed=714)
        het2_query = make_mismatch_region(het2_ref, density=1.0, seed=715)

        aligned_ref = flank + het1_ref + separator + het2_ref + flank
        aligned_query = flank + het1_query + separator + het2_query + flank

        regions = detect_structural_regions(
            aligned_ref, aligned_query, coarse_window=50, min_region_length=20
        )

        if len(regions) == 2:
            regions = sorted(regions, key=lambda r: r["column_start"])
            assert regions[0]["column_start"] == flank_len
            assert regions[0]["column_end"] == flank_len + het_len
            assert regions[1]["column_start"] == flank_len + het_len + sep_len
            assert regions[1]["column_end"] == flank_len + het_len + sep_len + het_len
        elif len(regions) == 1:
            assert regions[0]["column_start"] == flank_len
            assert regions[0]["column_end"] == flank_len + het_len + sep_len + het_len


class TestInvariants:
    """
    Property-based tests that should always hold regardless of input.
    """

    def test_regions_never_overlap_various_sizes(self):
        """Detected regions should never have overlapping column ranges."""
        for het_len in [30, 50, 100, 200]:
            for sep_len in [100, 200, 500]:
                flank = make_perfect_region(500, seed=800 + het_len + sep_len)
                sep = make_perfect_region(sep_len, seed=801 + het_len + sep_len)

                het1_ref = make_perfect_region(het_len, seed=802 + het_len + sep_len)
                het1_query = make_mismatch_region(het1_ref, density=1.0, seed=803)

                het2_ref = make_perfect_region(het_len, seed=804 + het_len + sep_len)
                het2_query = make_mismatch_region(het2_ref, density=1.0, seed=805)

                aligned_ref = flank + het1_ref + sep + het2_ref + flank
                aligned_query = flank + het1_query + sep + het2_query + flank

                regions = detect_structural_regions(aligned_ref, aligned_query)

                for i, r1 in enumerate(regions):
                    for r2 in regions[i + 1 :]:
                        assert (
                            r1["column_end"] <= r2["column_start"]
                            or r2["column_end"] <= r1["column_start"]
                        ), (
                            f"Overlapping regions with het_len={het_len}, sep_len={sep_len}: "
                            f"{r1} and {r2}"
                        )

    def test_column_end_always_greater_than_start(self):
        """column_end should always be > column_start."""
        for het_len in [30, 100, 500]:
            flank = make_perfect_region(500, seed=810 + het_len)
            het_ref = make_perfect_region(het_len, seed=811 + het_len)
            het_query = make_mismatch_region(het_ref, density=1.0, seed=812)

            aligned_ref = flank + het_ref + flank
            aligned_query = flank + het_query + flank

            regions = detect_structural_regions(aligned_ref, aligned_query)

            for region in regions:
                assert (
                    region["column_end"] > region["column_start"]
                ), f"Invalid region: end ({region['column_end']}) <= start ({region['column_start']})"

    def test_length_columns_matches_bounds(self):
        """length_columns should equal column_end - column_start."""
        for het_len in [30, 100, 500]:
            flank = make_perfect_region(500, seed=820 + het_len)
            het_ref = make_perfect_region(het_len, seed=821 + het_len)
            het_query = make_mismatch_region(het_ref, density=1.0, seed=822)

            aligned_ref = flank + het_ref + flank
            aligned_query = flank + het_query + flank

            regions = detect_structural_regions(aligned_ref, aligned_query)

            for region in regions:
                expected_length = region["column_end"] - region["column_start"]
                assert region["length_columns"] == expected_length, (
                    f"Length mismatch: length_columns={region['length_columns']} "
                    f"but bounds give {expected_length}"
                )

    def test_perfect_alignment_never_has_regions(self):
        """Perfect alignment should never produce structural regions."""
        for length in [100, 500, 1000, 5000, 10000]:
            seq = make_perfect_region(length, seed=830 + length)
            regions = detect_structural_regions(seq, seq)
            assert (
                regions == []
            ), f"Perfect alignment of {length}bp has regions: {regions}"
