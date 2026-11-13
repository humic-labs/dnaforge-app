from __future__ import annotations

import asyncio
import json
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi import FastAPI
from starlette.requests import Request

from src.alignment_index_operation_audit import (
    alignment_index_agent_audit_parameters,
    alignment_index_submission_audit_parameters,
)
from src.alignment_index_operation_contract import (
    AlignmentIndexAgentStart,
    AlignmentIndexInput,
    AlignmentIndexRequest,
    AlignmentIndexResult,
    AlignmentIndexSubmission,
    alignment_index_input_revision,
    prepare_alignment_index_submission,
)
from src.concurrency.tool_registry import ToolContext
from src.control_plane import ControlPlaneStore
from src.managed_alignment_index import execute_managed_alignment_index
from src.managed_operation_agent_tools import managed_operation_tool_definitions
from src.managed_operations import MANAGED_OPERATION_SYSTEM
from src.operation_kinds import (
    ALIGNMENT_INDEX_PREPARATION_OPERATION_KIND,
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
from src.routes.operations import router as operations_router
from src.routes.tiles import alignment_index_route
from src.security.local_access import LocalAccessMiddleware
from tests.managed_operation_kinds import MANAGED_OPERATION_KINDS, bind_test_executors
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient


def _submission(
    path: Path, *, key: str = "index-attempt-1"
) -> AlignmentIndexSubmission:
    return AlignmentIndexSubmission(
        submission_key=key,
        subject={"scope_id": "workspace-a"},
        input={"bamPath": str(path)},
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
    tmp_path: Path,
    executor,
) -> tuple[ControlPlaneStore, ManagedOperationService]:
    async def unused(_value, _cancel):
        raise AssertionError("an unrelated managed executor must not run")

    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    service = ManagedOperationService(
        store=store,
        runtime_scope="workspace-a",
        adapters=bind_test_executors(
            unused, {ALIGNMENT_INDEX_PREPARATION_OPERATION_KIND.key: executor}
        ),
    )
    return store, service


def test_alignment_index_is_one_compiled_generation_bound_kind(tmp_path: Path) -> None:
    bam = tmp_path / "sample.bam"
    bam.write_bytes(b"first-generation")
    descriptors = {
        descriptor.kind: descriptor
        for descriptor in MANAGED_OPERATION_SYSTEM.descriptors
    }

    assert set(descriptors) == MANAGED_OPERATION_KINDS
    descriptor = descriptors["alignment-index-preparation"]
    assert descriptor.contract_version == 1
    assert descriptor.result_schema_version == 1
    assert descriptor.active_join == "subject_revision"
    assert (
        ALIGNMENT_INDEX_PREPARATION_OPERATION_KIND.cancellation
        == CancellationMode.QUEUED_ONLY
    )
    assert descriptor.surfaces.http_start == ("/operations/alignment-index-preparation")
    assert descriptor.surfaces.cli_submit == (
        "dnaforge jobs submit alignment-index-preparation --request FILE|-"
    )
    assert descriptor.surfaces.agent_start == (
        "operations.alignment-index-preparation.start"
    )
    assert descriptor.input_schema == AlignmentIndexSubmission.model_json_schema()
    assert descriptor.agent_input_schema == AlignmentIndexAgentStart.model_json_schema()
    assert set(descriptor.agent_start_capabilities) == {
        "operations.start",
        "read-workspace",
    }

    definitions = {
        definition.spec.name: definition
        for definition in managed_operation_tool_definitions(MANAGED_OPERATION_SYSTEM)
    }
    assert (
        definitions["operations.alignment-index-preparation.start"].spec.inputs
        == AlignmentIndexAgentStart.model_json_schema()
    )
    assert ALIGNMENT_INDEX_PREPARATION_OPERATION_KIND.input_model is AlignmentIndexInput


def test_submission_captures_the_complete_file_generation(tmp_path: Path) -> None:
    bam = tmp_path / "sample.bam"
    replacement = tmp_path / "replacement.bam"
    bam.write_bytes(b"first-generation")
    original_stat = bam.stat()

    first = prepare_alignment_index_submission(_submission(bam))

    assert first.input.bam_path == str(bam.resolve(strict=True))
    assert first.input.source_generation.model_dump(by_alias=True) == {
        "canonicalPath": str(bam.resolve(strict=True)),
        "size": original_stat.st_size,
        "mtimeNs": str(original_stat.st_mtime_ns),
        "ctimeNs": str(original_stat.st_ctime_ns),
        "device": str(original_stat.st_dev),
        "inode": str(original_stat.st_ino),
    }
    assert first.subject.subject_id.startswith("aligned-read-file-v1:sha256:")
    assert first.subject.input_revision == alignment_index_input_revision(first.input)

    replacement.write_bytes(b"other-generation")
    assert replacement.stat().st_size == original_stat.st_size
    os.replace(replacement, bam)
    os.utime(bam, ns=(bam.stat().st_atime_ns, original_stat.st_mtime_ns))
    replacement_stat = bam.stat()
    assert replacement_stat.st_ctime_ns != original_stat.st_ctime_ns
    assert replacement_stat.st_ino != original_stat.st_ino

    second = prepare_alignment_index_submission(_submission(bam, key="index-attempt-2"))

    assert second.subject != first.subject
    assert second.input.source_generation.ctime_ns == str(replacement_stat.st_ctime_ns)
    assert second.input.source_generation.inode == str(replacement_stat.st_ino)

    forged = _submission(bam).model_copy(
        update={
            "subject": _submission(bam).subject.model_copy(
                update={"input_revision": "alignment-index-v1:sha256:" + "0" * 64}
            )
        }
    )
    with pytest.raises(InputRevisionMismatch):
        prepare_alignment_index_submission(forged)


@pytest.mark.asyncio
async def test_agent_start_resolves_a_workspace_path_and_starts_the_same_operation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bam = tmp_path / "sample.bam"
    bam.write_bytes(b"first-generation")
    entered = asyncio.Event()
    release = asyncio.Event()
    renderer_calls: list[tuple[str, dict, str]] = []

    async def executor(value, _cancel):
        assert value.bam_path == str(bam.resolve(strict=True))
        assert value.source_generation.inode == str(bam.stat().st_ino)
        entered.set()
        await release.wait()
        return AlignmentIndexResult(
            format="bam",
            state="created",
            indexPath=str(tmp_path / "sample.bam.bai"),
        )

    async def renderer_call(name, args, context):
        renderer_calls.append((name, args, context.job_id))
        return {
            "ok": True,
            "result": {"ok": True, "input": {"bamPath": str(bam)}},
            "audit_id": "renderer-audit-1",
        }

    monkeypatch.setattr(
        "src.alignment_index_operation_agent.call_renderer_bridge", renderer_call
    )
    store, service = _service(tmp_path, executor)
    capabilities = ["operations.start", "operations.read", "read-workspace"]
    store.ensure_agent_identity("agent-a", scope=capabilities)
    action_id = store.insert_agent_action(
        agent_identity_id="agent-a",
        tool_name="operations.alignment-index-preparation.start",
        parameters={"path_basename": "sample.bam"},
        authorized_scope=capabilities,
    )
    definition = next(
        item
        for item in managed_operation_tool_definitions(MANAGED_OPERATION_SYSTEM)
        if item.spec.name == "operations.alignment-index-preparation.start"
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
        snapshot = await definition.handler({"path": "reads/sample.bam"}, context)
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert snapshot["kind"] == "alignment-index-preparation"
        assert snapshot["state"] in {"queued", "running"}
        assert renderer_calls == [
            (
                "operations.alignment-index-preparation.start",
                {"path": "reads/sample.bam"},
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


def test_alignment_index_audit_hashes_paths() -> None:
    audit = alignment_index_submission_audit_parameters(
        {
            "submission_key": "attempt-1",
            "subject": {"scope_id": "workspace-a"},
            "input": {"bamPath": "/private/project/reads.bam"},
        }
    )
    encoded = json.dumps(audit, sort_keys=True)

    assert audit["input"]["bam_path_sha256"].startswith("sha256:")
    assert "/private/project/reads.bam" not in encoded
    agent_audit = alignment_index_agent_audit_parameters(
        {"path": "project-a/data/reads.bam"}
    )
    assert agent_audit["path_basename"] == "reads.bam"
    assert agent_audit["path_sha256"].startswith("sha256:")
    assert "project-a/data/reads.bam" not in json.dumps(agent_audit, sort_keys=True)


def test_generated_http_start_accepts_the_public_bam_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bam = tmp_path / "sample.bam"
    bam.write_bytes(b"first-generation")
    observed: list[AlignmentIndexInput] = []

    async def executor(value, _cancel):
        observed.append(value)
        return AlignmentIndexResult(
            format="bam",
            state="created",
            indexPath=str(tmp_path / "sample.bam.bai"),
        )

    @asynccontextmanager
    async def lifespan(app):
        store, service = _service(tmp_path, executor)
        app.state.managed_operations = service
        try:
            yield
        finally:
            await service.aclose()
            store.close()

    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", "human-operation-secret")
    monkeypatch.setenv("DNAFORGE_OPERATION_SCOPE", "workspace-a")
    monkeypatch.setenv("DNAFORGE_OPERATION_OWNER_ID", "local-human")
    app = FastAPI(lifespan=lifespan)
    app.add_middleware(LocalAccessMiddleware)
    app.include_router(operations_router)

    with TestClient(app) as client:
        client.headers["X-DNAForge-Operation-Authority"] = "human-operation-secret"
        response = client.post(
            "/operations/alignment-index-preparation",
            json=_submission(bam).model_dump(mode="json", by_alias=True),
        )

        assert response.status_code == 202, response.text
        assert response.json()["kind"] == "alignment-index-preparation"

    assert len(observed) == 1
    assert observed[0].bam_path == str(bam.resolve(strict=True))


@pytest.mark.asyncio
async def test_executor_owns_the_cpu_slot_and_passes_the_admitted_generation(
    tmp_path: Path, monkeypatch
) -> None:
    bam = tmp_path / "sample.bam"
    bam.write_bytes(b"first-generation")
    operation_input = prepare_alignment_index_submission(_submission(bam)).input
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

    class Pileup:
        class SourceGenerationChangedError(RuntimeError):
            pass

        class BamNotFoundError(RuntimeError):
            pass

        class AlignmentIndexError(RuntimeError):
            pass

        @staticmethod
        def ensure_alignment_index(path: str, *, source_generation: object):
            assert path == str(bam.resolve(strict=True))
            assert source_generation == operation_input.source_generation
            events.append("index")
            return {
                "format": "bam",
                "state": "created",
                "indexPath": str(tmp_path / "managed.bai"),
            }

    monkeypatch.setattr("src.managed_alignment_index.get_pool_manager", lambda: Pools())
    monkeypatch.setattr(
        "src.managed_alignment_index._load_pileup_service", lambda: Pileup
    )

    result = await execute_managed_alignment_index(operation_input, threading.Event())

    assert result.model_dump(mode="json", by_alias=True) == {
        "format": "bam",
        "state": "created",
        "indexPath": str(tmp_path / "managed.bai"),
    }
    assert events == ["pool-enter", "index", "pool-exit"]


@pytest.mark.asyncio
async def test_equivalent_active_requests_join_one_index_producer(
    tmp_path: Path,
) -> None:
    bam = tmp_path / "sample.bam"
    bam.write_bytes(b"first-generation")
    entered = asyncio.Event()
    release = asyncio.Event()
    producer_entries = 0

    async def executor(_value, _cancel):
        nonlocal producer_entries
        producer_entries += 1
        entered.set()
        await release.wait()
        return AlignmentIndexResult(
            format="bam",
            state="created",
            indexPath=str(tmp_path / "managed.bai"),
        )

    store, service = _service(tmp_path, executor)
    try:
        first, second = await asyncio.gather(
            service.start(
                _principal(),
                prepare_alignment_index_submission(
                    _submission(bam, key="desktop-attempt")
                ),
                kind="alignment-index-preparation",
            ),
            service.start(
                _principal(),
                prepare_alignment_index_submission(_submission(bam, key="cli-attempt")),
                kind="alignment-index-preparation",
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
            prepare_alignment_index_submission(
                _submission(bam, key="deliberate-retry")
            ),
            kind="alignment-index-preparation",
        )
        assert retry.id != first.id
    finally:
        release.set()
        await service.aclose()
        store.close()


@pytest.mark.asyncio
async def test_canceling_compatibility_wait_detaches_from_the_operation(
    tmp_path: Path, monkeypatch
) -> None:
    bam = tmp_path / "sample.bam"
    bam.write_bytes(b"first-generation")
    entered = asyncio.Event()
    release = asyncio.Event()

    async def executor(_value, _cancel):
        entered.set()
        await release.wait()
        return AlignmentIndexResult(
            format="bam",
            state="created",
            indexPath=str(tmp_path / "managed.bai"),
        )

    store, service = _service(tmp_path, executor)
    monkeypatch.setenv("DNAFORGE_OPERATION_SCOPE", "workspace-a")
    monkeypatch.setenv("DNAFORGE_OPERATION_OWNER_ID", "local-human")
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/tiles/alignment/index",
            "headers": [],
            "app": type(
                "App",
                (),
                {"state": type("State", (), {"managed_operations": service})()},
            )(),
        }
    )
    observer = asyncio.create_task(
        alignment_index_route(request, AlignmentIndexRequest(bamPath=str(bam)))
    )

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
