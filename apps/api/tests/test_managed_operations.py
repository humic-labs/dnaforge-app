from __future__ import annotations

import asyncio
import json
import sqlite3
import threading

import pytest
from pydantic import BaseModel, ConfigDict

from src.control_plane import ControlPlaneStore
from src.operations import (
    ActorKind,
    CancellationMode,
    ClientChannel,
    ManagedOperationKindAdapter,
    ManagedOperationService,
    ManagedOperationSubmission,
    OperationAccessDenied,
    OperationCanceled,
    OperationExecutionError,
    OperationKind,
    OperationKindUnavailable,
    OperationNotFound,
    OperationPrincipal,
    OperationQueueFull,
    OperationResultStorageFull,
    OperationState,
    OperationSubject,
    RuntimeOwnerConflict,
    SubmissionConflict,
)


class ExampleInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: str


class ExampleResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: str


class AlternateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    count: int


class AlternateResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    doubled: int


def human(*, scope: str = "workspace-a") -> OperationPrincipal:
    return OperationPrincipal(
        actor_kind=ActorKind.HUMAN,
        actor_id="human-a",
        channel=ClientChannel.DESKTOP_UI,
        scope_ids={scope},
    )


def agent(
    *,
    scope: str = "workspace-a",
    capabilities: set[str] | None = None,
) -> OperationPrincipal:
    return OperationPrincipal(
        actor_kind=ActorKind.AGENT,
        actor_id="agent-a",
        channel=ClientChannel.AGENT,
        scope_ids={scope},
        capabilities=capabilities or set(),
    )


def submission(
    key: str,
    value: str = "input",
    *,
    scope: str = "workspace-a",
) -> ManagedOperationSubmission[ExampleInput]:
    return ManagedOperationSubmission[ExampleInput](
        submission_key=key,
        subject=OperationSubject(
            scope_id=scope,
            subject_id="sequence-a",
            input_revision="sha256:abc",
        ),
        input=ExampleInput(value=value),
    )


def alternate_submission(
    key: str,
    count: int = 2,
    *,
    scope: str = "workspace-a",
) -> ManagedOperationSubmission[AlternateInput]:
    return ManagedOperationSubmission[AlternateInput](
        submission_key=key,
        subject=OperationSubject(
            scope_id=scope,
            subject_id="alternate-a",
            input_revision="sha256:def",
        ),
        input=AlternateInput(count=count),
    )


async def eventually_state(
    service: ManagedOperationService[ExampleInput, ExampleResult],
    principal: OperationPrincipal,
    operation_id: str,
    expected: OperationState,
) -> None:
    for _ in range(200):
        if service.get(principal, operation_id).state == expected:
            return
        await asyncio.sleep(0.005)
    assert service.get(principal, operation_id).state == expected


@pytest.fixture
def store(tmp_path):
    value = ControlPlaneStore(tmp_path / "control-plane.sqlite3")
    value.initialize()
    try:
        yield value
    finally:
        value.close()


@pytest.mark.asyncio
async def test_same_submission_is_one_operation_and_changed_payload_conflicts(store):
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return ExampleResult(value=value.value.upper())

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
    )
    first = await service.start(human(), submission("request-a"))
    await entered.wait()

    duplicate = await service.start(human(), submission("request-a"))
    assert duplicate.id == first.id
    assert calls == 1

    with pytest.raises(SubmissionConflict):
        await service.start(human(), submission("request-a", "changed"))

    release.set()
    await eventually_state(service, human(), first.id, OperationState.SUCCEEDED)
    await service.aclose()


@pytest.mark.asyncio
async def test_one_physical_worker_queued_stop_and_active_settlement(store):
    first_entered = threading.Event()
    release_first = threading.Event()
    second_entered = threading.Event()

    async def execute(value: ExampleInput, cancel: threading.Event) -> ExampleResult:
        def physical() -> ExampleResult:
            if value.value == "first":
                first_entered.set()
                release_first.wait(timeout=5)
            else:
                second_entered.set()
            return ExampleResult(value=f"{value.value}:{cancel.is_set()}")

        return await asyncio.to_thread(physical)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
        max_pending=1,
        cancellation_mode=CancellationMode.COOPERATIVE,
    )
    first = await service.start(human(), submission("first", "first"))
    assert await asyncio.to_thread(first_entered.wait, 1)
    second = await service.start(human(), submission("second", "second"))
    with pytest.raises(OperationQueueFull) as refusal:
        await service.start(human(), submission("third", "third"))
    assert refusal.value.code == "OPERATION_QUEUE_FULL"

    queued_cancel = await service.request_cancel(human(), second.id)
    assert queued_cancel.disposition == "accepted"
    assert queued_cancel.snapshot.state == OperationState.CANCELED
    assert store.get_managed_operation(second.id)["result_reservation_bytes"] == 0
    assert not second_entered.is_set()

    stopping = await service.request_cancel(human(), first.id)
    assert stopping.disposition == "accepted"
    assert stopping.snapshot.state == OperationState.STOPPING
    await asyncio.sleep(0.02)
    assert service.get(human(), first.id).state == OperationState.STOPPING

    release_first.set()
    await eventually_state(service, human(), first.id, OperationState.SUCCEEDED)
    assert service.get_result(human(), first.id).result == ExampleResult(
        value="first:True"
    )
    assert not second_entered.is_set()
    await service.aclose()


@pytest.mark.asyncio
async def test_cooperative_cancel_needs_explicit_executor_canceled_outcome(store):
    entered = threading.Event()
    cleanup_finished = threading.Event()
    release_cleanup = threading.Event()
    second_entered = threading.Event()

    async def execute(value: ExampleInput, cancel: threading.Event) -> ExampleResult:
        def physical() -> ExampleResult:
            if value.value == "first":
                entered.set()
                assert cancel.wait(timeout=1)
                release_cleanup.wait(timeout=5)
                cleanup_finished.set()
                raise OperationCanceled()
            second_entered.set()
            return ExampleResult(value="second")

        return await asyncio.to_thread(physical)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
        cancellation_mode=CancellationMode.COOPERATIVE,
    )
    first = await service.start(human(), submission("first", "first"))
    assert await asyncio.to_thread(entered.wait, 1)
    second = await service.start(human(), submission("second", "second"))

    accepted = await service.request_cancel(human(), first.id)
    duplicate = await service.request_cancel(human(), first.id)
    assert accepted.disposition == "accepted"
    assert duplicate.disposition == "already_requested"
    assert not second_entered.is_set()

    release_cleanup.set()
    assert await asyncio.to_thread(cleanup_finished.wait, 1)
    await eventually_state(service, human(), first.id, OperationState.CANCELED)
    assert service.get_result(human(), first.id).status == "unavailable"
    await eventually_state(service, human(), second.id, OperationState.SUCCEEDED)
    settled = await service.request_cancel(human(), first.id)
    assert settled.disposition == "already_settled"
    await service.aclose()


@pytest.mark.asyncio
async def test_real_failure_after_cooperative_stop_remains_failed(store):
    entered = asyncio.Event()
    release = asyncio.Event()

    async def execute(_value: ExampleInput, cancel: threading.Event) -> ExampleResult:
        entered.set()
        await release.wait()
        assert cancel.is_set()
        raise OperationExecutionError("ENGINE_FAILED", "Engine failed after Stop")

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
        cancellation_mode=CancellationMode.COOPERATIVE,
    )
    operation = await service.start(human(), submission("failure"))
    await entered.wait()
    assert (
        await service.request_cancel(human(), operation.id)
    ).disposition == "accepted"
    release.set()
    await eventually_state(service, human(), operation.id, OperationState.FAILED)
    assert service.get(human(), operation.id).error.code == "ENGINE_FAILED"
    await service.aclose()


@pytest.mark.asyncio
async def test_default_queued_only_mode_refuses_active_cancel_without_signaling(store):
    entered = asyncio.Event()
    release = asyncio.Event()
    observed_cancel: list[bool] = []

    async def execute(value: ExampleInput, cancel: threading.Event) -> ExampleResult:
        entered.set()
        await release.wait()
        observed_cancel.append(cancel.is_set())
        return ExampleResult(value=value.value)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
    )
    operation = await service.start(human(), submission("queued-only"))
    await entered.wait()
    running = service.get(human(), operation.id)
    assert running.cancellation_mode == CancellationMode.QUEUED_ONLY
    assert running.cancellation_availability == "unavailable"

    refused = await service.request_cancel(human(), operation.id)
    assert refused.disposition == "unavailable"
    assert refused.snapshot.state == OperationState.RUNNING
    assert "Active" in refused.reason

    release.set()
    await eventually_state(service, human(), operation.id, OperationState.SUCCEEDED)
    assert observed_cancel == [False]
    assert (
        service.get(human(), operation.id).cancellation_availability
        == "already_settled"
    )
    await service.aclose()


@pytest.mark.asyncio
async def test_submit_takes_an_immutable_deep_input_snapshot(store):
    first_release = asyncio.Event()
    observed: list[str] = []

    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        if value.value == "first":
            await first_release.wait()
        observed.append(value.value)
        return ExampleResult(value=value.value)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
    )
    first = await service.start(human(), submission("first", "first"))
    await eventually_state(service, human(), first.id, OperationState.RUNNING)
    mutable = submission("second", "original")
    second = await service.start(human(), mutable)
    mutable.input.value = "mutated-after-acceptance"

    first_release.set()
    await eventually_state(service, human(), second.id, OperationState.SUCCEEDED)
    assert observed == ["first", "original"]
    await service.aclose()


@pytest.mark.asyncio
async def test_shutdown_cancels_queue_and_waits_for_active_physical_settlement(store):
    active_entered = threading.Event()
    queued_entered = threading.Event()
    physical_release = threading.Event()
    active_cancel_observed: list[bool] = []

    async def execute(value: ExampleInput, cancel: threading.Event) -> ExampleResult:
        def physical() -> ExampleResult:
            if value.value == "active":
                active_entered.set()
                physical_release.wait(timeout=5)
                active_cancel_observed.append(cancel.is_set())
            else:
                queued_entered.set()
            return ExampleResult(value=value.value)

        return await asyncio.to_thread(physical)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
    )
    active = await service.start(human(), submission("active", "active"))
    assert await asyncio.to_thread(active_entered.wait, 1)
    queued = await service.start(human(), submission("queued", "queued"))

    closing = asyncio.create_task(service.aclose())
    await eventually_state(service, human(), active.id, OperationState.RUNNING)
    await eventually_state(service, human(), queued.id, OperationState.CANCELED)
    assert not closing.done()
    assert not queued_entered.is_set()

    physical_release.set()
    await asyncio.wait_for(closing, timeout=1)
    assert service.get(human(), active.id).state == OperationState.SUCCEEDED
    assert active_cancel_observed == [False]
    assert service.get(human(), active.id).cancel_requested_at is None
    assert any(
        action["outcome"] == "waiting_for_non_cancelable_settlement"
        for action in store.list_managed_operation_actions(active.id)
    )
    assert not queued_entered.is_set()


@pytest.mark.asyncio
async def test_duplicate_live_runtime_refuses_without_interrupting_owner(store):
    release = asyncio.Event()

    async def execute(_value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        await release.wait()
        return ExampleResult(value="done")

    owner = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
    )
    started = await owner.start(human(), submission("owned"))
    await eventually_state(owner, human(), started.id, OperationState.RUNNING)

    second_store = ControlPlaneStore(store.db_path)
    second_store.initialize()
    try:
        with pytest.raises(RuntimeOwnerConflict):
            ManagedOperationService(
                store=second_store,
                runtime_scope="runtime-a",
                kind=OperationKind.ANNOTATION,
                input_model=ExampleInput,
                result_model=ExampleResult,
                executor=execute,
            )
        assert owner.get(human(), started.id).state == OperationState.RUNNING
    finally:
        second_store.close()

    release.set()
    await eventually_state(owner, human(), started.id, OperationState.SUCCEEDED)
    await owner.aclose()


def test_restart_reconciles_only_after_proving_prior_owner_dead(store):
    store.claim_managed_operation_owner("runtime-a", "dead-owner")
    operation_id = store.insert_managed_operation(
        runtime_scope="runtime-a",
        scope_id="workspace-a",
        kind="annotation",
        subject_id="sequence-a",
        input_revision="sha256:abc",
        submission_key="request-a",
        submission_payload_hash="digest-a",
        actor_kind="human",
        actor_id="human-a",
        channel="desktop_ui",
        owner_instance_id="dead-owner",
        now=1.0,
        result_reservation_bytes=64,
    )

    async def execute(_value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        return ExampleResult(value="must-not-replay")

    replacement = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
    )

    recovered = replacement.get(human(), operation_id)
    assert recovered.state == OperationState.INTERRUPTED
    assert recovered.version == 2
    assert recovered.owner_instance_id == replacement.owner_instance_id
    assert store.get_managed_operation(operation_id)["result_reservation_bytes"] == 0
    asyncio.run(replacement.aclose())


@pytest.mark.asyncio
async def test_restart_preserves_settled_owner_instance_identity(store):
    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        return ExampleResult(value=value.value)

    first = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
    )
    operation = await first.start(human(), submission("settled"))
    await eventually_state(first, human(), operation.id, OperationState.SUCCEEDED)
    settled_owner = first.owner_instance_id
    await first.aclose()

    replacement = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
    )
    assert replacement.owner_instance_id != settled_owner
    assert replacement.get(human(), operation.id).owner_instance_id == settled_owner
    assert replacement.get_result(human(), operation.id).status == "available"
    await replacement.aclose()


@pytest.mark.asyncio
async def test_service_enforces_scope_and_agent_capabilities(store):
    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        return ExampleResult(value=value.value)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
    )
    operation = await service.start(human(), submission("request-a"))

    with pytest.raises(OperationAccessDenied):
        await service.start(human(scope="workspace-b"), submission("foreign"))
    with pytest.raises(OperationNotFound):
        service.get(human(scope="workspace-b"), operation.id)
    assert service.list(human(scope="workspace-b"), scope_id="workspace-b") == []

    with pytest.raises(OperationAccessDenied):
        service.get(agent(capabilities={"operations.start"}), operation.id)
    permitted = agent(capabilities={"operations.read", "operations.cancel"})
    assert service.get(permitted, operation.id).id == operation.id

    await eventually_state(service, human(), operation.id, OperationState.SUCCEEDED)
    with pytest.raises(OperationAccessDenied):
        await service.release_result(permitted, operation.id)
    released = await service.release_result(
        agent(capabilities={"operations.release"}), operation.id
    )
    assert released.disposition == "released"
    await service.aclose()


@pytest.mark.asyncio
async def test_typed_failure_is_safe_and_empty_result_is_success(store):
    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        if value.value == "fail":
            raise OperationExecutionError(
                "ANNOTATION_NOT_READY", "Reference data unavailable"
            )
        if value.value == "secret":
            raise RuntimeError("secret=/private/token")
        return ExampleResult(value="")

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
    )
    failure = await service.start(human(), submission("failure", "fail"))
    unexpected = await service.start(human(), submission("unexpected", "secret"))
    empty = await service.start(human(), submission("empty", "empty"))

    await eventually_state(service, human(), failure.id, OperationState.FAILED)
    await eventually_state(service, human(), unexpected.id, OperationState.FAILED)
    await eventually_state(service, human(), empty.id, OperationState.SUCCEEDED)
    assert service.get(human(), failure.id).error.code == "ANNOTATION_NOT_READY"
    unexpected_error = service.get(human(), unexpected.id).error
    assert unexpected_error.code == "OPERATION_FAILED"
    assert "secret" not in unexpected_error.message
    assert service.get_result(human(), empty.id).result == ExampleResult(value="")
    await service.aclose()


@pytest.mark.asyncio
async def test_retained_result_has_no_timer_and_metadata_pruning_cannot_delete_it(
    store,
):
    now = [100.0]

    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        if value.value.startswith("fail"):
            raise OperationExecutionError("EXPECTED_FAILURE", "Expected test failure")
        return ExampleResult(value=value.value)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
        clock=lambda: now[0],
        max_terminal_history=1,
    )
    operation = await service.start(human(), submission("retained"))
    await eventually_state(service, human(), operation.id, OperationState.SUCCEEDED)
    assert service.get_result(human(), operation.id).result == ExampleResult(
        value="input"
    )

    for index in range(2):
        failure = await service.start(
            human(), submission(f"failure-{index}", f"fail-{index}")
        )
        await eventually_state(service, human(), failure.id, OperationState.FAILED)

    now[0] = 100_000_000.0
    service.prune()
    retained = service.get(human(), operation.id)
    assert retained.state == OperationState.SUCCEEDED
    assert retained.result_status == "available"
    assert service.get_result(human(), operation.id).result == ExampleResult(
        value="input"
    )

    released = await service.release_result(human(), operation.id)
    assert released.disposition == "released"
    assert released.snapshot.result_status == "released"
    assert service.get_result(human(), operation.id).status == "released"
    duplicate = await service.release_result(human(), operation.id)
    assert duplicate.disposition == "already_released"

    service.prune()
    with pytest.raises(OperationNotFound):
        service.get(human(), operation.id)
    await service.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("transition", ["release", "prune"])
async def test_result_read_remains_consistent_during_release_or_pruning(
    store, monkeypatch, transition
):
    now = [100.0]

    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        if value.value == "fail":
            raise OperationExecutionError("EXPECTED_FAILURE", "Expected test failure")
        return ExampleResult(value=value.value)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
        clock=lambda: now[0],
        max_terminal_history=1,
    )
    read_entered = threading.Event()
    transition_started = threading.Event()
    transition_finished = threading.Event()
    read_result = store.get_managed_operation_result

    def paused_result_read(operation_id):
        read_entered.set()
        assert transition_started.wait(2)
        transition_finished.wait(0.2)
        return read_result(operation_id)

    try:
        operation = await service.start(human(), submission("concurrent-result"))
        await eventually_state(service, human(), operation.id, OperationState.SUCCEEDED)
        if transition == "prune":
            now[0] += 1
            newer = await service.start(human(), submission("newer-failure", "fail"))
            await eventually_state(service, human(), newer.id, OperationState.FAILED)
            await service.release_result(human(), operation.id)

        monkeypatch.setattr(store, "get_managed_operation_result", paused_result_read)
        reading = asyncio.create_task(
            asyncio.to_thread(service.get_result, human(), operation.id)
        )
        assert await asyncio.to_thread(read_entered.wait, 2)
        transition_started.set()
        try:
            if transition == "release":
                released = await service.release_result(human(), operation.id)
                assert released.disposition == "released"
            else:
                assert service.prune() == (operation.id,)
        finally:
            transition_finished.set()
        result = await reading
        if transition == "release":
            assert result.status == "available"
            assert result.result == ExampleResult(value="input")
            assert service.get_result(human(), operation.id).status == "released"
        else:
            assert result.status == "released"
            with pytest.raises(OperationNotFound):
                service.get_result(human(), operation.id)
    finally:
        transition_started.set()
        transition_finished.set()
        await service.aclose()


@pytest.mark.asyncio
async def test_storage_budget_reserves_before_execution_and_duplicate_does_not_reserve_twice(
    store,
):
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return ExampleResult(value=value.value)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
        max_result_bytes=32,
        max_retained_result_bytes=32,
    )
    first = await service.start(human(), submission("first", "first"))
    await entered.wait()
    assert store.get_managed_operation(first.id)["result_reservation_bytes"] == 32

    duplicate = await service.start(human(), submission("first", "first"))
    assert duplicate.id == first.id
    assert store.managed_operation_storage_usage() == {
        "retained_bytes": 0,
        "reserved_bytes": 32,
        "retained_count": 0,
        "reserved_count": 1,
    }

    with pytest.raises(OperationResultStorageFull):
        await service.start(human(), submission("blocked", "blocked"))
    assert calls == 1
    assert (
        store.get_managed_operation_by_submission(
            runtime_scope="runtime-a",
            scope_id="workspace-a",
            actor_kind="human",
            actor_id="human-a",
            submission_key="blocked",
        )
        is None
    )

    release.set()
    await eventually_state(service, human(), first.id, OperationState.SUCCEEDED)
    usage = store.managed_operation_storage_usage()
    assert usage["reserved_bytes"] == 0
    assert 0 < usage["retained_bytes"] <= 32
    with pytest.raises(OperationResultStorageFull):
        await service.start(human(), submission("still-blocked", "second"))

    assert (await service.release_result(human(), first.id)).disposition == "released"
    second = await service.start(human(), submission("second", "second"))
    await eventually_state(service, human(), second.id, OperationState.SUCCEEDED)
    await service.aclose()


@pytest.mark.asyncio
async def test_database_wide_reservation_is_atomic_across_runtime_owners(store):
    entered = asyncio.Event()
    release = asyncio.Event()

    async def first_executor(
        value: ExampleInput, _cancel: threading.Event
    ) -> ExampleResult:
        entered.set()
        await release.wait()
        return ExampleResult(value=value.value)

    async def second_executor(
        value: ExampleInput, _cancel: threading.Event
    ) -> ExampleResult:
        entered.set()
        await release.wait()
        return ExampleResult(value=value.value)

    second_store = ControlPlaneStore(store.db_path)
    second_store.initialize()
    first = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=first_executor,
        max_result_bytes=32,
        max_retained_result_bytes=32,
    )
    second = ManagedOperationService(
        store=second_store,
        runtime_scope="runtime-b",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=second_executor,
        max_result_bytes=32,
        max_retained_result_bytes=32,
    )
    try:
        outcomes = await asyncio.gather(
            first.start(human(), submission("first", "first")),
            second.start(human(), submission("second", "second")),
            return_exceptions=True,
        )
        admitted = [value for value in outcomes if not isinstance(value, BaseException)]
        refused = [value for value in outcomes if isinstance(value, BaseException)]
        assert len(admitted) == 1
        assert len(refused) == 1
        assert isinstance(refused[0], OperationResultStorageFull)
        operation = admitted[0]
        winner = first if outcomes[0] is operation else second
        loser = second if winner is first else first
        await entered.wait()
        release.set()
        await eventually_state(winner, human(), operation.id, OperationState.SUCCEEDED)
        await winner.release_result(human(), operation.id)
        retry = await loser.start(human(), submission("retry", "retry"))
        await eventually_state(loser, human(), retry.id, OperationState.SUCCEEDED)
    finally:
        release.set()
        await first.aclose()
        await second.aclose()
        second_store.close()


@pytest.mark.asyncio
async def test_oversized_result_fails_and_releases_reservation(store):
    async def execute(_value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        return ExampleResult(value="x" * 100)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
        max_result_bytes=32,
        max_retained_result_bytes=32,
    )
    operation = await service.start(human(), submission("oversized"))
    await eventually_state(service, human(), operation.id, OperationState.FAILED)
    assert service.get(human(), operation.id).error.code == "RESULT_TOO_LARGE"
    assert store.get_managed_operation(operation.id)["result_reservation_bytes"] == 0
    assert store.managed_operation_storage_usage() == {
        "retained_bytes": 0,
        "reserved_bytes": 0,
        "retained_count": 0,
        "reserved_count": 0,
    }
    await service.aclose()


@pytest.mark.asyncio
async def test_retained_result_count_bounds_tiny_results(store):
    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        return ExampleResult(value=value.value)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
        max_result_bytes=32,
        max_retained_result_bytes=1_024,
        max_retained_results=1,
    )
    first = await service.start(human(), submission("first", ""))
    await eventually_state(service, human(), first.id, OperationState.SUCCEEDED)
    with pytest.raises(OperationResultStorageFull):
        await service.start(human(), submission("second", ""))
    await service.release_result(human(), first.id)
    second = await service.start(human(), submission("second", ""))
    await eventually_state(service, human(), second.id, OperationState.SUCCEEDED)
    await service.aclose()


@pytest.mark.asyncio
async def test_list_page_reports_a_truthful_total_and_continuation(store):
    release = asyncio.Event()

    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        await release.wait()
        return ExampleResult(value=value.value)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
    )
    operations = [
        await service.start(human(), submission(f"page-{index}", str(index)))
        for index in range(3)
    ]

    first = service.list_page(human(), scope_id="workspace-a", limit=2)
    assert first.total == 3
    assert first.next_offset == 2
    assert [item.id for item in first.operations] == [
        operations[2].id,
        operations[1].id,
    ]

    final = service.list_page(human(), scope_id="workspace-a", limit=2, offset=2)
    assert final.total == 3
    assert final.next_offset is None
    assert [item.id for item in final.operations] == [operations[0].id]

    exact = service.list_page(human(), scope_id="workspace-a", limit=3)
    assert exact.total == 3
    assert exact.next_offset is None

    release.set()
    await service.aclose()


@pytest.mark.asyncio
async def test_subscription_initial_contains_more_than_the_old_default_page(store):
    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        return ExampleResult(value=value.value)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
        max_result_bytes=64,
        max_retained_result_bytes=64 * 200,
    )
    for index in range(105):
        operation = await service.start(
            human(), submission(f"initial-{index}", str(index))
        )
        await eventually_state(service, human(), operation.id, OperationState.SUCCEEDED)

    subscription = await service.subscribe(human(), scope_id="workspace-a")
    assert len(subscription.initial) == 105
    assert subscription.operation_count == 105
    assert subscription.active_count == 0
    assert subscription.terminal_count == 105
    assert subscription.history_complete is True

    subscription.close()
    await service.aclose()


@pytest.mark.asyncio
async def test_subscription_never_drops_active_rows_when_legacy_history_exceeds_bound(
    store,
):
    release = asyncio.Event()

    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        await release.wait()
        return ExampleResult(value=value.value)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
        max_result_bytes=64,
        max_retained_result_bytes=64,
        max_retained_results=1,
        max_terminal_history=1,
    )
    active = await service.start(human(), submission("active", "active"))
    for index in range(3):
        operation_id = store.insert_managed_operation(
            runtime_scope="runtime-a",
            scope_id="workspace-a",
            kind="annotation",
            subject_id=f"legacy-{index}",
            input_revision=f"revision-{index}",
            submission_key=f"legacy-{index}",
            submission_payload_hash=f"payload-{index}",
            actor_kind="human",
            actor_id="human-a",
            channel="desktop_ui",
            cancellation_mode="queued_only",
            owner_instance_id=service.owner_instance_id,
            now=float(index),
        )
        store.put_managed_operation_result(
            operation_id,
            payload={"value": str(index)},
            size_bytes=len(json.dumps({"value": str(index)}).encode()),
        )
        store.transition_managed_operation(
            operation_id,
            expected_states={"queued"},
            state="succeeded",
            owner_instance_id=service.owner_instance_id,
            now=float(index),
            result_status="available",
            mark_settled=True,
        )

    subscription = await service.subscribe(human(), scope_id="workspace-a")
    assert active.id in {item.id for item in subscription.initial}
    assert subscription.operation_count == 4
    assert subscription.active_count == 1
    assert subscription.terminal_count == 3
    assert subscription.history_complete is False
    assert len(subscription.initial) == 3

    subscription.close()
    release.set()
    await service.aclose()


@pytest.mark.asyncio
async def test_subscription_snapshot_events_carry_exact_live_collection_counts(store):
    release = asyncio.Event()

    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        await release.wait()
        return ExampleResult(value=value.value)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
        subscriber_queue_size=8,
    )
    subscription = await service.subscribe(human(), scope_id="workspace-a")
    assert subscription.operation_count == 0

    operation = await service.start(human(), submission("counted", "counted"))
    queued = await asyncio.wait_for(subscription.get(), timeout=1)
    assert queued.kind == "snapshot"
    assert queued.snapshot.id == operation.id
    assert queued.operation_count == 1
    assert queued.active_count == 1
    assert queued.terminal_count == 0
    assert queued.history_complete is True

    release.set()
    terminal_event = None
    for _ in range(3):
        event = await asyncio.wait_for(subscription.get(), timeout=1)
        if (
            event.snapshot is not None
            and event.snapshot.state == OperationState.SUCCEEDED
        ):
            terminal_event = event
            break
    assert terminal_event is not None
    assert terminal_event.operation_count == 1
    assert terminal_event.active_count == 0
    assert terminal_event.terminal_count == 1
    assert terminal_event.history_complete is True

    subscription.close()
    await service.aclose()


@pytest.mark.asyncio
async def test_metadata_pruning_requires_subscriber_resync(store):
    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        return ExampleResult(value=value.value)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
        max_terminal_history=1,
    )
    subscription = await service.subscribe(human(), scope_id="workspace-a")
    for index in range(2):
        operation_id = store.insert_managed_operation(
            runtime_scope="runtime-a",
            scope_id="workspace-a",
            kind="annotation",
            subject_id=f"terminal-{index}",
            input_revision=f"revision-{index}",
            submission_key=f"terminal-{index}",
            submission_payload_hash=f"payload-{index}",
            actor_kind="human",
            actor_id="human-a",
            channel="desktop_ui",
            cancellation_mode="queued_only",
            owner_instance_id=service.owner_instance_id,
            now=float(index),
        )
        store.transition_managed_operation(
            operation_id,
            expected_states={"queued"},
            state="failed",
            owner_instance_id=service.owner_instance_id,
            now=float(index),
            mark_settled=True,
        )

    assert len(service.prune()) == 1
    event = await asyncio.wait_for(subscription.get(), timeout=1)
    assert event.kind == "resync_required"
    subscription.close()
    await service.aclose()


def test_legacy_expiring_result_schema_migrates_without_deleting_payload(tmp_path):
    path = tmp_path / "legacy.sqlite3"
    connection = sqlite3.connect(path)
    connection.executescript("""
        CREATE TABLE managed_operation (
          id TEXT PRIMARY KEY,
          runtime_scope TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          input_revision TEXT NOT NULL,
          submission_key TEXT NOT NULL,
          submission_payload_hash TEXT NOT NULL,
          actor_kind TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          cancellation_mode TEXT NOT NULL,
          owner_instance_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          state TEXT NOT NULL,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          started_at REAL,
          settled_at REAL,
          cancel_requested_at REAL,
          result_expires_at REAL,
          history_expires_at REAL,
          error_json TEXT,
          UNIQUE(runtime_scope, scope_id, actor_kind, actor_id, submission_key)
        );
        CREATE TABLE managed_operation_result (
          operation_id TEXT PRIMARY KEY REFERENCES managed_operation(id) ON DELETE CASCADE,
          payload_json TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          expires_at REAL NOT NULL
        );
        CREATE INDEX managed_operation_result_expiry
          ON managed_operation_result(expires_at);
    """)
    connection.execute("""
        INSERT INTO managed_operation (
          id, runtime_scope, scope_id, kind, subject_id, input_revision,
          submission_key, submission_payload_hash, actor_kind, actor_id,
          channel, cancellation_mode, owner_instance_id, version, state,
          created_at, updated_at, settled_at, result_expires_at, history_expires_at
        ) VALUES (
          'operation-a', 'runtime-a', 'workspace-a', 'annotation', 'sequence-a',
          'sha256:a', 'submission-a', 'payload-a', 'human', 'human-a',
          'desktop_ui', 'queued_only', 'owner-a', 2, 'succeeded', 1, 2, 2, 3, 4
        )
        """)
    payload = json.dumps({"value": "retained"})
    connection.execute(
        "INSERT INTO managed_operation_result VALUES (?, ?, ?, ?)",
        ("operation-a", payload, len(payload.encode()), 3.0),
    )
    connection.commit()
    connection.close()

    store = ControlPlaneStore(path)
    try:
        store.initialize()
        result_columns = {
            row["name"]
            for row in store._conn.execute(
                "PRAGMA table_info(managed_operation_result)"
            ).fetchall()
        }
        assert result_columns == {
            "operation_id",
            "payload_json",
            "size_bytes",
            "result_schema_version",
        }
        operation = store.get_managed_operation("operation-a")
        assert operation["kind_contract_version"] == 1
        assert operation["result_status"] == "available"
        assert operation["origin"] == "managed"
        assert operation["reported_run_id"] is None
        assert operation["provenance_json"] is None
        migrated_submission = store.get_managed_operation_by_submission(
            runtime_scope="runtime-a",
            scope_id="workspace-a",
            actor_kind="human",
            actor_id="human-a",
            submission_key="submission-a",
        )
        assert migrated_submission["id"] == "operation-a"
        assert migrated_submission["matched_submission_payload_hash"] == "payload-a"
        assert store.get_managed_operation_result("operation-a")["payload_json"] == {
            "value": "retained"
        }
        assert (
            store.get_managed_operation_result("operation-a")["result_schema_version"]
            == 1
        )
        recorded_index = store._conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'index' "
            "AND name = 'managed_operation_recorded_run'"
        ).fetchone()
        assert recorded_index is not None
        assert "WHERE origin = 'recorded'" in recorded_index["sql"]
    finally:
        store.close()


def _insert_action_cap_fixture(store: ControlPlaneStore) -> str:
    operation_id = store.insert_managed_operation(
        runtime_scope="runtime-a",
        scope_id="workspace-a",
        kind="annotation",
        subject_id="sequence-a",
        input_revision="sha256:a",
        submission_key="submission-a",
        submission_payload_hash="payload-a",
        actor_kind="human",
        actor_id="human-a",
        channel="desktop_ui",
        owner_instance_id="owner-a",
        now=1.0,
    )
    store.insert_managed_operation_action(
        operation_id=operation_id,
        action="submit",
        actor_kind="human",
        actor_id="human-a",
        channel="desktop_ui",
        outcome="accepted",
        recorded_at=1.0,
        action_id="creator",
    )
    return operation_id


def test_managed_action_history_preserves_creator_and_newest_255_across_restart(
    tmp_path,
):
    path = tmp_path / "action-cap.sqlite3"
    store = ControlPlaneStore(path)
    store.initialize()
    operation_id = _insert_action_cap_fixture(store)
    for index in range(300):
        store.insert_managed_operation_action(
            operation_id=operation_id,
            action="request_cancel",
            actor_kind="human",
            actor_id=f"actor-{index}",
            channel="desktop_ui",
            outcome=f"outcome-{index}",
            recorded_at=float(index + 2),
            action_id=f"control-{index:04d}",
        )

    first, total, next_offset, omitted_count = store.page_managed_operation_actions(
        operation_id,
        limit=200,
    )
    second, second_total, second_next, second_omitted = (
        store.page_managed_operation_actions(
            operation_id,
            limit=200,
            offset=200,
        )
    )
    assert total == second_total == 256
    assert omitted_count == second_omitted == 45
    assert next_offset == 200
    assert second_next is None
    retained = first + second
    assert retained[0]["id"] == "creator"
    assert [row["id"] for row in retained[1:]] == [
        f"control-{index:04d}" for index in range(45, 300)
    ]
    store.close()

    restarted = ControlPlaneStore(path)
    try:
        restarted.initialize()
        _rows, restarted_total, _next, restarted_omitted = (
            restarted.page_managed_operation_actions(operation_id, limit=1)
        )
        assert restarted_total == 256
        assert restarted_omitted == 45
    finally:
        restarted.close()


@pytest.mark.parametrize(
    ("outcome", "actor_kind", "channel"),
    [
        ("document_admitted", "human", "managed_cli"),
        ("document_writing", "human", "desktop_ui"),
        ("document_outcome_unresolved", "agent", "agent"),
    ],
)
def test_unresolved_document_action_survives_history_compaction_and_restart(
    tmp_path, outcome, actor_kind, channel
):
    path = tmp_path / "pending-document-action.sqlite3"
    store = ControlPlaneStore(path)
    store.initialize()
    operation_id = _insert_action_cap_fixture(store)
    store.insert_managed_operation_action(
        operation_id=operation_id,
        action="apply_annotations",
        actor_kind=actor_kind,
        actor_id="actual-actor",
        channel=channel,
        outcome=outcome,
        recorded_at=2.0,
        action_id="pending-document",
        details={"native_owner_instance_id": "native-owner-a"},
    )
    for index in range(300):
        store.insert_managed_operation_action(
            operation_id=operation_id,
            action="inspect_annotations",
            actor_kind="agent",
            actor_id="agent-a",
            channel="agent",
            outcome="inspected",
            recorded_at=float(index + 3),
            action_id=f"inspection-{index:04d}",
        )
    rows, total, _, omitted = store.page_managed_operation_actions(operation_id)
    assert total == 257
    assert omitted == 45
    assert rows[0]["id"] == "creator"
    assert rows[1]["id"] == "pending-document"
    store.close()
    restarted = ControlPlaneStore(path)
    try:
        restarted.initialize()
        retained, count, _, omitted = restarted.page_managed_operation_actions(
            operation_id
        )
        assert count == 257
        assert omitted == 45
        assert retained[1]["outcome"] == outcome
        assert retained[1]["actor_kind"] == actor_kind
        assert retained[1]["actor_id"] == "actual-actor"
        assert retained[1]["channel"] == channel
        assert (
            retained[1]["details_json"]["native_owner_instance_id"] == "native-owner-a"
        )
    finally:
        restarted.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "outcome", ["document_admitted", "document_writing", "document_outcome_unresolved"]
)
async def test_pending_document_write_keeps_its_retained_result(store, outcome):
    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        return ExampleResult(value=value.value)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
    )
    try:
        operation = await service.start(human(), submission("document-result-pin"))
        await eventually_state(service, human(), operation.id, OperationState.SUCCEEDED)
        before = service.get_result(human(), operation.id)
        store.insert_managed_operation_action(
            operation_id=operation.id,
            action="apply_annotations",
            actor_kind="human",
            actor_id="human-a",
            channel="managed_cli",
            outcome=outcome,
            recorded_at=2.0,
            action_id="pending-document",
            details={"native_owner_instance_id": "native-owner-a"},
        )
        release = await service.release_result(human(), operation.id)
        assert release.disposition == "unavailable"
        assert "document write" in release.reason
        assert service.get_result(human(), operation.id) == before
        assert service.get(human(), operation.id).result_status == "available"
    finally:
        await service.aclose()


def test_prior_managed_action_schema_is_compacted_and_records_omissions(tmp_path):
    path = tmp_path / "legacy-action-cap.sqlite3"
    store = ControlPlaneStore(path)
    store.initialize()
    operation_id = _insert_action_cap_fixture(store)
    store._conn.executemany(
        """
        INSERT INTO managed_operation_action (
          id, operation_id, action, actor_kind, actor_id, channel,
          outcome, details_json, recorded_at
        ) VALUES (?, ?, 'request_cancel', 'human', 'human-a',
                  'desktop_ui', ?, '{}', ?)
        """,
        [
            (
                f"legacy-control-{index:04d}",
                operation_id,
                f"outcome-{index}",
                float(index + 2),
            )
            for index in range(260)
        ],
    )
    store._conn.commit()
    store.close()

    connection = sqlite3.connect(path)
    connection.execute("ALTER TABLE managed_operation DROP COLUMN action_omitted_count")
    connection.commit()
    connection.close()

    migrated = ControlPlaneStore(path)
    try:
        migrated.initialize()
        first, total, next_offset, omitted_count = (
            migrated.page_managed_operation_actions(operation_id, limit=1)
        )
        assert first[0]["id"] == "creator"
        assert total == 256
        assert next_offset == 1
        assert omitted_count == 5
        retained_ids = {
            row["id"]
            for row in migrated._conn.execute(
                "SELECT id FROM managed_operation_action WHERE operation_id = ?",
                (operation_id,),
            ).fetchall()
        }
        assert "legacy-control-0004" not in retained_ids
        assert "legacy-control-0005" in retained_ids
        assert "legacy-control-0259" in retained_ids
    finally:
        migrated.close()


@pytest.mark.asyncio
async def test_subscription_has_race_free_initial_state_and_explicit_overflow(store):
    release = asyncio.Event()

    async def execute(value: ExampleInput, _cancel: threading.Event) -> ExampleResult:
        await release.wait()
        return ExampleResult(value=value.value)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind=OperationKind.ANNOTATION,
        input_model=ExampleInput,
        result_model=ExampleResult,
        executor=execute,
        cancellation_mode=CancellationMode.COOPERATIVE,
        subscriber_queue_size=1,
    )
    operation = await service.start(human(), submission("stream"))
    subscription = await service.subscribe(human(), scope_id="workspace-a")
    assert [item.id for item in subscription.initial] == [operation.id]

    await eventually_state(service, human(), operation.id, OperationState.RUNNING)
    await service.request_cancel(human(), operation.id)
    event = await asyncio.wait_for(subscription.get(), timeout=1)
    assert event.kind == "resync_required"

    release.set()
    await eventually_state(service, human(), operation.id, OperationState.SUCCEEDED)
    subscription.close()
    await service.aclose()


@pytest.mark.asyncio
async def test_two_typed_kinds_share_one_owner_slot_and_decode_their_own_results(store):
    first_entered = asyncio.Event()
    release_first = asyncio.Event()
    second_entered = asyncio.Event()
    in_flight = 0
    maximum_in_flight = 0

    async def execute_first(
        value: ExampleInput, _cancel: threading.Event
    ) -> ExampleResult:
        nonlocal in_flight, maximum_in_flight
        in_flight += 1
        maximum_in_flight = max(maximum_in_flight, in_flight)
        first_entered.set()
        try:
            await release_first.wait()
            return ExampleResult(value=value.value.upper())
        finally:
            in_flight -= 1

    async def execute_second(
        value: AlternateInput, _cancel: threading.Event
    ) -> AlternateResult:
        nonlocal in_flight, maximum_in_flight
        in_flight += 1
        maximum_in_flight = max(maximum_in_flight, in_flight)
        second_entered.set()
        try:
            return AlternateResult(doubled=value.count * 2)
        finally:
            in_flight -= 1

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        adapters=(
            ManagedOperationKindAdapter(
                kind="test-text",
                title="Test text",
                input_model=ExampleInput,
                result_model=ExampleResult,
                executor=execute_first,
            ),
            ManagedOperationKindAdapter(
                kind="test-count",
                title="Test count",
                input_model=AlternateInput,
                result_model=AlternateResult,
                executor=execute_second,
            ),
        ),
        max_pending=1,
    )

    first = await service.start(
        human(), submission("text-a", "hello"), kind="test-text"
    )
    await first_entered.wait()
    second = await service.start(
        human(), alternate_submission("count-a", 7), kind="test-count"
    )
    assert not second_entered.is_set()
    assert (
        service.owner_instance_id == first.owner_instance_id == second.owner_instance_id
    )

    subscription = await service.subscribe(human(), scope_id="workspace-a")
    assert {item.kind for item in subscription.initial} == {"test-text", "test-count"}
    assert subscription.operation_count == 2
    assert subscription.active_count == 2

    release_first.set()
    await eventually_state(service, human(), first.id, OperationState.SUCCEEDED)
    await eventually_state(service, human(), second.id, OperationState.SUCCEEDED)

    first_result = service.get_result(human(), first.id)
    second_result = service.get_result(human(), second.id)
    assert first_result.result == ExampleResult(value="HELLO")
    assert second_result.result == AlternateResult(doubled=14)
    assert maximum_in_flight == 1
    subscription.close()
    await service.aclose()


@pytest.mark.asyncio
async def test_kind_start_authority_and_submission_keys_are_runtime_global(store):
    calls: list[str] = []

    async def execute_text(
        value: ExampleInput, _cancel: threading.Event
    ) -> ExampleResult:
        calls.append("text")
        return ExampleResult(value=value.value)

    async def execute_count(
        value: AlternateInput, _cancel: threading.Event
    ) -> AlternateResult:
        calls.append("count")
        return AlternateResult(doubled=value.count * 2)

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        adapters=(
            ManagedOperationKindAdapter(
                kind="test-text",
                title="Test text",
                input_model=ExampleInput,
                result_model=ExampleResult,
                executor=execute_text,
                required_start_capabilities=frozenset({"science.test-text"}),
            ),
            ManagedOperationKindAdapter(
                kind="test-count",
                title="Test count",
                input_model=AlternateInput,
                result_model=AlternateResult,
                executor=execute_count,
            ),
        ),
    )
    denied = agent(capabilities={"operations.start"})
    with pytest.raises(OperationAccessDenied):
        await service.start(denied, submission("shared-key"), kind="test-text")

    allowed = agent(
        capabilities={"operations.start", "operations.read", "science.test-text"}
    )
    started = await service.start(allowed, submission("shared-key"), kind="test-text")
    await eventually_state(service, allowed, started.id, OperationState.SUCCEEDED)

    with pytest.raises(SubmissionConflict):
        await service.start(
            allowed,
            alternate_submission("shared-key"),
            kind="test-count",
        )
    assert calls == ["text"]
    await service.aclose()


@pytest.mark.asyncio
async def test_known_start_disabled_kind_keeps_historical_result_readable(store):
    async def execute_count(
        value: AlternateInput, _cancel: threading.Event
    ) -> AlternateResult:
        return AlternateResult(doubled=value.count * 2)

    enabled = ManagedOperationKindAdapter(
        kind="test-count",
        title="Test count",
        input_model=AlternateInput,
        result_model=AlternateResult,
        executor=execute_count,
        contract_version=3,
        result_schema_version=1,
    )
    first = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        adapters=(enabled,),
    )
    operation = await first.start(
        human(), alternate_submission("historical", 11), kind="test-count"
    )
    await eventually_state(first, human(), operation.id, OperationState.SUCCEEDED)
    assert operation.kind_contract_version == 3
    assert (
        store.get_managed_operation_result(operation.id)["result_schema_version"] == 1
    )
    await first.aclose()

    decoded_versions: list[int] = []

    def decode_version_one(payload):
        decoded_versions.append(1)
        return AlternateResult.model_validate(payload)

    replacement = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        adapters=(
            ManagedOperationKindAdapter(
                kind="test-count",
                title="Test count",
                input_model=AlternateInput,
                result_model=AlternateResult,
                executor=None,
                start_enabled=False,
                contract_version=4,
                result_schema_version=2,
                result_decoders={
                    1: decode_version_one,
                    2: AlternateResult.model_validate,
                },
            ),
        ),
    )
    historical_result = replacement.get_result(human(), operation.id)
    assert historical_result.result == AlternateResult(doubled=22)
    assert historical_result.kind == "test-count"
    assert historical_result.result_schema_version == 2
    assert decoded_versions == [1]
    assert replacement.kind_descriptors()[0].actions == (
        "list",
        "get",
        "result",
        "actions",
        "release_result",
    )

    store._conn.execute(
        "UPDATE managed_operation_result SET result_schema_version = 99 WHERE operation_id = ?",
        (operation.id,),
    )
    store._conn.commit()
    unsupported = replacement.get_result(human(), operation.id)
    assert unsupported.status == "unavailable"
    assert unsupported.result is None
    assert unsupported.error is not None
    assert unsupported.error.code == "UNSUPPORTED_OPERATION_RESULT_VERSION"
    with pytest.raises(OperationKindUnavailable):
        await replacement.start(
            human(), alternate_submission("disabled", 3), kind="test-count"
        )
    await replacement.aclose()


def test_restart_reconciles_active_rows_for_every_registered_kind(store):
    store.claim_managed_operation_owner("runtime-a", "dead-owner")
    operation_ids = []
    for kind in ("test-text", "test-count"):
        operation_ids.append(
            store.insert_managed_operation(
                runtime_scope="runtime-a",
                scope_id="workspace-a",
                kind=kind,
                subject_id=f"subject-{kind}",
                input_revision=f"sha256:{kind}",
                submission_key=f"submission-{kind}",
                submission_payload_hash=f"payload-{kind}",
                actor_kind="human",
                actor_id="human-a",
                channel="desktop_ui",
                owner_instance_id="dead-owner",
                now=1.0,
                result_reservation_bytes=64,
            )
        )

    replacement = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        adapters=(
            ManagedOperationKindAdapter(
                kind="test-text",
                title="Test text",
                input_model=ExampleInput,
                result_model=ExampleResult,
                executor=None,
                start_enabled=False,
            ),
            ManagedOperationKindAdapter(
                kind="test-count",
                title="Test count",
                input_model=AlternateInput,
                result_model=AlternateResult,
                executor=None,
                start_enabled=False,
            ),
        ),
    )
    assert {
        replacement.get(human(), operation_id).state for operation_id in operation_ids
    } == {OperationState.INTERRUPTED}
    assert all(
        store.get_managed_operation(operation_id)["result_reservation_bytes"] == 0
        for operation_id in operation_ids
    )
    asyncio.run(replacement.aclose())
