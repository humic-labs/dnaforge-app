"""Sidecar admission adapter for the renderer's LIMS-aware run_msa command."""

from __future__ import annotations

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
from .managed_operation_tool_outputs import AlignmentAdmissionOutput
from .msa_operation_contract import (
    MultipleSequenceAlignmentSubmission,
    prepare_multiple_sequence_alignment_submission,
)
from .operation_kinds import MULTIPLE_SEQUENCE_ALIGNMENT_OPERATION_KIND
from .operations import ManagedOperationError


async def start_managed_msa_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    renderer_response = await call_renderer_bridge("run_msa", args, context)
    renderer_result = renderer_response.get("result")
    if not isinstance(renderer_result, dict):
        raise ToolExecutionFailure(
            code="INVALID_RENDERER_RESULT",
            message="The renderer returned an invalid alignment preparation result.",
            retriable=False,
        )
    renderer_error = renderer_result.get("error")
    if isinstance(renderer_error, str) and renderer_error:
        raise ToolExecutionFailure(
            code="MSA_INPUT_RESOLUTION_FAILED",
            message=renderer_error[:1024],
            retriable=False,
        )

    service = _service(context)
    try:
        submission = MultipleSequenceAlignmentSubmission.model_validate(
            {
                "submission_key": context.job_id,
                "subject": {
                    "scope_id": service.runtime_scope,
                    "subject_id": renderer_result.get("subject_id"),
                },
                "input": renderer_result.get("input"),
            }
        )
    except ValueError as exc:
        raise ToolExecutionFailure(
            code="INVALID_RENDERER_RESULT",
            message="The renderer returned invalid alignment input.",
            retriable=False,
        ) from exc

    try:
        snapshot = await service.start(
            _principal(context, service),
            prepare_multiple_sequence_alignment_submission(submission),
            kind=MULTIPLE_SEQUENCE_ALIGNMENT_OPERATION_KIND.key.kind,
        )
    except ManagedOperationError as exc:
        _raise_managed_failure(exc)
    _link_operation(service, context, snapshot.id)
    return {
        "ok": True,
        "operationId": snapshot.id,
        "result": snapshot.model_dump(mode="json"),
    }


def register_managed_msa_agent_tool() -> None:
    config = next(spec for spec in RENDERER_TOOL_SPECS if spec["name"] == "run_msa")
    spec = _renderer_tool_spec(config).model_copy(
        update={
            "home": ToolHome.NATIVE.value,
            "outputs": AlignmentAdmissionOutput.model_json_schema(),
            "handler_ref": "src.managed_msa_agent_tool.start_managed_msa_handler",
        }
    )
    agent_tool_registry.register(
        spec,
        start_managed_msa_handler,
        replay_policy=ToolReplayPolicy.EXECUTE,
        audit_result_projector=managed_operation_audit_result,
    )
