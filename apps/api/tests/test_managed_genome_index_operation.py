from __future__ import annotations

import asyncio
import json
import threading

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from src.concurrency.tool_registry import ToolContext
from src.control_plane import ControlPlaneStore
from src.genome_index_operation_audit import genome_index_submission_audit_parameters
from src.genome_index_operation_contract import (
    GenomeIndexAgentStart,
    GenomeIndexSubmission,
    IndexGenomeRequest,
    IndexGenomeResponse,
    prepare_genome_index_submission,
)
from src.managed_genome_index import execute_managed_genome_index
from src.managed_operation_agent_tools import managed_operation_tool_definitions
from src.managed_operations import MANAGED_OPERATION_SYSTEM
from src.operation_kinds import (
    GENOME_INDEXING_OPERATION_KIND,
)
from src.operations import (
    InputRevisionMismatch,
    ManagedOperationService,
    OperationCanceled,
    OperationExecutionError,
)
from src.routes.genome import router as genome_router
from tests.managed_operation_kinds import bind_test_executors


def _submission() -> GenomeIndexSubmission:
    return GenomeIndexSubmission(
        submission_key="genome-submission-1",
        subject={"scope_id": "workspace-a", "subject_id": "genome-source-1"},
        input={
            "input": "/workspace/reference.gbff",
            "outputDir": "/workspace/.waypoint/genome-index/reference-v1",
            "name": "reference",
            "workspaceRoot": "/workspace",
        },
    )


def test_genome_indexing_is_one_compiled_kind_with_http_cli_and_agent_surfaces():
    descriptors = {
        descriptor.kind: descriptor
        for descriptor in MANAGED_OPERATION_SYSTEM.descriptors
    }

    genome = descriptors["genome-indexing"]
    assert genome.contract_version == 1
    assert genome.result_schema_version == 1
    assert genome.surfaces.http_start == "/operations/genome-indexing"
    assert genome.surfaces.cli_submit == (
        "dnaforge jobs submit genome-indexing --request FILE|-"
    )
    assert genome.surfaces.agent_start == "operations.genome-indexing.start"
    assert genome.surfaces.http_import_recorded is None
    assert genome.actions == (
        "start",
        "list",
        "get",
        "result",
        "actions",
        "request_cancel",
        "release_result",
    )

    definitions = {
        definition.spec.name: definition
        for definition in managed_operation_tool_definitions(MANAGED_OPERATION_SYSTEM)
    }
    start = definitions["operations.genome-indexing.start"]
    assert start.spec.inputs == GenomeIndexAgentStart.model_json_schema()
    assert set(start.spec.required_capabilities) == {
        "operations.start",
        "read-workspace",
        "write-workspace",
    }
    assert genome.start_capabilities == ("operations.start",)
    assert set(genome.agent_start_capabilities) == {
        "operations.start",
        "read-workspace",
        "write-workspace",
    }
    assert genome.input_schema == GenomeIndexSubmission.model_json_schema()
    assert genome.agent_input_schema == GenomeIndexAgentStart.model_json_schema()


def test_genome_index_submission_derives_revision_and_rejects_a_forged_claim():
    prepared = prepare_genome_index_submission(_submission())

    assert prepared.input == IndexGenomeRequest.model_validate(_submission().input)
    assert prepared.subject.input_revision.startswith("genome-index-v1:sha256:")

    forged = _submission().model_copy(
        update={
            "subject": _submission().subject.model_copy(
                update={"input_revision": "genome-index-v1:sha256:" + "0" * 64}
            )
        }
    )
    with pytest.raises(InputRevisionMismatch):
        prepare_genome_index_submission(forged)


def test_genome_index_audit_hashes_local_paths_instead_of_retaining_them():
    audit = genome_index_submission_audit_parameters(
        _submission().model_dump(mode="json", by_alias=True)
    )
    encoded = json.dumps(audit, sort_keys=True)

    assert audit["input"]["name"] == "reference"
    assert audit["input"]["input_sha256"].startswith("sha256:")
    assert "/workspace" not in encoded
    assert "reference.gbff" not in encoded


@pytest.mark.asyncio
async def test_agent_start_grounds_the_path_in_the_app_and_returns_the_operation(
    tmp_path, monkeypatch
):
    entered = asyncio.Event()
    release = asyncio.Event()
    renderer_calls = []

    async def unused_executor(_value, _cancel):
        raise AssertionError("an unrelated executor must not run")

    async def genome_executor(value, _cancel):
        assert value == _submission().input
        entered.set()
        await release.wait()
        return IndexGenomeResponse(
            fastaPath="/workspace/index/reference.fa.gz",
            faiPath="/workspace/index/reference.fa.gz.fai",
            metadata={
                "length": 1234,
                "circular": False,
                "featureCount": 8,
                "annotationTypes": ["gene"],
                "annotationRasterReady": True,
            },
        )

    async def renderer_call(name, args, context):
        renderer_calls.append((name, args, context.job_id))
        return {
            "ok": True,
            "result": {
                "ok": True,
                "input": _submission().input.model_dump(mode="json", by_alias=True),
            },
            "audit_id": "renderer-audit-1",
        }

    monkeypatch.setattr(
        "src.genome_index_operation_agent.call_renderer_bridge", renderer_call
    )
    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    service = ManagedOperationService(
        store=store,
        runtime_scope="workspace-a",
        adapters=bind_test_executors(
            unused_executor, {GENOME_INDEXING_OPERATION_KIND.key: genome_executor}
        ),
    )
    capabilities = [
        "operations.start",
        "operations.read",
        "read-workspace",
        "write-workspace",
    ]
    store.ensure_agent_identity("agent-a", scope=capabilities)
    action_id = store.insert_agent_action(
        agent_identity_id="agent-a",
        tool_name="operations.genome-indexing.start",
        parameters={"path_basename": "reference.gbff"},
        authorized_scope=capabilities,
    )
    definition = next(
        item
        for item in managed_operation_tool_definitions(MANAGED_OPERATION_SYSTEM)
        if item.spec.name == "operations.genome-indexing.start"
    )
    assert definition.handler is not None
    context = ToolContext(
        job_id=action_id,
        agent_identity_id="agent-a",
        agent_capabilities=capabilities,
        cancel_event=asyncio.Event(),
        managed_operations=service,
    )

    try:
        response = await asyncio.wait_for(
            definition.handler({"path": "reference.gbff"}, context), timeout=0.2
        )
        assert response["kind"] == "genome-indexing"
        assert response["state"] in {"queued", "running"}
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert renderer_calls == [
            (
                "operations.genome-indexing.start",
                {"path": "reference.gbff"},
                action_id,
            )
        ]
        assert (
            store.get_agent_action(action_id)["managed_operation_id"] == response["id"]
        )
    finally:
        release.set()
        await service.aclose()
        store.close()


@pytest.mark.asyncio
async def test_managed_executor_maps_cancellation_and_does_not_retain_raw_failure(
    monkeypatch,
):
    async def canceled(_request, _cancel):
        raise HTTPException(status_code=499, detail="private cancellation detail")

    monkeypatch.setattr("src.managed_genome_index._run_admitted_index", canceled)
    with pytest.raises(OperationCanceled):
        await execute_managed_genome_index(_submission().input, threading.Event())

    async def failed(_request, _cancel):
        raise HTTPException(
            status_code=500,
            detail="failed while reading /private/workspace/reference.gbff",
        )

    monkeypatch.setattr("src.managed_genome_index._run_admitted_index", failed)
    with pytest.raises(OperationExecutionError) as raised:
        await execute_managed_genome_index(_submission().input, threading.Event())
    assert raised.value.payload.code == "GENOME_INDEX_FAILED"
    assert raised.value.payload.message == "Genome indexing failed."
    assert "/private/workspace" not in str(raised.value.payload)


def test_direct_genome_route_cannot_bypass_a_present_managed_runtime(monkeypatch):
    calls = []

    async def admitted(request, cancellation):
        calls.append((request, cancellation))
        return IndexGenomeResponse(
            fastaPath="/workspace/index/reference.fa.gz",
            faiPath="/workspace/index/reference.fa.gz.fai",
            metadata={
                "length": 1234,
                "circular": False,
                "featureCount": 8,
                "annotationTypes": [],
                "annotationRasterReady": True,
            },
        )

    monkeypatch.setattr("src.routes.genome._run_admitted_index", admitted)
    app = FastAPI()
    app.include_router(genome_router)
    app.state.managed_operations = object()

    with TestClient(app) as client:
        refused = client.post(
            "/genome/index",
            json=_submission().input.model_dump(mode="json", by_alias=True),
        )
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "MANAGED_GENOME_INDEX_REQUIRED"
        assert calls == []

        app.state.managed_operations = None
        accepted = client.post(
            "/genome/index",
            json=_submission().input.model_dump(mode="json", by_alias=True),
        )
        assert accepted.status_code == 200
        assert accepted.json()["metadata"]["length"] == 1234
        assert len(calls) == 1
