import asyncio
import json
from types import SimpleNamespace

import pytest

from src.concurrency.tool_errors import ToolExecutionFailure
from src.concurrency.tool_registry import ToolContext
from src.native_document_dispatch import NativeDocumentDispatchResult
from src.native_workflow_tools import (
    administration_audit_parameters,
    administration_audit_result,
    execute_native_workflow,
)
from src.security.native_document_authority import NativeDocumentAuthority


@pytest.fixture
def native(monkeypatch):
    state = {
        "scope": ["read-workspace", "write-workspace"],
        "calls": [],
        "revoked": False,
    }
    monkeypatch.setattr(
        "src.native_workflow_tools.check_grant",
        lambda _: (
            {"error": {"code": "GRANT_REVOKED", "message": "Revoked"}} if state["revoked"] else None
        ),
    )
    monkeypatch.setattr(
        "src.native_workflow_tools.get_control_plane_store",
        lambda: SimpleNamespace(
            get_agent_identity=lambda _: {"id": "caller", "scope_json": state["scope"]}
        ),
    )

    async def dispatch(authority, command):
        state["calls"].append(command)
        return NativeDocumentDispatchResult(
            "completed", result=state.get("result", {"revision": "current"})
        )

    monkeypatch.setattr("src.native_workflow_tools.dispatch_native_document_command", dispatch)
    context = ToolContext(
        job_id="action",
        agent_identity_id="caller",
        agent_capabilities=[
            "read-workspace",
            "write-workspace",
            "modify-settings",
            "manage-agent-access",
        ],
        cancel_event=asyncio.Event(),
        native_document_authority=NativeDocumentAuthority(
            "private", "owner", "http://127.0.0.1:43210"
        ),
    )
    return state, context


@pytest.mark.asyncio
async def test_search_runs_without_a_renderer_or_any_write_capability(native):
    state, context = native
    state["scope"] = ["read-workspace"]
    assert await execute_native_workflow("search_workspace", {"query": "strain"}, context) == {
        "ok": True,
        "result": {"revision": "current", "ok": True},
    }
    assert state["calls"] == [
        {
            "command": "workspace.search",
            "request": {"query": "strain"},
            "projectScope": {"kind": "app-following"},
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation, result_kind, result_field",
    [
        ("inspect", "inspection", "state"),
        ("availability", "availability", "availability"),
    ],
)
async def test_inventory_reads_dispatch_scoped_dictionaries_with_current_grant(
    native, operation, result_kind, result_field
):
    state, context = native
    state["scope"] = ["read-workspace"]
    state["result"] = {"kind": result_kind, result_field: None}
    result = await execute_native_workflow(
        "inventory",
        {"operation": {"kind": operation, "project": "project", "inventoryId": "inventory"}},
        context,
    )
    assert result == {"ok": True, "result": {"kind": result_kind, result_field: None, "ok": True}}
    assert state["calls"] == [
        {
            "command": f"inventory.{operation}",
            "request": {"project": "project", "inventoryId": "inventory"},
            "projectScope": {"kind": "app-following"},
            "agent": {"identityId": "caller", "capabilities": ["read-workspace"]},
        }
    ]


@pytest.mark.asyncio
async def test_inventory_catalog_is_read_only_and_project_scoped(native):
    state, context = native
    state["scope"] = ["read-workspace"]
    state["result"] = {"kind": "catalog", "entries": []}
    assert await execute_native_workflow(
        "inventory", {"operation": {"kind": "catalog", "project": "project"}}, context
    ) == {"ok": True, "result": {"kind": "catalog", "entries": [], "ok": True}}
    assert state["calls"] == [
        {
            "command": "inventory.catalog",
            "request": {"project": "project"},
            "projectScope": {"kind": "app-following"},
            "agent": {"identityId": "caller", "capabilities": ["read-workspace"]},
        }
    ]


@pytest.mark.asyncio
async def test_inventory_catalog_update_preview_uses_current_read_only_grant(native):
    state, context = native
    state["scope"] = ["read-workspace"]
    preview = {"revision": 0, "canApply": True, "conflictCount": 0, "definitions": []}
    state["result"] = {"kind": "catalog-update-preview", "preview": preview}
    request = {
        "operation": {
            "kind": "catalog-update-preview",
            "project": "project",
            "inventoryId": "inventory",
            "catalogEntryId": "catalog-entry",
        }
    }
    assert await execute_native_workflow("inventory", request, context) == {
        "ok": True,
        "result": {"kind": "catalog-update-preview", "preview": preview, "ok": True},
    }
    assert state["calls"] == [
        {
            "command": "inventory.catalog-update-preview",
            "request": {
                "project": "project",
                "inventoryId": "inventory",
                "catalogEntryId": "catalog-entry",
            },
            "projectScope": {"kind": "app-following"},
            "agent": {"identityId": "caller", "capabilities": ["read-workspace"]},
        }
    ]
    state["revoked"] = True
    with pytest.raises(ToolExecutionFailure) as revoked:
        await execute_native_workflow("inventory", request, context)
    assert revoked.value.code == "GRANT_REVOKED"
    assert len(state["calls"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("namespace, value", [(None, " 001a "), ("Uppercase", "001a\r\n")])
async def test_inventory_item_code_read_preserves_raw_query_and_rechecks_grant(
    native, namespace, value
):
    state, context = native
    state["scope"] = ["read-workspace"]
    lookup = {
        "projectId": "project",
        "inventoryId": "inventory",
        "revision": 0,
        "asOf": 1,
        "principal": {"kind": "agent", "identityId": "caller"},
        "resolution": {"kind": "not-found"},
        "targets": [],
    }
    state["result"] = {"kind": "item-code-resolution", "lookup": lookup}
    request = {
        "project": "project",
        "inventoryId": "inventory",
        "query": {"namespace": namespace, "value": value},
    }
    args = {"operation": {"kind": "resolve-item-code", **request}}
    assert await execute_native_workflow("inventory", args, context) == {
        "ok": True,
        "result": {"kind": "item-code-resolution", "lookup": lookup, "ok": True},
    }
    assert state["calls"] == [
        {
            "command": "inventory.resolve-item-code",
            "request": request,
            "projectScope": {"kind": "app-following"},
            "agent": {"identityId": "caller", "capabilities": ["read-workspace"]},
        }
    ]
    state["revoked"] = True
    with pytest.raises(ToolExecutionFailure) as revoked:
        await execute_native_workflow("inventory", args, context)
    assert revoked.value.code == "GRANT_REVOKED"
    assert len(state["calls"]) == 1


@pytest.mark.asyncio
async def test_inventory_label_preparation_is_read_only_and_preserves_artifact_bytes(native):
    state, context = native
    state["scope"] = ["read-workspace"]
    artifact = {
        "schema": "dnaforge.inventory-label-artifact.v1",
        "binding": {"id": "code", "namespace": "lab", "value": " 001a^FNC1 "},
        "sourceRevision": 7,
        "rendered": {"svg": "<svg>exact immutable bytes</svg>"},
        "svgSha256": "sha256:" + "a" * 64,
    }
    state["result"] = {"kind": "label-artifact", "artifact": artifact}
    request = {
        "project": "project",
        "inventoryId": "inventory",
        "codeId": "code",
        "mediaProfileId": "qr-50x30-300dpi",
    }
    args = {"operation": {"kind": "prepare-label", **request}}
    assert await execute_native_workflow("inventory", args, context) == {
        "ok": True,
        "result": {"kind": "label-artifact", "artifact": artifact, "ok": True},
    }
    assert state["calls"] == [
        {
            "command": "inventory.prepare-label",
            "request": request,
            "projectScope": {"kind": "app-following"},
            "agent": {"identityId": "caller", "capabilities": ["read-workspace"]},
        }
    ]
    state["revoked"] = True
    with pytest.raises(ToolExecutionFailure) as revoked:
        await execute_native_workflow("inventory", args, context)
    assert revoked.value.code == "GRANT_REVOKED"
    assert len(state["calls"]) == 1


@pytest.mark.asyncio
async def test_inventory_write_requires_current_grant_and_rejection_is_not_success(native):
    state, context = native
    request = {
        "operation": {
            "kind": "execute",
            "project": "project",
            "inventoryId": "inventory",
            "operationId": "consume-once",
            "expectedRevision": 2,
            "commands": [],
        }
    }
    state["scope"] = ["read-workspace"]
    with pytest.raises(ToolExecutionFailure) as denied:
        await execute_native_workflow("inventory", request, context)
    assert denied.value.code == "INSUFFICIENT_SCOPE"
    assert state["calls"] == []
    state["scope"] = ["read-workspace", "write-workspace"]
    state["result"] = {
        "kind": "execution",
        "execution": {
            "status": "rejected",
            "inventoryId": "inventory",
            "operationId": "consume-once",
            "code": "REVISION_CONFLICT",
            "message": "Inspect first.",
            "currentRevision": 3,
        },
    }
    with pytest.raises(ToolExecutionFailure) as rejected:
        await execute_native_workflow("inventory", request, context)
    assert rejected.value.code == "REVISION_CONFLICT"
    assert rejected.value.details["stateChanged"] is False
    assert rejected.value.details["operationId"] == "consume-once"
    assert state["calls"][0]["agent"]["identityId"] == "caller"


@pytest.mark.asyncio
async def test_retained_import_receives_fresh_authority_for_its_actual_effects(native):
    state, context = native
    state["scope"] = ["read-workspace"]
    request = {
        "project": "project",
        "operation": {
            "kind": "execute",
            "id": "review",
            "command": {"kind": "inspect"},
        },
    }
    await execute_native_workflow("import_review", request, context)
    assert state["calls"] == [
        {
            "command": "import-review.execute",
            "projectScope": {"kind": "app-following"},
            "request": request,
            "agent": {"identityId": "caller", "capabilities": ["read-workspace"]},
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation",
    [
        {"kind": "inspect"},
        {"kind": "schema"},
        {"kind": "list"},
        {"kind": "search", "query": "sample"},
        {"kind": "table", "tableId": "table", "command": {"kind": "inspect"}},
    ],
)
async def test_notebook_reads_use_native_owner_without_write_scope(native, operation):
    state, context = native
    state["scope"] = ["read-workspace"]
    await execute_native_workflow(
        "notebook_document", {"pageId": "notebook", "operation": operation}, context
    )
    assert state["calls"] == [
        {
            "command": "notebook.execute",
            "projectScope": {"kind": "app-following"},
            "request": {
                "pageId": "notebook",
                "operation": operation,
                "requestId": "action",
            },
        }
    ]


@pytest.mark.asyncio
async def test_notebook_creation_requires_current_creation_authority(native):
    state, context = native
    with pytest.raises(ToolExecutionFailure) as raised:
        await execute_native_workflow(
            "notebook_document",
            {"operation": {"kind": "create", "title": "New notebook"}},
            context,
        )
    assert raised.value.code == "INSUFFICIENT_SCOPE"
    assert state["calls"] == []


@pytest.mark.asyncio
async def test_partial_import_apply_is_a_failed_action_with_an_inspectable_retained_receipt(
    native,
):
    state, context = native
    result = {
        "id": "review",
        "revision": "partial-revision",
        "phase": "partial",
        "receipt": {
            "changed": True,
            "artifactPaths": ["one.strain.json"],
            "imported": 1,
            "failed": 1,
        },
    }
    state["result"] = result
    with pytest.raises(ToolExecutionFailure) as raised:
        await execute_native_workflow(
            "import_review",
            {
                "project": "project",
                "operation": {
                    "kind": "execute",
                    "id": "review",
                    "command": {"kind": "apply", "requestId": "once"},
                },
            },
            context,
        )
    assert raised.value.code == "IMPORT_REVIEW_PARTIAL"
    assert raised.value.retriable is False
    assert raised.value.details == {
        "stateChanged": True,
        "partialEffects": [result["receipt"]],
        "reviewId": "review",
        "reviewRevision": "partial-revision",
    }
    inspected = await execute_native_workflow(
        "import_review",
        {
            "project": "project",
            "operation": {
                "kind": "execute",
                "id": "review",
                "command": {"kind": "inspect"},
            },
        },
        context,
    )
    assert inspected == {"ok": True, "result": {**result, "ok": True}}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name,args",
    [
        (
            "project_history",
            {
                "project": "project",
                "operation": {
                    "kind": "stage",
                    "paths": ["file.py"],
                    "expectedRevision": "current",
                },
            },
        ),
        (
            "import_review",
            {
                "project": "project",
                "operation": {
                    "kind": "execute",
                    "id": "review",
                    "command": {"kind": "apply", "requestId": "once"},
                },
            },
        ),
        (
            "administration",
            {
                "operation": {
                    "kind": "update-settings",
                    "expectedRevision": "current",
                    "patch": {"theme": "light"},
                }
            },
        ),
    ],
)
async def test_live_scope_removal_refuses_native_effects(native, name, args):
    state, context = native
    state["scope"] = ["read-workspace"]
    with pytest.raises(ToolExecutionFailure) as raised:
        await execute_native_workflow(name, args, context)
    assert raised.value.code == "INSUFFICIENT_SCOPE"
    assert state["calls"] == []


@pytest.mark.asyncio
async def test_admin_receives_only_resolved_current_agent_authority(native):
    state, context = native
    state["scope"] = ["read-workspace", "modify-settings"]
    request = {
        "operation": {
            "kind": "update-settings",
            "expectedRevision": "current",
            "patch": {"theme": "light"},
        }
    }
    await execute_native_workflow("administration", request, context)
    assert state["calls"] == [
        {
            "command": "administration.execute",
            "projectScope": {"kind": "app-following"},
            "request": request,
            "agent": {
                "identityId": "caller",
                "capabilities": ["read-workspace", "modify-settings"],
            },
        }
    ]
    state["revoked"] = True
    with pytest.raises(ToolExecutionFailure) as raised:
        await execute_native_workflow(
            "administration", {"operation": {"kind": "inspect-settings"}}, context
        )
    assert raised.value.code == "GRANT_REVOKED"
    assert len(state["calls"]) == 1


@pytest.mark.asyncio
async def test_import_inspection_and_concrete_partial_failure_keep_owner_outcomes(
    native,
):
    state, context = native
    state["scope"] = ["read-workspace"]
    request = {
        "project": "project",
        "operation": {
            "kind": "execute",
            "id": "review",
            "command": {"kind": "inspect"},
        },
    }
    await execute_native_workflow("import_review", request, context)
    state["result"] = {
        "status": "failed",
        "code": "PROJECT_COMMIT_UNCONFIRMED",
        "error": "Inspect HEAD before repeating.",
        "stateChanged": "unknown",
        "commitOid": "known-commit",
    }
    with pytest.raises(ToolExecutionFailure) as raised:
        await execute_native_workflow(
            "project_history",
            {"project": "project", "operation": {"kind": "inspect"}},
            context,
        )
    assert raised.value.retriable is False
    assert raised.value.details["partialEffects"][0]["commitOid"] == "known-commit"


@pytest.mark.asyncio
async def test_sequence_native_route_requires_sequence_read_authority(native):
    state, context = native
    request = {"documentId": "sequence-a", "operation": {"kind": "inspect"}}
    with pytest.raises(ToolExecutionFailure) as raised:
        await execute_native_workflow("sequence_document", request, context)
    assert raised.value.code == "INSUFFICIENT_SCOPE"
    assert state["calls"] == []
    state["scope"].append("read-sequences")
    context.agent_capabilities.append("read-sequences")
    await execute_native_workflow("sequence_document", request, context)
    assert state["calls"] == [
        {
            "command": "sequence.execute",
            "request": request,
            "projectScope": {"kind": "app-following"},
        }
    ]


def test_share_capability_inputs_and_outputs_do_not_enter_retained_audit():
    request = {
        "operation": {
            "kind": "prepare-share-import",
            "sourceUrl": "https://example.test/share/private-capability",
        }
    }
    projected = administration_audit_parameters(request)
    assert "private-capability" not in json.dumps(projected)
    assert len(projected["operation"]["sourceSha256"]) == 64
    assert request["operation"]["sourceUrl"].endswith("private-capability")
    result = {
        "ok": True,
        "result": {
            "kind": "action",
            "action": {
                "id": "prepared",
                "revision": "current",
                "state": "completed",
                "result": {"shareUrl": "https://example.test/share/private-capability"},
            },
        },
    }
    audit = administration_audit_result(result)
    assert "private-capability" not in json.dumps(audit)
    assert audit["action"] == {
        "id": "prepared",
        "revision": "current",
        "state": "completed",
    }
