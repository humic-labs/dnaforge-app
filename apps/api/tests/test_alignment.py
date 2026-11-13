"""Tests for the Sequence Alignment Tool (alignment.py).

Step 1: Pure function unit tests (no MAFFT needed)
Step 2: HTTP endpoint tests (mock MAFFT subprocess)
Step 3: Integration tests (real MAFFT, marked slow)
"""

import asyncio
import os
import shutil
import subprocess
from unittest.mock import AsyncMock, patch

import pytest

from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient

from .conftest import anonymous_client


class TestAnalyzeAlignment:
    """Tests for analyze_alignment(aligned_query, aligned_ref)."""

    def test_identical_sequences(self):
        from src.tools.alignment import analyze_alignment

        result = analyze_alignment("ATCGATCG", "ATCGATCG")
        assert result["identity"] == 100.0
        assert result["matches"] == 8
        assert result["mismatches"] == 0
        assert result["gaps"] == 0
        assert result["mutations"] == []

    def test_single_substitution(self):
        from src.tools.alignment import analyze_alignment

        result = analyze_alignment("ATCGATCG", "ATCAATCG")
        assert result["mismatches"] == 1
        assert result["matches"] == 7
        assert len(result["mutations"]) == 1
        mut = result["mutations"][0]
        assert mut.type == "substitution"
        assert mut.position == 4
        assert mut.ref_base == "A"
        assert mut.query_base == "G"

    def test_gap_in_reference_is_insertion(self):
        from src.tools.alignment import analyze_alignment

        result = analyze_alignment("ATCGAATCG", "ATCG-ATCG")
        assert result["gaps"] == 1
        assert len(result["mutations"]) == 1
        mut = result["mutations"][0]
        assert mut.type == "insertion"
        assert mut.length == 1
        assert mut.query_base == "A"

    def test_gap_in_query_is_deletion(self):
        from src.tools.alignment import analyze_alignment

        result = analyze_alignment("ATCG-ATCG", "ATCGAATCG")
        assert result["gaps"] == 1
        assert len(result["mutations"]) == 1
        mut = result["mutations"][0]
        assert mut.type == "deletion"
        assert mut.length == 1
        assert mut.ref_base == "A"

    def test_consecutive_gaps_grouped(self):
        from src.tools.alignment import analyze_alignment

        result = analyze_alignment("AT---ATCG", "ATCGAATCG")
        deletion_muts = [m for m in result["mutations"] if m.type == "deletion"]
        assert len(deletion_muts) == 1
        assert deletion_muts[0].length == 3

    def test_consecutive_insertion_gaps_grouped(self):
        from src.tools.alignment import analyze_alignment

        result = analyze_alignment("ATCGAAATCG", "AT---GATCG")
        insertion_muts = [m for m in result["mutations"] if m.type == "insertion"]
        assert len(insertion_muts) == 1
        assert insertion_muts[0].length == 3

    def test_identity_calculation(self):
        from src.tools.alignment import analyze_alignment

        result = analyze_alignment("ATCGATCG", "ATCAATC-")
        total = result["matches"] + result["mismatches"] + result["gaps"]
        expected_identity = (result["matches"] / total) * 100
        assert abs(result["identity"] - expected_identity) < 0.01

    def test_empty_alignment(self):
        from src.tools.alignment import analyze_alignment

        result = analyze_alignment("", "")
        assert result["identity"] == 0
        assert result["matches"] == 0
        assert result["mutations"] == []

    def test_unsequenced_ends_are_not_deletions(self):
        from src.tools.alignment import analyze_alignment

        result = analyze_alignment("--CGTT--", "ATCGATCG")
        assert [(m.type, m.position) for m in result["mutations"]] == [
            ("substitution", 5)
        ]
        assert result["identity"] == 75

    def test_ambiguous_bases_are_not_matches_or_substitutions(self):
        from src.tools.alignment import analyze_alignment

        result = analyze_alignment("ATNGNTCG", "ATNGATCG")
        assert result["mutations"] == []
        assert result["matches"] == 6

    def test_rna_uracil_is_resolved(self):
        from src.tools.alignment import analyze_alignment

        result = analyze_alignment("AUCG", "AUCG")
        assert result["matches"] == 4
        assert result["mutations"] == []

    def test_missing_sequence_cannot_create_a_structural_deletion(self):
        from src.tools.alignment import unresolved_alignment_columns
        from src.tools.structural import analyze_alignment_structure

        reference = "A" * 80 + "CTG" * 100 + "C" * 80
        query = "-" * 80 + "CTG" * 100 + "N" * 80
        analysis = analyze_alignment_structure(
            reference,
            query,
            [],
            ignored_columns=unresolved_alignment_columns(query, reference),
        )
        assert analysis["structural_regions"] == []

    def test_ambiguous_insertion_is_not_split_into_false_alleles(self):
        from src.tools.alignment import analyze_alignment

        result = analyze_alignment("ATNACGT", "AT---GT")
        assert result["mutations"] == []


class TestTrimCircularAlignment:
    """Tests for trim_circular_alignment()."""

    @pytest.mark.parametrize(
        ("query", "reference", "expected_query", "expected_reference"),
        [
            ("AC----GT", "ACGTACGT", "ACGT", "ACGT"),
            ("AC----GTT", "ACGTACGT-", "ACGTT", "ACGT-"),
            ("AC-----T", "ACGTACGT", "AC-T", "ACGT"),
            ("AC---CGT", "ACGTACGT", "AC---CGT", "ACGTACGT"),
            ("ACGTACGT", "ACGTACGT", "ACGTACGT", "ACGTACGT"),
        ],
    )
    def test_removes_only_a_wholly_unobserved_extra_reference_copy(
        self, query, reference, expected_query, expected_reference
    ):
        from src.tools.alignment import trim_circular_alignment

        assert trim_circular_alignment(query, reference, 4) == (
            expected_query,
            expected_reference,
            0,
        )

    def test_trims_doubled_reference(self):
        from src.tools.alignment import trim_circular_alignment

        aligned_query = "-----ATCGA----------"
        aligned_ref = "GATCGATCGATCGATCGATCG"
        trimmed_q, trimmed_r, offset = trim_circular_alignment(
            aligned_query, aligned_ref, 10
        )

        assert "-" not in trimmed_q or len(trimmed_q) < len(aligned_query)
        assert offset == 5

    def test_query_at_position_zero(self):
        from src.tools.alignment import trim_circular_alignment

        aligned_query = "ATCGA-----"
        aligned_ref = "ATCGAATCGA"
        trimmed_q, trimmed_r, offset = trim_circular_alignment(
            aligned_query, aligned_ref, 5
        )
        assert offset == 0

    def test_no_alignment_found(self):
        from src.tools.alignment import trim_circular_alignment

        aligned_query = "----------"
        aligned_ref = "ATCGATCGAT"
        trimmed_q, trimmed_r, offset = trim_circular_alignment(
            aligned_query, aligned_ref, 5
        )
        assert offset == 0

    def test_returns_correct_offset_with_gaps(self):
        from src.tools.alignment import trim_circular_alignment

        aligned_query = "---ATCG----"
        aligned_ref = "AT-CATCGATC"

        trimmed_q, trimmed_r, offset = trim_circular_alignment(
            aligned_query, aligned_ref, 5
        )
        assert offset == 2 % 5


class TestComputeChecksum:
    """Tests for compute_checksum()."""

    def test_deterministic(self):
        from src.tools.alignment import compute_checksum

        h1 = compute_checksum("ATCG", "GCTA")
        h2 = compute_checksum("ATCG", "GCTA")
        assert h1 == h2

    def test_different_inputs_different_hash(self):
        from src.tools.alignment import compute_checksum

        h1 = compute_checksum("ATCG", "GCTA")
        h2 = compute_checksum("ATCG", "TTTT")
        assert h1 != h2

    def test_returns_64_char_hex(self):
        from src.tools.alignment import compute_checksum

        h = compute_checksum("test")
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)


class TestGetMafftArgs:
    """Tests for get_mafft_args()."""

    def test_auto_mode(self):
        from src.tools.alignment import AlignmentAlgorithm, get_mafft_args

        args = get_mafft_args(AlignmentAlgorithm.AUTO, 4)
        assert args[0] == "mafft"
        assert "--thread" in args
        assert "4" in args

        assert "--localpair" not in args
        assert "--globalpair" not in args

    def test_accurate_mode(self):
        from src.tools.alignment import AlignmentAlgorithm, get_mafft_args

        args = get_mafft_args(AlignmentAlgorithm.ACCURATE, 2)
        assert "--localpair" in args

    def test_ginsi_mode(self):
        from src.tools.alignment import AlignmentAlgorithm, get_mafft_args

        args = get_mafft_args(AlignmentAlgorithm.GINSI, 4)
        assert "--globalpair" in args

    def test_fast_mode(self):
        from src.tools.alignment import AlignmentAlgorithm, get_mafft_args

        args = get_mafft_args(AlignmentAlgorithm.FAST, 4)
        assert "--retree" in args
        assert "1" in args

    def test_einsi_mode(self):
        from src.tools.alignment import AlignmentAlgorithm, get_mafft_args

        args = get_mafft_args(AlignmentAlgorithm.EINSI, 4)
        assert "--genafpair" in args

    def test_custom_thread_count(self):
        from src.tools.alignment import AlignmentAlgorithm, get_mafft_args

        args = get_mafft_args(AlignmentAlgorithm.AUTO, 8)
        idx = args.index("--thread")
        assert args[idx + 1] == "8"


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="POSIX executable fixture")
async def test_run_mafft_uses_auto_installed_binary(tmp_path, monkeypatch):
    """The downloaded MAFFT works even when its directory is not in PATH."""
    from src.annotation.tools import TOOL_REGISTRY
    from src.services.plannotate import get_platform_suffix
    from src.tools.alignment import run_mafft

    suffix = get_platform_suffix()
    binary = tmp_path / TOOL_REGISTRY["mafft"]["platforms"][suffix]["binaries"]["mafft"]
    binary.parent.mkdir(parents=True)
    libexec = binary.parent.parent / "libexec"
    libexec.mkdir()
    (libexec / "version").write_text("7.526\n")
    binary.write_text('#!/bin/sh\nprintf "%s\\n" "$MAFFT_BINARIES"\n')
    binary.chmod(0o755)
    monkeypatch.setenv("WAYPOINT_BINARIES_PATH", str(tmp_path / "missing-bundle"))
    monkeypatch.setattr("src.annotation.tools.get_tools_dir", lambda: tmp_path)

    stdout, stderr = await run_mafft(["mafft", "--version"], timeout_seconds=5)

    assert stdout.strip() == str(libexec)
    assert stderr == ""


class TestFindColumnForPosition:
    """Tests for _find_column_for_position()."""

    def test_no_gap_alignment(self):
        from src.tools.alignment import _find_column_for_position

        result = _find_column_for_position(3, "ATCGATCG")
        assert result == 2

    def test_leading_gaps(self):
        from src.tools.alignment import _find_column_for_position

        result = _find_column_for_position(1, "--ATCGATCG")
        assert result == 2

    def test_gaps_in_middle(self):
        from src.tools.alignment import _find_column_for_position

        result = _find_column_for_position(3, "AT--CGATCG")
        assert result == 4

    def test_position_1(self):
        from src.tools.alignment import _find_column_for_position

        result = _find_column_for_position(1, "ATCG")
        assert result == 0


class TestCacheFunctions:
    """Tests for get_cached_alignment() and save_to_cache()."""

    def test_round_trip(self, monkeypatch, tmp_path):
        import src.tools.alignment as alignment_mod

        monkeypatch.setattr(alignment_mod, "CACHE_DIR", tmp_path)
        from src.tools.alignment import get_cached_alignment, save_to_cache

        data = {"aligned_query": "ATCG", "identity": 100.0}
        save_to_cache("test_key", data)
        result = get_cached_alignment("test_key")
        assert result is not None
        assert result["identity"] == 100.0

    def test_cache_miss_returns_none(self, monkeypatch, tmp_path):
        import src.tools.alignment as alignment_mod

        monkeypatch.setattr(alignment_mod, "CACHE_DIR", tmp_path)
        from src.tools.alignment import get_cached_alignment

        result = get_cached_alignment("nonexistent_key")
        assert result is None

    def test_corrupt_cache_returns_none(self, monkeypatch, tmp_path):
        import src.tools.alignment as alignment_mod

        monkeypatch.setattr(alignment_mod, "CACHE_DIR", tmp_path)
        from src.tools.alignment import get_cached_alignment

        cache_file = tmp_path / "bad_key.json"
        cache_file.write_text("not valid json{{{")
        result = get_cached_alignment("bad_key")
        assert result is None


MOCK_MAFFT_OUTPUT = ">query\nATCG-ATCG\n>reference\nATCGAATCG\n"


class TestPairwiseEndpoint:
    """Tests for POST /api/tools/alignment/pairwise."""

    @pytest.fixture
    def client(self):
        from src.main import app

        return TestClient(app)

    def test_basic_alignment(self, client):
        with patch("src.tools.alignment.run_mafft", new_callable=AsyncMock) as mock_run:
            mock_run.return_value = (MOCK_MAFFT_OUTPUT, "")
            response = client.post(
                "/api/tools/alignment/pairwise",
                json={
                    "query": "ATCGATCGATCG",
                    "reference": "ATCGAATCGATCG",
                    "use_cache": False,
                },
            )
        assert response.status_code == 200
        data = response.json()
        assert "aligned_query" in data
        assert "aligned_reference" in data
        assert "identity" in data
        assert "mutations" in data
        assert isinstance(data["mutations"], list)

    def test_circular_alignment(self, client):
        with patch("src.tools.alignment.run_mafft", new_callable=AsyncMock) as mock_run:

            circular_output = ">query\nATCGATCG--\n>reference\nATCGATCGAT\n"
            mock_run.return_value = (circular_output, "")
            response = client.post(
                "/api/tools/alignment/pairwise",
                json={
                    "query": "ATCGATCGATCG",
                    "reference": "ATCGATCGATCG",
                    "is_circular": True,
                    "use_cache": False,
                },
            )
        assert response.status_code == 200
        data = response.json()
        assert "circular_offset" in data

    def test_cache_hit(self, client, monkeypatch, tmp_path):
        import src.tools.alignment as alignment_mod

        monkeypatch.setattr(alignment_mod, "CACHE_DIR", tmp_path)

        with patch("src.tools.alignment.run_mafft", new_callable=AsyncMock) as mock_run:
            mock_run.return_value = (MOCK_MAFFT_OUTPUT, "")

            response1 = client.post(
                "/api/tools/alignment/pairwise",
                json={
                    "query": "ATCGATCGATCG",
                    "reference": "ATCGAATCGATCG",
                    "use_cache": True,
                },
            )
            assert response1.status_code == 200
            assert response1.json()["cached"] is False
            call_count_after_first = mock_run.call_count

            response2 = client.post(
                "/api/tools/alignment/pairwise",
                json={
                    "query": "ATCGATCGATCG",
                    "reference": "ATCGAATCGATCG",
                    "use_cache": True,
                },
            )
            assert response2.status_code == 200
            assert response2.json()["cached"] is True
            assert mock_run.call_count == call_count_after_first

    def test_use_cache_false_always_runs_mafft(self, client, monkeypatch, tmp_path):
        import src.tools.alignment as alignment_mod

        monkeypatch.setattr(alignment_mod, "CACHE_DIR", tmp_path)

        with patch("src.tools.alignment.run_mafft", new_callable=AsyncMock) as mock_run:
            mock_run.return_value = (MOCK_MAFFT_OUTPUT, "")

            client.post(
                "/api/tools/alignment/pairwise",
                json={
                    "query": "ATCGATCGATCG",
                    "reference": "ATCGAATCGATCG",
                    "use_cache": False,
                },
            )

            client.post(
                "/api/tools/alignment/pairwise",
                json={
                    "query": "ATCGATCGATCG",
                    "reference": "ATCGAATCGATCG",
                    "use_cache": False,
                },
            )
            assert mock_run.call_count == 2

    def test_mafft_not_installed(self, client):
        with patch(
            "src.tools.alignment.run_mafft",
            new_callable=AsyncMock,
            side_effect=FileNotFoundError("mafft not found"),
        ):
            response = client.post(
                "/api/tools/alignment/pairwise",
                json={
                    "query": "ATCGATCGATCG",
                    "reference": "ATCGAATCGATCG",
                    "use_cache": False,
                },
            )
        assert response.status_code == 500
        assert "MAFFT" in response.json()["detail"]

    def test_mafft_timeout(self, client):
        with patch(
            "src.tools.alignment.run_mafft",
            new_callable=AsyncMock,
            side_effect=asyncio.TimeoutError(),
        ):
            response = client.post(
                "/api/tools/alignment/pairwise",
                json={
                    "query": "ATCGATCGATCG",
                    "reference": "ATCGAATCGATCG",
                    "use_cache": False,
                },
            )
        assert response.status_code == 504

    def test_invalid_characters(self, client):
        response = client.post(
            "/api/tools/alignment/pairwise",
            json={
                "query": "ATCG123XYZATCG",
                "reference": "ATCGATCGATCG",
            },
        )
        assert response.status_code == 422

    def test_sequence_too_short(self, client):
        response = client.post(
            "/api/tools/alignment/pairwise",
            json={
                "query": "ATCG",
                "reference": "ATCGATCGATCG",
            },
        )
        assert response.status_code == 422


class TestMultipleEndpoint:
    """Tests for POST /api/tools/alignment/multiple."""

    @pytest.fixture
    def client(self):
        from src.main import app

        return TestClient(app)

    def test_basic_multiple_alignment(self, client):
        mock_output = ">seq1\nATCG-ATCG\n>seq2\nATCGAATCG\n>seq3\nATCG-ATCG\n"

        with patch(
            "src.tools.alignment.run_mafft",
            new_callable=AsyncMock,
            return_value=(mock_output, ""),
        ):
            response = client.post(
                "/api/tools/alignment/multiple",
                json={
                    "sequences": [
                        {"id": "seq1", "sequence": "ATCGATCGATCG"},
                        {"id": "seq2", "sequence": "ATCGAATCGATCG"},
                        {"id": "seq3", "sequence": "ATCGATCGATCG"},
                    ]
                },
            )
        assert response.status_code == 200
        data = response.json()
        assert data["num_sequences"] == 3
        assert "aligned_sequences" in data
        assert data["alignment_length"] > 0
        assert all("name" not in record for record in data["aligned_sequences"])

    def test_fewer_than_two_sequences(self, client):
        response = client.post(
            "/api/tools/alignment/multiple",
            json={
                "sequences": [
                    {"id": "seq1", "sequence": "ATCGATCGATCG"},
                ]
            },
        )
        assert response.status_code == 422

    def test_mafft_error(self, client):
        with patch(
            "src.tools.alignment.run_mafft",
            new_callable=AsyncMock,
            side_effect=subprocess.CalledProcessError(1, "mafft", stderr="error"),
        ):
            response = client.post(
                "/api/tools/alignment/multiple",
                json={
                    "sequences": [
                        {"id": "seq1", "sequence": "ATCGATCGATCG"},
                        {"id": "seq2", "sequence": "ATCGAATCGATCG"},
                    ]
                },
            )
        assert response.status_code == 500


class TestMultipleProteinEndpoint:
    """Tests for POST /api/tools/alignment/multiple-protein  slice 2.3).

    Every alignment route now inherits the application-wide sidecar session.
    These tests explicitly control the token for the failure contract.
    """

    TEST_MCP_TOKEN = "test-mcp-session-alignment"

    @pytest.fixture
    def client(self, monkeypatch):
        from src.main import app

        monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", self.TEST_MCP_TOKEN)
        return TestClient(app, headers={"X-DNAForge-Session": self.TEST_MCP_TOKEN})

    def test_rejects_a_missing_session_token(self, monkeypatch):
        from src.main import app

        monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", self.TEST_MCP_TOKEN)
        unauthenticated_client = anonymous_client(app)
        response = unauthenticated_client.post(
            "/api/tools/alignment/multiple-protein",
            json={
                "sequences": [
                    {"id": "seq1", "sequence": "MSKGEEL"},
                    {"id": "seq2", "sequence": "MSKGEEA"},
                ]
            },
        )
        assert response.status_code == 401

    def test_rejects_an_invalid_session_token(self, monkeypatch):
        from src.main import app

        monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", self.TEST_MCP_TOKEN)
        wrong_client = TestClient(app, headers={"X-DNAForge-Session": "wrong-token"})
        response = wrong_client.post(
            "/api/tools/alignment/multiple-protein",
            json={
                "sequences": [
                    {"id": "seq1", "sequence": "MSKGEEL"},
                    {"id": "seq2", "sequence": "MSKGEEA"},
                ]
            },
        )
        assert response.status_code == 401

    def test_refuses_when_session_token_not_configured(self, monkeypatch):
        """Operator misconfiguration (env unset) is refused, and says so.

         changed the STATUS here from 500 to 401 on purpose. The
        boundary now refuses before routing, and the individual routes disagreed
        about this case (/external/* and this route said 500, /mcp/call said
        401), so one answer had to win at the layer that runs first. 401 won:
        from the caller's side the fact is identical either way, the body still
        carries MCP_SESSION_NOT_CONFIGURED plus a how_to_fix, and a launch
        misconfiguration should not fire every 5xx alarm in the stack on every
        request. `GET /ready` is where that condition is now reported
        (`session_auth_configured: false`). See src/security/local_access.py.
        """
        from src.main import app

        monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN", raising=False)
        client = TestClient(app, headers={"X-DNAForge-Session": "anything"})
        response = client.post(
            "/api/tools/alignment/multiple-protein",
            json={
                "sequences": [
                    {"id": "seq1", "sequence": "MSKGEEL"},
                    {"id": "seq2", "sequence": "MSKGEEA"},
                ]
            },
        )
        assert response.status_code == 500
        assert response.json()["error"]["code"] == "MCP_SESSION_NOT_CONFIGURED"

    def test_basic_multiple_protein_alignment(self, client):
        mock_output = ">seq1\nMSKGEEL\n>seq2\nMSKGEE-\n"

        with patch(
            "src.tools.alignment.run_mafft",
            new_callable=AsyncMock,
            return_value=(mock_output, ""),
        ):
            response = client.post(
                "/api/tools/alignment/multiple-protein",
                json={
                    "sequences": [
                        {"id": "seq1", "sequence": "MSKGEEL"},
                        {"id": "seq2", "sequence": "MSKGEE"},
                    ]
                },
            )
        assert response.status_code == 200
        data = response.json()
        assert data["num_sequences"] == 2
        assert data["alignment_length"] > 0

    def test_rejects_invalid_amino_acid_characters(self, client):
        response = client.post(
            "/api/tools/alignment/multiple-protein",
            json={
                "sequences": [
                    {"id": "seq1", "sequence": "MSKGEEL1"},
                    {"id": "seq2", "sequence": "MSKGEEA1"},
                ]
            },
        )
        assert response.status_code == 422

    def test_rejects_fewer_than_two_sequences(self, client):
        response = client.post(
            "/api/tools/alignment/multiple-protein",
            json={"sequences": [{"id": "seq1", "sequence": "MSKGEEL"}]},
        )
        assert response.status_code == 422

    def test_mafft_error(self, client):
        with patch(
            "src.tools.alignment.run_mafft",
            new_callable=AsyncMock,
            side_effect=subprocess.CalledProcessError(1, "mafft", stderr="error"),
        ):
            response = client.post(
                "/api/tools/alignment/multiple-protein",
                json={
                    "sequences": [
                        {"id": "seq1", "sequence": "MSKGEEL"},
                        {"id": "seq2", "sequence": "MSKGEEA"},
                    ]
                },
            )
        assert response.status_code == 500


@pytest.mark.skipif(not shutil.which("mafft"), reason="MAFFT not installed")
class TestMultipleProteinIntegration:
    """Integration test using the real MAFFT binary with real protein homologs."""

    @pytest.fixture
    def client(self, monkeypatch):
        from src.main import app

        monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "real-mafft-token")
        return TestClient(app, headers={"X-DNAForge-Session": "real-mafft-token"})

    def test_real_multiple_protein_alignment(self, client):
        gfp = (
            "MSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKLTLKFICTTGKLPVPWPTLVTT"
            "LTYGVQCFSRYPDHMKQHDFFKSAMPEGYVQERTIFFKDDGNYKTRAEVKFEGDTLVNRIELK"
            "GIDFKEDGNILGHKLEYNYNSHNVYIMADKQKNGIKVNFKIRHNIEDGSVQLADHYQQNTPIG"
            "DGPVLLPDNHYLSTQSALSKDPNEKRDHMVLLEFVTAAGITHGMDELYK"
        )

        gfp_variant = gfp[:-1] + "A"
        response = client.post(
            "/api/tools/alignment/multiple-protein",
            json={
                "sequences": [
                    {"id": "gfp", "sequence": gfp},
                    {"id": "gfp_variant", "sequence": gfp_variant},
                ]
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["num_sequences"] == 2
        assert data["alignment_length"] >= len(gfp)


class TestAlgorithmsEndpoint:
    """Tests for GET /api/tools/alignment/algorithms."""

    @pytest.fixture
    def client(self):
        from src.main import app

        return TestClient(app)

    def test_returns_all_algorithms(self, client):
        response = client.get("/api/tools/alignment/algorithms")
        assert response.status_code == 200
        data = response.json()
        algo_ids = [a["id"] for a in data["algorithms"]]
        assert "auto" in algo_ids
        assert "fast" in algo_ids
        assert "accurate" in algo_ids
        assert "ginsi" in algo_ids
        assert "linsi" in algo_ids
        assert "einsi" in algo_ids


class TestCacheEndpoints:
    """Tests for DELETE /api/tools/alignment/cache and /cache/all."""

    @pytest.fixture
    def client(self):
        from src.main import app

        return TestClient(app)

    def test_delete_specific_cache(self, client, monkeypatch, tmp_path):
        import src.tools.alignment as alignment_mod

        monkeypatch.setattr(alignment_mod, "CACHE_DIR", tmp_path)

        from src.tools.alignment import compute_checksum

        query = "ATCGATCGATCG"
        reference = "ATCGAATCGATCG"
        cache_key = compute_checksum(query, reference, "auto", "False")
        cache_file = tmp_path / f"{cache_key}.json"
        cache_file.write_text('{"test": true}')

        response = client.request(
            "DELETE",
            "/api/tools/alignment/cache",
            json={
                "query": query,
                "reference": reference,
                "algorithm": "auto",
                "is_circular": False,
            },
        )
        assert response.status_code == 200
        assert response.json()["deleted"] is True

    def test_clear_all_cache(self, client, monkeypatch, tmp_path):
        import src.tools.alignment as alignment_mod

        monkeypatch.setattr(alignment_mod, "CACHE_DIR", tmp_path)

        (tmp_path / "cache1.json").write_text("{}")
        (tmp_path / "cache2.json").write_text("{}")

        response = client.delete("/api/tools/alignment/cache/all")
        assert response.status_code == 200
        assert response.json()["deleted_count"] == 2


class TestHealthEndpoint:
    """Tests for GET /api/tools/alignment/health."""

    @pytest.fixture
    def client(self):
        from src.main import app

        return TestClient(app)

    def test_mafft_installed(self, client):
        with patch(
            "src.tools.alignment.run_mafft",
            new_callable=AsyncMock,
            return_value=("", "v7.490"),
        ):
            response = client.get("/api/tools/alignment/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert data["mafft_available"] is True

    def test_mafft_missing(self, client):
        with patch(
            "src.tools.alignment.run_mafft",
            new_callable=AsyncMock,
            side_effect=FileNotFoundError("mafft not found"),
        ):
            response = client.get("/api/tools/alignment/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "degraded"
        assert data["mafft_available"] is False


@pytest.mark.slow
@pytest.mark.skipif(
    not shutil.which("mafft"),
    reason="MAFFT not installed",
)
class TestAlignmentIntegration:
    """Integration tests using real MAFFT binary."""

    @pytest.fixture
    def client(self):
        from src.main import app

        return TestClient(app)

    def test_real_pairwise_alignment(self, client):

        query = "ATCGATCGATCGATCGATCG"
        reference = "ATCGTTCGATCGATCGATCG"

        response = client.post(
            "/api/tools/alignment/pairwise",
            json={
                "query": query,
                "reference": reference,
                "use_cache": False,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["identity"] > 0
        assert data["identity"] < 100
        assert len(data["mutations"]) > 0

    def test_real_circular_alignment(self, client):

        reference = "ATCGATCGATCGATCGATCG"

        query = reference[15:] + reference[:5]

        response = client.post(
            "/api/tools/alignment/pairwise",
            json={
                "query": query,
                "reference": reference,
                "is_circular": True,
                "use_cache": False,
            },
        )
        assert response.status_code == 200
        data = response.json()

        assert data["identity"] > 80

    def test_real_multiple_alignment(self, client):
        response = client.post(
            "/api/tools/alignment/multiple",
            json={
                "sequences": [
                    {"id": "seq1", "sequence": "ATCGATCGATCGATCGATCG"},
                    {"id": "seq2", "sequence": "ATCGTTCGATCGATCGATCG"},
                    {"id": "seq3", "sequence": "ATCGATCAATCGATCGATCG"},
                ]
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["num_sequences"] == 3
        assert data["alignment_length"] >= 20

    def test_real_pairwise_with_structural_analysis(self, client):

        reference = "ATCGATCGATCGATCGATCG"
        query = "ATCGATCG------GATCG"

        clean_query = query.replace("-", "")

        response = client.post(
            "/api/tools/alignment/pairwise",
            json={
                "query": clean_query,
                "reference": reference,
                "use_cache": False,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["analysis"] is not None
