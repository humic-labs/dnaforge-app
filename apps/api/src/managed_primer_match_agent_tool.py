"""Admit renderer-resolved primer snapshots under the actual agent principal."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

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
    _service,
    managed_operation_audit_result,
)
from .operation_kinds import PRIMER_LIBRARY_SEARCH_OPERATION_KIND
from .operations import ManagedOperationError
from .primer_library_search_operation_contract import (
    PrimerLibrarySearchRequest,
    PrimerLibrarySearchSubmission,
    prepare_primer_library_search_submission,
)


class _PreparedTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    documentId: str
    name: str
    length: int = Field(gt=0)
    circular: bool
    contentSha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    acceptedRevision: dict[str, Any] | None
    input: PrimerLibrarySearchRequest

    @model_validator(mode="after")
    def validate_target(self) -> _PreparedTarget:
        if (
            self.documentId != self.input.target_document_id
            or self.length != len(self.input.reference_sequence)
            or self.circular != self.input.circular
        ):
            raise ValueError("Prepared reference metadata disagrees with its DNA.")
        return self


def _audit_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        **managed_operation_audit_result(result),
        "operation_ids": [
            target["operationId"] for target in result.get("targets", [])
        ],
    }


async def start_primer_match_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    response = await call_renderer_bridge("search_primer_matches", args, context)
    prepared = response.get("result")
    if not isinstance(prepared, dict) or prepared.get("ok") is not True:
        failure = prepared if isinstance(prepared, dict) else response
        raise ToolExecutionFailure(
            code="PRIMER_MATCH_INPUT_RESOLUTION_FAILED",
            message=str(failure.get("error", "Cannot resolve primer search inputs."))[
                :1024
            ],
            retriable=False,
            details={"stateChanged": False},
        )
    try:
        targets = [
            _PreparedTarget.model_validate(value) for value in prepared["targets"]
        ]
        if not 1 <= len(targets) <= 32 or len(
            {target.documentId for target in targets}
        ) != len(targets):
            raise ValueError("Invalid reference selection.")
        primers = targets[0].input.primers
        if any(target.input.primers != primers for target in targets):
            raise ValueError("References must use the same primer snapshot.")
    except (KeyError, TypeError, ValueError, ValidationError) as exc:
        raise ToolExecutionFailure(
            code="INVALID_RENDERER_RESULT",
            message="The renderer returned invalid primer search preparation.",
            retriable=False,
            details={"stateChanged": False},
        ) from exc

    service = _service(context)
    principal = _principal(context, service)
    admitted: list[dict[str, Any]] = []
    try:
        for index, target in enumerate(targets):
            submission = PrimerLibrarySearchSubmission(
                submission_key=f"{context.job_id}:{index}",
                subject={"scope_id": service.runtime_scope},
                input=target.input,
            )
            admission = prepare_primer_library_search_submission(submission)
            snapshot = await service.start(
                principal,
                admission,
                kind=PRIMER_LIBRARY_SEARCH_OPERATION_KIND.key.kind,
            )
            admitted.append(
                {
                    **target.model_dump(mode="json", exclude={"input"}),
                    "operationId": snapshot.id,
                    "state": snapshot.state,
                    "targetRevision": admission.input.target_revision,
                    "libraryRevision": admission.input.library_revision,
                }
            )

            if index == 0:
                _link_operation(service, context, snapshot.id)
    except ManagedOperationError as exc:
        raise ToolExecutionFailure(
            code=exc.code,
            message="Primer search admission failed; inspect any already admitted operation IDs before retrying.",
            retriable=False,
            details={"stateChanged": bool(admitted), "partialEffects": admitted},
        ) from exc
    request = targets[0].input
    return {
        "ok": True,
        "checked": False,
        "targetCount": len(admitted),
        "primerCount": len(primers),
        "primerPins": prepared.get("primerPins", []),
        "targets": admitted,
        "matching": {
            "maxEditDistance": request.max_edit_distance,
            "maxMismatches": request.max_mismatches,
            "minThreePrimeMatchLength": request.min_match_length,
            "sequenceBasis": "complete-ordered-DNA-oligo",
            "coordinateSystem": "zero_based_half_open",
        },
        "next": "Use operations.get and operations.result for each operationId. Admission alone is not a specificity result.",
    }


def register_managed_primer_match_agent_tool() -> None:
    config = next(
        spec for spec in RENDERER_TOOL_SPECS if spec["name"] == "search_primer_matches"
    )
    spec = _renderer_tool_spec(config).model_copy(
        update={
            "home": ToolHome.NATIVE.value,
            "handler_ref": "src.managed_primer_match_agent_tool.start_primer_match_handler",
        }
    )
    agent_tool_registry.register(
        spec,
        start_primer_match_handler,
        replay_policy=ToolReplayPolicy.EXECUTE,
        audit_result_projector=_audit_result,
    )
