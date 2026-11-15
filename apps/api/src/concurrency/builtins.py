"""Built-in substrate tools used to verify the  Phase 1a contract."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

from ..agent_analysis_runs import register_agent_analysis_run
from ..agent_artifacts import register_agent_artifact
from ..agent_resource_links import register_agent_resource_link
from ..agent_workflows import (
    build_workflow_run_preparation,
    owned_workflow_ledger_filter,
)
from ..agent_workspace_authority import resolve_artifact_workspace_roots
from ..control_plane import get_control_plane_store
from ..managed_annotation_agent_tools import register_managed_annotation_agent_tools
from ..managed_annotation_document_tools import (
    register_managed_annotation_document_tools,
)
from .renderer_bridge import register_renderer_agent_tools
from .schema import (
    DNAForgeTool,
    ExpectedLatency,
    PoolName,
    ToolCategory,
    ToolDuration,
    ToolEffect,
    ToolHome,
    ToolRuntime,
    ToolShape,
)
from .tool_errors import ToolExecutionFailure
from .tool_registry import ToolContext, agent_tool_registry
from .workflow_output import WorkflowPreparationOutput


async def echo_handler(args: dict[str, Any], context: ToolContext) -> dict[str, Any]:

    if _mcp_contract_probe_enabled():
        delay_ms = args.get("_contractProbeDelayMs", 0)
        if isinstance(delay_ms, int) and not isinstance(delay_ms, bool):
            await asyncio.sleep(max(0, min(delay_ms, 30_000)) / 1000)
    if context.cancel_event.is_set():
        raise asyncio.CancelledError
    return {"echo": args, "jobId": context.job_id}


def _mcp_contract_probe_enabled() -> bool:
    return os.environ.get("DNAFORGE_MCP_CONTRACT_PROBE") == "1"


async def prepare_workflow_run_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    if context.cancel_event.is_set():
        raise asyncio.CancelledError
    workflow_id = args.get("workflowId") or args.get("workflow_id")
    if not isinstance(workflow_id, str) or not workflow_id:
        raise ValueError("workflowId must be a non-empty string.")
    timeout_seconds = args.get("timeoutSeconds", 120)
    if not isinstance(timeout_seconds, int):
        timeout_seconds = 120
    build_desktop = args.get("buildDesktop", True)
    if not isinstance(build_desktop, bool):
        build_desktop = True
    ledger_root = os.environ.get("DNAFORGE_WORKFLOW_LEDGER_ROOT")
    kwargs: dict[str, Any] = {
        "build_desktop": build_desktop,
        "timeout_seconds": timeout_seconds,
    }
    if ledger_root:
        kwargs["ledger_root"] = Path(ledger_root)
    return build_workflow_run_preparation(
        workflow_id,
        ledger_filter=owned_workflow_ledger_filter(context.agent_identity_id),
        **kwargs,
    )


async def register_artifact_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    if context.cancel_event.is_set():
        raise asyncio.CancelledError
    try:
        roots = await resolve_artifact_workspace_roots(
            get_control_plane_store().get_agent_identity(context.agent_identity_id),
            context.native_document_authority,
        )
        return register_agent_artifact(
            args,
            agent_identity_id=context.agent_identity_id,
            action_id=context.job_id,
            workspace_roots=roots,
        )
    except (ValueError, FileNotFoundError) as error:
        raise ToolExecutionFailure(
            code="INVALID_ARTIFACT_INPUT",
            message=str(error),
            retriable=False,
            details={"stateChanged": False},
        ) from error


async def create_analysis_run_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    if context.cancel_event.is_set():
        raise asyncio.CancelledError
    try:
        return register_agent_analysis_run(
            args,
            agent_identity_id=context.agent_identity_id,
            action_id=context.job_id,
        )
    except ValueError as error:
        raise ToolExecutionFailure(
            code="INVALID_ANALYSIS_INPUT",
            message=str(error),
            retriable=False,
            details={"stateChanged": False},
        ) from error


async def create_resource_link_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    if context.cancel_event.is_set():
        raise asyncio.CancelledError
    return register_agent_resource_link(
        args,
        agent_identity_id=context.agent_identity_id,
        action_id=context.job_id,
    )


def echo_tool_spec() -> DNAForgeTool:
    contract_probe = _mcp_contract_probe_enabled()
    return DNAForgeTool(
        name="echo",
        description="Echo input through the sidecar substrate for local contract tests.",
        inputs={
            "type": "object",
            "additionalProperties": True,
            "properties": {"message": {"type": "string"}},
        },
        outputs={
            "type": "object",
            "properties": {
                "echo": {"type": "object"},
                "jobId": {"type": "string"},
            },
            "required": ["echo", "jobId"],
        },
        home=ToolHome.IN_HOST_TRANSITIONAL,
        runtime=ToolRuntime.IN_HOST,
        handler_ref="src.concurrency.builtins.echo_handler",
        pool=PoolName.CPU_FAST,
        expected_latency=(
            ExpectedLatency.SECONDS if contract_probe else ExpectedLatency.SUB_SECOND
        ),
        idempotency_keyable=True,
        streams_progress=False,
        category=ToolCategory(
            shape=ToolShape.DATA_SERVICE,
            duration=(
                ToolDuration.LONG_RUNNING if contract_probe else ToolDuration.IMMEDIATE
            ),
            effects=[ToolEffect.READ_ONLY],
            cancelable=contract_probe,
            approval_gated=False,
        ),
        required_capabilities=["debug.echo"],
        audit_required=False,
    )


def prepare_workflow_run_tool_spec() -> DNAForgeTool:
    return DNAForgeTool(
        name="workflow.prepare_run",
        description=(
            "Prepare a  workflow run command and return prior run context. "
            "This is read-only: it does not launch Electron or mutate the app."
        ),
        inputs={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "workflowId": {
                    "type": "string",
                    "description": "Workflow id from waypoint://workflow/manifest.",
                },
                "buildDesktop": {
                    "type": "boolean",
                    "description": "Include --build in the returned console command.",
                    "default": True,
                },
                "timeoutSeconds": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Timeout passed to the workflow runner command.",
                    "default": 120,
                },
            },
            "required": ["workflowId"],
        },
        outputs=WorkflowPreparationOutput.model_json_schema(),
        home=ToolHome.IN_HOST_TRANSITIONAL,
        runtime=ToolRuntime.IN_HOST,
        handler_ref="src.concurrency.builtins.prepare_workflow_run_handler",
        pool=PoolName.CPU_FAST,
        expected_latency=ExpectedLatency.SUB_SECOND,
        idempotency_keyable=False,
        streams_progress=False,
        category=ToolCategory(
            shape=ToolShape.DATA_SERVICE,
            duration=ToolDuration.IMMEDIATE,
            effects=[ToolEffect.READ_ONLY],
            cancelable=False,
            approval_gated=False,
        ),
        required_capabilities=["read-workspace"],
        audit_required=True,
    )


def register_artifact_tool_spec() -> DNAForgeTool:
    return DNAForgeTool(
        name="artifact.register",
        description=(
            "Register a file, directory, URL, or external result produced outside "
            "the app so DNAForge can track it as a project artifact with provenance."
            " For local artifacts, use an absolute path from get_workspace or "
            "an explicit absolute provenance.cwd for a relative path. "
            "The service does not inherit the shell's working directory."
        ),
        inputs={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["file", "directory", "url", "external"],
                },
                "name": {"type": "string"},
                "description": {"type": "string"},
                "path": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Required for file/directory artifacts. Use an absolute path, or provide the absolute workspace directory in provenance.cwd. Never assume the service shares the command working directory.",
                },
                "sourceUri": {
                    "type": "string",
                    "description": "External URL or provider identifier for url/external artifacts.",
                },
                "mimeType": {"type": "string"},
                "metadata": {"type": "object", "additionalProperties": True},
                "provenance": {
                    "type": "object",
                    "additionalProperties": True,
                    "properties": {
                        "cwd": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Absolute command working directory. Required when path is relative.",
                        }
                    },
                    "description": "Command, cwd, inputs, tool versions, or other run context.",
                },
                "tags": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["kind"],
            "allOf": [
                {
                    "if": {
                        "properties": {"kind": {"enum": ["file", "directory"]}},
                        "required": ["kind"],
                    },
                    "then": {"required": ["path"]},
                }
            ],
        },
        outputs={
            "type": "object",
            "properties": {
                "ok": {"type": "boolean"},
                "artifactId": {"type": "string"},
                "resourceUri": {"type": "string"},
                "artifact": {"type": "object"},
            },
            "required": ["ok", "artifactId", "resourceUri", "artifact"],
        },
        home=ToolHome.IN_HOST_TRANSITIONAL,
        runtime=ToolRuntime.IN_HOST,
        handler_ref="src.concurrency.builtins.register_artifact_handler",
        pool=PoolName.CPU_FAST,
        expected_latency=ExpectedLatency.SUB_SECOND,
        idempotency_keyable=True,
        streams_progress=False,
        category=ToolCategory(
            shape=ToolShape.DATA_SERVICE,
            duration=ToolDuration.IMMEDIATE,
            effects=[ToolEffect.MUTATING],
            cancelable=False,
            approval_gated=False,
        ),
        required_capabilities=["write-workspace"],
        audit_required=True,
    )


def create_analysis_run_tool_spec() -> DNAForgeTool:
    return DNAForgeTool(
        name="analysis_run.create",
        description=(
            "Create a provenance record for an external analysis or command run, "
            "including inputs, outputs, linked artifacts, status, and metrics."
        ),
        inputs={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "name": {"type": "string"},
                "status": {
                    "type": "string",
                    "enum": ["planned", "running", "completed", "failed", "canceled"],
                    "default": "completed",
                },
                "command": {
                    "description": "Command line, argv array, or structured command object.",
                    "oneOf": [
                        {"type": "string"},
                        {"type": "array", "items": {"type": "string"}},
                        {"type": "object", "additionalProperties": True},
                    ],
                },
                "cwd": {"type": "string"},
                "inputs": {
                    "type": "array",
                    "items": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "object", "additionalProperties": True},
                        ]
                    },
                },
                "outputs": {
                    "type": "array",
                    "items": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "object", "additionalProperties": True},
                        ]
                    },
                },
                "inputArtifacts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Registered input artifact IDs or resource URIs returned by "
                        "artifact.register, not file paths. Register files first."
                    ),
                },
                "outputArtifacts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Registered output artifact IDs or resource URIs returned by "
                        "artifact.register, not file paths. Register files first."
                    ),
                },
                "metrics": {"type": "object", "additionalProperties": True},
                "metadata": {"type": "object", "additionalProperties": True},
                "startedAt": {"type": "string"},
                "completedAt": {"type": "string"},
            },
        },
        outputs={
            "type": "object",
            "properties": {
                "ok": {"type": "boolean"},
                "analysisRunId": {"type": "string"},
                "resourceUri": {"type": "string"},
                "analysisRun": {"type": "object"},
            },
            "required": ["ok", "analysisRunId", "resourceUri", "analysisRun"],
        },
        home=ToolHome.IN_HOST_TRANSITIONAL,
        runtime=ToolRuntime.IN_HOST,
        handler_ref="src.concurrency.builtins.create_analysis_run_handler",
        pool=PoolName.CPU_FAST,
        expected_latency=ExpectedLatency.SUB_SECOND,
        idempotency_keyable=True,
        streams_progress=False,
        category=ToolCategory(
            shape=ToolShape.DATA_SERVICE,
            duration=ToolDuration.IMMEDIATE,
            effects=[ToolEffect.MUTATING],
            cancelable=False,
            approval_gated=False,
        ),
        required_capabilities=["write-workspace"],
        audit_required=True,
    )


def create_resource_link_tool_spec() -> DNAForgeTool:
    return DNAForgeTool(
        name="resource_link.create",
        description=(
            "Create a typed link between two DNAForge resources, such as an "
            "analysis run, artifact, workflow, sequence, design, or dataset."
        ),
        inputs={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "sourceUri": {
                    "type": "string",
                    "description": "Source waypoint:// resource URI.",
                },
                "targetUri": {
                    "type": "string",
                    "description": "Target waypoint:// resource URI.",
                },
                "relationship": {
                    "type": "string",
                    "description": "Relationship label, e.g. produced_by or implements_workflow.",
                },
                "metadata": {"type": "object", "additionalProperties": True},
            },
            "required": ["sourceUri", "targetUri", "relationship"],
        },
        outputs={
            "type": "object",
            "properties": {
                "ok": {"type": "boolean"},
                "resourceLinkId": {"type": "string"},
                "resourceUri": {"type": "string"},
                "resourceLink": {"type": "object"},
            },
            "required": ["ok", "resourceLinkId", "resourceUri", "resourceLink"],
        },
        home=ToolHome.IN_HOST_TRANSITIONAL,
        runtime=ToolRuntime.IN_HOST,
        handler_ref="src.concurrency.builtins.create_resource_link_handler",
        pool=PoolName.CPU_FAST,
        expected_latency=ExpectedLatency.SUB_SECOND,
        idempotency_keyable=True,
        streams_progress=False,
        category=ToolCategory(
            shape=ToolShape.DATA_SERVICE,
            duration=ToolDuration.IMMEDIATE,
            effects=[ToolEffect.MUTATING],
            cancelable=False,
            approval_gated=False,
        ),
        required_capabilities=["write-workspace"],
        audit_required=True,
    )


def register_builtin_agent_tools() -> None:
    agent_tool_registry.register(echo_tool_spec(), echo_handler)
    agent_tool_registry.register(
        prepare_workflow_run_tool_spec(), prepare_workflow_run_handler
    )
    agent_tool_registry.register(
        register_artifact_tool_spec(), register_artifact_handler
    )
    agent_tool_registry.register(
        create_analysis_run_tool_spec(), create_analysis_run_handler
    )
    agent_tool_registry.register(
        create_resource_link_tool_spec(), create_resource_link_handler
    )
    register_managed_annotation_agent_tools()
    register_managed_annotation_document_tools()
    from ..native_file_document_tools import register_native_file_document_tool

    register_native_file_document_tool()
    from ..native_workflow_tools import register_native_workflow_tools

    register_native_workflow_tools()
    from ..managed_msa_agent_tool import register_managed_msa_agent_tool
    from ..managed_primer_match_agent_tool import (
        register_managed_primer_match_agent_tool,
    )

    register_managed_msa_agent_tool()
    register_managed_primer_match_agent_tool()
    from ..managed_sequence_analysis_agent_tools import (
        register_sequence_analysis_agent_tools,
    )

    register_sequence_analysis_agent_tools()
    register_renderer_agent_tools()
