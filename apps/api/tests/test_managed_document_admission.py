from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest

from src.control_plane import ControlPlaneStore


@pytest.fixture
def ledger(tmp_path):
    store = ControlPlaneStore(tmp_path / "document-admission.sqlite3")
    store.initialize()
    try:
        yield store
    finally:
        store.close()


def operation(store, key="first", *, scope_id="workspace-a"):
    operation_id = store.insert_managed_operation(
        runtime_scope="runtime-a",
        scope_id=scope_id,
        kind="annotation",
        subject_id=f"document-{key}",
        input_revision="sha256:input",
        submission_key=key,
        submission_payload_hash=key,
        actor_kind="human",
        actor_id="human-a",
        channel="managed_cli",
        owner_instance_id="execution-owner",
        now=1.0,
    )
    store.put_managed_operation_result(
        operation_id, payload={"features": []}, size_bytes=15
    )
    store.transition_managed_operation(
        operation_id,
        expected_states={"queued"},
        state="succeeded",
        owner_instance_id="execution-owner",
        now=1.5,
        result_status="available",
        mark_settled=True,
    )
    return operation_id


def admit(store, operation_id, action_id="document-action-a", **overrides):
    arguments = {
        "operation_id": operation_id,
        "runtime_scope": "runtime-a",
        "action_id": action_id,
        "actor_kind": "human",
        "actor_id": "human-a",
        "channel": "managed_cli",
        "target_document_id": store.get_managed_operation(operation_id)["subject_id"],
        "native_owner_instance_id": "native-owner-a",
        "request_sha256": f"sha256:{'a' * 64}",
        "recorded_at": 2.0,
        "max_pending": 2,
    }
    arguments.update(overrides)
    return store.admit_managed_document_action(**arguments)


def test_repeated_admission_preserves_the_original_caller_identity(ledger):
    operation_id = operation(ledger)
    first = admit(ledger, operation_id)
    assert first.status == "admitted"
    assert first.record["actor_kind"] == "human"
    assert first.record["actor_id"] == "human-a"
    assert first.record["channel"] == "managed_cli"
    duplicate = admit(ledger, operation_id, recorded_at=3.0)
    assert duplicate.status == "existing"
    assert duplicate.record == first.record
    assert ledger.page_managed_operation_actions(operation_id)[1] == 1


@pytest.mark.parametrize(
    "change",
    [
        {"actor_kind": "agent", "actor_id": "agent-a", "channel": "agent"},
        {"channel": "desktop_ui"},
        {"request_sha256": f"sha256:{'b' * 64}"},
        {"target_document_id": "another-document"},
    ],
)
def test_one_action_identity_cannot_be_rebound_to_another_request(ledger, change):
    operation_id = operation(ledger)
    first = admit(ledger, operation_id)
    conflict = admit(ledger, operation_id, **change)
    assert conflict.status == "conflict"
    assert conflict.record is None
    assert ledger.page_managed_operation_actions(operation_id)[0] == [first.record]


def test_two_database_connections_cannot_admit_competing_writes_for_one_operation(
    ledger,
):
    operation_id = operation(ledger)
    other = ControlPlaneStore(ledger.db_path)
    other.initialize()
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(admit, store, operation_id, f"action-{index}")
                for index, store in enumerate((ledger, other))
            ]
            outcomes = [future.result(timeout=5) for future in futures]
        assert sorted(result.status for result in outcomes) == ["admitted", "busy"]
        assert ledger.page_managed_operation_actions(operation_id)[1] == 1
    finally:
        other.close()


def test_pending_capacity_is_shared_across_operations_and_preserved_on_restart(ledger):
    operations = [operation(ledger, key) for key in ("one", "two", "three")]
    assert admit(ledger, operations[0], "action-one").status == "admitted"
    assert admit(ledger, operations[1], "action-two").status == "admitted"
    other = ControlPlaneStore(ledger.db_path)
    other.initialize()
    try:
        assert admit(other, operations[2], "action-three").status == "full"
        assert other.page_managed_operation_actions(operations[2])[1] == 0
    finally:
        other.close()


def test_foreign_runtime_cannot_claim_an_operation(ledger):
    operation_id = operation(ledger)
    assert (
        admit(ledger, operation_id, runtime_scope="another-runtime").status
        == "not_found"
    )
    assert ledger.page_managed_operation_actions(operation_id)[1] == 0


def test_a_released_result_cannot_be_claimed_for_a_new_document_write(ledger):
    operation_id = operation(ledger)
    ledger.delete_managed_operation_result(operation_id)
    ledger.mark_managed_operation_result_released(
        operation_id, runtime_scope="runtime-a", now=3.0
    )
    assert admit(ledger, operation_id).status == "unavailable"
    assert ledger.page_managed_operation_actions(operation_id)[1] == 0


def test_missing_result_payload_cannot_be_claimed_even_when_metadata_says_available(
    ledger,
):
    operation_id = operation(ledger)
    ledger.delete_managed_operation_result(operation_id)
    assert admit(ledger, operation_id).status == "unavailable"
    assert ledger.page_managed_operation_actions(operation_id)[1] == 0


def test_existing_receipt_is_still_returned_when_its_result_is_no_longer_available(
    ledger,
):
    operation_id = operation(ledger)
    first = admit(ledger, operation_id)
    ledger.delete_managed_operation_result(operation_id)
    replay = admit(ledger, operation_id)
    assert replay.status == "existing"
    assert replay.record == first.record
