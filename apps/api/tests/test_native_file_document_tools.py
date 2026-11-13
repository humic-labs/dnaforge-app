import asyncio
from types import SimpleNamespace

import pytest

from src.concurrency.renderer_bridge import RENDERER_TOOL_SPECS
from src.concurrency.tool_errors import ToolExecutionFailure
from src.concurrency.tool_registry import ToolContext
from src.native_document_dispatch import NativeDocumentDispatchResult
from src.native_file_document_tools import _required, native_file_document_handler
from src.security.native_document_authority import NativeDocumentAuthority


@pytest.fixture
def runtime(monkeypatch):
    state = {
        "scope": ["read-workspace", "write-workspace"],
        "dispatches": [],
        "revoked": False,
    }
    store = SimpleNamespace(
        get_agent_identity=lambda _: {"id": "agent-a", "scope_json": state["scope"]}
    )
    monkeypatch.setattr(
        "src.native_file_document_tools.get_control_plane_store", lambda: store
    )
    monkeypatch.setattr(
        "src.native_file_document_tools.check_grant",
        lambda _: (
            {"error": {"code": "GRANT_REVOKED", "message": "Revoked"}}
            if state["revoked"]
            else None
        ),
    )

    async def dispatch(authority, command):
        state["dispatches"].append(command)
        return NativeDocumentDispatchResult(
            "completed",
            result={
                "documentId": "file-a",
                "revision": "current",
                "text": "bounded",
                "dirty": False,
                "content": "entire private buffer",
                "persistedContent": "entire saved buffer",
                "diskContent": "entire native baseline",
                "tableData": {"allRows": []},
            },
        )

    monkeypatch.setattr(
        "src.native_file_document_tools.dispatch_native_document_command", dispatch
    )
    context = ToolContext(
        job_id="action-a",
        agent_identity_id="agent-a",
        agent_capabilities=["read-workspace", "write-workspace"],
        cancel_event=asyncio.Event(),
        native_document_authority=NativeDocumentAuthority(
            "private", "owner-a", "http://127.0.0.1:43210"
        ),
    )
    return state, context


@pytest.mark.asyncio
async def test_closed_file_uses_native_owner_and_returns_only_public_inspection(
    runtime,
):
    state, context = runtime
    result = await native_file_document_handler(
        {"target": {"path": "/project/closed.txt"}, "operation": {"kind": "inspect"}},
        context,
    )
    assert result == {
        "ok": True,
        "result": {
            "ok": True,
            "documentId": "file-a",
            "revision": "current",
            "text": "bounded",
            "dirty": False,
        },
    }
    assert state["dispatches"] == [
        {
            "command": "file.execute",
            "agent": {
                "identityId": "agent-a",
                "capabilities": ["read-workspace", "write-workspace"],
            },
            "request": {
                "target": {"path": "/project/closed.txt"},
                "operation": {"kind": "inspect"},
                "requestId": "action-a",
            },
        }
    ]


def _file_operation_kinds(schema):
    for keyword in ("anyOf", "oneOf", "allOf"):
        for branch in schema.get(keyword, []):
            yield from _file_operation_kinds(branch)
    properties = schema.get("properties", {})
    if "operation" in properties:
        yield from _file_operation_kinds(properties["operation"])
    elif "const" in properties.get("kind", {}):
        yield properties["kind"]["const"]


@pytest.mark.parametrize(
    "kind",
    sorted(
        set(
            _file_operation_kinds(
                next(
                    spec["inputs"]
                    for spec in RENDERER_TOOL_SPECS
                    if spec["name"] == "file_document"
                )
            )
        )
    ),
)
def test_every_advertised_file_operation_reaches_gateway_authorization(kind):
    assert "read-workspace" in _required({"operation": {"kind": kind}})


@pytest.mark.asyncio
async def test_exact_text_replacement_reaches_native_owner_with_current_authority(
    runtime,
):
    state, context = runtime
    operation = {
        "kind": "replace-string",
        "oldText": "agent draft",
        "newText": "agent durable",
    }
    result = await native_file_document_handler(
        {
            "target": {"documentId": "file-a"},
            "expectedRevision": "current",
            "operation": operation,
        },
        context,
    )
    assert result["ok"] is True
    assert state["dispatches"][0]["request"] == {
        "target": {"documentId": "file-a"},
        "expectedRevision": "current",
        "operation": operation,
        "requestId": "action-a",
    }
    assert state["dispatches"][0]["agent"]["capabilities"] == [
        "read-workspace",
        "write-workspace",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation",
    [
        {"kind": "save"},
        {
            "kind": "replace-string",
            "oldText": "agent draft",
            "newText": "agent durable",
        },
    ],
)
async def test_current_grant_refuses_removed_write_authority_before_native_dispatch(
    runtime,
    operation,
):
    state, context = runtime
    state["scope"] = ["read-workspace"]
    with pytest.raises(ToolExecutionFailure) as raised:
        await native_file_document_handler(
            {
                "target": {"documentId": "file-a"},
                "operation": operation,
                "expectedRevision": "current",
            },
            context,
        )
    assert raised.value.code == "INSUFFICIENT_SCOPE"
    assert state["dispatches"] == []


@pytest.mark.asyncio
async def test_revoked_grant_and_renderer_internal_operations_cannot_reach_native_owner(
    runtime,
):
    state, context = runtime
    state["revoked"] = True
    with pytest.raises(ToolExecutionFailure) as raised:
        await native_file_document_handler(
            {"target": {"documentId": "file-a"}, "operation": {"kind": "inspect"}},
            context,
        )
    assert raised.value.code == "GRANT_REVOKED"
    state["revoked"] = False
    with pytest.raises(ToolExecutionFailure) as raised:
        await native_file_document_handler(
            {
                "target": {"documentId": "file-a"},
                "operation": {"kind": "replace-table", "data": {}},
            },
            context,
        )
    assert raised.value.code == "INVALID_FILE_DOCUMENT_REQUEST"
    assert state["dispatches"] == []


@pytest.mark.asyncio
async def test_legacy_tab_identity_remains_an_explicit_graphical_adapter(
    runtime, monkeypatch
):
    state, context = runtime
    calls = []

    async def renderer(name, args, received):
        calls.append((name, args, received.job_id))
        return {"ok": True, "result": {"documentId": "file-a"}}

    monkeypatch.setattr("src.native_file_document_tools.call_renderer_bridge", renderer)
    args = {"tabId": "tab-a", "operation": {"kind": "inspect"}}
    assert await native_file_document_handler(args, context) == {
        "ok": True,
        "result": {"documentId": "file-a"},
    }
    assert calls == [("file_document", args, "action-a")]
    assert state["dispatches"] == []


@pytest.mark.asyncio
async def test_uncertain_native_save_never_authorizes_an_automatic_repeat(
    runtime, monkeypatch
):
    _, context = runtime

    async def dispatch(*_):
        return NativeDocumentDispatchResult(
            "outcome-unresolved", reason="Native acknowledgement lost"
        )

    monkeypatch.setattr(
        "src.native_file_document_tools.dispatch_native_document_command", dispatch
    )
    with pytest.raises(ToolExecutionFailure) as raised:
        await native_file_document_handler(
            {
                "target": {"documentId": "file-a"},
                "operation": {"kind": "save"},
                "expectedRevision": "current",
            },
            context,
        )
    assert raised.value.code == "OUTCOME_UNRESOLVED"
    assert raised.value.retriable is False
    assert raised.value.details["requestId"] == "action-a"


@pytest.mark.asyncio
async def test_dirty_inventory_is_native_read_only_without_a_target_or_action_identity(
    runtime,
):
    state, context = runtime
    state["scope"] = ["read-workspace"]
    await native_file_document_handler(
        {"project": "/project", "operation": {"kind": "list-dirty", "limit": 10}},
        context,
    )
    assert state["dispatches"][0]["request"] == {
        "project": "/project",
        "operation": {"kind": "list-dirty", "limit": 10},
    }
    assert state["dispatches"][0]["agent"]["capabilities"] == ["read-workspace"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation",
    [
        {"kind": "table", "command": {"kind": "inspect"}},
        {"kind": "notebook", "command": {"kind": "inspect"}},
        {"kind": "notebook", "command": {"kind": "schema"}},
        {
            "kind": "notebook",
            "command": {
                "kind": "table",
                "tableId": "table-a",
                "command": {"kind": "inspect"},
            },
        },
    ],
)
async def test_typed_file_inspection_uses_current_read_only_authority(
    runtime, operation
):
    state, context = runtime
    state["scope"] = ["read-workspace"]
    await native_file_document_handler(
        {"target": {"documentId": "file-a"}, "operation": operation}, context
    )
    assert state["dispatches"][0]["request"]["operation"] == operation
    assert state["dispatches"][0]["agent"]["capabilities"] == ["read-workspace"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation",
    [
        {"kind": "table", "command": {"kind": "add-row"}},
        {"kind": "notebook", "command": {"kind": "rename", "title": "Changed"}},
        {
            "kind": "notebook",
            "command": {
                "kind": "table",
                "tableId": "table-a",
                "command": {"kind": "add-row"},
            },
        },
    ],
)
async def test_typed_file_mutations_still_require_current_write_authority(
    runtime, operation
):
    state, context = runtime
    state["scope"] = ["read-workspace"]
    with pytest.raises(ToolExecutionFailure) as raised:
        await native_file_document_handler(
            {"target": {"documentId": "file-a"}, "operation": operation}, context
        )
    assert raised.value.code == "INSUFFICIENT_SCOPE"
    assert state["dispatches"] == []
