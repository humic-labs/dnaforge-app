from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

import pytest
from starlette.requests import Request

from src.concurrency.tool_registry import ToolContext
from src.control_plane import ControlPlaneStore
from src.managed_operation_agent_tools import managed_operation_tool_definitions
from src.managed_operations import MANAGED_OPERATION_SYSTEM
from src.managed_variant_source import execute_managed_variant_source
from src.operation_kinds import (
    VARIANT_SOURCE_PREPARATION_OPERATION_KIND,
)
from src.operations import (
    ActorKind,
    CancellationMode,
    ClientChannel,
    InputRevisionMismatch,
    ManagedOperationService,
    OperationPrincipal,
    OperationState,
)
from src.routes.tiles import variant_prepare_route
from src.variant_source_operation_audit import (
    variant_source_agent_audit_parameters,
    variant_source_submission_audit_parameters,
)
from src.variant_source_operation_contract import (
    VariantSourceAgentStart,
    VariantSourceInput,
    VariantSourceResult,
    VariantSourceSubmission,
    capture_variant_file_generation,
    prepare_variant_source_submission,
    variant_source_input_revision,
)
from tests.managed_operation_kinds import MANAGED_OPERATION_KINDS, bind_test_executors


def _submission(
    path: Path,
    *,
    key: str = "variant-attempt-1",
    length: int = 1_000,
) -> VariantSourceSubmission:
    return VariantSourceSubmission(
        submission_key=key,
        subject={"scope_id": "workspace-a"},
        input={
            "variantPath": str(path),
            "references": [{"name": "chr1", "length": length}],
        },
    )


def _principal() -> OperationPrincipal:
    return OperationPrincipal(
        actor_kind=ActorKind.HUMAN,
        actor_id="local-human",
        channel=ClientChannel.DESKTOP_UI,
        scope_ids={"workspace-a"},
        capabilities={"operations.start", "operations.read"},
    )


def _service(
    tmp_path: Path, executor
) -> tuple[ControlPlaneStore, ManagedOperationService]:
    async def unused(_value, _cancel):
        raise AssertionError("an unrelated managed executor must not run")

    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    service = ManagedOperationService(
        store=store,
        runtime_scope="workspace-a",
        adapters=bind_test_executors(
            unused, {VARIANT_SOURCE_PREPARATION_OPERATION_KIND.key: executor}
        ),
    )
    return store, service


def _result(tmp_path: Path, value: VariantSourceInput) -> VariantSourceResult:
    query = tmp_path / "prepared.vcf.gz"
    index = tmp_path / "prepared.vcf.gz.tbi"
    query.write_bytes(b"prepared-query")
    index.write_bytes(b"prepared-index")
    return VariantSourceResult(
        sourcePath=value.variant_path,
        queryPath=str(query),
        indexPath=str(index),
        format="vcf",
        label=Path(value.variant_path).name,
        sourceSizeBytes=value.source_generation.size,
        sourceMtimeNs=value.source_generation.mtime_ns,
        sourceIdentity="0" * 64,
        sourceGeneration=value.source_generation,
        queryGeneration=capture_variant_file_generation(str(query)),
        indexGeneration=capture_variant_file_generation(str(index)),
        assemblyRevision=value.assembly_revision,
        matchedReferences=[reference.name for reference in value.references],
        samples=[],
    )


def test_variant_source_is_one_compiled_generation_bound_kind(tmp_path: Path) -> None:
    source = tmp_path / "calls.vcf"
    source.write_bytes(b"variant-source")
    descriptors = {
        descriptor.kind: descriptor
        for descriptor in MANAGED_OPERATION_SYSTEM.descriptors
    }

    assert set(descriptors) == MANAGED_OPERATION_KINDS
    descriptor = descriptors["variant-source-preparation"]
    assert descriptor.contract_version == 1
    assert descriptor.result_schema_version == 1
    assert descriptor.active_join == "subject_revision"
    assert (
        VARIANT_SOURCE_PREPARATION_OPERATION_KIND.cancellation
        == CancellationMode.QUEUED_ONLY
    )
    assert descriptor.surfaces.http_start == "/operations/variant-source-preparation"
    assert descriptor.surfaces.cli_submit == (
        "dnaforge jobs submit variant-source-preparation --request FILE|-"
    )
    assert descriptor.surfaces.agent_start == (
        "operations.variant-source-preparation.start"
    )
    assert descriptor.input_schema == VariantSourceSubmission.model_json_schema()
    assert descriptor.agent_input_schema == VariantSourceAgentStart.model_json_schema()
    assert set(descriptor.agent_start_capabilities) == {
        "operations.start",
        "read-workspace",
    }

    definitions = {
        definition.spec.name: definition
        for definition in managed_operation_tool_definitions(MANAGED_OPERATION_SYSTEM)
    }
    assert (
        definitions["operations.variant-source-preparation.start"].spec.inputs
        == VariantSourceAgentStart.model_json_schema()
    )
    assert VARIANT_SOURCE_PREPARATION_OPERATION_KIND.input_model is VariantSourceInput


def test_submission_captures_file_generation_and_expected_assembly(
    tmp_path: Path,
) -> None:
    source = tmp_path / "calls.vcf"
    source.write_bytes(b"first-generation")

    first = prepare_variant_source_submission(_submission(source))

    assert first.input.variant_path == str(source.resolve(strict=True))
    assert first.input.source_generation.model_dump(by_alias=True) == {
        "canonicalPath": str(source.resolve(strict=True)),
        "size": source.stat().st_size,
        "mtimeNs": str(source.stat().st_mtime_ns),
        "ctimeNs": str(source.stat().st_ctime_ns),
        "device": str(source.stat().st_dev),
        "inode": str(source.stat().st_ino),
    }
    assert [reference.model_dump() for reference in first.input.references] == [
        {"name": "chr1", "length": 1_000}
    ]
    assert first.input.assembly_revision.startswith("variant-assembly-v1:sha256:")
    assert first.subject.subject_id.startswith("variant-source-v1:sha256:")
    assert first.subject.input_revision == variant_source_input_revision(first.input)

    another_assembly = prepare_variant_source_submission(
        _submission(source, key="variant-attempt-2", length=2_000)
    )
    assert another_assembly.subject != first.subject

    forged = _submission(source).model_copy(
        update={
            "subject": _submission(source).subject.model_copy(
                update={
                    "input_revision": "variant-source-preparation-v1:sha256:" + "0" * 64
                }
            )
        }
    )
    with pytest.raises(InputRevisionMismatch):
        prepare_variant_source_submission(forged)


def test_variant_source_audit_hashes_paths_and_bounds_assembly() -> None:
    audit = variant_source_submission_audit_parameters(
        {
            "submission_key": "attempt-1",
            "subject": {"scope_id": "workspace-a"},
            "input": {
                "variantPath": "/private/project/calls.vcf",
                "references": [{"name": "chr1", "length": 1_000}],
            },
        }
    )
    encoded = json.dumps(audit, sort_keys=True)

    assert audit["input"]["variant_path_sha256"].startswith("sha256:")
    assert audit["input"]["reference_count"] == 1
    assert "/private/project/calls.vcf" not in encoded
    agent_audit = variant_source_agent_audit_parameters(
        {"assemblyId": "assembly-a", "path": "project-a/data/calls.vcf"}
    )
    assert agent_audit["assembly_id"] == "assembly-a"
    assert agent_audit["path_basename"] == "calls.vcf"
    assert agent_audit["path_sha256"].startswith("sha256:")
    assert "project-a/data/calls.vcf" not in json.dumps(agent_audit, sort_keys=True)


@pytest.mark.asyncio
async def test_executor_owns_cpu_slot_and_passes_the_admitted_generation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "calls.vcf"
    query = tmp_path / "calls.vcf.gz"
    index = tmp_path / "calls.vcf.gz.tbi"
    source.write_bytes(b"variant-source")
    query.write_bytes(b"prepared-query")
    index.write_bytes(b"prepared-index")
    operation_input = prepare_variant_source_submission(_submission(source)).input
    events: list[str] = []

    class Pool:
        async def __aenter__(self):
            events.append("pool-enter")

        async def __aexit__(self, *_args):
            events.append("pool-exit")

        def slot(self):
            return self

    class Pools:
        def get(self, name: str):
            assert name == "cpu_slow"
            return Pool()

    class Variants:
        class VariantSourceGenerationChangedError(RuntimeError):
            pass

        class VariantSourceNotFoundError(RuntimeError):
            pass

        class VariantIndexError(RuntimeError):
            pass

        class VariantAssemblyMismatchError(RuntimeError):
            pass

        class VariantQueryError(RuntimeError):
            pass

        @staticmethod
        def prepare_variant_source(path, references, *, source_generation):
            assert path == str(source.resolve(strict=True))
            assert references == [{"name": "chr1", "length": 1_000}]
            assert source_generation == operation_input.source_generation
            events.append("prepare")
            return {
                "sourcePath": path,
                "queryPath": str(query),
                "indexPath": str(index),
                "format": "vcf",
                "label": "calls.vcf",
                "sourceSizeBytes": operation_input.source_generation.size,
                "sourceMtimeNs": operation_input.source_generation.mtime_ns,
                "sourceIdentity": "0" * 64,
                "sourceGeneration": operation_input.source_generation.model_dump(
                    mode="json", by_alias=True, exclude_none=False
                ),
                "queryGeneration": capture_variant_file_generation(
                    str(query)
                ).model_dump(mode="json", by_alias=True, exclude_none=False),
                "indexGeneration": capture_variant_file_generation(
                    str(index)
                ).model_dump(mode="json", by_alias=True, exclude_none=False),
                "assemblyRevision": operation_input.assembly_revision,
                "matchedReferences": ["chr1"],
                "samples": [],
            }

    monkeypatch.setattr("src.managed_variant_source.get_pool_manager", lambda: Pools())
    monkeypatch.setattr(
        "src.managed_variant_source._load_variant_service", lambda: Variants
    )

    result = await execute_managed_variant_source(operation_input, threading.Event())

    assert isinstance(result, VariantSourceResult)
    assert result.source_generation == operation_input.source_generation
    assert result.assembly_revision == operation_input.assembly_revision
    assert events == ["pool-enter", "prepare", "pool-exit"]


@pytest.mark.asyncio
async def test_equivalent_active_requests_join_one_variant_producer_and_retry(
    tmp_path: Path,
) -> None:
    source = tmp_path / "calls.vcf"
    source.write_bytes(b"variant-source")
    entered = asyncio.Event()
    release = asyncio.Event()
    producer_entries = 0

    async def executor(value, _cancel):
        nonlocal producer_entries
        producer_entries += 1
        entered.set()
        await release.wait()
        return _result(tmp_path, value)

    store, service = _service(tmp_path, executor)
    try:
        first, second = await asyncio.gather(
            service.start(
                _principal(),
                prepare_variant_source_submission(
                    _submission(source, key="desktop-attempt")
                ),
                kind="variant-source-preparation",
            ),
            service.start(
                _principal(),
                prepare_variant_source_submission(
                    _submission(source, key="cli-attempt")
                ),
                kind="variant-source-preparation",
            ),
        )
        assert first.id == second.id
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert producer_entries == 1

        refused = await service.request_cancel(_principal(), first.id)
        assert refused.disposition == "unavailable"
        assert refused.snapshot.state == OperationState.RUNNING

        release.set()
        settled = await service.wait_for_terminal(_principal(), first.id)
        assert settled.state == OperationState.SUCCEEDED

        retry = await service.start(
            _principal(),
            prepare_variant_source_submission(
                _submission(source, key="deliberate-retry")
            ),
            kind="variant-source-preparation",
        )
        assert retry.id != first.id
        assert (
            await service.wait_for_terminal(_principal(), retry.id)
        ).state == OperationState.SUCCEEDED
        assert producer_entries == 2
    finally:
        release.set()
        await service.aclose()
        store.close()


@pytest.mark.asyncio
async def test_queued_variant_preparation_can_stop_before_the_executor_enters(
    tmp_path: Path,
) -> None:
    first_source = tmp_path / "first.vcf"
    second_source = tmp_path / "second.vcf"
    first_source.write_bytes(b"first-variant-source")
    second_source.write_bytes(b"second-variant-source")
    first_entered = asyncio.Event()
    release = asyncio.Event()
    entered_paths: list[str] = []

    async def executor(value, _cancel):
        entered_paths.append(value.variant_path)
        first_entered.set()
        await release.wait()
        return _result(tmp_path, value)

    store, service = _service(tmp_path, executor)
    try:
        first = await service.start(
            _principal(),
            prepare_variant_source_submission(
                _submission(first_source, key="running-attempt")
            ),
            kind="variant-source-preparation",
        )
        await asyncio.wait_for(first_entered.wait(), timeout=1)
        queued = await service.start(
            _principal(),
            prepare_variant_source_submission(
                _submission(second_source, key="queued-attempt")
            ),
            kind="variant-source-preparation",
        )
        assert queued.state == OperationState.QUEUED

        stopped = await service.request_cancel(_principal(), queued.id)

        assert stopped.disposition == "accepted"
        assert stopped.snapshot.state == OperationState.CANCELED
        assert entered_paths == [str(first_source.resolve())]

        release.set()
        assert (
            await asyncio.wait_for(
                service.wait_for_terminal(_principal(), first.id), timeout=1
            )
        ).state == OperationState.SUCCEEDED
        assert entered_paths == [str(first_source.resolve())]
    finally:
        release.set()
        await service.aclose()
        store.close()


def test_restart_marks_unfinished_variant_preparation_interrupted(
    tmp_path: Path,
) -> None:
    source = tmp_path / "calls.vcf"
    source.write_bytes(b"variant-source")
    prepared = prepare_variant_source_submission(_submission(source))
    seed_store = ControlPlaneStore(tmp_path / "control.sqlite3")
    seed_store.initialize()
    seed_store.claim_managed_operation_owner("workspace-a", "dead-owner")
    operation_id = seed_store.insert_managed_operation(
        runtime_scope="workspace-a",
        scope_id=prepared.subject.scope_id,
        kind="variant-source-preparation",
        subject_id=prepared.subject.subject_id,
        input_revision=prepared.subject.input_revision,
        submission_key=prepared.submission_key,
        submission_payload_hash="sha256:unfinished-variant-source",
        actor_kind="human",
        actor_id="local-human",
        channel="desktop_ui",
        owner_instance_id="dead-owner",
        now=1.0,
        result_reservation_bytes=64,
    )
    seed_store.close()

    async def executor(value, _cancel):
        return _result(tmp_path, value)

    store, replacement = _service(tmp_path, executor)
    try:
        recovered = replacement.get(_principal(), operation_id)
        assert recovered.kind == "variant-source-preparation"
        assert recovered.state == OperationState.INTERRUPTED
        assert recovered.owner_instance_id == replacement.owner_instance_id
        assert (
            store.get_managed_operation(operation_id)["result_reservation_bytes"] == 0
        )
    finally:
        asyncio.run(replacement.aclose())
        store.close()


@pytest.mark.asyncio
async def test_agent_resolves_app_owned_path_and_links_the_same_operation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "calls.vcf"
    source.write_bytes(b"variant-source")
    entered = asyncio.Event()
    release = asyncio.Event()
    renderer_calls: list[tuple[str, dict, str]] = []

    async def executor(value, _cancel):
        entered.set()
        await release.wait()
        return _result(tmp_path, value)

    async def renderer_call(name, args, context):
        renderer_calls.append((name, args, context.job_id))
        return {
            "ok": True,
            "result": {
                "ok": True,
                "assemblyId": "assembly-a",
                "input": {
                    "variantPath": str(source),
                    "references": [{"name": "chr1", "length": 1_000}],
                },
            },
            "audit_id": "renderer-audit-1",
        }

    monkeypatch.setattr(
        "src.variant_source_operation_agent.call_renderer_bridge", renderer_call
    )
    store, service = _service(tmp_path, executor)
    capabilities = ["operations.start", "operations.read", "read-workspace"]
    store.ensure_agent_identity("agent-a", scope=capabilities)
    action_id = store.insert_agent_action(
        agent_identity_id="agent-a",
        tool_name="operations.variant-source-preparation.start",
        parameters={"path_basename": "calls.vcf", "assembly_id": "assembly-a"},
        authorized_scope=capabilities,
    )
    definition = next(
        item
        for item in managed_operation_tool_definitions(MANAGED_OPERATION_SYSTEM)
        if item.spec.name == "operations.variant-source-preparation.start"
    )
    assert definition.handler is not None
    context = ToolContext(
        job_id=action_id,
        agent_identity_id="agent-a",
        agent_capabilities=capabilities,
        cancel_event=asyncio.Event(),
        managed_operations=service,
    )

    try:
        snapshot = await definition.handler(
            {"assemblyId": "assembly-a", "path": "data/calls.vcf"}, context
        )
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert snapshot["kind"] == "variant-source-preparation"
        assert snapshot["state"] in {"queued", "running"}
        assert renderer_calls == [
            (
                "operations.variant-source-preparation.start",
                {"assemblyId": "assembly-a", "path": "data/calls.vcf"},
                action_id,
            )
        ]
        assert (
            store.get_agent_action(action_id)["managed_operation_id"] == snapshot["id"]
        )
    finally:
        release.set()
        await service.aclose()
        store.close()


@pytest.mark.asyncio
async def test_canceling_compatibility_wait_detaches_without_canceling_the_worker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "calls.vcf"
    source.write_bytes(b"variant-source")
    entered = asyncio.Event()
    release = asyncio.Event()

    async def executor(value, _cancel):
        entered.set()
        await release.wait()
        return _result(tmp_path, value)

    store, service = _service(tmp_path, executor)
    monkeypatch.setenv("DNAFORGE_OPERATION_SCOPE", "workspace-a")
    monkeypatch.setenv("DNAFORGE_OPERATION_OWNER_ID", "local-human")
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/tiles/variants/prepare",
            "headers": [],
            "app": type(
                "App",
                (),
                {"state": type("State", (), {"managed_operations": service})()},
            )(),
        }
    )
    body = VariantSourceSubmission.model_validate(_submission(source)).input
    observer = asyncio.create_task(variant_prepare_route(request, body))

    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        observer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await observer

        operations = service.list(_principal(), scope_id="workspace-a")
        assert len(operations) == 1
        assert operations[0].state == OperationState.RUNNING

        release.set()
        settled = await asyncio.wait_for(
            service.wait_for_terminal(_principal(), operations[0].id), timeout=1
        )
        assert settled.state == OperationState.SUCCEEDED
        actions = service.list_actions_page(_principal(), settled.id, limit=20)
        assert all(action.action != "request_cancel" for action in actions.actions)
    finally:
        release.set()
        await service.aclose()
        store.close()
