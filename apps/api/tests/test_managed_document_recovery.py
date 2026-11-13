from __future__ import annotations

import pytest

from src.control_plane import ControlPlaneStore
from src.operations.document_actions import (
    DocumentWriteSettlement,
    ManagedDocumentActionJournal,
)
from tests.test_managed_document_admission import admit, operation
from tests.test_managed_document_journal import (
    begin,
    finish,
    intent,
)


@pytest.fixture
def state(tmp_path):
    store = ControlPlaneStore(tmp_path / "recovery.sqlite3")
    store.initialize()
    operation_id = operation(store)
    admit(store, operation_id)
    journal = ManagedDocumentActionJournal(
        store=store,
        runtime_scope="runtime-a",
        native_owner_instance_id="native-owner-a",
        clock=lambda: 4.0,
    )
    try:
        yield store, operation_id, journal
    finally:
        store.close()


def recovered_journal(store, *, owner="native-owner-b", scope="runtime-a"):
    return ManagedDocumentActionJournal(
        store=store,
        runtime_scope=scope,
        native_owner_instance_id=owner,
        clock=lambda: 8.0,
    )


def observe(journal, *, previous_owner="native-owner-a", **changes):
    values = {
        "status": "saved",
        "observed_sha256": intent().after_sha256,
        "target_revision": intent().target_revision,
        "checkpoint": {"status": "committed", "commit": "b" * 40},
    }
    values.update(changes)
    return journal.recover(
        action_id="document-action-a",
        request_sha256=f"sha256:{'a' * 64}",
        previous_native_owner_instance_id=previous_owner,
        observation=DocumentWriteSettlement(**values),
    )


def test_a_new_owner_records_an_observed_save_without_taking_credit_for_the_original_action(
    state,
):
    store, operation_id, original = state
    begin(original)
    before = store.get_managed_operation_action("document-action-a")
    successor = recovered_journal(store)
    assert begin(successor).status == "conflict"
    result = observe(successor)
    assert result.status == "recorded"
    for field in (
        "actor_kind",
        "actor_id",
        "channel",
        "recorded_at",
        "id",
        "operation_id",
    ):
        assert result.record[field] == before[field]
    details = result.record["details_json"]
    assert details["native_owner_instance_id"] == "native-owner-a"
    assert details["recovered_by_native_owner_instance_id"] == "native-owner-b"
    assert details["recovered_at"] == 8.0
    assert not store.has_pending_managed_document_action(operation_id)
    assert begin(original).status == "existing"
    assert begin(successor).status == "conflict"


def test_recovery_of_unchanged_bytes_releases_the_retained_result_pin(state):
    store, operation_id, original = state
    begin(original)
    result = observe(
        recovered_journal(store),
        status="save-failed",
        observed_sha256=intent().before_sha256,
        target_revision=None,
        checkpoint=None,
        reason="The original file was observed after the previous owner ended",
    )
    assert result.status == "recorded"
    assert not store.has_pending_managed_document_action(operation_id)


def test_changed_unknown_bytes_remain_unresolved_and_never_receive_write_permission(
    state,
):
    store, operation_id, original = state
    begin(original)
    successor = recovered_journal(store)
    result = observe(
        successor,
        status="outcome-unresolved",
        observed_sha256=f"sha256:{'9' * 64}",
        target_revision=None,
        checkpoint=None,
        reason="Current bytes match neither recorded file",
    )
    assert result.status == "recorded"
    assert store.has_pending_managed_document_action(operation_id)
    assert begin(successor).status == "conflict"
    assert begin(original).status == "existing"


@pytest.mark.parametrize("binding", ["same-owner", "wrong-owner", "foreign-runtime"])
def test_recovery_requires_the_expected_previous_owner_and_same_runtime(state, binding):
    store, _, original = state
    begin(original)
    successor = recovered_journal(
        store,
        owner="native-owner-a" if binding == "same-owner" else "native-owner-b",
        scope="other-runtime" if binding == "foreign-runtime" else "runtime-a",
    )
    result = observe(
        successor,
        previous_owner="wrong-owner" if binding == "wrong-owner" else "native-owner-a",
    )
    assert result.status == "conflict"
    assert (
        store.get_managed_operation_action("document-action-a")["outcome"]
        == "document_writing"
    )


def test_a_restarted_owner_cannot_claim_that_an_old_writer_never_published(state):
    store, _, original = state
    begin(original)
    result = observe(
        recovered_journal(store),
        status="save-failed",
        observed_sha256=intent().before_sha256,
        target_revision=None,
        checkpoint=None,
        write_disposition="not-published",
    )
    assert result.status == "conflict"


def test_admission_without_a_write_intent_can_be_closed_after_owner_exit(state):
    store, operation_id, _ = state
    successor = recovered_journal(store)
    assert observe(successor).status == "conflict"
    result = observe(
        successor,
        status="blocked",
        observed_sha256=None,
        target_revision=None,
        checkpoint=None,
        reason="Previous owner ended before granting file publication",
    )
    assert result.status == "recorded"
    assert not store.has_pending_managed_document_action(operation_id)


def test_repeated_recovery_is_idempotent_and_cannot_replace_a_terminal_checkpoint(
    state,
):
    store, _, original = state
    begin(original)
    successor = recovered_journal(store)
    assert observe(successor).status == "recorded"
    assert observe(successor).status == "existing"
    assert (
        observe(
            successor, checkpoint={"status": "committed", "commit": "c" * 40}
        ).status
        == "conflict"
    )
    assert (
        finish(original, checkpoint={"status": "failed", "reason": "different"}).status
        == "conflict"
    )


def test_recovery_is_retained_across_independent_database_connections(state):
    store, operation_id, original = state
    begin(original)
    other = ControlPlaneStore(store.db_path)
    other.initialize()
    try:
        result = observe(recovered_journal(other))
        assert result.status == "recorded"
        assert store.get_managed_operation_action("document-action-a") == result.record
        assert not store.has_pending_managed_document_action(operation_id)
    finally:
        other.close()
    reopened = ControlPlaneStore(store.db_path)
    reopened.initialize()
    try:
        assert (
            observe(recovered_journal(reopened, owner="native-owner-c")).status
            == "existing"
        )
        assert (
            reopened.get_managed_operation_action("document-action-a")["details_json"][
                "recovered_by_native_owner_instance_id"
            ]
            == "native-owner-b"
        )
    finally:
        reopened.close()
