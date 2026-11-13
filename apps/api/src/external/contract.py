"""Provider plugin contract for the external_resource substrate.

Plan: tools/devops/plans/2026-05-02-bioinformatics-db-substrate.md
       (sub-ticket DNA-XXa2)

Every provider — UniProt for v1, NCBI/Ensembl/InterProScan/ESM Atlas for the
follow-up plan, third-party plugins eventually — implements `ExternalProvider`.
The service layer (`service.py`) doesn't know UniProt-isms; it knows the
contract.

Design notes from the plan + codex round-2 review:

- `ParsedId` is a discriminated union, not a flat string. UniProt P00875,
  P00875-1 (isoform), P00875.2 (version-stamped), and a chain selector like
  P00875/A all parse cleanly into the same shape with different optional
  fields. Codex 6 explicitly called out that flat-string IDs lose information
  the downstream service needs (provenance per chain, isoform-aware caching).
- Capability vocabulary is an enum, not a free-form string. Plan section
  "Capability scope enforcement semantics" (codex 13) needs every provider
  to declare scopes from a closed set so the renderer fetch broker and the
  sidecar agree on what's being requested.
- Errors are typed exceptions, not `(result, error)` tuples — Python idiom
  matters here, the JS equivalent (`AbortController` + tuple returns) is
  not what we want. Codex 16.
- Sequence-similarity submission is a separate capability from metadata fetch.
  Thin service methods that submit sequence content must require
  `external-fetch:homology-search` even when they return metadata-shaped hits.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol, runtime_checkable


class Capability(str, Enum):
    """Capabilities a provider can declare and a caller can request.

    The string value is the wire format used in `audit_record.capability_check_json`
    and `external_fetch_log.capability_check_json` so existing dashboards keep
    working.
    """

    EXTERNAL_INFERENCE_DISCOVERY = "external-inference:discovery"

    EXTERNAL_FETCH_ANNOTATION = "external-fetch:annotation"

    EXTERNAL_FETCH_XREF = "external-fetch:xref-resolution"

    EXTERNAL_FETCH_STRUCTURE = "external-fetch:structure"

    EXTERNAL_FETCH_HOMOLOGY = "external-fetch:homology-search"

    EXTERNAL_FETCH_BULK_DOWNLOAD = "external-fetch:bulk-download"

    EXTERNAL_FETCH_PAPER = "external-fetch:paper"

    EXTERNAL_COMPUTE_TM = "external-compute:tm"

    EXTERNAL_COMPUTE_DISCOVER = "external-compute:discover"

    EXTERNAL_COMPUTE_SUBMIT = "external-compute:submit"

    EXTERNAL_COMPUTE_MANAGE = "external-compute:manage"


@dataclass(frozen=True)
class ParsedId:
    """Parsed provider ID with optional disambiguation fields.

    `canonical_id` is what the provider's REST surface accepts (e.g.,
    `P00875` for UniProt entry fetch). The optional fields disambiguate
    sub-resources of the same canonical entry — they DON'T change the
    canonical lookup but they DO change downstream behavior:

      - `isoform`: UniProt isoform suffix (e.g., '-1' for P00875-1).
        Same entry, different sequence variant.
      - `version`: provider-stated version stamp (e.g., '.2' for
        P00875.2). Same accession, different release of the data.
      - `chain`: PDB chain selector (e.g., 'A' for 1RBL chain A).
      - `taxon`: NCBI taxon id when the provider's lookup is taxon-scoped
        (e.g., gene+organism searches against UniProt).
      - `entity`: provider-specific entity selector for multi-entity
        records (PDB asymmetric units, multi-chain complexes).
      - `scope`: provider-native structured identity. Used when a provider has
        richer scopes than the legacy chain/entity fields can round-trip.
    """

    canonical_id: str
    provider: str
    isoform: str | None = None
    version: str | None = None
    chain: str | None = None
    taxon: str | None = None
    entity: str | None = None
    scope: str | None = None

    def cache_key(self) -> str:
        """Stable string suitable for the (provider, external_id) UPSERT key.

        Includes any sub-resource disambiguator that changes which canonical
        URL the provider fetches — isoform, version, chain, entity. Without
        this, fetching `P00875-1` (isoform) caches under the same key as
        `P00875` (canonical), and the second lookup returns whichever variant
        was last fetched. Pin the cache to the actual sub-resource so each
        variant gets its own row.

        `taxon` is excluded — it's a search-side filter, not a sub-resource
        of a canonical entry, so it doesn't change the canonical cache key.
        """
        if self.scope:
            return self.scope
        parts = [self.canonical_id]
        if self.isoform:
            parts.append(f"-{self.isoform}")
        if self.version:
            parts.append(f".{self.version}")
        if self.chain:
            parts.append(f"/{self.chain}")
        if self.entity:
            parts.append(f"#{self.entity}")
        return "".join(parts)


@dataclass(frozen=True)
class FetchOptions:
    """Caller-controlled knobs for a single fetch invocation.

    Defaults match the concurrency spec doc's published budgets. Callers
    pass overrides for unusual cases (bulk indexer with longer total_timeout,
    UI prefetch with tighter timeout).
    """

    total_timeout_s: float = 10.0
    connect_timeout_s: float = 3.0
    max_retries: int = 3
    initial_backoff_s: float = 0.5
    max_backoff_s: float = 8.0
    user_agent: str = (
        "DNAForge/0.1 (https://dnaforge.com; +https://github.com/humic-labs/dnaforge-app)"
    )


@dataclass(frozen=True)
class FetchResult:
    """What a provider's `fetch()` returns to the service layer.

    The service layer is responsible for persisting this into
    `data_file` + `external_resource` + `external_fetch_log`. The
    provider only knows about the wire format.

    `xrefs` carries cross-references parsed from the SAME response that
    populated the rest of the result. Providers SHOULD include them here
    (UniProt's response embeds xrefs inline; one fetch covers both). For
    providers where xref resolution is a separate API call, leave xrefs
    empty and implement `resolve_xrefs()` — the service layer will use
    the latter in that case.
    """

    parsed_id: ParsedId
    metadata: dict[str, Any]
    content_bytes: bytes | None = None
    content_mime_type: str | None = None
    content_sha256: str | None = None
    external_url: str | None = None
    version_identifier: str | None = None
    etag: str | None = None
    license: str | None = None
    attribution: str | None = None
    status_code: int = 200
    bytes_received: int = 0
    xrefs: list["Xref"] = field(default_factory=list)


@dataclass(frozen=True)
class Xref:
    """A cross-reference asserted by a provider.

    The service layer maps `(target_provider, target_external_id)` to an
    `external_resource_id` via UPSERT before writing the xref row, so a
    provider that asserts a xref to a not-yet-cached PDB entry implicitly
    creates a stub row for that PDB entry. The stub gets fully fetched
    on demand if a caller actually needs the data.
    """

    target_provider: str
    target_external_id: str
    xref_type: str
    evidence: str = "asserted"
    source_provider: str = ""
    confidence: float | None = None
    version: str | None = None
    identity: float | None = None
    coverage: float | None = None
    alignment_coords: dict[str, Any] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class ProviderError(Exception):
    """Base class for provider failures. Always carries failure_kind."""

    failure_kind: str = "provider_error"

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class ProviderHttpError(ProviderError):
    """HTTP error from the provider (4xx, 5xx, malformed body)."""

    failure_kind = "http_error"


class ProviderContractError(ProviderHttpError):
    """Deterministic provider contract violation, not a transient 5xx."""

    failure_kind = "provider_contract_error"


class ProviderRateLimitError(ProviderError):
    """429 with optional Retry-After hint. Service-layer backoff handles it."""

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


class ProviderTimeoutError(ProviderError):
    """total_timeout exceeded. Distinct from network error so callers can choose."""

    failure_kind = "timeout"


@runtime_checkable
class ExternalProvider(Protocol):
    """The contract every provider implements.

    Methods are intentionally narrow — codex 6 expanded this beyond a single
    `detect_id` to cover the full plugin lifecycle (parse, fetch, resolve
    xrefs, declare scopes). Any v2 method (search, predict, submit-job) goes
    in a separate Protocol; this one stays read-shaped.
    """

    provider_id: str

    def detect_id(self, raw: str) -> ParsedId | None:
        """Parse a raw user/agent-supplied string into a ParsedId for this provider.

        Returns None if the string isn't recognizable as belonging to this
        provider's namespace. Callers loop providers in priority order and
        take the first non-None return.
        """
        ...

    async def fetch(
        self,
        parsed_id: ParsedId,
        opts: FetchOptions,
    ) -> FetchResult:
        """Fetch the canonical entry for `parsed_id` from the provider.

        Raises ProviderHttpError / ProviderRateLimitError / ProviderTimeoutError
        on failure. Service layer decides retry policy via FetchOptions.
        """
        ...

    async def resolve_xrefs(
        self,
        parsed_id: ParsedId,
        target_provider: str | None = None,
    ) -> list[Xref]:
        """Return the cross-references the provider asserts for `parsed_id`.

        If `target_provider` is given, filter to xrefs landing in that
        provider's namespace (e.g., UniProt → PDB only). Otherwise return
        every asserted xref. Service layer is responsible for ensuring the
        target external_resource rows exist (UPSERT stubs) before persisting.
        """
        ...

    def declared_capabilities(self) -> list[Capability]:
        """The capability scopes this provider supports.

        Service-layer capability check verifies the caller's grant matches
        before invoking fetch/resolve_xrefs. Typical UniProt response for v1:
        [Capability.EXTERNAL_FETCH_ANNOTATION, Capability.EXTERNAL_FETCH_XREF].
        """
        ...
