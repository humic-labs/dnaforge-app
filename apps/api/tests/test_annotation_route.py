""": one validated definition for the annotation request and result.

``AnnotationRequest`` / ``AnnotationResult`` own the wire contract. These tests
drive the real FastAPI route, the real session middleware, and the real
``PlannotateService.annotate`` implementation; only the engine call and its
readiness probes are substituted so no database, binary, or network is needed.
"""

from pathlib import Path

import pytest

from src.main import app
from src.services import registry
from src.services.plannotate import (
    PLANNOTATE_SERVICE_NAME,
    AnnotationFeature,
    AnnotationRequest,
    PlannotateService,
)
from tests.conftest import anonymous_client
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient

FEATURE = {
    "name": "cat",
    "accession": "P62577",
    "start": 11,
    "end": 20,
    "strand": 1,
    "identity": 100.0,
    "coverage": 50.0,
    "fragment": True,
    "type": "CDS",
    "description": "chloramphenicol acetyltransferase",
    "ref_start": 5,
    "ref_end": 14,
    "ref_length": 219,
    "db_source": "protein",
}


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def ready_engine(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Report the registered service ready and record engine calls.

    Returns the list of ``{"sequence", "linear"}`` calls the engine received.
    The engine answers with one fixed feature at subrange-local coordinates so
    the offset arithmetic is observable through the real route.
    """
    import src.services.plannotate as pm

    service = registry.get(PLANNOTATE_SERVICE_NAME)
    assert isinstance(service, PlannotateService)
    calls: list[dict] = []

    async def fake_run(sequence: str, linear: bool) -> list[AnnotationFeature]:
        calls.append({"sequence": sequence, "linear": linear})
        return [AnnotationFeature(**FEATURE)]

    monkeypatch.setattr(service, "_plannotate_available", True)
    monkeypatch.setattr(service, "_binaries_dir", Path("/x"))
    monkeypatch.setattr(service, "get_database_status", lambda: {"downloaded": True})
    monkeypatch.setattr(
        pm, "check_required_binaries", lambda *_a, **_k: {"blastn": "/b"}
    )
    monkeypatch.setattr(
        "src.annotation.setup.is_annotation_provisioning", lambda: False
    )
    monkeypatch.setattr("src.annotation.setup.is_rfam_runtime_ready", lambda: True)
    monkeypatch.setattr(service, "_run_plannotate", fake_run)
    return calls


class TestValidRequests:
    def test_valid_request_returns_exactly_the_validated_result(
        self, client, ready_engine
    ):
        response = client.post(
            "/annotation", json={"sequence": "acgt " * 25 + "\n", "linear": True}
        )

        assert response.status_code == 200
        assert response.json() == {"features": [FEATURE], "sequence_length": 100}
        assert ready_engine == [{"sequence": "ACGT" * 25, "linear": True}]

    def test_explicit_empty_sequence_is_a_valid_empty_result(
        self, client, ready_engine
    ):
        response = client.post("/annotation", json={"sequence": ""})

        assert response.status_code == 200
        assert response.json() == {"features": [], "sequence_length": 0}
        assert ready_engine == []

    def test_subrange_offsets_query_coordinates_through_the_route(
        self, client, ready_engine
    ):
        response = client.post(
            "/annotation", json={"sequence": "ACGT" * 100, "start": 100, "end": 200}
        )

        assert response.status_code == 200
        body = response.json()
        assert body["sequence_length"] == 400
        assert body["features"] == [{**FEATURE, "start": 111, "end": 120}]
        assert ready_engine == [{"sequence": ("ACGT" * 100)[100:200], "linear": True}]

    def test_readiness_failure_keeps_the_error_field_presentation(
        self, client, ready_engine, monkeypatch
    ):
        monkeypatch.setattr(
            "src.annotation.setup.is_annotation_provisioning", lambda: True
        )

        response = client.post("/annotation", json={"sequence": "ACGT"})

        assert response.status_code == 200
        assert response.json() == {
            "features": [],
            "sequence_length": 4,
            "error": (
                "Annotation databases are downloading or being prepared. "
                "This may take a few minutes."
            ),
        }
        assert ready_engine == []


class TestEngineAndReadinessFailuresKeepTheErrorField:
    def test_engine_exception_is_presented_in_the_error_field(
        self, client, ready_engine, monkeypatch
    ):
        service = registry.get(PLANNOTATE_SERVICE_NAME)

        async def boom(sequence, linear):
            raise RuntimeError("cmscan crashed")

        monkeypatch.setattr(service, "_run_plannotate", boom)

        response = client.post("/annotation", json={"sequence": "ACGT"})

        assert response.status_code == 200
        assert response.json() == {
            "features": [],
            "sequence_length": 4,
            "error": "cmscan crashed",
        }

    def test_engine_exception_without_a_message_still_reports_a_failure(
        self, client, ready_engine, monkeypatch
    ):
        """An empty error string would read as success on the desktop."""
        service = registry.get(PLANNOTATE_SERVICE_NAME)

        async def silent(sequence, linear):
            raise ValueError()

        monkeypatch.setattr(service, "_run_plannotate", silent)

        response = client.post("/annotation", json={"sequence": "ACGT"})

        assert response.status_code == 200
        assert response.json()["features"] == []
        assert response.json()["error"] == (
            "Annotation failed without a message from the engine."
        )

    def test_missing_system_tool_keeps_its_settings_pointer(
        self, client, ready_engine, monkeypatch
    ):
        service = registry.get(PLANNOTATE_SERVICE_NAME)

        async def missing(sequence, linear):
            raise FileNotFoundError("[Errno 2] No such file or directory: 'blastn'")

        monkeypatch.setattr(service, "_run_plannotate", missing)

        response = client.post("/annotation", json={"sequence": "ACGT"})

        assert response.status_code == 200
        assert response.json()["error"] == (
            "Missing system tool: blastn. Check the Annotation Engine section in Settings."
        )

    def test_malformed_engine_row_is_a_reported_failure_not_a_partial_feature(
        self, client, ready_engine, monkeypatch
    ):
        service = registry.get(PLANNOTATE_SERVICE_NAME)

        async def half_row(sequence, linear):
            return [{"name": "x", "start": 1}]

        monkeypatch.setattr(service, "_run_plannotate", half_row)

        response = client.post("/annotation", json={"sequence": "ACGT"})

        assert response.status_code == 200
        body = response.json()
        assert body["features"] == []
        assert "validation error" in body["error"]

    def test_missing_tools_message_points_at_settings(
        self, client, ready_engine, monkeypatch
    ):
        import src.services.plannotate as pm

        monkeypatch.setattr(
            pm,
            "check_required_binaries",
            lambda *_a, **_k: {"blastn": None, "diamond": "/d"},
        )
        monkeypatch.setattr("src.annotation.tools.is_downloading_tools", lambda: False)

        response = client.post("/annotation", json={"sequence": "ACGT"})

        assert response.status_code == 200
        assert response.json()["error"] == (
            "Missing required tools: blastn. Check the Annotation Engine section in Settings."
        )
        assert ready_engine == []

    def test_whitespace_only_sequence_is_a_valid_empty_run(self, client, ready_engine):
        response = client.post("/annotation", json={"sequence": "  \n \n"})

        assert response.status_code == 200
        assert response.json() == {"features": [], "sequence_length": 0}
        assert ready_engine == []


class TestEngineIsSingleFlight:
    @pytest.mark.asyncio
    async def test_canceling_an_awaiter_does_not_release_the_physical_engine(
        self, ready_engine, monkeypatch
    ):
        import asyncio
        import threading

        import src.services.plannotate as pm
        from src.services.plannotate import AnnotationResult

        service = registry.get(PLANNOTATE_SERVICE_NAME)
        entered = threading.Event()
        release = threading.Event()
        calls = []

        def held_engine(request, runtime):
            calls.append(request.sequence)
            if len(calls) == 1:
                entered.set()
                assert release.wait(timeout=5)
            return AnnotationResult(features=[], sequence_length=len(request.sequence))

        monkeypatch.setattr(
            service,
            "_run_plannotate",
            PlannotateService._run_plannotate.__get__(service),
        )
        monkeypatch.setattr(pm, "run_annotation", held_engine)
        monkeypatch.setattr(
            pm,
            "check_required_binaries",
            lambda *_a, **_k: {
                name: f"/{name}" for name in ("blastn", "diamond", "cmscan")
            },
        )
        first = asyncio.create_task(service._run_plannotate("ACGT", True))
        second = None
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            first.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first
            second = asyncio.create_task(service._run_plannotate("GGCC", True))
            await asyncio.sleep(0.04)
            assert calls == ["ACGT"]
            release.set()
            await asyncio.wait_for(second, timeout=2)
            assert calls == ["ACGT", "GGCC"]
        finally:
            release.set()
            await asyncio.gather(
                first, *([second] if second is not None else []), return_exceptions=True
            )

    @pytest.mark.asyncio
    async def test_concurrent_runs_do_not_overlap_in_the_engine(
        self, ready_engine, monkeypatch
    ):
        import asyncio
        import time

        import src.services.plannotate as pm
        from src.services.plannotate import AnnotationRequest, AnnotationResult

        service = registry.get(PLANNOTATE_SERVICE_NAME)
        active = 0
        max_active = 0

        def slow_engine(request, runtime):
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            time.sleep(0.02)
            active -= 1
            return AnnotationResult(
                features=[AnnotationFeature(**FEATURE)],
                sequence_length=len(request.sequence),
            )

        monkeypatch.setattr(
            service,
            "_run_plannotate",
            PlannotateService._run_plannotate.__get__(service),
        )
        monkeypatch.setattr(pm, "run_annotation", slow_engine)
        monkeypatch.setattr(
            pm,
            "check_required_binaries",
            lambda *_a, **_k: {
                name: f"/{name}" for name in ("blastn", "diamond", "cmscan")
            },
        )

        results = await asyncio.gather(
            *(
                service.annotate(AnnotationRequest(sequence="ACGT" * 10))
                for _ in range(4)
            )
        )

        assert max_active == 1
        assert all(len(r.features) == 1 for r in results)


class TestMalformedRequestsAreRejectedBeforeComputation:
    def test_missing_sequence_is_rejected(self, client, ready_engine):
        response = client.post("/annotation", json={})

        assert response.status_code == 422
        assert ready_engine == []

    def test_misspelled_sequence_is_rejected_not_treated_as_empty(
        self, client, ready_engine
    ):
        response = client.post("/annotation", json={"sequece": "ACGT"})

        assert response.status_code == 422
        errors = {(tuple(e["loc"]), e["type"]) for e in response.json()["detail"]}
        assert (("body", "sequence"), "missing") in errors
        assert (("body", "sequece"), "extra_forbidden") in errors
        assert ready_engine == []

    @pytest.mark.parametrize(
        "payload",
        [
            {"sequence": 42},
            {"sequence": ["ACGT"]},
            {"sequence": "ACGT", "linear": "sometimes"},
            {"sequence": "ACGT", "start": "ten", "end": 20},
            {"sequence": "ACGT", "start": 1.5, "end": 20},
        ],
    )
    def test_wrong_field_types_are_rejected(self, client, ready_engine, payload):
        response = client.post("/annotation", json=payload)

        assert response.status_code == 422
        assert ready_engine == []

    def test_numeric_strings_still_coerce_for_range_bounds(self, client, ready_engine):
        """Lax coercion of "100" -> 100 matches the previous normalizer behavior."""
        response = client.post(
            "/annotation", json={"sequence": "ACGT" * 100, "start": "100", "end": "200"}
        )

        assert response.status_code == 200
        assert response.json()["features"][0]["start"] == 111


class TestBoundaryOwnership:
    def test_unauthenticated_request_is_refused_before_the_route(self, ready_engine):
        with anonymous_client(app) as client:
            response = client.post("/annotation", json={"sequence": "ACGT"})

        assert response.status_code == 401
        assert ready_engine == []

    def test_managed_owner_refuses_the_untracked_compatibility_route(
        self, client, ready_engine, monkeypatch
    ):
        monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", "human-operation-secret")
        app.state.managed_operations = object()
        try:
            response = client.post("/annotation", json={"sequence": "ACGT"})
        finally:
            app.state.managed_operations = None

        assert response.status_code == 409
        assert response.json()["detail"] == {
            "code": "MANAGED_ANNOTATION_REQUIRED",
            "message": (
                "This runtime owns annotation through /operations/annotation; "
                "the foreground compatibility endpoint is unavailable."
            ),
        }
        assert ready_engine == []

    def test_managed_owner_without_human_authority_keeps_compatibility_route(
        self, client, ready_engine, monkeypatch
    ):
        monkeypatch.delenv("DNAFORGE_HUMAN_OPERATION_TOKEN", raising=False)
        app.state.managed_operations = object()
        try:
            response = client.post("/annotation", json={"sequence": "ACGT"})
        finally:
            app.state.managed_operations = None

        assert response.status_code == 200
        assert response.json() == {"features": [FEATURE], "sequence_length": 4}
        assert ready_engine == [{"sequence": "ACGT", "linear": False}]

    def test_generic_execute_no_longer_forwards_built_in_services(
        self, client, ready_engine
    ):
        response = client.post(
            f"/services/{PLANNOTATE_SERVICE_NAME}/execute", json={"sequence": "ACGT"}
        )

        assert response.status_code == 404
        assert "POST /annotation" in response.json()["detail"]
        assert ready_engine == []

    def test_unregistered_annotation_service_is_a_503(
        self, client, ready_engine, monkeypatch
    ):
        import src.routes.annotation as route_module

        monkeypatch.setattr(route_module.registry, "get", lambda name: None)

        response = client.post("/annotation", json={"sequence": "ACGT"})

        assert response.status_code == 503
        assert response.json()["detail"] == "Annotation service is not registered"
        assert ready_engine == []

    def test_plugin_registered_under_a_built_in_name_is_not_executed(
        self, client, ready_engine
    ):
        from src.plugins.registry import plugin_registry

        plugin_registry.register(
            PLANNOTATE_SERVICE_NAME,
            "http://127.0.0.1:1",
            {"name": PLANNOTATE_SERVICE_NAME, "input_types": {}, "return_types": {}},
        )
        try:
            response = client.post(
                f"/services/{PLANNOTATE_SERVICE_NAME}/execute",
                json={"sequence": "ACGT"},
            )
        finally:
            plugin_registry.unregister(PLANNOTATE_SERVICE_NAME)

        assert response.status_code == 404
        assert "POST /annotation" in response.json()["detail"]
        assert ready_engine == []

    def test_request_model_is_the_only_definition(self):
        assert AnnotationRequest.model_fields["sequence"].is_required()
        assert AnnotationRequest.model_config["extra"] == "forbid"
        assert AnnotationRequest(sequence="").sequence == ""
        with pytest.raises(ValueError):
            AnnotationRequest.model_validate({"sequece": "ACGT"})


class TestExportedContract:
    def test_openapi_declares_the_annotation_contract(self):
        spec = app.openapi()
        operation = spec["paths"]["/annotation"]["post"]
        request_schema = operation["requestBody"]["content"]["application/json"][
            "schema"
        ]
        response_schema = operation["responses"]["200"]["content"]["application/json"][
            "schema"
        ]
        assert request_schema == {"$ref": "#/components/schemas/AnnotationRequest"}
        assert response_schema == {"$ref": "#/components/schemas/AnnotationResult"}

        components = spec["components"]["schemas"]
        assert components["AnnotationRequest"]["required"] == ["sequence"]
        assert components["AnnotationRequest"]["additionalProperties"] is False
        assert components["AnnotationResult"]["properties"]["features"]["items"] == {
            "$ref": "#/components/schemas/AnnotationFeature"
        }
        assert components["AnnotationFeature"]["properties"]["db_source"]["enum"] == [
            "protein",
            "nucleotide",
            "rna",
        ]

    def test_generic_execute_stays_an_explicit_open_plugin_payload(self):
        spec = app.openapi()
        operation = spec["paths"]["/services/{name}/execute"]["post"]
        assert "plugin" in operation["description"].lower()
        request_schema = operation["requestBody"]["content"]["application/json"][
            "schema"
        ]
        assert request_schema["additionalProperties"] is True

    def test_service_listing_is_derived_from_the_models(self, client):
        response = client.get("/services/")

        assert response.status_code == 200
        listed = {entry["name"]: entry for entry in response.json()["services"]}
        schema = listed[PLANNOTATE_SERVICE_NAME]
        assert schema["input_types"]["sequence"]["type"] == "string"
        assert schema["input_types"]["sequence"]["required"] is True
        assert schema["input_types"]["start"]["type"] == "integer"
        assert schema["input_types"]["start"]["required"] is False
        assert schema["return_types"]["features"]["type"] == "array"
        assert schema["return_types"]["features"]["items"]["properties"]["db_source"][
            "enum"
        ] == [
            "protein",
            "nucleotide",
            "rna",
        ]
        assert schema["return_types"]["error"]["required"] is False
