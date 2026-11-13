"""Binding contract for hosted bioinformatics compute endpoints.


A *compute endpoint* is a hosted service (Tamarind Bio, NVIDIA BioNeMo NIM,
subseq.bio, ...) that runs a model job on the user's behalf under the USER's own
account and key. Every provider is described by a manifest
(`packages/core/compute-endpoints/manifests/<id>.json`) and driven by a
`ProviderBinding`. Two binding kinds implement the protocol:

- `McpProviderBinding` (slice 2): generic, manifest-driven. An MCP *client* to the
  provider's remote MCP server; `toolMap` in the manifest names the remote tool
  for each operation. Zero provider-specific code.
- `RestProviderBinding` subclasses (slice 7): one per provider without an MCP
  server.

Why this is NOT `external.contract.ExternalProvider`: that contract is
fetch-shaped (detect an id, fetch it, 10 s default timeout, mandatory fetch-log
row). A compute job is submit-then-poll over minutes. The June 2026 eng review
(codex #7) ruled the two must not share a Protocol; bindings BORROW the
`external/` circuit breaker and rate limiter and own their own job FSM.

Design rules (plan V1–V6):

- Eight operations, fixed vocabulary (`ComputeOperation`). Adding a provider
  adds no agent tools.
- Credentials arrive per request (`ProviderCredential`), never from env, never
  logged, never persisted by the sidecar. `ProviderCredential.__repr__` redacts.
- Errors are typed exceptions the route layer maps to stable failure kinds the
  renderer can show in plain language (bad key, budget exhausted, rate limited,
  provider down, mapped tool missing).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping, Protocol, runtime_checkable


class ComputeOperation(str, Enum):
    LIST_TOOLS = "list_tools"
    GET_SCHEMA = "get_schema"
    VALIDATE = "validate"
    ESTIMATE = "estimate"
    SUBMIT = "submit"
    STATUS = "status"
    FETCH_RESULT = "fetch_result"
    CANCEL = "cancel"


READ_ONLY_OPERATIONS: frozenset[ComputeOperation] = frozenset(
    {
        ComputeOperation.LIST_TOOLS,
        ComputeOperation.GET_SCHEMA,
        ComputeOperation.VALIDATE,
        ComputeOperation.ESTIMATE,
        ComputeOperation.STATUS,
        ComputeOperation.FETCH_RESULT,
    }
)

MANAGE_OPERATIONS: frozenset[ComputeOperation] = frozenset({ComputeOperation.CANCEL})


def capability_for(operation: ComputeOperation) -> str:
    """Wire-format capability string a caller must hold for `operation`.

    Returns the `external.contract.Capability` value; kept as a plain string so
    this module has no import dependency on the fetch substrate.
    """
    if operation is ComputeOperation.SUBMIT:
        return "external-compute:submit"
    if operation in MANAGE_OPERATIONS:
        return "external-compute:manage"
    return "external-compute:discover"


class CredentialScheme(str, Enum):
    HEADER = "header"
    BEARER = "bearer"
    OAUTH = "oauth"


@dataclass(frozen=True)
class ProviderCredential:
    """The user's provider key for ONE request.

    Constructed by the route layer from the `x-dnaforge-compute-credential`
    header the desktop main process injects. Never read from process env.
    `repr()`/`str()` redact so an accidental log line cannot leak the secret.
    """

    provider_id: str
    scheme: CredentialScheme
    secret: str = field(repr=False)
    header_name: str | None = None

    def __post_init__(self) -> None:
        if not self.secret or not self.secret.strip():
            raise ValueError("ProviderCredential.secret must be non-empty")
        if self.scheme is CredentialScheme.HEADER and not self.header_name:
            raise ValueError("header scheme requires header_name")

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"ProviderCredential(provider_id={self.provider_id!r}, scheme={self.scheme.value!r}, secret=<redacted>)"

    __str__ = __repr__

    def as_headers(self) -> dict[str, str]:
        """Outbound headers for the provider request. The ONLY place the secret is read."""
        if self.scheme is CredentialScheme.HEADER:
            assert self.header_name is not None
            return {self.header_name: self.secret}
        if self.scheme is CredentialScheme.BEARER:
            return {"Authorization": f"Bearer {self.secret}"}
        return {"Authorization": f"Bearer {self.secret}"}


class JobState(str, Enum):
    """Provider-agnostic lifecycle. Bindings map provider statuses onto this."""

    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELED = "canceled"


TERMINAL_STATES: frozenset[JobState] = frozenset(
    {JobState.COMPLETED, JobState.FAILED, JobState.CANCELED}
)


class OutputKind(str, Enum):
    """What `fetch_result` hands back; drives the desktop normalizer choice."""

    STRUCTURE = "structure"
    SEQUENCE_SET = "sequence-set"
    TABLE = "table"
    BINARY = "binary"


@dataclass(frozen=True)
class ToolDescriptor:
    """One runnable tool/job-type on a provider, as the agent sees it."""

    id: str
    display_name: str
    description: str = ""
    tags: tuple[str, ...] = ()
    output_kind: OutputKind | None = None


@dataclass(frozen=True)
class CostEstimate:
    """Pre-submit cost signal. `unit` is provider-native ("weighted_hours", "credits")."""

    amount: float | None
    unit: str
    estimated_seconds: float | None = None
    note: str = ""

    def is_known(self) -> bool:
        return self.amount is not None


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    problems: tuple[str, ...] = ()


@dataclass(frozen=True)
class ProviderJobRef:
    """Opaque handle to a job on the provider. Persisted in `compute_jobs.provider_job_ref`."""

    provider_id: str
    remote_id: str
    tool_id: str
    artifact_refs: tuple[str, ...] = ()


@dataclass(frozen=True)
class JobStatus:
    ref: ProviderJobRef
    state: JobState
    provider_state: str = ""
    progress_note: str = ""
    cost: CostEstimate | None = None

    def is_terminal(self) -> bool:
        return self.state in TERMINAL_STATES


@dataclass(frozen=True)
class ResultFile:
    name: str
    content: bytes | None = None
    url: str | None = None
    media_type: str = "application/octet-stream"
    size_bytes: int | None = None

    def __post_init__(self) -> None:
        if self.content is None and self.url is None:
            raise ValueError(f"ResultFile {self.name!r} has neither content nor url")


@dataclass(frozen=True)
class ResultBundle:
    ref: ProviderJobRef
    output_kind: OutputKind
    files: tuple[ResultFile, ...]
    metrics: Mapping[str, Any] = field(default_factory=dict)
    provenance: Mapping[str, str] = field(default_factory=dict)

    provider_request: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class SubmitRequest:
    tool_id: str
    settings: Mapping[str, Any]
    files: Mapping[str, bytes] = field(default_factory=dict)
    idempotency_key: str | None = None
    label: str | None = None


class ComputeProviderError(Exception):
    failure_kind: str = "provider_error"

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class BadCredentialError(ComputeProviderError):
    """401/403-as-auth: the key is wrong, revoked, or lacks the permission (NVIDIA
    "Public API Endpoints")."""

    failure_kind = "bad_credential"


class BudgetExhaustedError(ComputeProviderError):
    """Provider refused because the user's/org's budget or credits are gone
    (Tamarind 403 budget, subseq insufficient credits)."""

    failure_kind = "budget_exhausted"


class ComputeRateLimitError(ComputeProviderError):
    failure_kind = "rate_limited"

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 429,
        retry_after_s: float | None = None,
    ) -> None:
        super().__init__(message, status_code=status_code)
        self.retry_after_s = retry_after_s


class ProviderUnavailableError(ComputeProviderError):
    """5xx, connection failure, or MCP session that cannot be (re)opened."""

    failure_kind = "provider_unavailable"


class MappedToolMissingError(ComputeProviderError):
    """Manifest `toolMap` names a remote tool the provider no longer lists.
    Fail loudly: silently falling back would hide catalog drift."""

    failure_kind = "mapped_tool_missing"

    def __init__(self, operation: ComputeOperation, remote_tool: str) -> None:
        super().__init__(
            f"provider does not expose {remote_tool!r} (mapped for {operation.value})"
        )
        self.operation = operation
        self.remote_tool = remote_tool


class InvalidJobSettingsError(ComputeProviderError):
    """Deterministic 400 from validate/submit: caller settings are wrong."""

    failure_kind = "invalid_settings"

    def __init__(self, message: str, *, problems: tuple[str, ...] = ()) -> None:
        super().__init__(message, status_code=400)
        self.problems = problems


class UnknownJobError(ComputeProviderError):
    failure_kind = "unknown_job"


@runtime_checkable
class ProviderBinding(Protocol):
    """What every compute provider binding implements.

    Every method takes the per-request `credential`; bindings hold no secrets
    between calls. Methods raise `ComputeProviderError` subclasses; they never
    return error tuples.
    """

    provider_id: str

    async def list_tools(
        self,
        credential: ProviderCredential,
        *,
        search: str | None = None,
        tags: tuple[str, ...] = (),
    ) -> list[ToolDescriptor]: ...

    async def get_schema(
        self, credential: ProviderCredential, tool_id: str
    ) -> Mapping[str, Any]:
        """JSON Schema (or provider-native schema object) for `tool_id` settings."""
        ...

    async def validate(
        self, credential: ProviderCredential, tool_id: str, settings: Mapping[str, Any]
    ) -> ValidationResult: ...

    async def estimate(
        self, credential: ProviderCredential, tool_id: str, settings: Mapping[str, Any]
    ) -> CostEstimate:
        """Return `CostEstimate(amount=None, unit=...)` when the provider cannot estimate."""
        ...

    async def submit(
        self, credential: ProviderCredential, request: SubmitRequest
    ) -> ProviderJobRef: ...

    async def status(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> JobStatus: ...

    async def fetch_result(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> ResultBundle: ...

    async def cancel(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> JobStatus: ...


__all__ = [
    "BadCredentialError",
    "BudgetExhaustedError",
    "ComputeOperation",
    "ComputeProviderError",
    "ComputeRateLimitError",
    "CostEstimate",
    "CredentialScheme",
    "InvalidJobSettingsError",
    "JobState",
    "JobStatus",
    "MappedToolMissingError",
    "OutputKind",
    "ProviderBinding",
    "ProviderCredential",
    "ProviderJobRef",
    "ProviderUnavailableError",
    "READ_ONLY_OPERATIONS",
    "ResultBundle",
    "ResultFile",
    "SubmitRequest",
    "TERMINAL_STATES",
    "ToolDescriptor",
    "UnknownJobError",
    "ValidationResult",
    "capability_for",
]
