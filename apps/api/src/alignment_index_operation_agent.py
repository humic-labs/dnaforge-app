"""Agent admission for BAM indexing through an app-grounded workspace path."""

from __future__ import annotations

from pydantic import ValidationError

from .alignment_index_operation_contract import (
    AlignmentIndexAgentPreparation,
    AlignmentIndexAgentStart,
    AlignmentIndexSubmission,
    prepare_alignment_index_submission,
)
from .concurrency.renderer_bridge import call_renderer_bridge
from .concurrency.tool_errors import ToolExecutionFailure
from .concurrency.tool_registry import ToolContext
from .operations import ManagedOperationService, ManagedOperationSubmission


async def prepare_agent_alignment_index_submission(
    request: AlignmentIndexAgentStart,
    context: ToolContext,
    service: ManagedOperationService,
) -> ManagedOperationSubmission:
    renderer_response = await call_renderer_bridge(
        "operations.alignment-index-preparation.start",
        request.model_dump(mode="json"),
        context,
    )
    renderer_result = renderer_response.get("result")
    if not isinstance(renderer_result, dict):
        raise ToolExecutionFailure(
            code="INVALID_RENDERER_RESULT",
            message="The app returned an invalid alignment-index preparation result.",
            retriable=False,
        )
    renderer_error = renderer_result.get("error")
    if isinstance(renderer_error, str) and renderer_error:
        raise ToolExecutionFailure(
            code="ALIGNMENT_INDEX_INPUT_RESOLUTION_FAILED",
            message=renderer_error[:1024],
            retriable=False,
        )
    try:
        prepared = AlignmentIndexAgentPreparation.model_validate(renderer_result)
    except ValidationError as exc:
        raise ToolExecutionFailure(
            code="INVALID_RENDERER_RESULT",
            message="The app returned invalid alignment-index input.",
            retriable=False,
        ) from exc
    return prepare_alignment_index_submission(
        AlignmentIndexSubmission(
            submission_key=context.job_id,
            subject={"scope_id": service.runtime_scope},
            input=prepared.input,
        )
    )


__all__ = ["prepare_agent_alignment_index_submission"]
