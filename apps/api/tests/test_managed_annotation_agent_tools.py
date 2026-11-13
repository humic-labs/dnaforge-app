from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from functools import partial

import httpx
import pytest
from dnaforge_annotation.contract import AnnotationRequest, AnnotationResult
from dnaforge_annotation.identity import annotation_input_revision

from src.annotation_operation_contract import (
    AnnotationSubmission,
    prepare_annotation_submission,
)
from src.capability_policy import MANAGED_OPERATION_CAPABILITIES
from src.concurrency import register_builtin_agent_tools
from src.concurrency.job_manager import get_job_manager, reset_job_manager
from src.concurrency.pools import reset_pool_manager
from src.concurrency.tool_registry import agent_tool_registry
from src.control_plane import ControlPlaneStore, initialize_control_plane
from src.main import app
from src.managed_annotation_agent_tools import MANAGED_ANNOTATION_TOOL_NAMES
from src.operation_agent_authority import validate_operation_principal
from src.operations import (
    ActorKind,
    ClientChannel,
    ManagedOperationKindAdapter,
    ManagedOperationService,
    OperationKind,
    OperationPrincipal,
)
from src.recorded_annotation_operations import (
    RecordedAnnotationImport,
    prepare_recorded_annotation_import,
)
from src.routes.agent_grants import ALLOWED_API_KEY_SCOPES
from src.routes.mcp_auth import MANAGED_IN_APP_AGENT_IDENTITY, bootstrap_session_grant

MCP_TOKEN = "managed-operation-agent-token"
RUNTIME_SCOPE = "runtime-environment-a"
AGENT_ID = "managed-operation-agent"
OWNER_ID = "local-human"


def _submission(*, key: str = "submission-a", sequence: str = "ATGC") -> dict:
    return {
        "submission_key": key,
        "subject": {
            "scope_id": RUNTIME_SCOPE,
            "subject_id": "sequence-a",
        },
        "input": {"sequence": sequence, "linear": True},
    }


def _recorded_import(
    *,
    sequence: str = "PRIVATE-RECORDED-ACGT",
    feature_name: str | None = None,
) -> dict:
    request = AnnotationRequest(sequence=sequence, linear=True)
    features = []
    if feature_name is not None:
        features.append(
            {
                "name": feature_name,
                "accession": "reported-accession",
                "start": 1,
                "end": len(sequence),
                "strand": 1,
                "identity": 99.0,
                "coverage": 100.0,
                "fragment": False,
                "type": "misc_feature",
                "description": "reported result",
                "ref_start": 1,
                "ref_end": len(sequence),
                "ref_length": len(sequence),
                "db_source": "nucleotide",
            }
        )
    return {
        "subject": {"scope_id": RUNTIME_SCOPE, "subject_id": "sequence-a"},
        "receipt": {
            "schema_version": 1,
            "run_id": "0199305d-5d20-7000-8000-000000000001",
            "tool": {"name": "dnaforge-annotation", "version": "0.1.0"},
            "outcome": "succeeded",
            "started_at": "2026-09-09T12:00:00+00:00",
            "finished_at": "2026-09-09T12:01:00+00:00",
            "input": {
                "path": "-",
                "sequence_id": "sample",
                "sequence_length": len(sequence),
                "revision": annotation_input_revision(request),
            },
            "output": {"format": "json", "path": "-"},
            "request": request.model_dump(mode="json"),
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
            "result": {
                "features": features,
                "sequence_length": len(sequence),
                "error": None,
            },
        },
    }


def _agent(
    *,
    identity_id: str = AGENT_ID,
    capabilities: frozenset[str] = MANAGED_OPERATION_CAPABILITIES,
) -> OperationPrincipal:
    return OperationPrincipal(
        actor_kind=ActorKind.AGENT,
        actor_id=identity_id,
        channel=ClientChannel.AGENT,
        scope_ids={RUNTIME_SCOPE},
        capabilities=capabilities,
    )


@pytest.fixture
async def managed_runtime(
    tmp_path, monkeypatch
) -> AsyncIterator[tuple[ControlPlaneStore, ManagedOperationService]]:
    db_path = tmp_path / "control.sqlite3"
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(db_path))
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", AGENT_ID)
    monkeypatch.setenv(
        "DNAFORGE_MCP_GRANT_CAPABILITIES",
        ",".join(sorted(MANAGED_OPERATION_CAPABILITIES)),
    )
    monkeypatch.setenv("DNAFORGE_SIDECAR_ENVIRONMENT_ID", RUNTIME_SCOPE)
    store = initialize_control_plane(db_path)
    store.ensure_agent_identity(
        AGENT_ID,
        parent_human_identity_id=OWNER_ID,
        scope=sorted(MANAGED_OPERATION_CAPABILITIES),
        environment_id=RUNTIME_SCOPE,
    )

    async def execute(
        request: AnnotationRequest, _cancel
    ) -> AnnotationResult:  # noqa: ANN001
        await asyncio.sleep(0)
        return AnnotationResult(
            features=[],
            sequence_length=len(request.sequence),
            error=None,
        )

    service = ManagedOperationService(
        store=store,
        runtime_scope=RUNTIME_SCOPE,
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
            ),
        ),
        principal_validator=partial(
            validate_operation_principal,
            store=store,
            runtime_scope=RUNTIME_SCOPE,
            owner_id=OWNER_ID,
        ),
    )
    app.state.managed_operations = service
    agent_tool_registry.clear()
    register_builtin_agent_tools()
    reset_job_manager()
    reset_pool_manager()
    try:
        yield store, service
    finally:
        await service.aclose()
        app.state.managed_operations = None
        agent_tool_registry.clear()
        reset_job_manager()
        reset_pool_manager()


def test_registration_uses_existing_catalog_and_typed_annotation_submission():
    agent_tool_registry.clear()
    register_builtin_agent_tools()
    try:
        registered_names = {tool.spec.name for tool in agent_tool_registry.list()}
        assert MANAGED_ANNOTATION_TOOL_NAMES <= registered_names

        start = agent_tool_registry.require("operations.annotation.start").spec
        assert start.required_capabilities == ["operations.start"]
        assert start.category.cancelable is False
        assert start.category.duration == "immediate"
        assert start.inputs["additionalProperties"] is False
        assert set(start.inputs["required"]) == {"submission_key", "subject", "input"}
        assert "AnnotationRequest" in start.inputs["$defs"]
        assert (
            agent_tool_registry.require("operations.annotation.start").replay_policy
            == "execute"
        )

        assert agent_tool_registry.require(
            "operations.request_cancel"
        ).spec.required_capabilities == ["operations.cancel"]
        assert agent_tool_registry.require(
            "operations.release_result"
        ).spec.required_capabilities == ["operations.release"]
        assert agent_tool_registry.require(
            "operations.annotation.import_recorded"
        ).spec.required_capabilities == ["operations.import"]
        for name in {
            "operations.discover",
            "operations.list",
            "operations.get",
            "operations.result",
            "operations.actions",
        }:
            assert agent_tool_registry.require(name).spec.required_capabilities == [
                "operations.read"
            ]
    finally:
        agent_tool_registry.clear()


@pytest.mark.asyncio
async def test_agent_imports_recorded_success_without_persisting_source_or_claiming_actor(
    managed_runtime,
):
    store, service = managed_runtime
    marker = "PRIVATE-RECORDED-SEQUENCE-MARKER"
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"X-DNAForge-Session": MCP_TOKEN},
    ) as client:
        response = await client.post(
            "/mcp/call",
            json={
                "name": "operations.annotation.import_recorded",
                "arguments": _recorded_import(sequence=marker),
            },
        )

    assert response.status_code == 200
    job = response.json()
    assert job["ok"] is True
    operation_id = job["result"]["id"]
    assert job["result"]["origin"] == "recorded"
    action = store.get_agent_action(job["jobId"])
    assert action["managed_operation_id"] == operation_id
    assert marker not in json.dumps(action["parameters_json"])
    assert action["parameters_json"]["receipt"]["sequence_length"] == len(marker)
    assert marker.encode() not in store.db_path.read_bytes()
    assert service.get_result(_agent(), operation_id).status == "available"

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"X-DNAForge-Session": MCP_TOKEN},
    ) as client:
        history = await client.post(
            "/mcp/call",
            json={
                "name": "operations.actions",
                "arguments": {"operation_id": operation_id, "limit": 10},
            },
        )
    assert history.json()["ok"] is True
    assert history.json()["result"]["actions"][0]["actor_id"] == AGENT_ID
    assert history.json()["result"]["actions"][0]["outcome"] == "imported"


@pytest.mark.asyncio
async def test_operation_agent_actions_persist_only_result_projection_after_release(
    managed_runtime,
):
    store, _service = managed_runtime
    sequence_marker = "PRIVATE-RECORDED-SEQUENCE-MARKER"
    feature_marker = "SCIENTIFIC-RESULT-MARKER"
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"X-DNAForge-Session": MCP_TOKEN},
    ) as client:
        imported_response = await client.post(
            "/mcp/call",
            json={
                "name": "operations.annotation.import_recorded",
                "arguments": _recorded_import(
                    sequence=sequence_marker,
                    feature_name=feature_marker,
                ),
            },
        )
        imported = imported_response.json()
        operation_id = imported["result"]["id"]

        result_response = await client.post(
            "/mcp/call",
            json={
                "name": "operations.result",
                "arguments": {"operation_id": operation_id},
            },
        )
        result_job = result_response.json()
        assert result_job["result"]["result"]["features"][0]["name"] == feature_marker

        release_response = await client.post(
            "/mcp/call",
            json={
                "name": "operations.release_result",
                "arguments": {"operation_id": operation_id},
            },
        )
        released = release_response.json()
        assert released["result"]["disposition"] == "released"

    assert store.get_managed_operation_result(operation_id) is None
    for job in (imported, result_job, released):
        action = store.get_agent_action(job["jobId"])
        serialized_action = json.dumps(action, sort_keys=True)
        assert sequence_marker not in serialized_action
        assert feature_marker not in serialized_action
        assert action["result_json"] == {
            "_dnaforge_audit_result_projection_v1": {
                "payload_bytes": action["result_json"][
                    "_dnaforge_audit_result_projection_v1"
                ]["payload_bytes"],
                "payload_sha256": action["result_json"][
                    "_dnaforge_audit_result_projection_v1"
                ]["payload_sha256"],
                "schema_version": 1,
                **(
                    {
                        "operation_id": operation_id,
                        "operation_kind": "annotation",
                        "operation_state": "succeeded",
                    }
                    if job is imported
                    else (
                        {
                            "operation_id": operation_id,
                            "operation_kind": "annotation",
                            "result_status": "available",
                        }
                        if job is result_job
                        else {
                            "operation_id": operation_id,
                            "disposition": "released",
                            "operation_kind": "annotation",
                            "operation_state": "succeeded",
                        }
                    )
                ),
            }
        }

    retained_job = get_job_manager().snapshot(result_job["jobId"])
    assert retained_job is not None
    assert "result" not in retained_job
    assert retained_job["resultProjection"]["result_status"] == "available"
    assert feature_marker not in json.dumps(retained_job)


@pytest.mark.asyncio
async def test_mcp_and_agent_routes_share_owner_and_link_authorized_actions(
    managed_runtime,
):
    store, _service = managed_runtime
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"X-DNAForge-Session": MCP_TOKEN},
    ) as client:
        started_response = await client.post(
            "/mcp/call",
            json={
                "name": "operations.annotation.start",
                "arguments": _submission(),
            },
        )
        assert started_response.status_code == 200
        started_job = started_response.json()
        assert started_job["ok"] is True
        operation_id = started_job["result"]["id"]
        start_action = store.get_agent_action(started_job["jobId"])
        assert start_action["managed_operation_id"] == operation_id
        assert start_action["parameters_json"] == {
            "submission_key": "submission-a",
            "subject": {
                "scope_id": RUNTIME_SCOPE,
                "subject_id": "sequence-a",
                "claimed_input_revision": None,
            },
            "input": {
                "sequence_length": 4,
                "sequence_sha256": "sha256:" + hashlib.sha256(b"ATGC").hexdigest(),
                "input_revision": started_job["result"]["subject"]["input_revision"],
                "linear": True,
                "start": None,
                "end": None,
            },
        }
        assert "ATGC" not in json.dumps(start_action["parameters_json"])

        get_response = await client.post(
            "/api/tools/operations.get/execute",
            json={"args": {"operation_id": operation_id}},
        )
        assert get_response.status_code == 200
        get_job = get_response.json()
        assert get_job["result"]["id"] == operation_id
        assert (
            store.get_agent_action(get_job["jobId"])["managed_operation_id"]
            == operation_id
        )

        for _ in range(100):
            if store.get_managed_operation(operation_id)["state"] == "succeeded":
                break
            await asyncio.sleep(0.005)
        assert store.get_managed_operation(operation_id)["state"] == "succeeded"

        for tool_name in ("operations.result", "operations.request_cancel"):
            response = await client.post(
                "/mcp/call",
                json={
                    "name": tool_name,
                    "arguments": {"operation_id": operation_id},
                },
            )
            assert response.status_code == 200
            job = response.json()
            assert job["ok"] is True
            if tool_name == "operations.request_cancel":
                assert job["result"]["disposition"] == "already_settled"
            assert (
                store.get_agent_action(job["jobId"])["managed_operation_id"]
                == operation_id
            )

        release_response = await client.post(
            "/mcp/call",
            json={
                "name": "operations.release_result",
                "arguments": {"operation_id": operation_id},
            },
        )
        assert release_response.status_code == 200
        release_job = release_response.json()
        assert release_job["ok"] is True
        assert release_job["result"]["disposition"] == "released"
        assert (
            store.get_agent_action(release_job["jobId"])["managed_operation_id"]
            == operation_id
        )

        for tool_name, arguments in (
            ("operations.discover", {}),
            ("operations.list", {"scope_id": RUNTIME_SCOPE}),
        ):
            response = await client.post(
                "/mcp/call",
                json={"name": tool_name, "arguments": arguments},
            )
            assert response.status_code == 200
            job = response.json()
            assert job["ok"] is True
            if tool_name == "operations.list":
                assert job["result"]["total"] == 1
                assert job["result"]["next_offset"] is None
            assert store.get_agent_action(job["jobId"])["managed_operation_id"] is None

    operation = store.get_managed_operation(operation_id)
    assert operation["actor_kind"] == "agent"
    assert operation["actor_id"] == AGENT_ID
    assert operation["channel"] == "agent"


@pytest.mark.asyncio
async def test_durable_submission_idempotence_links_each_real_agent_action(
    managed_runtime,
):
    store, _service = managed_runtime
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"X-DNAForge-Session": MCP_TOKEN},
    ) as client:
        jobs = []
        for _ in range(2):
            response = await client.post(
                "/mcp/call",
                json={
                    "name": "operations.annotation.start",
                    "arguments": _submission(),
                },
                headers={"Idempotency-Key": "wrapper-retry-a"},
            )
            assert response.status_code == 200
            jobs.append(response.json())

    assert jobs[0]["result"]["id"] == jobs[1]["result"]["id"]
    assert jobs[0]["jobId"] != jobs[1]["jobId"]
    for job in jobs:
        assert (
            store.get_agent_action(job["jobId"])["managed_operation_id"]
            == job["result"]["id"]
        )


@pytest.mark.asyncio
async def test_agent_can_link_read_action_to_authorized_human_origin_operation(
    managed_runtime,
):
    store, service = managed_runtime
    human = OperationPrincipal(
        actor_kind=ActorKind.HUMAN,
        actor_id=OWNER_ID,
        channel=ClientChannel.DESKTOP_UI,
        scope_ids={RUNTIME_SCOPE},
    )
    operation = await service.start(
        human,
        prepare_annotation_submission(
            AnnotationSubmission.model_validate(_submission())
        ),
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"X-DNAForge-Session": MCP_TOKEN},
    ) as client:
        response = await client.post(
            "/mcp/call",
            json={
                "name": "operations.get",
                "arguments": {"operation_id": operation.id},
            },
        )

    assert response.status_code == 200
    job = response.json()
    assert job["ok"] is True
    assert store.get_agent_action(job["jobId"])["managed_operation_id"] == operation.id
    assert store.get_managed_operation(operation.id)["actor_kind"] == "human"


@pytest.mark.asyncio
async def test_service_authorization_failure_does_not_link_action(managed_runtime):
    store, service = managed_runtime
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"X-DNAForge-Session": MCP_TOKEN},
    ) as client:
        first = await client.post(
            "/mcp/call",
            json={
                "name": "operations.annotation.start",
                "arguments": _submission(),
            },
            headers={"Idempotency-Key": "authorization-must-rerun"},
        )
        assert first.json()["ok"] is True
        service.principal_validator = partial(
            validate_operation_principal,
            store=store,
            runtime_scope=RUNTIME_SCOPE,
            owner_id="different-human",
        )
        response = await client.post(
            "/mcp/call",
            json={
                "name": "operations.annotation.start",
                "arguments": _submission(),
            },
            headers={"Idempotency-Key": "authorization-must-rerun"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["jobId"] != first.json()["jobId"]
    assert body["error"]["code"] == "OPERATION_ACCESS_DENIED"
    assert store.get_agent_action(body["jobId"])["managed_operation_id"] is None


@pytest.mark.asyncio
async def test_route_capability_denial_precedes_operation_and_is_audited(
    managed_runtime,
    monkeypatch,
):
    store, _service = managed_runtime
    narrow_agent = "narrow-operation-agent"
    sequence = "DENIED-SEQUENCE-MARKER"
    store.ensure_agent_identity(
        narrow_agent,
        parent_human_identity_id=OWNER_ID,
        scope=["operations.read"],
        environment_id=RUNTIME_SCOPE,
    )
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", narrow_agent)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"X-DNAForge-Session": MCP_TOKEN},
    ) as client:
        response = await client.post(
            "/mcp/call",
            json={
                "name": "operations.annotation.start",
                "arguments": _submission(sequence=sequence),
            },
        )

    assert response.status_code == 403
    body = response.json()
    assert body["error"]["code"] == "INSUFFICIENT_SCOPE"
    action = store.get_agent_action(body["error"]["details"]["action_id"])
    assert action["authorization_state"] == "denied"
    assert action["managed_operation_id"] is None
    assert sequence not in json.dumps(action["parameters_json"])
    assert action["parameters_json"]["input"]["sequence_length"] == len(sequence)
    assert (
        store.list_managed_operations(
            runtime_scope=RUNTIME_SCOPE,
            scope_id=RUNTIME_SCOPE,
            limit=10,
            offset=0,
        )
        == []
    )


@pytest.mark.asyncio
async def test_invalid_submission_failure_is_bounded_and_does_not_echo_input(
    managed_runtime,
):
    store, _service = managed_runtime
    marker = "PRIVATE-SEQUENCE-MARKER" * 200
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"X-DNAForge-Session": MCP_TOKEN},
    ) as client:
        response = await client.post(
            "/mcp/call",
            json={
                "name": "operations.annotation.start",
                "arguments": {"input": {"sequence": marker}},
            },
        )

    assert response.status_code == 400
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "INVALID_TOOL_INPUT"
    assert body["error"]["retriable"] is False
    assert body["error"]["details"]["stateChanged"] is False
    assert body["error"]["details"]["issues"]
    assert "jobId" not in body
    assert marker not in response.text
    assert store.list_incomplete_agent_actions() == []
    assert (
        store.list_managed_operations(
            runtime_scope=RUNTIME_SCOPE,
            scope_id=RUNTIME_SCOPE,
            limit=10,
            offset=0,
        )
        == []
    )


def test_operation_principal_validator_reloads_parent_environment_and_capabilities(
    tmp_path,
):
    store = ControlPlaneStore(tmp_path / "authority.sqlite3")
    store.initialize()
    try:
        store.ensure_agent_identity(
            AGENT_ID,
            parent_human_identity_id=OWNER_ID,
            scope=sorted(MANAGED_OPERATION_CAPABILITIES),
            environment_id=RUNTIME_SCOPE,
        )
        assert validate_operation_principal(
            _agent(),
            store=store,
            runtime_scope=RUNTIME_SCOPE,
            owner_id=OWNER_ID,
        )
        assert not validate_operation_principal(
            _agent(capabilities=frozenset({"operations.read", "operations.unknown"})),
            store=store,
            runtime_scope=RUNTIME_SCOPE,
            owner_id=OWNER_ID,
        )
        assert not validate_operation_principal(
            _agent(),
            store=store,
            runtime_scope=RUNTIME_SCOPE,
            owner_id="other-human",
        )
        assert not validate_operation_principal(
            _agent(),
            store=store,
            runtime_scope="other-environment",
            owner_id=OWNER_ID,
        )

        store.ensure_agent_identity(
            "revoked-agent",
            parent_human_identity_id=OWNER_ID,
            scope=sorted(MANAGED_OPERATION_CAPABILITIES),
            revoked=True,
            environment_id=RUNTIME_SCOPE,
        )
        assert not validate_operation_principal(
            _agent(identity_id="revoked-agent"),
            store=store,
            runtime_scope=RUNTIME_SCOPE,
            owner_id=OWNER_ID,
        )
        store.ensure_agent_identity(
            "expired-agent",
            parent_human_identity_id=OWNER_ID,
            scope=sorted(MANAGED_OPERATION_CAPABILITIES),
            expires_at=(datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
            environment_id=RUNTIME_SCOPE,
        )
        assert not validate_operation_principal(
            _agent(identity_id="expired-agent"),
            store=store,
            runtime_scope=RUNTIME_SCOPE,
            owner_id=OWNER_ID,
        )

        human = OperationPrincipal(
            actor_kind=ActorKind.HUMAN,
            actor_id=OWNER_ID,
            channel=ClientChannel.DESKTOP_UI,
            scope_ids={RUNTIME_SCOPE},
        )
        assert validate_operation_principal(
            human,
            store=store,
            runtime_scope=RUNTIME_SCOPE,
            owner_id=OWNER_ID,
        )
    finally:
        store.close()


def test_operation_capabilities_are_mintable_for_api_key_agents():
    assert MANAGED_OPERATION_CAPABILITIES <= ALLOWED_API_KEY_SCOPES


def test_bootstrap_backfills_environment_only_for_owned_managed_identity(
    tmp_path,
    monkeypatch,
):
    store = initialize_control_plane(tmp_path / "bootstrap.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", MANAGED_IN_APP_AGENT_IDENTITY)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "operations.read")
    monkeypatch.setenv("DNAFORGE_SIDECAR_ENVIRONMENT_ID", RUNTIME_SCOPE)
    store.ensure_agent_identity(
        MANAGED_IN_APP_AGENT_IDENTITY,
        scope=["read-workspace"],
        environment_id=None,
    )

    bootstrap_session_grant()

    managed = store.get_agent_identity(MANAGED_IN_APP_AGENT_IDENTITY)
    assert managed["environment_id"] == RUNTIME_SCOPE

    external_id = "external-agent-without-environment"
    store.ensure_agent_identity(
        external_id,
        scope=["read-workspace"],
        kind="stdio-mcp",
        origin="local-mcp",
        environment_id=None,
    )
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", external_id)
    bootstrap_session_grant()
    assert store.get_agent_identity(external_id)["environment_id"] is None


def test_bootstrap_does_not_adopt_reserved_id_with_external_metadata(
    tmp_path,
    monkeypatch,
):
    store = initialize_control_plane(tmp_path / "reserved-id.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", MANAGED_IN_APP_AGENT_IDENTITY)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "operations.read")
    monkeypatch.setenv("DNAFORGE_SIDECAR_ENVIRONMENT_ID", RUNTIME_SCOPE)
    store.ensure_agent_identity(
        MANAGED_IN_APP_AGENT_IDENTITY,
        scope=["read-workspace"],
        kind="stdio-mcp",
        origin="local-mcp",
        environment_id=None,
    )

    bootstrap_session_grant()

    row = store.get_agent_identity(MANAGED_IN_APP_AGENT_IDENTITY)
    assert row["environment_id"] is None
    assert row["scope_json"] == ["read-workspace"]
