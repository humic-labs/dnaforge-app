from __future__ import annotations

import asyncio
import json

import pytest

from src.concurrency.tool_errors import ToolExecutionFailure
from src.concurrency.tool_registry import ToolContext
from src.managed_annotation_document_tools import (
    apply_managed_annotation_document_handler,
    inspect_managed_annotation_document_handler,
)
from src.native_document_dispatch import NativeDocumentDispatchResult
from src.security.native_document_authority import NativeDocumentAuthority
from tests.test_annotation_document_actions import (
    CAPABILITIES,
    inspection_result,
)
from tests.test_annotation_document_actions import runtime as annotation_runtime

runtime = annotation_runtime


@pytest.fixture
def scoped_agent(runtime, tmp_path, monkeypatch):
    store, _, _, selection = runtime
    project_a = (tmp_path / "project-a").resolve()
    project_a.mkdir()
    identity = "dna5047-project-a-agent"
    store.create_agent_identity(
        identity_id=identity,
        parent_human_identity_id="human-a",
        scope=sorted(CAPABILITIES),
        kind="stdio-mcp",
        origin="local-mcp",
        environment_id="runtime-a",
    )
    assert store.bind_local_mcp_workspace(
        identity,
        workspace_id="folder:" + json.dumps(str(project_a)),
        workspace_label="Project A only",
    )
    monkeypatch.setattr("src.control_plane.store._STORE", store)
    action_id = store.insert_agent_action(
        agent_identity_id=identity,
        tool_name="operations.annotation.inspect",
        parameters={},
    )
    context = ToolContext(
        job_id=action_id,
        agent_identity_id=identity,
        agent_capabilities=sorted(CAPABILITIES),
        cancel_event=asyncio.Event(),
        managed_operations=runtime[1],
        native_document_authority=NativeDocumentAuthority(
            "dna5047-fixture-native-token",
            "native-owner-a",
            "http://127.0.0.1:43210",
        ),
    )
    return (
        store,
        context,
        selection,
        {"kind": "project-roots", "roots": [str(project_a)]},
    )


@pytest.mark.asyncio
async def test_dna5047_inspection_preserves_real_frozen_grant_scope(
    scoped_agent, monkeypatch
):
    store, context, retained_target, expected_scope = scoped_agent
    sent = []

    async def dispatch(_authority, command):
        sent.append(command)
        return NativeDocumentDispatchResult(
            "completed", result=inspection_result(command, retained_target)
        )

    monkeypatch.setattr(
        "src.managed_annotation_document_tools.dispatch_native_document_command",
        dispatch,
    )
    result = await inspect_managed_annotation_document_handler(
        {
            "operationId": retained_target.operation_id,
            "targetDocumentId": retained_target.target_document_id,
        },
        context,
    )
    assert result["ok"] is True
    assert len(sent) == 1
    assert sent[0].get("projectScope") == expected_scope
    assert not store.has_pending_managed_document_action(retained_target.operation_id)


@pytest.mark.asyncio
async def test_dna5047_apply_preserves_real_frozen_grant_scope(
    scoped_agent, monkeypatch
):
    store, context, retained_target, expected_scope = scoped_agent
    sent = []

    async def dispatch(_authority, command):
        sent.append(command)
        return NativeDocumentDispatchResult(
            "refused", reason="Fixture stops native publication"
        )

    monkeypatch.setattr(
        "src.managed_annotation_document_tools.dispatch_native_document_command",
        dispatch,
    )
    with pytest.raises(ToolExecutionFailure) as failure:
        await apply_managed_annotation_document_handler(
            retained_target.model_dump(by_alias=True), context
        )
    assert failure.value.code == "MANAGED_ANNOTATION_APPLY_BLOCKED"
    assert len(sent) == 1
    assert sent[0].get("projectScope") == expected_scope
    actions = store.page_managed_operation_actions(retained_target.operation_id)[0]
    assert len(actions) == 1
    assert actions[0]["actor_id"] == context.agent_identity_id
    assert actions[0]["outcome"] == "document_blocked"


@pytest.mark.asyncio
async def test_dna5047_revoked_grant_never_dispatches_annotation(
    scoped_agent, monkeypatch
):
    store, context, retained_target, _ = scoped_agent
    store.revoke_agent_identity(context.agent_identity_id)
    sent = []

    async def dispatch(_authority, command):
        sent.append(command)
        raise AssertionError(
            "A revoked grant must not reach native annotation dispatch"
        )

    monkeypatch.setattr(
        "src.managed_annotation_document_tools.dispatch_native_document_command",
        dispatch,
    )
    with pytest.raises(ToolExecutionFailure) as failure:
        await inspect_managed_annotation_document_handler(
            {
                "operationId": retained_target.operation_id,
                "targetDocumentId": retained_target.target_document_id,
            },
            context,
        )
    assert failure.value.code == "OPERATION_ACCESS_DENIED"
    assert sent == []
