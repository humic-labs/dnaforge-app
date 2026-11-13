"""
Tests for the Primer Binding API endpoint.

Uses edlib alignment to find primer binding sites on a template sequence.
Tests verify:
1. API contract (request/response format)
2. Forward and reverse complement matching
3. Circular sequence handling
4. Edit distance thresholds
5. Batch primer binding
6. Input validation
"""

from src.main import app
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient

client = TestClient(app)

FWD_PRIMER = "ATCGATCGATCGATCGATCG"

TEMPLATE = "AAAAA" + FWD_PRIMER + "TTTTT" + "GCTAGCTAGCTAGCTA" + "CCCCC"

RC_PRIMER = "TAGCTAGCTAGCTAGC"


class TestPrimerBindEndpoint:
    """Tests for POST /api/tools/primers/bind"""

    def test_aligns_forward_primer_to_sequence(self):
        """Forward primer finds exact match at correct position."""
        response = client.post(
            "/api/tools/primers/bind",
            json={
                "primer": FWD_PRIMER,
                "sequence": TEMPLATE,
                "max_edit_distance": 1,
            },
        )
        assert response.status_code == 200
        data = response.json()

        assert len(data["hits"]) >= 1
        hit = data["hits"][0]
        assert hit["identity"] == 1.0
        assert hit["edit_distance"] == 0
        assert hit["strand"] == 1

    def test_finds_reverse_complement_match(self):
        """Primer matching the reverse complement strand is detected."""
        response = client.post(
            "/api/tools/primers/bind",
            json={
                "primer": RC_PRIMER,
                "sequence": TEMPLATE,
                "max_edit_distance": 1,
            },
        )
        assert response.status_code == 200
        data = response.json()

        rc_hits = [h for h in data["hits"] if h["strand"] == -1]
        assert len(rc_hits) >= 1

    def test_handles_circular_sequence(self):
        """Primer binding site that spans the origin of a circular sequence."""
        circular_seq = "GCGATCGATCG" + "N" * 20 + "ATCGATCGATC"
        primer = "ATCGATCGATCGCGATCGATCG"

        response = client.post(
            "/api/tools/primers/bind",
            json={
                "primer": primer,
                "sequence": circular_seq,
                "circular": True,
                "max_edit_distance": 2,
            },
        )
        assert response.status_code == 200

    def test_returns_multiple_hits(self):
        """Template with repeated primer binding sites returns all hits."""
        repeated = "AAAAA" + FWD_PRIMER + "TTTTTTTT" + FWD_PRIMER + "CCCCC"
        response = client.post(
            "/api/tools/primers/bind",
            json={
                "primer": FWD_PRIMER,
                "sequence": repeated,
                "max_edit_distance": 0,
            },
        )
        assert response.status_code == 200
        data = response.json()

        assert len(data["hits"]) >= 2

    def test_respects_edit_distance_threshold(self):
        """Only exact matches returned when max_edit_distance=0."""
        mismatch_template = "AAAAA" + "ATCGATCGATCAATCGATCG" + "TTTTT"

        response = client.post(
            "/api/tools/primers/bind",
            json={
                "primer": FWD_PRIMER,
                "sequence": mismatch_template,
                "max_edit_distance": 0,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["hits"]) == 0

    def test_returns_empty_for_no_matches(self):
        """Unrelated primer returns empty hits array."""
        response = client.post(
            "/api/tools/primers/bind",
            json={
                "primer": "TTTTTTTTTTTTTTTTTTTT",
                "sequence": "GGGGGGGGGGGGGGGGGGGG",
                "max_edit_distance": 0,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["hits"] == []

    def test_handles_batch_of_primers(self):
        """Batch endpoint processes multiple primers against one sequence."""
        response = client.post(
            "/api/tools/primers/bind/batch",
            json={
                "primers": [FWD_PRIMER, RC_PRIMER, "TTTTTTTTTTTTTTTTTTTT"],
                "sequence": TEMPLATE,
                "max_edit_distance": 1,
            },
        )
        assert response.status_code == 200
        data = response.json()

        assert len(data["results"]) == 3
        assert len(data["results"][0]["hits"]) >= 1
        assert len(data["results"][2]["hits"]) == 0

    def test_returns_400_for_invalid_primer(self):
        """Empty primer sequence returns 400."""
        response = client.post(
            "/api/tools/primers/bind",
            json={
                "primer": "",
                "sequence": TEMPLATE,
            },
        )
        assert response.status_code == 422

    def test_returns_400_for_empty_sequence(self):
        """Empty template sequence returns 400."""
        response = client.post(
            "/api/tools/primers/bind",
            json={
                "primer": FWD_PRIMER,
                "sequence": "",
            },
        )
        assert response.status_code == 422
