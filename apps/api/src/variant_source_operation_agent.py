"""Agent admission for a VCF/BCF path and indexed assembly resolved by the app."""

from __future__ import annotations

from pydantic import ValidationError

from .concurrency.renderer_bridge import call_renderer_bridge
from .concurrency.tool_errors import ToolExecutionFailure
from .concurrency.tool_registry import ToolContext
from .operations import ManagedOperationService, ManagedOperationSubmission
from .variant_source_operation_contract import (
    VariantSourceAgentPreparation,
    VariantSourceAgentStart,
    VariantSourceSubmission,
    prepare_variant_source_submission,
)


async def prepare_agent_variant_source_submission(
    request: VariantSourceAgentStart,
    context: ToolContext,
    service: ManagedOperationService,
) -> ManagedOperationSubmission:
    renderer_response = await call_renderer_bridge(
        "operations.variant-source-preparation.start",
        request.model_dump(mode="json", by_alias=True),
        context,
    )
    renderer_result = renderer_response.get("result")
    if not isinstance(renderer_result, dict):
        raise ToolExecutionFailure(
            code="INVALID_RENDERER_RESULT",
            message="The app returned an invalid variant-source preparation result.",
            retriable=False,
        )
    renderer_error = renderer_result.get("error")
    if isinstance(renderer_error, str) and renderer_error:
        raise ToolExecutionFailure(
            code="VARIANT_SOURCE_INPUT_RESOLUTION_FAILED",
            message=renderer_error[:1024],
            retriable=False,
        )
    try:
        prepared = VariantSourceAgentPreparation.model_validate(renderer_result)
    except ValidationError as exc:
        raise ToolExecutionFailure(
            code="INVALID_RENDERER_RESULT",
            message="The app returned invalid variant-source input.",
            retriable=False,
        ) from exc
    if prepared.assembly_id != request.assembly_id:
        raise ToolExecutionFailure(
            code="INVALID_RENDERER_RESULT",
            message="The app returned variant-source input for another assembly.",
            retriable=False,
        )
    return prepare_variant_source_submission(
        VariantSourceSubmission(
            submission_key=context.job_id,
            subject={"scope_id": service.runtime_scope},
            input=prepared.input,
        )
    )


__all__ = ["prepare_agent_variant_source_submission"]
