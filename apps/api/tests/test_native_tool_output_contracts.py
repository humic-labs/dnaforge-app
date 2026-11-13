import asyncio
from copy import deepcopy
from types import SimpleNamespace
from urllib.parse import unquote

import httpx
import pytest

from src import native_file_document_tools, native_workflow_tools
from src.concurrency import renderer_bridge
from src.concurrency.tool_errors import ToolExecutionFailure
from src.concurrency.tool_registry import AgentToolRegistry, ToolContext
from src.concurrency.tool_validation import validate_tool_value
from src.native_document_dispatch import NativeDocumentDispatchResult
from src.security.native_document_authority import NativeDocumentAuthority

_DOCUMENT = {
    "documentId": "document-a",
    "path": "/project/document.txt",
    "workspaceRoot": "/project",
    "revision": "revision-a",
    "persistedRevision": "revision-a",
    "ready": True,
    "readOnly": False,
    "dirty": False,
    "saving": False,
    "canUndo": False,
    "canRedo": False,
}
_SEQUENCE = {
    **_DOCUMENT,
    "path": "/project/sequence.gb",
    "version": 0,
    "savedVersion": 0,
    "length": 4,
    "annotationCount": 0,
    "capabilities": ["inspect", "save"],
    "bases": {"start": 0, "end": 4, "text": "ACGT"},
    "annotations": [],
    "nextAnnotationOffset": None,
}
_NOTEBOOK = {
    **_DOCUMENT,
    "path": "/project/notebook.md",
    "pageId": "page-a",
    "title": "Notebook",
    "canonicalFingerprint": "fingerprint-a",
    "version": 0,
    "editable": True,
    "blockCount": 1,
    "blocks": [
        {
            "index": 0,
            "block": {
                "type": "paragraph",
                "attrs": {"nested": {"values": ["retained", 1, True, None]}},
                "content": [{"type": "text", "text": "Retained native text"}],
            },
        }
    ],
    "nextOffset": None,
}
_CASES = [
    (
        "file_document",
        {"target": {"documentId": "document-a"}, "operation": {"kind": "inspect"}},
        {**_DOCUMENT, "type": "text", "capabilities": ["inspect"], "text": "bounded"},
    ),
    (
        "sequence_document",
        {"documentId": "document-a", "operation": {"kind": "inspect"}},
        _SEQUENCE,
    ),
    (
        "notebook_document",
        {"pageId": "page-a", "operation": {"kind": "inspect"}},
        _NOTEBOOK,
    ),
    (
        "search_workspace",
        {"query": "Retained"},
        {
            "query": "Retained",
            "projects": [{"name": "Project", "root": "/project"}],
            "results": [
                {
                    "entityId": "document-a",
                    "entityType": "file",
                    "name": "Retained",
                    "workspaceRoot": "/project",
                    "workspaceName": "Project",
                }
            ],
            "nextCursor": None,
        },
    ),
    (
        "project_history",
        {"project": "/project", "operation": {"kind": "inspect"}},
        {
            "status": "ok",
            "operation": "inspect",
            "inspection": {
                "workspaceRoot": "/project",
                "tracked": True,
                "head": "a" * 40,
                "branch": "main",
                "revision": "project-history-v1:" + "b" * 64,
                "entries": [],
                "totalEntries": 0,
                "nextOffset": None,
                "protectedStagedPaths": [],
            },
            "stateChanged": False,
            "paths": [],
            "warnings": [],
        },
    ),
    (
        "import_review",
        {
            "project": "/project",
            "operation": {
                "kind": "execute",
                "id": "review-a",
                "command": {"kind": "inspect"},
            },
        },
        {
            "id": "review-a",
            "revision": "review-revision-a",
            "workspaceRoot": "/project",
            "destinationDir": "/project/records",
            "phase": "review",
            "sourceName": "records.csv",
            "sourceFingerprint": "sha256:" + "c" * 64,
            "sourceKind": "csv",
            "columns": [],
            "totalRecords": 0,
            "records": [],
            "nextOffset": None,
            "canApply": False,
        },
    ),
    (
        "administration",
        {"operation": {"kind": "inspect-settings"}},
        {
            "kind": "settings",
            "snapshot": {
                "ownerId": "owner-a",
                "generation": 0,
                "revision": "settings-revision-a",
                "values": {
                    "theme": "light",
                    "displayZoom": 1,
                    "assemblyColorScheme": "tailwind",
                    "webglPerformance": "auto",
                },
                "adopted": [],
                "persistence": "saved",
                "unsavedKeys": [],
            },
            "stateChanged": False,
        },
    ),
]


@pytest.fixture
def native_outputs(monkeypatch):
    registry = AgentToolRegistry()
    for module in (native_file_document_tools, native_workflow_tools):
        monkeypatch.setattr(module, "agent_tool_registry", registry)
    native_file_document_tools.register_native_file_document_tool()
    native_workflow_tools.register_native_workflow_tools()
    return registry


@pytest.fixture
def native_runtime(monkeypatch):
    state = {"result": {}, "calls": [], "disposition": "completed"}
    agent = {"identityId": "caller", "capabilities": ["*"]}
    store = SimpleNamespace(get_agent_identity=lambda _: {"id": "caller"})
    monkeypatch.setattr(native_workflow_tools, "_current_agent", lambda *_: agent)
    monkeypatch.setattr(native_file_document_tools, "check_grant", lambda *_: None)
    monkeypatch.setattr(
        native_file_document_tools, "get_control_plane_store", lambda: store
    )
    monkeypatch.setattr(
        native_file_document_tools,
        "resolve_identity_context",
        lambda *_, **__: {"effective_capabilities": ["*"]},
    )

    async def dispatch(authority, command):
        state["calls"].append(command)
        return NativeDocumentDispatchResult(
            state["disposition"], result=state["result"], reason="Owner refused"
        )

    for module in (native_file_document_tools, native_workflow_tools):
        monkeypatch.setattr(module, "dispatch_native_document_command", dispatch)
    context = ToolContext(
        job_id="action-a",
        agent_identity_id="caller",
        agent_capabilities=["*"],
        cancel_event=asyncio.Event(),
        native_document_authority=NativeDocumentAuthority(
            "private-test-authority", "owner-a", "http://127.0.0.1:43210"
        ),
    )
    return state, context


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,result", _CASES, ids=[case[0] for case in _CASES])
async def test_actual_native_success_matches_effective_registered_contract(
    native_outputs, native_runtime, name, args, result
):
    state, context = native_runtime
    state["result"] = deepcopy(result)
    tool = native_outputs.require(name)
    returned = await tool.handler(args, context)
    assert returned == {"ok": True, "result": {**result, "ok": True}}
    validate_tool_value(returned, tool.spec.outputs, output=True)
    canonical = next(
        config
        for config in renderer_bridge.RENDERER_TOOL_SPECS
        if config["name"] == name
    )
    assert tool.spec.outputs == canonical["outputs"]
    assert "ok" not in state["result"]


@pytest.mark.parametrize("name,args,result", _CASES, ids=[case[0] for case in _CASES])
def test_effective_native_contract_refuses_missing_or_false_success(
    native_outputs, name, args, result
):
    schema = native_outputs.require(name).spec.outputs
    for malformed in (
        {"ok": True, "result": {"ok": True}},
        {"ok": False, "result": {**result, "ok": True}},
        {"ok": True, "result": {**result, "ok": False}},
        {**result, "ok": True},
    ):
        with pytest.raises(ToolExecutionFailure) as raised:
            validate_tool_value(malformed, schema, output=True)
        assert raised.value.code == "INVALID_TOOL_OUTPUT"


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,result", _CASES, ids=[case[0] for case in _CASES])
async def test_native_refusal_cannot_be_normalized_into_success(
    native_outputs, native_runtime, name, args, result
):
    state, context = native_runtime
    state["result"] = {
        "ok": False,
        "code": "OWNER_REFUSED",
        "error": "The owner refused the original operation.",
        "stateChanged": False,
    }
    with pytest.raises(ToolExecutionFailure) as raised:
        await native_outputs.require(name).handler(args, context)
    assert raised.value.code == "OWNER_REFUSED"
    assert raised.value.retriable is False
    assert raised.value.details["stateChanged"] is False


@pytest.mark.asyncio
async def test_legacy_file_renderer_envelope_retains_audit_identity(
    native_outputs, native_runtime, monkeypatch
):
    state, context = native_runtime
    response = {
        "ok": True,
        "result": {
            "ok": True,
            "path": "/project/legacy.txt",
            "type": "text",
            "revision": "legacy-revision",
            "ready": True,
            "readOnly": False,
            "dirty": False,
            "text": "Retained legacy text",
        },
        "audit_id": "renderer-audit-a",
    }
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_URL", "http://127.0.0.1:43211")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "synthetic-test-session")
    monkeypatch.setattr(
        renderer_bridge,
        "get_control_plane_store",
        lambda: SimpleNamespace(get_agent_identity=lambda _: None),
    )

    async def post(*_, **__):
        return httpx.Response(200, json=response)

    async def renderer(name, args, received):
        return await renderer_bridge.call_renderer_bridge(
            name, args, received, post=post
        )

    monkeypatch.setattr(native_file_document_tools, "call_renderer_bridge", renderer)
    tool = native_outputs.require("file_document")
    returned = await tool.handler(
        {"tabId": "legacy-tab", "operation": {"kind": "inspect"}}, context
    )
    assert returned == response
    validate_tool_value(returned, tool.spec.outputs, output=True)
    assert state["calls"] == []


def test_canonical_nested_and_recursive_refs_resolve_inside_effective_envelope(
    native_outputs,
):
    references = []

    def visit(value, root):
        if isinstance(value, list):
            for child in value:
                visit(child, root)
        elif isinstance(value, dict):
            if "$ref" in value:
                reference = value["$ref"]
                references.append(reference)
                assert reference == "#" or reference.startswith("#/"), reference
                target = root
                if reference != "#":
                    for component in unquote(reference[2:]).split("/"):
                        key = component.replace("~1", "/").replace("~0", "~")
                        target = (
                            target[int(key)]
                            if isinstance(target, list)
                            else target[key]
                        )
                assert isinstance(target, (dict, bool))
            for child in value.values():
                visit(child, root)

    for tool in native_outputs.list():
        visit(tool.spec.outputs, tool.spec.outputs)
    assert references
    schema = native_outputs.require("notebook_document").spec.outputs
    valid = {"ok": True, "result": {**deepcopy(_NOTEBOOK), "ok": True}}
    validate_tool_value(valid, schema, output=True)
    valid["result"]["blocks"][0]["block"]["content"] = {"type": "text"}
    with pytest.raises(ToolExecutionFailure) as raised:
        validate_tool_value(valid, schema, output=True)
    assert raised.value.code == "INVALID_TOOL_OUTPUT"
