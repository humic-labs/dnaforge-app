from __future__ import annotations

import asyncio

import pytest
from pydantic import BaseModel

from src.control_plane import ControlPlaneStore
from src.operations import (
    ActorKind,
    CancellationMode,
    ClientChannel,
    ManagedOperationService,
    ManagedOperationSubmission,
    OperationCanceled,
    OperationPrincipal,
    OperationResultStorageFull,
    OperationState,
    OperationSubject,
)


class Value(BaseModel):
    value: str


SOURCE = {
    "workspace_id": "11111111-1111-4111-8111-111111111111",
    "version_id": "22222222-2222-4222-8222-222222222222",
    "manifest_sha256": "a" * 64,
    "files": [
        {
            "key": "reference",
            "resource_id": "33333333-3333-4333-8333-333333333333",
            "path": "sequences/reference.gb",
            "content_sha256": "b" * 64,
            "size_bytes": 20,
        }
    ],
}
PRINCIPAL = OperationPrincipal(
    actor_kind=ActorKind.HUMAN,
    actor_id="44444444-4444-4444-8444-444444444444",
    channel=ClientChannel.HOSTED_BROWSER,
    scope_ids={SOURCE["workspace_id"]},
)


def submission(key="first"):
    return ManagedOperationSubmission[Value](
        submission_key=key,
        subject=OperationSubject(
            scope_id=SOURCE["workspace_id"],
            subject_id=key,
            input_revision="sha256:" + "c" * 64,
            accepted_workspace_input=SOURCE,
        ),
        input=Value(value=key),
    )


class Retainer:
    def __init__(self):
        self.held = {}
        self.retains = []
        self.releases = []
        self.fail_retain = False
        self.fail_release = False

    async def retain(self, reference):
        self.retains.append(reference)
        self.held[reference.operation_id] = reference
        if self.fail_retain:
            raise ConnectionError("retain response lost")

    async def release(self, reference):
        self.releases.append(reference)
        if self.fail_release:
            raise ConnectionError("release unavailable")
        self.held.pop(reference.operation_id, None)


def service(store, retainer, executor, **kwargs):
    return ManagedOperationService(
        store=store,
        runtime_scope="retention-test",
        kind="retention-test",
        input_model=Value,
        result_model=Value,
        executor=executor,
        input_retainer=retainer,
        **kwargs,
    )


async def settled(owner, operation_id):
    for _ in range(100):
        snapshot = owner.get(PRINCIPAL, operation_id)
        if snapshot.state not in {OperationState.QUEUED, OperationState.RUNNING}:
            return snapshot
        await asyncio.sleep(0.005)
    pytest.fail("operation did not settle")


@pytest.fixture
def store(tmp_path):
    value = ControlPlaneStore(tmp_path / "operations.sqlite3")
    value.initialize()
    yield value
    value.close()


@pytest.mark.asyncio
async def test_pins_before_execution_replays_once_and_keeps_input_until_release(store):
    retainer = Retainer()

    async def execute(value, _cancel):
        assert len(retainer.held) == 1
        reference = next(iter(retainer.held.values()))
        assert reference.version_id == SOURCE["version_id"]
        assert reference.manifest_sha256 == SOURCE["manifest_sha256"]
        assert reference.account_id == PRINCIPAL.actor_id
        return value

    owner = service(store, retainer, execute)
    try:
        first = await owner.start(PRINCIPAL, submission())
        assert (await owner.start(PRINCIPAL, submission())).id == first.id
        completed = await settled(owner, first.id)
        assert completed.state == OperationState.SUCCEEDED, completed.error
        assert len(retainer.retains) == 1
        await owner.reconcile_input_retention()
        assert first.id in retainer.held
        assert owner.get_result(PRINCIPAL, first.id).result.value == "first"
        await owner.release_result(PRINCIPAL, first.id)
        await owner.reconcile_input_retention()
        assert not retainer.held
        assert (
            store.get_managed_operation(first.id)["input_retention_state"] == "released"
        )
    finally:
        await owner.aclose()


@pytest.mark.asyncio
async def test_ambiguous_acquisition_never_runs_and_pending_release_survives_pruning_restart(
    store,
):
    retainer = Retainer()
    retainer.fail_retain = retainer.fail_release = True
    executions = []

    async def execute(value, _cancel):
        executions.append(value)
        return value

    owner = service(store, retainer, execute, max_terminal_history=1)
    try:
        first = await owner.start(PRINCIPAL, submission())
        second = await owner.start(PRINCIPAL, submission("second"))
        assert first.state == second.state == OperationState.FAILED
        assert first.error.code == "INPUT_RETENTION_UNAVAILABLE"
        assert not executions
        assert set(retainer.held) == {first.id, second.id}
        owner.prune()
        assert store.get_managed_operation(first.id) is not None
        assert store.get_managed_operation(second.id) is not None
    finally:
        await owner.aclose()
    retainer.fail_release = False
    replacement = service(store, retainer, execute, max_terminal_history=1)
    try:
        await replacement.reconcile_input_retention()
        assert not retainer.held
        replacement.prune()
        assert (
            sum(
                store.get_managed_operation(op.id) is not None for op in (first, second)
            )
            == 1
        )
    finally:
        await replacement.aclose()


@pytest.mark.asyncio
async def test_existing_retained_result_gets_reference_on_upgrade_and_keeps_it_on_restart(
    store,
):
    async def execute(value, _cancel):
        return value

    legacy = service(store, None, execute)
    first = await legacy.start(PRINCIPAL, submission())
    await settled(legacy, first.id)
    await legacy.aclose()
    retainer = Retainer()
    upgraded = service(store, retainer, execute)
    await upgraded.reconcile_input_retention()
    assert first.id in retainer.held
    await upgraded.aclose()
    restarted = service(store, retainer, execute)
    try:
        await restarted.reconcile_input_retention()
        assert first.id in retainer.held
        assert len(retainer.retains) == 1
        assert restarted.get_result(PRINCIPAL, first.id).result.value == "first"
    finally:
        await restarted.aclose()


@pytest.mark.asyncio
async def test_running_cancellation_keeps_input_until_executor_settles(store):
    retainer = Retainer()
    entered = asyncio.Event()
    settle = asyncio.Event()

    async def execute(_value, cancel):
        entered.set()
        await settle.wait()
        assert cancel.is_set()
        assert retainer.held
        raise OperationCanceled("controlled cancellation")

    owner = service(
        store, retainer, execute, cancellation_mode=CancellationMode.COOPERATIVE
    )
    try:
        first = await owner.start(PRINCIPAL, submission())
        await entered.wait()
        await owner.request_cancel(PRINCIPAL, first.id)
        await owner.reconcile_input_retention()
        assert first.id in retainer.held
        settle.set()
        for _ in range(100):
            if owner.get(PRINCIPAL, first.id).state == OperationState.CANCELED:
                break
            await asyncio.sleep(0.005)
        assert owner.get(PRINCIPAL, first.id).state == OperationState.CANCELED
        await owner.reconcile_input_retention()
        assert not retainer.held
    finally:
        settle.set()
        await owner.aclose()


@pytest.mark.asyncio
async def test_pending_release_consumes_admission_capacity_until_acknowledged(store):
    retainer = Retainer()
    retainer.fail_retain = retainer.fail_release = True

    async def execute(value, _cancel):
        pytest.fail("failed input retention must never execute")

    owner = service(store, retainer, execute, max_retained_results=1)
    try:
        first = await owner.start(PRINCIPAL, submission())
        assert first.state == OperationState.FAILED
        with pytest.raises(OperationResultStorageFull):
            await owner.start(PRINCIPAL, submission("over-capacity"))
        assert len(retainer.retains) == 1
        retainer.fail_release = False
        await owner.reconcile_input_retention()
        assert not retainer.held
        second = await owner.start(PRINCIPAL, submission("capacity-recovered"))
        assert second.id != first.id
    finally:
        await owner.aclose()


@pytest.mark.asyncio
async def test_restart_interrupts_a_durable_admission_and_releases_ambiguous_pin(store):
    retainer = Retainer()

    async def execute(value, _cancel):
        return value

    owner = service(store, retainer, execute)
    operation_id = store.insert_managed_operation(
        runtime_scope=owner.runtime_scope,
        scope_id=SOURCE["workspace_id"],
        kind="retention-test",
        subject_id="crashed",
        input_revision="revision",
        submission_key="crashed",
        submission_payload_hash="a" * 64,
        actor_kind="human",
        actor_id=PRINCIPAL.actor_id,
        channel="hosted_browser",
        owner_instance_id=owner.owner_instance_id,
        now=1,
        accepted_workspace_input=SOURCE,
        retain_input=True,
    )
    from src.operations.input_retention import OperationInputReference

    await retainer.retain(
        OperationInputReference.from_row(store.get_managed_operation(operation_id))
    )
    owner._lease.release()
    replacement = service(store, retainer, execute)
    try:
        assert (
            replacement.get(PRINCIPAL, operation_id).state == OperationState.INTERRUPTED
        )
        await replacement.reconcile_input_retention()
        assert operation_id not in retainer.held
        assert (
            store.get_managed_operation(operation_id)["input_retention_state"]
            == "released"
        )
    finally:
        await replacement.aclose()


@pytest.mark.asyncio
async def test_missing_legacy_input_fails_backfill_without_releasing_the_retained_result(
    store,
):
    async def execute(value, _cancel):
        return value

    legacy = service(store, None, execute)
    first = await legacy.start(PRINCIPAL, submission())
    await settled(legacy, first.id)
    await legacy.aclose()
    retainer = Retainer()
    retainer.fail_retain = True
    upgraded = service(store, retainer, execute)
    try:
        with pytest.raises(ConnectionError):
            await upgraded.reconcile_input_retention()
        assert upgraded.get_result(PRINCIPAL, first.id).status == "available"
        assert (
            store.get_managed_operation(first.id)["input_retention_state"]
            == "retain_pending"
        )
        assert not retainer.releases
    finally:
        await upgraded.aclose()


@pytest.mark.asyncio
async def test_release_arriving_during_another_release_is_not_stranded(store):
    entered = asyncio.Event()
    finish = asyncio.Event()

    class DelayedRetainer(Retainer):
        async def release(self, reference):
            if not self.releases:
                entered.set()
                await finish.wait()
            await super().release(reference)

    retainer = DelayedRetainer()

    async def execute(value, _cancel):
        return value

    owner = service(store, retainer, execute)
    try:
        first = await owner.start(PRINCIPAL, submission())
        second = await owner.start(PRINCIPAL, submission("second"))
        await settled(owner, first.id)
        await settled(owner, second.id)
        await owner.release_result(PRINCIPAL, first.id)
        await entered.wait()
        await owner.release_result(PRINCIPAL, second.id)
        finish.set()
        for _ in range(100):
            if not retainer.held:
                break
            await asyncio.sleep(0.005)
        assert not retainer.held
    finally:
        finish.set()
        await owner.aclose()
