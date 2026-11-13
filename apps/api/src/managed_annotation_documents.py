"""Authorize once, dispatch once, and report the common document receipt."""

from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import TypeAdapter, ValidationError

from .annotation_document_contract import (
    AnnotationDocumentSelection,
    AnnotationDocumentTarget,
)
from .annotation_document_responses import (
    AnnotationDocumentApplyResponse,
    AnnotationDocumentInspection,
    AnnotationDocumentOutcome,
    DocumentNotSaved,
    DocumentOutcomeUnresolved,
    DocumentSaved,
)
from .managed_annotation_document_actions import ManagedAnnotationDocumentActions
from .native_document_dispatch import (
    NativeDocumentDispatchResult,
    dispatch_native_document_command,
)
from .operations import (
    ManagedOperationError,
    OperationPrincipal,
    OperationQueueFull,
    SubmissionConflict,
)
from .operations.document_actions import DocumentWriteSettlement
from .security.native_document_authority import (
    NativeDocumentAuthority,
    native_document_command_url,
)

_OUTCOME = TypeAdapter(AnnotationDocumentOutcome)
_UNCONFIRMED = (
    "The document outcome is not confirmed. Observe this action before repeating work."
)


class NativeDocumentConnectionUnavailable(ManagedOperationError):
    code = "NATIVE_DOCUMENT_CONNECTION_UNAVAILABLE"


_INSPECTION_REASONS = {
    "dispatch_incomplete": "The document owner did not confirm the inspection.",
    "schema_invalid": "The document owner returned an incompatible inspection.",
    "authority_changed": "The retained result changed during inspection.",
    "identity_mismatch": "The inspection belongs to a different document or result.",
    "operation_version_mismatch": "The inspection uses an older retained result version.",
    "result_mismatch": "The inspection does not match the retained result.",
    "input_revision_mismatch": "The inspection does not match the analyzed sequence revision.",
    "applicability_mismatch": "The document owner returned inconsistent review readiness.",
    "candidate_order_mismatch": "The inspected candidate ordering could not be confirmed.",
    "candidate_bounds_mismatch": "The inspected candidates are outside the retained result.",
    "coordinate_mismatch": "The inspected coordinate history could not be confirmed.",
    "candidate_identity_mismatch": "The inspected candidate identities could not be confirmed.",
    "candidate_source_mismatch": "The inspected candidates do not match the retained result.",
    "candidate_mapping_mismatch": "The inspected coordinates do not match the analyzed revision.",
}


class NativeDocumentInspectionUnavailable(ManagedOperationError):
    code = "NATIVE_DOCUMENT_INSPECTION_UNAVAILABLE"

    def __init__(self, reason_code: str):
        self.reason_code = reason_code
        super().__init__(
            _INSPECTION_REASONS[reason_code]
            + " Refresh review to inspect the retained result again. No annotations were saved."
        )


class ManagedAnnotationDocuments:
    def __init__(
        self,
        *,
        actions: ManagedAnnotationDocumentActions,
        authority: NativeDocumentAuthority | None,
        dispatch: Callable[
            [NativeDocumentAuthority, dict[str, Any]],
            Awaitable[NativeDocumentDispatchResult],
        ] = dispatch_native_document_command,
    ) -> None:
        self.actions = actions
        self.authority = authority
        self.dispatch = dispatch

    def _connection(self) -> NativeDocumentAuthority:
        authority = self.authority
        if (
            authority is None
            or not authority.token
            or authority.owner_instance_id != self.actions.native_owner_instance_id
            or native_document_command_url(authority.command_url) is None
        ):
            raise NativeDocumentConnectionUnavailable(
                "No native document owner is connected to this runtime."
            )
        return authority

    async def inspect(
        self, principal: OperationPrincipal, target: AnnotationDocumentTarget
    ) -> AnnotationDocumentInspection:
        connection = self._connection()
        target = target.model_copy(deep=True)
        authority = self.actions.inspection_authority(principal, target)
        response = await self.dispatch(
            connection,
            {
                "command": "annotation.inspect",
                "target": target.model_dump(mode="json", by_alias=True),
                "authority": authority,
            },
        )
        current = self.actions.inspection_authority(principal, target)
        try:
            inspection = AnnotationDocumentInspection.model_validate(response.result)
        except ValidationError:
            inspection = None
        if response.disposition != "completed":
            raise NativeDocumentInspectionUnavailable("dispatch_incomplete")
        if inspection is None:
            raise NativeDocumentInspectionUnavailable("schema_invalid")
        reason = _inspection_failure_reason(inspection, target, authority, current)
        if reason is not None:
            raise NativeDocumentInspectionUnavailable(reason)
        return inspection

    async def apply(
        self, principal: OperationPrincipal, selection: AnnotationDocumentSelection
    ) -> AnnotationDocumentApplyResponse:
        connection = self._connection()
        selection = selection.model_copy(deep=True)
        admitted = self.actions.admit(principal, selection)
        if admitted.status == "full":
            raise OperationQueueFull("The native document action capacity is full.")
        if admitted.status != "admitted" or admitted.record is None:
            raise SubmissionConflict(
                "The document action was not admitted. Check existing actions before repeating work."
            )
        action_id = admitted.record["id"]
        response = await self.dispatch(
            connection,
            {
                "command": "annotation.apply",
                "request": {
                    "actionId": action_id,
                    "requestSha256": selection.request_sha256(),
                    "selection": selection.model_dump(mode="json", by_alias=True),
                },
            },
        )
        if response.disposition == "refused":
            self.actions.journal.settle(
                action_id=action_id,
                request_sha256=selection.request_sha256(),
                status="blocked",
                reason=response.reason or "The native owner refused the command.",
            )
        row = self.actions.service.store.get_managed_operation_action(action_id)
        outcome = self._receipt_outcome(row, admitted.record, response)
        return AnnotationDocumentApplyResponse(action_id=action_id, outcome=outcome)

    def _receipt_outcome(
        self,
        row: dict | None,
        admitted: dict,
        response: NativeDocumentDispatchResult,
    ) -> AnnotationDocumentOutcome:
        unresolved = DocumentOutcomeUnresolved(
            status="outcome-unresolved", action_id=admitted["id"], reason=_UNCONFIRMED
        )
        if row is None or any(
            row.get(key) != admitted[key]
            for key in (
                "id",
                "operation_id",
                "action",
                "actor_kind",
                "actor_id",
                "channel",
            )
        ):
            return unresolved
        details = row.get("details_json")
        if not isinstance(details, dict) or any(
            details.get(key) != admitted["details_json"][key]
            for key in (
                "target_document_id",
                "request_sha256",
                "native_owner_instance_id",
            )
        ):
            return unresolved
        try:
            settlement = DocumentWriteSettlement.model_validate(
                details.get("settlement")
            )
        except ValidationError:
            return unresolved
        if row["outcome"] != "document_" + settlement.status.replace("-", "_"):
            return unresolved
        if settlement.status == "saved":
            intent = details.get("write_intent")
            if (
                not isinstance(intent, dict)
                or settlement.observed_sha256 != intent.get("after_sha256")
                or settlement.target_revision is None
                or settlement.target_revision != intent.get("target_revision")
                or settlement.checkpoint is None
            ):
                return unresolved
            saved = DocumentSaved(
                status="saved",
                target_document_revision=settlement.target_revision,
                checkpoint=settlement.checkpoint,
            )
            try:
                native = _OUTCOME.validate_python(response.result)
            except ValidationError:
                native = None
            if (
                response.disposition == "completed"
                and isinstance(native, DocumentSaved)
                and native.target_document_revision == saved.target_document_revision
                and native.checkpoint == saved.checkpoint
            ):
                return native
            return saved
        if settlement.status in {"blocked", "save-failed"}:
            return DocumentNotSaved(
                status=settlement.status,
                reason=settlement.reason
                or "The document was not saved by this action.",
                target_document_revision=settlement.target_revision,
            )
        return unresolved


def _inspection_failure_reason(
    inspection: AnnotationDocumentInspection,
    target: AnnotationDocumentTarget,
    authority: dict,
    current: dict,
) -> str | None:
    """Keep every authority check; report only its first bounded failure."""
    if current != authority:
        return "authority_changed"
    if (
        inspection.operation_id != target.operation_id
        or inspection.target_document_id != target.target_document_id
    ):
        return "identity_mismatch"
    if inspection.operation_version != authority["operation"]["version"]:
        return "operation_version_mismatch"
    if inspection.result_sha256 != authority["resultSha256"]:
        return "result_mismatch"
    if (
        inspection.analyzed_input_revision
        != authority["operation"]["subject"]["input_revision"]
    ):
        return "input_revision_mismatch"
    if inspection.applicable != (inspection.block_reason is None):
        return "applicability_mismatch"
    indexes = [candidate.index for candidate in inspection.candidates]
    if indexes != sorted(set(indexes)):
        return "candidate_order_mismatch"
    if any(index >= len(authority["result"]["features"]) for index in indexes):
        return "candidate_bounds_mismatch"
    if (inspection.coordinates == "exact" and inspection.transition_count != 0) or (
        inspection.coordinates == "mapped" and inspection.transition_count < 1
    ):
        return "coordinate_mismatch"
    for candidate in inspection.candidates:
        if candidate.id != f"{target.operation_id}:{candidate.index}":
            return "candidate_identity_mismatch"
        if (
            candidate.source_feature.model_dump(mode="json", round_trip=True)
            != authority["result"]["features"][candidate.index]
        ):
            return "candidate_source_mismatch"
        if (
            inspection.coordinates == "exact"
            and candidate.feature != candidate.source_feature
        ):
            return "candidate_mapping_mismatch"
    return None
