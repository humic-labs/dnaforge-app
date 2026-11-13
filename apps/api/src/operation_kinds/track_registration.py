from __future__ import annotations

from ..operations import CancellationMode
from ..operations.registration import (
    AgentStartContract,
    ExecutableOperationKind,
    OperationKindKey,
    OperationLimits,
    ResultCodec,
    StartContract,
)
from ..track_registration_operation_agent import (
    prepare_agent_track_registration_submission,
)
from ..track_registration_operation_audit import (
    track_registration_agent_audit_parameters,
    track_registration_submission_audit_parameters,
)
from ..track_registration_operation_contract import (
    RegisterTrackRequest,
    RegisterTrackResponse,
    TrackRegistrationAgentStart,
    TrackRegistrationSubmission,
    prepare_track_registration_submission,
)

TRACK_REGISTRATION_OPERATION_KIND = ExecutableOperationKind(
    key=OperationKindKey(kind="track-registration", version=1),
    title="Register track",
    input_model=RegisterTrackRequest,
    result=ResultCodec(
        current_version=1,
        model=RegisterTrackResponse,
        decoders={1: RegisterTrackResponse.model_validate},
    ),
    start=StartContract(
        request_model=TrackRegistrationSubmission,
        prepare=prepare_track_registration_submission,
        required_capabilities=frozenset({"operations.start"}),
        audit_parameters=track_registration_submission_audit_parameters,
    ),
    agent_start=AgentStartContract(
        request_model=TrackRegistrationAgentStart,
        prepare=prepare_agent_track_registration_submission,
        required_capabilities=frozenset({"operations.start", "read-workspace"}),
        audit_parameters=track_registration_agent_audit_parameters,
    ),
    cancellation=CancellationMode.QUEUED_ONLY,
    limits=OperationLimits(max_input_bytes=16 * 1024, max_result_bytes=8 * 1024),
)


__all__ = ["TRACK_REGISTRATION_OPERATION_KIND"]
