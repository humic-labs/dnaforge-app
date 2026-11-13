from pydantic import TypeAdapter
from typing_extensions import NotRequired, TypedDict


class ManagedOperationRow(TypedDict):
    id: str
    runtime_scope: str
    scope_id: str
    kind: str
    kind_contract_version: int
    origin: str
    reported_run_id: str | None
    subject_id: str
    input_revision: str
    accepted_workspace_input_json: dict[str, object] | None
    input_retention_state: str
    submission_key: str
    submission_payload_hash: str
    matched_submission_payload_hash: NotRequired[str]
    actor_kind: str
    actor_id: str
    channel: str
    cancellation_mode: str
    owner_instance_id: str
    version: int
    state: str
    created_at: float
    updated_at: float
    started_at: float | None
    settled_at: float | None
    cancel_requested_at: float | None
    result_expires_at: float | None
    history_expires_at: float | None
    result_status: str
    result_reservation_bytes: int
    provenance_json: dict[str, object] | None
    action_omitted_count: int
    error_json: dict[str, object] | None


managed_operation_row = TypeAdapter(ManagedOperationRow)
