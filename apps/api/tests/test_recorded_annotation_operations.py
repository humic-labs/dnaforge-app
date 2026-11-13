from __future__ import annotations

import json
import threading
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from dnaforge_annotation.contract import AnnotationRequest, AnnotationResult
from dnaforge_annotation.identity import annotation_input_revision

from src.control_plane import ControlPlaneStore
from src.operations import (
    ActorKind,
    ClientChannel,
    ManagedOperationKindAdapter,
    ManagedOperationService,
    OperationAccessDenied,
    OperationOrigin,
    OperationPrincipal,
    OperationRecordedProvenance,
    OperationResultStorageFull,
    OperationState,
    SubmissionConflict,
)
from src.recorded_annotation_operations import (
    RecordedAnnotationImport,
    prepare_recorded_annotation_import,
)


def test_annotation_era_provenance_decodes_into_neutral_artifacts():
    legacy = OperationRecordedProvenance.model_validate(
        {
            "schema_version": 1,
            "reported_run_id": "old-run",
            "reported_started_at": "2026-09-09T12:00:00Z",
            "reported_finished_at": "2026-09-09T12:01:00Z",
            "tool_name": "old-tool",
            "tool_version": "1.0",
            "input_sequence_id": "sample-a",
            "input_sequence_length": 42,
            "input_sequence_sha256": "sha256:" + "a" * 64,
            "input_revision": "revision-a",
            "request_parameters": {"mode": "fast"},
            "reported_input_path": "/input.dat",
            "reported_output_path": "/output.json",
            "reported_output_format": "json",
            "reported_runtime_threads": 2,
            "reported_runtime_data_dir": "/data",
            "reported_runtime_executables": {"worker": "/bin/worker"},
            "reported_runtime_temp_dir": "/tmp/run",
            "reported_runtime_database_config": "/data/config",
            "reported_reference_manifest": "/data/manifest",
            "reference_versions": {"reference-a": "2026.09"},
        }
    )

    assert legacy.inputs[0].identity == "sample-a"
    assert legacy.inputs[0].size == 42
    assert legacy.outputs[0].format == "json"
    assert legacy.runtime.threads == 2
    assert legacy.resources == {"reference-a": "2026.09"}
    serialized = legacy.model_dump(mode="json")
    assert "input_sequence_id" not in serialized
    assert "reference_versions" not in serialized


def principal(
    actor_id: str = "human-a",
    *,
    scope: str = "runtime-a",
    actor_kind: ActorKind = ActorKind.HUMAN,
    capabilities: frozenset[str] = frozenset(),
) -> OperationPrincipal:
    return OperationPrincipal(
        actor_kind=actor_kind,
        actor_id=actor_id,
        channel=(
            ClientChannel.AGENT
            if actor_kind == ActorKind.AGENT
            else ClientChannel.DESKTOP_UI
        ),
        scope_ids={scope},
        capabilities=capabilities,
    )


def receipt(*, run_id: str | None = None, sequence: str = "PRIVATE-ACGT") -> dict:
    request = AnnotationRequest(sequence=sequence, linear=True, start=1, end=4)
    return {
        "schema_version": 1,
        "run_id": run_id or str(uuid4()),
        "tool": {"name": "dnaforge-annotation", "version": "0.1.0"},
        "outcome": "succeeded",
        "started_at": "2026-09-09T12:00:00+00:00",
        "finished_at": "2026-09-09T12:01:00+00:00",
        "input": {
            "path": "/reported/input.fasta",
            "sequence_id": "receipt-sequence",
            "sequence_length": len(sequence),
            "revision": annotation_input_revision(request),
        },
        "output": {"format": "json", "path": "/reported/output.json"},
        "request": request.model_dump(mode="json"),
        "runtime": {
            "data_dir": "/reported/references",
            "executables": {
                "blastn": "/reported/blastn",
                "diamond": "/reported/diamond",
                "cmscan": "/reported/cmscan",
            },
            "temp_dir": None,
            "threads": 2,
            "database_config": "/reported/databases.yml",
        },
        "reference_data": {
            "manifest": "/reported/databases.yml",
            "versions": {"snapgene": "2026.09", "custom": None},
        },
        "result": {"features": [], "sequence_length": len(sequence), "error": None},
    }


def import_body(
    value: dict,
    *,
    scope: str = "runtime-a",
    subject_id: str = "sequence-a",
) -> RecordedAnnotationImport:
    return RecordedAnnotationImport.model_validate(
        {
            "subject": {"scope_id": scope, "subject_id": subject_id},
            "receipt": value,
        }
    )


def adapter(*, kind: str = "annotation") -> ManagedOperationKindAdapter:
    async def execute(
        _request: AnnotationRequest, _cancel: threading.Event
    ) -> AnnotationResult:
        raise AssertionError("recorded imports must never enter the executor")

    return ManagedOperationKindAdapter(
        kind=kind,
        title="Annotate sequence",
        input_model=AnnotationRequest,
        result_model=AnnotationResult,
        executor=execute,
        recorded_import_model=RecordedAnnotationImport,
        recorded_import_preparer=prepare_recorded_annotation_import,
    )


@pytest.fixture
def store(tmp_path):
    value = ControlPlaneStore(tmp_path / "control.sqlite3")
    value.initialize()
    try:
        yield value
    finally:
        value.close()


@pytest.mark.asyncio
async def test_recorded_success_is_retained_without_execution_or_source_sequence(store):
    marker = "PRIVATE-SEQUENCE-MARKER-ACGT"
    value = receipt(sequence=marker)
    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        adapters=(adapter(),),
        clock=lambda: 200.0,
    )

    snapshot = await service.import_recorded(
        principal(), import_body(value), kind="annotation"
    )

    assert snapshot.state == OperationState.SUCCEEDED
    assert snapshot.origin == OperationOrigin.RECORDED
    assert snapshot.created_at == snapshot.settled_at == 200.0
    assert snapshot.started_at is None
    assert snapshot.provenance is not None
    assert snapshot.provenance.reported_run_id == value["run_id"]
    assert snapshot.provenance.reported_started_at == datetime(
        2026, 9, 9, 12, tzinfo=timezone.utc
    )
    assert snapshot.provenance.resources == {
        "custom": None,
        "snapgene": "2026.09",
    }
    assert snapshot.provenance.inputs[0].identity == value["input"]["sequence_id"]
    assert snapshot.provenance.inputs[0].size_unit == "bases"
    assert service.get_result(principal(), snapshot.id).result == AnnotationResult(
        features=[], sequence_length=len(marker), error=None
    )
    assert marker.encode() not in store.db_path.read_bytes()
    assert marker not in json.dumps(store.list_managed_operation_actions(snapshot.id))
    await service.aclose()


@pytest.mark.asyncio
async def test_reported_run_is_globally_deduplicated_and_duplicate_precedes_budget(
    store,
):
    value = receipt()
    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        adapters=(adapter(), adapter(kind="other-annotation")),
        max_retained_results=1,
    )
    first = await service.import_recorded(
        principal("human-a"), import_body(value), kind="annotation"
    )
    duplicate = await service.import_recorded(
        principal("human-b"), import_body(value), kind="annotation"
    )
    assert duplicate.id == first.id

    changed = deepcopy(value)
    changed["reference_data"]["versions"]["snapgene"] = "changed"
    with pytest.raises(SubmissionConflict):
        await service.import_recorded(
            principal("human-c"), import_body(changed), kind="annotation"
        )
    with pytest.raises(SubmissionConflict):
        await service.import_recorded(
            principal("human-c"), import_body(value), kind="other-annotation"
        )
    with pytest.raises(OperationResultStorageFull):
        await service.import_recorded(
            principal("human-c"), import_body(receipt()), kind="annotation"
        )

    actions = service.list_actions_page(principal(), first.id, limit=20)
    assert [(item.actor_id, item.outcome) for item in actions.actions[:2]] == [
        ("human-a", "imported"),
        ("human-b", "already_imported"),
    ]
    await service.aclose()


@pytest.mark.asyncio
async def test_cross_runtime_duplicate_is_not_reinserted_or_disclosed(store):
    value = receipt()
    first = ManagedOperationService(
        store=store, runtime_scope="runtime-a", adapters=(adapter(),)
    )
    imported = await first.import_recorded(
        principal(scope="runtime-a"), import_body(value), kind="annotation"
    )
    await first.aclose()

    second = ManagedOperationService(
        store=store, runtime_scope="runtime-b", adapters=(adapter(),)
    )
    with pytest.raises(OperationAccessDenied):
        await second.import_recorded(
            principal(scope="runtime-a"), import_body(value), kind="annotation"
        )
    assert store.get_recorded_managed_operation(value["run_id"])["id"] == imported.id
    assert (
        len(
            store.list_managed_operations(
                runtime_scope="runtime-a", scope_id="runtime-a", limit=10
            )
        )
        == 1
    )
    await second.aclose()


@pytest.mark.asyncio
async def test_action_history_reports_actual_control_actors_and_is_authorized(store):
    value = receipt()
    service = ManagedOperationService(
        store=store, runtime_scope="runtime-a", adapters=(adapter(),)
    )
    imported = await service.import_recorded(
        principal("importer"), import_body(value), kind="annotation"
    )
    settled_stop = await service.request_cancel(principal("stopper"), imported.id)
    assert settled_stop.disposition == "already_settled"
    released = await service.release_result(principal("releaser"), imported.id)
    assert released.disposition == "released"
    duplicate_release = await service.release_result(
        principal("releaser-2"), imported.id
    )
    assert duplicate_release.disposition == "already_released"

    page = service.list_actions_page(principal(), imported.id, limit=2)
    assert page.total == 4
    assert page.next_offset == 2
    assert page.omitted_count == 0
    assert page.history_complete is True
    assert [(item.action, item.actor_id, item.outcome) for item in page.actions] == [
        ("import_recorded", "importer", "imported"),
        ("request_cancel", "stopper", "already_settled"),
    ]
    second = service.list_actions_page(principal(), imported.id, limit=2, offset=2)
    assert second.next_offset is None
    assert [(item.action, item.actor_id, item.outcome) for item in second.actions] == [
        ("release_result", "releaser", "released"),
        ("release_result", "releaser-2", "already_released"),
    ]

    with pytest.raises(OperationAccessDenied):
        service.list_actions_page(
            principal(
                "agent-a",
                actor_kind=ActorKind.AGENT,
                capabilities=frozenset({"operations.import"}),
            ),
            imported.id,
        )
    await service.aclose()
