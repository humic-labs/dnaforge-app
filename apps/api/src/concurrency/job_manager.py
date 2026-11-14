"""Universal job manager for sidecar tool calls."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Literal

from ..action_completion import ActionCompletionOwner
from ..control_plane import get_control_plane_store
from ..external_access_observation import observations_enabled, observe_action
from .pools import get_pool_manager
from .refusals import QueueRefusal
from .schema import DNAForgeTool, ExpectedLatency, ToolDuration, ToolHome
from .tool_errors import ToolExecutionFailure
from .tool_registry import (
    AUDIT_RESULT_PROJECTION_KEY,
    ToolContext,
    ToolHandler,
)
from .tool_validation import validate_tool_value

if TYPE_CHECKING:
    from ..operations import ManagedOperationService
    from ..security.native_document_authority import NativeDocumentAuthority

JobStatus = Literal["queued", "running", "stopping", "completed", "failed", "canceled"]
IdempotencyCacheKey = tuple[str, str]

DEFAULT_MAX_TERMINAL_JOBS = 256
DEFAULT_MAX_EVENT_SUBSCRIBERS_PER_JOB = 8
DEFAULT_MAX_EVENT_SUBSCRIBERS_PER_AGENT = 32
DEFAULT_EVENT_SUBSCRIBER_QUEUE_SIZE = 8
RENDERER_INLINE_WAIT_SECONDS = 1.0
TERMINAL_JOB_STATUSES: tuple[JobStatus, ...] = ("completed", "failed", "canceled")
ACTIVE_JOB_STATUSES: tuple[JobStatus, ...] = ("queued", "running", "stopping")
EventQueue = asyncio.Queue[dict[str, Any] | None]


@dataclass
class JobRecord:
    id: str
    tool_name: str
    pool: str
    agent_identity_id: str
    agent_capabilities: list[str]
    cancelable: bool
    turn_id: str | None = None
    status: JobStatus = "queued"
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    terminal_expires_at: float | None = None
    cancel_event: asyncio.Event | None = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    events: list[dict[str, Any]] = field(default_factory=list)
    event_subscribers: set[EventQueue] = field(default_factory=set)
    delivery_result: dict[str, Any] | None = None
    observation_id: str | None = None

    def snapshot(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "jobId": self.id,
            "toolName": self.tool_name,
            "pool": self.pool,
            "status": "running" if self.status == "stopping" else self.status,
        }
        if self.status == "stopping":
            data["cancelRequested"] = True
        return data


@dataclass
class IdempotencyEntry:
    body_hash: str
    job_id: str
    expires_at: float | None = None


class IdempotencyConflict(Exception):
    def __init__(self, key: str):
        super().__init__(
            f"Idempotency key collision with different request body: {key}"
        )
        self.key = key


class JobEventSubscriberLimit(Exception):
    def __init__(self, scope: Literal["job", "agent"], limit: int) -> None:
        super().__init__(f"Job event subscriber {scope} limit reached ({limit})")
        self.scope = scope
        self.limit = limit


class JobEventSubscription:
    def __init__(
        self,
        manager: JobManager,
        job: JobRecord,
        replay_events: tuple[dict[str, Any], ...],
        event_queue: EventQueue | None,
    ) -> None:
        self._manager = manager
        self._job = job
        self._replay_events = replay_events
        self._event_queue = event_queue
        self._started = False
        self._closed = False

    async def __aiter__(self) -> AsyncIterator[dict[str, Any]]:
        if self._started:
            raise RuntimeError("A job event subscription can only be consumed once")
        self._started = True
        try:
            for event in self._replay_events:
                if event.get("event") not in TERMINAL_JOB_STATUSES:
                    yield event
            if self._event_queue is not None:
                while True:
                    event = await self._event_queue.get()
                    if event is None:
                        return
                    if event.get("event") in TERMINAL_JOB_STATUSES:
                        break
                    yield event
            yield {
                "event": self._job.status,
                "data": self._manager.snapshot(self._job.id) or self._job.snapshot(),
            }
        finally:
            self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._manager._close_event_subscription(self._job, self._event_queue)


class JobManager:
    def __init__(
        self,
        ttl_seconds: int = 600,
        max_terminal_jobs: int = DEFAULT_MAX_TERMINAL_JOBS,
        max_event_subscribers_per_job: int = DEFAULT_MAX_EVENT_SUBSCRIBERS_PER_JOB,
        max_event_subscribers_per_agent: int = DEFAULT_MAX_EVENT_SUBSCRIBERS_PER_AGENT,
        event_subscriber_queue_size: int = DEFAULT_EVENT_SUBSCRIBER_QUEUE_SIZE,
    ):
        if max_terminal_jobs < 1:
            raise ValueError("max_terminal_jobs must be at least 1")
        if max_event_subscribers_per_job < 1:
            raise ValueError("max_event_subscribers_per_job must be at least 1")
        if max_event_subscribers_per_agent < 1:
            raise ValueError("max_event_subscribers_per_agent must be at least 1")
        if event_subscriber_queue_size < 1:
            raise ValueError("event_subscriber_queue_size must be at least 1")
        self.ttl_seconds = ttl_seconds
        self.max_terminal_jobs = max_terminal_jobs
        self.max_event_subscribers_per_job = max_event_subscribers_per_job
        self.max_event_subscribers_per_agent = max_event_subscribers_per_agent
        self.event_subscriber_queue_size = event_subscriber_queue_size
        self._jobs: dict[str, JobRecord] = {}
        self._idempotency_cache: dict[IdempotencyCacheKey, IdempotencyEntry] = {}
        self._event_subscriber_counts_by_agent: dict[str, int] = {}
        self._event_subscriber_counts_by_job: dict[str, int] = {}

    def get(self, job_id: str) -> JobRecord | None:
        self._prune_expired()
        job = self._jobs.get(job_id)
        if job is not None:
            return job
        return self._load_retained_terminal_job(job_id)

    def get_live_owner(self, job_id: str) -> JobRecord | None:
        """Return only an active in-memory execution owner, without SQLite fallback."""

        self._prune_expired()
        job = self._jobs.get(job_id)
        if job is None or job.status not in ACTIVE_JOB_STATUSES:
            return None
        return job

    def snapshot(self, job_id: str) -> dict[str, Any] | None:
        """Return transport state, loading terminal payloads from SQLite.

        JobRecord is deliberately lightweight. Ordinary tool results have one
        durable home in agent_action.result_json. Tools with an explicit audit
        projection deliver the original result once from memory, while SQLite
        and later snapshots expose only a clearly named resultProjection.
        """

        job = self.get(job_id)
        if job is None:
            return None
        snapshot = job.snapshot()
        if job.status not in ("completed", "failed", "canceled"):
            return snapshot
        action = get_control_plane_store().get_agent_action(job_id)
        if action is None:
            return snapshot
        if job.delivery_result is not None:
            snapshot["result"] = job.delivery_result
            job.delivery_result = None
            return snapshot
        result = action.get("result_json")
        error = action.get("error_json")
        if result is not None:
            projection = result.get(AUDIT_RESULT_PROJECTION_KEY)
            if set(result) == {AUDIT_RESULT_PROJECTION_KEY} and isinstance(
                projection, dict
            ):
                snapshot["resultProjection"] = projection
            else:
                snapshot["result"] = result
        if error is not None:
            snapshot["error"] = error
        return snapshot

    def retain_delivery_result(self, job_id: str, result: dict[str, Any]) -> bool:
        """Keep a projected tool's original outcome only for live delivery."""

        job = self._jobs.get(job_id)
        if job is None:
            return False
        job.delivery_result = result
        return True

    def peek_delivery_result(self, job_id: str) -> dict[str, Any] | None:
        """Read live delivery state without consuming the client's response."""

        job = self._jobs.get(job_id)
        return None if job is None else job.delivery_result

    def counts(self, *, agent_identity_id: str | None = None) -> dict[str, int]:
        self._prune_expired()
        counts = {"active": 0, "queued": 0, "completed": 0, "failed": 0, "canceled": 0}
        for job in self._jobs.values():
            if (
                agent_identity_id is not None
                and job.agent_identity_id != agent_identity_id
            ):
                continue
            if job.status in {"running", "stopping"}:
                counts["active"] += 1
            elif job.status == "queued":
                counts["queued"] += 1
            elif job.status in counts:
                counts[job.status] += 1
        return counts

    def reconcile_renderer_action(self, action_id: str) -> None:
        """Publish the terminal outcome already committed with the renderer audit."""
        action = get_control_plane_store().get_agent_action(action_id)
        if action is None:
            return
        retained = self._job_record_from_action(action)
        if retained is None:
            return
        job = self._jobs.get(action_id)
        if job is None:
            return
        job.status = retained.status
        self._mark_terminal(job, None)
        self._push_event(job, job.status, job.snapshot())

    async def submit(
        self,
        *,
        spec: DNAForgeTool,
        args: dict[str, Any],
        handler: ToolHandler,
        audit_parameters: dict[str, Any] | None = None,
        agent_identity_id: str = "local-agent",
        agent_capabilities: list[str] | None = None,
        idempotency_key: str | None = None,
        parent_action_id: str | None = None,
        turn_id: str | None = None,
        prefer_async: bool = False,
        managed_operations: ManagedOperationService | None = None,
        native_document_authority: NativeDocumentAuthority | None = None,
        reuse_cached_result: bool = True,
        completion_owner: ActionCompletionOwner = "job",
        persisted_result_projector: (
            Callable[[dict[str, Any]], dict[str, Any]] | None
        ) = None,
    ) -> JobRecord:
        self._prune_expired()

        effective_capabilities = (
            spec.required_capabilities
            if agent_capabilities is None
            else agent_capabilities
        )
        body_hash = _stable_hash(
            {
                "tool": spec.name,
                "args": args,
                "agent_identity_id": agent_identity_id,
                "agent_capabilities": effective_capabilities,
                "parent_action_id": parent_action_id,
                "turn_id": turn_id,
            }
        )
        cache_key = idempotency_key if reuse_cached_result else None
        if cache_key:
            cached = self._get_cached(agent_identity_id, cache_key, body_hash)
            if cached is not None:
                return cached

        self._ensure_pool_accepts(spec.pool)

        store = get_control_plane_store()
        store.ensure_agent_identity(
            agent_identity_id,
            scope=effective_capabilities,
        )
        job_id = store.insert_agent_action(
            agent_identity_id=agent_identity_id,
            tool_name=spec.name,
            parameters=args if audit_parameters is None else audit_parameters,
            authorized_scope=effective_capabilities,
            parent_action_id=parent_action_id,
            root_action_id=_root_action_id(store.get_agent_action(parent_action_id)),
            job_pool=spec.pool,
            job_cancelable=spec.category.cancelable,
            job_duration=spec.category.duration,
            job_turn_id=turn_id,
            idempotency_key_hash=(
                _idempotency_key_hash(cache_key) if cache_key else None
            ),
            idempotency_body_hash=body_hash if cache_key else None,
            completion_owner=completion_owner,
        )
        job = JobRecord(
            id=job_id,
            tool_name=spec.name,
            pool=spec.pool,
            agent_identity_id=agent_identity_id,
            agent_capabilities=effective_capabilities,
            cancelable=spec.category.cancelable,
            turn_id=turn_id,
        )
        self._jobs[job_id] = job
        if cache_key:
            memory_cache_key = _idempotency_cache_key(agent_identity_id, cache_key)
            self._idempotency_cache[memory_cache_key] = IdempotencyEntry(
                body_hash=body_hash,
                job_id=job_id,
            )
        self._push_event(job, "queued", {"status": "queued"})

        should_run_inline = (
            spec.expected_latency == ExpectedLatency.SUB_SECOND.value
            or spec.category.duration == ToolDuration.IMMEDIATE.value
        ) and not (
            prefer_async
            and spec.home in {ToolHome.RENDERER.value, ToolHome.NATIVE.value}
        )
        if should_run_inline and spec.home not in {
            ToolHome.RENDERER.value,
            ToolHome.NATIVE.value,
        }:
            await self._run_job(
                job,
                spec,
                args,
                handler,
                cache_key,
                body_hash,
                effective_capabilities,
                managed_operations,
                native_document_authority,
                persisted_result_projector,
                completion_owner,
            )
        else:
            owner = asyncio.create_task(
                self._run_job(
                    job,
                    spec,
                    args,
                    handler,
                    cache_key,
                    body_hash,
                    effective_capabilities,
                    managed_operations,
                    native_document_authority,
                    persisted_result_projector,
                    completion_owner,
                )
            )
            job.task = owner
            if should_run_inline:
                if spec.home == ToolHome.RENDERER.value:
                    await asyncio.wait({owner}, timeout=RENDERER_INLINE_WAIT_SECONDS)
                else:
                    await asyncio.shield(owner)
        return job

    async def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job is None or not job.cancelable:
            return False
        if job.status in TERMINAL_JOB_STATUSES or job.status == "stopping":
            return True
        running = job.status == "running"
        job.status = "stopping"
        job.updated_at = time.time()
        if job.cancel_event is not None:
            job.cancel_event.set()
        self._push_event(job, "stopping", job.snapshot())
        if running and job.task is not None:
            job.task.cancel()
        return True

    def subscribe_events(self, job_id: str) -> JobEventSubscription | None:
        job = self.get(job_id)
        if job is None:
            return None
        replay_events = tuple(job.events)
        job_subscriber_count = self._event_subscriber_counts_by_job.get(job.id, 0)
        if job_subscriber_count >= self.max_event_subscribers_per_job:
            raise JobEventSubscriberLimit("job", self.max_event_subscribers_per_job)
        agent_subscriber_count = self._event_subscriber_counts_by_agent.get(
            job.agent_identity_id, 0
        )
        if agent_subscriber_count >= self.max_event_subscribers_per_agent:
            raise JobEventSubscriberLimit("agent", self.max_event_subscribers_per_agent)

        self._event_subscriber_counts_by_job[job.id] = job_subscriber_count + 1
        self._event_subscriber_counts_by_agent[job.agent_identity_id] = (
            agent_subscriber_count + 1
        )
        if job.status in TERMINAL_JOB_STATUSES:
            return JobEventSubscription(self, job, replay_events, None)

        event_queue: EventQueue = asyncio.Queue(
            maxsize=self.event_subscriber_queue_size
        )
        job.event_subscribers.add(event_queue)
        return JobEventSubscription(self, job, replay_events, event_queue)

    async def event_stream(self, job_id: str):
        subscription = self.subscribe_events(job_id)
        if subscription is None:
            return
        try:
            async for event in subscription:
                yield event
        finally:
            subscription.close()

    async def _run_job(
        self,
        job: JobRecord,
        spec: DNAForgeTool,
        args: dict[str, Any],
        handler: ToolHandler,
        idempotency_key: str | None,
        body_hash: str,
        agent_capabilities: list[str],
        managed_operations: ManagedOperationService | None,
        native_document_authority: NativeDocumentAuthority | None,
        persisted_result_projector: Callable[[dict[str, Any]], dict[str, Any]] | None,
        completion_owner: ActionCompletionOwner,
    ) -> None:
        store = get_control_plane_store()
        cancel_event = job.cancel_event
        if cancel_event is None:
            raise RuntimeError(f"Active job {job.id} has no cancellation owner")
        try:
            if observations_enabled():
                try:
                    job.observation_id = str(uuid.uuid4())
                except Exception:
                    job.observation_id = None
                if job.observation_id is not None:
                    await observe_action(
                        job.id, admitted=True, operation_id=job.observation_id
                    )
            if cancel_event.is_set():
                raise asyncio.CancelledError
            job.status = "running"
            job.updated_at = time.time()
            self._push_event(job, "running", {"status": "running"})
            context = ToolContext(
                job_id=job.id,
                agent_identity_id=job.agent_identity_id,
                agent_capabilities=agent_capabilities,
                cancel_event=cancel_event,
                turn_id=job.turn_id,
                cancelable=job.cancelable,
                managed_operations=managed_operations,
                native_document_authority=native_document_authority,
            )
            async with get_pool_manager().get(spec.pool).slot():
                result = await _maybe_await(handler(args, context))

            if not (isinstance(result, dict) and result.get("ok") is False):
                validate_tool_value(result, spec.outputs, output=True)
            persisted_result = (
                persisted_result_projector(result)
                if persisted_result_projector is not None
                else result
            )
            settled = self._settle_action(
                job,
                result=persisted_result,
                completion_owner=completion_owner,
            )
            store.insert_audit_record(
                action_id=job.id,
                actor_kind="agent",
                actor_identity=job.agent_identity_id,
                actor_scope=agent_capabilities,
                side_effects=[],
                capability_check={
                    "required": spec.required_capabilities,
                    "conditional_required": spec.conditional_required_capabilities,
                    "conditional_evaluation": (
                        "renderer-input-policy"
                        if spec.conditional_required_capabilities
                        else "not-applicable"
                    ),
                    "satisfied": True,
                    "reason": "granted",
                },
            )
            if settled and persisted_result_projector is not None:
                job.delivery_result = result
            self._mark_terminal(job, idempotency_key)
            self._push_event(job, job.status, job.snapshot())
            self._compact_terminal(job)
        except asyncio.CancelledError:
            if job.status in TERMINAL_JOB_STATUSES:
                return
            external_owner = spec.home in {
                ToolHome.RENDERER.value,
                ToolHome.NATIVE.value,
            }
            job.status = "failed" if external_owner else "canceled"
            error = (
                {
                    "code": "OUTCOME_UNRESOLVED",
                    "message": "The sidecar stopped observing external execution. Recover the original action before repeating work.",
                    "retriable": False,
                    "details": {"actionId": job.id, "stateMayHaveChanged": True},
                }
                if external_owner
                else {"code": "CANCELED", "message": "Job canceled"}
            )
            self._settle_action(job, error=error)
            self._mark_terminal(job, idempotency_key)
            self._push_event(job, job.status, job.snapshot())
            self._compact_terminal(job)
        except ToolExecutionFailure as exc:
            is_canceled = exc.code == "CANCELED"
            job.status = "canceled" if is_canceled else "failed"
            error = exc.to_error()
            self._settle_action(
                job,
                error=error,
                completion_owner=(
                    exc.completion_owner if completion_owner == "renderer" else "job"
                ),
            )
            store.insert_audit_record(
                action_id=job.id,
                actor_kind="agent",
                actor_identity=job.agent_identity_id,
                actor_scope=agent_capabilities,
                side_effects=[],
                capability_check={
                    "required": spec.required_capabilities,
                    "conditional_required": spec.conditional_required_capabilities,
                    "conditional_evaluation": (
                        "renderer-input-policy"
                        if spec.conditional_required_capabilities
                        else "not-applicable"
                    ),
                    "satisfied": True,
                    "reason": (
                        "canceled_after_grant"
                        if is_canceled
                        else "tool_error_after_grant"
                    ),
                },
            )
            self._mark_terminal(job, idempotency_key)
            self._push_event(job, job.status, job.snapshot())
            self._compact_terminal(job)
        except Exception as exc:
            job.status = "failed"
            error = {"code": "HANDLER_ERROR", "message": str(exc)}
            self._settle_action(job, error=error)
            store.insert_audit_record(
                action_id=job.id,
                actor_kind="agent",
                actor_identity=job.agent_identity_id,
                actor_scope=agent_capabilities,
                side_effects=[],
                capability_check={
                    "required": spec.required_capabilities,
                    "conditional_required": spec.conditional_required_capabilities,
                    "conditional_evaluation": (
                        "renderer-input-policy"
                        if spec.conditional_required_capabilities
                        else "not-applicable"
                    ),
                    "satisfied": True,
                    "reason": "handler_error_after_grant",
                },
            )
            self._mark_terminal(job, idempotency_key)
            self._push_event(job, job.status, job.snapshot())
            self._compact_terminal(job)
        finally:
            job.updated_at = time.time()
            if job.status in ("completed", "failed", "canceled"):
                if not job.events or job.events[-1].get("event") != job.status:
                    self._push_event(job, job.status, job.snapshot())
                self._mark_terminal(job, idempotency_key)
                self._compact_terminal(job)

                if job.observation_id is not None:
                    await observe_action(
                        job.id, operation_id=job.observation_id, execution=job.status
                    )

    def _settle_action(
        self,
        job: JobRecord,
        *,
        result: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
        completion_owner: ActionCompletionOwner = "job",
    ) -> bool:
        store = get_control_plane_store()
        expires_at = time.time() + self.ttl_seconds
        with store.transaction():
            unresolved = error is not None and error.get("code") == "OUTCOME_UNRESOLVED"
            settled = (
                False
                if unresolved
                else store.complete_agent_action(
                    job.id,
                    result=result,
                    error=error,
                    completion_owner=completion_owner,
                    terminal_expires_at=expires_at,
                )
            )
            action = store.get_agent_action(job.id)
            if action is None:
                raise RuntimeError(f"Missing admitted action: {job.id}")
            if action["completion_state"] != "settled":
                action = store.reconcile_interrupted_agent_action(
                    job.id,
                    error=error
                    if unresolved
                    else {
                        "code": "OUTCOME_UNRESOLVED",
                        "message": "The completion owner has not reported an outcome. Recover the original action before repeating work.",
                        "retriable": False,
                        "details": {"actionId": job.id, "stateMayHaveChanged": True},
                    },
                    terminal_expires_at=expires_at,
                )
            retained = self._job_record_from_action(action)
            if retained is None:
                raise RuntimeError(f"Action has no retained outcome: {job.id}")
            job.status = retained.status
        return settled

    def _push_event(self, job: JobRecord, event: str, data: dict[str, Any]) -> None:
        if (
            event in TERMINAL_JOB_STATUSES
            and job.events
            and job.events[-1].get("event") == event
        ):
            return
        payload = {"event": event, "data": data}
        job.events.append(payload)
        for event_queue in tuple(job.event_subscribers):
            try:
                event_queue.put_nowait(payload)
            except asyncio.QueueFull:
                self._detach_event_subscriber_queue(job, event_queue, terminate=True)

    def _detach_event_subscriber_queue(
        self,
        job: JobRecord,
        event_queue: EventQueue,
        *,
        terminate: bool,
    ) -> None:
        if event_queue not in job.event_subscribers:
            return
        job.event_subscribers.remove(event_queue)
        if not terminate:
            return
        try:
            while True:
                event_queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        event_queue.put_nowait(None)

    def _close_event_subscription(
        self,
        job: JobRecord,
        event_queue: EventQueue | None,
    ) -> None:
        if event_queue is not None:
            self._detach_event_subscriber_queue(job, event_queue, terminate=False)

        job_count = self._event_subscriber_counts_by_job.get(job.id, 0)
        if job_count <= 1:
            self._event_subscriber_counts_by_job.pop(job.id, None)
        else:
            self._event_subscriber_counts_by_job[job.id] = job_count - 1
        agent_count = self._event_subscriber_counts_by_agent.get(
            job.agent_identity_id, 0
        )
        if agent_count <= 1:
            self._event_subscriber_counts_by_agent.pop(job.agent_identity_id, None)
        else:
            self._event_subscriber_counts_by_agent[job.agent_identity_id] = (
                agent_count - 1
            )

    def _get_cached(
        self,
        agent_identity_id: str,
        idempotency_key: str,
        body_hash: str,
    ) -> JobRecord | None:
        self._prune_expired()
        cache_key = _idempotency_cache_key(agent_identity_id, idempotency_key)
        entry = self._idempotency_cache.get(cache_key)
        if entry is None:
            action = (
                get_control_plane_store().get_retained_agent_action_by_idempotency_hash(
                    agent_identity_id,
                    _idempotency_key_hash(idempotency_key),
                    now=time.time(),
                    include_unresolved=True,
                )
            )
            if action is None:
                return None
            if action.get("idempotency_body_hash") != body_hash:
                raise IdempotencyConflict(idempotency_key)
            recovered = self._recover_interrupted_action(action)
            return self._job_record_from_action(recovered)
        if entry.expires_at is not None and entry.expires_at <= time.monotonic():
            self._idempotency_cache.pop(cache_key, None)
            return None
        if entry.body_hash != body_hash:
            raise IdempotencyConflict(idempotency_key)
        job = self.get(entry.job_id)
        if job is None:
            self._idempotency_cache.pop(cache_key, None)
            return None
        return job

    def _mark_idempotency_completed(
        self,
        agent_identity_id: str,
        idempotency_key: str,
        job_id: str,
    ) -> None:
        cache_key = _idempotency_cache_key(agent_identity_id, idempotency_key)
        entry = self._idempotency_cache.get(cache_key)
        if entry is not None and entry.job_id == job_id:
            entry.expires_at = time.monotonic() + self.ttl_seconds

    def _mark_terminal(self, job: JobRecord, idempotency_key: str | None) -> None:
        job.updated_at = time.time()
        if job.terminal_expires_at is None:
            job.terminal_expires_at = time.monotonic() + self.ttl_seconds
        if idempotency_key:
            self._mark_idempotency_completed(
                job.agent_identity_id,
                idempotency_key,
                job.id,
            )
        else:
            for entry in self._idempotency_cache.values():
                if entry.job_id == job.id and entry.expires_at is None:
                    entry.expires_at = job.terminal_expires_at

    def _compact_terminal(self, job: JobRecord) -> None:
        """Release execution-only owners after durable terminal state exists."""

        job.task = None
        job.cancel_event = None
        self._prune_terminal_overflow()

    def _prune_terminal_overflow(self) -> None:
        terminal_jobs = [
            (job_id, job)
            for job_id, job in self._jobs.items()
            if job.terminal_expires_at is not None
        ]
        overflow = len(terminal_jobs) - self.max_terminal_jobs
        if overflow <= 0:
            return
        terminal_jobs.sort(
            key=lambda item: (item[1].terminal_expires_at, item[1].updated_at)
        )
        for job_id, _job in terminal_jobs[:overflow]:
            self._evict_terminal_job(job_id)

    def _evict_terminal_job(self, job_id: str) -> None:
        job = self._jobs.get(job_id)
        if job is None or job.terminal_expires_at is None:
            return
        self._jobs.pop(job_id, None)
        for key, entry in list(self._idempotency_cache.items()):
            if entry.job_id == job_id:
                self._idempotency_cache.pop(key, None)

    def _prune_expired(self) -> None:
        now = time.monotonic()
        expired_job_ids = {
            job_id
            for job_id, job in self._jobs.items()
            if job.terminal_expires_at is not None and job.terminal_expires_at <= now
        }
        for job_id in expired_job_ids:
            self._evict_terminal_job(job_id)
        for key, entry in list(self._idempotency_cache.items()):
            if entry.expires_at is not None and entry.expires_at <= now:
                self._idempotency_cache.pop(key, None)

    def _recover_interrupted_action(self, action: dict[str, Any]) -> dict[str, Any]:
        if action["completion_state"] == "settled":
            return action

        store = get_control_plane_store()
        return (
            store.reconcile_interrupted_agent_action(
                action["id"],
                error={
                    "code": "OUTCOME_UNRESOLVED",
                    "message": "The sidecar lost this action's execution owner. Inspect the original action and any domain audit before repeating work.",
                    "retriable": False,
                    "details": {"actionId": action["id"], "stateMayHaveChanged": True},
                },
                terminal_expires_at=time.time() + self.ttl_seconds,
            )
            or action
        )

    def reconcile_interrupted_actions(self) -> None:
        """Resolve durable admissions after the control-plane store starts."""
        store = get_control_plane_store()
        for action in store.list_incomplete_agent_actions():
            self._recover_interrupted_action(action)

    def _load_retained_terminal_job(self, job_id: str) -> JobRecord | None:
        action = get_control_plane_store().get_agent_action(job_id)
        if action is None:
            return None
        action = self._recover_interrupted_action(action)
        expires_at = action.get("terminal_expires_at")
        completed_at = action.get("completed_at")
        if (
            not isinstance(expires_at, (int, float))
            or expires_at <= time.time()
            or not isinstance(completed_at, str)
            or not completed_at
        ):
            return None
        return self._job_record_from_action(action)

    def _job_record_from_action(self, action: dict[str, Any]) -> JobRecord | None:
        job_id = action.get("id")
        tool_name = action.get("tool_name")
        pool = action.get("job_pool")
        agent_identity_id = action.get("agent_identity_id")
        expires_at = action.get("terminal_expires_at")
        completed_at = action.get("completed_at")
        if (
            not isinstance(job_id, str)
            or not isinstance(tool_name, str)
            or not isinstance(pool, str)
            or not isinstance(agent_identity_id, str)
        ):
            return None
        if (
            not isinstance(expires_at, (int, float))
            or expires_at <= time.time()
            or not isinstance(completed_at, str)
            or not completed_at
        ):
            return None
        error = action.get("error_json")
        if isinstance(error, dict) and error.get("code") == "CANCELED":
            status: JobStatus = "canceled"
        elif error is not None:
            status = "failed"
        else:
            status = "completed"
        raw_capabilities = action.get("authorized_scope_json")
        capabilities = (
            [value for value in raw_capabilities if isinstance(value, str)]
            if isinstance(raw_capabilities, list)
            else []
        )
        remaining_seconds = max(0.0, float(expires_at) - time.time())
        raw_turn_id = action.get("job_turn_id")
        return JobRecord(
            id=job_id,
            tool_name=tool_name,
            pool=pool,
            agent_identity_id=agent_identity_id,
            agent_capabilities=capabilities,
            cancelable=bool(action.get("job_cancelable")),
            turn_id=raw_turn_id if isinstance(raw_turn_id, str) else None,
            status=status,
            terminal_expires_at=time.monotonic() + remaining_seconds,
            cancel_event=None,
        )

    def _ensure_pool_accepts(self, pool_name: str) -> None:
        pool_stats = get_pool_manager().stats()[pool_name]
        planned = sum(
            1
            for job in self._jobs.values()
            if job.pool == pool_name and job.status in ACTIVE_JOB_STATUSES
        )
        capacity = pool_stats["size"]
        max_queued = pool_stats["max_queued_jobs"]
        if planned >= capacity + max_queued:
            raise QueueRefusal(
                pool=pool_name,
                queue_depth=max(0, planned - capacity),
                pool_capacity=capacity,
                refusal_kind="saturated",
            )


async def _maybe_await(value):
    if inspect.isawaitable(value):
        return await value
    return value


def _stable_hash(value: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _idempotency_key_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _idempotency_cache_key(
    agent_identity_id: str,
    idempotency_key: str,
) -> IdempotencyCacheKey:
    return (agent_identity_id, idempotency_key)


def _root_action_id(parent_action: dict[str, Any] | None) -> str | None:
    if parent_action is None:
        return None
    return parent_action.get("root_action_id") or parent_action.get("id")


_JOB_MANAGER: JobManager | None = None


def get_job_manager() -> JobManager:
    global _JOB_MANAGER
    if _JOB_MANAGER is None:
        _JOB_MANAGER = JobManager()
    return _JOB_MANAGER


def reset_job_manager() -> JobManager:
    global _JOB_MANAGER
    _JOB_MANAGER = JobManager()
    return _JOB_MANAGER
