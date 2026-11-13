"""Feature-owned document selection shared by native and renderer adapters."""

from __future__ import annotations

import hashlib
import json
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_validator


class AnnotationDocumentTarget(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    operation_id: str = Field(alias="operationId", min_length=1, max_length=256)
    target_document_id: str = Field(
        alias="targetDocumentId", min_length=1, max_length=1024
    )


class AnnotationDocumentSelection(AnnotationDocumentTarget):
    expected_operation_version: int = Field(alias="expectedOperationVersion", ge=1)
    expected_result_sha256: str = Field(
        alias="expectedResultSha256", pattern=r"^sha256:[a-f0-9]{64}$"
    )
    expected_target_document_revision: str = Field(
        alias="expectedTargetDocumentRevision",
        pattern=r"^annotation-document-v1:sha256:[a-f0-9]{64}$",
    )
    selected_candidate_ids: list[
        Annotated[str, Field(min_length=1, max_length=512)]
    ] = Field(alias="selectedCandidateIds", min_length=1, max_length=10_000)

    @field_validator("selected_candidate_ids")
    @classmethod
    def unique_selection(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("Annotation candidate selection must be unique")
        return value

    def request_sha256(self) -> str:
        value = self.model_dump(mode="json", by_alias=True)
        value["selectedCandidateIds"] = sorted(self.selected_candidate_ids)
        payload = json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        )
        return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def selection_sha256(self) -> str:
        payload = json.dumps(
            sorted(self.selected_candidate_ids),
            separators=(",", ":"),
            ensure_ascii=False,
        )
        return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()
