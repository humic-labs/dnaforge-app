from __future__ import annotations

import asyncio
import json
import shutil
import threading
import time
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI, HTTPException
from pydantic import ValidationError

from src.concurrency.tool_errors import ToolExecutionFailure
from src.concurrency.tool_registry import ToolContext
from src.control_plane import ControlPlaneStore
from src.managed_msa import execute_managed_msa
from src.managed_msa_agent_tool import start_managed_msa_handler
from src.managed_operation_agent_tools import managed_operation_tool_definitions
from src.managed_operation_tool_outputs import AlignmentAdmissionOutput
from src.managed_operations import MANAGED_OPERATION_SYSTEM
from src.msa_operation_audit import multiple_sequence_alignment_audit_parameters
from src.msa_operation_contract import (
    MAX_MSA_OUTPUT_CELLS,
    MAX_MSA_SEQUENCE_COUNT,
    MAX_MSA_SEQUENCE_RESIDUES,
    MAX_MSA_TOTAL_RESIDUES,
    MultipleSequenceAlignmentInput,
    MultipleSequenceAlignmentResult,
    MultipleSequenceAlignmentSubmission,
    prepare_multiple_sequence_alignment_submission,
)
from src.operation_kinds import (
    GENOME_INDEXING_OPERATION_KIND,
    MULTIPLE_SEQUENCE_ALIGNMENT_OPERATION_KIND,
)
from src.operations import (
    ActorKind,
    ClientChannel,
    InputRevisionMismatch,
    ManagedOperationService,
    OperationExecutionError,
    OperationPrincipal,
    OperationState,
)
from src.routes.operations import router as operations_router
from src.security.local_access import LocalAccessMiddleware
from src.tools.alignment import MultipleAlignmentResult
from tests.managed_operation_kinds import MANAGED_OPERATION_KINDS, bind_test_executors
from tests.sidecar_test_client import AuthenticatedSidecarTestClient


def _input() -> MultipleSequenceAlignmentInput:
    return MultipleSequenceAlignmentInput(
        sequences=[
            {"id": "protein-1", "name": "Kinase alpha", "sequence": "MPEPTIDE"},
            {"id": "protein-2", "name": "Kinase beta", "sequence": "MPEPTIDEK"},
        ],
        algorithm="fast",
        threads=2,
        timeout_seconds=120,
    )


def _submission(key: str = "submission-1") -> MultipleSequenceAlignmentSubmission:
    return MultipleSequenceAlignmentSubmission(
        submission_key=key,
        subject={"scope_id": "workspace-a", "subject_id": "msa:protein-1,protein-2"},
        input=_input(),
    )


def test_msa_is_one_compiled_kind_with_http_cli_and_agent_surfaces():
    descriptors = {
        descriptor.kind: descriptor
        for descriptor in MANAGED_OPERATION_SYSTEM.descriptors
    }

    assert set(descriptors) == MANAGED_OPERATION_KINDS
    msa = descriptors["multiple-sequence-alignment"]
    assert msa.contract_version == 1
    assert msa.result_schema_version == 1
    assert msa.surfaces.http_start == "/operations/multiple-sequence-alignment"
    assert msa.surfaces.cli_submit == (
        "dnaforge jobs submit multiple-sequence-alignment --request FILE|-"
    )
    assert msa.surfaces.agent_start == "operations.multiple-sequence-alignment.start"
    assert msa.surfaces.http_import_recorded is None
    assert msa.actions == (
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
    assert "operations.multiple-sequence-alignment.start" in definitions
    assert definitions["operations.multiple-sequence-alignment.start"].spec.inputs == (
        MultipleSequenceAlignmentSubmission.model_json_schema()
    )


def test_msa_submission_derives_immutable_revision_and_rejects_a_false_claim():
    prepared = prepare_multiple_sequence_alignment_submission(_submission())

    assert prepared.input == _input()
    assert prepared.subject.input_revision.startswith("msa-v1:sha256:")

    with pytest.raises(InputRevisionMismatch):
        prepare_multiple_sequence_alignment_submission(
            _submission().model_copy(
                update={
                    "subject": _submission().subject.model_copy(
                        update={"input_revision": "msa-v1:sha256:" + "0" * 64}
                    )
                }
            )
        )


def test_msa_audit_projection_uses_identity_length_and_hash_without_sequence_data():
    audit = multiple_sequence_alignment_audit_parameters(
        _submission().model_dump(mode="json")
    )
    encoded = json.dumps(audit, sort_keys=True)

    assert audit["input"]["sequence_count"] == 2
    assert audit["input"]["sequences"][0]["id"] == "protein-1"
    assert audit["input"]["sequences"][0]["length"] == 8
    assert audit["input"]["sequences"][0]["sha256"].startswith("sha256:")
    assert "MPEPTIDE" not in encoded
    assert "Kinase alpha" not in encoded


def test_msa_contract_rejects_whitespace_ids_and_duplicate_result_ids():
    with pytest.raises(ValidationError):
        MultipleSequenceAlignmentInput(
            sequences=[
                {"id": "protein one", "sequence": "MPEPTIDE"},
                {"id": "protein-2", "sequence": "MPEPTIDE"},
            ]
        )

    with pytest.raises(ValidationError):
        MultipleSequenceAlignmentResult(
            aligned_sequences=[
                {"id": "protein-1", "sequence": "MPEPTIDE"},
                {"id": "protein-1", "sequence": "MPEPTIDE"},
            ],
            alignment_length=8,
            num_sequences=2,
        )


@pytest.mark.asyncio
async def test_msa_executor_rejects_changed_result_identity(monkeypatch):
    async def changed_identity(*_args, **_kwargs):
        return MultipleAlignmentResult(
            aligned_sequences=[
                {"id": "protein-1", "name": "Kinase alpha", "sequence": "MPEPTIDE-"},
                {"id": "protein-3", "name": "Kinase beta", "sequence": "MPEPTIDEK"},
            ],
            alignment_length=9,
            num_sequences=2,
        )

    monkeypatch.setattr("src.managed_msa._execute_multiple_alignment", changed_identity)

    with pytest.raises(OperationExecutionError) as raised:
        await execute_managed_msa(_input(), threading.Event())
    assert raised.value.payload.code == "ALIGNMENT_INVALID_RESULT"


@pytest.mark.asyncio
async def test_msa_executor_does_not_retain_untrusted_engine_stderr(monkeypatch):
    async def failed_engine(*_args, **_kwargs):
        raise HTTPException(
            status_code=500,
            detail="MAFFT error: untrusted engine output MPEPTIDESECRET",
        )

    monkeypatch.setattr("src.managed_msa._execute_multiple_alignment", failed_engine)

    with pytest.raises(OperationExecutionError) as raised:
        await execute_managed_msa(_input(), threading.Event())
    assert raised.value.payload.code == "ALIGNMENT_FAILED"
    assert raised.value.payload.message == "Multiple-sequence alignment failed."
    assert "MPEPTIDESECRET" not in str(raised.value.payload)


@pytest.mark.parametrize(
    "sequences",
    [
        [
            {"id": f"protein-{index}", "sequence": "MPEPTIDE"}
            for index in range(MAX_MSA_SEQUENCE_COUNT + 1)
        ],
        [
            {"id": "protein-1", "sequence": "M" * (MAX_MSA_SEQUENCE_RESIDUES + 1)},
            {"id": "protein-2", "sequence": "MPEPTIDE"},
        ],
        [
            {"id": f"protein-{index}", "sequence": "M" * 100_000}
            for index in range(MAX_MSA_TOTAL_RESIDUES // 100_000 + 1)
        ],
        [
            {
                "id": f"protein-{index}",
                "sequence": "M" * (MAX_MSA_OUTPUT_CELLS // 10_000 + 1),
            }
            for index in range(100)
        ],
    ],
)
def test_msa_input_is_bounded_before_compute(sequences):
    with pytest.raises(ValidationError):
        MultipleSequenceAlignmentInput(sequences=sequences)


@pytest.mark.asyncio
async def test_run_msa_preserves_a_renderer_resolution_failure(monkeypatch):
    async def renderer_call(_name, _args, _context):
        return {
            "ok": True,
            "result": {"error": "Protein p1 has no sequence field."},
            "audit_id": "renderer-audit-1",
        }

    monkeypatch.setattr(
        "src.managed_msa_agent_tool.call_renderer_bridge", renderer_call
    )
    context = ToolContext(
        job_id="action-1",
        agent_identity_id="agent-a",
        agent_capabilities=["operations.start", "read-sequences"],
        cancel_event=asyncio.Event(),
    )

    with pytest.raises(ToolExecutionFailure) as raised:
        await start_managed_msa_handler({"proteinIds": ["p1", "p2"]}, context)
    assert raised.value.code == "MSA_INPUT_RESOLUTION_FAILED"
    assert str(raised.value) == "Protein p1 has no sequence field."


@pytest.mark.asyncio
async def test_run_msa_returns_the_managed_operation_before_compute_finishes(
    tmp_path, monkeypatch
):
    entered = asyncio.Event()
    release = asyncio.Event()

    async def annotation_executor(_value, _cancel):
        raise AssertionError("annotation executor must not run")

    async def genome_executor(_value, _cancel):
        raise AssertionError("genome executor must not run")

    async def msa_executor(value, cancel: threading.Event):
        entered.set()
        await release.wait()
        alignment_length = max(len(record.sequence) for record in value.sequences)
        return MultipleSequenceAlignmentResult(
            aligned_sequences=[
                {
                    "id": record.id,
                    "name": record.name,
                    "sequence": record.sequence.ljust(alignment_length, "-"),
                }
                for record in value.sequences
            ],
            alignment_length=alignment_length,
            num_sequences=len(value.sequences),
        )

    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    service = ManagedOperationService(
        store=store,
        runtime_scope="workspace-a",
        adapters=bind_test_executors(
            annotation_executor,
            {
                GENOME_INDEXING_OPERATION_KIND.key: genome_executor,
                MULTIPLE_SEQUENCE_ALIGNMENT_OPERATION_KIND.key: msa_executor,
            },
        ),
    )
    store.ensure_agent_identity(
        "agent-a",
        scope=["operations.start", "operations.read", "read-sequences"],
    )
    action_id = store.insert_agent_action(
        agent_identity_id="agent-a",
        tool_name="run_msa",
        parameters={"protein_ids": ["protein-1", "protein-2"]},
        authorized_scope=["operations.start", "operations.read", "read-sequences"],
    )

    async def renderer_call(_name, _args, _context):
        return {
            "ok": True,
            "result": {
                "subject_id": "msa:protein-1,protein-2",
                "input": _input().model_dump(mode="json"),
            },
            "audit_id": "renderer-audit-1",
        }

    monkeypatch.setattr(
        "src.managed_msa_agent_tool.call_renderer_bridge", renderer_call
    )
    context = ToolContext(
        job_id=action_id,
        agent_identity_id="agent-a",
        agent_capabilities=["operations.start", "operations.read", "read-sequences"],
        cancel_event=asyncio.Event(),
        managed_operations=service,
    )

    try:
        response = await asyncio.wait_for(
            start_managed_msa_handler(
                {"proteinIds": ["protein-1", "protein-2"]}, context
            ),
            timeout=0.2,
        )
        AlignmentAdmissionOutput.model_validate(response)
        operation_id = response["operationId"]
        assert response["ok"] is True
        assert response["result"]["id"] == operation_id
        assert response["result"]["kind"] == "multiple-sequence-alignment"
        assert response["result"]["state"] in {"queued", "running"}
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert (
            service.get(
                OperationPrincipal(
                    actor_kind=ActorKind.HUMAN,
                    actor_id="human-a",
                    channel=ClientChannel.DESKTOP_UI,
                    scope_ids={"workspace-a"},
                ),
                operation_id,
            ).state
            == OperationState.RUNNING
        )
        assert store.get_agent_action(action_id)["managed_operation_id"] == operation_id
    finally:
        release.set()
        await service.aclose()
        store.close()


@pytest.mark.skipif(shutil.which("mafft") is None, reason="MAFFT is not installed")
def test_http_start_runs_real_mafft_and_retains_the_typed_result(tmp_path, monkeypatch):
    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", "human-operation-secret")
    monkeypatch.setenv("DNAFORGE_OPERATION_SCOPE", "workspace-a")
    monkeypatch.setenv("DNAFORGE_OPERATION_OWNER_ID", "local-human")

    async def annotation_executor(_value, _cancel):
        raise AssertionError("annotation executor must not run")

    async def genome_executor(_value, _cancel):
        raise AssertionError("genome executor must not run")

    @asynccontextmanager
    async def lifespan(app):
        store = ControlPlaneStore(tmp_path / "http-control.sqlite3")
        store.initialize()
        service = ManagedOperationService(
            store=store,
            runtime_scope="workspace-a",
            adapters=bind_test_executors(
                annotation_executor,
                {
                    GENOME_INDEXING_OPERATION_KIND.key: genome_executor,
                    MULTIPLE_SEQUENCE_ALIGNMENT_OPERATION_KIND.key: execute_managed_msa,
                },
            ),
        )
        app.state.managed_operations = service
        try:
            yield
        finally:
            await service.aclose()
            store.close()

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(LocalAccessMiddleware)
    app.include_router(operations_router)
    with AuthenticatedSidecarTestClient(app) as client:
        client.headers["X-DNAForge-Operation-Authority"] = "human-operation-secret"
        started = client.post(
            "/operations/multiple-sequence-alignment",
            json=_submission("http-submission").model_dump(mode="json"),
        )
        assert started.status_code == 202, started.text
        operation_id = started.json()["id"]

        for _attempt in range(100):
            result = client.get(f"/operations/{operation_id}/result")
            if result.json()["status"] == "available":
                break
            time.sleep(0.02)
        else:
            raise AssertionError("Managed MSA result did not settle")

        payload = result.json()
        assert payload["kind"] == "multiple-sequence-alignment"
        assert payload["result"]["num_sequences"] == 2
        assert payload["result"]["alignment_length"] >= 9
        assert {record["id"] for record in payload["result"]["aligned_sequences"]} == {
            "protein-1",
            "protein-2",
        }
