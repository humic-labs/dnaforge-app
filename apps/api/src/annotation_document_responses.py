"""Public document responses shared by human and agent adapters."""

from typing import Annotated, Literal

from dnaforge_annotation.contract import AnnotationFeature
from pydantic import BaseModel, ConfigDict, Field

from .operations.document_actions import Digest, DocumentCheckpoint, Revision


class DocumentResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)


class AnnotationDocumentCandidate(DocumentResponse):
    id: str
    index: int = Field(ge=0, strict=True)
    source_feature: AnnotationFeature = Field(alias="sourceFeature")
    feature: AnnotationFeature
    substitution_overlap: bool = Field(alias="substitutionOverlap", strict=True)


class AnnotationDocumentInspection(DocumentResponse):
    operation_id: str = Field(alias="operationId")
    target_document_id: str = Field(alias="targetDocumentId")
    operation_version: int = Field(alias="operationVersion", ge=1, strict=True)
    result_sha256: Digest = Field(alias="resultSha256")
    target_document_revision: str = Field(
        alias="targetDocumentRevision",
        pattern=r"^annotation-document-v1:sha256:[a-f0-9]{64}$",
    )
    analyzed_input_revision: Revision = Field(alias="analyzedInputRevision")
    candidates: list[AnnotationDocumentCandidate]
    applicable: bool = Field(strict=True)
    block_reason: str | None = Field(default=None, alias="blockReason")
    coordinates: Literal["exact", "mapped"]
    transition_count: int = Field(alias="transitionCount", ge=0, strict=True)


class DocumentSaved(DocumentResponse):
    status: Literal["saved"]
    target_document_revision: Revision = Field(alias="targetDocumentRevision")
    checkpoint: DocumentCheckpoint
    display: Literal["refreshed", "pending", "not-required"] = "pending"
    display_error: str | None = Field(default=None, alias="displayError")
    lineage: Literal["recorded", "unavailable"] | None = None


class DocumentNotSaved(DocumentResponse):
    status: Literal["blocked", "save-failed"]
    reason: str = Field(min_length=1, max_length=2048)
    target_document_revision: Revision | None = Field(
        default=None, alias="targetDocumentRevision"
    )


class DocumentOutcomeUnresolved(DocumentResponse):
    status: Literal["outcome-unresolved"]
    reason: str = Field(min_length=1, max_length=2048)
    action_id: str = Field(alias="actionId")


AnnotationDocumentOutcome = Annotated[
    DocumentSaved | DocumentNotSaved | DocumentOutcomeUnresolved,
    Field(discriminator="status"),
]


class AnnotationDocumentApplyResponse(DocumentResponse):
    action_id: str = Field(alias="actionId")
    outcome: AnnotationDocumentOutcome
