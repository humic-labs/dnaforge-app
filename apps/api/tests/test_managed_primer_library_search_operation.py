from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

import pytest

from src.control_plane import ControlPlaneStore
from src.managed_operation_agent_tools import managed_operation_tool_definitions
from src.managed_operations import MANAGED_OPERATION_SYSTEM
from src.managed_primer_library_search import execute_managed_primer_library_search
from src.operation_kinds import (
    PRIMER_LIBRARY_SEARCH_OPERATION_KIND,
)
from src.operations import (
    ActorKind,
    CancellationAvailability,
    CancellationMode,
    ClientChannel,
    ManagedOperationService,
    OperationPrincipal,
    OperationState,
)
from src.primer_library_search_operation_audit import (
    primer_library_search_audit_parameters,
)
from src.primer_library_search_operation_contract import (
    PrimerLibrarySearchSubmission,
    prepare_primer_library_search_submission,
    primer_library_search_input_revision,
    primer_library_search_library_revision,
    primer_library_search_target_revision,
)
from src.tools.primer_bind import (
    BatchBindRequest,
    BatchBindResponse,
    BatchPrimerResult,
    BindingHit,
)
from tests.managed_operation_kinds import bind_test_executors


def _submission(
    *,
    key: str,
    target: str = "target-one",
    primer_revision: str = "revision-one",
    max_mismatches: int = 5,
    circular: bool = False,
    region: tuple[int, int] | None = None,
) -> PrimerLibrarySearchSubmission:
    operation_input = {
        "targetDocumentId": "document-a",
        "referenceSequence": target,
        "circular": circular,
        "primers": [
            {
                "id": "primer-a",
                "sequence": "primer-one",
                "revision": primer_revision,
            }
        ],
        "maxEditDistance": 3,
        "minMatchLength": 0,
        "minEffectiveTm": 0,
        "maxMismatches": max_mismatches,
    }
    if region is not None:
        operation_input.update({"regionStart": region[0], "regionEnd": region[1]})
    return PrimerLibrarySearchSubmission.model_validate(
        {
            "submission_key": key,
            "subject": {"scope_id": "workspace-a"},
            "input": operation_input,
        }
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
) -> tuple[ControlPlaneStore, ManagedOperationService]:
    async def unused(_value, _cancel):
        raise AssertionError("an unrelated managed executor must not run")

    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    service = ManagedOperationService(
        store=store,
        runtime_scope="workspace-a",
        adapters=bind_test_executors(
            unused,
            {
                PRIMER_LIBRARY_SEARCH_OPERATION_KIND.key: execute_managed_primer_library_search
            },
        ),
    )
    return store, service


def test_primer_search_identity_covers_target_library_and_constraints() -> None:
    baseline = prepare_primer_library_search_submission(_submission(key="attempt-one"))
    same = prepare_primer_library_search_submission(_submission(key="attempt-two"))

    assert baseline.subject == same.subject
    assert baseline.subject.input_revision == primer_library_search_input_revision(
        baseline.input
    )
    assert baseline.input.target_revision == primer_library_search_target_revision(
        baseline.input
    )
    assert baseline.input.library_revision == primer_library_search_library_revision(
        baseline.input
    )
    assert baseline.subject.subject_id.startswith(
        "primer-library-search-target-v1:sha256:"
    )

    changed_target = prepare_primer_library_search_submission(
        _submission(key="target-changed", target="target-two")
    )
    changed_library = prepare_primer_library_search_submission(
        _submission(key="library-changed", primer_revision="revision-two")
    )
    changed_constraints = prepare_primer_library_search_submission(
        _submission(key="constraints-changed", max_mismatches=2)
    )
    changed_topology = prepare_primer_library_search_submission(
        _submission(key="topology-changed", circular=True)
    )
    changed_region = prepare_primer_library_search_submission(
        _submission(key="region-changed", region=(1, 8))
    )

    assert changed_target.subject.input_revision != baseline.subject.input_revision
    assert changed_library.subject.input_revision != baseline.subject.input_revision
    assert changed_constraints.subject.input_revision != baseline.subject.input_revision
    assert changed_topology.subject.input_revision != baseline.subject.input_revision
    assert changed_region.subject.input_revision != baseline.subject.input_revision
    assert (
        PRIMER_LIBRARY_SEARCH_OPERATION_KIND.cancellation
        == CancellationMode.QUEUED_ONLY
    )
    descriptor = next(
        item
        for item in MANAGED_OPERATION_SYSTEM.descriptors
        if item.kind == "primer-library-search"
    )
    assert descriptor.active_join == "subject_revision"
    assert descriptor.surfaces.http_start == "/operations/primer-library-search"
    assert descriptor.surfaces.cli_submit == (
        "dnaforge jobs submit primer-library-search --request FILE|-"
    )
    assert descriptor.surfaces.agent_start == "operations.primer-library-search.start"
    definitions = {
        definition.spec.name: definition
        for definition in managed_operation_tool_definitions(MANAGED_OPERATION_SYSTEM)
    }
    assert (
        definitions["operations.primer-library-search.start"].spec.inputs
        == PrimerLibrarySearchSubmission.model_json_schema()
    )


def test_primer_search_audit_records_shape_and_hashes_without_sequence_content() -> (
    None
):
    audit = primer_library_search_audit_parameters(
        _submission(key="audit-attempt").model_dump(mode="json", by_alias=True)
    )
    encoded = json.dumps(audit, sort_keys=True)

    assert audit["input"]["target_length"] == len("target-one")
    assert audit["input"]["primer_count"] == 1
    assert audit["input"]["target_document_id_sha256"].startswith("sha256:")
    assert audit["input"]["target_revision"].startswith(
        "primer-search-target-v1:sha256:"
    )
    assert audit["input"]["library_revision"].startswith("primer-library-v1:sha256:")
    assert audit["input"]["circular"] is False
    assert audit["input"]["max_edit_distance"] == 3
    assert audit["input"]["min_match_length"] == 0
    assert audit["input"]["min_effective_tm"] == 0
    assert audit["input"]["max_mismatches"] == 5
    assert "target-one" not in encoded
    assert "primer-one" not in encoded
    assert "document-a" not in encoded


@pytest.mark.asyncio
async def test_active_rejoin_uses_one_matcher_and_changed_input_can_cancel_while_queued(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    matcher_started = threading.Event()
    release_matcher = threading.Event()
    matcher_calls: list[object] = []

    def controlled_matcher(request):
        matcher_calls.append(request)
        matcher_started.set()
        assert release_matcher.wait(timeout=5)
        return BatchBindResponse(
            results=[BatchPrimerResult(primer=request.primers[0], hits=[])]
        )

    monkeypatch.setattr(
        "src.managed_primer_library_search._bind_primers_batch_sync",
        controlled_matcher,
    )
    store, service = _service(tmp_path)
    principal = _principal()

    try:
        first = await service.start(
            principal,
            prepare_primer_library_search_submission(_submission(key="attempt-one")),
            kind="primer-library-search",
        )
        assert await asyncio.to_thread(matcher_started.wait, 2)

        running_cancel = await service.request_cancel(principal, first.id)
        assert running_cancel.disposition == "unavailable"
        assert running_cancel.snapshot.id == first.id
        assert running_cancel.snapshot.state == OperationState.RUNNING
        assert (
            running_cancel.snapshot.cancellation_availability
            == CancellationAvailability.UNAVAILABLE
        )
        assert not release_matcher.is_set()

        joined = await service.start(
            principal,
            prepare_primer_library_search_submission(_submission(key="attempt-two")),
            kind="primer-library-search",
        )
        assert joined.id == first.id
        assert len(matcher_calls) == 1

        changed = await service.start(
            principal,
            prepare_primer_library_search_submission(
                _submission(key="changed", max_mismatches=2)
            ),
            kind="primer-library-search",
        )
        assert changed.id != first.id
        assert changed.state == OperationState.QUEUED

        canceled = await service.request_cancel(principal, changed.id)
        assert canceled.snapshot.state == OperationState.CANCELED
        assert len(matcher_calls) == 1

        release_matcher.set()
        terminal = await service.wait_for_terminal(principal, first.id)
        assert terminal.state == OperationState.SUCCEEDED
        assert len(matcher_calls) == 1

        retry = await service.start(
            principal,
            prepare_primer_library_search_submission(
                _submission(key="post-terminal-retry")
            ),
            kind="primer-library-search",
        )
        assert retry.id != first.id
        retry_terminal = await service.wait_for_terminal(principal, retry.id)
        assert retry_terminal.state == OperationState.SUCCEEDED
        assert len(matcher_calls) == 2
    finally:
        release_matcher.set()
        await service.aclose()
        store.close()


@pytest.mark.asyncio
async def test_executor_pushes_down_a_padded_region_and_returns_absolute_hits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_requests: list[BatchBindRequest] = []

    def controlled_matcher(request):
        captured_requests.append(request)
        return BatchBindResponse(
            results=[
                BatchPrimerResult(
                    primer=request.primers[0],
                    hits=[
                        BindingHit(
                            start=0, end=5, strand=1, identity=1, edit_distance=0
                        ),
                        BindingHit(
                            start=1,
                            end=6,
                            strand=1,
                            identity=0.8,
                            edit_distance=1,
                        ),
                        BindingHit(
                            start=12,
                            end=17,
                            strand=-1,
                            identity=0.8,
                            edit_distance=1,
                        ),
                    ],
                )
            ]
        )

    monkeypatch.setattr(
        "src.managed_primer_library_search._bind_primers_batch_sync",
        controlled_matcher,
    )
    submission = PrimerLibrarySearchSubmission.model_validate(
        {
            "submission_key": "region-attempt",
            "subject": {"scope_id": "workspace-a"},
            "input": {
                "targetDocumentId": "document-a",
                "referenceSequence": "x" * 50,
                "circular": True,
                "primers": [
                    {
                        "id": "primer-a",
                        "sequence": "prime",
                        "revision": "revision-one",
                    }
                ],
                "regionStart": 20,
                "regionEnd": 30,
            },
        }
    )
    operation_input = prepare_primer_library_search_submission(submission).input

    result = await execute_managed_primer_library_search(
        operation_input,
        threading.Event(),
    )

    assert len(captured_requests) == 1
    matcher_request = captured_requests[0]
    assert matcher_request.sequence == "X" * 20
    assert matcher_request.circular is False
    assert matcher_request.primers == ["PRIME"]
    assert [(hit.start, hit.end) for hit in result.results[0].hits] == [
        (16, 21),
        (27, 32),
    ]
    assert result.target_revision == operation_input.target_revision
    assert result.library_revision == operation_input.library_revision
