from __future__ import annotations

import asyncio
import multiprocessing
from pathlib import Path

import pytest
from fastapi import FastAPI

from src import annotation_provisioning as provisioning
from src.annotation.provisioning_lock import AnnotationInstallationLease
from src.annotation_provisioning_contract import (
    AnnotationProvisioningInput,
    AnnotationProvisioningResult,
    AnnotationProvisioningSubmission,
    current_annotation_provisioning_input,
    prepare_annotation_provisioning_submission,
)
from src.control_plane import ControlPlaneStore
from src.managed_operations import MANAGED_OPERATION_SYSTEM
from src.operation_kinds import (
    ANNOTATION_PROVISIONING_OPERATION_KIND,
)
from src.operations import (
    ActorKind,
    CancellationMode,
    ClientChannel,
    InputRevisionMismatch,
    ManagedOperationService,
    OperationExecutionError,
    OperationPrincipal,
    OperationState,
)
from tests.managed_operation_kinds import bind_test_executors


def _human(scope_id: str) -> OperationPrincipal:
    return OperationPrincipal(
        actor_kind=ActorKind.HUMAN,
        actor_id="local-human",
        channel=ClientChannel.DESKTOP_UI,
        scope_ids={scope_id},
    )


def _bindings(provisioning_executor):
    async def unused(_value, _cancel):
        raise AssertionError("an unrelated operation executor must not run")

    return bind_test_executors(
        unused, {ANNOTATION_PROVISIONING_OPERATION_KIND.key: provisioning_executor}
    )


async def _wait_for_state(
    service: ManagedOperationService,
    principal: OperationPrincipal,
    operation_id: str,
    state: OperationState,
) -> None:
    for _ in range(200):
        if service.get(principal, operation_id).state == state:
            return
        await asyncio.sleep(0)
    raise AssertionError(f"operation {operation_id} did not reach {state.value}")


def _lease_child(
    root: str,
    started: multiprocessing.synchronize.Event,
    acquired: multiprocessing.synchronize.Event,
    release: multiprocessing.synchronize.Event,
) -> None:
    lease = AnnotationInstallationLease(Path(root), owner_id="child")
    started.set()
    lease.acquire()
    try:
        acquired.set()
        release.wait(timeout=5)
    finally:
        lease.release()


def test_annotation_provisioning_is_one_compiled_queued_only_kind():
    descriptors = {
        descriptor.kind: descriptor
        for descriptor in MANAGED_OPERATION_SYSTEM.descriptors
    }

    descriptor = descriptors["annotation-provisioning"]
    assert descriptor.title == "Set up annotation"
    assert descriptor.contract_version == 1
    assert descriptor.result_schema_version == 1
    assert descriptor.surfaces.http_start == "/operations/annotation-provisioning"
    assert descriptor.surfaces.cli_submit == (
        "dnaforge jobs submit annotation-provisioning --request FILE|-"
    )
    assert descriptor.surfaces.agent_start == "operations.annotation-provisioning.start"
    assert (
        descriptor.input_schema == AnnotationProvisioningSubmission.model_json_schema()
    )

    adapter = next(
        item
        for item in _bindings(lambda _value, _cancel: None)
        if item.kind == "annotation-provisioning"
    )
    assert adapter.cancellation_mode == CancellationMode.QUEUED_ONLY


@pytest.mark.asyncio
async def test_startup_marks_provisioning_before_operation_admission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    from src.annotation import setup

    observed_during_start: list[bool] = []

    class RecordingService:
        owner_instance_id = "recording-owner"

        def list(self, *_args, **_kwargs):
            return []

        async def start(self, *_args, **_kwargs):
            observed_during_start.append(setup.is_annotation_provisioning())
            return object()

    monkeypatch.setenv("WAYPOINT_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(provisioning, "annotation_provisioning_required", lambda: True)
    setup.set_initial_annotation_provisioning(False)
    app = FastAPI()

    async with provisioning.annotation_provisioning_lifespan(
        app,
        RecordingService(),
        scope_id="runtime-a",
        owner_id="local-human",
    ):
        assert observed_during_start == [True]
        assert setup.is_annotation_provisioning() is True

    assert setup.is_annotation_provisioning() is False


def test_provisioning_submission_derives_installation_identity_and_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("WAYPOINT_DATA_DIR", str(tmp_path))
    current = current_annotation_provisioning_input()
    request = AnnotationProvisioningSubmission(
        submission_key="provisioning-attempt-1",
        scope_id="runtime-a",
    )

    prepared = prepare_annotation_provisioning_submission(request)

    assert prepared.input == current
    assert prepared.subject.scope_id == "runtime-a"
    assert prepared.subject.subject_id.startswith("annotation-installation:sha256:")
    assert prepared.subject.input_revision.startswith(
        "annotation-provisioning-v1:sha256:"
    )
    assert str(tmp_path) not in prepared.model_dump_json()

    forged = request.model_copy(update={"input_revision": "wrong-revision"})
    with pytest.raises(InputRevisionMismatch):
        prepare_annotation_provisioning_submission(forged)


@pytest.mark.asyncio
async def test_startup_and_repeated_retry_join_one_active_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("WAYPOINT_DATA_DIR", str(tmp_path / "application-data"))
    entered = asyncio.Event()
    release = asyncio.Event()
    calls: list[AnnotationProvisioningInput] = []

    async def execute(value, _cancel):
        calls.append(value)
        entered.set()
        await release.wait()
        return AnnotationProvisioningResult(
            installation_revision=value.installation_revision,
            disposition="installed",
            tools_ready=True,
            databases_ready=True,
            rfam_runtime_ready=True,
        )

    monkeypatch.setattr(provisioning, "annotation_provisioning_required", lambda: True)
    store = ControlPlaneStore(tmp_path / "operations.sqlite3")
    store.initialize()
    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        adapters=_bindings(execute),
    )
    coordinator = provisioning.AnnotationProvisioningCoordinator(
        service,
        scope_id="runtime-a",
        owner_id="local-human",
    )

    try:
        startup, retry_a, retry_b = await asyncio.gather(
            coordinator.start_if_needed(),
            coordinator.retry(),
            coordinator.retry(),
        )
        assert startup is not None
        assert {startup.id, retry_a.id, retry_b.id} == {startup.id}
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert len(calls) == 1
    finally:
        release.set()
        await service.aclose()
        store.close()


@pytest.mark.asyncio
async def test_failed_attempt_is_retained_and_two_retries_share_one_new_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("WAYPOINT_DATA_DIR", str(tmp_path / "application-data"))
    second_entered = asyncio.Event()
    second_release = asyncio.Event()
    calls = 0

    async def execute(value, _cancel):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OperationExecutionError(
                "ANNOTATION_PROVISIONING_FAILED", "Annotation setup failed."
            )
        second_entered.set()
        await second_release.wait()
        return AnnotationProvisioningResult(
            installation_revision=value.installation_revision,
            disposition="installed",
            tools_ready=True,
            databases_ready=True,
            rfam_runtime_ready=True,
        )

    monkeypatch.setattr(provisioning, "annotation_provisioning_required", lambda: True)
    store = ControlPlaneStore(tmp_path / "operations.sqlite3")
    store.initialize()
    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        adapters=_bindings(execute),
    )
    coordinator = provisioning.AnnotationProvisioningCoordinator(
        service,
        scope_id="runtime-a",
        owner_id="local-human",
    )
    principal = _human("runtime-a")

    try:
        failed = await coordinator.retry()
        await _wait_for_state(service, principal, failed.id, OperationState.FAILED)
        retry_a, retry_b = await asyncio.gather(
            coordinator.retry(), coordinator.retry()
        )
        assert retry_a.id == retry_b.id
        assert retry_a.id != failed.id
        await asyncio.wait_for(second_entered.wait(), timeout=1)
        assert calls == 2
    finally:
        second_release.set()
        await service.aclose()
        store.close()


@pytest.mark.asyncio
async def test_executor_serializes_writers_and_rechecks_after_the_lease(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("WAYPOINT_DATA_DIR", str(tmp_path))
    current = current_annotation_provisioning_input()
    ready = False
    entered = asyncio.Event()
    release = asyncio.Event()
    physical_entries = 0

    def required() -> bool:
        return not ready

    async def ensure_tools() -> None:
        nonlocal physical_entries
        physical_entries += 1
        entered.set()
        await release.wait()

    async def ensure_databases() -> None:
        return None

    async def ensure_rfam_current() -> None:
        return None

    async def ensure_rfam_platform_compatible() -> None:
        return None

    async def ensure_plannotate_dbs_current() -> None:
        nonlocal ready
        ready = True

    monkeypatch.setattr(provisioning, "annotation_provisioning_required", required)
    monkeypatch.setattr(provisioning, "ensure_tools", ensure_tools)
    monkeypatch.setattr(provisioning, "ensure_databases", ensure_databases)
    monkeypatch.setattr(provisioning, "ensure_rfam_current", ensure_rfam_current)
    monkeypatch.setattr(
        provisioning,
        "ensure_rfam_platform_compatible",
        ensure_rfam_platform_compatible,
    )
    monkeypatch.setattr(
        provisioning,
        "ensure_plannotate_dbs_current",
        ensure_plannotate_dbs_current,
    )
    monkeypatch.setattr(
        provisioning,
        "annotation_provisioning_readiness",
        lambda: provisioning.AnnotationProvisioningReadiness(
            tools_ready=ready,
            databases_ready=ready,
            rfam_runtime_ready=ready,
            updates_current=ready,
        ),
    )

    first = asyncio.create_task(
        provisioning.execute_managed_annotation_provisioning(current, None)
    )
    await asyncio.wait_for(entered.wait(), timeout=1)
    second = asyncio.create_task(
        provisioning.execute_managed_annotation_provisioning(current, None)
    )
    await asyncio.sleep(0)
    assert physical_entries == 1

    release.set()
    first_result, second_result = await asyncio.gather(first, second)
    assert physical_entries == 1
    assert {first_result.disposition, second_result.disposition} == {
        "installed",
        "already_current",
    }


def test_installation_lease_excludes_an_independent_process(tmp_path: Path):
    owner = AnnotationInstallationLease(tmp_path, owner_id="parent")
    owner.acquire()
    context = multiprocessing.get_context("spawn")
    started = context.Event()
    acquired = context.Event()
    release = context.Event()
    child = context.Process(
        target=_lease_child,
        args=(str(tmp_path), started, acquired, release),
    )
    child.start()
    try:
        assert started.wait(timeout=5)
        assert not acquired.wait(timeout=0.25)
        owner.release()
        assert acquired.wait(timeout=5)
    finally:
        owner.release()
        release.set()
        child.join(timeout=5)
        if child.is_alive():
            child.terminate()
            child.join(timeout=5)
    assert child.exitcode == 0


def test_installation_lease_is_released_when_its_process_dies(tmp_path: Path):
    context = multiprocessing.get_context("spawn")
    started = context.Event()
    acquired = context.Event()
    release = context.Event()
    child = context.Process(
        target=_lease_child,
        args=(str(tmp_path), started, acquired, release),
    )
    child.start()
    assert started.wait(timeout=5)
    assert acquired.wait(timeout=5)
    assert AnnotationInstallationLease.is_locked(tmp_path) is True

    child.terminate()
    child.join(timeout=5)
    assert not child.is_alive()
    assert AnnotationInstallationLease.is_locked(tmp_path) is False

    successor = AnnotationInstallationLease(tmp_path, owner_id="successor")
    successor.acquire()
    successor.release()


def test_provisioning_status_observes_an_independent_process_lease(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    from src.annotation import setup

    monkeypatch.setenv("WAYPOINT_DATA_DIR", str(tmp_path))
    context = multiprocessing.get_context("spawn")
    started = context.Event()
    acquired = context.Event()
    release = context.Event()
    child = context.Process(
        target=_lease_child,
        args=(str(tmp_path), started, acquired, release),
    )
    child.start()
    try:
        assert started.wait(timeout=5)
        assert acquired.wait(timeout=5)
        assert setup.is_annotation_provisioning() is True
    finally:
        release.set()
        child.join(timeout=5)
        if child.is_alive():
            child.terminate()
            child.join(timeout=5)
    assert child.exitcode == 0
    assert setup.is_annotation_provisioning() is False


def test_abandoned_publication_stays_visible_and_requires_recovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    from src.annotation import setup

    monkeypatch.setenv("WAYPOINT_DATA_DIR", str(tmp_path))
    transaction = tmp_path / "annotation" / ".annotation-db-transaction-interrupted"
    transaction.mkdir(parents=True)
    monkeypatch.setattr(provisioning, "_tools_ready", lambda: True)
    monkeypatch.setattr(
        provisioning,
        "get_database_status",
        lambda _path: {"downloaded": True, "needs_update": False},
    )
    monkeypatch.setattr(provisioning, "asset_needs_update", lambda *_args: False)
    monkeypatch.setattr(provisioning, "is_rfam_runtime_ready", lambda: True)

    assert setup.is_annotation_provisioning() is True
    assert provisioning.annotation_provisioning_required() is True


def test_offline_readiness_accepts_a_complete_prepared_bundle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("WAYPOINT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DNAFORGE_OFFLINE_ANNOTATION", "1")
    monkeypatch.setattr(provisioning, "_tools_ready", lambda: True)
    monkeypatch.setattr(
        provisioning,
        "get_database_status",
        lambda _path: {"downloaded": True, "needs_update": False},
    )
    monkeypatch.setattr(provisioning, "asset_needs_update", lambda *_args: True)
    monkeypatch.setattr(provisioning, "is_rfam_runtime_ready", lambda: True)

    assert provisioning.annotation_provisioning_readiness().ready is True


@pytest.mark.asyncio
async def test_startup_skips_a_job_when_the_installation_is_current(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    async def execute(_value, _cancel):
        raise AssertionError("a current installation must not enqueue work")

    monkeypatch.setattr(provisioning, "annotation_provisioning_required", lambda: False)
    store = ControlPlaneStore(tmp_path / "operations.sqlite3")
    store.initialize()
    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        adapters=_bindings(execute),
    )
    coordinator = provisioning.AnnotationProvisioningCoordinator(
        service,
        scope_id="runtime-a",
        owner_id="local-human",
    )
    try:
        assert await coordinator.start_if_needed() is None
        assert service.list(_human("runtime-a"), scope_id="runtime-a") == []
    finally:
        await service.aclose()
        store.close()
