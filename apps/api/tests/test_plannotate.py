"""
Tests for pLannotate annotation service.

- PlannotateService.annotate(AnnotationRequest) -> AnnotationResult, the one
  annotation implementation behind POST /annotation 
- Discovery description derived from those models
- Database download management
"""

import asyncio
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from src.services.plannotate import AnnotationFeature, AnnotationRequest
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient


class TestPlannotateServiceDefinition:
    """Tests for the PlannotateService class."""

    def test_plannotate_service_exists(self):
        """PlannotateService can be imported."""
        from src.services.plannotate import PlannotateService

        service = PlannotateService()
        assert service is not None

    def test_plannotate_service_name(self):
        """Service name is 'plannotate'."""
        from src.services.plannotate import PlannotateService

        service = PlannotateService()
        assert service.name == "plannotate_service"

    def test_plannotate_input_types_come_from_the_request_model(self):
        """The discovery listing is derived from AnnotationRequest."""
        from src.services.plannotate import AnnotationRequest, PlannotateService

        service = PlannotateService()
        assert set(service.INPUT_TYPES) == set(AnnotationRequest.model_fields)
        assert service.INPUT_TYPES["sequence"]["type"] == "string"
        assert service.INPUT_TYPES["sequence"]["required"] is True

    def test_plannotate_return_types_come_from_the_result_model(self):
        """The discovery listing is derived from AnnotationResult."""
        from src.services.plannotate import AnnotationResult, PlannotateService

        service = PlannotateService()
        assert set(service.RETURN_TYPES) == set(AnnotationResult.model_fields)
        assert service.RETURN_TYPES["features"]["type"] == "array"


class TestPlannotateExecution:
    """Tests for pLannotate execution."""

    @pytest.fixture
    def service(self):
        from src.services.plannotate import PlannotateService

        return PlannotateService()

    @pytest.mark.asyncio
    async def test_execute_returns_features_list(self, service):
        """Execute returns a dict with features list."""
        result = await service.annotate(AnnotationRequest(sequence="ATCGATCG"))

        assert isinstance(result.features, list)

    @pytest.mark.asyncio
    async def test_execute_with_valid_plasmid_returns_annotations(self, service):
        """Execute with a known plasmid returns annotations."""
        puc19_ori = (
            "TTGAGATCCTTTTTTTCTGCGCGTAATCTGCTGCTTGCAAACAAAAAAACCACCGCTACCAGCGGTGGTTTGTTTGCC"
            "GGATCAAGAGCTACCAACTCTTTTTCCGAAGGTAACTGGCTTCAGCAGAGCGCAGATACCAAATACTGTCCTTCTAGT"
            "GTAGCCGTAGTTAGGCCACCACTTCAAGAACTCTGTAGCACCGCCTACATACCTCGCTCTGCTAATCCTGTTACCAGT"
        )

        result = await service.annotate(AnnotationRequest(sequence=puc19_ori))

        assert isinstance(result.features, list)

    @pytest.mark.asyncio
    async def test_feature_structure(self, service):
        """Features have expected structure with identity/coverage."""
        amp_promoter = "TTTACACTTTATGCTTCCGGCTCGTATGTTGTGTGGAATTGTGAGCGGATAACAATTTCACACAGGAAACAGCTATG"

        result = await service.annotate(AnnotationRequest(sequence=amp_promoter))

        if result.features:
            feature = result.features[0]
            assert isinstance(feature, AnnotationFeature)
            assert feature.name and feature.start and feature.end
            assert feature.strand in (1, -1)

    @pytest.mark.asyncio
    async def test_run_plannotate_uses_thread_and_explicit_runtime(
        self, service, monkeypatch
    ):
        """Annotation passes exact local resources without mutating process PATH."""
        import importlib

        import pandas as pd

        import src.services.plannotate as pm

        original_path = os.environ.get("PATH", "")
        service._binaries_dir = Path("/tmp/dnaforge test binaries")
        calls = {}

        async def fake_to_thread(fn):
            calls["to_thread"] = True
            return fn()

        def fake_annotate(sequence, *, linear, is_detailed, runtime, yaml_file):
            calls["sequence"] = sequence
            calls["linear"] = linear
            calls["is_detailed"] = is_detailed
            calls["runtime"] = runtime
            calls["yaml_file"] = yaml_file
            return pd.DataFrame()

        monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)
        monkeypatch.setattr(pm, "annotate", fake_annotate, raising=False)
        monkeypatch.setitem(os.environ, "PATH", original_path)

        ann = importlib.import_module("src.annotation.annotate")

        monkeypatch.setattr(ann, "annotate", fake_annotate)
        monkeypatch.setattr(
            pm,
            "check_required_binaries",
            lambda _directory: {
                "blastn": "/tmp/dnaforge test binaries/blastn",
                "diamond": "/tmp/dnaforge test binaries/diamond",
                "cmscan": "/tmp/dnaforge test binaries/cmscan",
            },
        )

        result = await service._run_plannotate("ACGT", linear=True)

        assert result == []
        assert calls["to_thread"] is True
        assert calls["sequence"] == "ACGT"
        assert calls["linear"] is True
        assert calls["is_detailed"] is False
        assert calls["runtime"] == service.runtime
        assert calls["runtime"].data_dir == service._db_path
        assert calls["runtime"].threads == 1
        assert os.environ.get("PATH", "") == original_path


class TestPlannotateDatabaseManagement:
    """Tests for database download and status."""

    @pytest.fixture
    def service(self):
        from src.services.plannotate import PlannotateService

        return PlannotateService()

    def test_database_status_check(self, service):
        """Can check if database is downloaded."""
        status = service.get_database_status()

        assert "downloaded" in status
        assert isinstance(status["downloaded"], bool)
        assert "path" in status

    def test_database_path_is_in_app_data(self, service):
        """Database path is in user's app data directory."""
        status = service.get_database_status()

        path = status["path"]
        assert "plannotate" in path.lower() or "waypoint" in path.lower()


class TestPlannotateAPIIntegration:
    """Tests for pLannotate via /services/ API."""

    @pytest.fixture
    def client(self):
        from src.main import app

        return TestClient(app)

    def test_plannotate_in_service_list(self, client):
        """pLannotate appears in service list."""
        response = client.get("/services/")
        assert response.status_code == 200

        data = response.json()
        service_names = [s["name"] for s in data["services"]]
        assert "plannotate_service" in service_names

    def test_plannotate_schema_endpoint(self, client):
        """Can get pLannotate schema."""
        response = client.get("/services/plannotate_service/schema")
        assert response.status_code == 200

        schema = response.json()
        assert schema["name"] == "plannotate_service"
        assert "sequence" in schema["input_types"]

    def test_plannotate_typed_route(self, client):
        """Can run pLannotate through its typed route."""
        response = client.post("/annotation", json={"sequence": "ATCGATCGATCG"})
        assert response.status_code == 200

        data = response.json()
        assert "features" in data
        assert data["sequence_length"] == 12

    def test_generic_execute_route_rejects_built_in(self, client):
        """The open plugin route no longer runs the built-in service."""
        response = client.post(
            "/services/plannotate_service/execute", json={"sequence": "ATCGATCGATCG"}
        )
        assert response.status_code == 404


class TestPlannotateBinaryDiscovery:
    """Tests for binary path discovery and platform detection."""

    def test_find_binaries_dir_returns_valid_path_or_none(self):
        """find_binaries_dir returns Path or None, not an invalid path."""
        from src.services.plannotate import find_binaries_dir

        result = find_binaries_dir()

        if result is not None:
            assert (
                result.is_dir()
            ), f"find_binaries_dir returned non-directory: {result}"

    def test_get_platform_suffix_returns_valid_suffix(self):
        """get_platform_suffix returns a valid platform suffix."""
        from src.services.plannotate import get_platform_suffix

        suffix = get_platform_suffix()

        valid_suffixes = [
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
            "aarch64-unknown-linux-gnu",
            "x86_64-unknown-linux-gnu",
            "x86_64-pc-windows-msvc",
        ]
        assert suffix in valid_suffixes, f"Invalid platform suffix: {suffix}"

    def test_rosetta_detection_on_apple_silicon(self):
        """On Apple Silicon, should detect aarch64 even under Rosetta."""
        import platform
        import subprocess

        if platform.system() != "Darwin":
            pytest.skip("Rosetta detection only applies to macOS")

        result = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True,
            text=True,
        )
        if "Apple" not in result.stdout:
            pytest.skip("Not running on Apple Silicon")

        from src.services.plannotate import get_platform_suffix

        suffix = get_platform_suffix()
        assert (
            suffix == "aarch64-apple-darwin"
        ), f"On Apple Silicon, should detect aarch64, got: {suffix}"

    def test_check_required_binaries_returns_dict(self):
        """check_required_binaries returns a dict with the platform's tools."""
        from src.annotation.tools import get_platform_binary_names
        from src.services.plannotate import check_required_binaries, find_binaries_dir

        binaries_dir = find_binaries_dir()
        result = check_required_binaries(binaries_dir)

        assert isinstance(result, dict)
        assert "blastn" in result
        assert "diamond" in result
        if "cmscan" in get_platform_binary_names(required_by="plannotate"):
            assert "cmscan" in result
        else:
            assert "cmscan" not in result

    def test_binary_paths_are_valid_when_found(self):
        """When binaries are found, paths point to existing files."""
        from pathlib import Path

        from src.services.plannotate import check_required_binaries, find_binaries_dir

        binaries_dir = find_binaries_dir()
        result = check_required_binaries(binaries_dir)

        for _name, path in result.items():
            if path is not None:
                assert Path(path).exists(), f"Binary path doesn't exist: {path}"
                assert Path(path).is_file(), f"Binary path is not a file: {path}"


class TestPlannotateInfernalHandling:
    """Tests for infernal empty-result handling (vendored, no runtime patching)."""

    def test_vendored_infernal_handles_empty_results(self):
        """The vendored infernal parser handles empty cmscan output directly."""
        from pathlib import Path
        from tempfile import NamedTemporaryFile

        from src.annotation.infernal import parse_infernal

        tmp = NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
        tmp.write("#target name\n")
        tmp.write("#---\n")
        tmp.close()

        result = parse_infernal(tmp.name)
        assert len(result) == 0
        assert "sseqid" in result.columns
        Path(tmp.name).unlink()

    def test_no_runtime_patching_needed(self):
        """The service module should not have _infernal_patched (removed)."""
        import src.services.plannotate as pm

        assert not hasattr(
            pm, "_infernal_patched"
        ), "_infernal_patched still exists — runtime patching should be removed"

    @pytest.mark.asyncio
    async def test_empty_sequence_no_crash(self):
        """Empty or very short sequences should not crash."""
        from src.services.plannotate import PlannotateService

        service = PlannotateService()

        result = await service.annotate(AnnotationRequest(sequence=""))
        assert result.features == []
        assert result.sequence_length == 0

    @pytest.mark.asyncio
    async def test_short_sequence_no_error(self):
        """Short sequences that have no Rfam hits should not cause errors."""
        from src.services.plannotate import PlannotateService

        service = PlannotateService()

        result = await service.annotate(AnnotationRequest(sequence="ATCG"))

        assert isinstance(result.features, list)
        assert result.sequence_length == 4
        if result.error is not None:
            assert "list index out of range" not in result.error

    def test_debug_error_format_includes_traceback_when_enabled(self, monkeypatch):
        """CI probes can opt into traceback detail without changing default errors."""
        from src.services.plannotate import _format_annotation_error

        exc = RuntimeError("boom")

        monkeypatch.delenv("DNAFORGE_ANNOTATION_DEBUG_ERRORS", raising=False)
        assert _format_annotation_error(exc) == "boom"

        try:
            raise exc
        except RuntimeError as caught:
            monkeypatch.setenv("DNAFORGE_ANNOTATION_DEBUG_ERRORS", "1")
            formatted = _format_annotation_error(caught)

        assert "boom" in formatted
        assert "Traceback (most recent call last)" in formatted
        assert "test_debug_error_format_includes_traceback_when_enabled" in formatted


class TestPlannotateDownloadingState:
    """Error messages during database download should be contextual."""

    @pytest.mark.asyncio
    async def test_error_message_when_downloading(self):
        """Error should say databases are downloading, not prompt Settings."""
        import src.annotation.setup as setup_mod
        from src.services.plannotate import PlannotateService

        service = PlannotateService()
        service._plannotate_available = False
        original = setup_mod._downloading
        try:
            setup_mod._downloading = True
            result = await service.annotate(AnnotationRequest(sequence="ATCGATCG"))
            assert result.error is not None
            assert "downloading" in result.error.lower()
            assert "Settings" not in result.error
        finally:
            setup_mod._downloading = original

    @pytest.mark.asyncio
    async def test_error_message_when_not_downloading(self):
        """When not downloading, error should mention Settings."""
        import src.annotation.setup as setup_mod
        from src.services.plannotate import PlannotateService

        service = PlannotateService()
        service._plannotate_available = False
        original = setup_mod._downloading
        try:
            setup_mod._downloading = False
            result = await service.annotate(AnnotationRequest(sequence="ATCGATCG"))
            assert result.error is not None
            assert "settings" in result.error.lower()
        finally:
            setup_mod._downloading = original

    @pytest.mark.asyncio
    async def test_execute_does_not_read_databases_during_startup_provisioning(
        self, monkeypatch
    ):
        """Annotation must not race the Windows Rfam replacement window."""
        from src.services.plannotate import PlannotateService

        service = PlannotateService()
        run_called = False

        async def fake_run_plannotate(sequence, linear):
            nonlocal run_called
            run_called = True
            return []

        monkeypatch.setattr(service, "_run_plannotate", fake_run_plannotate)
        monkeypatch.setattr(
            "src.annotation.setup.is_annotation_provisioning", lambda: True
        )

        result = await service.annotate(AnnotationRequest(sequence="ATCGATCG"))

        assert run_called is False
        assert result.features == []
        assert result.error == (
            "Annotation databases are downloading or being prepared. This may take a few minutes."
        )

    @pytest.mark.asyncio
    async def test_missing_databases_precede_rfam_runtime_error(self, monkeypatch):
        """An incomplete installation must direct the user to Settings."""
        from src.services.plannotate import PlannotateService

        service = PlannotateService()
        run_called = False

        async def fake_run_plannotate(sequence, linear):
            nonlocal run_called
            run_called = True
            return []

        monkeypatch.setattr(service, "_run_plannotate", fake_run_plannotate)
        monkeypatch.setattr(
            service,
            "get_database_status",
            lambda: {"downloaded": False},
        )
        monkeypatch.setattr(
            "src.annotation.setup.is_annotation_provisioning", lambda: False
        )
        monkeypatch.setattr("src.annotation.setup.is_rfam_runtime_ready", lambda: False)

        result = await service.annotate(AnnotationRequest(sequence="ATCGATCG"))

        assert run_called is False
        assert result.features == []
        assert result.error == (
            "Annotation databases not installed. Check Annotation Engine in Settings."
        )
        assert "Rfam" not in result.error

    @pytest.mark.asyncio
    async def test_installed_but_unusable_rfam_remains_fail_closed(self, monkeypatch):
        """Do not report scientifically incomplete annotation as success."""
        from src.services.plannotate import PlannotateService

        service = PlannotateService()
        run_called = False

        async def fake_run_plannotate(sequence, linear):
            nonlocal run_called
            run_called = True
            return []

        monkeypatch.setattr(service, "_run_plannotate", fake_run_plannotate)
        monkeypatch.setattr(
            service,
            "get_database_status",
            lambda: {"downloaded": True},
        )
        monkeypatch.setattr(
            "src.annotation.setup.is_annotation_provisioning", lambda: False
        )
        monkeypatch.setattr("src.annotation.setup.is_rfam_runtime_ready", lambda: False)

        result = await service.annotate(AnnotationRequest(sequence="ATCGATCG"))

        assert run_called is False
        assert result.features == []
        assert result.error == (
            "Rfam annotation indexes are unavailable for this platform."
        )


class TestPlannotateUserFacingErrors:
    """Error messages must be user-facing, not developer-facing."""

    @pytest.fixture
    def service(self):
        from src.services.plannotate import PlannotateService

        return PlannotateService()

    @pytest.mark.asyncio
    async def test_error_messages_are_user_facing(self, service):
        """Error messages should not contain REST endpoints or shell commands."""
        result = await service.annotate(AnnotationRequest(sequence="ATCGATCG"))

        if result.error is not None:
            error = result.error
            assert (
                "POST /toolbox/retry" not in error
            ), f"Error contains REST endpoint: {error}"
            assert (
                "download-binaries.sh" not in error
            ), f"Error contains shell command: {error}"
            assert (
                "curl" not in error.lower()
            ), f"Error contains curl reference: {error}"


class TestPlannotateAnnotationIntegration:
    """Integration tests that verify annotation actually returns features.

    These tests use known sequences (pUC19) and assert that expected features
    are found. This catches bugs like passing file paths instead of sequence
    strings to the annotate() function.

    CRITICAL: These tests require pLannotate databases to be installed.
    They will be skipped if databases are not available.
    """

    PUC19_SEQUENCE = (
        "TCGCGCGTTTCGGTGATGACGGTGAAAACCTCTGACACATGCAGCTCCCGGAGACGGTCACAGCTTGTCTGTAAGCGGA"
        "TGCCGGGAGCAGACAAGCCCGTCAGGGCGCGTCAGCGGGTGTTGGCGGGTGTCGGGGCTGGCTTAACTATGCGGCATCA"
        "GAGCAGATTGTACTGAGAGTGCACCATATGCGGTGTGAAATACCGCACAGATGCGTAAGGAGAAAATACCGCATCAGGC"
        "GCCATTCGCCATTCAGGCTGCGCAACTGTTGGGAAGGGCGATCGGTGCGGGCCTCTTCGCTATTACGCCAGCTGGCGAA"
        "AGGGGGATGTGCTGCAAGGCGATTAAGTTGGGTAACGCCAGGGTTTTCCCAGTCACGACGTTGTAAAACGACGGCCAGT"
        "GAATTCGAGCTCGGTACCCGGGGATCCTCTAGAGTCGACCTGCAGGCATGCAAGCTTGGCGTAATCATGGTCATAGCTG"
        "TTTCCTGTGTGAAATTGTTATCCGCTCACAATTCCACACAACATACGAGCCGGAAGCATAAAGTGTAAAGCCTGGGGTG"
        "CCTAATGAGTGAGCTAACTCACATTAATTGCGTTGCGCTCACTGCCCGCTTTCCAGTCGGGAAACCTGTCGTGCCAGCT"
        "GCATTAATGAATCGGCCAACGCGCGGGGAGAGGCGGTTTGCGTATTGGGCGCTCTTCCGCTTCCTCGCTCACTGACTCG"
        "CTGCGCTCGGTCGTTCGGCTGCGGCGAGCGGTATCAGCTCACTCAAAGGCGGTAATACGGTTATCCACAGAATCAGGGG"
        "ATAACGCAGGAAAGAACATGTGAGCAAAAGGCCAGCAAAAGGCCAGGAACCGTAAAAAGGCCGCGTTGCTGGCGTTTTT"
        "CCATAGGCTCCGCCCCCCTGACGAGCATCACAAAAATCGACGCTCAAGTCAGAGGTGGCGAAACCCGACAGGACTATAA"
        "AGATACCAGGCGTTTCCCCCTGGAAGCTCCCTCGTGCGCTCTCCTGTTCCGACCCTGCCGCTTACCGGATACCTGTCCG"
        "CCTTTCTCCCTTCGGGAAGCGTGGCGCTTTCTCATAGCTCACGCTGTAGGTATCTCAGTTCGGTGTAGGTCGTTCGCTC"
        "CAAGCTGGGCTGTGTGCACGAACCCCCCGTTCAGCCCGACCGCTGCGCCTTATCCGGTAACTATCGTCTTGAGTCCAAC"
        "CCGGTAAGACACGACTTATCGCCACTGGCAGCAGCCACTGGTAACAGGATTAGCAGAGCGAGGTATGTAGGCGGTGCTA"
        "CAGAGTTCTTGAAGTGGTGGCCTAACTACGGCTACACTAGAAGAACAGTATTTGGTATCTGCGCTCTGCTGAAGCCAGT"
        "TACCTTCGGAAAAAGAGTTGGTAGCTCTTGATCCGGCAAACAAACCACCGCTGGTAGCGGTGGTTTTTTTGTTTGCAAG"
        "CAGCAGATTACGCGCAGAAAAAAAGGATCTCAAGAAGATCCTTTGATCTTTTCTACGGGGTCTGACGCTCAGTGGAACG"
        "AAAACTCACGTTAAGGGATTTTGGTCATGAGATTATCAAAAAGGATCTTCACCTAGATCCTTTTAAATTAAAAATGAAG"
        "TTTTAAATCAATCTAAAGTATATATGAGTAAACTTGGTCTGACAGTTACCAATGCTTAATCAGTGAGGCACCTATCTCA"
        "GCGATCTGTCTATTTCGTTCATCCATAGTTGCCTGACTCCCCGTCGTGTAGATAACTACGATACGGGAGGGCTTACCAT"
        "CTGGCCCCAGTGCTGCAATGATACCGCGAGACCCACGCTCACCGGCTCCAGATTTATCAGCAATAAACCAGCCAGCCGG"
        "AAGGGCCGAGCGCAGAAGTGGTCCTGCAACTTTATCCGCCTCCATCCAGTCTATTAATTGTTGCCGGGAAGCTAGAGTA"
        "AGTAGTTCGCCAGTTAATAGTTTGCGCAACGTTGTTGCCATTGCTACAGGCATCGTGGTGTCACGCTCGTCGTTTGGTA"
        "TGGCTTCATTCAGCTCCGGTTCCCAACGATCAAGGCGAGTTACATGATCCCCCATGTTGTGCAAAAAAGCGGTTAGCTC"
        "CTTCGGTCCTCCGATCGTTGTCAGAAGTAAGTTGGCCGCAGTGTTATCACTCATGGTTATGGCAGCACTGCATAATTCT"
        "CTTACTGTCATGCCATCCGTAAGATGCTTTTCTGTGACTGGTGAGTACTCAACCAAGTCATTCTGAGAATAGTGTATGC"
        "GGCGACCGAGTTGCTCTTGCCCGGCGTCAATACGGGATAATACCGCGCCACATAGCAGAACTTTAAAAGTGCTCATCAT"
        "TGGAAAACGTTCTTCGGGGCGAAAACTCTCAAGGATCTTACCGCTGTTGAGATCCAGTTCGATGTAACCCACTCGTGCA"
        "CCCAACTGATCTTCAGCATCTTTTACTTTCACCAGCGTTTCTGGGTGAGCAAAAACAGGAAGGCAAAATGCCGCAAAAA"
        "AGGGAATAAGGGCGACACGGAAATGTTGAATACTCATACTCTTCCTTTTTCAATATTATTGAAGCATTTATCAGGGTTA"
        "TTGTCTCATGAGCGGATACATATTTGAATGTATTTAGAAAAATAAACAAATAGGGGTTCCGCGCACATTTCCCCGAAAA"
        "GTGCCACCTGACGTC"
    )

    EXPECTED_PUC19_FEATURES = {
        "AmpR",
        "ori",
        "lacZ",
    }

    @pytest.fixture
    def service(self):
        from src.services.plannotate import PlannotateService

        return PlannotateService()

    @pytest.fixture
    def skip_if_no_databases(self, service):
        """Skip test if pLannotate databases are not available."""
        status = service.get_database_status()
        if not status["plannotate_available"]:
            pytest.skip("pLannotate library not installed")

        if not status["downloaded"]:
            pytest.skip("Annotation databases not downloaded")

        missing = [k for k, v in status["binaries"].items() if v is None]
        if missing:
            pytest.skip(f"Missing binaries: {', '.join(missing)}")

    @pytest.mark.asyncio
    async def test_puc19_returns_features(self, service, skip_if_no_databases):
        """pUC19 sequence MUST return features, not an empty list.

        This test would have caught the bug where we passed a file path
        instead of a sequence string to annotate().
        """
        result = await service.annotate(AnnotationRequest(sequence=self.PUC19_SEQUENCE))

        assert result.error is None, f"Annotation failed: {result.error}"

        features = result.features
        assert len(features) > 0, (
            "pUC19 annotation returned 0 features. "
            "This is a well-characterized plasmid that MUST have features. "
            "Check if sequence is being passed correctly to annotate()."
        )

    @pytest.mark.asyncio
    async def test_puc19_contains_expected_features(
        self, service, skip_if_no_databases
    ):
        """pUC19 must contain specific known features like AmpR and ori."""
        result = await service.annotate(AnnotationRequest(sequence=self.PUC19_SEQUENCE))

        assert result.error is None, f"Annotation failed: {result.error}"

        feature_names = {f.name for f in result.features}

        found_expected = set()
        for expected in self.EXPECTED_PUC19_FEATURES:
            for name in feature_names:
                if expected.lower() in name.lower():
                    found_expected.add(expected)
                    break

        missing = self.EXPECTED_PUC19_FEATURES - found_expected
        assert (
            len(missing) == 0
        ), f"pUC19 missing expected features: {missing}. Found features: {feature_names}"

    @pytest.mark.asyncio
    async def test_feature_data_quality(self, service, skip_if_no_databases):
        """Features must have valid coordinates, identity, and coverage scores."""
        result = await service.annotate(AnnotationRequest(sequence=self.PUC19_SEQUENCE))

        assert result.error is None, f"Annotation failed: {result.error}"
        assert len(result.features) > 0, "No features found"

        sequence_length = result.sequence_length

        for feature in result.features:
            assert feature.start >= 0, f"Invalid start: {feature}"
            assert feature.end >= 0, f"Invalid end: {feature}"

            assert (
                feature.start <= sequence_length or feature.end <= sequence_length
            ), f"Feature coordinates outside sequence: {feature}"

            assert 0 <= feature.identity <= 100, f"Invalid identity: {feature.identity}"
            assert 0 <= feature.coverage <= 100, f"Invalid coverage: {feature.coverage}"

            assert feature.strand in (1, -1), f"Invalid strand: {feature.strand}"

    @pytest.mark.asyncio
    async def test_api_endpoint_returns_features(self, skip_if_no_databases):
        """API endpoint must return features for pUC19.

        This tests the full stack from HTTP to annotation.
        """
        from src.main import app
        from tests.sidecar_test_client import (
            AuthenticatedSidecarTestClient as TestClient,
        )

        client = TestClient(app)
        response = client.post("/annotation", json={"sequence": self.PUC19_SEQUENCE})

        assert response.status_code == 200
        data = response.json()

        assert "error" not in data, f"API returned error: {data.get('error')}"
        assert (
            len(data["features"]) > 0
        ), "API returned 0 features for pUC19. This indicates the annotation pipeline is broken."


class TestPlannotatePathCalculation:
    """Tests for correct path calculation to binaries directory."""

    def test_path_calculation_from_module_file(self):
        """Path calculation should correctly traverse from module to binaries."""
        from pathlib import Path

        import src.services.plannotate as pm

        module_file = Path(pm.__file__)

        apps_dir = module_file.parent.parent.parent.parent
        assert apps_dir.name == "apps", f"Expected apps dir, got: {apps_dir}"
        assert (apps_dir / "api").is_dir(), "apps/api should exist"
        assert (apps_dir / "desktop").is_dir(), "apps/desktop should exist"

    def test_find_binaries_uses_correct_parent_count(self):
        """find_binaries_dir should use exactly 4 parent calls, not 5."""
        from pathlib import Path

        import src.services.plannotate as pm

        module_file = Path(pm.__file__)

        four_parents = module_file.parent.parent.parent.parent
        five_parents = module_file.parent.parent.parent.parent.parent

        assert (
            four_parents.name == "apps"
        ), f"4 parents = {four_parents.name}, expected 'apps'"

        assert five_parents.name != "apps", "5 parents should NOT be 'apps'"


class TestPlannotateFragmentMetadata:
    """Tests for fragment metadata (reference positions, length, db source).

    pLannotate hits can be partial matches (fragments) of reference features.
    We need to expose the reference positions and length to display things like:
    - "aa 1-50 of 150" for protein fragments
    - Whether the hit is from a protein (AA) or nucleotide database
    """

    PUC19_SEQUENCE = TestPlannotateAnnotationIntegration.PUC19_SEQUENCE

    @pytest.fixture
    def service(self):
        from src.services.plannotate import PlannotateService

        return PlannotateService()

    @pytest.fixture
    def skip_if_no_databases(self, service):
        """Skip test if pLannotate databases are not available."""
        status = service.get_database_status()
        if not status["plannotate_available"]:
            pytest.skip("pLannotate library not installed")

        if not status["downloaded"]:
            pytest.skip("Annotation databases not downloaded")

        missing = [k for k, v in status["binaries"].items() if v is None]
        if missing:
            pytest.skip(f"Missing binaries: {', '.join(missing)}")

    @pytest.mark.asyncio
    async def test_features_include_reference_positions(
        self, service, skip_if_no_databases
    ):
        """Features must include reference start/end positions for fragment display."""
        result = await service.annotate(AnnotationRequest(sequence=self.PUC19_SEQUENCE))

        assert result.error is None, f"Annotation failed: {result.error}"
        assert len(result.features) > 0, "No features found"

        for feature in result.features:
            assert feature.ref_start >= 1, f"ref_start should be >= 1: {feature}"
            assert (
                feature.ref_end >= feature.ref_start
            ), f"ref_end < ref_start: {feature}"
            assert (
                feature.ref_length >= feature.ref_end
            ), f"ref_length < ref_end: {feature}"

    @pytest.mark.asyncio
    async def test_features_include_db_source(self, service, skip_if_no_databases):
        """Features must include db_source indicating protein (AA) vs nucleotide search."""
        result = await service.annotate(AnnotationRequest(sequence=self.PUC19_SEQUENCE))

        assert result.error is None, f"Annotation failed: {result.error}"
        assert len(result.features) > 0, "No features found"

        for feature in result.features:
            assert feature.db_source in (
                "protein",
                "nucleotide",
                "rna",
            ), f"Invalid db_source '{feature.db_source}' in feature: {feature.name}"

    @pytest.mark.asyncio
    async def test_fragment_coverage_matches_ref_positions(
        self, service, skip_if_no_databases
    ):
        """Coverage percentage should be derivable from ref positions and length.

        Coverage = (ref_end - ref_start + 1) / ref_length * 100
        Allow some tolerance for rounding.
        """
        result = await service.annotate(AnnotationRequest(sequence=self.PUC19_SEQUENCE))

        assert result.error is None, f"Annotation failed: {result.error}"
        assert len(result.features) > 0, "No features found"

        for feature in result.features:
            if feature.ref_length > 0:
                match_len = feature.ref_end - feature.ref_start + 1
                expected_coverage = (match_len / feature.ref_length) * 100

                actual_coverage = feature.coverage
                diff = abs(actual_coverage - expected_coverage)
                assert diff < 5, (
                    f"Coverage mismatch for {feature.name}: "
                    f"expected ~{expected_coverage:.1f}%, got {actual_coverage:.1f}%"
                )


class TestFindBinariesDirWithToolsDir:
    """Test that find_binaries_dir() checks runtime tools dir (A-7)."""

    def test_tools_dir_takes_priority_over_dev(self, tmp_path):
        """Tools dir (step 2) should be checked before dev binaries (step 3)."""
        from src.services.plannotate import find_binaries_dir

        tools_dir = tmp_path / "tools"
        tools_dir.mkdir()
        for name in ["blastn", "diamond", "cmscan"]:
            f = tools_dir / name
            f.write_bytes(b"\x00" * 100)

        with (
            patch.dict(os.environ, {}, clear=False),
            patch("src.annotation.tools.get_tools_dir", return_value=tools_dir),
            patch(
                "src.annotation.tools.validate_tools",
                return_value={
                    "blastn": True,
                    "diamond": True,
                    "cmscan": True,
                    "makeblastdb": True,
                },
            ),
        ):
            os.environ.pop("WAYPOINT_BINARIES_PATH", None)
            result = find_binaries_dir()
            assert result == tools_dir

    def test_requires_all_tools_present(self, tmp_path):
        """Partial tools should NOT match — all() not any()."""
        from src.services.plannotate import find_binaries_dir

        tools_dir = tmp_path / "tools"
        tools_dir.mkdir()

        with (
            patch.dict(os.environ, {}, clear=False),
            patch("src.annotation.tools.get_tools_dir", return_value=tools_dir),
            patch(
                "src.annotation.tools.validate_tools",
                return_value={
                    "blastn": True,
                    "diamond": True,
                    "cmscan": False,
                    "makeblastdb": True,
                },
            ),
        ):
            os.environ.pop("WAYPOINT_BINARIES_PATH", None)
            result = find_binaries_dir()
            assert result != tools_dir

    def test_falls_through_when_tools_missing(self, tmp_path):
        """When tools dir has no valid tools, should fall through to dev dir."""
        from src.services.plannotate import find_binaries_dir

        tools_dir = tmp_path / "tools"
        tools_dir.mkdir()

        with (
            patch.dict(os.environ, {}, clear=False),
            patch("src.annotation.tools.get_tools_dir", return_value=tools_dir),
            patch(
                "src.annotation.tools.validate_tools",
                return_value={
                    "blastn": False,
                    "diamond": False,
                    "cmscan": False,
                    "makeblastdb": False,
                },
            ),
        ):
            os.environ.pop("WAYPOINT_BINARIES_PATH", None)
            result = find_binaries_dir()
            assert result != tools_dir


class TestGetBinaryPathUnsuffixed:
    """Test that get_binary_path() finds unsuffixed binaries (A-8)."""

    def test_finds_unsuffixed_binary(self, tmp_path):
        from src.services.plannotate import get_binary_path

        binary = tmp_path / "blastn"
        binary.write_bytes(b"\x00" * 100)
        result = get_binary_path("blastn", tmp_path)
        assert result == str(binary)

    def test_suffixed_takes_priority(self, tmp_path):
        from src.services.plannotate import (
            get_binary_path,
            get_platform_suffix,
        )

        suffix = get_platform_suffix()
        suffixed = tmp_path / f"blastn-{suffix}"
        suffixed.write_bytes(b"\x00" * 100)
        unsuffixed = tmp_path / "blastn"
        unsuffixed.write_bytes(b"\x00" * 50)

        result = get_binary_path("blastn", tmp_path)
        assert result == str(suffixed)

    def test_rejects_zero_byte_unsuffixed(self, tmp_path):
        from src.services.plannotate import get_binary_path

        binary = tmp_path / "blastn"
        binary.touch()
        result = get_binary_path("blastn", tmp_path)
        assert result is None


class TestBinariesDirLazyResolve:
    """Test that PlannotateService re-resolves _binaries_dir if initially None.

    Bug: __init__() caches find_binaries_dir() at import time. If ensure_tools()
    hasn't finished, the cached value is None. Downloaded tools are never found.
    Fix: Lazy re-resolve in annotate() when _binaries_dir is None.
    """

    @pytest.mark.asyncio
    async def test_lazy_resolve_when_none(self):
        """annotate() should re-resolve _binaries_dir if it was None at init."""
        from src.services.plannotate import PlannotateService

        service = PlannotateService()
        service._binaries_dir = None

        fake_dir = Path("/tmp/fake_tools_dir")
        with (
            patch.object(service, "_plannotate_available", True),
            patch(
                "src.services.plannotate.find_binaries_dir",
                return_value=fake_dir,
            ) as mock_find,
            patch(
                "src.services.plannotate.check_required_binaries",
                return_value={
                    "blastn": "/bin/blastn",
                    "diamond": "/bin/diamond",
                    "cmscan": "/bin/cmscan",
                },
            ),
            patch.object(service, "_run_plannotate", return_value=[]),
        ):
            await service.annotate(AnnotationRequest(sequence="ATCGATCG"))
            mock_find.assert_called_once()
            assert service._binaries_dir == fake_dir

    @pytest.mark.asyncio
    async def test_no_re_resolve_when_already_set(self):
        """annotate() should NOT re-resolve if _binaries_dir is already set."""
        from src.services.plannotate import PlannotateService

        service = PlannotateService()
        existing_dir = Path("/existing/binaries")
        service._binaries_dir = existing_dir

        with (
            patch.object(service, "_plannotate_available", True),
            patch(
                "src.services.plannotate.find_binaries_dir",
            ) as mock_find,
            patch(
                "src.services.plannotate.check_required_binaries",
                return_value={
                    "blastn": "/bin/blastn",
                    "diamond": "/bin/diamond",
                    "cmscan": "/bin/cmscan",
                },
            ),
            patch.object(service, "_run_plannotate", return_value=[]),
        ):
            await service.annotate(AnnotationRequest(sequence="ATCGATCG"))
            mock_find.assert_not_called()
            assert service._binaries_dir == existing_dir


class TestContextualToolError:
    """Test contextual error when tools are downloading (A-10)."""

    @pytest.mark.asyncio
    async def test_downloading_tools_error_message(self):
        from src.services.plannotate import PlannotateService

        svc = PlannotateService()

        with (
            patch.object(svc, "_plannotate_available", True),
            patch(
                "src.services.plannotate.check_required_binaries",
                return_value={"blastn": None, "diamond": None, "cmscan": None},
            ),
            patch("src.annotation.tools.is_downloading_tools", return_value=True),
        ):
            result = await svc.annotate(AnnotationRequest(sequence="ATCG"))
            assert "being installed" in result.error
