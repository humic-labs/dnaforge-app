from __future__ import annotations

import asyncio

import pytest

from src.concurrency.renderer_bridge import register_renderer_agent_tools
from src.concurrency.tool_errors import ToolExecutionFailure
from src.concurrency.tool_registry import ToolContext, agent_tool_registry
from src.managed_annotation_agent_tools import (
    managed_operation_audit_result,
    register_managed_annotation_agent_tools,
)
from src.managed_annotation_document_tools import (
    AnnotationApplyToolOutput,
    AnnotationInspectionToolOutput,
    apply_managed_annotation_document_handler,
    inspect_managed_annotation_document_handler,
    register_managed_annotation_document_tools,
)
from src.managed_msa_agent_tool import register_managed_msa_agent_tool
from src.managed_primer_match_agent_tool import register_managed_primer_match_agent_tool
from src.managed_sequence_analysis_agent_tools import (
    register_sequence_analysis_agent_tools,
)
from src.native_document_dispatch import NativeDocumentDispatchResult
from src.native_file_document_tools import register_native_file_document_tool
from src.native_workflow_tools import register_native_workflow_tools
from src.security.native_document_authority import NativeDocumentAuthority
from tests.test_annotation_document_actions import (
    CAPABILITIES,
    inspection_result,
    write_intent,
)
from tests.test_annotation_document_actions import (
    runtime as document_runtime,
)

runtime = document_runtime


def context_for(runtime):
    store, service, _, _ = runtime
    job_id = store.insert_agent_action(
        agent_identity_id="agent-a",
        tool_name="operations.annotation.apply",
        parameters={},
    )
    return ToolContext(
        job_id=job_id,
        agent_identity_id="agent-a",
        agent_capabilities=sorted(CAPABILITIES),
        cancel_event=asyncio.Event(),
        managed_operations=service,
        native_document_authority=NativeDocumentAuthority(
            "native-private", "native-owner-a", "http://127.0.0.1:43210"
        ),
    )


def test_native_canonical_and_provider_alias_keep_the_same_owner_and_audit_policy():
    agent_tool_registry.clear()
    try:
        register_managed_annotation_agent_tools()
        register_managed_annotation_document_tools()
        register_managed_msa_agent_tool()
        register_managed_primer_match_agent_tool()
        register_sequence_analysis_agent_tools()
        register_native_file_document_tool()
        register_native_workflow_tools()
        register_renderer_agent_tools()
        for command in ("inspect", "apply"):
            canonical = agent_tool_registry.require(f"operations.annotation.{command}")
            alias = agent_tool_registry.require(f"operations_annotation_{command}")
            assert canonical.spec.home == alias.spec.home == "native"
            assert canonical.handler is alias.handler
            assert canonical.replay_policy == alias.replay_policy == "execute"
            assert canonical.audit_result_projector is managed_operation_audit_result
            assert alias.audit_result_projector is managed_operation_audit_result
    finally:
        agent_tool_registry.clear()


@pytest.mark.asyncio
async def test_agent_inspection_needs_only_read_authority_and_reserves_no_write(
    runtime, monkeypatch
):
    store, _, _, selection = runtime
    context = context_for(runtime)
    context.agent_capabilities.remove("write-workspace")

    async def dispatch(_authority, command):
        assert command["command"] == "annotation.inspect"
        return NativeDocumentDispatchResult(
            "completed", result=inspection_result(command, selection)
        )

    monkeypatch.setattr(
        "src.managed_annotation_document_tools.dispatch_native_document_command",
        dispatch,
    )
    inspected = await inspect_managed_annotation_document_handler(
        {
            "operationId": selection.operation_id,
            "targetDocumentId": selection.target_document_id,
        },
        context,
    )
    AnnotationInspectionToolOutput.model_validate(inspected)
    assert inspected["result"]["applicable"] is True
    assert not store.has_pending_managed_document_action(selection.operation_id)
    with pytest.raises(ToolExecutionFailure) as failure:
        await apply_managed_annotation_document_handler(
            selection.model_dump(by_alias=True), context
        )
    assert failure.value.code == "OPERATION_ACCESS_DENIED"


@pytest.mark.asyncio
@pytest.mark.parametrize("reply", ["saved", "lost-after-save", "unresolved", "blocked"])
async def test_agent_apply_uses_the_common_journal_and_actual_principal(
    runtime, monkeypatch, reply
):
    store, _, actions, selection = runtime
    context = context_for(runtime)
    sent = []

    async def dispatch(_authority, command):
        sent.append(command)
        action_id = command["request"]["actionId"]
        if reply == "blocked":
            return NativeDocumentDispatchResult("refused", reason="Unsaved edits")
        if reply == "unresolved":
            return NativeDocumentDispatchResult("outcome-unresolved")
        intent = write_intent(selection)
        assert actions.begin_write(action_id, selection, intent).status == "permitted"
        actions.journal.settle(
            action_id=action_id,
            request_sha256=selection.request_sha256(),
            status="saved",
            observed_sha256=intent.after_sha256,
            target_revision=intent.target_revision,
            checkpoint={"status": "committed", "commit": "b" * 40},
        )
        return NativeDocumentDispatchResult(
            "outcome-unresolved" if reply == "lost-after-save" else "completed",
            result=(
                None
                if reply == "lost-after-save"
                else {
                    "status": "saved",
                    "targetDocumentRevision": intent.target_revision,
                    "checkpoint": {"status": "committed", "commit": "b" * 40},
                    "display": "refreshed",
                    "lineage": "recorded",
                }
            ),
        )

    monkeypatch.setattr(
        "src.managed_annotation_document_tools.dispatch_native_document_command",
        dispatch,
    )
    if reply in {"blocked", "unresolved"}:
        with pytest.raises(ToolExecutionFailure) as failure:
            await apply_managed_annotation_document_handler(
                selection.model_dump(by_alias=True), context
            )
        assert failure.value.code == (
            "OUTCOME_UNRESOLVED"
            if reply == "unresolved"
            else "MANAGED_ANNOTATION_APPLY_BLOCKED"
        )
        assert failure.value.details["actionId"] == sent[0]["request"]["actionId"]
        assert failure.value.details["stateMayHaveChanged"] == (reply == "unresolved")
        assert failure.value.retriable is False
    else:
        result = await apply_managed_annotation_document_handler(
            selection.model_dump(by_alias=True), context
        )
        AnnotationApplyToolOutput.model_validate(result)
        assert result["result"]["status"] == "saved"
        assert result["result"]["display"] == (
            "pending" if reply == "lost-after-save" else "refreshed"
        )
        assert result["result"].get("lineage") == (
            None if reply == "lost-after-save" else "recorded"
        )
        projection = managed_operation_audit_result(result)
        assert projection["document_action_id"] == result["actionId"]
        assert projection["operation_id"] == selection.operation_id
        assert "Recorded candidate" not in str(projection)
    assert len(sent) == 1
    action = store.get_managed_operation_action(sent[0]["request"]["actionId"])
    assert (action["actor_kind"], action["actor_id"], action["channel"]) == (
        "agent",
        "agent-a",
        "agent",
    )
    assert (
        store.get_agent_action(context.job_id)["managed_operation_id"]
        == selection.operation_id
    )
    assert store.has_pending_managed_document_action(selection.operation_id) == (
        reply == "unresolved"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["missing-owner", "forged-actor", "changed-version"])
async def test_refused_agent_commands_never_dispatch_or_reserve(
    runtime, monkeypatch, change
):
    store, _, _, selection = runtime
    context = context_for(runtime)
    args = selection.model_dump(by_alias=True)
    if change == "missing-owner":
        context.native_document_authority = None
    elif change == "forged-actor":
        args["actor_id"] = "human-a"
    else:
        args["expectedOperationVersion"] += 1

    async def never_dispatch(*_args):
        pytest.fail("Refused input must not reach native execution")

    monkeypatch.setattr(
        "src.managed_annotation_document_tools.dispatch_native_document_command",
        never_dispatch,
    )
    with pytest.raises(ToolExecutionFailure):
        await apply_managed_annotation_document_handler(args, context)
    assert not store.has_pending_managed_document_action(selection.operation_id)
