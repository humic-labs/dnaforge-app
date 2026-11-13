from __future__ import annotations

import pytest

from src.control_plane import ControlPlaneStore
from src.operations.document_actions import ManagedDocumentActionJournal
from tests.test_managed_document_admission import admit, operation


@pytest.fixture
def ledger(tmp_path):
    store = ControlPlaneStore(tmp_path / "pending.sqlite3")
    store.initialize()
    try:
        yield store
    finally:
        store.close()


def pending(store, *, scope="runtime-a", **page):
    return ManagedDocumentActionJournal(
        store=store, runtime_scope=scope, native_owner_instance_id="native-owner-b"
    ).pending(**page)


def test_pending_page_keeps_its_place_when_preceding_actions_settle(ledger):
    for name in ("a", "b", "c"):
        assert (
            admit(ledger, operation(ledger, name), action_id=name, max_pending=8).status
            == "admitted"
        )
    first = pending(ledger, limit=2)
    assert [row["id"] for row in first.actions] == ["a", "b"]
    assert first.next_action_id == "b"
    assert first.native_owner_instance_id == "native-owner-b"
    for name in ("a", "b"):
        row = ledger.get_managed_operation_action(name)
        ledger.transition_managed_document_action(
            action_id=name,
            expected_outcome="document_admitted",
            outcome="document_blocked",
            details=row["details_json"],
        )
    second = pending(ledger, limit=2, after_action_id=first.next_action_id)
    assert [row["id"] for row in second.actions] == ["c"]
    assert second.next_action_id is None


def test_pending_observation_is_scoped_read_only_and_includes_uncertain_actions(ledger):
    operation_id = operation(ledger)
    row = admit(ledger, operation_id).record
    details = {**row["details_json"], "legacy_diagnostic": "retained"}
    for outcome in ("document_writing", "document_outcome_unresolved"):
        current = ledger.get_managed_operation_action(row["id"])
        ledger.transition_managed_document_action(
            action_id=row["id"],
            expected_outcome=current["outcome"],
            outcome=outcome,
            details=details,
        )
        before = ledger.get_managed_operation_action(row["id"])
        assert pending(ledger).actions == [{**before, "operation_kind": "annotation"}]
        assert pending(ledger, scope="runtime-other").actions == []
        assert ledger.get_managed_operation_action(row["id"]) == before
    ledger.insert_managed_operation_action(
        operation_id=operation_id,
        action="inspect",
        actor_kind="human",
        actor_id="human-a",
        channel="managed_cli",
        outcome="document_writing",
        recorded_at=8.0,
    )
    assert len(pending(ledger).actions) == 1


@pytest.mark.parametrize("limit", [0, -1, 33, True, 1.5])
def test_pending_observation_rejects_unbounded_or_non_integer_pages(ledger, limit):
    with pytest.raises(ValueError):
        pending(ledger, limit=limit)
