from __future__ import annotations

import asyncio
import json
import threading

import pytest
from starlette.requests import Request

from src.alignment_coverage_operation_audit import (
    alignment_coverage_agent_audit_parameters,
    alignment_coverage_submission_audit_parameters,
)
from src.alignment_coverage_operation_contract import (
    AlignmentCoverageAgentStart,
    AlignmentCoverageInput,
    AlignmentCoverageResult,
    AlignmentCoverageSubmission,
    alignment_coverage_input_revision,
    prepare_alignment_coverage_submission,
)
from src.concurrency.tool_registry import ToolContext
from src.control_plane import ControlPlaneStore
from src.managed_alignment_coverage import execute_managed_alignment_coverage
from src.managed_operation_agent_tools import managed_operation_tool_definitions
from src.managed_operations import MANAGED_OPERATION_SYSTEM
from src.operation_kinds import (
    ALIGNMENT_COVERAGE_PREPARATION_OPERATION_KIND,
)
from src.operations import (
    ActorKind,
    ClientChannel,
    InputRevisionMismatch,
    ManagedOperationService,
    OperationPrincipal,
    OperationState,
)
from src.routes.tiles import CoveragePrecomputeBody, coverage_precompute_route
from tests.managed_operation_kinds import MANAGED_OPERATION_KINDS, bind_test_executors


def _generation(*, mtime_ns: str = "1700000000000000000") -> dict:
    return {
        "contract": "aligned-read-source-generation.v1",
        "alignment": {
            "canonicalPath": "/fixtures/sample.bam",
            "size": 2048,
            "mtimeNs": mtime_ns,
            "ctimeNs": "1700000000000000001",
            "device": "5",
            "inode": "101",
        },
        "index": {
            "canonicalPath": "/fixtures/sample.bam.bai",
            "size": 512,
            "mtimeNs": "1700000000000000002",
            "ctimeNs": "1700000000000000003",
            "device": "5",
            "inode": "102",
        },
    }


def _input(**updates) -> AlignmentCoverageInput:
    value = {
        "assemblyId": "assembly-grch38",
        "bamPath": "/fixtures/sample.bam",
        "indexPath": "/fixtures/sample.bam.bai",
        "sourceGeneration": _generation(),
        "chroms": ["chr2", "chr1", "chr2"],
    }
    value.update(updates)
    return AlignmentCoverageInput.model_validate(value)


def _submission(
    key: str = "coverage-submission-1", **input_updates
) -> AlignmentCoverageSubmission:
    return AlignmentCoverageSubmission(
        submission_key=key,
        subject={"scope_id": "workspace-a"},
        input=_input(**input_updates),
    )


def _principal(
    actor_kind: ActorKind,
    actor_id: str,
    channel: ClientChannel,
) -> OperationPrincipal:
    return OperationPrincipal(
        actor_kind=actor_kind,
        actor_id=actor_id,
        channel=channel,
        scope_ids={"workspace-a"},
        capabilities={"operations.start", "operations.read", "read-workspace"},
    )


def test_alignment_coverage_is_one_compiled_kind_for_every_managed_surface():
    descriptors = {
        descriptor.kind: descriptor
        for descriptor in MANAGED_OPERATION_SYSTEM.descriptors
    }

    assert set(descriptors) == MANAGED_OPERATION_KINDS
    coverage = descriptors["alignment-coverage-preparation"]
    assert coverage.contract_version == 1
    assert coverage.result_schema_version == 1
    assert coverage.active_join == "subject_revision"
    assert coverage.surfaces.http_start == (
        "/operations/alignment-coverage-preparation"
    )
    assert coverage.surfaces.cli_submit == (
        "dnaforge jobs submit alignment-coverage-preparation --request FILE|-"
    )
    assert coverage.surfaces.agent_start == (
        "operations.alignment-coverage-preparation.start"
    )
    assert coverage.input_schema == AlignmentCoverageSubmission.model_json_schema()
    assert (
        coverage.agent_input_schema == AlignmentCoverageAgentStart.model_json_schema()
    )
    assert set(coverage.agent_start_capabilities) == {
        "operations.start",
        "read-workspace",
    }

    definitions = {
        definition.spec.name: definition
        for definition in managed_operation_tool_definitions(MANAGED_OPERATION_SYSTEM)
    }
    assert (
        definitions["operations.alignment-coverage-preparation.start"].spec.inputs
        == AlignmentCoverageAgentStart.model_json_schema()
    )


def test_submission_normalizes_the_chromosome_set_and_derives_exact_identity():
    prepared = prepare_alignment_coverage_submission(_submission())

    assert prepared.input.chroms == ["chr1", "chr2"]
    assert prepared.subject.subject_id.startswith("aligned-read-source-v1:sha256:")
    assert prepared.subject.input_revision == alignment_coverage_input_revision(
        prepared.input
    )

    reordered = prepare_alignment_coverage_submission(
        _submission("coverage-submission-2", chroms=["chr1", "chr2"])
    )
    assert reordered.subject == prepared.subject
    assert reordered.input == prepared.input

    changed_generation = prepare_alignment_coverage_submission(
        _submission(
            "coverage-submission-3",
            sourceGeneration=_generation(mtime_ns="1700000000000000099"),
        )
    )
    assert changed_generation.subject != prepared.subject

    forged = _submission().model_copy(
        update={
            "subject": _submission().subject.model_copy(
                update={"input_revision": "alignment-coverage-v1:sha256:" + "0" * 64}
            )
        }
    )
    with pytest.raises(InputRevisionMismatch):
        prepare_alignment_coverage_submission(forged)


def test_audit_projection_hashes_paths_and_agent_input_is_identifier_only():
    audit = alignment_coverage_submission_audit_parameters(
        _submission().model_dump(mode="json", by_alias=True)
    )
    encoded = json.dumps(audit, sort_keys=True)

    assert audit["input"]["assembly_id"] == "assembly-grch38"
    assert audit["input"]["chrom_count"] == 2
    assert audit["input"]["bam_path_sha256"].startswith("sha256:")
    assert "/fixtures/sample.bam" not in encoded

    agent_audit = alignment_coverage_agent_audit_parameters(
        {"assemblyId": "assembly-grch38", "trackId": "track-42"}
    )
    assert agent_audit == {
        "assembly_id": "assembly-grch38",
        "track_id": "track-42",
    }


@pytest.mark.asyncio
async def test_equivalent_cross_actor_submissions_join_before_one_worker_settles(
    tmp_path,
):
    entered = asyncio.Event()
    release = asyncio.Event()
    producer_entries = 0

    async def unused(_value, _cancel):
        raise AssertionError("unrelated managed executor must not run")

    async def coverage_executor(value, _cancel: threading.Event):
        nonlocal producer_entries
        producer_entries += 1
        entered.set()
        await release.wait()
        return AlignmentCoverageResult(
            chroms=[
                {"chrom": chrom, "present": True, "built": True}
                for chrom in value.chroms
            ]
        )

    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    service = ManagedOperationService(
        store=store,
        runtime_scope="workspace-a",
        adapters=bind_test_executors(
            unused,
            {ALIGNMENT_COVERAGE_PREPARATION_OPERATION_KIND.key: coverage_executor},
        ),
    )
    human = _principal(ActorKind.HUMAN, "local-human", ClientChannel.DESKTOP_UI)
    agent = _principal(ActorKind.AGENT, "agent-a", ClientChannel.AGENT)
    agent_submission = prepare_alignment_coverage_submission(
        _submission("agent-attempt")
    )

    try:
        first, second = await asyncio.wait_for(
            asyncio.gather(
                service.start(
                    human,
                    prepare_alignment_coverage_submission(
                        _submission("desktop-attempt")
                    ),
                    kind="alignment-coverage-preparation",
                ),
                service.start(
                    agent,
                    agent_submission,
                    kind="alignment-coverage-preparation",
                ),
            ),
            timeout=0.2,
        )
        assert first.id == second.id
        assert first.state in {OperationState.QUEUED, OperationState.RUNNING}
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert producer_entries == 1

        actions = service.list_actions_page(human, first.id, limit=20)
        assert [
            (action.action, action.outcome, action.actor_id)
            for action in actions.actions
        ] == [
            ("submit", "accepted", "local-human"),
            ("submit", "joined_active", "agent-a"),
        ]

        release.set()
        settled = await service.wait_for_terminal(human, first.id)
        assert settled.state == OperationState.SUCCEEDED
        retry = await service.start(
            agent,
            agent_submission,
            kind="alignment-coverage-preparation",
        )
        assert retry.id == first.id
        assert producer_entries == 1
    finally:
        release.set()
        await service.aclose()
        store.close()


@pytest.mark.asyncio
async def test_agent_identifiers_resolve_in_the_app_and_join_the_human_operation(
    tmp_path,
    monkeypatch,
):
    entered = asyncio.Event()
    release = asyncio.Event()
    producer_entries = 0
    renderer_calls: list[tuple[str, dict, str]] = []

    async def unused(_value, _cancel):
        raise AssertionError("an unrelated managed executor must not run")

    async def coverage_executor(value, _cancel):
        nonlocal producer_entries
        producer_entries += 1
        entered.set()
        await release.wait()
        return AlignmentCoverageResult(
            chroms=[
                {"chrom": chrom, "present": True, "built": True}
                for chrom in value.chroms
            ]
        )

    async def renderer_call(name, args, context):
        renderer_calls.append((name, args, context.job_id))
        return {
            "ok": True,
            "result": {
                "ok": True,
                "input": _input().model_dump(mode="json", by_alias=True),
            },
            "audit_id": "renderer-audit-1",
        }

    monkeypatch.setattr(
        "src.alignment_coverage_operation_agent.call_renderer_bridge",
        renderer_call,
    )
    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    service = ManagedOperationService(
        store=store,
        runtime_scope="workspace-a",
        adapters=bind_test_executors(
            unused,
            {ALIGNMENT_COVERAGE_PREPARATION_OPERATION_KIND.key: coverage_executor},
        ),
    )
    capabilities = ["operations.start", "operations.read", "read-workspace"]
    store.ensure_agent_identity("agent-a", scope=capabilities)
    action_id = store.insert_agent_action(
        agent_identity_id="agent-a",
        tool_name="operations.alignment-coverage-preparation.start",
        parameters={"assembly_id": "assembly-grch38", "track_id": "track-42"},
        authorized_scope=capabilities,
    )
    definition = next(
        item
        for item in managed_operation_tool_definitions(MANAGED_OPERATION_SYSTEM)
        if item.spec.name == "operations.alignment-coverage-preparation.start"
    )
    assert definition.handler is not None
    context = ToolContext(
        job_id=action_id,
        agent_identity_id="agent-a",
        agent_capabilities=capabilities,
        cancel_event=asyncio.Event(),
        managed_operations=service,
    )
    human = _principal(ActorKind.HUMAN, "local-human", ClientChannel.DESKTOP_UI)

    try:
        agent_snapshot = await asyncio.wait_for(
            definition.handler(
                {"assemblyId": "assembly-grch38", "trackId": "track-42"},
                context,
            ),
            timeout=0.2,
        )
        human_snapshot = await service.start(
            human,
            prepare_alignment_coverage_submission(_submission("human-attempt")),
            kind="alignment-coverage-preparation",
        )
        assert agent_snapshot["id"] == human_snapshot.id
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert producer_entries == 1
        assert renderer_calls == [
            (
                "operations.alignment-coverage-preparation.start",
                {"assemblyId": "assembly-grch38", "trackId": "track-42"},
                action_id,
            )
        ]
        assert (
            store.get_agent_action(action_id)["managed_operation_id"]
            == human_snapshot.id
        )
    finally:
        release.set()
        await service.aclose()
        store.close()


@pytest.mark.asyncio
async def test_changed_input_does_not_join_and_terminal_work_requires_a_new_attempt(
    tmp_path,
):
    entered = asyncio.Event()
    release = asyncio.Event()

    async def unused(_value, _cancel):
        raise AssertionError("an unrelated managed executor must not run")

    async def coverage_executor(value, _cancel):
        entered.set()
        await release.wait()
        return AlignmentCoverageResult(
            chroms=[
                {"chrom": chrom, "present": True, "built": True}
                for chrom in value.chroms
            ]
        )

    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    service = ManagedOperationService(
        store=store,
        runtime_scope="workspace-a",
        adapters=bind_test_executors(
            unused,
            {ALIGNMENT_COVERAGE_PREPARATION_OPERATION_KIND.key: coverage_executor},
        ),
    )
    human = _principal(ActorKind.HUMAN, "local-human", ClientChannel.DESKTOP_UI)

    try:
        first = await service.start(
            human,
            prepare_alignment_coverage_submission(_submission("first-attempt")),
            kind="alignment-coverage-preparation",
        )
        await asyncio.wait_for(entered.wait(), timeout=1)
        changed = await service.start(
            human,
            prepare_alignment_coverage_submission(
                _submission("force-attempt", force=True)
            ),
            kind="alignment-coverage-preparation",
        )
        assert changed.id != first.id
        assert changed.state == OperationState.QUEUED

        running_cancel = await service.request_cancel(human, first.id)
        assert running_cancel.disposition == "unavailable"
        queued_cancel = await service.request_cancel(human, changed.id)
        assert queued_cancel.disposition == "accepted"
        assert queued_cancel.snapshot.state == OperationState.CANCELED

        release.set()
        settled = await asyncio.wait_for(
            service.wait_for_terminal(human, first.id), timeout=1
        )
        assert settled.state == OperationState.SUCCEEDED

        retry = await service.start(
            human,
            prepare_alignment_coverage_submission(_submission("retry-attempt")),
            kind="alignment-coverage-preparation",
        )
        assert retry.id != first.id
        assert (
            await asyncio.wait_for(
                service.wait_for_terminal(human, retry.id), timeout=1
            )
        ).state == OperationState.SUCCEEDED
    finally:
        release.set()
        await service.aclose()
        store.close()


@pytest.mark.asyncio
async def test_executor_keeps_the_existing_pool_source_checks_and_readiness_oracle(
    monkeypatch,
):
    events: list[str] = []

    class Pool:
        async def __aenter__(self):
            events.append("pool-enter")

        async def __aexit__(self, _type, _value, _traceback):
            events.append("pool-exit")

        def slot(self):
            return self

    class Pools:
        def get(self, name: str):
            assert name == "cpu_slow"
            return Pool()

    class Pileup:
        class SourceGenerationChangedError(RuntimeError):
            pass

        class BamNotFoundError(RuntimeError):
            pass

        class IndexNotFoundError(RuntimeError):
            pass

        class ReferenceNotFoundError(RuntimeError):
            pass

        @staticmethod
        def require_aligned_read_source_generation(*_args):
            events.append("validate-source")

    class Coverage:
        @staticmethod
        def coverage_pyramid_precompute(
            _bam_path,
            chroms,
            *,
            index_path,
            reference_fasta,
            force,
        ):
            assert chroms == ["chr1", "chr2"]
            assert index_path == "/fixtures/sample.bam.bai"
            assert reference_fasta is None
            assert force is False
            events.append("precompute")
            return [
                {
                    "chrom": chrom,
                    "present": True,
                    "built": True,
                    "chromLength": 100,
                    "cachePath": f"/private/cache/{chrom}.npy",
                    "sizeBytes": 512,
                    "provenance": {"method": "existing-engine"},
                }
                for chrom in chroms
            ]

        @staticmethod
        def coverage_pyramid_readiness(
            _bam_path,
            chroms,
            *,
            index_path,
            reference_fasta,
        ):
            assert index_path == "/fixtures/sample.bam.bai"
            assert reference_fasta is None
            events.append("readiness")
            return [{"chrom": chrom, "present": True} for chrom in chroms]

    monkeypatch.setattr(
        "src.managed_alignment_coverage.get_pool_manager", lambda: Pools()
    )
    monkeypatch.setattr(
        "src.managed_alignment_coverage._load_coverage_services",
        lambda: (Coverage, Pileup),
    )

    result = await execute_managed_alignment_coverage(_input(), threading.Event())

    assert result.model_dump(mode="json", by_alias=True, exclude_none=True) == {
        "chroms": [
            {
                "chrom": "chr1",
                "present": True,
                "built": True,
                "chromLength": 100,
                "sizeBytes": 512,
            },
            {
                "chrom": "chr2",
                "present": True,
                "built": True,
                "chromLength": 100,
                "sizeBytes": 512,
            },
        ]
    }
    assert events == [
        "pool-enter",
        "validate-source",
        "precompute",
        "validate-source",
        "readiness",
        "validate-source",
        "pool-exit",
    ]


@pytest.mark.asyncio
async def test_canceling_the_legacy_http_wait_detaches_without_canceling_the_worker(
    tmp_path,
    monkeypatch,
):
    entered = asyncio.Event()
    release = asyncio.Event()

    async def unused(_value, _cancel):
        raise AssertionError("an unrelated managed executor must not run")

    async def coverage_executor(value, _cancel):
        entered.set()
        await release.wait()
        return AlignmentCoverageResult(
            chroms=[
                {"chrom": chrom, "present": True, "built": True}
                for chrom in value.chroms
            ]
        )

    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    service = ManagedOperationService(
        store=store,
        runtime_scope="workspace-a",
        adapters=bind_test_executors(
            unused,
            {ALIGNMENT_COVERAGE_PREPARATION_OPERATION_KIND.key: coverage_executor},
        ),
    )
    monkeypatch.setenv("DNAFORGE_OPERATION_SCOPE", "workspace-a")
    monkeypatch.setenv("DNAFORGE_OPERATION_OWNER_ID", "local-human")
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/tiles/coverage/precompute",
            "headers": [],
            "app": type(
                "App",
                (),
                {"state": type("State", (), {"managed_operations": service})()},
            )(),
        }
    )
    body = CoveragePrecomputeBody.model_validate(
        {
            "assemblyId": "assembly-grch38",
            "bamPath": "/fixtures/sample.bam",
            "indexPath": "/fixtures/sample.bam.bai",
            "sourceGeneration": _generation(),
            "chroms": ["chr1", "chr2"],
        }
    )
    observer = asyncio.create_task(coverage_precompute_route(request, body))

    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        observer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await observer

        human = _principal(ActorKind.HUMAN, "local-human", ClientChannel.DESKTOP_UI)
        operations = service.list(human, scope_id="workspace-a")
        assert len(operations) == 1
        assert operations[0].state == OperationState.RUNNING

        release.set()
        settled = await asyncio.wait_for(
            service.wait_for_terminal(human, operations[0].id), timeout=1
        )
        assert settled.state == OperationState.SUCCEEDED
        actions = service.list_actions_page(human, settled.id, limit=20)
        assert all(action.action != "request_cancel" for action in actions.actions)
    finally:
        release.set()
        await service.aclose()
        store.close()
