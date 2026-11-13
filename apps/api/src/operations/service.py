from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import threading
import time
from collections import deque
from collections.abc import Callable, Iterable
from typing import Generic, TypeVar

from pydantic import BaseModel

from ..capability_policy import has_required_capabilities
from ..control_plane import ControlPlaneStore, new_uuid7
from ..control_plane.managed_operation_rows import ManagedOperationRow
from .adapters import (
    DEFAULT_MAX_INPUT_BYTES,
    DEFAULT_MAX_RESULT_BYTES,
    ManagedOperationKindAdapter,
    ManagedOperationKindDescriptor,
    OperationExecutor,
    operation_kind_value,
)
from .contracts import (
    ACTIVE_STATES,
    TERMINAL_STATES,
    ActiveJoinMode,
    ActorKind,
    CancellationAvailability,
    CancellationMode,
    ManagedOperationSubmission,
    OperationAccessDenied,
    OperationActionPage,
    OperationActionRecord,
    OperationAdmissionRequest,
    OperationCanceled,
    OperationCancelResponse,
    OperationErrorPayload,
    OperationEvent,
    OperationExecutionError,
    OperationInitialCollection,
    OperationKind,
    OperationKindUnavailable,
    OperationNotFound,
    OperationOrigin,
    OperationPage,
    OperationPrincipal,
    OperationQueueFull,
    OperationRecordedProvenance,
    OperationReleaseResponse,
    OperationResultEnvelope,
    OperationResultStorageFull,
    OperationResultTooLarge,
    OperationSnapshot,
    OperationState,
    OperationSubject,
    PreparedRecordedOperation,
    ResultT,
    SubmissionConflict,
)
from .document_actions import document_action_history_details
from .input_retention import OperationInputRetainer, OperationInputRetention
from .lease import RuntimeScopeLease

logger = logging.getLogger(__name__)

InputT = TypeVar("InputT", bound=BaseModel)
PrincipalValidator = Callable[[OperationPrincipal], bool]


class OperationSubscription(Generic[ResultT]):
    def __init__(
        self,
        *,
        initial: tuple[OperationSnapshot[ResultT], ...],
        operation_count: int,
        active_count: int,
        terminal_count: int,
        history_complete: bool,
        queue: asyncio.Queue[OperationEvent[ResultT]],
        closed: asyncio.Event,
        on_close: Callable[[], None],
    ) -> None:
        self.initial = initial
        self.operation_count = operation_count
        self.active_count = active_count
        self.terminal_count = terminal_count
        self.history_complete = history_complete
        self._queue = queue
        self._owner_closed = closed
        self._on_close = on_close
        self._closed = False

    async def get(self) -> OperationEvent[ResultT]:
        if not self._queue.empty():
            return self._queue.get_nowait()
        if self._owner_closed.is_set():
            return OperationEvent[ResultT](kind="resync_required")
        receive = asyncio.create_task(self._queue.get())
        closed = asyncio.create_task(self._owner_closed.wait())
        try:
            await asyncio.wait({receive, closed}, return_when=asyncio.FIRST_COMPLETED)
            if receive.done():
                return receive.result()
            return OperationEvent[ResultT](kind="resync_required")
        finally:
            for task in (receive, closed):
                if not task.done():
                    task.cancel()
            await asyncio.gather(receive, closed, return_exceptions=True)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._owner_closed.set()
        self._on_close()

    def __aiter__(self) -> OperationSubscription[ResultT]:
        return self

    async def __anext__(self) -> OperationEvent[ResultT]:
        if self._closed and self._queue.empty():
            raise StopAsyncIteration
        event = await self.get()
        if event.kind != "snapshot":
            self.close()
        return event


class _Subscriber(Generic[ResultT]):
    def __init__(
        self,
        principal: OperationPrincipal,
        scope_id: str,
        queue_size: int,
        history_complete: bool,
    ) -> None:
        self.principal = principal
        self.scope_id = scope_id
        self.queue: asyncio.Queue[OperationEvent[ResultT]] = asyncio.Queue(
            maxsize=queue_size
        )
        self.history_complete = history_complete
        self.active = True
        self.closed = asyncio.Event()


class ManagedOperationService(Generic[InputT, ResultT]):
    """One durable runtime owner for its registered typed operation kinds."""

    def __init__(
        self,
        *,
        store: ControlPlaneStore,
        runtime_scope: str,
        adapters: Iterable[ManagedOperationKindAdapter] | None = None,
        kind: str | OperationKind | None = None,
        input_model: type[InputT] | None = None,
        result_model: type[ResultT] | None = None,
        executor: OperationExecutor[InputT, ResultT] | None = None,
        cancellation_mode: CancellationMode | None = None,
        max_pending: int = 8,
        max_input_bytes: int | None = None,
        max_result_bytes: int | None = None,
        max_retained_result_bytes: int = 256 * 1024 * 1024,
        max_retained_results: int = 2_000,
        max_terminal_history: int = 2_000,
        subscriber_queue_size: int = 64,
        clock: Callable[[], float] = time.time,
        principal_validator: PrincipalValidator | None = None,
        isolate_operations_by_actor: bool = False,
        input_retainer: OperationInputRetainer | None = None,
        admission: Callable[[OperationAdmissionRequest], None] | None = None,
    ) -> None:
        configured_adapters = self._configure_adapters(
            adapters=adapters,
            kind=kind,
            input_model=input_model,
            result_model=result_model,
            executor=executor,
            cancellation_mode=cancellation_mode,
            max_input_bytes=max_input_bytes,
            max_result_bytes=max_result_bytes,
        )
        if max_pending < 0:
            raise ValueError("max_pending must be non-negative")
        if (
            min(
                max_retained_result_bytes,
                max_retained_results,
                max_terminal_history,
            )
            < 1
        ):
            raise ValueError("storage bounds must be positive")
        largest_result = max(
            adapter.max_result_bytes for adapter in configured_adapters
        )
        if max_retained_result_bytes < largest_result:
            raise ValueError("retained result budget must fit one maximum-size result")
        if subscriber_queue_size < 1:
            raise ValueError("subscriber_queue_size must be positive")

        self.store = store
        self.runtime_scope = runtime_scope
        self._adapters = {adapter.kind: adapter for adapter in configured_adapters}
        self.max_pending = max_pending
        self.max_retained_result_bytes = max_retained_result_bytes
        self.max_retained_results = max_retained_results
        self.max_terminal_history = max_terminal_history
        self.subscriber_queue_size = subscriber_queue_size
        self.clock = clock
        self.principal_validator = principal_validator or (lambda _principal: True)
        self.isolate_operations_by_actor = isolate_operations_by_actor
        self.admission = admission
        self.owner_instance_id = new_uuid7()

        self._lease = RuntimeScopeLease(
            store.db_path, runtime_scope, self.owner_instance_id
        )
        self._lease.acquire()
        try:
            now = self.clock()
            with self.store.transaction():
                if input_retainer is not None:
                    self.store.require_managed_operation_inputs(runtime_scope)
                previous_owner = self.store.claim_managed_operation_owner(
                    runtime_scope, self.owner_instance_id, now=now
                )
                if previous_owner and previous_owner != self.owner_instance_id:
                    self.store.interrupt_managed_operations(
                        runtime_scope=runtime_scope,
                        previous_owner_instance_id=previous_owner,
                        new_owner_instance_id=self.owner_instance_id,
                        now=now,
                    )
                self.store.prune_managed_operations(
                    runtime_scope=runtime_scope,
                    now=now,
                    max_terminal_history=self.max_terminal_history,
                )
        except BaseException:
            self._lease.release()
            raise

        self._lock = asyncio.Lock()
        self._queue: deque[str] = deque()
        self._inputs: dict[str, tuple[ManagedOperationKindAdapter, BaseModel]] = {}
        self._cancel_events: dict[str, threading.Event] = {}
        self._runner_task: asyncio.Task[None] | None = None
        self._executor_tasks: set[asyncio.Task[BaseModel]] = set()
        self._subscribers: set[_Subscriber[ResultT]] = set()
        self._accepting = True
        self._closed = False
        self._input_retention = (
            OperationInputRetention(store, runtime_scope, input_retainer)
            if input_retainer is not None
            else None
        )

    @staticmethod
    def _configure_adapters(
        *,
        adapters: Iterable[ManagedOperationKindAdapter] | None,
        kind: str | OperationKind | None,
        input_model: type[BaseModel] | None,
        result_model: type[BaseModel] | None,
        executor: OperationExecutor | None,
        cancellation_mode: CancellationMode | None,
        max_input_bytes: int | None,
        max_result_bytes: int | None,
    ) -> tuple[ManagedOperationKindAdapter, ...]:
        if adapters is None:
            if (
                kind is None
                or input_model is None
                or result_model is None
                or executor is None
            ):
                raise ValueError(
                    "configure adapters or provide one kind, input model, result model, and executor"
                )
            kind_value = operation_kind_value(kind)
            configured = (
                ManagedOperationKindAdapter(
                    kind=kind_value,
                    title=kind_value.replace("_", " ").replace("-", " ").title(),
                    input_model=input_model,
                    result_model=result_model,
                    executor=executor,
                    cancellation_mode=cancellation_mode or CancellationMode.QUEUED_ONLY,
                    max_input_bytes=(
                        DEFAULT_MAX_INPUT_BYTES
                        if max_input_bytes is None
                        else max_input_bytes
                    ),
                    max_result_bytes=(
                        DEFAULT_MAX_RESULT_BYTES
                        if max_result_bytes is None
                        else max_result_bytes
                    ),
                ),
            )
        else:
            if any(
                value is not None
                for value in (
                    kind,
                    input_model,
                    result_model,
                    executor,
                    cancellation_mode,
                    max_input_bytes,
                    max_result_bytes,
                )
            ):
                raise ValueError(
                    "adapter registry cannot be combined with single-kind arguments"
                )
            configured = tuple(adapters)
        if not configured:
            raise ValueError(
                "managed runtime requires at least one known operation kind"
            )
        kind_ids = [adapter.kind for adapter in configured]
        if len(kind_ids) != len(set(kind_ids)):
            raise ValueError("managed runtime operation kinds must be unique")
        return configured

    def kind_descriptors(self) -> tuple[ManagedOperationKindDescriptor, ...]:
        return tuple(adapter.descriptor() for adapter in self._adapters.values())

    def _adapter(
        self, kind: str | OperationKind | None, *, require_start: bool
    ) -> ManagedOperationKindAdapter:
        if kind is None:
            startable = [
                adapter for adapter in self._adapters.values() if adapter.start_enabled
            ]
            if len(startable) != 1:
                raise OperationKindUnavailable(
                    "Select one available managed operation kind"
                )
            adapter = startable[0]
        else:
            adapter = self._adapters.get(operation_kind_value(kind))
            if adapter is None:
                raise OperationKindUnavailable(
                    "The managed runtime does not know this operation kind"
                )
        if require_start and not adapter.start_enabled:
            raise OperationKindUnavailable(
                "This operation kind is retained for history but cannot be started"
            )
        return adapter

    async def start(
        self,
        principal: OperationPrincipal,
        submission: ManagedOperationSubmission[InputT],
        *,
        kind: str | OperationKind | None = None,
    ) -> OperationSnapshot[ResultT]:
        self._authorize_scope(
            principal, submission.subject.scope_id, "operations.start"
        )
        adapter = self._adapter(kind, require_start=True)
        self._authorize_capabilities(principal, adapter.required_start_capabilities)
        input_payload = submission.input.model_dump(mode="json", round_trip=True)
        serialized_input = json.dumps(
            input_payload, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        if len(serialized_input) > adapter.max_input_bytes:
            raise OperationResultTooLarge(
                "Managed operation input exceeds its byte limit"
            )
        frozen_input = adapter.input_model.model_validate_json(serialized_input)
        payload_hash = self._submission_hash(adapter.kind, submission, serialized_input)

        async with self._lock:
            if not self._accepting:
                raise OperationQueueFull("The managed runtime is shutting down")
            self.prune()
            now = self.clock()
            with self.store.transaction():
                existing = self.store.get_managed_operation_by_submission(
                    runtime_scope=self.runtime_scope,
                    scope_id=submission.subject.scope_id,
                    actor_kind=principal.actor_kind.value,
                    actor_id=principal.actor_id,
                    submission_key=submission.submission_key,
                )
                if existing is not None:
                    if existing["matched_submission_payload_hash"] != payload_hash:
                        raise SubmissionConflict(
                            "The submission key was already used with different input"
                        )
                    return self._snapshot(existing)
                if adapter.active_join == ActiveJoinMode.SUBJECT_REVISION:
                    actor_kind, actor_id = self._actor_filter(principal)
                    active = self.store.get_active_managed_operation_by_identity(
                        runtime_scope=self.runtime_scope,
                        scope_id=submission.subject.scope_id,
                        kind=adapter.kind,
                        subject_id=submission.subject.subject_id,
                        input_revision=submission.subject.input_revision,
                        actor_kind=actor_kind,
                        actor_id=actor_id,
                    )
                    if active is not None:
                        if active["submission_payload_hash"] != payload_hash:
                            raise SubmissionConflict(
                                "An active operation has the same subject revision but different input"
                            )
                        self.store.insert_managed_operation_submission(
                            runtime_scope=self.runtime_scope,
                            scope_id=submission.subject.scope_id,
                            actor_kind=principal.actor_kind.value,
                            actor_id=principal.actor_id,
                            submission_key=submission.submission_key,
                            submission_payload_hash=payload_hash,
                            operation_id=active["id"],
                            submitted_at=now,
                        )
                        self.store.insert_managed_operation_action(
                            operation_id=active["id"],
                            action="submit",
                            actor_kind=principal.actor_kind.value,
                            actor_id=principal.actor_id,
                            channel=principal.channel.value,
                            outcome="joined_active",
                            recorded_at=now,
                        )
                        return self._snapshot(active)
                if self.admission is not None:
                    self.admission(
                        OperationAdmissionRequest(
                            principal=principal,
                            kind=adapter.kind,
                            active_count=sum(
                                1
                                for row in self.store.list_managed_operations_by_states(
                                    runtime_scope=self.runtime_scope,
                                    owner_instance_id=self.owner_instance_id,
                                    states={state.value for state in ACTIVE_STATES},
                                )
                                if row["actor_kind"] == principal.actor_kind.value
                                and row["actor_id"] == principal.actor_id
                            ),
                        )
                    )
                queued = self.store.count_managed_operations_in_state(
                    runtime_scope=self.runtime_scope, state=OperationState.QUEUED.value
                )
                if queued >= self.max_pending:
                    raise OperationQueueFull("The managed operation queue is full")
                usage = self.store.managed_operation_storage_usage()
                pending_input_releases = (
                    self.store.pending_managed_input_release_count()
                )
                if (
                    usage["retained_bytes"]
                    + usage["reserved_bytes"]
                    + adapter.max_result_bytes
                    > self.max_retained_result_bytes
                    or usage["retained_count"]
                    + usage["reserved_count"]
                    + pending_input_releases
                    + 1
                    > self.max_retained_results
                ):
                    raise OperationResultStorageFull(
                        retained_bytes=usage["retained_bytes"],
                        reserved_bytes=usage["reserved_bytes"],
                        requested_bytes=adapter.max_result_bytes,
                        limit_bytes=self.max_retained_result_bytes,
                        retained_count=usage["retained_count"],
                        reserved_count=usage["reserved_count"] + pending_input_releases,
                        limit_count=self.max_retained_results,
                    )
                operation_id = self.store.insert_managed_operation(
                    runtime_scope=self.runtime_scope,
                    scope_id=submission.subject.scope_id,
                    kind=adapter.kind,
                    subject_id=submission.subject.subject_id,
                    input_revision=submission.subject.input_revision,
                    submission_key=submission.submission_key,
                    submission_payload_hash=payload_hash,
                    actor_kind=principal.actor_kind.value,
                    actor_id=principal.actor_id,
                    channel=principal.channel.value,
                    cancellation_mode=adapter.cancellation_mode.value,
                    owner_instance_id=self.owner_instance_id,
                    now=now,
                    result_reservation_bytes=adapter.max_result_bytes,
                    kind_contract_version=adapter.contract_version,
                    accepted_workspace_input=(
                        submission.subject.accepted_workspace_input.model_dump(
                            mode="json"
                        )
                        if submission.subject.accepted_workspace_input is not None
                        else None
                    ),
                    retain_input=(
                        self._input_retention is not None
                        and submission.subject.accepted_workspace_input is not None
                    ),
                )
                self.store.insert_managed_operation_action(
                    operation_id=operation_id,
                    action="submit",
                    actor_kind=principal.actor_kind.value,
                    actor_id=principal.actor_id,
                    channel=principal.channel.value,
                    outcome="accepted",
                    recorded_at=now,
                )
            if (
                self._input_retention is not None
                and submission.subject.accepted_workspace_input is not None
            ):
                try:
                    await self._input_retention.retain(self._required_row(operation_id))
                except (Exception, asyncio.CancelledError) as error:
                    failed = self.store.transition_managed_operation(
                        operation_id,
                        expected_states={OperationState.QUEUED.value},
                        state=OperationState.FAILED.value,
                        owner_instance_id=self.owner_instance_id,
                        now=self.clock(),
                        clear_result_reservation=True,
                        mark_settled=True,
                        error={
                            "code": "INPUT_RETENTION_UNAVAILABLE",
                            "message": "The accepted input could not be retained. Start a new job when the service is available.",
                        },
                    )
                    if failed is None:
                        raise RuntimeError(
                            "Input retention admission changed unexpectedly"
                        ) from error
                    self._publish(failed)
                    self.prune()
                    if isinstance(error, asyncio.CancelledError):
                        raise
                    return self._snapshot(failed)
            self._inputs[operation_id] = (adapter, frozen_input)
            self._cancel_events[operation_id] = threading.Event()
            self._queue.append(operation_id)
            row = self._required_row(operation_id)
            self._publish(row)
            self._ensure_runner()
            return self._snapshot(row)

    async def import_recorded(
        self,
        principal: OperationPrincipal,
        value: BaseModel,
        *,
        kind: str | OperationKind,
    ) -> OperationSnapshot[ResultT]:
        adapter = self._adapter(kind, require_start=False)
        if (
            adapter.recorded_import_model is None
            or adapter.recorded_import_preparer is None
        ):
            raise OperationKindUnavailable(
                "This operation kind does not accept recorded results"
            )
        serialized_import = json.dumps(
            value.model_dump(mode="json", round_trip=True),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(serialized_import) > adapter.max_recorded_import_bytes:
            raise OperationResultTooLarge(
                "Recorded operation receipt exceeds its byte limit"
            )
        frozen_import = adapter.recorded_import_model.model_validate_json(
            serialized_import
        )
        prepared = PreparedRecordedOperation[adapter.result_model].model_validate(
            adapter.recorded_import_preparer(frozen_import)
        )
        self._authorize_scope(principal, prepared.subject.scope_id, "operations.import")
        self._authorize_capabilities(principal, adapter.required_import_capabilities)

        result = adapter.result_model.model_validate(prepared.result)
        result_payload = result.model_dump(mode="json", round_trip=True)
        encoded_result = json.dumps(
            result_payload, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        if len(encoded_result) > adapter.max_result_bytes:
            raise OperationResultTooLarge(
                "Recorded operation result exceeds its byte limit"
            )
        provenance_payload = prepared.provenance.model_dump(
            mode="json", round_trip=True
        )
        encoded_provenance = json.dumps(
            provenance_payload, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        if len(encoded_provenance) > adapter.max_provenance_bytes:
            raise OperationResultTooLarge(
                "Recorded operation provenance exceeds its byte limit"
            )
        payload_hash = self._recorded_import_hash(adapter.kind, serialized_import)

        async with self._lock:
            if not self._accepting:
                raise OperationQueueFull("The managed runtime is shutting down")
            self.prune()
            now = self.clock()
            with self.store.transaction():
                existing = self.store.get_recorded_managed_operation(
                    prepared.reported_run_id
                )
                if existing is not None:
                    if (
                        existing["kind"] != adapter.kind
                        or existing["submission_payload_hash"] != payload_hash
                    ):
                        raise SubmissionConflict(
                            "The reported run identity was already imported with different data"
                        )
                    if (
                        existing["runtime_scope"] != self.runtime_scope
                        or existing["scope_id"] not in principal.scope_ids
                        or not self._operation_visible_to_principal(principal, existing)
                    ):
                        raise OperationAccessDenied(
                            "The reported run was already retained by another runtime"
                        )
                    self.store.insert_managed_operation_action(
                        operation_id=existing["id"],
                        action="import_recorded",
                        actor_kind=principal.actor_kind.value,
                        actor_id=principal.actor_id,
                        channel=principal.channel.value,
                        outcome="already_imported",
                        recorded_at=now,
                    )
                    return self._snapshot(existing)

                usage = self.store.managed_operation_storage_usage()
                if (
                    usage["retained_bytes"]
                    + usage["reserved_bytes"]
                    + len(encoded_result)
                    > self.max_retained_result_bytes
                    or usage["retained_count"] + usage["reserved_count"] + 1
                    > self.max_retained_results
                ):
                    raise OperationResultStorageFull(
                        retained_bytes=usage["retained_bytes"],
                        reserved_bytes=usage["reserved_bytes"],
                        requested_bytes=len(encoded_result),
                        limit_bytes=self.max_retained_result_bytes,
                        retained_count=usage["retained_count"],
                        reserved_count=usage["reserved_count"],
                        limit_count=self.max_retained_results,
                    )
                operation_id = self.store.insert_recorded_managed_operation(
                    runtime_scope=self.runtime_scope,
                    scope_id=prepared.subject.scope_id,
                    kind=adapter.kind,
                    reported_run_id=prepared.reported_run_id,
                    subject_id=prepared.subject.subject_id,
                    input_revision=prepared.subject.input_revision,
                    submission_payload_hash=payload_hash,
                    actor_kind=principal.actor_kind.value,
                    actor_id=principal.actor_id,
                    channel=principal.channel.value,
                    owner_instance_id=self.owner_instance_id,
                    provenance=provenance_payload,
                    now=now,
                    kind_contract_version=adapter.contract_version,
                )
                self.store.put_managed_operation_result(
                    operation_id,
                    payload=result_payload,
                    size_bytes=len(encoded_result),
                    result_schema_version=adapter.result_schema_version,
                )
                self.store.insert_managed_operation_action(
                    operation_id=operation_id,
                    action="import_recorded",
                    actor_kind=principal.actor_kind.value,
                    actor_id=principal.actor_id,
                    channel=principal.channel.value,
                    outcome="imported",
                    recorded_at=now,
                )
            row = self._required_row(operation_id)
            self._publish(row)
            return self._snapshot(row)

    def get(
        self, principal: OperationPrincipal, operation_id: str
    ) -> OperationSnapshot[ResultT]:
        self._authorize(principal, "operations.read")
        row = self.store.get_managed_operation(operation_id)
        if row is None or row["runtime_scope"] != self.runtime_scope:
            raise OperationNotFound("Managed operation was not found")
        if row[
            "scope_id"
        ] not in principal.scope_ids or not self._operation_visible_to_principal(
            principal, row
        ):
            raise OperationNotFound("Managed operation was not found")
        return self._snapshot(row)

    def list(
        self,
        principal: OperationPrincipal,
        *,
        scope_id: str,
        subject_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[OperationSnapshot[ResultT]]:
        self._authorize_scope(principal, scope_id, "operations.read")
        return self.list_page(
            principal,
            scope_id=scope_id,
            subject_id=subject_id,
            limit=limit,
            offset=offset,
        ).operations

    def list_page(
        self,
        principal: OperationPrincipal,
        *,
        scope_id: str,
        subject_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> OperationPage[ResultT]:
        self._authorize_scope(principal, scope_id, "operations.read")
        actor_kind, actor_id = self._actor_filter(principal)
        rows, total, next_offset = self.store.page_managed_operations(
            runtime_scope=self.runtime_scope,
            scope_id=scope_id,
            subject_id=subject_id,
            actor_kind=actor_kind,
            actor_id=actor_id,
            limit=limit,
            offset=offset,
        )
        return OperationPage[ResultT](
            operations=[self._snapshot(row) for row in rows],
            total=total,
            next_offset=next_offset,
        )

    def get_result(
        self, principal: OperationPrincipal, operation_id: str
    ) -> OperationResultEnvelope[ResultT]:
        with self.store.transaction():
            snapshot = self.get(principal, operation_id)
            row = self.store.get_managed_operation_result(operation_id)
        adapter = self._adapter(snapshot.kind, require_start=False)
        envelope_fields = {
            "operation_id": operation_id,
            "kind": snapshot.kind,
            "result_schema_version": adapter.result_schema_version,
        }
        if snapshot.state in ACTIVE_STATES:
            return OperationResultEnvelope(**envelope_fields, status="pending")
        if snapshot.state == OperationState.FAILED:
            return OperationResultEnvelope(
                **envelope_fields,
                status="unavailable",
                error=snapshot.error,
            )
        if snapshot.result_status == "released":
            return OperationResultEnvelope(**envelope_fields, status="released")
        if snapshot.result_status == "expired":
            return OperationResultEnvelope(**envelope_fields, status="expired")
        if row is None:
            return OperationResultEnvelope(**envelope_fields, status="unavailable")
        stored_version = int(row["result_schema_version"])
        decoder = adapter.result_decoders.get(stored_version)
        if decoder is None:
            return OperationResultEnvelope(
                **envelope_fields,
                status="unavailable",
                error=OperationErrorPayload(
                    code="UNSUPPORTED_OPERATION_RESULT_VERSION",
                    message="This retained result uses an unsupported schema version.",
                ),
            )
        result = adapter.result_model.model_validate(decoder(row["payload_json"]))
        if stored_version != adapter.result_schema_version:
            wire_result = result.model_dump(mode="json", by_alias=True)
            try:
                current = adapter.result_model.model_validate(
                    adapter.result_decoders[adapter.result_schema_version](wire_result)
                )
                if current != result:
                    raise ValueError("Current codec changes the served value")
            except (ValueError, TypeError, KeyError) as current_codec_error:
                historical = adapter.result_model.model_validate(decoder(wire_result))
                if historical != result:
                    raise ValueError(
                        "Historical codec changes the served value"
                    ) from current_codec_error
                envelope_fields["result_schema_version"] = stored_version
        return OperationResultEnvelope(
            **envelope_fields, status="available", result=result
        )

    def list_actions_page(
        self,
        principal: OperationPrincipal,
        operation_id: str,
        *,
        limit: int = 100,
        offset: int = 0,
    ) -> OperationActionPage:
        self.get(principal, operation_id)
        rows, total, next_offset, omitted_count = (
            self.store.page_managed_operation_actions(
                operation_id,
                limit=limit,
                offset=offset,
            )
        )
        return OperationActionPage(
            actions=[
                OperationActionRecord(
                    id=row["id"],
                    action=row["action"],
                    actor_kind=row["actor_kind"],
                    actor_id=row["actor_id"],
                    channel=row["channel"],
                    outcome=row["outcome"],
                    details=(
                        document_action_history_details(row["details_json"])
                        if row["action"] == "apply_to_document"
                        else row["details_json"]
                    ),
                    recorded_at=row["recorded_at"],
                )
                for row in rows
            ],
            total=total,
            next_offset=next_offset,
            omitted_count=omitted_count,
            history_complete=omitted_count == 0,
        )

    async def release_result(
        self, principal: OperationPrincipal, operation_id: str
    ) -> OperationReleaseResponse[ResultT]:
        self._authorize(principal, "operations.release")
        async with self._lock:
            row = self.store.get_managed_operation(operation_id)
            if (
                row is None
                or row["runtime_scope"] != self.runtime_scope
                or row["scope_id"] not in principal.scope_ids
                or not self._operation_visible_to_principal(principal, row)
            ):
                raise OperationNotFound("Managed operation was not found")
            if row["result_status"] == "released":
                self._record_control_action(
                    row,
                    principal=principal,
                    action="release_result",
                    outcome="already_released",
                )
                return OperationReleaseResponse(
                    snapshot=self._snapshot(row),
                    disposition="already_released",
                    reason="The retained result was already released.",
                )
            if row["result_status"] != "available":
                self._record_control_action(
                    row,
                    principal=principal,
                    action="release_result",
                    outcome="unavailable",
                )
                return OperationReleaseResponse(
                    snapshot=self._snapshot(row),
                    disposition="unavailable",
                    reason="This operation has no retained result to release.",
                )

            now = self.clock()
            with self.store.transaction():
                if self.store.has_pending_managed_document_action(operation_id):
                    self._record_control_action(
                        row,
                        principal=principal,
                        action="release_result",
                        outcome="unavailable",
                    )
                    return OperationReleaseResponse(
                        snapshot=self._snapshot(row),
                        disposition="unavailable",
                        reason="The retained result is needed to finish or recover a document write.",
                    )
                if not self.store.delete_managed_operation_result(operation_id):
                    raise RuntimeError(
                        "Available operation result disappeared before release"
                    )
                updated = self.store.mark_managed_operation_result_released(
                    operation_id,
                    runtime_scope=self.runtime_scope,
                    now=now,
                )
                if updated is None:
                    raise RuntimeError("Operation result state changed before release")
                self.store.insert_managed_operation_action(
                    operation_id=operation_id,
                    action="release_result",
                    actor_kind=principal.actor_kind.value,
                    actor_id=principal.actor_id,
                    channel=principal.channel.value,
                    outcome="released",
                    recorded_at=now,
                )
            self._publish(updated)
            if self._input_retention is not None:
                self._input_retention.kick()
            return OperationReleaseResponse(
                snapshot=self._snapshot(updated),
                disposition="released",
                reason="The retained result was released and its storage is available.",
            )

    async def request_cancel(
        self, principal: OperationPrincipal, operation_id: str
    ) -> OperationCancelResponse[ResultT]:
        self._authorize(principal, "operations.cancel")
        async with self._lock:
            row = self.store.get_managed_operation(operation_id)
            if (
                row is None
                or row["runtime_scope"] != self.runtime_scope
                or row["scope_id"] not in principal.scope_ids
                or not self._operation_visible_to_principal(principal, row)
            ):
                raise OperationNotFound("Managed operation was not found")
            state = OperationState(row["state"])
            if state == OperationState.QUEUED:
                updated = self._cancel_queued(
                    row,
                    actor_kind=principal.actor_kind.value,
                    actor_id=principal.actor_id,
                    channel=principal.channel.value,
                )
                return OperationCancelResponse(
                    snapshot=self._snapshot(updated),
                    disposition="accepted",
                    reason="Canceled before engine entry.",
                )
            if state == OperationState.RUNNING:
                if (
                    CancellationMode(row["cancellation_mode"])
                    == CancellationMode.QUEUED_ONLY
                ):
                    self._record_unavailable_active_cancel(
                        row,
                        actor_kind=principal.actor_kind.value,
                        actor_id=principal.actor_id,
                        channel=principal.channel.value,
                    )
                    return OperationCancelResponse(
                        snapshot=self._snapshot(row),
                        disposition="unavailable",
                        reason=(
                            "Active execution does not support interruption; "
                            "its actual outcome will be retained."
                        ),
                    )
                updated = self._request_active_cancel(
                    row,
                    actor_kind=principal.actor_kind.value,
                    actor_id=principal.actor_id,
                    channel=principal.channel.value,
                )
                return OperationCancelResponse(
                    snapshot=self._snapshot(updated),
                    disposition="accepted",
                    reason="Cancellation was requested; waiting for physical settlement.",
                )
            if state == OperationState.STOPPING:
                self._record_control_action(
                    row,
                    principal=principal,
                    action="request_cancel",
                    outcome="already_requested",
                )
                return OperationCancelResponse(
                    snapshot=self._snapshot(row),
                    disposition="already_requested",
                    reason="Cancellation was already requested; waiting for physical settlement.",
                )
            self._record_control_action(
                row,
                principal=principal,
                action="request_cancel",
                outcome="already_settled",
            )
            return OperationCancelResponse(
                snapshot=self._snapshot(row),
                disposition="already_settled",
                reason="The operation has already settled.",
            )

    async def subscribe(
        self, principal: OperationPrincipal, *, scope_id: str
    ) -> OperationSubscription[ResultT]:
        self._authorize_scope(principal, scope_id, "operations.read")
        async with self._lock:
            if not self._accepting:
                raise OperationQueueFull("The managed runtime is shutting down")
            actor_kind, actor_id = self._actor_filter(principal)
            rows, active_count, terminal_count = (
                self.store.managed_operation_initial_collection(
                    runtime_scope=self.runtime_scope,
                    scope_id=scope_id,
                    terminal_limit=self.max_terminal_history
                    + self.max_retained_results,
                    actor_kind=actor_kind,
                    actor_id=actor_id,
                )
            )
            initial = OperationInitialCollection[ResultT](
                operations=[self._snapshot(row) for row in rows],
                operation_count=active_count + terminal_count,
                active_count=active_count,
                terminal_count=terminal_count,
                history_complete=len(rows) == active_count + terminal_count,
            )
            subscriber = _Subscriber[ResultT](
                principal,
                scope_id,
                self.subscriber_queue_size,
                initial.history_complete,
            )
            self._subscribers.add(subscriber)

        def close() -> None:
            subscriber.active = False
            self._subscribers.discard(subscriber)

        return OperationSubscription(
            initial=tuple(initial.operations),
            operation_count=initial.operation_count,
            active_count=initial.active_count,
            terminal_count=initial.terminal_count,
            history_complete=initial.history_complete,
            queue=subscriber.queue,
            closed=subscriber.closed,
            on_close=close,
        )

    async def wait_for_terminal(
        self,
        principal: OperationPrincipal,
        operation_id: str,
    ) -> OperationSnapshot[ResultT]:
        """Wait for one retained operation while leaving its owner independent.

        Canceling this await only detaches the observer. The service-owned worker
        keeps running and remains visible to every other transport.
        """

        while True:
            current = self.get(principal, operation_id)
            if current.state in TERMINAL_STATES:
                return current

            subscription = await self.subscribe(
                principal, scope_id=current.subject.scope_id
            )
            try:
                initial = next(
                    (
                        snapshot
                        for snapshot in subscription.initial
                        if snapshot.id == operation_id
                    ),
                    current,
                )
                if initial.state in TERMINAL_STATES:
                    return initial

                while True:
                    event = await subscription.get()
                    if event.kind != "snapshot":
                        break
                    if (
                        event.snapshot is not None
                        and event.snapshot.id == operation_id
                        and event.snapshot.state in TERMINAL_STATES
                    ):
                        return event.snapshot
            finally:
                subscription.close()

    def prune(self) -> tuple[str, ...]:
        if self._input_retention is not None:
            self._input_retention.kick()
        deleted = self.store.prune_managed_operations(
            runtime_scope=self.runtime_scope,
            now=self.clock(),
            max_terminal_history=self.max_terminal_history,
        )
        if deleted:
            for subscriber in tuple(self._subscribers):
                if subscriber.active:
                    self._terminate_subscriber(subscriber, "resync_required")
        return tuple(deleted)

    async def reconcile_input_retention(self) -> None:
        if self._input_retention is not None:
            async with self._lock:
                self.store.prepare_managed_input_releases(self.runtime_scope)
                await self._input_retention.reconcile()

    async def aclose(self) -> None:
        if self._closed:
            return
        async with self._lock:
            self._accepting = False
            for operation_id in tuple(self._queue):
                row = self.store.get_managed_operation(operation_id)
                if row is not None and row["state"] == OperationState.QUEUED.value:
                    self._cancel_queued(
                        row,
                        actor_kind="system",
                        actor_id=self.owner_instance_id,
                        channel="runtime",
                    )
            active_rows = self.store.list_managed_operations_by_states(
                runtime_scope=self.runtime_scope,
                owner_instance_id=self.owner_instance_id,
                states={OperationState.RUNNING.value},
            )
            for row in active_rows:
                if (
                    CancellationMode(row["cancellation_mode"])
                    == CancellationMode.COOPERATIVE
                ):
                    self._request_active_cancel(
                        row,
                        actor_kind="system",
                        actor_id=self.owner_instance_id,
                        channel="runtime",
                    )
                else:
                    self._record_shutdown_wait(row)
            runner = self._runner_task
        if runner is not None:
            await self._await_uninterruptibly(runner)
        if self._input_retention is not None:
            await self._input_retention.aclose()
        self.store.release_managed_operation_owner(
            self.runtime_scope, self.owner_instance_id
        )
        self._lease.release()
        self._closed = True
        for subscriber in tuple(self._subscribers):
            subscriber.active = False
            subscriber.closed.set()
        self._subscribers.clear()

    def _ensure_runner(self) -> None:
        if self._runner_task is not None and not self._runner_task.done():
            return
        self._runner_task = asyncio.create_task(self._run_loop())

    async def _run_loop(self) -> None:
        while True:
            async with self._lock:
                operation_id = self._next_queued()
                if operation_id is None:
                    return
                row = self.store.transition_managed_operation(
                    operation_id,
                    expected_states={OperationState.QUEUED.value},
                    state=OperationState.RUNNING.value,
                    owner_instance_id=self.owner_instance_id,
                    now=self.clock(),
                    mark_started=True,
                )
                if row is None:
                    continue
                adapter, value = self._inputs[operation_id]
                cancel_event = self._cancel_events[operation_id]
                self._publish(row)

            executor = adapter.executor
            if executor is None:
                raise RuntimeError("A queued operation has no registered executor")
            executor_task = asyncio.create_task(executor(value, cancel_event))
            self._executor_tasks.add(executor_task)
            try:
                result = await self._await_uninterruptibly(executor_task)
            except OperationCanceled:
                await self._finish_executor_canceled(operation_id)
            except OperationExecutionError as exc:
                await self._finish_failed(operation_id, exc.payload)
            except BaseException as exc:
                if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                    raise
                logger.exception("Managed operation executor failed")
                await self._finish_failed(
                    operation_id,
                    OperationErrorPayload(
                        code="OPERATION_FAILED",
                        message="The managed operation failed.",
                    ),
                )
            else:
                await self._finish_result(operation_id, adapter, result)
            finally:
                self._executor_tasks.discard(executor_task)
                self._inputs.pop(operation_id, None)
                self._cancel_events.pop(operation_id, None)

    async def _finish_result(
        self,
        operation_id: str,
        adapter: ManagedOperationKindAdapter,
        value: BaseModel,
    ) -> None:
        try:
            result = adapter.result_model.model_validate(value)
            payload = result.model_dump(mode="json", round_trip=True)
            encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode(
                "utf-8"
            )
            if len(encoded) > adapter.max_result_bytes:
                raise OperationExecutionError(
                    "RESULT_TOO_LARGE",
                    "The managed operation result exceeded its byte limit.",
                )
        except OperationExecutionError as exc:
            await self._finish_failed(operation_id, exc.payload)
            return
        except Exception:
            logger.exception("Managed operation returned an invalid typed result")
            await self._finish_failed(
                operation_id,
                OperationErrorPayload(
                    code="INVALID_OPERATION_RESULT",
                    message="The managed operation returned an invalid result.",
                ),
            )
            return

        async with self._lock:
            now = self.clock()
            with self.store.transaction():
                self.store.put_managed_operation_result(
                    operation_id,
                    payload=payload,
                    size_bytes=len(encoded),
                    result_schema_version=adapter.result_schema_version,
                )
                updated = self.store.transition_managed_operation(
                    operation_id,
                    expected_states={
                        OperationState.RUNNING.value,
                        OperationState.STOPPING.value,
                    },
                    state=OperationState.SUCCEEDED.value,
                    owner_instance_id=self.owner_instance_id,
                    now=now,
                    result_status="available",
                    clear_result_reservation=True,
                    mark_settled=True,
                )
                if updated is None:
                    raise RuntimeError(
                        "Operation state changed before success settlement"
                    )
                self.store.insert_managed_operation_action(
                    operation_id=operation_id,
                    action="settle",
                    actor_kind="system",
                    actor_id=self.owner_instance_id,
                    channel="runtime",
                    outcome="succeeded",
                    recorded_at=now,
                )
            self._publish(updated)
            self.prune()

    async def _finish_failed(
        self, operation_id: str, error: OperationErrorPayload
    ) -> None:
        async with self._lock:
            now = self.clock()
            with self.store.transaction():
                updated = self.store.transition_managed_operation(
                    operation_id,
                    expected_states={
                        OperationState.RUNNING.value,
                        OperationState.STOPPING.value,
                    },
                    state=OperationState.FAILED.value,
                    owner_instance_id=self.owner_instance_id,
                    now=now,
                    clear_result_reservation=True,
                    error=error.model_dump(mode="json"),
                    mark_settled=True,
                )
                if updated is None:
                    raise RuntimeError(
                        "Operation state changed before failure settlement"
                    )
                self.store.insert_managed_operation_action(
                    operation_id=operation_id,
                    action="settle",
                    actor_kind="system",
                    actor_id=self.owner_instance_id,
                    channel="runtime",
                    outcome="failed",
                    recorded_at=now,
                    details={"error_code": error.code},
                )
            self._publish(updated)
            self.prune()

    async def _finish_executor_canceled(self, operation_id: str) -> None:
        async with self._lock:
            row = self._required_row(operation_id)
            if row["state"] == OperationState.STOPPING.value:
                self._finish_canceled(row)
                return

            error = OperationErrorPayload(
                code="UNEXPECTED_CANCELLATION_OUTCOME",
                message="The executor reported cancellation without an accepted request.",
            )
            now = self.clock()
            with self.store.transaction():
                updated = self.store.transition_managed_operation(
                    operation_id,
                    expected_states={OperationState.RUNNING.value},
                    state=OperationState.FAILED.value,
                    owner_instance_id=self.owner_instance_id,
                    now=now,
                    clear_result_reservation=True,
                    error=error.model_dump(mode="json"),
                    mark_settled=True,
                )
                if updated is None:
                    raise RuntimeError(
                        "Operation state changed before cancellation settlement"
                    )
                self.store.insert_managed_operation_action(
                    operation_id=operation_id,
                    action="settle",
                    actor_kind="system",
                    actor_id=self.owner_instance_id,
                    channel="runtime",
                    outcome="failed",
                    recorded_at=now,
                    details={"error_code": error.code},
                )
            self._publish(updated)
            self.prune()

    def _cancel_queued(
        self,
        row: ManagedOperationRow,
        *,
        actor_kind: str,
        actor_id: str,
        channel: str,
    ) -> ManagedOperationRow:
        now = self.clock()
        with self.store.transaction():
            updated = self.store.transition_managed_operation(
                row["id"],
                expected_states={OperationState.QUEUED.value},
                state=OperationState.CANCELED.value,
                owner_instance_id=self.owner_instance_id,
                now=now,
                clear_result_reservation=True,
                mark_cancel_requested=True,
                mark_settled=True,
            )
            if updated is None:
                return self._required_row(row["id"])
            self.store.insert_managed_operation_action(
                operation_id=row["id"],
                action="request_cancel",
                actor_kind=actor_kind,
                actor_id=actor_id,
                channel=channel,
                outcome="canceled_before_execution",
                recorded_at=now,
            )
        try:
            self._queue.remove(row["id"])
        except ValueError:
            pass
        self._inputs.pop(row["id"], None)
        self._cancel_events.pop(row["id"], None)
        self._publish(updated)
        return updated

    def _request_active_cancel(
        self,
        row: ManagedOperationRow,
        *,
        actor_kind: str,
        actor_id: str,
        channel: str,
    ) -> ManagedOperationRow:
        event = self._cancel_events.get(row["id"])
        if event is not None:
            event.set()
        now = self.clock()
        with self.store.transaction():
            updated = self.store.transition_managed_operation(
                row["id"],
                expected_states={OperationState.RUNNING.value},
                state=OperationState.STOPPING.value,
                owner_instance_id=self.owner_instance_id,
                now=now,
                mark_cancel_requested=True,
            )
            if updated is None:
                return self._required_row(row["id"])
            self.store.insert_managed_operation_action(
                operation_id=row["id"],
                action="request_cancel",
                actor_kind=actor_kind,
                actor_id=actor_id,
                channel=channel,
                outcome="accepted_waiting_for_settlement",
                recorded_at=now,
            )
        self._publish(updated)
        return updated

    def _record_unavailable_active_cancel(
        self,
        row: ManagedOperationRow,
        *,
        actor_kind: str,
        actor_id: str,
        channel: str,
    ) -> None:
        self.store.insert_managed_operation_action(
            operation_id=row["id"],
            action="request_cancel",
            actor_kind=actor_kind,
            actor_id=actor_id,
            channel=channel,
            outcome="unavailable_while_running",
            recorded_at=self.clock(),
        )

    def _record_shutdown_wait(self, row: ManagedOperationRow) -> None:
        self.store.insert_managed_operation_action(
            operation_id=row["id"],
            action="runtime_shutdown",
            actor_kind="system",
            actor_id=self.owner_instance_id,
            channel="runtime",
            outcome="waiting_for_non_cancelable_settlement",
            recorded_at=self.clock(),
        )

    def _record_control_action(
        self,
        row: ManagedOperationRow,
        *,
        principal: OperationPrincipal,
        action: str,
        outcome: str,
    ) -> None:
        self.store.insert_managed_operation_action(
            operation_id=row["id"],
            action=action,
            actor_kind=principal.actor_kind.value,
            actor_id=principal.actor_id,
            channel=principal.channel.value,
            outcome=outcome,
            recorded_at=self.clock(),
        )

    def _finish_canceled(self, row: ManagedOperationRow) -> ManagedOperationRow:
        now = self.clock()
        with self.store.transaction():
            updated = self.store.transition_managed_operation(
                row["id"],
                expected_states={OperationState.STOPPING.value},
                state=OperationState.CANCELED.value,
                owner_instance_id=self.owner_instance_id,
                now=now,
                clear_result_reservation=True,
                mark_settled=True,
            )
            if updated is None:
                return self._required_row(row["id"])
            self.store.insert_managed_operation_action(
                operation_id=row["id"],
                action="settle",
                actor_kind="system",
                actor_id=self.owner_instance_id,
                channel="runtime",
                outcome="canceled",
                recorded_at=now,
            )
        self._publish(updated)
        self.prune()
        return updated

    def _next_queued(self) -> str | None:
        if not self._accepting:
            return None
        while self._queue:
            operation_id = self._queue.popleft()
            row = self.store.get_managed_operation(operation_id)
            if row is not None and row["state"] == OperationState.QUEUED.value:
                return operation_id
        return None

    def _snapshot(self, row: ManagedOperationRow) -> OperationSnapshot[ResultT]:
        state = OperationState(row["state"])
        cancellation_mode = CancellationMode(row["cancellation_mode"])
        if state == OperationState.QUEUED:
            cancellation_availability = CancellationAvailability.AVAILABLE
        elif state == OperationState.RUNNING:
            cancellation_availability = (
                CancellationAvailability.AVAILABLE
                if cancellation_mode == CancellationMode.COOPERATIVE
                else CancellationAvailability.UNAVAILABLE
            )
        elif state == OperationState.STOPPING:
            cancellation_availability = CancellationAvailability.ALREADY_REQUESTED
        else:
            cancellation_availability = CancellationAvailability.ALREADY_SETTLED
        result_status = row["result_status"]
        error = (
            OperationErrorPayload.model_validate(row["error_json"])
            if row["error_json"] is not None
            else None
        )
        origin = OperationOrigin(row.get("origin") or OperationOrigin.MANAGED.value)
        provenance = (
            OperationRecordedProvenance.model_validate(row["provenance_json"])
            if row.get("provenance_json") is not None
            else None
        )
        return OperationSnapshot[ResultT](
            id=row["id"],
            kind=row["kind"],
            kind_contract_version=row["kind_contract_version"],
            origin=origin,
            subject=OperationSubject(
                scope_id=row["scope_id"],
                subject_id=row["subject_id"],
                input_revision=row["input_revision"],
                accepted_workspace_input=row.get("accepted_workspace_input_json"),
            ),
            state=state,
            actor_kind=ActorKind(row["actor_kind"]),
            actor_id=row["actor_id"],
            channel=row["channel"],
            owner_instance_id=row["owner_instance_id"],
            version=row["version"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            started_at=row["started_at"],
            settled_at=row["settled_at"],
            cancel_requested_at=row["cancel_requested_at"],
            cancellation_mode=cancellation_mode,
            cancellation_availability=cancellation_availability,
            result_status=result_status,
            provenance=provenance,
            error=error,
        )

    def _publish(self, row: ManagedOperationRow) -> None:
        snapshot = self._snapshot(row)
        counts_by_actor: dict[tuple[str, str] | None, tuple[int, int]] = {}
        for subscriber in tuple(self._subscribers):
            if not subscriber.active or subscriber.scope_id != row["scope_id"]:
                continue
            if not self.principal_validator(subscriber.principal):
                self._terminate_subscriber(subscriber, "authorization_revoked")
                continue
            if not self._operation_visible_to_principal(subscriber.principal, row):
                continue
            actor_kind, actor_id = self._actor_filter(subscriber.principal)
            actor_key = (
                (actor_kind, actor_id)
                if actor_kind is not None and actor_id is not None
                else None
            )
            if actor_key not in counts_by_actor:
                counts_by_actor[actor_key] = self.store.managed_operation_counts(
                    runtime_scope=self.runtime_scope,
                    scope_id=row["scope_id"],
                    actor_kind=actor_kind,
                    actor_id=actor_id,
                )
            active_count, terminal_count = counts_by_actor[actor_key]
            event = OperationEvent[ResultT](
                kind="snapshot",
                snapshot=snapshot,
                operation_count=active_count + terminal_count,
                active_count=active_count,
                terminal_count=terminal_count,
                history_complete=subscriber.history_complete,
            )
            if subscriber.queue.full():
                self._terminate_subscriber(subscriber, "resync_required")
                continue
            subscriber.queue.put_nowait(event)

    def _terminate_subscriber(
        self,
        subscriber: _Subscriber[ResultT],
        kind: str,
    ) -> None:
        while not subscriber.queue.empty():
            subscriber.queue.get_nowait()
        subscriber.queue.put_nowait(OperationEvent[ResultT](kind=kind))
        subscriber.active = False
        self._subscribers.discard(subscriber)

    def _authorize(self, principal: OperationPrincipal, capability: str) -> None:
        if not self.principal_validator(principal):
            raise OperationAccessDenied(
                "The operation principal is no longer authorized"
            )
        if principal.actor_kind == ActorKind.AGENT and not has_required_capabilities(
            list(principal.capabilities), [capability]
        ):
            raise OperationAccessDenied(f"Missing required capability: {capability}")

    def _authorize_capabilities(
        self, principal: OperationPrincipal, capabilities: frozenset[str]
    ) -> None:
        if not capabilities or principal.actor_kind != ActorKind.AGENT:
            return
        if not has_required_capabilities(
            list(principal.capabilities), sorted(capabilities)
        ):
            missing = ", ".join(sorted(capabilities))
            raise OperationAccessDenied(
                f"Missing operation-kind capabilities: {missing}"
            )

    def _authorize_scope(
        self, principal: OperationPrincipal, scope_id: str, capability: str
    ) -> None:
        self._authorize(principal, capability)
        if scope_id not in principal.scope_ids:
            raise OperationAccessDenied(
                "The principal is not authorized for this scope"
            )

    def _actor_filter(
        self, principal: OperationPrincipal
    ) -> tuple[str | None, str | None]:
        if not self.isolate_operations_by_actor:
            return None, None
        return principal.actor_kind.value, principal.actor_id

    def _operation_visible_to_principal(
        self, principal: OperationPrincipal, row: ManagedOperationRow
    ) -> bool:
        if not self.isolate_operations_by_actor:
            return True
        return (
            row["actor_kind"] == principal.actor_kind.value
            and row["actor_id"] == principal.actor_id
        )

    def _submission_hash(
        self,
        kind: str,
        submission: ManagedOperationSubmission[InputT],
        serialized_input: bytes,
    ) -> str:
        digest = hashlib.sha256()
        digest.update(kind.encode("utf-8"))
        digest.update(b"\0")
        digest.update(submission.subject.model_dump_json().encode("utf-8"))
        digest.update(b"\0")
        digest.update(serialized_input)
        return digest.hexdigest()

    @staticmethod
    def _recorded_import_hash(kind: str, serialized_import: bytes) -> str:
        digest = hashlib.sha256()
        digest.update(kind.encode("utf-8"))
        digest.update(b"\0")
        digest.update(serialized_import)
        return digest.hexdigest()

    def _required_row(self, operation_id: str) -> ManagedOperationRow:
        row = self.store.get_managed_operation(operation_id)
        if row is None:
            raise RuntimeError(f"Managed operation {operation_id} disappeared")
        return row

    @staticmethod
    async def _await_uninterruptibly(task: asyncio.Task[ResultT]) -> ResultT:
        while True:
            try:
                return await asyncio.shield(task)
            except asyncio.CancelledError:
                if task.done():
                    return task.result()
                continue
