"""Private native-owner callbacks; public clients cannot certify document saves."""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from ..annotation_document_contract import AnnotationDocumentSelection
from ..managed_annotation_document_actions import ManagedAnnotationDocumentActions
from ..operations.document_actions import (
    Digest,
    DocumentJournalResponse,
    DocumentWriteIntent,
    DocumentWriteSettlement,
    PendingDocumentActionsResponse,
)
from ..security.native_document_authority import require_native_document_authority
from .operations import (
    OperationValidationErrorResponse,
    SanitizedOperationRoute,
    operation_errors,
    operation_owner,
)

router = APIRouter(
    prefix="/internal/managed-documents",
    tags=["Native document callbacks"],
    dependencies=[Depends(require_native_document_authority)],
    route_class=SanitizedOperationRoute,
    responses={422: {"model": OperationValidationErrorResponse}},
)


class _AuthorityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    selection: AnnotationDocumentSelection


class _IntentRequest(_AuthorityRequest):
    intent: DocumentWriteIntent


class _SettlementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_sha256: Digest
    settlement: DocumentWriteSettlement


class _RecoveryRequest(_SettlementRequest):
    previous_native_owner_instance_id: str = Field(min_length=1, max_length=128)


def _actions(
    request: Request,
    native_owner_id: Annotated[str, Depends(require_native_document_authority)],
) -> ManagedAnnotationDocumentActions:
    return ManagedAnnotationDocumentActions(
        service=operation_owner(request),
        native_owner_instance_id=native_owner_id,
    )


NativeActions = Annotated[ManagedAnnotationDocumentActions, Depends(_actions)]
ActionId = Annotated[str, Path(min_length=1, max_length=128)]


@router.get("/pending", response_model=PendingDocumentActionsResponse)
def pending(
    actions: NativeActions,
    limit: Annotated[int, Query(ge=1, le=32)] = 32,
    after_action_id: Annotated[str | None, Query(min_length=1, max_length=128)] = None,
) -> PendingDocumentActionsResponse:
    with operation_errors():
        return actions.journal.pending(limit=limit, after_action_id=after_action_id)


@router.post("/actions/{action_id}/authority")
def authority(
    action_id: ActionId, body: _AuthorityRequest, actions: NativeActions
) -> dict:
    with operation_errors():
        return actions.authority(action_id, body.selection)


@router.post("/actions/{action_id}/intent", response_model=DocumentJournalResponse)
def intent(
    action_id: ActionId, body: _IntentRequest, actions: NativeActions
) -> DocumentJournalResponse:
    with operation_errors():
        return actions.begin_write(action_id, body.selection, body.intent)


@router.post("/actions/{action_id}/settlement", response_model=DocumentJournalResponse)
def settlement(
    action_id: ActionId, body: _SettlementRequest, actions: NativeActions
) -> DocumentJournalResponse:
    with operation_errors():
        return actions.journal.settle(
            action_id=action_id,
            request_sha256=body.request_sha256,
            **body.settlement.model_dump(mode="json"),
        )


@router.post("/actions/{action_id}/recovery", response_model=DocumentJournalResponse)
def recovery(
    action_id: ActionId, body: _RecoveryRequest, actions: NativeActions
) -> DocumentJournalResponse:
    with operation_errors():
        return actions.journal.recover(
            action_id=action_id,
            request_sha256=body.request_sha256,
            previous_native_owner_instance_id=body.previous_native_owner_instance_id,
            observation=body.settlement,
        )
