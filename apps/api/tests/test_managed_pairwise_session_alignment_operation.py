from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import TypeAdapter, ValidationError

from src.control_plane import ControlPlaneStore
from src.managed_operation_agent_tools import managed_operation_tool_definitions
from src.managed_operations import MANAGED_OPERATION_SYSTEM
from src.managed_pairwise_session_alignment import (
    execute_managed_pairwise_session_alignment,
)
from src.operation_kinds import (
    PAIRWISE_SESSION_ALIGNMENT_OPERATION_KIND,
)
from src.operations import (
    ActorKind,
    CancellationMode,
    ClientChannel,
    ManagedOperationService,
    OperationCanceled,
    OperationExecutionError,
    OperationPrincipal,
    OperationState,
)
from src.pairwise_session_alignment_operation_audit import (
    pairwise_session_alignment_audit_parameters,
)
from src.pairwise_session_alignment_operation_contract import (
    MAX_PAIRWISE_QUERY_COUNT,
    MAX_PAIRWISE_SEQUENCE_RESIDUES,
    PairwiseSessionAlignmentInput,
    PairwiseSessionAlignmentResult,
    PairwiseSessionAlignmentSubmission,
    PairwiseSessionAlignmentToolIdentity,
    pairwise_session_alignment_input_revision,
    prepare_pairwise_session_alignment_submission,
)
from src.tools.alignment import AlignmentCanceled, AlignmentResult, MafftRuntime
from tests.managed_operation_kinds import bind_test_executors


def _request(
    *,
    reference: str | None = None,
    query: str | None = None,
    algorithm: str = "auto",
) -> dict[str, object]:
    return {
        "referenceSequence": reference or "N" * 20,
        "queries": [
            {
                "id": "query-one",
                "sequence": query or "N" * 20,
            }
        ],
        "algorithm": algorithm,
        "threads": 2,
        "timeoutSeconds": 120,
        "isCircular": False,
    }


def _submission(
    *,
    key: str,
    document_id: str = "document-one",
    session_id: str = "session-one",
    request: dict[str, object] | None = None,
) -> PairwiseSessionAlignmentSubmission:
    return PairwiseSessionAlignmentSubmission.model_validate(
        {
            "submission_key": key,
            "subject": {
                "scope_id": "workspace-a",
                "document_id": document_id,
                "session_id": session_id,
            },
            "input": request or _request(),
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


def _alignment_result(request: PairwiseSessionAlignmentInput) -> AlignmentResult:
    query = request.queries[0].sequence
    reference = request.reference_sequence
    return AlignmentResult(
        aligned_query=query,
        aligned_reference=reference,
        identity=100,
        matches=len(query),
        mismatches=0,
        gaps=0,
        alignment_length=len(query),
        query_length=len(query),
        reference_length=len(reference),
        mutations=[],
        cached=False,
        circular_offset=0,
        analysis=None,
    )


def test_pairwise_session_alignment_is_one_compiled_joinable_kind() -> None:
    descriptors = {
        descriptor.kind: descriptor
        for descriptor in MANAGED_OPERATION_SYSTEM.descriptors
    }

    descriptor = descriptors["pairwise-session-alignment"]
    assert descriptor.contract_version == 1
    assert descriptor.result_schema_version == 2
    assert descriptor.active_join == "subject_revision"
    assert (
        PAIRWISE_SESSION_ALIGNMENT_OPERATION_KIND.cancellation
        == CancellationMode.COOPERATIVE
    )
    assert descriptor.surfaces.http_start == "/operations/pairwise-session-alignment"
    assert descriptor.surfaces.cli_submit == (
        "dnaforge jobs submit pairwise-session-alignment --request FILE|-"
    )
    assert descriptor.surfaces.agent_start == (
        "operations.pairwise-session-alignment.start"
    )

    definitions = {
        definition.spec.name: definition
        for definition in managed_operation_tool_definitions(MANAGED_OPERATION_SYSTEM)
    }
    assert (
        definitions["operations.pairwise-session-alignment.start"].spec.inputs
        == PairwiseSessionAlignmentSubmission.model_json_schema()
    )


def test_pairwise_identity_binds_session_and_every_scientific_input() -> None:
    baseline = prepare_pairwise_session_alignment_submission(
        _submission(key="attempt-one")
    )
    same = prepare_pairwise_session_alignment_submission(_submission(key="attempt-two"))

    assert same.subject == baseline.subject
    assert baseline.subject.subject_id.startswith(
        "pairwise-session-alignment-subject-v1:sha256:"
    )
    assert baseline.subject.input_revision == pairwise_session_alignment_input_revision(
        baseline.input
    )

    changed_session = prepare_pairwise_session_alignment_submission(
        _submission(key="session-changed", session_id="session-two")
    )
    changed_reference = prepare_pairwise_session_alignment_submission(
        _submission(
            key="reference-changed",
            request=_request(reference="N" * 19 + "A"),
        )
    )
    changed_query = prepare_pairwise_session_alignment_submission(
        _submission(key="query-changed", request=_request(query="N" * 19 + "A"))
    )
    changed_algorithm = prepare_pairwise_session_alignment_submission(
        _submission(key="algorithm-changed", request=_request(algorithm="fast"))
    )

    assert changed_session.subject.subject_id != baseline.subject.subject_id
    assert changed_session.subject.input_revision == baseline.subject.input_revision
    assert changed_reference.subject.input_revision != baseline.subject.input_revision
    assert changed_query.subject.input_revision != baseline.subject.input_revision
    assert changed_algorithm.subject.input_revision != baseline.subject.input_revision


def test_pairwise_audit_hashes_identity_and_sequence_content() -> None:
    submission = _submission(
        key="audit-attempt",
        document_id="private/document/path",
        session_id="private-session",
    )
    audit = pairwise_session_alignment_audit_parameters(
        submission.model_dump(mode="json", by_alias=True)
    )
    encoded = json.dumps(audit, sort_keys=True)

    assert audit["input"]["query_count"] == 1
    assert audit["input"]["reference_length"] == 20
    assert audit["input"]["query_lengths"] == [20]
    assert audit["input"]["reference_sha256"].startswith("sha256:")
    assert audit["input"]["query_sha256"][0].startswith("sha256:")
    assert "private/document/path" not in encoded
    assert "private-session" not in encoded
    assert "N" * 20 not in encoded


def test_pairwise_input_is_bounded_before_compute() -> None:
    too_many_queries = _request()
    too_many_queries["queries"] = [
        {"id": f"query-{index}", "sequence": "N" * 20}
        for index in range(MAX_PAIRWISE_QUERY_COUNT + 1)
    ]
    with pytest.raises(ValidationError):
        _submission(key="too-many", request=too_many_queries)

    with pytest.raises(ValidationError):
        _submission(
            key="too-long",
            request=_request(reference="N" * (MAX_PAIRWISE_SEQUENCE_RESIDUES + 1)),
        )


@pytest.mark.asyncio
async def test_executor_preserves_query_identity_and_forwards_cooperative_cancel(
    monkeypatch: pytest.MonkeyPatch,
    managed_tool_runtime: MafftRuntime,
) -> None:
    prepared = prepare_pairwise_session_alignment_submission(_submission(key="execute"))
    observed_cancel: list[threading.Event] = []

    async def controlled_pairwise(
        request, *, timeout_seconds, cancel_event, runtime, deadline
    ):
        assert request.query == prepared.input.queries[0].sequence
        assert request.reference == prepared.input.reference_sequence
        assert request.use_cache is False
        assert 0 < timeout_seconds <= prepared.input.timeout_seconds
        assert runtime is managed_tool_runtime
        assert deadline > asyncio.get_running_loop().time()
        observed_cancel.append(cancel_event)
        return _alignment_result(prepared.input)

    monkeypatch.setattr(
        "src.managed_pairwise_session_alignment._execute_pairwise_alignment",
        controlled_pairwise,
    )
    cancel_event = threading.Event()

    result = await execute_managed_pairwise_session_alignment(
        prepared.input,
        cancel_event,
    )

    assert observed_cancel == [cancel_event]
    assert result.input_revision == prepared.subject.input_revision
    assert result.reference_revision == prepared.input.reference_revision
    assert [row.query_id for row in result.results] == ["query-one"]
    assert result.results[0].query_revision == prepared.input.queries[0].revision
    assert result.results[0].alignment.identity == 100
    assert result.tool == PairwiseSessionAlignmentToolIdentity(
        name="MAFFT", version="v7.526 (2024/Apr/26)"
    )


@pytest.mark.asyncio
async def test_executor_is_atomic_and_drains_siblings_after_one_query_fails(
    monkeypatch: pytest.MonkeyPatch,
    managed_tool_runtime: MafftRuntime,
) -> None:
    request = _request(query="N" * 19 + "A")
    request["queries"] = [
        {"id": "query-fails", "sequence": "N" * 19 + "A"},
        {"id": "query-sibling", "sequence": "N" * 19 + "C"},
    ]
    prepared = prepare_pairwise_session_alignment_submission(
        _submission(key="atomic-failure", request=request)
    )
    both_started = asyncio.Event()
    sibling_settled = asyncio.Event()
    started = 0

    async def controlled_pairwise(
        value, *, timeout_seconds, cancel_event, runtime, deadline
    ):
        nonlocal started
        started += 1
        if started == 2:
            both_started.set()
        await both_started.wait()
        if value.query.endswith("A"):
            raise HTTPException(status_code=500, detail="controlled failure")
        try:
            while not cancel_event.is_set():
                await asyncio.sleep(0.01)
            raise OperationCanceled("sibling canceled")
        finally:
            sibling_settled.set()

    monkeypatch.setattr(
        "src.managed_pairwise_session_alignment._execute_pairwise_alignment",
        controlled_pairwise,
    )
    cancel_event = threading.Event()

    with pytest.raises(OperationExecutionError) as raised:
        await execute_managed_pairwise_session_alignment(prepared.input, cancel_event)

    assert raised.value.payload.code == "PAIRWISE_ALIGNMENT_FAILED"
    assert cancel_event.is_set()
    assert sibling_settled.is_set()


@pytest.mark.asyncio
async def test_explicit_e2e_barrier_is_test_only_and_cooperatively_cancelable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prepared = prepare_pairwise_session_alignment_submission(
        _submission(key="barrier-cancel")
    )
    monkeypatch.setenv("WAYPOINT_TEST", "1")
    monkeypatch.setenv("WAYPOINT_PAIRWISE_SESSION_E2E_BARRIER", str(tmp_path))
    cancel_event = threading.Event()
    execution = asyncio.create_task(
        execute_managed_pairwise_session_alignment(prepared.input, cancel_event)
    )

    async def marker_exists() -> bool:
        for _ in range(100):
            if list(tmp_path.glob("entered-*")):
                return True
            await asyncio.sleep(0.01)
        return False

    assert await marker_exists()
    cancel_event.set()
    with pytest.raises(OperationCanceled):
        await asyncio.wait_for(execution, timeout=1)
    assert len(list(tmp_path.glob("entered-*"))) == 1


@pytest.mark.asyncio
async def test_active_rejoin_runs_one_executor_and_running_stop_is_cooperative(
    tmp_path: Path,
) -> None:
    entered = asyncio.Event()
    executor_calls = 0

    async def controlled_executor(value, cancel_event: threading.Event):
        nonlocal executor_calls
        executor_calls += 1
        entered.set()
        while not cancel_event.is_set():
            await asyncio.sleep(0.01)
        raise OperationCanceled("Pairwise session alignment was canceled")

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
                PAIRWISE_SESSION_ALIGNMENT_OPERATION_KIND.key: controlled_executor,
            },
        ),
    )
    principal = _principal()

    try:
        first = await service.start(
            principal,
            prepare_pairwise_session_alignment_submission(
                _submission(key="attempt-one")
            ),
            kind="pairwise-session-alignment",
        )
        await asyncio.wait_for(entered.wait(), timeout=1)

        joined = await service.start(
            principal,
            prepare_pairwise_session_alignment_submission(
                _submission(key="attempt-two")
            ),
            kind="pairwise-session-alignment",
        )
        assert joined.id == first.id
        assert executor_calls == 1

        canceled = await service.request_cancel(principal, first.id)
        terminal = await service.wait_for_terminal(principal, first.id)
        assert canceled.disposition == "accepted"
        assert terminal.state == OperationState.CANCELED
        assert executor_calls == 1
    finally:
        await service.aclose()
        store.close()


@pytest.fixture
def managed_tool_runtime(monkeypatch: pytest.MonkeyPatch) -> MafftRuntime:
    """Controlled tool identity for tests whose scientific executor is mocked."""
    runtime = MafftRuntime("/test-only/mafft", {"MAFFT_BINARIES": "/test-only/libexec"})
    monkeypatch.setattr(
        "src.managed_pairwise_session_alignment.resolve_mafft_runtime", lambda: runtime
    )

    async def version(actual, *, deadline, cancel_event):
        assert actual is runtime
        assert deadline > asyncio.get_running_loop().time()
        return "v7.526 (2024/Apr/26)"

    monkeypatch.setattr(
        "src.managed_pairwise_session_alignment.read_mafft_version", version
    )
    return runtime


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "version", ["unknown", "Railway account help", "", "v7.526\nhelp"]
)
async def test_invalid_actual_version_never_starts_query_work(
    monkeypatch, managed_tool_runtime, version
):
    async def invalid_version(*_args, **_kwargs):
        return version

    async def must_not_align(*_args, **_kwargs):
        raise AssertionError("Invalid tool identity must not enter query execution")

    monkeypatch.setattr(
        "src.managed_pairwise_session_alignment.read_mafft_version", invalid_version
    )
    monkeypatch.setattr(
        "src.managed_pairwise_session_alignment._execute_pairwise_alignment",
        must_not_align,
    )
    prepared = prepare_pairwise_session_alignment_submission(
        _submission(key="invalid-version")
    )
    with pytest.raises(OperationExecutionError) as raised:
        await execute_managed_pairwise_session_alignment(
            prepared.input, threading.Event()
        )
    assert raised.value.payload.code == "PAIRWISE_ALIGNMENT_TOOL_IDENTITY_UNAVAILABLE"


@pytest.mark.asyncio
async def test_version_probe_cancellation_preserves_owner_canceled_outcome(
    monkeypatch, managed_tool_runtime
):
    async def canceled(*_args, **_kwargs):
        raise AlignmentCanceled("physically stopped")

    monkeypatch.setattr(
        "src.managed_pairwise_session_alignment.read_mafft_version", canceled
    )
    prepared = prepare_pairwise_session_alignment_submission(
        _submission(key="version-cancel")
    )
    with pytest.raises(OperationCanceled):
        await execute_managed_pairwise_session_alignment(
            prepared.input, threading.Event()
        )


@pytest.mark.asyncio
async def test_query_work_does_not_start_after_probe_consumes_total_budget(
    monkeypatch, managed_tool_runtime
):
    async def exhausted(*_args, **_kwargs):
        await asyncio.sleep(1.01)
        return "v7.526 (2024/Apr/26)"

    async def must_not_align(*_args, **_kwargs):
        raise AssertionError("No query may be created after the request deadline")

    monkeypatch.setattr(
        "src.managed_pairwise_session_alignment.read_mafft_version", exhausted
    )
    monkeypatch.setattr(
        "src.managed_pairwise_session_alignment._execute_pairwise_alignment",
        must_not_align,
    )
    request = _request()
    request["timeoutSeconds"] = 1
    prepared = prepare_pairwise_session_alignment_submission(
        _submission(key="probe-budget", request=request)
    )
    with pytest.raises(OperationExecutionError) as raised:
        await execute_managed_pairwise_session_alignment(
            prepared.input, threading.Event()
        )
    assert raised.value.payload.code == "PAIRWISE_ALIGNMENT_TIMEOUT"


def test_pairwise_result_versions_require_real_identity_only_for_new_results():
    prepared = prepare_pairwise_session_alignment_submission(
        _submission(key="legacy-result")
    )
    payload = {
        "inputRevision": prepared.subject.input_revision,
        "referenceRevision": prepared.input.reference_revision,
        "results": [
            {
                "queryId": "query-one",
                "queryRevision": prepared.input.queries[0].revision,
                "alignment": _alignment_result(prepared.input).model_dump(mode="json"),
            }
        ],
    }
    legacy = MANAGED_OPERATION_SYSTEM.decode_result(
        kind="pairwise-session-alignment", result_schema_version=1, payload=payload
    )
    assert legacy.tool is None
    assert "tool" not in legacy.model_dump(mode="json")
    with pytest.raises(ValueError, match="requires tool identity"):
        MANAGED_OPERATION_SYSTEM.decode_result(
            kind="pairwise-session-alignment", result_schema_version=2, payload=payload
        )
    current = {**payload, "tool": {"name": "MAFFT", "version": "v7.526 (2024/Apr/26)"}}
    decoded = MANAGED_OPERATION_SYSTEM.decode_result(
        kind="pairwise-session-alignment", result_schema_version=2, payload=current
    )
    assert decoded.tool.version == current["tool"]["version"]
    with pytest.raises(ValueError, match="Legacy"):
        MANAGED_OPERATION_SYSTEM.decode_result(
            kind="pairwise-session-alignment", result_schema_version=1, payload=current
        )


@pytest.mark.asyncio
async def test_tool_identity_survives_sqlite_owner_reopen_and_legacy_read(tmp_path):
    prepared = prepare_pairwise_session_alignment_submission(
        _submission(key="retained-tool")
    )

    async def controlled_executor(value, _cancel):
        return PairwiseSessionAlignmentResult(
            inputRevision=prepared.subject.input_revision,
            referenceRevision=value.reference_revision,
            results=[
                {
                    "queryId": value.queries[0].id,
                    "queryRevision": value.queries[0].revision,
                    "alignment": _alignment_result(value),
                }
            ],
            tool=PairwiseSessionAlignmentToolIdentity(
                name="MAFFT", version="v7.526 (2024/Apr/26)"
            ),
        )

    adapters = bind_test_executors(controlled_executor)
    path = tmp_path / "retained-tool.sqlite3"
    store = ControlPlaneStore(path)
    store.initialize()
    service = ManagedOperationService(
        store=store, runtime_scope="workspace-a", adapters=adapters
    )
    try:
        operation = await service.start(
            _principal(), prepared, kind="pairwise-session-alignment"
        )
        await asyncio.wait_for(
            service.wait_for_terminal(_principal(), operation.id), timeout=2
        )
        first = service.get_result(_principal(), operation.id)
        assert first.result_schema_version == 2
        assert first.result.tool.version == "v7.526 (2024/Apr/26)"
    finally:
        await service.aclose()
        store.close()
    reopened = ControlPlaneStore(path)
    reopened.initialize()
    reader = ManagedOperationService(
        store=reopened, runtime_scope="workspace-a", adapters=adapters
    )
    try:
        retained = reader.get_result(_principal(), operation.id)
        assert retained == first
        legacy = retained.result.model_dump(mode="json")
        legacy.pop("tool")
        reopened.put_managed_operation_result(
            operation.id,
            payload=legacy,
            size_bytes=len(json.dumps(legacy)),
            result_schema_version=1,
        )
        historical = reader.get_result(_principal(), operation.id)
        assert historical.result_schema_version == 1
        compiled = TypeAdapter(
            MANAGED_OPERATION_SYSTEM.result_envelope
        ).validate_python(historical.model_dump(mode="json", by_alias=True))
        assert compiled.result_schema_version == 1
        assert historical.result.tool is None
        assert historical.result.input_revision == retained.result.input_revision
    finally:
        await reader.aclose()
        reopened.close()
