"""Retained-result authorization for native annotation document commands."""

from __future__ import annotations

from dnaforge_annotation.contract import AnnotationRequest, AnnotationResult

from .annotation_document_contract import (
    AnnotationDocumentSelection,
    AnnotationDocumentTarget,
)
from .annotation_result_authority import (
    result_sha256 as _result_sha256,
)
from .annotation_result_authority import (
    trusted_result_context as _trusted_context,
)
from .capability_policy import has_required_capabilities
from .concurrency.renderer_bridge import RENDERER_TOOL_SPECS
from .control_plane import new_uuid7
from .control_plane.store import ManagedDocumentActionAdmission
from .operations import (
    ActorKind,
    ManagedOperationService,
    OperationAccessDenied,
    OperationPrincipal,
    OperationState,
    SubmissionConflict,
)
from .operations.document_actions import (
    DocumentJournalResponse,
    DocumentWriteIntent,
    ManagedDocumentActionJournal,
)

_APPLY_CAPABILITIES = frozenset(
    next(
        spec["required_capabilities"]
        for spec in RENDERER_TOOL_SPECS
        if spec["name"] == "operations.annotation.apply"
    )
)
_INSPECT_CAPABILITIES = frozenset(
    next(
        spec["required_capabilities"]
        for spec in RENDERER_TOOL_SPECS
        if spec["name"] == "operations.annotation.inspect"
    )
)


class ManagedAnnotationDocumentActions:
    def __init__(
        self,
        *,
        service: ManagedOperationService[AnnotationRequest, AnnotationResult],
        native_owner_instance_id: str,
        max_pending: int = 8,
    ) -> None:
        self.service = service
        self.native_owner_instance_id = native_owner_instance_id
        self.max_pending = max_pending
        self.journal = ManagedDocumentActionJournal(
            store=service.store,
            runtime_scope=service.runtime_scope,
            native_owner_instance_id=native_owner_instance_id,
            clock=service.clock,
        )

    def inspection_authority(
        self, principal: OperationPrincipal, target: AnnotationDocumentTarget
    ) -> dict:
        if principal.actor_kind == ActorKind.AGENT and not has_required_capabilities(
            list(principal.capabilities), sorted(_INSPECT_CAPABILITIES)
        ):
            raise OperationAccessDenied(
                "Document inspection requires workspace and sequence read authority"
            )
        with self.service.store.transaction():
            return self._retained_authority(principal, target)

    def _retained_authority(
        self, principal: OperationPrincipal, target: AnnotationDocumentTarget
    ) -> dict:
        snapshot = self.service.get(principal, target.operation_id)
        envelope = self.service.get_result(principal, target.operation_id)
        if (
            snapshot.kind != "annotation"
            or snapshot.state != OperationState.SUCCEEDED
            or snapshot.result_status != "available"
            or snapshot.subject.subject_id != target.target_document_id
            or snapshot.subject.subject_id.startswith("external-input:")
            or envelope.status != "available"
            or not isinstance(envelope.result, AnnotationResult)
            or envelope.result.error is not None
        ):
            raise SubmissionConflict(
                "The operation has no retained annotation result for this document"
            )
        return _trusted_context(
            snapshot, envelope.result, _result_sha256(envelope.result)
        )

    def _authorize(
        self, principal: OperationPrincipal, selection: AnnotationDocumentSelection
    ) -> dict:
        if principal.actor_kind == ActorKind.AGENT and not has_required_capabilities(
            list(principal.capabilities), sorted(_APPLY_CAPABILITIES)
        ):
            raise OperationAccessDenied(
                "Document Apply requires workspace read and write authority"
            )
        authority = self.inspection_authority(principal, selection)
        if (
            authority["operation"]["version"] != selection.expected_operation_version
            or authority["resultSha256"] != selection.expected_result_sha256
        ):
            raise SubmissionConflict("The retained operation changed after inspection")
        for candidate_id in selection.selected_candidate_ids:
            prefix = selection.operation_id + ":"
            index = candidate_id.removeprefix(prefix)
            if (
                not candidate_id.startswith(prefix)
                or not index.isascii()
                or not index.isdecimal()
                or len(index) > 10
                or str(int(index)) != index
                or int(index) >= len(authority["result"]["features"])
            ):
                raise SubmissionConflict(
                    "The selection contains an unknown annotation candidate"
                )
        return authority

    def admit(
        self, principal: OperationPrincipal, selection: AnnotationDocumentSelection
    ) -> ManagedDocumentActionAdmission:
        with self.service.store.transaction():
            self._authorize(principal, selection)
            return self.service.store.admit_managed_document_action(
                operation_id=selection.operation_id,
                runtime_scope=self.service.runtime_scope,
                action_id=new_uuid7(),
                actor_kind=principal.actor_kind.value,
                actor_id=principal.actor_id,
                channel=principal.channel.value,
                target_document_id=selection.target_document_id,
                native_owner_instance_id=self.native_owner_instance_id,
                request_sha256=selection.request_sha256(),
                recorded_at=self.service.clock(),
                max_pending=self.max_pending,
            )

    def authority(self, action_id: str, selection: AnnotationDocumentSelection) -> dict:
        with self.service.store.transaction():
            row = self.service.store.get_managed_operation_action(action_id)
            if row is None or row["action"] != "apply_to_document":
                raise SubmissionConflict("The document action is unavailable")
            details = row["details_json"]
            if (
                row["operation_id"] != selection.operation_id
                or not isinstance(details, dict)
                or details.get("target_document_id") != selection.target_document_id
                or details.get("request_sha256") != selection.request_sha256()
                or details.get("native_owner_instance_id")
                != self.native_owner_instance_id
            ):
                raise SubmissionConflict(
                    "The document action does not match this request or owner"
                )
            caller = OperationPrincipal(
                actor_kind=row["actor_kind"],
                actor_id=row["actor_id"],
                channel=row["channel"],
                scope_ids={self.service.runtime_scope},
                capabilities=(
                    _APPLY_CAPABILITIES if row["actor_kind"] == "agent" else frozenset()
                ),
            )
            return self._authorize(caller, selection)

    def begin_write(
        self,
        action_id: str,
        selection: AnnotationDocumentSelection,
        intent: DocumentWriteIntent,
    ) -> DocumentJournalResponse:
        if (
            intent.selection_count != len(selection.selected_candidate_ids)
            or intent.selection_sha256 != selection.selection_sha256()
        ):
            raise SubmissionConflict(
                "The native intent does not match the admitted selection"
            )

        def revalidate() -> None:
            self.authority(action_id, selection)

        return self.journal.begin_write(
            action_id=action_id,
            request_sha256=selection.request_sha256(),
            intent=intent,
            revalidate=revalidate,
        )
