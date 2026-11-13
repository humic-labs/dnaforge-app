"""Tests for SantaLucia nearest-neighbor Tm calculator.

Cross-validates against the TypeScript implementation's known outputs.
Both implementations must produce identical results for the same inputs.
"""

import pytest

from src.tools.tm_calculator import (
    calculate_gc_content,
    calculate_tm_nn,
    calculate_tm_wallace,
)


class TestCalculateTmNN:
    """Test nearest-neighbor Tm calculation."""

    def test_20bp_50_percent_gc(self):
        """Standard 20bp primer at 50% GC — matches JS implementation."""
        tm = calculate_tm_nn("ATCGATCGATCGATCGATCG")
        assert tm == pytest.approx(53.9, abs=0.1)

    def test_high_gc_content(self):
        """20bp all-GC primer should have high Tm."""
        tm = calculate_tm_nn("GCGCGCGCGCGCGCGCGCGC")
        assert tm > 70.0

    def test_low_gc_content(self):
        """20bp all-AT primer should have low Tm."""
        tm = calculate_tm_nn("ATATATATATATATATATATAT"[:20])
        assert tm < 50.0

    def test_m13_forward(self):
        """M13 forward primer — well-known Tm."""
        tm = calculate_tm_nn("GTAAAACGACGGCCAGT")
        assert 48.0 < tm < 56.0

    def test_short_sequence_uses_wallace(self):
        """Sequences < 6bp use Wallace rule."""
        tm = calculate_tm_nn("ATCG")
        assert tm == 12.0

    def test_salt_correction(self):
        """Higher salt should increase Tm."""
        seq = "ATCGATCGATCGATCGATCG"
        tm_low_salt = calculate_tm_nn(seq, na_conc_mm=10)
        tm_high_salt = calculate_tm_nn(seq, na_conc_mm=200)
        assert tm_high_salt > tm_low_salt

    def test_primer_concentration(self):
        """Higher primer concentration should increase Tm slightly."""
        seq = "ATCGATCGATCGATCGATCG"
        tm_low = calculate_tm_nn(seq, primer_conc_nm=50)
        tm_high = calculate_tm_nn(seq, primer_conc_nm=1000)
        assert tm_high > tm_low

    def test_ignores_non_atgc(self):
        """Non-ATGC characters are stripped."""
        tm1 = calculate_tm_nn("ATCGATCGATCGATCGATCG")
        tm2 = calculate_tm_nn("ATC GAT CGA TCG ATC GATCG")
        assert tm1 == tm2

    def test_self_complementary(self):
        """Self-complementary sequences get symmetry correction."""
        tm = calculate_tm_nn("AATTAATTAATTAATT")
        assert isinstance(tm, float)

    def test_cross_validate_js_values(self):
        """Cross-validate specific sequences against JS implementation outputs.

        These values were computed by running the JS calculateTmNN with default
        params (250nM primer, 50mM Na+). The Python implementation must match.
        """
        test_cases = [
            ("ATCGATCGATCGATCGATCG", 53.9),
            ("GCTAGCTAGCTAGCTAGCTA", 51.9),
        ]
        for seq, expected_tm in test_cases:
            tm = calculate_tm_nn(seq)
            assert tm == pytest.approx(
                expected_tm, abs=0.1
            ), f"Tm mismatch for {seq}: expected {expected_tm}, got {tm}"


class TestCalculateTmWallace:
    """Test Wallace rule Tm."""

    def test_basic(self):
        """Wallace rule: 2(A+T) + 4(G+C)."""
        assert calculate_tm_wallace("ATCG") == 12.0

    def test_all_gc(self):
        """All GC: 4 * length."""
        assert calculate_tm_wallace("GCGC") == 16.0

    def test_all_at(self):
        """All AT: 2 * length."""
        assert calculate_tm_wallace("ATAT") == 8.0


class TestGCContent:
    """Test GC content calculation."""

    def test_50_percent(self):
        assert calculate_gc_content("ATCG") == 50.0

    def test_100_percent(self):
        assert calculate_gc_content("GCGC") == 100.0

    def test_0_percent(self):
        assert calculate_gc_content("ATAT") == 0.0

    def test_empty(self):
        assert calculate_gc_content("") == 0.0

    def test_strips_non_atgc(self):
        assert calculate_gc_content("A T C G") == 50.0
