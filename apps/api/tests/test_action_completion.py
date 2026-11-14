import sqlite3
import time

import pytest

from src.concurrency import register_builtin_agent_tools
from src.concurrency.dispatcher import dispatch_tool
from src.concurrency.job_manager import reset_job_manager
from src.concurrency.tool_errors import ToolExecutionFailure
from src.concurrency.tool_registry import agent_tool_registry
from src.control_plane import initialize_control_plane


def test_completion_requires_admitted_owner_and_never_replaces_settled_result(tmp_path):
    store = initialize_control_plane(tmp_path / "completion.sqlite3")
    store.ensure_agent_identity("agent", scope=[])
    action_id = store.insert_agent_action(
        agent_identity_id="agent",
        tool_name="get_workspace",
        parameters={},
        completion_owner="renderer",
    )
    result = {"ok": True, "result": {"workspace": "original"}}
    assert not store.complete_agent_action(action_id, result=result)
    assert store.get_agent_action(action_id)["completion_state"] == "pending"
    store.reconcile_interrupted_agent_action(
        action_id,
        error={"code": "OUTCOME_UNRESOLVED"},
        terminal_expires_at=time.time() + 60,
    )
    assert store.get_agent_action(action_id)["completion_state"] == "unresolved"
    assert store.complete_agent_action(
        action_id, result=result, completion_owner="renderer"
    )
    before = store.get_agent_action(action_id)
    assert not store.complete_agent_action(
        action_id, result=result, completion_owner="renderer"
    )
    assert not store.complete_agent_action(
        action_id, error={"code": "LATE"}, completion_owner="renderer"
    )
    store.reconcile_interrupted_agent_action(
        action_id,
        error={"code": "OUTCOME_UNRESOLVED"},
        terminal_expires_at=time.time() + 120,
    )
    assert store.get_agent_action(action_id) == before


def test_legacy_completion_metadata_migrates_once_without_changing_outcomes(tmp_path):
    path = tmp_path / "legacy.sqlite3"
    store = initialize_control_plane(path)
    store.ensure_agent_identity("agent", scope=[])
    cases = [
        ("get_workspace", {}, "renderer", "settled"),
        ("open_tab", {}, "renderer", "unresolved"),
        ("search_primer_matches", {}, "job", "pending"),
        (
            "file_document",
            {"tabId": "tab", "operation": {"kind": "inspect"}},
            "renderer",
            "pending",
        ),
        (
            "file_document",
            {"target": {"documentId": "doc"}, "operation": {"kind": "inspect"}},
            "job",
            "pending",
        ),
    ]
    actions = []
    for name, args, owner, state in cases:
        action_id = store.insert_agent_action(
            agent_identity_id="agent", tool_name=name, parameters=args
        )
        if state == "settled":
            store.complete_agent_action(
                action_id, result={"ok": True, "result": {"retained": True}}
            )
        elif state == "unresolved":
            store.reconcile_interrupted_agent_action(
                action_id, error={"code": "OUTCOME_UNRESOLVED"}, terminal_expires_at=123
            )
        before = store.get_agent_action(action_id)
        before.pop("completion_owner")
        before.pop("completion_state")
        actions.append((action_id, owner, state, before))
    with sqlite3.connect(path) as legacy:
        legacy.execute("ALTER TABLE agent_action DROP COLUMN completion_owner")
        legacy.execute("ALTER TABLE agent_action DROP COLUMN completion_state")
    for _ in range(2):
        store = initialize_control_plane(path)
        for action_id, owner, state, before in actions:
            after = store.get_agent_action(action_id)
            assert after.pop("completion_owner") == owner
            assert after.pop("completion_state") == state
            assert after == before


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "args,owner",
    [
        ({"tabId": "tab", "operation": {"kind": "inspect"}}, "renderer"),
        ({"target": {"documentId": "doc"}, "operation": {"kind": "inspect"}}, "job"),
        ({"operation": {"kind": "list-dirty"}}, "job"),
    ],
)
async def test_file_document_persists_selected_owner_before_handler(
    tmp_path, args, owner
):
    store = initialize_control_plane(tmp_path / "file.sqlite3")
    reset_job_manager()
    agent_tool_registry.clear()
    register_builtin_agent_tools()
    registered = agent_tool_registry.require("file_document")
    observed = []

    async def handler(args, context):
        observed.append(store.get_agent_action(context.job_id)["completion_owner"])
        raise ToolExecutionFailure(
            code="PROBE_FINISHED", message="Ownership recorded", retriable=False
        )

    registered.handler = handler
    await dispatch_tool("file_document", args, agent_capabilities=["read-workspace"])
    assert observed == [owner]
    reset_job_manager()
