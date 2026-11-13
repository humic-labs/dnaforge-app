"""Authenticated, caller-scoped MCP discovery route tests."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient
from jsonschema import validate

from src.concurrency.builtins import (
    echo_handler,
    echo_tool_spec,
    prepare_workflow_run_handler,
    prepare_workflow_run_tool_spec,
    register_artifact_handler,
    register_artifact_tool_spec,
)
from src.concurrency.job_manager import get_job_manager, reset_job_manager
from src.concurrency.pools import reset_pool_manager
from src.concurrency.tool_registry import agent_tool_registry
from src.control_plane import initialize_control_plane
from src.main import app
from src.mcp_companion.projection import project_call_result
from src.routes.mcp_auth import hash_api_key

MCP_TOKEN = "test-mcp-token"
CALLER_ID = "discovery-caller"
OTHER_ID = "other-agent"


@pytest.fixture
def discovery_client(tmp_path, monkeypatch):
    agent_tool_registry.clear()
    agent_tool_registry.register(echo_tool_spec(), echo_handler)
    agent_tool_registry.register(
        prepare_workflow_run_tool_spec(), prepare_workflow_run_handler
    )
    agent_tool_registry.register(
        register_artifact_tool_spec(), register_artifact_handler
    )
    reset_job_manager()
    reset_pool_manager()

    db_path = tmp_path / "control.sqlite3"
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(db_path))
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", CALLER_ID)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "*")
    store = initialize_control_plane(db_path)
    store.ensure_agent_identity(
        CALLER_ID,
        scope=["read-workspace"],
        label="Scoped discovery caller",
    )
    store.ensure_agent_identity(
        OTHER_ID,
        scope=["read-workspace"],
        label="Foreign caller",
    )
    _seed_resources(store, CALLER_ID, "caller")
    _seed_resources(store, OTHER_ID, "other")

    headers = {
        "X-DNAForge-Session": MCP_TOKEN,
        "X-DNAForge-Agent-Identity": CALLER_ID,
    }
    yield TestClient(app), store, headers

    agent_tool_registry.clear()
    reset_job_manager()
    reset_pool_manager()


def _seed_resources(store, identity_id: str, suffix: str) -> None:  # noqa: ANN001
    action_id = store.insert_agent_action(
        action_id=f"action-{suffix}",
        agent_identity_id=identity_id,
        tool_name="workflow.prepare_run",
        parameters={},
    )
    store.insert_agent_artifact(
        artifact_id=f"artifact-{suffix}",
        agent_identity_id=identity_id,
        action_id=action_id,
        kind="file",
        name=f"{suffix}.tsv",
        path=f"/tmp/{suffix}.tsv",
    )
    analysis_run_id = store.insert_agent_analysis_run(
        analysis_run_id=f"run-{suffix}",
        agent_identity_id=identity_id,
        action_id=action_id,
        name=f"{suffix.title()} run",
        status="completed",
        command={"line": "true"},
    )
    store.insert_agent_resource_link(
        resource_link_id=f"link-{suffix}",
        agent_identity_id=identity_id,
        action_id=action_id,
        source_uri=f"waypoint://analysis-run/{analysis_run_id}",
        target_uri="waypoint://workflow/ncbi-derivative-design",
        relationship="implements_workflow",
    )


def test_post_discover_uses_persisted_scope_and_hides_foreign_resources(
    discovery_client,
):
    client, _, headers = discovery_client

    response = client.post(
        "/mcp/discover",
        json={"clientInfo": {"name": "test-client", "version": "1"}},
        headers=headers,
    )

    assert response.status_code == 200
    body = response.json()
    assert body["caller"] == {
        "agentIdentityId": CALLER_ID,
        "label": "Scoped discovery caller",
        "authMethod": "session",
        "clientInfo": {"name": "test-client", "version": "1"},
        "requestedCapabilities": None,
        "grantedCapabilities": ["read-workspace"],
        "effectiveCapabilities": ["read-workspace"],
    }
    assert [tool["name"] for tool in body["tools"]] == [
        "artifact.register",
        "echo",
        "workflow.prepare_run",
    ]
    workflow_tool = next(
        tool for tool in body["tools"] if tool["name"] == "workflow.prepare_run"
    )
    schema = workflow_tool["outputSchema"]
    assert schema == prepare_workflow_run_tool_spec().outputs
    assert schema["additionalProperties"] is False
    assert {"ok", "workflowId", "workflowSteps", "workflowBoundaries"}.issubset(
        schema["required"]
    )
    assert [resource["uri"] for resource in body["resources"]] == sorted(
        resource["uri"] for resource in body["resources"]
    )
    serialized_resources = json.dumps(body["resources"])
    assert "waypoint://artifact/artifact-caller" in serialized_resources
    assert "waypoint://analysis-run/run-caller" in serialized_resources
    assert "waypoint://resource-link/link-caller" in serialized_resources
    assert "artifact-other" not in serialized_resources
    assert "run-other" not in serialized_resources
    assert "link-other" not in serialized_resources
    assert [
        template["uriTemplate"] for template in body["resourceTemplates"]
    ] == sorted(template["uriTemplate"] for template in body["resourceTemplates"])
    assert "waypoint://selection/{refId}" in {
        template["uriTemplate"] for template in body["resourceTemplates"]
    }
    assert "waypoint://sequence/{documentId}" not in {
        template["uriTemplate"] for template in body["resourceTemplates"]
    }


def test_get_and_post_discovery_share_one_projection(discovery_client):
    client, _, headers = discovery_client

    get_body = client.get("/mcp/discover", headers=headers).json()
    post_body = client.post("/mcp/discover", json={}, headers=headers).json()

    assert get_body == post_body


def test_get_discovery_openapi_contract_has_no_request_body():
    operation = app.openapi()["paths"]["/mcp/discover"]["get"]

    assert "requestBody" not in operation


def test_real_call_structured_content_matches_discovered_output_schema(
    discovery_client,
):
    client, store, _ = discovery_client
    api_key = "dna_key_output_schema_integration"
    store.create_agent_identity(
        identity_id="output-schema-agent",
        scope=["debug.echo"],
        api_key_hash=hash_api_key(api_key),
    )
    headers = {"X-DNAForge-API-Key": api_key}

    discovery = client.post("/mcp/discover", json={}, headers=headers)
    call = client.post(
        "/mcp/call",
        json={"name": "echo", "arguments": {"message": "schema-match"}},
        headers=headers,
    )

    assert discovery.status_code == 200
    assert call.status_code == 200
    echo_tool = next(
        tool for tool in discovery.json()["tools"] if tool["name"] == "echo"
    )
    projected = project_call_result(call.status_code, call.json())
    assert projected.structured_content == call.json()["result"]
    assert projected.meta == {
        "com.dnaforge/job": {
            "jobId": call.json()["jobId"],
            "toolName": "echo",
            "status": "completed",
            "pool": "cpu_fast",
        }
    }
    validate(instance=projected.structured_content, schema=echo_tool["outputSchema"])


def test_discover_client_info_is_non_authoritative_and_header_identity_is_ignored(
    discovery_client,
):
    client, store, headers = discovery_client

    response = client.post(
        "/mcp/discover",
        json={"clientInfo": {"name": OTHER_ID, "version": "9.9"}},
        headers={
            **headers,
            "X-DNAForge-Agent-Identity": OTHER_ID,
            "X-DNAForge-Agent-Capabilities": "*",
        },
    )

    assert response.status_code == 200
    caller = response.json()["caller"]
    assert caller == {
        "agentIdentityId": CALLER_ID,
        "label": "Scoped discovery caller",
        "authMethod": "session",
        "clientInfo": {"name": OTHER_ID, "version": "9.9"},
        "requestedCapabilities": ["*"],
        "grantedCapabilities": ["read-workspace"],
        "effectiveCapabilities": ["read-workspace"],
    }
    persisted = store.get_agent_identity(CALLER_ID)
    assert persisted is not None
    assert persisted["client_name"] == OTHER_ID
    assert persisted["client_version"] == "9.9"


@pytest.mark.parametrize(
    "body",
    [
        [],
        {"clientInfo": None},
        {"clientInfo": "client"},
        {"clientInfo": {}},
        {"clientInfo": {"name": "client", "version": 1}},
        {"clientInfo": {"name": " ", "version": "1"}},
    ],
)
def test_discover_rejects_malformed_client_info(discovery_client, body):
    client, _, headers = discovery_client

    response = client.post("/mcp/discover", json=body, headers=headers)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_CLIENT_INFO"


def test_discover_preserves_explicit_empty_capability_request(discovery_client):
    client, _, headers = discovery_client
    attenuated_headers = {
        **headers,
        "X-DNAForge-Agent-Capabilities": "[]",
    }

    response = client.post("/mcp/discover", json={}, headers=attenuated_headers)

    assert response.status_code == 200
    body = response.json()
    assert body["caller"]["requestedCapabilities"] == []
    assert body["caller"]["effectiveCapabilities"] == []
    assert [tool["name"] for tool in body["tools"]] == [
        "artifact.register",
        "echo",
        "workflow.prepare_run",
    ]
    assert body["resources"] == []
    assert body["resourceTemplates"] == []


@pytest.mark.parametrize(
    ("grant_state", "expected_code"),
    [
        ("revoked", "GRANT_REVOKED"),
        ("expired", "GRANT_EXPIRED"),
        ("missing", "GRANT_MISSING"),
    ],
)
def test_discover_revalidates_persistent_grant_each_request(
    discovery_client,
    monkeypatch,
    grant_state,
    expected_code,
):
    client, store, headers = discovery_client
    if grant_state == "revoked":
        assert store.revoke_agent_identity(CALLER_ID) is True
    elif grant_state == "expired":
        expired_id = "expired-discovery-agent"
        store.ensure_agent_identity(
            expired_id,
            scope=["read-workspace"],
            expires_at="2000-01-01T00:00:00Z",
        )
        monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", expired_id)
    else:
        monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", "missing-discovery-agent")

    response = client.post("/mcp/discover", json={}, headers=headers)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == expected_code
    assert "tools" not in response.json()
    assert "resources" not in response.json()


def test_discover_rejects_invalid_session_before_grant_state(discovery_client):
    client, store, headers = discovery_client
    assert store.revoke_agent_identity(CALLER_ID) is True

    response = client.get(
        "/mcp/discover",
        headers={**headers, "X-DNAForge-Session": "wrong-token"},
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "BAD_SESSION"


def test_discover_api_key_uses_its_persisted_scope(discovery_client):
    client, store, _ = discovery_client
    api_key = "dna_key_discovery_test"
    store.create_agent_identity(
        identity_id="api-discovery-agent",
        scope=["debug.echo"],
        label="API discovery caller",
        kind="http-api-key",
        api_key_hash=hash_api_key(api_key),
    )

    response = client.post(
        "/mcp/discover",
        json={},
        headers={"X-DNAForge-API-Key": api_key},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["caller"]["agentIdentityId"] == "api-discovery-agent"
    assert body["caller"]["label"] == "API discovery caller"
    assert body["caller"]["authMethod"] == "api-key"
    assert body["caller"]["clientInfo"] is None
    assert body["caller"]["effectiveCapabilities"] == ["debug.echo"]
    assert [tool["name"] for tool in body["tools"]] == [
        "artifact.register",
        "echo",
        "workflow.prepare_run",
    ]
    assert body["resources"] == []
    assert body["resourceTemplates"] == []


def test_sequence_template_requires_read_sequences(discovery_client):
    client, store, _ = discovery_client
    api_key = "dna_key_sequence_discovery"
    store.create_agent_identity(
        identity_id="sequence-discovery-agent",
        scope=["read-sequences"],
        kind="http-api-key",
        api_key_hash=hash_api_key(api_key),
    )

    response = client.get(
        "/mcp/discover",
        headers={"X-DNAForge-API-Key": api_key},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["resources"] == []
    assert [template["uriTemplate"] for template in body["resourceTemplates"]] == [
        "waypoint://sequence/{documentId}"
    ]


def test_discover_preserves_open_workspace_resources_with_capability_filtering(
    discovery_client,
):
    client, store, headers = discovery_client
    workspace_calls = 0
    workspace_spec = prepare_workflow_run_tool_spec().model_copy(
        update={
            "name": "get_workspace",
            "handler_ref": "tests.discovery.get_workspace",
            "outputs": {"type": "object", "required": ["ok", "result"]},
            "inputs": {"type": "object", "additionalProperties": False},
        }
    )

    async def get_workspace(_args, _context):  # noqa: ANN001
        nonlocal workspace_calls
        workspace_calls += 1
        return {
            "ok": True,
            "result": {
                "folders": [{"name": "workspace", "path": "/workspace"}],
                "panels": [
                    {
                        "tabs": [
                            {
                                "type": "design",
                                "entityId": "design-1",
                                "label": "Design 1",
                            },
                            {
                                "type": "sequence",
                                "entityId": "/workspace/plasmids/pUC19.gb",
                                "label": "pUC19",
                            },
                        ]
                    }
                ],
            },
        }

    agent_tool_registry.register(workspace_spec, get_workspace)

    base_projection = client.get("/mcp/discover", headers=headers)

    assert base_projection.status_code == 200
    assert workspace_calls == 0
    base_uris = {resource["uri"] for resource in base_projection.json()["resources"]}
    assert "waypoint://design/design-1" not in base_uris
    assert "waypoint://sequence/plasmids%2FpUC19.gb" not in base_uris

    workspace_only = client.post(
        "/mcp/discover",
        json={"includeOpenWorkspaceResources": True},
        headers=headers,
    )

    assert workspace_only.status_code == 200
    assert workspace_calls == 1
    workspace_only_uris = {
        resource["uri"] for resource in workspace_only.json()["resources"]
    }
    assert "waypoint://design/design-1" in workspace_only_uris
    assert "waypoint://sequence/plasmids%2FpUC19.gb" not in workspace_only_uris

    api_key = "dna_key_open_resources"
    store.create_agent_identity(
        identity_id="open-resource-agent",
        scope=["read-workspace", "read-sequences"],
        label="Open resource agent",
        kind="http-api-key",
        api_key_hash=hash_api_key(api_key),
    )
    with_sequences = client.post(
        "/mcp/discover",
        json={"includeOpenWorkspaceResources": True},
        headers={"X-DNAForge-API-Key": api_key},
    )

    assert with_sequences.status_code == 200
    assert workspace_calls == 2
    resource_uris = [resource["uri"] for resource in with_sequences.json()["resources"]]
    assert resource_uris == sorted(resource_uris)
    assert "waypoint://design/design-1" in resource_uris
    assert "waypoint://sequence/plasmids%2FpUC19.gb" in resource_uris


@pytest.mark.parametrize(
    ("uri", "content_key"),
    [
        ("waypoint://action/action-caller", "action"),
        ("waypoint://artifact/artifact-caller", "artifact"),
        ("waypoint://analysis-run/run-caller", "analysisRun"),
        ("waypoint://resource-link/link-caller", "resourceLink"),
        ("waypoint://agent/status", "tools"),
        ("waypoint://workflow/manifest", "manifest"),
    ],
)
def test_unified_resource_read_handles_discovered_resources(
    discovery_client,
    uri,
    content_key,
):
    client, _, headers = discovery_client

    response = client.post(
        "/mcp/resources/read",
        json={"uri": uri},
        headers=headers,
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["contents"][0]["uri"] == uri
    content = json.loads(body["contents"][0]["text"])
    assert content_key in content
    serialized = json.dumps(content)
    for foreign_id in (
        OTHER_ID,
        "action-other",
        "artifact-other",
        "run-other",
        "link-other",
    ):
        assert foreign_id not in serialized


def test_unified_resource_read_hides_foreign_owned_resource(discovery_client):
    client, _, headers = discovery_client

    response = client.post(
        "/mcp/resources/read",
        json={"uri": "waypoint://artifact/artifact-other"},
        headers=headers,
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "UNKNOWN_RESOURCE"


def test_unified_workflow_ledger_reads_filter_foreign_and_unowned_runs(
    discovery_client,
    tmp_path,
    monkeypatch,
):
    client, _, headers = discovery_client
    ledger_root = tmp_path / "workflow-ledgers"
    ledgers = [
        (
            "run-a-own",
            "action-caller",
            "passed",
            "own-run-visible",
        ),
        (
            "run-b-foreign",
            "action-other",
            "failed",
            "foreign-run-secret",
        ),
        (
            "run-c-unowned",
            None,
            "failed",
            "unowned-run-secret",
        ),
        (
            "run-d-partially-unowned",
            "action-caller",
            "failed",
            "partially-unowned-run-secret",
        ),
    ]
    for run_name, action_id, outcome, marker in ledgers:
        run_dir = ledger_root / run_name
        run_dir.mkdir(parents=True)
        lifecycle = [{"action_id": action_id}] if action_id is not None else []
        if run_name == "run-d-partially-unowned":
            lifecycle.append({})
        (run_dir / "workflow-ledger.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "workflow": {
                        "id": "shared-workflow",
                        "demand": {"level": "high"},
                    },
                    "outcome": outcome,
                    "success": outcome == "passed",
                    "classification": marker,
                    "command_lifecycle": lifecycle,
                }
            )
        )
    monkeypatch.setenv("DNAFORGE_WORKFLOW_LEDGER_ROOT", str(ledger_root))

    discovery = client.get("/mcp/discover", headers=headers)
    summary_response = client.post(
        "/mcp/resources/read",
        json={"uri": "waypoint://workflow-runs/summary"},
        headers=headers,
    )
    latest_response = client.post(
        "/mcp/resources/read",
        json={"uri": "waypoint://workflow-runs/latest/shared-workflow"},
        headers=headers,
    )

    assert discovery.status_code == 200
    assert "waypoint://workflow-runs/latest/{id}" in {
        template["uriTemplate"] for template in discovery.json()["resourceTemplates"]
    }
    assert "foreign-run-secret" not in discovery.text
    assert summary_response.status_code == 200
    summary = json.loads(summary_response.json()["contents"][0]["text"])["summary"]
    assert summary["total_runs"] == 1
    assert summary["workflows"]["shared-workflow"]["runs"] == 1
    assert "foreign-run-secret" not in json.dumps(summary)
    assert "unowned-run-secret" not in json.dumps(summary)
    assert "partially-unowned-run-secret" not in json.dumps(summary)
    assert latest_response.status_code == 200
    latest = json.loads(latest_response.json()["contents"][0]["text"])
    assert latest["ledger"]["classification"] == "own-run-visible"
    assert "foreign-run-secret" not in json.dumps(latest)


def test_unified_resource_read_revalidates_revocation(discovery_client):
    client, store, headers = discovery_client
    assert store.revoke_agent_identity(CALLER_ID) is True

    response = client.post(
        "/mcp/resources/read",
        json={"uri": "waypoint://artifact/artifact-caller"},
        headers=headers,
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "GRANT_REVOKED"


def test_unified_resource_read_denies_and_audits_missing_resource_scope(
    discovery_client,
):
    client, store, headers = discovery_client

    response = client.post(
        "/mcp/resources/read",
        json={"uri": "waypoint://sequence/plasmids%2FpUC19.gb"},
        headers=headers,
    )

    assert response.status_code == 403
    details = response.json()["error"]["details"]
    assert details["required"] == ["read-sequences"]
    action = store.get_agent_action(details["action_id"])
    audits = store.get_audit_records_for_action(details["action_id"])
    assert action is not None
    assert action["authorization_state"] == "denied"
    assert audits[0]["capability_check_json"] == {
        "required": ["read-sequences"],
        "satisfied": False,
        "reason": "insufficient_scope",
    }


def test_tool_list_and_status_report_complete_catalog_but_owned_jobs(discovery_client):
    client, _, headers = discovery_client
    for identity_id in (CALLER_ID, OTHER_ID, OTHER_ID):
        asyncio.run(
            get_job_manager().submit(
                spec=echo_tool_spec(),
                args={"message": identity_id},
                handler=echo_handler,
                agent_identity_id=identity_id,
                agent_capabilities=["debug.echo"],
            )
        )

    tools_response = client.get("/api/tools", headers=headers)
    status_response = client.get("/mcp/agent/status", headers=headers)

    assert tools_response.status_code == 200
    assert [tool["name"] for tool in tools_response.json()["tools"]] == [
        "artifact.register",
        "echo",
        "workflow.prepare_run",
    ]
    status = status_response.json()["resource"]
    assert status["tools"] == {
        "registered": 3,
        "names": ["artifact.register", "echo", "workflow.prepare_run"],
    }
    assert status["jobs"]["completed"] == 1
    assert status["latestResources"]["artifact"]["resourceUri"] == (
        "waypoint://artifact/artifact-caller"
    )
    assert status["latestResources"]["analysisRun"]["resourceUri"] == (
        "waypoint://analysis-run/run-caller"
    )
    assert status["latestResources"]["resourceLink"]["resourceUri"] == (
        "waypoint://resource-link/link-caller"
    )
    assert "other" not in json.dumps(status)


def test_direct_excluded_call_remains_denied_and_audited(discovery_client):
    client, store, headers = discovery_client

    response = client.post(
        "/mcp/call",
        json={"name": "echo", "arguments": {"message": "blocked"}},
        headers=headers,
    )

    assert response.status_code == 403
    details = response.json()["error"]["details"]
    action = store.get_agent_action(details["action_id"])
    audits = store.get_audit_records_for_action(details["action_id"])
    assert action is not None
    assert action["authorization_state"] == "denied"
    assert action["error_json"]["code"] == "INSUFFICIENT_SCOPE"
    assert audits[0]["id"] == details["audit_id"]
    assert audits[0]["capability_check_json"]["satisfied"] is False


def test_compact_tool_lookup_omits_catalog_and_resources_and_rechecks_auth(
    discovery_client,
):
    client, store, headers = discovery_client
    response = client.post(
        "/mcp/discover",
        headers=headers,
        json={
            "toolLookup": {"name": "workflow_prepare_run", "portableNames": True},
        },
    )
    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "tool": {"name": "workflow.prepare_run", "cancelable": False},
    }
    missing = client.post(
        "/mcp/discover",
        headers=headers,
        json={
            "toolLookup": {"name": "unknown", "portableNames": True},
        },
    )
    assert missing.json() == {"ok": True, "tool": None}
    denied = client.post("/mcp/discover", json={"toolLookup": {"name": "echo"}})
    assert denied.status_code == 401


def test_compact_tool_lookup_rejects_malformed_names(discovery_client):
    client, _, headers = discovery_client
    for lookup in (
        {"name": ""},
        {"name": "x", "portableNames": "yes"},
        {"name": "x" * 129},
        [],
    ):
        response = client.post(
            "/mcp/discover", headers=headers, json={"toolLookup": lookup}
        )
        assert response.status_code == 400
