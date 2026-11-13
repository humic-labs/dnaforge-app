from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest

from src.control_plane import ControlPlaneStore
from src.operations.document_actions import (
    DocumentWriteIntent,
    ManagedDocumentActionJournal,
)
from tests.test_managed_document_admission import admit, operation


@pytest.fixture
def state(tmp_path):
    store = ControlPlaneStore(tmp_path / "journal.sqlite3")
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


def intent(**changes):
    values = {
        "before_sha256": f"sha256:{'1' * 64}",
        "after_sha256": f"sha256:{'2' * 64}",
        "target_revision": f"annotation-document-v1:sha256:{'3' * 64}",
        "selection_sha256": f"sha256:{'4' * 64}",
        "selection_count": 2,
    }
    values.update(changes)
    return DocumentWriteIntent(**values)


def begin(journal, **changes):
    values = {
        "action_id": "document-action-a",
        "request_sha256": f"sha256:{'a' * 64}",
        "intent": intent(),
        "revalidate": lambda: None,
    }
    values.update(changes)
    return journal.begin_write(**values)


def finish(journal, **changes):
    values = {
        "action_id": "document-action-a",
        "request_sha256": f"sha256:{'a' * 64}",
        "status": "saved",
        "observed_sha256": intent().after_sha256,
        "target_revision": intent().target_revision,
        "checkpoint": {"status": "committed", "commit": "b" * 40},
    }
    values.update(changes)
    return journal.settle(**values)


def test_write_permission_follows_an_independently_visible_durable_intent(state):
    store, operation_id, journal = state
    observer = ControlPlaneStore(store.db_path)
    observer.initialize()
    try:

        def revalidate():
            assert store._conn.execute("PRAGMA synchronous").fetchone()[0] == 2
            assert (
                observer.get_managed_operation_action("document-action-a")["outcome"]
                == "document_admitted"
            )

        result = begin(journal, revalidate=revalidate)
        assert result.status == "permitted"
        recorded = observer.page_managed_operation_actions(operation_id)[0][0]
        assert recorded["outcome"] == "document_writing"
        assert recorded["details_json"]["write_intent"] == intent().model_dump()
        assert store._conn.execute("PRAGMA synchronous").fetchone()[0] == 1
    finally:
        observer.close()


def test_revoked_authority_never_receives_write_permission(state):
    store, operation_id, journal = state

    def revoked():
        raise PermissionError("The caller's grant was revoked")

    with pytest.raises(PermissionError, match="revoked"):
        begin(journal, revalidate=revoked)
    row = store.page_managed_operation_actions(operation_id)[0][0]
    assert row["outcome"] == "document_admitted"
    assert "write_intent" not in row["details_json"]


def test_two_connections_cannot_obtain_permission_to_write_the_same_action_twice(state):
    store, _, journal = state
    other = ControlPlaneStore(store.db_path)
    other.initialize()
    second = ManagedDocumentActionJournal(
        store=other,
        runtime_scope="runtime-a",
        native_owner_instance_id="native-owner-a",
    )
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(begin, (journal, second)))
        assert sorted(result.status for result in results) == ["existing", "permitted"]
    finally:
        other.close()


@pytest.mark.parametrize(
    "binding",
    [{"runtime_scope": "foreign"}, {"native_owner_instance_id": "another-owner"}],
)
def test_other_runtime_or_native_owner_cannot_advance_an_action(state, binding):
    store, operation_id, _ = state
    args = {
        "store": store,
        "runtime_scope": "runtime-a",
        "native_owner_instance_id": "native-owner-a",
    }
    args.update(binding)
    assert begin(ManagedDocumentActionJournal(**args)).status == "conflict"
    assert (
        store.page_managed_operation_actions(operation_id)[0][0]["outcome"]
        == "document_admitted"
    )


def test_request_and_write_intent_cannot_be_replaced_on_replay(state):
    _, _, journal = state
    assert begin(journal).status == "permitted"
    assert begin(journal, request_sha256=f"sha256:{'c' * 64}").status == "conflict"
    assert begin(journal, intent=intent(selection_count=3)).status == "conflict"
    assert begin(journal).status == "existing"


def test_saved_receipt_requires_a_prior_intent_and_the_exact_intended_file(state):
    store, operation_id, journal = state
    assert finish(journal).status == "conflict"
    assert begin(journal).status == "permitted"
    assert finish(journal, observed_sha256=intent().before_sha256).status == "conflict"
    assert finish(journal, target_revision="wrong-revision").status == "conflict"
    assert store.has_pending_managed_document_action(operation_id)


def test_saved_receipt_keeps_actual_caller_and_never_rewrites_a_terminal_result(state):
    store, operation_id, journal = state
    begin(journal)
    saved = finish(journal)
    assert saved.status == "recorded"
    assert saved.record["outcome"] == "document_saved"
    assert (
        saved.record["actor_kind"],
        saved.record["actor_id"],
        saved.record["channel"],
    ) == ("human", "human-a", "managed_cli")
    assert not store.has_pending_managed_document_action(operation_id)
    assert finish(journal).status == "existing"
    assert (
        finish(
            journal, checkpoint={"status": "failed", "reason": "later failure"}
        ).status
        == "conflict"
    )
    assert store.page_managed_operation_actions(operation_id)[0] == [saved.record]


def test_an_ambiguous_write_stays_pinned_and_does_not_receive_replay_permission(state):
    store, operation_id, journal = state
    begin(journal)
    unresolved = finish(
        journal,
        status="outcome-unresolved",
        observed_sha256=None,
        target_revision=None,
        checkpoint=None,
        reason="connection lost",
    )
    assert unresolved.status == "recorded"
    assert unresolved.record["outcome"] == "document_outcome_unresolved"
    assert store.has_pending_managed_document_action(operation_id)
    assert begin(journal).status == "existing"
    assert finish(journal).status == "recorded"
    assert not store.has_pending_managed_document_action(operation_id)


def test_failure_after_intent_requires_observation_of_the_unchanged_file(state):
    store, operation_id, journal = state
    begin(journal)
    values = {
        "status": "save-failed",
        "observed_sha256": None,
        "target_revision": None,
        "checkpoint": None,
        "reason": "write failed",
    }
    assert finish(journal, **values).status == "conflict"
    assert store.has_pending_managed_document_action(operation_id)
    values["observed_sha256"] = intent().before_sha256
    assert finish(journal, **values).status == "recorded"
    assert not store.has_pending_managed_document_action(operation_id)


def test_preparation_refusal_can_settle_without_any_write_intent(state):
    store, operation_id, journal = state
    result = finish(
        journal,
        status="blocked",
        observed_sha256=None,
        target_revision=None,
        checkpoint=None,
        reason="Unsaved edits",
    )
    assert result.status == "recorded"
    assert result.record["outcome"] == "document_blocked"
    assert not store.has_pending_managed_document_action(operation_id)
    assert begin(journal).status == "existing"


def test_native_precondition_refusal_can_record_an_external_winner_without_claiming_unchanged_bytes(
    state,
):
    store, operation_id, journal = state
    begin(journal)
    external_hash = f"sha256:{'9' * 64}"
    result = finish(
        journal,
        status="save-failed",
        observed_sha256=external_hash,
        target_revision=None,
        checkpoint=None,
        write_disposition="not-published",
        reason="The file changed before publication; this action did not replace it",
    )
    assert result.status == "recorded"
    assert (
        result.record["details_json"]["settlement"]["observed_sha256"] == external_hash
    )
    assert not store.has_pending_managed_document_action(operation_id)


def test_different_observed_bytes_alone_do_not_prove_a_failed_write(state):
    store, operation_id, journal = state
    begin(journal)
    assert (
        finish(
            journal,
            status="save-failed",
            observed_sha256=f"sha256:{'9' * 64}",
            target_revision=None,
            checkpoint=None,
        ).status
        == "conflict"
    )
    assert store.has_pending_managed_document_action(operation_id)


def test_a_saved_receipt_cannot_simultaneously_claim_no_publication(state):
    _, _, journal = state
    begin(journal)
    assert finish(journal, write_disposition="not-published").status == "conflict"
