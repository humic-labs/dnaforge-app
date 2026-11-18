from __future__ import annotations

import sqlite3
import threading
from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Literal

LEASE_SCHEMA = "dnaforge.organization-inventory-agent-lease.v1"
MAX_LEASE_MS = 5000
PolicyState = Literal["live", "denying", "complete"]

_SCHEMA = (
    f"""CREATE TABLE IF NOT EXISTS agent_organization_inventory_claim_policy (
      grant_id TEXT PRIMARY KEY REFERENCES agent_identity(id) ON DELETE RESTRICT,
      protocol_schema TEXT NOT NULL CHECK(protocol_schema='{LEASE_SCHEMA}'),
      max_lease_ms INTEGER NOT NULL CHECK(max_lease_ms={MAX_LEASE_MS}),
      state TEXT NOT NULL CHECK(state IN('live','denying','complete'))
    )""",
    """CREATE TRIGGER IF NOT EXISTS organization_claim_policy_insert
    BEFORE INSERT ON agent_organization_inventory_claim_policy BEGIN
      SELECT CASE WHEN dnaforge_org_claim_policy_transition(NEW.grant_id,NULL,NEW.state)!=1
        OR NEW.state!='live' THEN RAISE(ABORT,'ORGANIZATION_CLAIM_POLICY_TRANSITION_DENIED') END;
    END""",
    """CREATE TRIGGER IF NOT EXISTS organization_claim_policy_update
    BEFORE UPDATE ON agent_organization_inventory_claim_policy BEGIN
      SELECT CASE WHEN NEW.grant_id!=OLD.grant_id OR NEW.protocol_schema!=OLD.protocol_schema
        OR NEW.max_lease_ms!=OLD.max_lease_ms
        OR dnaforge_org_claim_policy_transition(OLD.grant_id,OLD.state,NEW.state)!=1
        THEN RAISE(ABORT,'ORGANIZATION_CLAIM_POLICY_TRANSITION_DENIED') END;
    END""",
    """CREATE TRIGGER IF NOT EXISTS organization_claim_policy_delete
    BEFORE DELETE ON agent_organization_inventory_claim_policy BEGIN
      SELECT CASE WHEN dnaforge_org_claim_policy_transition(OLD.grant_id,OLD.state,'delete')!=1
        THEN RAISE(ABORT,'ORGANIZATION_CLAIM_POLICY_TRANSITION_DENIED') END;
    END""",
    """CREATE TRIGGER IF NOT EXISTS organization_claim_grant_revoke
    BEFORE UPDATE OF revoked ON agent_identity
    WHEN EXISTS(SELECT 1 FROM agent_organization_inventory_claim_policy WHERE grant_id=OLD.id)
      AND (NEW.revoked NOT IN(0,1) OR (OLD.revoked!=0 AND NEW.revoked=0)
        OR (NEW.revoked=1 AND EXISTS(SELECT 1 FROM agent_organization_inventory_claim_policy
          WHERE grant_id=OLD.id AND state!='complete')))
    BEGIN SELECT RAISE(ABORT,'ORGANIZATION_CLAIM_PROTOCOL_REQUIRED'); END""",
    """CREATE TRIGGER IF NOT EXISTS organization_claim_grant_delete
    BEFORE DELETE ON agent_identity
    WHEN EXISTS(SELECT 1 FROM agent_organization_inventory_claim_policy WHERE grant_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'ORGANIZATION_CLAIM_PROTOCOL_REQUIRED'); END""",
)


class OrganizationInventoryClaimPolicyStore:
    def __init__(
        self,
        connection: sqlite3.Connection,
        transaction: Callable[[], AbstractContextManager[None]],
    ):
        self._connection = connection
        self._transaction = transaction
        self._scope = threading.local()
        connection.create_function(
            "dnaforge_org_claim_policy_transition", 3, self._allow_transition
        )

    def _allow_transition(self, grant_id: str, previous: str | None, following: str) -> int:
        return int(
            (previous, following) in {(None, "live"), ("live", "denying"), ("denying", "complete")}
            and getattr(self._scope, "transition", None) == (grant_id, previous, following)
        )

    def initialize(self) -> None:
        with self._transaction():
            for statement in _SCHEMA:
                self._connection.execute(statement)

    def get(self, grant_id: str) -> dict[str, str | int] | None:
        row = self._connection.execute(
            "SELECT protocol_schema,max_lease_ms,state FROM agent_organization_inventory_claim_policy WHERE grant_id=?",
            (grant_id,),
        ).fetchone()
        return dict(row) if row is not None else None

    def enroll(self, grant_id: str) -> dict[str, str | int]:
        existing = self.get(grant_id)
        if existing is not None:
            return existing
        self._transition(grant_id, None, "live")
        return self._required(grant_id)

    def deny(self, grant_id: str) -> None:
        if self._required(grant_id)["state"] == "live":
            self._transition(grant_id, "live", "denying")

    def complete(self, grant_id: str, revoked_at: str) -> None:
        with self._transaction():
            if self._required(grant_id)["state"] == "complete":
                return
            self._transition(grant_id, "denying", "complete")
            changed = self._connection.execute(
                "UPDATE agent_identity SET revoked=1,revoked_at=COALESCE(revoked_at,?) WHERE id=?",
                (revoked_at, grant_id),
            )
            if changed.rowcount != 1:
                raise RuntimeError("The guarded grant disappeared before revocation.")

    def _required(self, grant_id: str) -> dict[str, str | int]:
        row = self.get(grant_id)
        if row is None:
            raise ValueError("The organization claim policy is not enrolled.")
        return row

    def _transition(
        self, grant_id: str, previous: PolicyState | None, following: PolicyState
    ) -> None:
        with self._transaction():
            if getattr(self._scope, "transition", None) is not None:
                raise RuntimeError("A claim policy transition is already active.")
            self._scope.transition = (grant_id, previous, following)
            try:
                if previous is None:
                    self._connection.execute(
                        "INSERT INTO agent_organization_inventory_claim_policy VALUES(?,?,?,?)",
                        (grant_id, LEASE_SCHEMA, MAX_LEASE_MS, following),
                    )
                else:
                    changed = self._connection.execute(
                        "UPDATE agent_organization_inventory_claim_policy SET state=? WHERE grant_id=? AND state=?",
                        (following, grant_id, previous),
                    )
                    if changed.rowcount != 1:
                        raise ValueError("The claim policy transition is stale.")
            finally:
                self._scope.transition = None
