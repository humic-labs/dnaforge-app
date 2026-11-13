from __future__ import annotations

import asyncio
from copy import deepcopy
from unittest.mock import AsyncMock

import pytest

from src.concurrency.tool_errors import ToolExecutionFailure
from src.concurrency.tool_registry import AgentToolRegistry, ToolContext
from src.concurrency.tool_validation import validate_tool_value
from src.control_plane import ControlPlaneStore
from src.managed_operations import MANAGED_OPERATION_SYSTEM
from src.managed_sequence_analysis_agent_tools import (
    register_sequence_analysis_agent_tools,
    start_clone_analysis,
    start_ngs_analysis,
    start_variant_calls,
)
from src.operations import (
    ActorKind,
    ClientChannel,
    ManagedOperationService,
    OperationPrincipal,
)
from src.operations.registration import ExecutableOperationKind


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name", ["analyze_clone", "start_variant_calls", "analyze_ngs_reads"]
)
async def test_sequence_analysis_uses_agent_owner_and_returns_before_compute(
    tmp_path, monkeypatch, name
):
    entered, release = asyncio.Event(), asyncio.Event()

    async def held_executor(value, cancel):
        entered.set()
        await release.wait()
        raise RuntimeError("Test deliberately ends without a computed result")

    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    service = ManagedOperationService(
        store=store,
        runtime_scope="workspace-a",
        adapters=MANAGED_OPERATION_SYSTEM.bind_executors(
            {
                package.key: held_executor
                for package in MANAGED_OPERATION_SYSTEM.packages
                if isinstance(package, ExecutableOperationKind)
            }
        ),
    )
    capabilities = [
        "operations.start",
        "operations.read",
        "read-workspace",
        "read-sequences",
        "create-entity",
        "modify-tabs",
    ]
    store.ensure_agent_identity("analysis-agent", scope=capabilities)
    action = store.insert_agent_action(
        agent_identity_id="analysis-agent",
        tool_name=name,
        parameters={},
        authorized_scope=capabilities,
    )
    context = ToolContext(
        job_id=action,
        agent_identity_id="analysis-agent",
        agent_capabilities=capabilities,
        cancel_event=asyncio.Event(),
        managed_operations=service,
    )
    path = tmp_path / ("reads.fastq" if name == "analyze_ngs_reads" else "calls.vcf")
    path.write_text(
        "@read-1\nACGT\n+\nIIII\n"
        if name == "analyze_ngs_reads"
        else "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n"
    )
    prepared = {
        "ok": True,
        "documentId": "sequence-1",
        "sessionId": "session-1",
        "chrom": "Cas9",
        "name": "Raw read review",
        "input": (
            {
                "referenceSequence": "ACGT" * 10,
                "queries": [{"id": "clone-1", "sequence": "ACGT" * 10}],
                "isCircular": True,
            }
            if name == "analyze_clone"
            else (
                {
                    "documentId": "sequence-1",
                    "readPath": str(path),
                    "referenceSequence": "ACGT" * 30,
                    "preset": "sr",
                }
                if name == "analyze_ngs_reads"
                else {
                    "variantPath": str(path),
                    "references": [{"name": "Cas9", "length": 40}],
                }
            )
        ),
    }
    renderer_calls = []
    child_ids = []

    async def renderer_call(tool, args, caller):
        renderer_calls.append((tool, args))
        assert caller.job_id != context.job_id
        assert caller.agent_identity_id == context.agent_identity_id
        child = store.get_agent_action(caller.job_id)
        assert child["parent_action_id"] == action
        assert child["root_action_id"] == action
        assert caller.job_id not in child_ids
        child_ids.append(caller.job_id)

        store.complete_agent_action(caller.job_id, result={"ok": True})
        assert store.get_agent_action(action)["completed_at"] is None
        return {
            "ok": True,
            "result": (
                prepared
                if tool == name
                else {
                    "ok": True,
                    "status": "active",
                    "operationId": args["operationId"],
                }
            ),
        }

    monkeypatch.setattr(
        "src.managed_sequence_analysis_agent_tools.call_renderer_bridge", renderer_call
    )
    try:
        handler = {
            "analyze_clone": start_clone_analysis,
            "start_variant_calls": start_variant_calls,
            "analyze_ngs_reads": start_ngs_analysis,
        }[name]
        response = await asyncio.wait_for(handler({}, context), timeout=2)
        registry = AgentToolRegistry()
        monkeypatch.setattr(
            "src.managed_sequence_analysis_agent_tools.agent_tool_registry", registry
        )
        register_sequence_analysis_agent_tools()
        registered = registry.require(name)
        assert registered.handler is handler
        validate_tool_value(response, registered.spec.outputs, output=True)
        await asyncio.wait_for(entered.wait(), timeout=2)
        snapshot = service.get(
            OperationPrincipal(
                actor_kind=ActorKind.AGENT,
                actor_id="analysis-agent",
                channel=ClientChannel.AGENT,
                scope_ids={"workspace-a"},
                capabilities=frozenset(capabilities),
            ),
            response["operationId"],
        )
        assert snapshot.actor_kind == ActorKind.AGENT
        assert snapshot.actor_id == "analysis-agent"
        assert snapshot.channel == ClientChannel.AGENT
        assert store.get_agent_action(action)["managed_operation_id"] == snapshot.id
        assert response["status"] in {"queued", "running"}
        if name == "analyze_clone":
            assert renderer_calls[-1] == (
                "get_clone_analysis",
                {
                    "documentId": "sequence-1",
                    "sessionId": "session-1",
                    "operationId": snapshot.id,
                },
            )
        elif name == "analyze_ngs_reads":
            assert renderer_calls[-1] == (
                "get_ngs_analysis",
                {
                    "documentId": "sequence-1",
                    "operationId": snapshot.id,
                    "name": "Raw read review",
                },
            )
            assert response["continuation"] == {
                "tool": "get_ngs_analysis",
                "arguments": renderer_calls[-1][1],
            }
            assert response["continuation"]["arguments"]["operationId"] != action
            for missing in ["continuation", "operationId", "name"]:
                incomplete = deepcopy(response)
                if missing == "continuation":
                    incomplete.pop(missing)
                else:
                    incomplete["continuation"]["arguments"].pop(missing)
                with pytest.raises(ToolExecutionFailure) as failure:
                    validate_tool_value(
                        incomplete, registered.spec.outputs, output=True
                    )
                assert failure.value.code == "INVALID_TOOL_OUTPUT"
            unexpected = deepcopy(response)
            unexpected["continuation"]["arguments"]["unexpected"] = True
            with pytest.raises(ToolExecutionFailure):
                validate_tool_value(unexpected, registered.spec.outputs, output=True)
        else:
            assert len(renderer_calls) == 1
    finally:
        release.set()
        await service.aclose()
        store.close()


@pytest.mark.asyncio
async def test_failed_input_resolution_never_starts_compute(monkeypatch):
    async def renderer_call(*args):
        return {"result": {"ok": False, "error": "The source is outside the project."}}

    monkeypatch.setattr(
        "src.managed_sequence_analysis_agent_tools._renderer_step", renderer_call
    )
    context = ToolContext(
        job_id="unadmitted",
        agent_identity_id="agent",
        agent_capabilities=[],
        cancel_event=asyncio.Event(),
    )
    with pytest.raises(ToolExecutionFailure, match="outside the project"):
        await start_clone_analysis({}, context)


@pytest.mark.asyncio
async def test_variant_input_never_starts_or_attaches_a_raw_read_job(
    tmp_path, monkeypatch
):
    source = tmp_path / "sample_reads.fastq.gz_withfiltering.vcf"
    source.write_text(
        "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n"
    )
    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()

    async def never_execute(value, cancel):
        raise AssertionError("Invalid raw-read input must not reach an executor")

    service = ManagedOperationService(
        store=store,
        runtime_scope="format-admission",
        adapters=MANAGED_OPERATION_SYSTEM.bind_executors(
            {
                package.key: never_execute
                for package in MANAGED_OPERATION_SYSTEM.packages
                if isinstance(package, ExecutableOperationKind)
            }
        ),
    )
    started = AsyncMock(wraps=service.start)
    monkeypatch.setattr(service, "start", started)
    prepared = {
        "result": {
            "ok": True,
            "documentId": "reference",
            "name": "A11 variants",
            "input": {
                "documentId": "reference",
                "readPath": str(source),
                "referenceSequence": "ACGT" * 30,
                "preset": "sr",
            },
        }
    }
    renderer = AsyncMock(return_value=prepared)
    monkeypatch.setattr(
        "src.managed_sequence_analysis_agent_tools._renderer_step", renderer
    )
    context = ToolContext(
        job_id="unadmitted",
        agent_identity_id="agent",
        agent_capabilities=[],
        cancel_event=asyncio.Event(),
        managed_operations=service,
    )
    try:
        with pytest.raises(
            ToolExecutionFailure, match="start_variant_calls.*import_variant_calls"
        ) as failure:
            await start_ngs_analysis({}, context)
        assert failure.value.code == "INVALID_RAW_READ_INPUT"
        started.assert_not_called()
        assert renderer.await_count == 1
    finally:
        await service.aclose()
        store.close()
