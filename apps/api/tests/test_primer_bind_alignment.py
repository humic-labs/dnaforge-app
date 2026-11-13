"""Tests for primer binding alignment accuracy.

Uses a synthetic 200bp test sequence with designed primers that have
specific mismatch patterns. Validates that edlib returns correct
binding positions and that 3' analysis is accurate.

Test sequence (200bp):
  Positions 0-19:   ATGCGATCGATCGATCGATC  (forward primer binding site)
  Positions 50-69:  GCTAGCTAGCTAGCTAGCTA  (reverse primer binding site)
  Positions 100-119: ATGCGATCGATCGATCGATC  (duplicate forward site)
  Rest: random fill

Primers:
  P1: Perfect match at 0-19 (forward)
  P2: 1 mismatch at 5' end (position 0)
  P3: 1 mismatch at 3' end (position 19)
  P4: 2 mismatches at 5' end (positions 0,1)
  P5: 2 mismatches in middle (positions 9,10)
  P6: Perfect reverse complement match at 50-69
"""

from src.tools.primer_bind import (
    _compute_three_prime_match,
    align_primer,
)

TEST_SEQUENCE = (
    "ATGCGATCGATCGATCGATC"
    "AAAAAAAAAAAAAAAAAAAA"
    "TTTTTTTTTTTTTTTTTTTT"
    "GCTAGCTAGCTAGCTAGCTA"
    "CCCCCCCCCCCCCCCCCCCC"
    "ATGCGATCGATCGATCGATC"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)
TEST_SEQUENCE = TEST_SEQUENCE[:200].ljust(200, "A")

FORWARD_SITE = "ATGCGATCGATCGATCGATC"

PRIMER_PERFECT = FORWARD_SITE

PRIMER_1MM_5PRIME = "TTGCGATCGATCGATCGATC"

PRIMER_1MM_3PRIME = "ATGCGATCGATCGATCGATA"

PRIMER_2MM_5PRIME = "TTCCGATCGATCGATCGATC"

PRIMER_2MM_MIDDLE = "ATGCGATCGTTCGATCGATC"
PRIMER_2MM_MIDDLE = "ATGCGATCGTACGATCGATC"


class TestAlignPrimerPositions:
    """Test that alignment positions are correct."""

    def test_perfect_match_position(self):
        """Perfect 20bp primer should match at exact positions."""
        hits = align_primer(PRIMER_PERFECT, TEST_SEQUENCE, max_edit_distance=3)

        forward_hits = [h for h in hits if h.strand == 1]
        positions = sorted((h.start, h.end) for h in forward_hits)

        assert (0, 20) in positions, f"Expected hit at 0-20, got {positions}"
        assert (100, 120) in positions, f"Expected hit at 100-120, got {positions}"

    def test_perfect_match_zero_mismatches(self):
        """Perfect match should report 0 mismatches."""
        hits = align_primer(PRIMER_PERFECT, TEST_SEQUENCE, max_edit_distance=3)
        fwd = [h for h in hits if h.strand == 1 and h.start == 0]

        assert len(fwd) >= 1
        assert fwd[0].edit_distance == 0
        assert fwd[0].mismatch_positions == []
        assert fwd[0].three_prime_match_length == 20

    def test_1mm_5prime_position_correct(self):
        """1 mismatch at 5' end should still bind at correct position."""
        hits = align_primer(PRIMER_1MM_5PRIME, TEST_SEQUENCE, max_edit_distance=3)
        fwd = [h for h in hits if h.strand == 1]

        positions = [(h.start, h.end) for h in fwd]
        assert any(
            s == 0 and e == 20 for s, e in positions
        ), f"1mm 5' primer should bind at 0-20, got {positions}"

    def test_1mm_5prime_3prime_match_full(self):
        """1 mismatch at 5' end: 3' match should be 19nt (all but first base)."""
        hits = align_primer(PRIMER_1MM_5PRIME, TEST_SEQUENCE, max_edit_distance=3)
        hit = next(h for h in hits if h.strand == 1 and h.start == 0)

        assert hit.three_prime_match_length == 19
        assert 0 in hit.mismatch_positions

    def test_1mm_3prime_short_match(self):
        """1 mismatch at 3' end: 3' match should be 0nt (mismatch at very end)."""
        hits = align_primer(PRIMER_1MM_3PRIME, TEST_SEQUENCE, max_edit_distance=3)
        hit = next(h for h in hits if h.strand == 1 and h.start == 0)

        assert hit.three_prime_match_length == 0
        assert 19 in hit.mismatch_positions

    def test_2mm_5prime_position_correct(self):
        """2 mismatches at 5' end should still bind at correct position."""
        hits = align_primer(PRIMER_2MM_5PRIME, TEST_SEQUENCE, max_edit_distance=3)
        fwd = [h for h in hits if h.strand == 1]

        positions = [(h.start, h.end) for h in fwd]
        assert any(
            s == 0 and e == 20 for s, e in positions
        ), f"2mm 5' primer should bind at 0-20, got {positions}"

    def test_2mm_5prime_3prime_match(self):
        """2 mismatches at 5' end (pos 0,2): 3' match should be 17nt (pos 3-19)."""
        hits = align_primer(PRIMER_2MM_5PRIME, TEST_SEQUENCE, max_edit_distance=3)
        hit = next(h for h in hits if h.strand == 1 and h.start == 0)

        assert hit.three_prime_match_length == 17
        assert hit.edit_distance == 2

    def test_2mm_middle_position_correct(self):
        """2 mismatches in middle: position should still be exact."""
        hits = align_primer(PRIMER_2MM_MIDDLE, TEST_SEQUENCE, max_edit_distance=3)
        fwd = [h for h in hits if h.strand == 1]

        positions = [(h.start, h.end) for h in fwd]
        assert any(
            s == 0 and e == 20 for s, e in positions
        ), f"2mm middle primer should bind at 0-20, got {positions}"

    def test_2mm_middle_3prime_match(self):
        """2 mismatches in middle: 3' match should be 10nt (positions 10-19 match)."""
        hits = align_primer(PRIMER_2MM_MIDDLE, TEST_SEQUENCE, max_edit_distance=3)
        hit = next(h for h in hits if h.strand == 1 and h.start == 0)

        assert hit.three_prime_match_length == 9
        assert 9 in hit.mismatch_positions
        assert 10 in hit.mismatch_positions


class TestComputeThreePrimeMatch:
    """Test 3' contiguous match calculation."""

    def test_perfect_match(self):
        assert _compute_three_prime_match([], 20) == 20

    def test_mismatch_at_5prime(self):
        assert _compute_three_prime_match([0], 20) == 19

    def test_mismatch_at_3prime(self):
        assert _compute_three_prime_match([19], 20) == 0

    def test_mismatch_in_middle(self):
        assert _compute_three_prime_match([10], 20) == 9

    def test_two_mismatches_at_5prime(self):
        assert _compute_three_prime_match([0, 1], 20) == 18

    def test_two_mismatches_middle(self):
        assert _compute_three_prime_match([9, 10], 20) == 9
