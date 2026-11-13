"""Durable native write intents in the common operation ledger.

Runtime adapters authenticate the native owner before calling this journal.
An owner identifier is a consistency binding, never a credential.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..control_plane import ControlPlaneStore

Digest = Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
Revision = Annotated[str, Field(min_length=1, max_length=512)]


class DocumentWriteIntent(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    before_sha256: Digest
    after_sha256: Digest
    target_revision: Revision
    selection_sha256: Digest
    selection_count: int = Field(ge=1, le=10_000, strict=True)


class _CommittedCheckpoint(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    status: Literal["committed"]
    commit: str = Field(pattern=r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")


class _AbsentCheckpoint(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    status: Literal["not-required"]


class _FailedCheckpoint(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    status: Literal["failed"]
    reason: str = Field(min_length=1, max_length=2048)


DocumentCheckpoint = Annotated[
    _CommittedCheckpoint | _AbsentCheckpoint | _FailedCheckpoint,
    Field(discriminator="status"),
]


class DocumentWriteSettlement(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["saved", "blocked", "save-failed", "outcome-unresolved"]
    observed_sha256: Digest | None = None
    target_revision: Revision | None = None
    checkpoint: DocumentCheckpoint | None = None
    reason: str | None = Field(default=None, min_length=1, max_length=2048)
    write_disposition: Literal["not-published"] | None = None


@dataclass(frozen=True)
class DocumentJournalResponse:
    status: Literal["permitted", "recorded", "existing", "conflict", "unavailable"]
    record: dict[str, Any] | None = None


@dataclass(frozen=True)
class PendingDocumentActionsResponse:
    native_owner_instance_id: str
    actions: list[dict[str, Any]]
    next_action_id: str | None


def document_action_history_details(
    details: dict,
) -> dict[str, str | int | float | bool | None]:
    visible = {
        key: value
        for key, value in details.items()
        if value is None or isinstance(value, (str, int, float, bool))
    }
    for source, fields in (
        (
            "write_intent",
            {
                "before_sha256": "write_before_sha256",
                "after_sha256": "write_after_sha256",
                "target_revision": "write_target_revision",
                "selection_sha256": "selection_sha256",
                "selection_count": "selection_count",
            },
        ),
        (
            "settlement",
            {
                "status": "save_status",
                "observed_sha256": "observed_file_sha256",
                "target_revision": "saved_target_revision",
                "reason": "save_reason",
                "write_disposition": "write_disposition",
            },
        ),
    ):
        nested = details.get(source)
        if isinstance(nested, dict):
            for key, label in fields.items():
                value = nested.get(key)
                if isinstance(value, (str, int, float, bool)):
                    visible[label] = value
    settlement = details.get("settlement")
    checkpoint = settlement.get("checkpoint") if isinstance(settlement, dict) else None
    if isinstance(checkpoint, dict):
        for key in ("status", "commit", "reason"):
            value = checkpoint.get(key)
            if isinstance(value, str):
                visible["checkpoint_" + key] = value
    return visible


class ManagedDocumentActionJournal:
    def __init__(
        self,
        *,
        store: ControlPlaneStore,
        runtime_scope: str,
        native_owner_instance_id: str,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.store = store
        self.runtime_scope = runtime_scope
        self.native_owner_instance_id = native_owner_instance_id
        self.clock = clock

    def pending(
        self, *, limit: int = 32, after_action_id: str | None = None
    ) -> PendingDocumentActionsResponse:
        actions, cursor = self.store.page_pending_managed_document_actions(
            runtime_scope=self.runtime_scope,
            limit=limit,
            after_action_id=after_action_id,
        )
        return PendingDocumentActionsResponse(
            self.native_owner_instance_id, actions, cursor
        )

    def _bound_action(
        self,
        action_id: str,
        request_sha256: str,
        *,
        previous_native_owner_instance_id: str | None = None,
    ) -> dict | None:
        row = self.store.get_managed_operation_action(action_id)
        if row is None or row["action"] != "apply_to_document":
            return None
        details = row["details_json"]
        operation = self.store.get_managed_operation(row["operation_id"])
        if (
            not isinstance(details, dict)
            or operation is None
            or operation["runtime_scope"] != self.runtime_scope
            or details.get("native_owner_instance_id")
            != (
                self.native_owner_instance_id
                if previous_native_owner_instance_id is None
                else previous_native_owner_instance_id
            )
            or details.get("request_sha256") != request_sha256
        ):
            return None
        return row

    def begin_write(
        self,
        *,
        action_id: str,
        request_sha256: str,
        intent: DocumentWriteIntent,
        revalidate: Callable[[], None],
    ) -> DocumentJournalResponse:
        if intent.before_sha256 == intent.after_sha256:
            raise ValueError("A native write intent must describe a changed file")
        frozen_intent = intent.model_dump(mode="json")
        with self.store.durable_transaction():
            row = self._bound_action(action_id, request_sha256)
            if row is None:
                return DocumentJournalResponse("conflict")
            details = row["details_json"]
            if row["outcome"] != "document_admitted":
                previous_intent = details.get("write_intent")
                if previous_intent is not None and previous_intent != frozen_intent:
                    return DocumentJournalResponse("conflict")
                return DocumentJournalResponse("existing", row)
            operation = self.store.get_managed_operation(row["operation_id"])
            if (
                operation["state"] != "succeeded"
                or operation["result_status"] != "available"
                or self.store.get_managed_operation_result(row["operation_id"]) is None
            ):
                return DocumentJournalResponse("unavailable")
            if revalidate() is not None:
                raise TypeError("Native intent authority must be checked synchronously")
            updated = self.store.transition_managed_document_action(
                action_id=action_id,
                expected_outcome="document_admitted",
                outcome="document_writing",
                details={
                    **details,
                    "write_intent": frozen_intent,
                    "writing_at": self.clock(),
                },
            )
            if updated is None:
                raise RuntimeError("The native intent lost its admitted action")
        return DocumentJournalResponse("permitted", updated)

    def settle(
        self,
        *,
        action_id: str,
        request_sha256: str,
        status: Literal["saved", "blocked", "save-failed", "outcome-unresolved"],
        observed_sha256: str | None = None,
        target_revision: str | None = None,
        checkpoint: dict | None = None,
        reason: str | None = None,
        write_disposition: Literal["not-published"] | None = None,
    ) -> DocumentJournalResponse:
        observation = DocumentWriteSettlement(
            status=status,
            observed_sha256=observed_sha256,
            target_revision=target_revision,
            checkpoint=checkpoint,
            reason=reason,
            write_disposition=write_disposition,
        )
        return self._settle_observation(
            action_id=action_id, request_sha256=request_sha256, observation=observation
        )

    def recover(
        self,
        *,
        action_id: str,
        request_sha256: str,
        previous_native_owner_instance_id: str,
        observation: DocumentWriteSettlement,
    ) -> DocumentJournalResponse:
        if (
            previous_native_owner_instance_id == self.native_owner_instance_id
            or observation.write_disposition is not None
        ):
            return DocumentJournalResponse("conflict")
        return self._settle_observation(
            action_id=action_id,
            request_sha256=request_sha256,
            observation=observation,
            previous_native_owner_instance_id=previous_native_owner_instance_id,
        )

    def _settle_observation(
        self,
        *,
        action_id: str,
        request_sha256: str,
        observation: DocumentWriteSettlement,
        previous_native_owner_instance_id: str | None = None,
    ) -> DocumentJournalResponse:
        status = observation.status
        observed_sha256 = observation.observed_sha256
        target_revision = observation.target_revision
        checkpoint = observation.checkpoint
        write_disposition = observation.write_disposition
        settlement = observation.model_dump(mode="json", exclude_none=True)
        with self.store.durable_transaction():
            row = self._bound_action(
                action_id,
                request_sha256,
                previous_native_owner_instance_id=previous_native_owner_instance_id,
            )
            if row is None:
                return DocumentJournalResponse("conflict")
            details = row["details_json"]
            previous = details.get("settlement")
            if previous == settlement:
                return DocumentJournalResponse("existing", row)
            if row["outcome"] not in {
                "document_admitted",
                "document_writing",
                "document_outcome_unresolved",
            }:
                return DocumentJournalResponse("conflict")
            intent = details.get("write_intent")
            if intent is None:
                valid = (
                    status == "blocked"
                    and observed_sha256 is None
                    and checkpoint is None
                    and write_disposition is None
                )
            elif status == "saved":
                valid = (
                    observed_sha256 == intent["after_sha256"]
                    and target_revision == intent["target_revision"]
                    and checkpoint is not None
                    and write_disposition is None
                )
            elif status == "save-failed":
                valid = (
                    observed_sha256 is not None
                    and (
                        observed_sha256 == intent["before_sha256"]
                        or write_disposition == "not-published"
                    )
                    and target_revision is None
                    and checkpoint is None
                )
            else:
                valid = (
                    status == "outcome-unresolved"
                    and checkpoint is None
                    and write_disposition is None
                )
            if not valid:
                return DocumentJournalResponse("conflict")
            now = self.clock()
            outcome = "document_" + status.replace("-", "_")
            extra = {"settlement": settlement, "settled_at": now}
            if status == "outcome-unresolved":
                extra = {"settlement": settlement, "unresolved_at": now}
            if previous_native_owner_instance_id is not None:
                extra.update(
                    {
                        "recovered_by_native_owner_instance_id": self.native_owner_instance_id,
                        "recovered_at": now,
                    }
                )
            updated = self.store.transition_managed_document_action(
                action_id=action_id,
                expected_outcome=row["outcome"],
                outcome=outcome,
                details={**details, **extra},
            )
            if updated is None:
                raise RuntimeError("The native outcome lost its pending action")
        return DocumentJournalResponse("recorded", updated)
