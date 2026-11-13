"""Agent admission for genome indexing through an app-grounded workspace path."""

from __future__ import annotations

from pydantic import ValidationError

from .concurrency.renderer_bridge import call_renderer_bridge
from .concurrency.tool_errors import ToolExecutionFailure
from .concurrency.tool_registry import ToolContext
from .genome_index_operation_contract import (
    GenomeIndexAgentPreparation,
    GenomeIndexAgentStart,
    GenomeIndexSubmission,
    genome_index_subject_id,
    prepare_genome_index_submission,
)
from .operations import ManagedOperationService, ManagedOperationSubmission


async def prepare_agent_genome_index_submission(
    request: GenomeIndexAgentStart,
    context: ToolContext,
    service: ManagedOperationService,
) -> ManagedOperationSubmission:
    renderer_response = await call_renderer_bridge(
        "operations.genome-indexing.start",
        request.model_dump(mode="json"),
        context,
    )
    renderer_result = renderer_response.get("result")
    if not isinstance(renderer_result, dict):
        raise ToolExecutionFailure(
            code="INVALID_RENDERER_RESULT",
            message="The app returned an invalid genome-index preparation result.",
            retriable=False,
        )
    renderer_error = renderer_result.get("error")
    if isinstance(renderer_error, str) and renderer_error:
        raise ToolExecutionFailure(
            code="GENOME_INDEX_INPUT_RESOLUTION_FAILED",
            message=renderer_error[:1024],
            retriable=False,
        )
    try:
        prepared = GenomeIndexAgentPreparation.model_validate(renderer_result)
    except ValidationError as exc:
        raise ToolExecutionFailure(
            code="INVALID_RENDERER_RESULT",
            message="The app returned invalid genome-index input.",
            retriable=False,
        ) from exc

    submission = GenomeIndexSubmission(
        submission_key=context.job_id,
        subject={
            "scope_id": service.runtime_scope,
            "subject_id": genome_index_subject_id(prepared.input),
        },
        input=prepared.input,
    )
    return prepare_genome_index_submission(submission)


__all__ = ["prepare_agent_genome_index_submission"]
