"""
Tests for the Primer Design API endpoint.

Uses Primer3 under the hood, so these tests verify:
1. API contract (request/response format)
2. Input validation
3. Primer3 integration
4. Error handling
"""

from src.main import app
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient

client = TestClient(app)

TEST_SEQUENCE = (
    "ATGAAGTCTTTAATTAAAGAGTTTGATTCTCAGGTTGAAGAAGAGAAATCTGCTCGTATCTTGGCTAAGAAGGCTAAG"
    "ACTCACATCAAGATGACTGAGGACGACAAGAAGATCTTGGAGAACTTGGCTAAGGACGTTAAGAAGATGGCTGAGTCT"
    "GGTGCTCTGAAGGAGAAGATCGCTGAGTCTGGTGCTCTGAAGGAGAAGATCGCTAAGTCTGGTGCTCTGAAGGAGAAG"
    "ATCGCTGAGTCTGGTGCTCTGAAGGAGAAGATCGCTGAGTCTGGTGCTCTGAAGGAGAAGATCGCTGAGTCTGGTGCT"
    "CTGAAGGAGAAGATCGCTGAGTCTGGTGCTCTGAAGGAGAAGATCGCTGAGTCTGGTGCTCTGAAGGAGAAGATCGCT"
)


class TestPrimerDesignEndpoint:
    """Tests for POST /api/tools/primers/design"""

    def test_design_primers_basic(self):
        """Test basic primer design with default parameters."""
        response = client.post(
            "/api/tools/primers/design",
            json={"sequence": TEST_SEQUENCE},
        )
        assert response.status_code == 200
        data = response.json()

        assert data["success"] is True
        assert "primer_pairs" in data
        assert len(data["primer_pairs"]) > 0

        pair = data["primer_pairs"][0]
        assert "forward" in pair
        assert "reverse" in pair
        assert "product_size" in pair

        fwd = pair["forward"]
        assert "sequence" in fwd
        assert "tm" in fwd
        assert "gc_percent" in fwd
        assert "length" in fwd
        assert "start" in fwd

    def test_design_primers_with_target_region(self):
        """Test primer design targeting a specific region."""
        response = client.post(
            "/api/tools/primers/design",
            json={
                "sequence": TEST_SEQUENCE,
                "target_start": 100,
                "target_length": 50,
            },
        )
        assert response.status_code == 200
        data = response.json()

        assert data["success"] is True
        assert data["target_region"] == [100, 50]

    def test_design_primers_preserves_target_region_starting_at_zero(self):
        """Base zero is a real coordinate, not a missing target."""
        response = client.post(
            "/api/tools/primers/design",
            json={
                "sequence": TEST_SEQUENCE,
                "target_start": 0,
                "target_length": 50,
            },
        )
        assert response.status_code == 200
        assert response.json()["target_region"] == [0, 50]

    def test_design_primers_rejects_incomplete_target_region(self):
        """A target is either complete or rejected; it is never silently ignored."""
        for partial_target in ({"target_start": 0}, {"target_length": 50}):
            response = client.post(
                "/api/tools/primers/design",
                json={"sequence": TEST_SEQUENCE, **partial_target},
            )

            assert response.status_code == 400
            assert response.json()["detail"] == (
                "target_start and target_length must be provided together"
            )

    def test_design_primers_custom_parameters(self):
        """Test primer design with custom Tm and size parameters."""
        response = client.post(
            "/api/tools/primers/design",
            json={
                "sequence": TEST_SEQUENCE,
                "primer_min_tm": 58.0,
                "primer_opt_tm": 62.0,
                "primer_max_tm": 66.0,
                "primer_min_size": 20,
                "primer_opt_size": 22,
                "primer_max_size": 28,
                "product_min_size": 150,
                "product_max_size": 300,
            },
        )
        assert response.status_code == 200
        data = response.json()

        if data["success"] and data["primer_pairs"]:
            pair = data["primer_pairs"][0]
            assert 56.0 <= pair["forward"]["tm"] <= 68.0
            assert 56.0 <= pair["reverse"]["tm"] <= 68.0
            assert 150 <= pair["product_size"] <= 300

    def test_design_primers_sequence_too_short(self):
        """Test that short sequences are rejected."""
        response = client.post(
            "/api/tools/primers/design",
            json={"sequence": "ATCGATCG"},
        )
        assert response.status_code == 422

    def test_design_primers_invalid_characters(self):
        """Test that invalid DNA characters are rejected."""
        response = client.post(
            "/api/tools/primers/design",
            json={"sequence": "ATCG" * 20 + "XYZ"},
        )
        assert response.status_code == 422

    def test_design_primers_target_beyond_sequence(self):
        """Test that target region beyond sequence is rejected."""
        response = client.post(
            "/api/tools/primers/design",
            json={
                "sequence": TEST_SEQUENCE,
                "target_start": 400,
                "target_length": 50,
            },
        )
        assert response.status_code == 400

    def test_design_primers_num_return(self):
        """Test that num_return parameter limits results."""
        response = client.post(
            "/api/tools/primers/design",
            json={
                "sequence": TEST_SEQUENCE,
                "num_return": 2,
            },
        )
        assert response.status_code == 200
        data = response.json()

        if data["success"]:
            assert len(data["primer_pairs"]) <= 2


class TestPrimerAnalyzeEndpoint:
    """Tests for POST /api/tools/primers/analyze"""

    def test_analyze_primer_basic(self):
        """Test basic primer analysis."""
        response = client.post(
            "/api/tools/primers/analyze",
            params={"sequence": "ATGCGATCGATCGATCGATCG"},
        )
        assert response.status_code == 200
        data = response.json()

        assert "sequence" in data
        assert "length" in data
        assert "tm" in data
        assert "gc_percent" in data
        assert "quality" in data
        assert data["length"] == 21

    def test_analyze_primer_gc_content(self):
        """Test GC content calculation."""
        response = client.post(
            "/api/tools/primers/analyze",
            params={"sequence": "GCGCGCGCGCGCGCGCGCGC"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["gc_percent"] == 100.0

        response = client.post(
            "/api/tools/primers/analyze",
            params={"sequence": "ATATATATATATATATATA"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["gc_percent"] == 0.0

    def test_analyze_primer_tm_reasonable(self):
        """Test that Tm values are reasonable."""
        response = client.post(
            "/api/tools/primers/analyze",
            params={"sequence": "ATGCATGCATGCATGCATGC"},
        )
        assert response.status_code == 200
        data = response.json()

        assert 45.0 <= data["tm"] <= 70.0

    def test_analyze_primer_too_short(self):
        """Test that short primers are rejected."""
        response = client.post(
            "/api/tools/primers/analyze",
            params={"sequence": "ATCG"},
        )
        assert response.status_code == 400

    def test_analyze_primer_too_long(self):
        """Test that long primers are rejected."""
        response = client.post(
            "/api/tools/primers/analyze",
            params={"sequence": "ATCG" * 15},
        )
        assert response.status_code == 400

    def test_analyze_primer_quality_assessment(self):
        """Test quality assessment based on characteristics."""
        response = client.post(
            "/api/tools/primers/analyze",
            params={"sequence": "ATGCATGCATGCATGCATGC"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["quality"] in ["good", "fair", "poor"]

    def test_analyze_primer_warnings(self):
        """Test that warnings are generated for problematic primers."""
        response = client.post(
            "/api/tools/primers/analyze",
            params={"sequence": "ATATATATATATATATATA"},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["warnings"]) > 0
        assert any("GC" in w for w in data["warnings"])


class TestApplicationPresets:
    """Tests for application-aware primer design."""

    def test_get_all_applications(self):
        """Test that /applications returns all application presets."""
        response = client.get("/api/tools/primers/applications")
        assert response.status_code == 200
        data = response.json()

        assert "applications" in data
        applications = data["applications"]

        app_ids = [app["id"] for app in applications]
        expected_apps = [
            "pcr",
            "sequencing",
            "qpcr",
            "colony_pcr",
            "gibson",
            "golden_gate",
            "sdm",
            "re_cloning",
        ]
        for application_id in expected_apps:
            assert application_id in app_ids

        for application in applications:
            assert "id" in application
            assert "name" in application
            assert "description" in application
            assert "presets" in application
            assert "primer_min_tm" in application["presets"]
            assert "primer_opt_tm" in application["presets"]
            assert "primer_max_tm" in application["presets"]

    def test_get_single_application(self):
        """Test that /applications/{app} returns specific preset."""
        response = client.get("/api/tools/primers/applications/qpcr")
        assert response.status_code == 200
        data = response.json()

        assert data["application"] == "qpcr"
        assert data["name"] == "Qpcr"
        assert "presets" in data
        assert data["presets"]["product_min_size"] == 60
        assert data["presets"]["product_max_size"] == 150

    def test_get_invalid_application(self):
        """Test that invalid application returns 422 (validation error)."""
        response = client.get("/api/tools/primers/applications/invalid_app")
        assert response.status_code == 422

    def test_design_with_qpcr_application(self):
        """Test that qPCR application returns small amplicons."""
        response = client.post(
            "/api/tools/primers/design",
            json={
                "sequence": TEST_SEQUENCE,
                "application": "qpcr",
            },
        )
        assert response.status_code == 200
        data = response.json()

        assert data["success"] is True
        assert data["application"] == "qpcr"
        assert "params_used" in data

        if data["primer_pairs"]:
            for pair in data["primer_pairs"]:
                assert 60 <= pair["product_size"] <= 150

    def test_design_with_colony_pcr_application(self):
        """Test that colony PCR requires longer sequences (500-2000bp products)."""
        response = client.post(
            "/api/tools/primers/design",
            json={
                "sequence": TEST_SEQUENCE,
                "application": "colony_pcr",
            },
        )
        assert response.status_code in [400, 500]

    def test_colony_pcr_presets(self):
        """Test colony PCR preset values."""
        response = client.get("/api/tools/primers/applications/colony_pcr")
        assert response.status_code == 200
        data = response.json()

        assert data["presets"]["product_min_size"] == 500
        assert data["presets"]["product_max_size"] == 2000

    def test_design_with_sdm_application(self):
        """Test SDM application has longer primer constraints."""
        response = client.get("/api/tools/primers/applications/sdm")
        assert response.status_code == 200
        data = response.json()

        assert data["presets"]["primer_min_size"] == 25
        assert data["presets"]["primer_min_tm"] == 65.0

    def test_params_used_in_response(self):
        """Test that params_used reflects effective parameters."""
        response = client.post(
            "/api/tools/primers/design",
            json={
                "sequence": TEST_SEQUENCE,
                "application": "pcr",
            },
        )
        assert response.status_code == 200
        data = response.json()

        params = data["params_used"]
        assert params["primer_min_tm"] == 55.0
        assert params["primer_opt_tm"] == 60.0
        assert params["primer_max_tm"] == 65.0
        assert params["product_min_size"] == 100
        assert params["product_max_size"] == 1000

    def test_parameter_override(self):
        """Test that explicit parameters override presets."""
        response = client.post(
            "/api/tools/primers/design",
            json={
                "sequence": TEST_SEQUENCE,
                "application": "pcr",
                "primer_opt_tm": 62.5,
                "product_max_size": 500,
            },
        )
        assert response.status_code == 200
        data = response.json()

        params = data["params_used"]
        assert params["primer_opt_tm"] == 62.5
        assert params["product_max_size"] == 500
        assert params["primer_min_tm"] == 55.0

    def test_default_application_is_pcr(self):
        """Test that PCR is the default application."""
        response = client.post(
            "/api/tools/primers/design",
            json={"sequence": TEST_SEQUENCE},
        )
        assert response.status_code == 200
        data = response.json()

        assert data["application"] == "pcr"

    def test_gibson_presets(self):
        """Test Gibson/HiFi assembly presets."""
        response = client.get("/api/tools/primers/applications/gibson")
        assert response.status_code == 200
        data = response.json()

        assert data["presets"]["primer_opt_size"] == 22
        assert data["presets"]["primer_max_size"] == 28
        assert data["presets"]["product_max_size"] == 10000

    def test_golden_gate_presets(self):
        """Test Golden Gate assembly presets."""
        response = client.get("/api/tools/primers/applications/golden_gate")
        assert response.status_code == 200
        data = response.json()

        assert data["presets"]["primer_min_tm"] == 52.0
        assert data["presets"]["primer_opt_tm"] == 58.0
        assert data["presets"]["primer_max_tm"] == 62.0


class TestEndpointAvailability:
    """Test that endpoints are available and respond."""

    def test_design_endpoint_exists(self):
        """Verify design endpoint responds."""
        response = client.post(
            "/api/tools/primers/design",
            json={"sequence": TEST_SEQUENCE},
        )
        assert response.status_code in [200, 422, 400]

    def test_analyze_endpoint_exists(self):
        """Verify analyze endpoint responds."""
        response = client.post(
            "/api/tools/primers/analyze",
            params={"sequence": "ATGCATGCATGCATGCATGC"},
        )
        assert response.status_code in [200, 422, 400]

    def test_applications_endpoint_exists(self):
        """Verify applications endpoint responds."""
        response = client.get("/api/tools/primers/applications")
        assert response.status_code == 200
