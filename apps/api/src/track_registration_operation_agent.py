"""Agent admission for track registration through an app-grounded workspace path."""

from __future__ import annotations

from pydantic import ValidationError

from .concurrency.renderer_bridge import call_renderer_bridge
from .concurrency.tool_errors import ToolExecutionFailure
from .concurrency.tool_registry import ToolContext
from .operations import ManagedOperationService, ManagedOperationSubmission
from .track_registration_operation_contract import (
    TrackRegistrationAgentPreparation,
    TrackRegistrationAgentStart,
    TrackRegistrationSubmission,
    prepare_track_registration_submission,
    track_registration_subject_id,
)


async def prepare_agent_track_registration_submission(
    request: TrackRegistrationAgentStart,
    context: ToolContext,
    service: ManagedOperationService,
) -> ManagedOperationSubmission:
    renderer_response = await call_renderer_bridge(
        "operations.track-registration.start",
        request.model_dump(mode="json", by_alias=True),
        context,
    )
    renderer_result = renderer_response.get("result")
    if not isinstance(renderer_result, dict):
        raise ToolExecutionFailure(
            code="INVALID_RENDERER_RESULT",
            message="The app returned an invalid track registration preparation result.",
            retriable=False,
        )
    renderer_error = renderer_result.get("error")
    if isinstance(renderer_error, str) and renderer_error:
        raise ToolExecutionFailure(
            code="TRACK_INPUT_RESOLUTION_FAILED",
            message=renderer_error[:1024],
            retriable=False,
        )
    try:
        prepared = TrackRegistrationAgentPreparation.model_validate(renderer_result)
    except ValidationError as exc:
        raise ToolExecutionFailure(
            code="INVALID_RENDERER_RESULT",
            message="The app returned invalid track registration input.",
            retriable=False,
        ) from exc

    submission = TrackRegistrationSubmission(
        submission_key=context.job_id,
        subject={
            "scope_id": service.runtime_scope,
            "subject_id": track_registration_subject_id(prepared.input),
        },
        input=prepared.input,
    )
    return prepare_track_registration_submission(submission)


__all__ = ["prepare_agent_track_registration_submission"]
