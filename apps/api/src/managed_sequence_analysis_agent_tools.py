"""Use the existing managed owner for renderer-resolved sequence analyses."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any

from .concurrency.renderer_bridge import (
    RENDERER_TOOL_SPECS,
    _renderer_tool_spec,
    call_renderer_bridge,
)
from .concurrency.schema import ToolHome
from .concurrency.tool_errors import ToolExecutionFailure
from .concurrency.tool_registry import (
    ToolContext,
    ToolReplayPolicy,
    agent_tool_registry,
)
from .managed_operation_agent_tools import (
    _link_operation,
    _principal,
    _raise_managed_failure,
    _service,
    managed_operation_audit_result,
)
from .managed_operation_tool_outputs import (
    CloneAnalysisAdmissionOutput,
    NgsAnalysisAdmissionOutput,
    VariantCallsAdmissionOutput,
)
from .ngs_read_analysis_contract import (
    InvalidRawReadInput,
    NgsReadAnalysisSubmission,
    prepare_ngs_read_submission,
)
from .operations import ManagedOperationError
from .pairwise_session_alignment_operation_contract import (
    PairwiseSessionAlignmentSubmission,
    prepare_pairwise_session_alignment_submission,
)
from .variant_source_operation_contract import (
    VariantSourceSubmission,
    prepare_variant_source_submission,
)


def _prepared(response: dict[str, Any]) -> dict[str, Any]:
    result = response.get("result")
    if (
        not isinstance(result, dict)
        or result.get("ok") is not True
        or "input" not in result
    ):
        raise ToolExecutionFailure(
            code="SEQUENCE_ANALYSIS_PREPARATION_FAILED",
            message=(
                str(
                    (result or {}).get(
                        "error", "The app could not prepare these inputs."
                    )
                )[:1024]
                if isinstance(result, dict)
                else "Invalid analysis preparation."
            ),
            retriable=False,
        )
    return result


async def _renderer_step(
    name: str, args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    """A renderer step has its own audit identity; it cannot finish its parent job."""
    store = _service(context).store
    parent = store.get_agent_action(context.job_id)
    if parent is None or parent["agent_identity_id"] != context.agent_identity_id:
        raise ToolExecutionFailure(
            code="ANALYSIS_PARENT_MISSING",
            message="The analysis action is no longer available.",
            retriable=False,
        )
    child_id = store.insert_agent_action(
        agent_identity_id=context.agent_identity_id,
        tool_name=name,
        parameters=args,
        authorized_scope=context.agent_capabilities,
        parent_action_id=context.job_id,
        root_action_id=parent["root_action_id"],
        job_turn_id=context.turn_id,
    )
    return await call_renderer_bridge(name, args, replace(context, job_id=child_id))


async def start_clone_analysis(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    prepared = _prepared(await _renderer_step("analyze_clone", args, context))
    service = _service(context)
    submission = PairwiseSessionAlignmentSubmission.model_validate(
        {
            "submission_key": context.job_id,
            "subject": {
                "scope_id": service.runtime_scope,
                "document_id": prepared["documentId"],
                "session_id": prepared["sessionId"],
            },
            "input": prepared["input"],
        }
    )
    try:
        operation = await service.start(
            _principal(context, service),
            prepare_pairwise_session_alignment_submission(submission),
            kind="pairwise-session-alignment",
        )
    except ManagedOperationError as error:
        _raise_managed_failure(error)
    _link_operation(service, context, operation.id)

    adoption = await _renderer_step(
        "get_clone_analysis",
        {
            "documentId": prepared["documentId"],
            "sessionId": prepared["sessionId"],
            "operationId": operation.id,
        },
        context,
    )
    result = adoption.get("result")
    if (
        not isinstance(result, dict)
        or result.get("ok") is not True
        or result.get("operationId") != operation.id
    ):
        raise ToolExecutionFailure(
            code="CLONE_ANALYSIS_REVIEW_FAILED",
            message=f"Job {operation.id} was admitted but could not attach to the review. Read the job before retrying.",
            retriable=False,
        )
    return {
        "ok": True,
        "documentId": prepared["documentId"],
        "sessionId": prepared["sessionId"],
        "operationId": operation.id,
        "status": operation.state.value,
    }


async def start_variant_calls(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    prepared = _prepared(await _renderer_step("start_variant_calls", args, context))
    service = _service(context)
    submission = VariantSourceSubmission.model_validate(
        {
            "submission_key": context.job_id,
            "subject": {"scope_id": service.runtime_scope},
            "input": prepared["input"],
        }
    )
    admission = await asyncio.to_thread(prepare_variant_source_submission, submission)
    try:
        operation = await service.start(
            _principal(context, service), admission, kind="variant-source-preparation"
        )
    except ManagedOperationError as error:
        _raise_managed_failure(error)
    _link_operation(service, context, operation.id)
    return {
        "ok": True,
        "documentId": prepared["documentId"],
        "chrom": prepared["chrom"],
        "operationId": operation.id,
        "status": operation.state.value,
    }


async def start_ngs_analysis(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    prepared = _prepared(await _renderer_step("analyze_ngs_reads", args, context))
    service = _service(context)
    submission = NgsReadAnalysisSubmission.model_validate(
        {
            "submission_key": context.job_id,
            "subject": {"scope_id": service.runtime_scope},
            "input": prepared["input"],
        }
    )
    try:
        admission = await asyncio.to_thread(prepare_ngs_read_submission, submission)
    except InvalidRawReadInput as error:
        raise ToolExecutionFailure(
            code="INVALID_RAW_READ_INPUT",
            message=str(error),
            retriable=False,
            details={"stateChanged": False},
        ) from error
    try:
        operation = await service.start(
            _principal(context, service), admission, kind="ngs-read-analysis"
        )
    except ManagedOperationError as error:
        _raise_managed_failure(error)
    _link_operation(service, context, operation.id)
    continuation_arguments = {
        "documentId": prepared["documentId"],
        "operationId": operation.id,
        "name": prepared["name"],
    }
    adoption = await _renderer_step("get_ngs_analysis", continuation_arguments, context)
    result = adoption.get("result")
    if (
        not isinstance(result, dict)
        or result.get("ok") is not True
        or result.get("operationId") != operation.id
    ):
        raise ToolExecutionFailure(
            code="NGS_REVIEW_FAILED",
            message=f"Job {operation.id} was admitted but its review could not attach. Inspect the job before retrying.",
            retriable=False,
        )
    return NgsAnalysisAdmissionOutput(
        ok=True,
        documentId=prepared["documentId"],
        operationId=operation.id,
        status=operation.state,
        continuation={
            "tool": "get_ngs_analysis",
            "arguments": continuation_arguments,
        },
    ).model_dump(mode="json")


def register_sequence_analysis_agent_tools() -> None:
    for name, handler in [
        ("analyze_clone", start_clone_analysis),
        ("start_variant_calls", start_variant_calls),
        ("analyze_ngs_reads", start_ngs_analysis),
    ]:
        config = next(spec for spec in RENDERER_TOOL_SPECS if spec["name"] == name)
        spec = _renderer_tool_spec(config).model_copy(
            update={
                "home": ToolHome.NATIVE.value,
                "outputs": {
                    "analyze_clone": CloneAnalysisAdmissionOutput,
                    "start_variant_calls": VariantCallsAdmissionOutput,
                    "analyze_ngs_reads": NgsAnalysisAdmissionOutput,
                }[name].model_json_schema(),
                "handler_ref": f"src.managed_sequence_analysis_agent_tools.{handler.__name__}",
            }
        )
        agent_tool_registry.register(
            spec,
            handler,
            replay_policy=ToolReplayPolicy.EXECUTE,
            audit_result_projector=managed_operation_audit_result,
        )
