"""Managed annotation routes share one real owner across short-lived clients."""

import asyncio
import os
import threading
import time
from contextlib import asynccontextmanager
from uuid import uuid4

import pytest
from dnaforge_annotation.identity import annotation_input_revision
from fastapi import FastAPI

from src.annotation_operation_contract import AnnotationSubmission
from src.control_plane import ControlPlaneStore
from src.operations import (
    ManagedOperationKindAdapter,
    ManagedOperationService,
    OperationKind,
)
from src.recorded_annotation_operations import (
    RecordedAnnotationImport,
    prepare_recorded_annotation_import,
)
from src.routes.operations import operation_scope_id, router
from src.security.local_access import LocalAccessMiddleware
from src.services.plannotate import AnnotationRequest, AnnotationResult
from tests.managed_operation_kinds import MANAGED_OPERATION_KINDS
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient


def test_stream_contract_exports_event_data_models_without_claiming_a_json_response():
    app = FastAPI()
    app.include_router(router)
    schema = app.openapi()
    content = schema["paths"]["/operations/events"]["get"]["responses"]["200"][
        "content"
    ]
    assert set(content) == {"text/event-stream"}
    assert content["text/event-stream"]["schema"] == {"type": "string"}
    models = schema["components"]["schemas"]
    assert "history_complete" in models["OperationInitial"]["required"]
    assert "operation_count" in models["OperationEvent"]["properties"]
    executable = models["ExecutableOperationKindDescription"]
    history_only = models["HistoryOnlyOperationKindDescription"]
    assert set(executable["properties"]["kind"]["enum"]) == MANAGED_OPERATION_KINDS
    assert executable["properties"]["registration"]["const"] == "executable"
    assert executable["properties"]["executable"]["const"] is True
    assert history_only["properties"]["registration"]["const"] == "history_only"
    assert history_only["properties"]["executable"]["const"] is False
    assert models["OperationKindDescription"]["discriminator"]["propertyName"] == (
        "registration"
    )


def test_action_coverage_and_sanitized_validation_are_declared_in_openapi():
    app = FastAPI()
    app.include_router(router)
    schema = app.openapi()
    action_page = schema["components"]["schemas"]["OperationActionPage"]
    assert {"omitted_count", "history_complete"} <= set(action_page["required"])
    validation_response = schema["paths"]["/operations/annotation/import-recorded"][
        "post"
    ]["responses"]["422"]["content"]["application/json"]["schema"]
    assert validation_response == {
        "$ref": "#/components/schemas/OperationValidationErrorResponse"
    }
    validation_model = schema["components"]["schemas"][
        "OperationValidationErrorResponse"
    ]
    assert validation_model["required"] == ["detail"]


def test_operation_scope_fallback_isolated_startup_only_sidecars(monkeypatch):
    monkeypatch.delenv("DNAFORGE_OPERATION_SCOPE", raising=False)
    monkeypatch.delenv("DNAFORGE_SIDECAR_ENVIRONMENT_ID", raising=False)
    monkeypatch.delenv("DNAFORGE_HUMAN_OPERATION_TOKEN", raising=False)
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "private-launch-token-a")

    first_scope = operation_scope_id()
    assert first_scope.startswith("local-session-")
    assert "private-launch-token-a" not in first_scope
    assert operation_scope_id() == first_scope

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "private-launch-token-b")
    assert operation_scope_id() != first_scope

    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", "human-operation-secret")
    assert operation_scope_id() == "local-runtime"

    monkeypatch.setenv("DNAFORGE_SIDECAR_ENVIRONMENT_ID", "packaged-profile")
    assert operation_scope_id() == "packaged-profile"

    monkeypatch.setenv("DNAFORGE_OPERATION_SCOPE", "explicit-operation-scope")
    assert operation_scope_id() == "explicit-operation-scope"

    monkeypatch.delenv("DNAFORGE_OPERATION_SCOPE")
    monkeypatch.delenv("DNAFORGE_SIDECAR_ENVIRONMENT_ID")
    monkeypatch.delenv("DNAFORGE_HUMAN_OPERATION_TOKEN")
    monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN")
    assert operation_scope_id() == f"local-process-{os.getpid()}"


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", "human-operation-secret")
    monkeypatch.setenv("DNAFORGE_OPERATION_SCOPE", "runtime-test")
    monkeypatch.setenv("DNAFORGE_OPERATION_OWNER_ID", "local-human")
    entered = threading.Event()
    release = threading.Event()
    calls = []

    async def execute(value, _cancel):
        def physical():
            calls.append(value.sequence)
            entered.set()
            release.wait(timeout=5)
            return AnnotationResult(features=[], sequence_length=len(value.sequence))

        return await asyncio.to_thread(physical)

    @asynccontextmanager
    async def lifespan(app):
        store = ControlPlaneStore(tmp_path / "operations.sqlite3")
        store.initialize()
        service = ManagedOperationService(
            store=store,
            runtime_scope="runtime-test",
            adapters=(
                ManagedOperationKindAdapter(
                    kind=OperationKind.ANNOTATION,
                    title="Annotate sequence",
                    input_model=AnnotationRequest,
                    result_model=AnnotationResult,
                    executor=execute,
                    submission_model=AnnotationSubmission,
                    recorded_import_model=RecordedAnnotationImport,
                    recorded_import_preparer=prepare_recorded_annotation_import,
                    required_start_capabilities=frozenset({"operations.start"}),
                    required_import_capabilities=frozenset({"operations.import"}),
                ),
            ),
        )
        app.state.managed_operations = service
        try:
            yield
        finally:
            release.set()
            await service.aclose()
            app.state.managed_operations = None
            store.close()

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(LocalAccessMiddleware)
    app.include_router(router)
    with TestClient(app) as client:
        client.headers["X-DNAForge-Operation-Authority"] = "human-operation-secret"
        yield client, entered, release, calls


def request(key="request-1"):
    return {
        "submission_key": key,
        "subject": {"scope_id": "runtime-test", "subject_id": "sequence-a"},
        "input": {"sequence": "ACGT"},
    }


def recorded_request():
    annotation_request = AnnotationRequest(sequence="ACGT", linear=True)
    return {
        "subject": {"scope_id": "runtime-test", "subject_id": "sequence-a"},
        "receipt": {
            "schema_version": 1,
            "run_id": str(uuid4()),
            "tool": {"name": "dnaforge-annotation", "version": "0.1.0"},
            "outcome": "succeeded",
            "started_at": "2026-09-09T12:00:00+00:00",
            "finished_at": "2026-09-09T12:01:00+00:00",
            "input": {
                "path": "-",
                "sequence_id": "sample",
                "sequence_length": 4,
                "revision": annotation_input_revision(annotation_request),
            },
            "output": {"format": "json", "path": "-"},
            "request": annotation_request.model_dump(mode="json"),
            "runtime": {
                "data_dir": "/reported/data",
                "executables": {
                    "blastn": "/reported/blastn",
                    "diamond": "/reported/diamond",
                    "cmscan": "/reported/cmscan",
                },
                "temp_dir": None,
                "threads": 1,
                "database_config": None,
            },
            "reference_data": {
                "manifest": "/reported/databases.yml",
                "versions": {"snapgene": None},
            },
            "result": {"features": [], "sequence_length": 4, "error": None},
        },
    }


def test_start_list_and_stop_share_identity_without_a_long_lived_submitter(runtime):
    client, entered, release, calls = runtime
    started = client.post("/operations/annotation", json=request())
    assert started.status_code == 202, started.text
    operation_id = started.json()["id"]
    assert entered.wait(timeout=1)
    duplicate = client.post("/operations/annotation", json=request())
    assert duplicate.json()["id"] == operation_id
    listed = client.get("/operations", params={"scope_id": "runtime-test"})
    assert listed.json()["operations"][0]["id"] == operation_id
    assert listed.json()["total"] == 1
    assert listed.json()["next_offset"] is None
    stopped = client.post(f"/operations/{operation_id}/cancel", json={})
    assert stopped.status_code == 200
    assert stopped.json()["disposition"] == "unavailable"
    assert stopped.json()["snapshot"]["state"] == "running"
    assert stopped.json()["reason"]
    assert calls == ["ACGT"]
    release.set()


def test_list_pagination_does_not_claim_a_full_final_page_has_more(runtime):
    client, _entered, release, _calls = runtime
    started = client.post("/operations/annotation", json=request())
    assert started.status_code == 202

    exact = client.get(
        "/operations",
        params={"scope_id": "runtime-test", "limit": 1, "offset": 0},
    )
    assert exact.status_code == 200
    assert exact.json()["total"] == 1
    assert exact.json()["next_offset"] is None

    release.set()


def test_wire_payload_cannot_forge_actor_or_authority(runtime):
    client, _entered, _release, calls = runtime
    body = request()
    body["actor_kind"] = "human"
    body["actor_id"] = "someone-else"
    assert client.post("/operations/annotation", json=body).status_code == 422
    body = request()
    body["subject"]["scope_id"] = "foreign"
    assert client.post("/operations/annotation", json=body).status_code == 403
    assert calls == []


def test_catalog_comes_from_the_runtime_registered_contracts(runtime):
    client, _entered, _release, calls = runtime
    response = client.get("/operations/catalog")
    assert response.status_code == 200
    catalog = response.json()
    assert catalog["scope_id"] == "runtime-test"
    annotation = next(kind for kind in catalog["kinds"] if kind["kind"] == "annotation")
    assert {kind["kind"] for kind in catalog["kinds"]} == {"annotation"}
    assert annotation["input_schema"] == AnnotationSubmission.model_json_schema()
    assert (
        annotation["recorded_import_schema"]
        == RecordedAnnotationImport.model_json_schema()
    )
    assert "import_recorded" in annotation["actions"]
    assert "release_result" in annotation["actions"]
    assert annotation["contract_version"] == 1
    assert annotation["result_schema_version"] == 1
    assert annotation["start_capabilities"]
    assert annotation["recorded_import_capabilities"]
    assert annotation["executable"] is True
    assert annotation["surfaces"] == {
        "http_start": "/operations/annotation",
        "http_import_recorded": "/operations/annotation/import-recorded",
        "cli_submit": "dnaforge jobs submit annotation --request FILE|-",
        "cli_import_recorded": (
            "dnaforge jobs import-recorded annotation --request FILE|-"
        ),
        "agent_start": "operations.annotation.start",
        "agent_import_recorded": "operations.annotation.import_recorded",
    }
    assert calls == []


def test_recorded_success_import_is_immediately_available_and_has_action_history(
    runtime,
):
    client, _entered, _release, calls = runtime
    body = recorded_request()
    imported = client.post("/operations/annotation/import-recorded", json=body)
    assert imported.status_code == 200, imported.text
    snapshot = imported.json()
    assert snapshot["origin"] == "recorded"
    assert snapshot["state"] == "succeeded"
    assert snapshot["started_at"] is None
    assert snapshot["provenance"]["reported_run_id"] == body["receipt"]["run_id"]
    result = client.get(f"/operations/{snapshot['id']}/result")
    assert result.json()["status"] == "available"
    actions = client.get(f"/operations/{snapshot['id']}/actions", params={"limit": 1})
    assert actions.status_code == 200
    assert actions.json()["actions"][0]["outcome"] == "imported"
    assert actions.json()["total"] == 1
    assert actions.json()["next_offset"] is None
    assert actions.json()["omitted_count"] == 0
    assert actions.json()["history_complete"] is True
    assert calls == []


def test_invalid_recorded_receipt_does_not_echo_source_sequence(runtime):
    client, _entered, _release, calls = runtime
    marker = "PRIVATE-INVALID-RECEIPT-SEQUENCE-MARKER"
    body = recorded_request()
    body["receipt"]["request"]["sequence"] = marker

    response = client.post("/operations/annotation/import-recorded", json=body)

    assert response.status_code == 422
    assert response.json() == {
        "detail": {
            "code": "INVALID_OPERATION_REQUEST",
            "message": "The operation request is invalid.",
        }
    }
    assert marker not in response.text
    assert calls == []


def test_invalid_recorded_receipt_does_not_bypass_operation_authority(runtime):
    client, _entered, _release, calls = runtime
    marker = "PRIVATE-UNAUTHORIZED-INVALID-RECEIPT-MARKER"
    body = recorded_request()
    body["receipt"]["request"]["sequence"] = marker

    response = client.post(
        "/operations/annotation/import-recorded",
        json=body,
        headers={"X-DNAForge-Operation-Authority": "wrong-authority"},
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "OPERATION_AUTHORITY_REQUIRED"
    assert marker not in response.text
    assert calls == []


def test_release_result_is_explicit_and_idempotent(runtime):
    client, entered, release, _calls = runtime
    started = client.post("/operations/annotation", json=request())
    assert started.status_code == 202
    operation_id = started.json()["id"]
    assert entered.wait(timeout=1)
    release.set()
    for _ in range(100):
        result = client.get(f"/operations/{operation_id}/result")
        if result.json()["status"] == "available":
            break
        time.sleep(0.005)
    assert result.json()["status"] == "available"

    released = client.post(f"/operations/{operation_id}/release-result", json={})
    assert released.status_code == 200
    assert released.json()["disposition"] == "released"
    assert released.json()["snapshot"]["result_status"] == "released"
    assert (
        client.get(f"/operations/{operation_id}/result").json()["status"] == "released"
    )

    duplicate = client.post(f"/operations/{operation_id}/release-result", json={})
    assert duplicate.status_code == 200
    assert duplicate.json()["disposition"] == "already_released"


def test_owner_derives_revision_and_rejects_a_forged_revision(runtime):
    client, entered, release, _calls = runtime
    body = request()
    body["subject"].pop("input_revision", None)
    started = client.post("/operations/annotation", json=body)
    assert started.status_code == 202, started.text
    revision = started.json()["subject"]["input_revision"]
    assert revision.startswith("annotation-input-v1:sha256:")
    assert entered.wait(timeout=1)
    forged = request("forged-revision")
    forged["subject"]["input_revision"] = "sha256:not-the-input"
    refused = client.post("/operations/annotation", json=forged)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["code"] == "INPUT_REVISION_MISMATCH"
    release.set()
