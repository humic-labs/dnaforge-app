"""Shared data + error types for the external_resource substrate.

Extracted from service.py  as a dependency-free leaf module: the
service-layer dataclasses + exceptions. The core service AND the provider-
domain mixins (service_uniprot / service_rcsb / service_structure) all import
from here, which keeps the mixin split cycle-free (this module imports nothing
from service.py). `service.py` re-exports every name below, so existing
`from ...external.service import StructureTooLarge` call sites are unaffected.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .contract import Capability

_ANNOTATION_REQUIRED = [Capability.EXTERNAL_FETCH_ANNOTATION.value]
_HOMOLOGY_REQUIRED = [Capability.EXTERNAL_FETCH_HOMOLOGY.value]


class ServiceError(Exception):
    """Base class for service-layer failures."""


class CapabilityDenied(ServiceError):
    """The caller's grant does not include a scope the provider requires."""

    def __init__(self, required: list[str], granted: list[str]) -> None:
        super().__init__(
            f"capability check failed: required={required} granted={granted}"
        )
        self.required = required
        self.granted = granted


class UnknownProvider(ServiceError):
    """No registered provider matches the given provider_id."""


class CircuitOpen(ServiceError):
    """The circuit breaker for this origin is currently open."""

    def __init__(self, origin: str, opens_at_s: float) -> None:
        super().__init__(
            f"circuit breaker open for {origin}; closes after {opens_at_s:.1f}s"
        )
        self.origin = origin
        self.opens_at_s = opens_at_s


class StructureTooLarge(ServiceError):
    """Provider returned a structure file larger than an explicit caller budget."""

    failure_kind = "structure_too_large"

    def __init__(self, byte_count: int, max_bytes: int) -> None:
        super().__init__(f"structure response too large: {byte_count} > {max_bytes}")
        self.byte_count = byte_count
        self.max_bytes = max_bytes


class SequenceTooLarge(ServiceError):
    """Provider returned a sequence record larger than the caller's byte budget.

    : NCBI nuccore accepts RefSeq accessions (NC_*) that resolve to whole
    chromosomes/assemblies — a `gbwithparts` GenBank record can be hundreds of MB.
    `fetch_sequence_bytes` rejects oversized records (mapped to HTTP 413) so the
    single-process sidecar can't be OOM'd by a few concurrent large imports, and
    so the route's decode + JSON re-serialization can't amplify a huge payload.
    """

    failure_kind = "sequence_too_large"

    def __init__(self, byte_count: int, max_bytes: int) -> None:
        super().__init__(f"sequence record too large: {byte_count} > {max_bytes}")
        self.byte_count = byte_count
        self.max_bytes = max_bytes


@dataclass(frozen=True)
class FetchRequest:
    """Caller-facing fetch request shape, mirrored by the route Pydantic model."""

    provider: str
    raw_id: str
    workspace_id: str | None = None
    granted_capabilities: list[str] = field(default_factory=list)
    bind_to: dict[str, str] | None = None
    """If set, after fetch+persist also create an external_resource_binding row.
       Required keys: source_kind, source_uri, relationship, evidence."""
    agent_action_id: str | None = None
    """: when present, the request originated from an agent via /mcp/call.
       The service uses this to write an agent_artifact row tying the fetch
       to the agent_action root (workflow-boundaries 4-row invariant)."""


@dataclass(frozen=True)
class FetchResponse:
    """Caller-facing return shape."""

    external_resource_id: str
    external_id: str
    cache_hit: bool
    license: str | None
    attribution: str | None
    metadata: dict[str, Any]
    xref_count: int
    binding_id: str | None = None
    agent_artifact_id: str | None = None


@dataclass(frozen=True)
class StructureBytesResponse:
    """Provider-owned structure bytes returned to the route layer.

    `external_id` is the canonical identity callers should cache and persist
    for this provider request. `served_external_id` is the byte payload identity
    when the provider serves a broader object than the requested scope, e.g.
    RCSB scoped chain/entity identities served from an entry-level file.
    """

    provider: str
    external_id: str
    served_external_id: str
    format: str
    content: bytes
    content_type: str
    source_url: str
    license: str
    attribution: str
    etag: str | None = None


@dataclass(frozen=True)
class SequenceBytesResponse:
    """Provider-owned sequence-record bytes returned to the route layer.

    : the import path's NCBI fetch moved off the renderer-side
    `@waypoint/bioinfo-client` onto the sidecar provider substrate. Unlike
    `StructureBytesResponse` (binary mmCIF/PDB consumed by MolStar), a
    sequence record is GenBank/FASTA *text*, so the route returns it as a
    JSON string field alongside structured provenance — matching the rest
    of the JSON `/external/*` surface rather than the raw-bytes structure
    route.

    `external_id` is the canonical accession the provider pinned (with its
    version suffix). `metadata` is the provider's light header parse
    (organism, definition, length, topology, taxon_id, accession, locus).
    """

    provider: str
    external_id: str
    format: str
    content: bytes
    content_type: str
    content_sha256: str
    source_url: str | None
    license: str | None
    attribution: str | None
    version_identifier: str | None
    etag: str | None
    metadata: dict[str, Any]


@dataclass(frozen=True)
class StructurePosterResponse:
    provider: str
    external_id: str
    content: bytes
    content_type: str
    source_url: str
    etag: str | None = None
    style: str | None = None
    cache_hit: bool = False
    render_version: str | None = None


@dataclass(frozen=True)
class RcsbSequenceSearchHit:
    identifier: str
    pdb_id: str
    entity_id: str | None
    score: float | None = None
    sequence_identity: float | None = None
    evalue: float | None = None
    bit_score: float | None = None


@dataclass(frozen=True)
class ProteinQueryEvidence:
    kind: str
    residue: str | None = None


@dataclass(frozen=True)
class ProteinQueryIdentity:
    kind: str
    normalized_length: int
    checksum_md5: str
    checksum_sha256: str
    canonical_form: str
    canonical_lookup_sequence: str
    canonical_form_applied: bool = True
    ineligible: bool = False
    ineligible_reason: str | None = None
    evidence: tuple[ProteinQueryEvidence, ...] = ()
