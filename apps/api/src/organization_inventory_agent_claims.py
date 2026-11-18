from __future__ import annotations

import asyncio
import math
import sqlite3
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints

from .capability_policy import has_required_capabilities
from .control_plane import ControlPlaneStore
from .control_plane.organization_inventory_claim_policy import LEASE_SCHEMA, MAX_LEASE_MS
from .routes.mcp_auth import _grant_error_for_identity

ORGANIZATION_INVENTORY_AGENT_LEASE_SCHEMA = LEASE_SCHEMA
MAX_ORGANIZATION_INVENTORY_AGENT_LEASE_MS = MAX_LEASE_MS


def _canonical_identifier(value: str) -> str:
    if value.strip() != value or "\0" in value:
        raise ValueError("A canonical nonempty identifier is required.")
    return value


Identifier = Annotated[
    str, StringConstraints(min_length=1, max_length=512), AfterValidator(_canonical_identifier)
]
Uuid = Annotated[
    str,
    StringConstraints(pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"),
]
Sha256 = Annotated[str, StringConstraints(pattern=r"^sha256:[a-f0-9]{64}$")]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class OrganizationInventoryAgentTarget(StrictModel):
    kind: Literal["organization-inventory"]
    orgId: Uuid
    inventoryId: Uuid


class OrganizationInventoryAgentObservePurpose(StrictModel):
    kind: Literal["observe"]
    operation: Literal["snapshot", "cancel-preview", "attempt", "inspect"]


class OrganizationInventoryAgentPreviewPurpose(StrictModel):
    kind: Literal["preview-use"]


class OrganizationInventoryAgentSendPurpose(StrictModel):
    kind: Literal["send"]
    mode: Literal["submit", "retry-exact", "confirm-unsent"]
    operationId: Identifier
    requestSha256: Sha256


class OrganizationInventoryAgentLeaseRequest(StrictModel):
    schema_: Literal["dnaforge.organization-inventory-agent-lease.v1"] = Field(alias="schema")
    delegationId: Identifier
    delegationIncarnation: Identifier
    accountId: Uuid
    desktopSessionId: Uuid
    target: OrganizationInventoryAgentTarget
    flightId: Identifier
    purpose: Annotated[
        OrganizationInventoryAgentObservePurpose
        | OrganizationInventoryAgentPreviewPurpose
        | OrganizationInventoryAgentSendPurpose,
        Field(discriminator="kind"),
    ]


class OrganizationInventoryAgentLeaseBinding(OrganizationInventoryAgentLeaseRequest):
    agentIdentityId: Identifier
    nativeOwnerInstanceId: Identifier


class OrganizationInventoryAgentLeaseGranted(StrictModel):
    kind: Literal["granted"] = "granted"
    binding: OrganizationInventoryAgentLeaseBinding
    validForMs: int = Field(ge=1, le=MAX_LEASE_MS)


class OrganizationInventoryAgentClaimDenied(StrictModel):
    kind: Literal["denied"] = "denied"
    code: Identifier
    message: str = Field(min_length=1, max_length=2000)


class OrganizationInventoryAgentClaimUnavailable(StrictModel):
    kind: Literal["unavailable"] = "unavailable"
    code: Identifier
    message: str = Field(min_length=1, max_length=2000)


class OrganizationInventoryAgentClaimPolicy(StrictModel):
    protocolVersion: Literal[1] = 1
    state: Literal["live", "denying", "complete"]
    maxLeaseMs: Literal[5000] = 5000


class OrganizationInventoryAgentClaimPolicyRead(StrictModel):
    kind: Literal["policy"] = "policy"
    agentIdentityId: Identifier
    nativeOwnerInstanceId: Identifier
    policy: OrganizationInventoryAgentClaimPolicy | None


class OrganizationInventoryAgentClaimPolicyEnrollment(StrictModel):
    pass


OrganizationInventoryAgentLeaseRead = Annotated[
    OrganizationInventoryAgentLeaseGranted
    | OrganizationInventoryAgentClaimDenied
    | OrganizationInventoryAgentClaimUnavailable,
    Field(discriminator="kind"),
]
OrganizationInventoryAgentPolicyRead = Annotated[
    OrganizationInventoryAgentClaimPolicyRead
    | OrganizationInventoryAgentClaimDenied
    | OrganizationInventoryAgentClaimUnavailable,
    Field(discriminator="kind"),
]


class OrganizationInventoryGrantAuthorityUnavailable(RuntimeError):
    pass


class OrganizationInventoryAgentClaimService:
    def __init__(
        self,
        store: ControlPlaneStore,
        *,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self._store = store
        self._now = now
        self._monotonic = monotonic
        self._sleep = sleep

    def _grant(self, agent_id: str, required: list[str]):
        identity = self._store.get_agent_identity(agent_id)
        error = _grant_error_for_identity(agent_id, identity)
        if error:
            return OrganizationInventoryAgentClaimDenied(
                code=error["error"]["code"], message=error["error"]["message"]
            )
        assert identity is not None
        capabilities = identity.get("scope_json")
        if (
            not isinstance(capabilities, list)
            or not all(isinstance(value, str) for value in capabilities)
            or not has_required_capabilities(capabilities, required)
        ):
            return OrganizationInventoryAgentClaimDenied(
                code="INSUFFICIENT_SCOPE",
                message="The grant does not permit this organization inventory purpose.",
            )
        return identity

    def _policy(self, agent_id: str, native_owner_id: str):
        row = self._store.organization_inventory_claims.get(agent_id)
        if row is not None and (
            row["protocol_schema"] != LEASE_SCHEMA or row["max_lease_ms"] != MAX_LEASE_MS
        ):
            raise OrganizationInventoryGrantAuthorityUnavailable("Unsupported claim policy.")
        return OrganizationInventoryAgentClaimPolicyRead(
            agentIdentityId=agent_id,
            nativeOwnerInstanceId=native_owner_id,
            policy=None
            if row is None
            else OrganizationInventoryAgentClaimPolicy(state=row["state"]),
        )

    def enroll(self, agent_id: str, native_owner_id: str) -> OrganizationInventoryAgentPolicyRead:
        with self._store.transaction():
            identity = self._grant(agent_id, ["read-organization-inventory"])
            if isinstance(identity, OrganizationInventoryAgentClaimDenied):
                return identity
            self._store.organization_inventory_claims.enroll(agent_id)
            return self._policy(agent_id, native_owner_id)

    def status(self, agent_id: str, native_owner_id: str) -> OrganizationInventoryAgentPolicyRead:
        with self._store.transaction():
            if self._store.get_agent_identity(agent_id) is None:
                return OrganizationInventoryAgentClaimDenied(
                    code="GRANT_MISSING", message="The exact grant does not exist."
                )
            return self._policy(agent_id, native_owner_id)

    def lease(
        self, agent_id: str, native_owner_id: str, request: OrganizationInventoryAgentLeaseRequest
    ) -> OrganizationInventoryAgentLeaseRead:
        required = ["read-organization-inventory"]
        if request.purpose.kind != "observe":
            required.append("use-organization-inventory")
        with self._store.transaction():
            identity = self._grant(agent_id, required)
            if isinstance(identity, OrganizationInventoryAgentClaimDenied):
                return identity
            policy = self._policy(agent_id, native_owner_id)
            if policy.policy is None or policy.policy.state != "live":
                return OrganizationInventoryAgentClaimDenied(
                    code="ORGANIZATION_CLAIM_NOT_LIVE",
                    message="The grant is not enrolled in a live organization claim policy.",
                )
            valid_for = MAX_LEASE_MS
            if identity.get("expires_at") is not None:
                expires = datetime.fromisoformat(identity["expires_at"].replace("Z", "+00:00"))
                if expires.tzinfo is None:
                    expires = expires.replace(tzinfo=timezone.utc)
                valid_for = min(
                    valid_for, math.floor((expires - self._now()).total_seconds() * 1000)
                )
            if valid_for < 1:
                return OrganizationInventoryAgentClaimDenied(
                    code="GRANT_EXPIRED", message="The grant expired before claim admission."
                )
            return OrganizationInventoryAgentLeaseGranted(
                binding=OrganizationInventoryAgentLeaseBinding.model_validate(
                    {
                        **request.model_dump(by_alias=True),
                        "agentIdentityId": agent_id,
                        "nativeOwnerInstanceId": native_owner_id,
                    }
                ),
                validForMs=valid_for,
            )

    async def revoke(self, agent_id: str) -> bool:
        with self._store.transaction():
            if self._store.get_agent_identity(agent_id) is None:
                return False
            policy = self._store.organization_inventory_claims.get(agent_id)
            if policy is None:
                return self._store.revoke_agent_identity(agent_id)
            if policy["state"] == "complete":
                return True
            self._store.organization_inventory_claims.deny(agent_id)
        start = self._monotonic()
        if not math.isfinite(start):
            raise OrganizationInventoryGrantAuthorityUnavailable("The claim clock is unavailable.")
        await self._sleep(MAX_LEASE_MS / 1000)
        finish = self._monotonic()
        if not math.isfinite(finish) or finish < start + MAX_LEASE_MS / 1000:
            raise OrganizationInventoryGrantAuthorityUnavailable(
                "Claim revocation is pending its full drain."
            )
        try:
            self._store.organization_inventory_claims.complete(agent_id, self._now().isoformat())
        except sqlite3.Error as error:
            raise OrganizationInventoryGrantAuthorityUnavailable(
                "Claim revocation could not be confirmed."
            ) from error
        return True
