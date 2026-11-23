"""Contracts for the SDK-backed DNAForge MCP companion."""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from mcp import MCPError, types

from src.mcp_companion import CompanionOptions, create_mcp_server
from src.mcp_companion.projection import project_call_result
from src.mcp_companion.runner import _parse_options
from src.mcp_companion.server import (
    AGENT_USER_INPUT_TOOL_NAME,
    CompanionHandlers,
    native_authoring_instructions,
)
from src.mcp_companion.sidecar import SidecarHTTPError
from src.mcp_tool_names import canonical_renderer_tool_name, portable_tool_catalog


@pytest.mark.parametrize("status", ["failed", "canceled"])
def test_successful_job_observation_is_not_a_tool_failure(status):
    observation = {
        "ok": True,
        "status": status,
        "error": {"message": "Observed job failed"},
    }
    result = project_call_result(
        200,
        {
            "ok": True,
            "jobId": "read-status",
            "status": "completed",
            "result": {"ok": True, "result": observation},
        },
    )
    assert result.is_error is False
    assert result.structured_content == {"ok": True, "result": observation}


@pytest.mark.parametrize("status", ["failed", "canceled"])
def test_terminal_job_failure_remains_an_error_when_poll_transport_succeeds(status):
    body = {
        "ok": True,
        "jobId": "failed-binding",
        "status": status,
        "result": None,
        "error": {
            "code": "INVALID_TOOL_OUTPUT",
            "message": "Inspect the original action.",
        },
    }
    result = project_call_result(200, body)
    assert result.is_error is True
    assert json.loads(result.content[0].text) == {**body, "ok": False}
    assert body["ok"] is True


def test_explicit_tool_failure_inside_completed_job_is_an_error():
    result = project_call_result(
        200,
        {
            "ok": True,
            "jobId": "read-status",
            "status": "completed",
            "result": {
                "ok": False,
                "code": "READ_FAILED",
                "error": "Cannot read status",
            },
        },
    )
    assert result.is_error is True


def test_native_snapshot_of_failed_operation_is_a_successful_read():
    snapshot = {
        "id": "observed-operation",
        "state": "failed",
        "error": {"code": "COMPUTE_FAILED"},
    }
    result = project_call_result(
        200,
        {
            "ok": True,
            "jobId": "read-operation",
            "status": "completed",
            "result": snapshot,
        },
    )
    assert result.is_error is False
    assert result.structured_content == snapshot


def test_external_reference_results_publish_the_qualified_public_link():
    target = {
        "entityId": "e0b34177-a7d4-4cf6-9529-42526df462f5",
        "projectId": "d12f4e19-d1cb-4cef-850c-c765b0bab320",
    }
    private = "dnaforge-chat://reference/e0b34177-a7d4-4cf6-9529-42526df462f5"
    public = "dnaforge-dev-1827://entity/open?entityId=e0b34177-a7d4-4cf6-9529-42526df462f5&projectId=d12f4e19-d1cb-4cef-850c-c765b0bab320"
    body = {
        "ok": True,
        "result": {
            "referenceId": target["entityId"],
            "inlineLink": private,
            "externalUrl": public,
            "target": target,
        },
    }
    result = project_call_result(200, body)
    assert result.structured_content["inlineLink"] == public
    assert result.structured_content["target"] == target
    assert json.loads(result.content[0].text)["result"]["inlineLink"] == public
    assert body["result"]["inlineLink"] == private


def test_external_molecular_save_returns_a_valid_receipt_without_an_in_app_link():
    from jsonschema import Draft202012Validator
    from src.concurrency.renderer_bridge import load_renderer_tool_manifest

    reference = {
        "kind": "molecular-document",
        "version": 1,
        "projectId": "fixture-project",
        "documentId": "11111111-1111-4111-8111-111111111111",
        "revisionId": "22222222-2222-4222-8222-222222222222",
        "revisionSha256": "a" * 64,
    }
    saved = {
        "ok": True,
        "referenceId": reference["revisionId"],
        "revisionId": reference["revisionId"],
        "structureViewId": "saved-structure",
        "documentReference": reference,
        "activeViewReference": reference,
        "inlineLink": "dnaforge-chat://molecular-document/fixture-project",
        "molecularDocumentId": reference["documentId"],
        "molecularDocumentReference": reference,
        "molecularDocumentProjectId": reference["projectId"],
        "molecularDocumentPath": "/fixture/Example.dnaforge-molecular.json",
        "molecularDocumentRevision": "b" * 64,
        "molecularDocumentSavedReferenceId": reference["revisionId"],
        "title": "Example",
        "caption": "",
        "evidence": [],
        "coordinateDigestSha256": "c" * 64,
        "format": "mvsj",
        "message": "Saved the molecular document.",
    }
    receipt = project_call_result(
        200,
        {
            "ok": True,
            "jobId": "save-job",
            "status": "completed",
            "result": {"ok": True, "result": saved},
        },
    )
    tool = next(
        tool
        for tool in load_renderer_tool_manifest()["tools"]
        if tool["name"] == "mol_save_view"
    )
    assert receipt.is_error is False
    assert receipt.structured_content["result"]["documentReference"] == reference
    assert "inlineLink" not in receipt.structured_content["result"]
    Draft202012Validator(tool["outputSchema"]).validate(receipt.structured_content)


def test_external_results_preserve_notebook_content_and_remove_unqualified_links():
    private = "dnaforge-chat://reference/ref-1"
    document = {
        "type": "doc",
        "content": [{"type": "text", "text": private}],
    }
    body = {
        "result": {
            "referenceId": "ref-1",
            "inlineLink": private,
            "externalUrl": None,
            "notebook": document,
            "prose": f"An example: {private}",
        }
    }
    result = project_call_result(200, body)
    assert "inlineLink" not in result.structured_content
    assert result.structured_content["referenceId"] == "ref-1"
    assert result.structured_content["notebook"] == document
    assert result.structured_content["prose"] == body["result"]["prose"]
    assert (
        project_call_result(
            200, body, client_surface="dnaforge-chat"
        ).structured_content
        == body["result"]
    )


def test_molecular_save_receipt_keeps_its_document_reference_without_an_inline_link():
    from jsonschema import Draft202012Validator

    from src.concurrency.renderer_bridge import load_renderer_tool_manifest
    from src.mcp_companion.projection import project_tool

    document_id = "11111111-1111-4111-8111-111111111111"
    revision_id = "22222222-2222-4222-8222-222222222222"
    digest = "a" * 64
    reference = {
        "kind": "molecular-document",
        "version": 1,
        "projectId": "project-1",
        "documentId": document_id,
        "revisionId": revision_id,
        "revisionSha256": digest,
    }
    receipt = {
        "ok": True,
        "referenceId": "project-reference",
        "revisionId": revision_id,
        "structureViewId": f"molecular-document:{document_id}",
        "documentReference": reference,
        "activeViewReference": reference,
        "inlineLink": "dnaforge-chat://molecular-document/project-1",
        "molecularDocumentId": document_id,
        "molecularDocumentReference": reference,
        "molecularDocumentProjectId": "project-1",
        "molecularDocumentPath": "/project/Pocket.dnaforge-molecular.json",
        "molecularDocumentRevision": digest,
        "molecularDocumentSavedReferenceId": revision_id,
        "title": "Pocket",
        "caption": "",
        "evidence": [],
        "coordinateDigestSha256": digest,
        "format": "mvsj",
        "message": "Saved the molecular document.",
    }
    raw_tool = next(
        tool
        for tool in load_renderer_tool_manifest()["tools"]
        if tool["name"] == "mol_save_view"
    )
    body = {"ok": True, "result": {"ok": True, "result": receipt}}
    result = project_call_result(200, body, tool_name="mol_save_view")
    assert result.structured_content["result"]["documentReference"] == reference
    assert "inlineLink" not in result.structured_content["result"]
    Draft202012Validator(project_tool(raw_tool).output_schema).validate(
        result.structured_content
    )


def test_external_explicit_json_content_uses_the_same_link_as_structured_content():
    reference = {
        "referenceId": "ref-1",
        "inlineLink": "dnaforge-chat://reference/ref-1",
        "externalUrl": "dnaforge://entity/open?entityId=entity-1&referenceId=ref-1",
        "target": {"entityId": "entity-1", "referenceId": "ref-1"},
    }
    body = {
        "content": [{"type": "text", "text": json.dumps(reference)}],
        "structuredContent": reference,
    }
    result = project_call_result(200, body)
    assert json.loads(result.content[0].text) == result.structured_content
    assert result.structured_content["inlineLink"] == reference["externalUrl"]


@pytest.mark.parametrize("surface", [None, "external", "dnaforge-chat", "other"])
def test_companion_launch_keeps_the_explicit_client_surface(monkeypatch, surface):
    monkeypatch.delenv("DNAFORGE_MCP_CLIENT_SURFACE", raising=False)
    if surface is not None:
        monkeypatch.setenv("DNAFORGE_MCP_CLIENT_SURFACE", surface)
    expected = "dnaforge-chat" if surface == "dnaforge-chat" else "external"
    assert CompanionOptions.from_env().client_surface == expected
    assert _parse_options([]).client_surface == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("surface", ["external", "dnaforge-chat"])
async def test_tool_dispatch_projects_links_for_the_launch_surface(surface):
    sidecar = FakeSidecarClient(_catalog(tools=[_tool("create_notebook_reference")]))
    reference = {
        "referenceId": "ref-1",
        "inlineLink": "dnaforge-chat://reference/ref-1",
        "externalUrl": "dnaforge://entity/open?entityId=entity-1&referenceId=ref-1",
        "target": {"entityId": "entity-1", "referenceId": "ref-1"},
    }
    sidecar.call_response = {"ok": True, "result": reference}
    result = await CompanionHandlers(
        sidecar, CompanionOptions(client_surface=surface)
    ).call_tool(
        _context(), types.CallToolRequestParams(name="create_notebook_reference")
    )
    expected = (
        reference["externalUrl"] if surface == "external" else reference["inlineLink"]
    )
    assert result.structured_content["inlineLink"] == expected
    assert result.structured_content["target"] == reference["target"]


def _tool(
    name: str,
    *,
    cancelable: bool = False,
    output_schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    tool: dict[str, Any] = {
        "name": name,
        "description": f"Tool {name}",
        "inputSchema": {"type": "object"},
        "annotations": {
            "readOnlyHint": True,
            "cancelable": cancelable,
            "duration": "long-running" if cancelable else "immediate",
        },
    }
    if output_schema is not None:
        tool["outputSchema"] = output_schema
    return tool


def _catalog(*, tools: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "ok": True,
        "caller": {
            "agentIdentityId": "grant-1",
            "requestedCapabilities": ["read-workspace"],
            "grantedCapabilities": ["read-workspace"],
            "effectiveCapabilities": ["read-workspace"],
        },
        "tools": tools or [],
        "resources": [
            {
                "uri": "waypoint://selection/z",
                "name": "Z selection",
                "mimeType": "application/json",
            },
            {
                "uri": "waypoint://selection/a",
                "name": "A selection",
                "mimeType": "application/json",
            },
        ],
        "resourceTemplates": [
            {
                "uriTemplate": "waypoint://selection/{refId}",
                "name": "DNAForge selection",
                "mimeType": "application/json",
            }
        ],
    }


class FakeSidecarClient:
    def __init__(self, catalog: dict[str, Any] | None = None):
        self.catalog = catalog or _catalog()
        self.discover_client_info: list[dict[str, Any] | None] = []
        self.discover_open_workspace_flags: list[bool] = []
        self.discover_error: SidecarHTTPError | None = None
        self.call_response: dict[str, Any] = {
            "ok": True,
            "jobId": "job-inline",
            "status": "completed",
            "result": {"answer": 42},
        }
        self.job_responses: list[dict[str, Any]] = []
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.idempotency_keys: list[str] = []
        self.canceled_job_ids: list[str] = []
        self.cancel_errors: dict[str, SidecarHTTPError] = {}
        self.poll_started = asyncio.Event()
        self.block_poll = False
        self.admission_started = asyncio.Event()
        self.release_admission = asyncio.Event()
        self.block_admission = False

    async def discover(
        self,
        *,
        client_info: dict[str, Any] | None = None,
        include_open_workspace_resources: bool = False,
    ) -> dict[str, Any]:
        self.discover_client_info.append(client_info)
        self.discover_open_workspace_flags.append(include_open_workspace_resources)
        if self.discover_error is not None:
            raise self.discover_error
        return self.catalog

    async def lookup_tool(
        self, name: str, *, portable_names: bool
    ) -> dict[str, Any] | None:
        if self.discover_error is not None:
            raise self.discover_error
        tools = self.catalog["tools"]
        if portable_names:
            _, names = portable_tool_catalog(tools)
            name = names.get(name, name)
        tool = next(
            (
                tool
                for tool in tools
                if (
                    tool["name"] == name
                    or canonical_renderer_tool_name(tool["name"]) == name
                )
            ),
            None,
        )
        return (
            None
            if tool is None
            else {
                "name": canonical_renderer_tool_name(name),
                "cancelable": tool["annotations"]["cancelable"],
            }
        )

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> tuple[int, dict[str, Any]]:
        self.calls.append((name, arguments))
        self.idempotency_keys.append(idempotency_key)
        self.admission_started.set()
        if self.block_admission:
            await self.release_admission.wait()
        return 200, self.call_response

    async def get_job(self, job_id: str) -> dict[str, Any]:
        self.poll_started.set()
        if self.block_poll:
            await asyncio.Event().wait()
        if not self.job_responses:
            raise AssertionError(f"unexpected poll for {job_id}")
        return self.job_responses.pop(0)

    async def cancel_job(self, job_id: str) -> None:
        self.canceled_job_ids.append(job_id)
        error = self.cancel_errors.get(job_id)
        if error is not None:
            raise error

    async def read_resource(self, uri: str) -> dict[str, Any]:
        return {
            "ok": True,
            "contents": [
                {
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": '{"kind":"selection"}',
                }
            ],
        }


def _context(*, meta: dict[str, Any] | None = None) -> SimpleNamespace:
    client_info = types.Implementation(name="test-client", version="1.2.3")
    return SimpleNamespace(
        protocol_version="2026-07-28",
        request_id="request-7",
        meta=meta,
        session=SimpleNamespace(
            client_params=SimpleNamespace(client_info=client_info),
        ),
    )


class StructureGuidanceSidecar(FakeSidecarClient):
    def __init__(self):
        super().__init__(
            _catalog(
                tools=[
                    _tool(name)
                    for name in (
                        "administration",
                        "mol_get_scene",
                        "mol_apply_scene",
                        "mol_structures",
                        "echo",
                    )
                ]
            )
        )
        self.instructions = "Use the saved custom structure guidance."

    async def call_tool(self, name, arguments, *, idempotency_key):
        status, body = await super().call_tool(name, arguments, idempotency_key=idempotency_key)
        if name == "administration":
            assert arguments == {"operation": {"kind": "inspect-structure-guidance"}}
            body = {
                **body,
                "result": {
                    "ok": True,
                    "kind": "structure-guidance",
                    "guidance": {
                        "defaultVersion": 1,
                        "source": "override",
                        "instructions": self.instructions,
                    },
                },
            }
        return status, body


@pytest.mark.asyncio
async def test_first_external_structure_write_returns_guidance_before_dispatch():
    sidecar = StructureGuidanceSidecar()
    handlers = CompanionHandlers(sidecar, CompanionOptions())
    ctx = _context()
    apply = types.CallToolRequestParams(name="mol_apply_scene", arguments={})
    operation = {"operation": {"kind": "inspect-structure-guidance"}}

    first = await handlers.call_tool(ctx, apply)
    assert first.is_error
    assert "STRUCTURE_GUIDANCE_REQUIRED" in first.content[0].text
    assert sidecar.instructions in first.content[0].text
    assert sidecar.calls == [("administration", operation)]

    applied = await handlers.call_tool(ctx, apply)
    assert not applied.is_error and applied.structured_content == {"answer": 42}
    assert sidecar.instructions not in applied.content[0].text
    assert sidecar.calls[-1] == ("mol_apply_scene", {})
    assert len(sidecar.calls) == 2

    sidecar.instructions = ""
    current = await handlers.call_tool(
        ctx, types.CallToolRequestParams(name="administration", arguments=operation)
    )
    assert current.structured_content["guidance"]["instructions"] == ""
    reconnected = await CompanionHandlers(sidecar, CompanionOptions()).call_tool(
        _context(), apply
    )
    assert reconnected.is_error
    assert "STRUCTURE_GUIDANCE_REQUIRED" in reconnected.content[0].text
    assert sidecar.calls[-1] == ("administration", operation)


@pytest.mark.asyncio
async def test_first_structure_read_presents_guidance_and_preserves_the_scene_result():
    sidecar = StructureGuidanceSidecar()
    handlers = CompanionHandlers(sidecar, CompanionOptions())
    ctx = _context()

    unrelated = await handlers.call_tool(
        ctx, types.CallToolRequestParams(name="echo", arguments={})
    )
    assert sidecar.instructions not in unrelated.content[0].text
    read = await handlers.call_tool(
        ctx,
        types.CallToolRequestParams(name="mol_structures", arguments={"operation": "list"}),
    )
    assert not read.is_error
    assert read.structured_content == {
        "answer": 42,
        "structureGuidance": {
            "defaultVersion": 1,
            "source": "override",
            "instructions": sidecar.instructions,
            "examplesUri": "waypoint://workflow/structure-authoring",
        },
    }
    assert sidecar.instructions in read.content[0].text
    again = await handlers.call_tool(
        _context(), types.CallToolRequestParams(name="mol_get_scene", arguments={})
    )
    assert sidecar.instructions not in again.content[0].text
    assert again.structured_content == {"answer": 42}
    write = await handlers.call_tool(
        ctx, types.CallToolRequestParams(name="mol_apply_scene", arguments={})
    )
    assert not write.is_error
    assert [name for name, _ in sidecar.calls] == [
        "echo",
        "administration",
        "mol_structures",
        "mol_get_scene",
        "mol_apply_scene",
    ]


@pytest.mark.asyncio
async def test_catalog_handlers_revalidate_and_sort_scoped_discovery():
    sidecar = FakeSidecarClient(_catalog(tools=[_tool("zeta"), _tool("alpha")]))
    handlers = CompanionHandlers(sidecar, CompanionOptions())

    listed_tools = await handlers.list_tools(_context(), None)
    listed_resources = await handlers.list_resources(_context(), None)
    listed_templates = await handlers.list_resource_templates(_context(), None)

    assert [tool.name for tool in listed_tools.tools] == ["alpha", "zeta"]
    assert [str(resource.uri) for resource in listed_resources.resources] == [
        "waypoint://selection/a",
        "waypoint://selection/z",
    ]
    assert [
        template.uri_template for template in listed_templates.resource_templates
    ] == ["waypoint://selection/{refId}"]
    assert len(sidecar.discover_client_info) == 3
    assert sidecar.discover_open_workspace_flags == [False, True, False]
    assert sidecar.discover_client_info[0] == {
        "name": "test-client",
        "version": "1.2.3",
    }
    assert listed_tools.ttl_ms == 0
    assert listed_tools.cache_scope == "private"
    assert listed_resources.ttl_ms == 0
    assert listed_resources.cache_scope == "private"


@pytest.mark.asyncio
async def test_external_catalog_uses_portable_names_and_dispatches_canonical_tools():
    sidecar = FakeSidecarClient(
        _catalog(
            tools=[
                _tool("operations.discover"),
                _tool("compute.submit"),
                _tool("compute_submit"),
            ]
        )
    )
    handlers = CompanionHandlers(sidecar, CompanionOptions(portable_tool_names=True))
    listed = await handlers.list_tools(_context(), None)
    assert [tool.name for tool in listed.tools] == [
        "compute_submit",
        "operations_discover",
    ]
    await handlers.call_tool(
        _context(),
        types.CallToolRequestParams(name="operations_discover", arguments={}),
    )
    assert sidecar.calls == [("operations.discover", {})]
    await handlers.call_tool(
        _context(), types.CallToolRequestParams(name="compute_submit", arguments={})
    )
    assert sidecar.calls[-1] == ("compute.submit", {})
    sidecar.catalog["tools"] = [_tool("compute_submit")]
    await handlers.call_tool(
        _context(), types.CallToolRequestParams(name="compute_submit", arguments={})
    )
    assert sidecar.calls[-1] == ("compute.submit", {})
    await handlers.call_tool(
        _context(),
        types.CallToolRequestParams(name="operations.discover", arguments={}),
    )
    assert sidecar.calls[-1] == ("operations.discover", {})
    sidecar.catalog["tools"] = []
    await handlers.call_tool(
        _context(),
        types.CallToolRequestParams(name="operations_discover", arguments={}),
    )
    assert sidecar.calls[-1] == ("operations_discover", {})


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["compute_validate", "compute_submit"])
async def test_in_app_registered_alias_uses_canonical_action_for_renderer_audit(name):
    canonical = name.replace("_", ".", 1)
    sidecar = FakeSidecarClient(_catalog(tools=[_tool(canonical), _tool(name)]))
    handlers = CompanionHandlers(sidecar, CompanionOptions(portable_tool_names=False))
    await handlers.call_tool(
        _context(), types.CallToolRequestParams(name=name, arguments={})
    )
    assert sidecar.calls == [(canonical, {})]
    sidecar.catalog["tools"] = []
    await handlers.call_tool(
        _context(), types.CallToolRequestParams(name=name, arguments={})
    )
    assert sidecar.calls[-1] == (name, {})


@pytest.mark.asyncio
async def test_external_catalog_refuses_unknown_alias_collisions():
    sidecar = FakeSidecarClient(
        _catalog(tools=[_tool("custom.name"), _tool("custom_name")])
    )
    handlers = CompanionHandlers(sidecar, CompanionOptions(portable_tool_names=True))
    with pytest.raises(ValueError, match="collision"):
        await handlers.list_tools(_context(), None)


@pytest.mark.asyncio
async def test_portable_alias_preserves_cancelable_job_ownership():
    sidecar = FakeSidecarClient(
        _catalog(tools=[_tool("operations.start", cancelable=True)])
    )
    sidecar.call_response = {"ok": True, "jobId": "alias-job", "status": "queued"}
    sidecar.block_poll = True
    handlers = CompanionHandlers(sidecar, CompanionOptions(portable_tool_names=True))
    task = asyncio.create_task(
        handlers.call_tool(
            _context(),
            types.CallToolRequestParams(name="operations_start", arguments={}),
        )
    )
    await sidecar.poll_started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert sidecar.calls == [("operations.start", {})]
    assert sidecar.canceled_job_ids == ["alias-job"]


@pytest.mark.asyncio
async def test_app_owned_workspace_rejection_rebinds_once_before_retry():
    class RefreshingSidecar(FakeSidecarClient):
        refreshes = 0

        async def refresh_workspace_binding(self):
            self.refreshes += 1
            self.call_response = {
                "ok": True,
                "status": "completed",
                "result": {"answer": 42},
            }
            return True

    sidecar = RefreshingSidecar(_catalog(tools=[_tool("get_workspace")]))
    sidecar.call_response = {"ok": True, "jobId": "stale-job", "status": "queued"}
    sidecar.job_responses = [
        {
            "status": "failed",
            "error": {
                "code": "WRONG_WORKSPACE",
                "details": {"stateMayHaveChanged": False},
            },
        }
    ]
    handlers = CompanionHandlers(sidecar, CompanionOptions())
    result = await handlers.call_tool(
        _context(), types.CallToolRequestParams(name="get_workspace", arguments={})
    )
    assert result.is_error is False
    assert result.structured_content == {"answer": 42}
    assert sidecar.refreshes == 1
    assert len(sidecar.calls) == 2
    assert len(set(sidecar.idempotency_keys)) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error",
    [
        {"code": "INSUFFICIENT_SCOPE", "details": {"stateMayHaveChanged": False}},
        {"code": "AUDIT_UNAVAILABLE", "details": {"stateMayHaveChanged": False}},
        {"code": "WRONG_WORKSPACE", "details": {"stateMayHaveChanged": True}},
        {"code": "WRONG_WORKSPACE", "details": {}},
    ],
)
async def test_workspace_refresh_never_replays_other_failures(error):
    class RefreshingSidecar(FakeSidecarClient):
        async def refresh_workspace_binding(self):
            pytest.fail("must not rebind or replay this failure")

    sidecar = RefreshingSidecar()
    sidecar.call_response = {"status": "failed", "error": error}
    result = await CompanionHandlers(sidecar, CompanionOptions()).call_tool(
        _context(), types.CallToolRequestParams(name="fixture", arguments={})
    )
    assert result.is_error is True
    assert len(sidecar.calls) == 1


@pytest.mark.asyncio
async def test_agent_user_input_tool_is_exposed_only_for_an_enabled_companion():
    sidecar = FakeSidecarClient(_catalog(tools=[_tool("zeta")]))

    disabled = await CompanionHandlers(sidecar, CompanionOptions()).list_tools(
        _context(), None
    )
    enabled = await CompanionHandlers(
        sidecar,
        CompanionOptions(expose_agent_user_input=True),
    ).list_tools(_context(), None)

    assert [tool.name for tool in disabled.tools] == ["zeta"]
    assert [tool.name for tool in enabled.tools] == [AGENT_USER_INPUT_TOOL_NAME, "zeta"]
    user_input = enabled.tools[0]
    from jsonschema import Draft202012Validator

    output_validator = Draft202012Validator(user_input.output_schema)
    output_validator.validate({"answers": {"assembly": "Gibson", "hosts": ["A", "B"]}})
    output_validator.validate({"outcome": "cancelled"})
    assert not output_validator.is_valid({"answers": {"assembly": {"untyped": True}}})
    assert user_input.annotations is not None
    assert user_input.annotations.read_only_hint is True
    assert user_input.input_schema["properties"]["questions"]["minItems"] == 1
    assert user_input.input_schema["properties"]["questions"]["maxItems"] == 3


@pytest.mark.asyncio
async def test_agent_user_input_tool_relays_mcp_elicitation_without_sidecar_dispatch():
    sidecar = FakeSidecarClient()
    handlers = CompanionHandlers(
        sidecar,
        CompanionOptions(expose_agent_user_input=True),
    )
    ctx = _context()
    elicitations: list[tuple[str, dict[str, Any], str]] = []

    async def elicit_form(
        message: str,
        requested_schema: dict[str, Any],
        related_request_id: str,
    ) -> types.ElicitResult:
        elicitations.append((message, requested_schema, related_request_id))
        return types.ElicitResult(
            action="accept",
            content={"assembly": "Gibson"},
        )

    ctx.session.elicit_form = elicit_form
    result = await handlers.call_tool(
        ctx,
        types.CallToolRequestParams(
            name=AGENT_USER_INPUT_TOOL_NAME,
            arguments={
                "questions": [
                    {
                        "id": "assembly",
                        "header": "Assembly",
                        "question": "Which assembly method?",
                        "options": [
                            {
                                "label": "Gibson",
                                "description": "Use overlapping fragments.",
                            },
                            {
                                "label": "Golden Gate",
                                "description": "Use Type IIS assembly.",
                            },
                        ],
                        "multiSelect": False,
                    }
                ]
            },
        ),
    )

    assert sidecar.calls == []
    assert elicitations == [
        (
            "Which assembly method?",
            {
                "type": "object",
                "properties": {
                    "assembly": {
                        "type": "string",
                        "title": "Assembly",
                        "description": "Which assembly method?",
                        "oneOf": [
                            {
                                "const": "Gibson",
                                "title": "Gibson",
                                "description": "Use overlapping fragments.",
                            },
                            {
                                "const": "Golden Gate",
                                "title": "Golden Gate",
                                "description": "Use Type IIS assembly.",
                            },
                        ],
                    }
                },
                "required": ["assembly"],
            },
            "request-7",
        )
    ]
    assert result.is_error is False
    assert result.structured_content == {"answers": {"assembly": "Gibson"}}
    assert result.content[0].text == '{"answers":{"assembly":"Gibson"}}'


@pytest.mark.asyncio
async def test_agent_user_input_rechecks_grant_before_prompting():
    sidecar = FakeSidecarClient()
    sidecar.discover_error = SidecarHTTPError(
        "GET /mcp/discover", 401, {"error": {"code": "GRANT_REVOKED"}}
    )
    handlers = CompanionHandlers(
        sidecar, CompanionOptions(expose_agent_user_input=True)
    )
    ctx = _context()
    prompted = False

    async def elicit_form(**_kwargs):
        nonlocal prompted
        prompted = True
        raise AssertionError("A revoked app grant must not prompt the user")

    ctx.session.elicit_form = elicit_form
    with pytest.raises(MCPError, match="GRANT_REVOKED"):
        await handlers.call_tool(
            ctx,
            types.CallToolRequestParams(
                name=AGENT_USER_INPUT_TOOL_NAME,
                arguments={
                    "questions": [
                        {
                            "id": "choice",
                            "header": "Choice",
                            "question": "Continue?",
                            "options": [
                                {"label": "Yes", "description": "Continue."},
                                {"label": "No", "description": "Stop."},
                            ],
                        }
                    ]
                },
            ),
        )
    assert not prompted


@pytest.mark.asyncio
async def test_agent_user_input_tool_consumes_authenticated_grok_handoff(
    tmp_path: Path,
):
    sidecar = FakeSidecarClient()
    handoff_path = tmp_path / "response.json"
    questions = [
        {
            "id": "assembly",
            "header": "Assembly",
            "question": "Which assembly method?",
            "options": [
                {"label": "Gibson", "description": "Overlap assembly."},
                {"label": "Golden Gate", "description": "Type IIS assembly."},
            ],
            "multiSelect": False,
        }
    ]
    handoff_path.write_text(
        json.dumps(
            {
                "schema": "dnaforge.grok-user-input-handoff/v1",
                "token": "one-time-token",
                "arguments": {"questions": questions},
                "response": {
                    "outcome": "submitted",
                    "answers": {
                        "assembly": {"selectedOptionIds": ["Gibson"]},
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    handlers = CompanionHandlers(
        sidecar,
        CompanionOptions(
            expose_agent_user_input=True,
            agent_user_input_handoff_path=str(handoff_path),
            agent_user_input_handoff_token="one-time-token",
        ),
    )
    ctx = _context()

    async def unexpected_elicitation(*_args: Any, **_kwargs: Any) -> types.ElicitResult:
        raise AssertionError("Grok handoff must not depend on MCP elicitation")

    ctx.session.elicit_form = unexpected_elicitation
    result = await handlers.call_tool(
        ctx,
        types.CallToolRequestParams(
            name=AGENT_USER_INPUT_TOOL_NAME,
            arguments={"questions": questions},
        ),
    )

    assert sidecar.calls == []
    assert result.is_error is False
    assert result.structured_content == {"answers": {"assembly": "Gibson"}}
    assert not handoff_path.exists()


@pytest.mark.asyncio
async def test_agent_user_input_tool_rejects_a_mismatched_handoff(tmp_path: Path):
    handoff_path = tmp_path / "response.json"
    handoff_path.write_text(
        json.dumps(
            {
                "schema": "dnaforge.grok-user-input-handoff/v1",
                "token": "wrong-token",
                "arguments": {"questions": []},
                "response": {"outcome": "cancelled", "answers": {}},
            }
        ),
        encoding="utf-8",
    )
    handlers = CompanionHandlers(
        FakeSidecarClient(),
        CompanionOptions(
            expose_agent_user_input=True,
            agent_user_input_handoff_path=str(handoff_path),
            agent_user_input_handoff_token="one-time-token",
        ),
    )

    result = await handlers.call_tool(
        _context(),
        types.CallToolRequestParams(
            name=AGENT_USER_INPUT_TOOL_NAME,
            arguments={
                "questions": [
                    {
                        "id": "assembly",
                        "header": "Assembly",
                        "question": "Which assembly method?",
                        "options": [
                            {"label": "Gibson", "description": "Overlap assembly."},
                            {
                                "label": "Golden Gate",
                                "description": "Type IIS assembly.",
                            },
                        ],
                    }
                ]
            },
        ),
    )

    assert result.is_error is True
    assert not handoff_path.exists()


def test_sdk_server_owns_discovery_and_private_zero_ttl_hints():
    server = create_mcp_server(FakeSidecarClient(), CompanionOptions())

    assert server.get_request_handler("server/discover") is not None
    assert server.get_request_handler("tools/list") is not None
    assert server.get_request_handler("tools/call") is not None
    assert server.get_request_handler("resources/read") is not None
    for method in (
        "server/discover",
        "tools/list",
        "resources/list",
        "resources/templates/list",
        "resources/read",
    ):
        hint = server.cache_hints[method]
        assert hint.ttl_ms == 0
        assert hint.scope == "private"


@pytest.mark.asyncio
@pytest.mark.parametrize("surface", ["external", "dnaforge-chat"])
async def test_native_authoring_contract_reaches_initialization_and_discovery(surface):
    server = create_mcp_server(
        FakeSidecarClient(), CompanionOptions(client_surface=surface)
    )
    instructions = native_authoring_instructions()
    assert instructions in server.create_initialization_options().instructions
    assert "Persist every selected oligo" in instructions
    assert "get_entity_link" in instructions
    discovery = await server._dnaforge_handlers.discover(
        _context(), types.RequestParams()
    )
    assert instructions in discovery.instructions
    assert server.create_initialization_options().instructions == discovery.instructions
    assert (
        "This client is external"
        if surface == "external"
        else "This client renders DNAForge chat chips"
    ) in discovery.instructions
    for published in [
        server.create_initialization_options().instructions,
        discovery.instructions,
    ]:
        opening = published[:512].lower()
        for term in [
            "dnaforge",
            "plasmid",
            "get_workspace",
            "draft",
            "oligo",
            "native notebook",
        ]:
            assert term in opening


def test_tool_projection_preserves_output_schema_and_namespaces_extensions():
    server = create_mcp_server(
        FakeSidecarClient(
            _catalog(
                tools=[
                    _tool(
                        "scoped.tool",
                        cancelable=True,
                        output_schema={"type": "object", "required": ["ok"]},
                    )
                ]
            )
        ),
        CompanionOptions(),
    )
    handlers: CompanionHandlers = server._dnaforge_handlers

    projected = handlers.project_tool(
        _tool(
            "scoped.tool",
            cancelable=True,
            output_schema={"type": "object", "required": ["ok"]},
        )
    )

    assert projected.output_schema == {"type": "object", "required": ["ok"]}
    assert projected.annotations is not None
    assert projected.annotations.read_only_hint is True
    assert projected.meta == {
        "com.dnaforge/tool": {"cancelable": True, "duration": "long-running"}
    }


def test_tool_projection_adds_mcp_object_type_to_union_output_schema():
    output_schema = {
        "$defs": {
            "Completed": {
                "type": "object",
                "properties": {"status": {"const": "completed"}},
                "required": ["status"],
            }
        },
        "oneOf": [{"$ref": "#/$defs/Completed"}],
    }

    projected = CompanionHandlers.project_tool(
        _tool("union.output", output_schema=output_schema)
    )

    assert projected.output_schema == {**output_schema, "type": "object"}


def test_tool_projection_rejects_non_object_output_schema():
    with pytest.raises(ValueError, match="must have an object outputSchema"):
        CompanionHandlers.project_tool(
            _tool("array.output", output_schema={"type": "array"})
        )


@pytest.mark.parametrize("alternative", ["oneOf", "anyOf", "allOf"])
def test_tool_projection_preserves_legacy_top_level_alternative_normalization(
    alternative: str,
):
    raw = _tool("variant.tool")
    raw["description"] = "Choose an import source."
    raw["inputSchema"] = {
        "type": "object",
        "description": "Import one source.",
        "properties": {
            "source": {
                "oneOf": [
                    {"type": "string"},
                    {"type": "object"},
                ]
            }
        },
        alternative: [
            {"required": ["source"]},
            {"required": ["sourcePath"]},
        ],
    }

    projected = CompanionHandlers.project_tool(raw)

    assert alternative not in projected.input_schema
    assert projected.input_schema["properties"]["source"]["oneOf"] == [
        {"type": "string"},
        {"type": "object"},
    ]
    assert projected.input_schema["description"] == (
        "Import one source. Use one valid input form; do not mix fields from multiple alternatives."
    )
    assert projected.description == (
        "Choose an import source. For this tool, provide the fields for exactly "
        "one supported input form; the desktop app validates the full request "
        "before execution."
    )


@pytest.mark.asyncio
async def test_per_request_client_info_wins_over_initialize_audit_context():
    sidecar = FakeSidecarClient(_catalog(tools=[_tool("scoped.tool")]))
    handlers = CompanionHandlers(sidecar, CompanionOptions())
    ctx = _context(
        meta={
            types.CLIENT_INFO_META_KEY: {
                "name": "per-request-client",
                "version": "9.0.0",
            }
        }
    )

    await handlers.list_tools(ctx, None)

    assert sidecar.discover_client_info == [
        {"name": "per-request-client", "version": "9.0.0"}
    ]


def test_native_selection_readback_fits_transport_without_losing_structured_data():
    terms = [
        {
            "head": {"name": "structure-query.atom-groups"},
            "args": {
                "residue-test": {
                    "head": {"name": "core.rel.eq"},
                    "args": [
                        {
                            "head": {
                                "name": "structure-query.atom-property.macromolecular.label_seq_id"
                            }
                        },
                        i,
                    ],
                }
            },
        }
        for i in range(1200)
    ]
    body = {
        "ok": True,
        "status": "completed",
        "result": {
            "ok": True,
            "result": {
                "native": {
                    "colorThemeParams": {
                        "layers": [
                            {
                                "selection": {
                                    "name": "script",
                                    "params": {
                                        "script": {
                                            "expression": {
                                                "head": {
                                                    "name": "structure-query.combinator.merge"
                                                },
                                                "args": terms,
                                            }
                                        }
                                    },
                                }
                            }
                        ]
                    }
                }
            },
        },
    }
    result = project_call_result(200, body)
    frame = {
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "item": {
                "type": "mcpToolCall",
                "result": result.model_dump(
                    by_alias=True, mode="json", exclude_none=True
                ),
            }
        },
    }
    assert len(json.dumps(frame, separators=(",", ":")).encode()) < 1024 * 1024
    assert json.loads(result.content[0].text) == body
    assert result.structured_content == body["result"]


@pytest.mark.parametrize("transport_ok", [False, True])
def test_call_projection_cannot_report_success_for_failed_operation(transport_ok):
    body = {
        "ok": transport_ok,
        "jobId": "job-hidden-molecular-target",
        "status": "failed",
        "error": {
            "code": "DATA_TARGETS_NOT_DRAWN",
            "details": {"stateChanged": False, "partialEffects": []},
        },
    }

    result = project_call_result(200, body)

    assert result.is_error is True
    assert json.loads(result.content[0].text) == {**body, "ok": False}
    assert body["ok"] is transport_ok


def test_call_projection_preserves_all_supported_content_kinds():
    body = {
        "ok": True,
        "jobId": "job-1",
        "status": "completed",
        "content": [
            {"type": "text", "text": "finished"},
            {"type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png"},
            {
                "type": "resource",
                "resource": {
                    "uri": "waypoint://artifact/a1",
                    "mimeType": "application/json",
                    "text": '{"artifact":1}',
                },
            },
            {
                "type": "resource_link",
                "name": "Artifact a1",
                "uri": "waypoint://artifact/a1",
                "mimeType": "application/json",
            },
        ],
        "structuredContent": {"answer": 42},
    }

    result = project_call_result(200, body)

    assert [content.type for content in result.content] == [
        "text",
        "image",
        "resource",
        "resource_link",
    ]
    assert result.structured_content == {"answer": 42}
    assert result.meta == {
        "com.dnaforge/job": {"jobId": "job-1", "status": "completed"}
    }
    assert result.is_error is False


@pytest.mark.parametrize("key", ["content", "structuredContent"])
def test_nested_domain_metadata_cannot_become_a_protocol_envelope(key):
    domain = {
        "ok": True,
        "artifactId": "artifact-1",
        "artifact": {"metadata": {key: {"externalPayload": True}}},
    }
    result = project_call_result(
        200, {"ok": True, "status": "completed", "result": domain}
    )
    assert result.structured_content == domain
    assert result.is_error is False


def test_call_projection_detects_nested_renderer_image_and_failure():
    body = {
        "ok": True,
        "status": "completed",
        "result": {
            "ok": False,
            "result": {
                "returns_image": True,
                "data": "iVBORw0KGgo=",
                "mimeType": "image/png",
            },
        },
    }

    result = project_call_result(200, body, tool_name="mol_capture_screenshot")

    assert result.is_error is True
    assert len(result.content) == 1
    assert isinstance(result.content[0], types.ImageContent)
    assert result.content[0].data == "iVBORw0KGgo="
    assert result.structured_content == {
        "ok": False,
        "result": {"returns_image": True, "mimeType": "image/png"},
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("queued", [False, True])
async def test_screenshot_call_sends_image_bytes_once_below_client_limit(queued):
    image_data = base64.b64encode(bytes(450 * 1024)).decode("ascii")
    image = {
        "ok": True,
        "returns_image": True,
        "data": image_data,
        "mimeType": "image/png",
        "viewerId": "saved-view:1fae1f7f-c704-48f3-abcb-b209a13b01af",
        "width": 768,
        "height": 768,
        "byteLength": 450 * 1024,
        "maxBytes": 600 * 1024,
        "downscaled": False,
    }
    completed = {
        "ok": True,
        "jobId": "screenshot-job",
        "status": "completed",
        "result": {"audit_id": "screenshot-audit", "ok": True, "result": image},
    }
    from jsonschema import Draft202012Validator

    from src.concurrency.renderer_bridge import load_renderer_tool_manifest

    screenshot_tool = next(
        tool
        for tool in load_renderer_tool_manifest()["tools"]
        if tool["name"] == "mol_capture_screenshot"
    )
    sidecar = FakeSidecarClient(
        _catalog(
            tools=[
                _tool(
                    "mol_capture_screenshot",
                    output_schema=screenshot_tool["outputSchema"],
                )
            ]
        )
    )
    sidecar.call_response = (
        {"ok": True, "jobId": "screenshot-job", "status": "queued"}
        if queued
        else completed
    )
    sidecar.job_responses = [completed]

    result = await CompanionHandlers(sidecar, CompanionOptions()).call_tool(
        _context(),
        types.CallToolRequestParams(
            name="mol_capture_screenshot",
            arguments={"structureViewId": image["viewerId"]},
        ),
    )

    assert result.is_error is False
    listed = await CompanionHandlers(sidecar, CompanionOptions()).list_tools(
        _context(), None
    )
    public_schema = next(
        tool.output_schema
        for tool in listed.tools
        if tool.name == "mol_capture_screenshot"
    )
    Draft202012Validator(public_schema).validate(result.structured_content)
    assert len(result.content) == 1
    assert isinstance(result.content[0], types.ImageContent)
    assert result.content[0].data == image_data
    assert set(result.structured_content["result"]) == set(image) - {"data"}
    assert result.structured_content == {
        "audit_id": "screenshot-audit",
        "ok": True,
        "result": {key: value for key, value in image.items() if key != "data"},
    }
    wire = result.model_dump_json(by_alias=True, exclude_none=True)
    assert wire.count(image_data) == 1
    assert len(wire.encode("utf-8")) < 1024 * 1024
    assert completed["result"]["result"]["data"] == image_data


def test_call_projection_promotes_sidecar_resource_link_and_embedded_resource():
    body = {
        "ok": True,
        "status": "completed",
        "result": {
            "ok": True,
            "resourceUri": "waypoint://resource-link/link-1",
            "resourceLink": {
                "resourceUri": "waypoint://resource-link/link-1",
                "relationship": "produced_by",
                "sourceUri": "waypoint://artifact/a1",
                "targetUri": "waypoint://analysis-run/r1",
            },
            "embeddedResource": {
                "uri": "waypoint://artifact/a1",
                "mimeType": "application/json",
                "text": '{"artifact":1}',
            },
        },
    }

    result = project_call_result(200, body)

    assert [item.type for item in result.content] == ["resource", "resource_link"]
    embedded = result.content[0]
    assert isinstance(embedded, types.EmbeddedResource)
    assert embedded.resource.text == '{"artifact":1}'
    link = result.content[1]
    assert isinstance(link, types.ResourceLink)
    assert str(link.uri) == "waypoint://resource-link/link-1"
    assert link.name == "produced_by"
    assert link.description == ("waypoint://artifact/a1 -> waypoint://analysis-run/r1")


@pytest.mark.asyncio
async def test_call_polls_queued_job_to_terminal_result():
    sidecar = FakeSidecarClient(_catalog(tools=[_tool("slow.tool", cancelable=True)]))
    sidecar.call_response = {
        "ok": True,
        "jobId": "job-1",
        "status": "queued",
    }
    sidecar.job_responses = [
        {"jobId": "job-1", "status": "running"},
        {
            "jobId": "job-1",
            "status": "completed",
            "result": {"answer": 42},
        },
    ]
    handlers = CompanionHandlers(
        sidecar,
        CompanionOptions(job_poll_interval_seconds=0),
    )

    result = await handlers.call_tool(
        _context(),
        types.CallToolRequestParams(name="slow.tool", arguments={"x": 1}),
    )

    assert sidecar.calls == [("slow.tool", {"x": 1})]
    assert len(sidecar.idempotency_keys) == 1
    assert sidecar.idempotency_keys[0].startswith(
        f"dnaforge-mcp:{handlers._process_nonce}:"
    )
    assert result.structured_content == {"answer": 42}
    assert sidecar.discover_open_workspace_flags == []
    assert handlers.active_request_jobs == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["failed", "canceled"])
async def test_polled_job_failure_is_an_error_after_successful_status_read(status):
    sidecar = FakeSidecarClient(_catalog(tools=[_tool("mol_save_view")]))
    sidecar.call_response = {
        "ok": True,
        "jobId": "saved-view-job",
        "status": "queued",
    }
    terminal = {
        "ok": True,
        "jobId": "saved-view-job",
        "toolName": "mol_save_view",
        "status": status,
        "error": {
            "code": "PLUGIN_NOT_READY",
            "message": "The document was saved, but its viewer is still loading.",
            "details": {
                "stateChanged": True,
                "partialEffects": [
                    {"kind": "saved-molecular-view", "referenceId": "saved-view"}
                ],
            },
        },
    }
    sidecar.job_responses = [terminal]
    handlers = CompanionHandlers(
        sidecar,
        CompanionOptions(job_poll_interval_seconds=0),
    )

    result = await handlers.call_tool(
        _context(),
        types.CallToolRequestParams(name="mol_save_view", arguments={}),
    )

    assert result.is_error is True
    assert json.loads(result.content[0].text) == {**terminal, "ok": False}
    assert result.meta == {
        "com.dnaforge/job": {
            "jobId": "saved-view-job",
            "toolName": "mol_save_view",
            "status": status,
        }
    }
    assert sidecar.calls == [("mol_save_view", {})]
    assert len(sidecar.idempotency_keys) == 1
    assert handlers.active_request_jobs == {}


@pytest.mark.asyncio
async def test_sequential_reused_jsonrpc_id_gets_fresh_admission_keys():
    sidecar = FakeSidecarClient(_catalog(tools=[_tool("echo.tool")]))
    handlers = CompanionHandlers(sidecar, CompanionOptions())

    first = await handlers.call_tool(
        _context(),
        types.CallToolRequestParams(name="echo.tool", arguments={"value": 1}),
    )
    second = await handlers.call_tool(
        _context(),
        types.CallToolRequestParams(name="echo.tool", arguments={"value": 2}),
    )

    assert first.is_error is False
    assert second.is_error is False
    assert sidecar.calls == [
        ("echo.tool", {"value": 1}),
        ("echo.tool", {"value": 2}),
    ]
    assert len(set(sidecar.idempotency_keys)) == 2


@pytest.mark.asyncio
async def test_poll_timeout_cancels_cancelable_admitted_job_before_error_result():
    sidecar = FakeSidecarClient(_catalog(tools=[_tool("slow.tool", cancelable=True)]))
    sidecar.call_response = {
        "ok": True,
        "jobId": "job-timeout",
        "status": "running",
    }
    handlers = CompanionHandlers(
        sidecar,
        CompanionOptions(job_poll_interval_seconds=0, job_timeout_seconds=0),
    )

    result = await handlers.call_tool(
        _context(),
        types.CallToolRequestParams(name="slow.tool", arguments={}),
    )

    assert sidecar.canceled_job_ids == ["job-timeout"]
    assert result.is_error is True
    assert result.structured_content is None
    assert "JOB_POLL_TIMEOUT" in result.content[0].text
    assert result.meta == {
        "com.dnaforge/job": {"jobId": "job-timeout", "status": "failed"}
    }
    assert handlers.active_request_jobs == {}


@pytest.mark.asyncio
async def test_sdk_cancellation_deletes_cancelable_sidecar_job_and_reraises():
    sidecar = FakeSidecarClient(_catalog(tools=[_tool("slow.tool", cancelable=True)]))
    sidecar.call_response = {
        "ok": True,
        "jobId": "job-cancel",
        "status": "running",
    }
    sidecar.block_poll = True
    handlers = CompanionHandlers(
        sidecar,
        CompanionOptions(job_poll_interval_seconds=0),
    )

    task = asyncio.create_task(
        handlers.call_tool(
            _context(),
            types.CallToolRequestParams(name="slow.tool", arguments={}),
        )
    )
    await sidecar.poll_started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert sidecar.canceled_job_ids == ["job-cancel"]
    assert handlers.active_request_jobs == {}


@pytest.mark.asyncio
async def test_cancellation_during_admission_waits_for_job_id_then_deletes():
    sidecar = FakeSidecarClient(_catalog(tools=[_tool("slow.tool", cancelable=True)]))
    sidecar.call_response = {
        "ok": True,
        "jobId": "job-admission-race",
        "status": "running",
    }
    sidecar.block_admission = True
    handlers = CompanionHandlers(
        sidecar,
        CompanionOptions(job_poll_interval_seconds=0),
    )

    task = asyncio.create_task(
        handlers.call_tool(
            _context(),
            types.CallToolRequestParams(name="slow.tool", arguments={}),
        )
    )
    await sidecar.admission_started.wait()
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()

    sidecar.release_admission.set()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert sidecar.canceled_job_ids == ["job-admission-race"]
    assert handlers.active_request_jobs == {}


@pytest.mark.asyncio
async def test_cancellation_after_failed_discovery_uses_job_delete_and_accepts_409():
    sidecar = FakeSidecarClient()
    sidecar.discover_error = SidecarHTTPError(
        "discovery unavailable",
        502,
        {"error": {"code": "WORKSPACE_DISCOVERY_UNAVAILABLE"}},
    )
    sidecar.call_response = {
        "ok": True,
        "jobId": "job-unknown-cancelability",
        "status": "running",
    }
    sidecar.block_poll = True
    sidecar.cancel_errors["job-unknown-cancelability"] = SidecarHTTPError(
        "job is not cancelable",
        409,
        {"error": {"code": "JOB_NOT_CANCELABLE"}},
    )
    handlers = CompanionHandlers(
        sidecar,
        CompanionOptions(job_poll_interval_seconds=0),
    )

    task = asyncio.create_task(
        handlers.call_tool(
            _context(),
            types.CallToolRequestParams(name="slow.tool", arguments={}),
        )
    )
    await sidecar.poll_started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert sidecar.canceled_job_ids == ["job-unknown-cancelability"]
    assert handlers.active_request_jobs == {}


@pytest.mark.asyncio
async def test_discovery_error_message_preserves_sidecar_error_code():
    sidecar = FakeSidecarClient()
    sidecar.discover_error = SidecarHTTPError(
        "MCP session token is missing or invalid.",
        401,
        {"error": {"code": "BAD_SESSION"}},
    )
    handlers = CompanionHandlers(sidecar, CompanionOptions())

    with pytest.raises(MCPError, match="BAD_SESSION"):
        await handlers.list_tools(_context(), None)


@pytest.mark.asyncio
async def test_sdk_cancellation_does_not_delete_noncancelable_renderer_job():
    sidecar = FakeSidecarClient(
        _catalog(tools=[_tool("renderer.tool", cancelable=False)])
    )
    sidecar.call_response = {
        "ok": True,
        "jobId": "job-renderer",
        "status": "running",
    }
    sidecar.block_poll = True
    handlers = CompanionHandlers(
        sidecar,
        CompanionOptions(job_poll_interval_seconds=0),
    )

    task = asyncio.create_task(
        handlers.call_tool(
            _context(),
            types.CallToolRequestParams(name="renderer.tool", arguments={}),
        )
    )
    await sidecar.poll_started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert sidecar.canceled_job_ids == []


@pytest.mark.asyncio
async def test_resource_read_is_private_zero_ttl_and_preserves_contents():
    handlers = CompanionHandlers(FakeSidecarClient(), CompanionOptions())

    result = await handlers.read_resource(
        _context(),
        types.ReadResourceRequestParams(uri="waypoint://selection/ref-1"),
    )

    assert result.ttl_ms == 0
    assert result.cache_scope == "private"
    assert len(result.contents) == 1
    assert result.contents[0].text == '{"kind":"selection"}'


def test_molecular_catalog_union_is_valid_on_the_real_codex_protocol():
    from mcp_types.methods import serialize_server_result

    from src.mcp_companion.projection import project_tool

    manifest = json.loads(
        (
            Path(__file__).resolve().parents[3]
            / "packages/core/agent-tools/renderer-tool-manifest.json"
        ).read_text()
    )
    raw = next(tool for tool in manifest["tools"] if tool["name"] == "mol_structures")
    result = types.ListToolsResult(tools=[project_tool(raw)])
    wire = serialize_server_result(
        "tools/list", "2025-06-18", result.model_dump(by_alias=True, exclude_none=True)
    )
    assert wire["tools"][0]["inputSchema"]["type"] == "object"


@pytest.mark.asyncio
async def test_ordinary_calls_use_fresh_compact_lookup_without_full_catalog():
    sidecar = FakeSidecarClient(_catalog(tools=[_tool("echo")]))
    handlers = CompanionHandlers(sidecar, CompanionOptions())
    await handlers.call_tool(
        _context(), types.CallToolRequestParams(name="echo", arguments={})
    )
    assert sidecar.calls == [("echo", {})]
    assert sidecar.discover_client_info == []


def test_provider_metadata_with_content_markers_is_preserved_as_ordinary_json():
    metadata = {
        "returns_image": True,
        "data": "literal data",
        "mimeType": "image/png",
        "embeddedResource": {
            "uri": "https://example.invalid/private",
            "text": "literal",
        },
        "resourceLink": {"uri": "https://example.invalid/link"},
    }
    domain = {"ok": True, "inputSchema": {"default": metadata}}
    result = project_call_result(
        200,
        {"ok": True, "status": "completed", "result": domain},
        tool_name="compute_getSchema",
    )
    assert result.structured_content == domain
    assert len(result.content) == 1
    assert isinstance(result.content[0], types.TextContent)


@pytest.mark.asyncio
@pytest.mark.parametrize("during_poll", [False, True])
async def test_transport_timeout_preserves_tool_and_recovery_identity(during_poll):
    class TimeoutSidecar(FakeSidecarClient):
        async def call_tool(self, name, arguments, *, idempotency_key):
            self.request_key = idempotency_key
            if not during_poll:
                raise httpx.ReadTimeout("")
            return 202, {"ok": True, "jobId": "owned-job", "status": "running"}

        async def get_job(self, job_id):
            raise httpx.ReadTimeout("")

    sidecar = TimeoutSidecar(_catalog(tools=[_tool("get_sequence")]))
    handlers = CompanionHandlers(sidecar, CompanionOptions(job_poll_interval_seconds=0))
    with pytest.raises(MCPError, match="MCP_TRANSPORT_TIMEOUT") as raised:
        await handlers.call_tool(
            _context(),
            types.CallToolRequestParams(
                name="get_sequence", arguments={"documentId": "imported-sequence"}
            ),
        )
    error = raised.value.error
    assert error.code != 0
    assert "get_sequence" in error.message
    assert error.data["body"]["error"]["details"]["requestId"] == sidecar.request_key
    assert error.data["body"]["error"]["details"]["stateMayHaveChanged"] is True
    if during_poll:
        assert error.data["body"]["error"]["details"]["jobId"] == "owned-job"
    assert sidecar.canceled_job_ids == []
