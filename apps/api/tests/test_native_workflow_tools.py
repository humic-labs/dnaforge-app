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
        ("stockroom", "stockroom", "stockroom"),
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
async def test_inventory_benchling_capture_inspection_is_read_only_and_rechecks_grant(native):
    state, context = native
    state["scope"] = ["read-workspace"]
    inspection = {"kind": "blocked", "capture": None, "records": []}
    state["result"] = {"kind": "benchling-capture-inspection", "result": inspection}
    request = {
        "project": "project",
        "inventoryId": "inventory",
        "sourceText": '{"quantity":{"value":9007199254740993}}\r\n',
    }
    args = {"operation": {"kind": "inspect-benchling-capture", **request}}
    assert await execute_native_workflow("inventory", args, context) == {
        "ok": True,
        "result": {"kind": "benchling-capture-inspection", "result": inspection, "ok": True},
    }
    assert state["calls"] == [
        {
            "command": "inventory.inspect-benchling-capture",
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
@pytest.mark.parametrize("freshness_max_age_ms", [None, 0, 60_000])
async def test_inventory_conditions_read_preserves_explicit_policy_and_rechecks_grant(
    native, freshness_max_age_ms
):
    state, context = native
    state["scope"] = ["read-workspace"]
    conditions = {
        "projectId": "project",
        "inventoryId": "inventory",
        "revision": 2,
        "asOf": 1_000,
        "freshnessMaxAgeMs": freshness_max_age_ms,
        "equipment": {},
        "stocks": {},
    }
    state["result"] = {"kind": "storage-conditions", "conditions": conditions}
    request = {
        "project": "project",
        "inventoryId": "inventory",
        "freshnessMaxAgeMs": freshness_max_age_ms,
    }
    args = {"operation": {"kind": "storage-conditions", **request}}
    assert await execute_native_workflow("inventory", args, context) == {
        "ok": True,
        "result": {"kind": "storage-conditions", "conditions": conditions, "ok": True},
    }
    assert state["calls"] == [
        {
            "command": "inventory.storage-conditions",
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


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["export-snapshot", "preview-import"])
async def test_inventory_archive_reads_need_only_current_read_grant(native, kind):
    state, context = native
    state["scope"] = ["read-workspace"]
    request = {"project": "project", "inventoryId": "inventory"}
    if kind == "export-snapshot":
        request["format"] = "native-v1"
    else:
        request.update({"sourceText": "exact archive", "options": {"bindings": []}})
    await execute_native_workflow("inventory", {"operation": {"kind": kind, **request}}, context)
    assert state["calls"][0]["command"] == f"inventory.{kind}"
    assert state["calls"][0]["request"] == request
    state["revoked"] = True
    with pytest.raises(ToolExecutionFailure) as revoked:
        await execute_native_workflow(
            "inventory", {"operation": {"kind": kind, **request}}, context
        )
    assert revoked.value.code == "GRANT_REVOKED"
    assert len(state["calls"]) == 1


@pytest.mark.asyncio
async def test_inventory_adoption_preserves_accepted_request_tag_and_requires_write(native):
    state, context = native
    operation = {
        "kind": "apply-import",
        "project": "project",
        "inventoryId": "inventory",
        "operationId": "adopt",
        "expectedRevision": 0,
        "sourceText": "exact archive",
        "options": {"bindings": []},
        "expectedPlanDigest": "sha256:" + "0" * 64,
    }
    state["scope"] = ["read-workspace"]
    with pytest.raises(ToolExecutionFailure) as denied:
        await execute_native_workflow("inventory", {"operation": operation}, context)
    assert denied.value.code == "INSUFFICIENT_SCOPE"
    assert state["calls"] == []
    state["scope"] = ["read-workspace", "write-workspace"]
    await execute_native_workflow("inventory", {"operation": operation}, context)
    assert state["calls"][0]["command"] == "inventory.apply-import"
    assert state["calls"][0]["request"] == {**operation, "kind": "adopt-archive"}
    assert state["calls"][0]["agent"]["identityId"] == "caller"


@pytest.mark.asyncio
async def test_inventory_mapped_table_preserves_layout_source_and_requires_write_for_application(
    native,
):
    state, context = native
    options = {
        "namespace": "source",
        "delimiter": ",",
        "columns": {"sourceId": "ID", "plate": "Plate", "well": "Well"},
        "materials": [],
        "plates": [],
        "quantity": {"kind": "unknown", "reason": "No source measurements"},
        "qualities": [],
        "evidenceOnlyColumns": [],
        "skips": [],
    }
    operation = {
        "kind": "preview-mapped-table",
        "project": "project",
        "inventoryId": "inventory",
        "format": "mapped-plate-v1",
        "sourceText": "exact source\r\n",
        "options": options,
    }
    state["scope"] = ["read-workspace"]
    await execute_native_workflow("inventory", {"operation": operation}, context)
    assert state["calls"][0]["command"] == "inventory.preview-mapped-table"
    assert state["calls"][0]["request"]["sourceText"] == "exact source\r\n"
    apply = {key: value for key, value in operation.items() if key != "format"}
    apply.update(
        {
            "kind": "apply-mapped-table",
            "operationId": "observe-once",
            "expectedRevision": 0,
            "expectedPlanDigest": "sha256:" + "0" * 64,
        }
    )
    with pytest.raises(ToolExecutionFailure) as denied:
        await execute_native_workflow("inventory", {"operation": apply}, context)
    assert denied.value.code == "INSUFFICIENT_SCOPE"
    assert len(state["calls"]) == 1
    state["scope"] = ["read-workspace", "write-workspace"]
    await execute_native_workflow("inventory", {"operation": apply}, context)
    assert state["calls"][1]["command"] == "inventory.apply-mapped-table"
    assert state["calls"][1]["request"] == {**apply, "kind": "receive-mapped-table"}


@pytest.mark.asyncio
async def test_inventory_physical_capture_preserves_source_and_requires_write_for_application(
    native,
):
    state, context = native
    options = {
        "scopeAcceptance": {"kind": "selected-records", "reason": ""},
        "records": [],
        "sourceIssueDispositions": [],
        "uncapturedPositions": [],
    }
    preview = {
        "kind": "preview-benchling-capture",
        "project": "project",
        "inventoryId": "inventory",
        "sourceText": "exact capture\r\n",
        "options": options,
    }
    state["scope"] = ["read-workspace"]
    await execute_native_workflow("inventory", {"operation": preview}, context)
    assert state["calls"][0]["command"] == "inventory.preview-benchling-capture"
    assert state["calls"][0]["request"]["sourceText"] == "exact capture\r\n"
    apply = {
        **preview,
        "kind": "apply-benchling-capture",
        "operationId": "capture-once",
        "expectedRevision": 0,
        "expectedPlanDigest": "sha256:" + "a" * 64,
        "options": {
            **options,
            "materials": [],
            "resolvedTargets": [],
            "normalizedStockRows": [],
            "normalizedTableOptions": {},
        },
    }
    with pytest.raises(ToolExecutionFailure) as denied:
        await execute_native_workflow("inventory", {"operation": apply}, context)
    assert denied.value.code == "INSUFFICIENT_SCOPE"
    assert len(state["calls"]) == 1
    state["scope"] = ["read-workspace", "write-workspace"]
    await execute_native_workflow("inventory", {"operation": apply}, context)
    assert state["calls"][1]["command"] == "inventory.apply-benchling-capture"
    assert state["calls"][1]["request"] == {**apply, "kind": "import-benchling-capture"}


@pytest.mark.asyncio
async def test_inventory_hierarchy_preserves_layout_source_and_requires_write_for_application(
    native,
):
    state, context = native
    options = {
        "namespace": "source",
        "delimiter": ",",
        "parents": [],
        "skips": [],
    }
    operation = {
        "kind": "preview-hierarchy",
        "project": "project",
        "inventoryId": "inventory",
        "format": "hierarchy-v1",
        "sourceText": "exact source\r\n",
        "options": options,
    }
    state["scope"] = ["read-workspace"]
    await execute_native_workflow("inventory", {"operation": operation}, context)
    assert state["calls"][0]["command"] == "inventory.preview-hierarchy"
    assert state["calls"][0]["request"]["sourceText"] == "exact source\r\n"
    apply = {key: value for key, value in operation.items() if key != "format"}
    apply.update(
        {
            "kind": "apply-hierarchy",
            "operationId": "observe-once",
            "expectedRevision": 0,
            "expectedPlanDigest": "sha256:" + "0" * 64,
        }
    )
    with pytest.raises(ToolExecutionFailure) as denied:
        await execute_native_workflow("inventory", {"operation": apply}, context)
    assert denied.value.code == "INSUFFICIENT_SCOPE"
    assert len(state["calls"]) == 1
    state["scope"] = ["read-workspace", "write-workspace"]
    await execute_native_workflow("inventory", {"operation": apply}, context)
    assert state["calls"][1]["command"] == "inventory.apply-hierarchy"
    assert state["calls"][1]["request"] == {**apply, "kind": "import-hierarchy"}


@pytest.mark.asyncio
async def test_inventory_stocktake_preserves_observations_and_requires_write_for_application(
    native,
):
    state, context = native
    options = {
        "namespace": "source",
        "delimiter": ",",
        "subjects": [],
        "locations": [],
        "decisions": [],
    }
    operation = {
        "kind": "preview-stocktake",
        "project": "project",
        "inventoryId": "inventory",
        "format": "stocktake-v1",
        "sourceText": "exact source\r\n",
        "options": options,
    }
    state["scope"] = ["read-workspace"]
    await execute_native_workflow("inventory", {"operation": operation}, context)
    assert state["calls"][0]["command"] == "inventory.preview-stocktake"
    assert state["calls"][0]["request"]["sourceText"] == "exact source\r\n"
    apply = {key: value for key, value in operation.items() if key != "format"}
    apply.update(
        {
            "kind": "apply-stocktake",
            "operationId": "observe-once",
            "expectedRevision": 0,
            "expectedPlanDigest": "sha256:" + "0" * 64,
        }
    )
    with pytest.raises(ToolExecutionFailure) as denied:
        await execute_native_workflow("inventory", {"operation": apply}, context)
    assert denied.value.code == "INSUFFICIENT_SCOPE"
    assert len(state["calls"]) == 1
    state["scope"] = ["read-workspace", "write-workspace"]
    await execute_native_workflow("inventory", {"operation": apply}, context)
    assert state["calls"][1]["command"] == "inventory.apply-stocktake"
    assert state["calls"][1]["request"] == {**apply, "kind": "apply-stocktake"}


@pytest.mark.asyncio
async def test_inventory_receive_table_preserves_source_and_separates_read_and_write(native):
    state, context = native
    options = {
        "namespace": "source",
        "delimiter": ",",
        "materials": [],
        "locations": [],
        "vessels": [],
        "skips": [],
    }
    operation = {
        "kind": "preview-table",
        "project": "project",
        "inventoryId": "inventory",
        "format": "receive-v1",
        "sourceText": "exact source\r\n",
        "options": options,
    }
    state["scope"] = ["read-workspace"]
    await execute_native_workflow("inventory", {"operation": operation}, context)
    assert state["calls"][0]["command"] == "inventory.preview-table"
    assert state["calls"][0]["request"]["sourceText"] == "exact source\r\n"
    apply = {key: value for key, value in operation.items() if key != "format"}
    apply.update(
        {
            "kind": "apply-table",
            "operationId": "table-once",
            "expectedRevision": 0,
            "expectedPlanDigest": "sha256:" + "0" * 64,
        }
    )
    with pytest.raises(ToolExecutionFailure) as denied:
        await execute_native_workflow("inventory", {"operation": apply}, context)
    assert denied.value.code == "INSUFFICIENT_SCOPE"
    assert len(state["calls"]) == 1
    state["scope"] = ["read-workspace", "write-workspace"]
    await execute_native_workflow("inventory", {"operation": apply}, context)
    assert state["calls"][1]["command"] == "inventory.apply-table"
    assert state["calls"][1]["request"] == {**apply, "kind": "receive-table"}


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


@pytest.mark.asyncio
async def test_inventory_source_revision_requires_write_and_preserves_verified_source_evidence(
    native,
):
    state, context = native
    options = {
        "table": {
            "namespace": "source",
            "delimiter": ",",
            "materials": [],
            "locations": [],
            "vessels": [],
            "skips": [],
        },
        "acknowledgements": [],
    }
    operation = {
        "kind": "preview-source-revision",
        "project": "project",
        "inventoryId": "inventory",
        "format": "receive-v1",
        "sourceText": "exact source\r\n",
        "options": options,
    }
    state["scope"] = ["read-workspace"]
    await execute_native_workflow("inventory", {"operation": operation}, context)
    assert state["calls"][0]["command"] == "inventory.preview-source-revision"
    assert state["calls"][0]["request"]["sourceText"] == operation["sourceText"]
    apply = {key: value for key, value in operation.items() if key != "format"}
    apply.update(
        {
            "kind": "acknowledge-source",
            "operationId": "source-once",
            "expectedRevision": 0,
            "options": {**options, "preimages": []},
            "expectedPlanDigest": "sha256:" + "0" * 64,
        }
    )
    with pytest.raises(ToolExecutionFailure) as denied:
        await execute_native_workflow("inventory", {"operation": apply}, context)
    assert denied.value.code == "INSUFFICIENT_SCOPE"
    assert len(state["calls"]) == 1
    state["scope"] = ["read-workspace", "write-workspace"]
    await execute_native_workflow("inventory", {"operation": apply}, context)
    assert state["calls"][1]["command"] == "inventory.acknowledge-source"
    assert state["calls"][1]["request"] == {**apply, "kind": "acknowledge-table-source"}


@pytest.mark.asyncio
async def test_inventory_arrival_preserves_original_evidence_and_requires_current_write_grant(native):
    state, context = native
    state["scope"] = ["read-workspace"]
    preview = {
        "kind": "preview-arrival",
        "project": "project",
        "inventoryId": "inventory",
        "sourceText": "original delivery packet\r\n",
        "options": {"components": []},
    }
    await execute_native_workflow("inventory", {"operation": preview}, context)
    assert state["calls"][0]["command"] == "inventory.preview-arrival"
    assert state["calls"][0]["request"]["sourceText"] == preview["sourceText"]
    document = {
        "kind": "arrival-document",
        "project": "project",
        "inventoryId": "inventory",
        "arrivalId": "arrival",
        "documentKey": "packing",
        "expectedSha256": "sha256:" + "0" * 64,
    }
    await execute_native_workflow("inventory", {"operation": document}, context)
    assert state["calls"][1]["command"] == "inventory.arrival-document"
    assert state["calls"][1]["request"] == {
        key: value for key, value in document.items() if key != "kind"
    }
    apply = {
        **preview,
        "kind": "apply-arrival",
        "operationId": "receive-once",
        "expectedRevision": 0,
        "expectedPlanDigest": "sha256:" + "1" * 64,
        "options": {"components": [], "materials": [], "targets": []},
    }
    with pytest.raises(ToolExecutionFailure) as denied:
        await execute_native_workflow("inventory", {"operation": apply}, context)
    assert denied.value.code == "INSUFFICIENT_SCOPE"
    assert len(state["calls"]) == 2
    state["scope"] = ["read-workspace", "write-workspace"]
    await execute_native_workflow("inventory", {"operation": apply}, context)
    assert state["calls"][2]["command"] == "inventory.apply-arrival"
    assert state["calls"][2]["request"] == {**apply, "kind": "receive-arrival"}
    state["revoked"] = True
    with pytest.raises(ToolExecutionFailure) as revoked:
        await execute_native_workflow("inventory", {"operation": document}, context)
    assert revoked.value.code == "GRANT_REVOKED"
    assert len(state["calls"]) == 3
