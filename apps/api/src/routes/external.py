"""FastAPI routes for the external_resource substrate .

Plan: tools/devops/plans/2026-05-02-bioinformatics-db-substrate.md
       (sub-ticket DNA-XXa2)

Endpoints:
  - POST /external/fetch              — fetch + register an external resource.
                                        Idempotent on (provider, external_id).
  - GET  /external/resource/{id}      — read an external resource by canonical id.
  - GET  /external/resource/by-external-id?provider=&external_id=
                                       — read by (provider, external_id) tuple.

Out of scope for v1 (deferred): /external/query (graph queries), /external/refresh
(freshness watcher trigger), /external/index (background indexer). The plan
moves these to a follow-up plan after v1 production traffic validates the
substrate.
"""

from __future__ import annotations

import asyncio
import base64
import codecs
import hashlib
import hmac
import ipaddress
import json
import os
from collections import OrderedDict
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Header, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from ..capability_policy import has_required_capabilities
from ..concurrency.pools import get_pool_manager
from ..concurrency.refusals import QueueRefusal
from ..concurrency.schema import PoolName
from ..external.afdb import AfdbHit
from ..external.contract import Capability, ProviderError
from ..external.credential_broker import CredentialBrokerError
from ..external.gene_facts import Database, GeneFacts, GeneFactsNotFound, fetch_gene_facts
from ..external.htsget import HtsgetSourceError
from ..external.paper_graph import PaperIdentifier, PaperReferenceTrace
from ..external.providers.jev import (
    DISCOVERY_CAPABILITY,
    MAX_CANDIDATES,
    DiscoveryCandidate,
)
from ..external.providers.paper_source import PaperSourceRejected, PaperSourceTooLarge
from ..external.providers.rcsb import RCSBEntryNotFound
from ..external.providers.ucsc import UcscApiEndpoint, UcscApiPayload
from ..external.public_http import PublicHttpBoundaryError
from ..external.remote_range import (
    RemoteRangeGrant,
    RemoteRangeMaterialization,
    RemoteRangeSourceError,
)
from ..external.runtime_registry import set_external_runtime
from ..external.service import (
    CapabilityDenied,
    CircuitOpen,
    ExternalResourcesService,
    FetchRequest,
    SequenceTooLarge,
    ServiceError,
    StructureTooLarge,
    UnknownProvider,
)
from ..security.operation_authority import require_human_operation_authority
from ..variant_source_operation_contract import (
    VariantReferenceIdentity,
    variant_assembly_revision,
)
from .mcp_auth import (
    check_session,
    effective_capabilities_for_session_request,
    session_grant_capabilities,
)


def _enforce_session(session_token: str | None) -> None:
    """ — gate /external/* routes behind the same session contract
    that /mcp/call uses (X-DNAForge-Session header validated against env).

    The sidecar listens on loopback. Without this gate, any local process
    (compromised renderer extension, rogue script on a shared dev box,
    cross-origin web page reaching loopback when CORS is permissive) can
    write to the agent audit trail by forging X-DNAForge-Action-Id +
    self-attesting capabilities. The session token is the trust boundary.
    """
    err = check_session(session_token)
    if err is None:
        return
    error = err["error"]
    code = error.get("code", "BAD_SESSION")
    status_code = (
        status.HTTP_500_INTERNAL_SERVER_ERROR
        if code == "MCP_SESSION_NOT_CONFIGURED"
        else status.HTTP_401_UNAUTHORIZED
    )
    raise HTTPException(status_code=status_code, detail=error)


def _effective_external_capabilities(requested_capabilities: list[str]) -> list[str]:
    return effective_capabilities_for_session_request(requested_capabilities)


def _require_requested_capabilities(
    requested_capabilities: list[str], required: list[str]
) -> None:
    effective = _effective_external_capabilities(requested_capabilities)
    if not has_required_capabilities(effective, required):
        raise _capability_denied_http(
            CapabilityDenied(required=required, granted=effective)
        )
    _enforce_session_grant_capabilities(required)


def _enforce_session_grant_capabilities(required: list[str]) -> None:
    grant = session_grant_capabilities()
    if grant is None or has_required_capabilities(grant, required):
        return
    raise _capability_denied_http(CapabilityDenied(required=required, granted=grant))


router = APIRouter(prefix="/external", tags=["External Resources"])


@router.get("/gene-facts", response_model=GeneFacts)
async def get_gene_facts(
    database: Database,
    identifier: str,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> GeneFacts:
    """Retrieve public annotations only for a known, exact database identifier."""
    _enforce_session(x_dnaforge_session)
    required = [Capability.EXTERNAL_FETCH_ANNOTATION.value]
    _require_requested_capabilities(required, required)
    try:
        return await fetch_gene_facts(database, identifier)
    except GeneFactsNotFound as exc:
        raise HTTPException(status_code=404, detail="Database record not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (TimeoutError, PublicHttpBoundaryError) as exc:
        raise HTTPException(status_code=502, detail="Gene database is unavailable") from exc
    except Exception as exc:
        # Never expose provider response bodies or networking internals to the UI.
        raise HTTPException(status_code=502, detail="Gene database is unavailable") from exc


_service: ExternalResourcesService | None = None


def set_service(service: ExternalResourcesService | None) -> None:
    """Wire the singleton service. Called from main.py during lifespan startup."""
    global _service
    _service = service
    set_external_runtime(service)


def _service_or_raise() -> ExternalResourcesService:
    if _service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="external_resources service not initialized",
        )
    return _service


class DiscoveryRankRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=500)
    candidates: list[DiscoveryCandidate] = Field(
        min_length=1, max_length=MAX_CANDIDATES
    )


class DiscoveryRankResponse(BaseModel):
    ids: list[str]


@router.post("/discovery/rank", response_model=DiscoveryRankResponse)
async def post_discovery_rank(
    body: DiscoveryRankRequest,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> DiscoveryRankResponse:
    _enforce_session(x_dnaforge_session)
    required = [DISCOVERY_CAPABILITY]
    _require_requested_capabilities(required, required)
    try:
        ids = await _service_or_raise().rank_discovery(
            body.query,
            body.candidates,
            granted_capabilities=_effective_external_capabilities(required),
        )
        return DiscoveryRankResponse(ids=ids)
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except (UnknownProvider, CircuitOpen) as exc:
        raise HTTPException(status_code=503, detail="Jev ranking unavailable") from exc
    except ProviderError as exc:
        raise _provider_error_http(exc) from exc


class FetchBindingSpec(BaseModel):
    """Optional `bind_to` block — when present, the service also writes an
    external_resource_binding row tying the fetched resource to a workspace
    sequence/feature/project.

    `source_kind` and `evidence` are `Literal`-validated at the API layer so
    invalid values produce 422 (Pydantic validation) rather than 500 (sqlite
    CHECK constraint violation). Length bounds mirror the renderer-side
    zod schema (apps/desktop/src/features/ai/tools/external-fetch.ts) and
    the manifest entry (packages/core/agent-tools/renderer-tool-manifest.json).
    """

    source_kind: Literal["sequence", "feature", "project"] = Field(...)
    source_uri: str = Field(
        ...,
        min_length=1,
        max_length=2000,
        description="waypoint:// URI for the workspace artifact",
    )
    relationship: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="'derived_from' | 'has_structure' | 'has_homolog' | ...",
    )
    evidence: Literal["asserted", "inferred", "predicted"] = Field(...)


class FetchRequestModel(BaseModel):
    provider: str = Field(
        ...,
        min_length=1,
        max_length=64,
        description="provider id, e.g. 'uniprot'",
    )
    external_id: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="raw provider-specific id (e.g. 'P00875')",
    )
    workspace_id: str | None = Field(
        None,
        max_length=200,
        description=(
            "workspace context for fetch_log + binding scoping; omit for system/indexer fetches"
        ),
    )
    granted_capabilities: list[str] = Field(
        default_factory=list,
        description=(
            "caller's granted capability scopes; must intersect provider's declared scopes"
        ),
    )
    bind_to: FetchBindingSpec | None = Field(
        None,
        description="optional workspace binding to create alongside the fetch",
    )


class FetchResponseModel(BaseModel):
    external_resource_id: str
    provider: str
    external_id: str
    cache_hit: bool
    license: str | None
    attribution: str | None
    metadata: dict[str, Any]
    xref_count: int
    binding_id: str | None = None
    agent_artifact_id: str | None = None


class UniProtSearchRequestModel(BaseModel):
    """: thin wrapper around UniProt /uniprotkb/search.

    The renderer's resolver chain (`apps/desktop/src/features/structure-drawer/`)
    builds opaque queries (`xref:embl-AAC73112.1 AND reviewed:true`,
    `gene_oln:b0001 AND organism_id:83333`, etc.) and POSTs them here. The
    sidecar wraps the call with the provider's rate-limit + circuit-breaker +
    backoff so the resolver chain doesn't have to duplicate those guarantees
    in TypeScript.
    """

    query: str = Field(..., description="UniProt search query, raw")
    size: int = Field(1, ge=1, le=10, description="max hits to return")
    workspace_id: str | None = Field(
        None, description="workspace context for fetch_log scoping"
    )
    granted_capabilities: list[str] = Field(default_factory=list)
    include_sequence: bool = Field(
        False,
        description=(
            "When true, include the UniProt canonical sequence and organism "
            "metadata for strict renderer-side sequence-overlap validation."
        ),
    )


class UniProtSearchHitModel(BaseModel):
    accession: str
    reviewed: bool
    sequence: str | None = None
    taxon_id: int | None = None
    organism: str | None = None


class UniProtSearchResponseModel(BaseModel):
    hits: list[UniProtSearchHitModel]


class UniProtBySequenceRequestModel(BaseModel):
    """Look up UniProt entries by exact protein-sequence MD5 match.

    The structure drawer's primary resolver mechanism: most user CDSes
    (reference-genome proteins, cloned wild-types, codon-optimized
    variants) have an exact UniProt entry. Hashing locally + querying
    UniProt's `checksum:` field returns the canonical accession with
    1.0 identity, no organism guessing or qualifier hints required.
    """

    sequence: str = Field(
        ...,
        min_length=1,
        max_length=200_000,
        description="Protein single-letter codes; trailing stop optional",
    )
    canonical_form_hint: Literal["waypoint-protein-v2"] | None = Field(
        None,
        description=(
            "Renderer-declared canonicalization contract. The sidecar still "
            "canonicalizes authoritatively before provider lookup."
        ),
    )
    workspace_id: str | None = Field(
        None,
        max_length=200,
        description="Workspace context for fetch_log scoping",
    )
    granted_capabilities: list[str] = Field(default_factory=list)
    size: int = Field(
        10,
        ge=1,
        le=50,
        description=(
            "Max hits to return. Default 10 covers the common case "
            "(highly-conserved proteins identical across many strains); "
            "raise only when the caller wants the full identical-sequence "
            "set across UniProt."
        ),
    )


class UniProtBySequenceHitModel(BaseModel):
    accession: str
    reviewed: bool
    match_evidence: "MatchEvidenceModel"
    pdb_ids: list[str] = Field(
        default_factory=list,
        description=(
            "PDB cross-references for this UniProt entry, preserved in "
            "UniProt's REST order. Used by the structure drawer to prefer "
            "experimental over predicted structures. Empty when the entry "
            "has no PDB xrefs (most bacterial proteins, novel sequences)."
        ),
    )
    pdb_xrefs: list["PdbXrefModel"] = Field(
        default_factory=list,
        description=(
            "Structured PDB cross-references with normalized method, resolution, "
            "chain ids, and raw UniProt properties. Kept alongside pdb_ids for "
            "backwards compatibility during the candidate-browser migration."
        ),
    )


class PdbXrefModel(BaseModel):
    pdb_id: str
    method: str | None = None
    resolution: float | None = None
    chains: list[str] = Field(default_factory=list)
    raw_properties: dict[str, str] = Field(default_factory=dict)


class QueryIdentityEvidenceModel(BaseModel):
    kind: Literal["internal_stop", "non_standard_residue", "protein_invalid_residue"]
    residue: str | None = None


class QueryIdentityModel(BaseModel):
    kind: Literal["protein_sequence"]
    normalized_length: int
    checksum_md5: str
    checksum_sha256: str
    canonical_form: Literal["waypoint-protein-v2"]
    canonical_lookup_sequence: str
    canonical_form_applied: bool = True
    ineligible: bool = False
    ineligible_reason: str | None = None
    evidence: list[QueryIdentityEvidenceModel] = Field(default_factory=list)


class MatchEvidenceModel(BaseModel):
    kind: Literal["exact_sequence_checksum", "xref", "id_mapping", "name_search"]
    checksum_md5: str | None = None
    sequence_identity: float | None = None
    taxon_id: int | None = None
    organism: str | None = None
    rank: int
    rank_reasons: list[str] = Field(default_factory=list)


class UniProtBySequenceResponseModel(BaseModel):
    md5: str = Field(
        ...,
        description=(
            "Uppercase hex MD5 we queried with. Echoed back so callers can "
            "audit / cache / display the hash that resolved their protein."
        ),
    )
    hits: list[UniProtBySequenceHitModel] = Field(
        ...,
        description=(
            "Sorted reviewed-first (Swiss-Prot before TrEMBL). Empty list "
            "indicates no UniProt entry has this exact sequence — caller "
            "should fall through to homology search."
        ),
    )
    query_identity: QueryIdentityModel


class AfdbValidateRequestModel(BaseModel):
    """: thin wrapper around AlphaFold DB existence check.

    Returns the prediction's mean pLDDT when AFDB has a structure for the
    requested UniProt accession, otherwise null. Renderer's resolver chain
    uses this to gate UniProt-resolving steps (2-7) — a UniProt entry without
    an AFDB prediction is a chain-fall-through, not a drawer render.
    """

    accession: str = Field(..., description="UniProt primary accession")
    fragment: str = Field("F1", min_length=2, max_length=16, pattern=r"^F[1-9][0-9]*$")
    workspace_id: str | None = Field(None)
    granted_capabilities: list[str] = Field(default_factory=list)


class AfdbValidateResponseModel(BaseModel):
    accession: str | None = Field(
        None, description="canonical UniProt accession or null on miss"
    )
    mean_plddt: float | None = Field(
        None, description="mean pLDDT confidence 0-100; null if AFDB doesn't report it"
    )
    latest_version: int | None = Field(
        None, description="latest AlphaFold model version, when AFDB reports it"
    )
    cif_url: str | None = Field(
        None, description="canonical AlphaFold CIF URL, when AFDB reports it"
    )
    provider_identity_key: str | None = Field(
        None, description="canonical scoped AlphaFold provider identity"
    )
    fragment: str | None = Field(None, description="AlphaFold model fragment, e.g. F1")
    model_id: str | None = Field(None, description="AlphaFold file/model identifier")
    exists: bool = Field(..., description="convenience: true iff AFDB has a prediction")


class RcsbValidateRequestModel(BaseModel):
    pdb_id: str = Field(..., min_length=4, max_length=10)
    workspace_id: str | None = Field(None, max_length=200)
    granted_capabilities: list[str] = Field(default_factory=list)


class RcsbValidateResponseModel(BaseModel):
    valid: bool
    pdb_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    license: str | None = None
    attribution: str | None = None


class RcsbSequenceSearchRequestModel(BaseModel):
    sequence: str = Field(..., min_length=25, max_length=200_000)
    sequence_type: Literal["protein", "rna", "dna"] = "rna"
    identity_cutoff: float = Field(0.9, ge=0, le=1)
    evalue_cutoff: float = Field(0.1, ge=0)
    size: int = Field(10, ge=1, le=50)
    workspace_id: str | None = Field(None, max_length=200)
    granted_capabilities: list[str] = Field(default_factory=list)


class RcsbSequenceSearchHitModel(BaseModel):
    identifier: str
    pdb_id: str
    entity_id: str | None = None
    score: float | None = None
    sequence_identity: float | None = None
    evalue: float | None = None
    bit_score: float | None = None


class RcsbSequenceSearchResponseModel(BaseModel):
    hits: list[RcsbSequenceSearchHitModel]


class AlphaFoldSummaryRequestModel(BaseModel):
    accession: str = Field(..., min_length=1, max_length=32)
    workspace_id: str | None = Field(None, max_length=200)
    granted_capabilities: list[str] = Field(default_factory=list)


class AlphaFoldSummaryResponseModel(BaseModel):
    valid: bool
    accession: str | None = None
    mean_plddt: float | None = None
    latest_version: int | None = None
    cif_url: str | None = None
    provider_identity_key: str | None = None
    fragment: str | None = None
    model_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    license: str | None = None
    attribution: str | None = None


class UniProtSummaryRequestModel(BaseModel):
    accession: str = Field(..., min_length=1, max_length=32)
    workspace_id: str | None = Field(None, max_length=200)
    granted_capabilities: list[str] = Field(default_factory=list)


class UniProtSummaryResponseModel(BaseModel):
    valid: bool
    accession: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    license: str | None = None
    attribution: str | None = None


class StructureBytesRequestModel(BaseModel):
    provider: Literal["rcsb", "alphafold"]
    external_id: str = Field(..., min_length=1, max_length=200)
    format: Literal["mmcif", "pdb"] = "mmcif"
    pdb_id: str | None = Field(None, min_length=4, max_length=10)
    pdb_entity_id: str | None = Field(None, min_length=1, max_length=32)
    label_asym_ids: list[str] = Field(default_factory=list, max_length=100)
    auth_asym_ids: list[str] = Field(default_factory=list, max_length=100)
    assembly_id: str | None = Field(None, min_length=1, max_length=32)
    accession: str | None = Field(None, min_length=1, max_length=32)
    fragment: str | None = Field(None, min_length=1, max_length=16)
    version: str | None = Field(None, min_length=1, max_length=16)
    model_id: str | None = Field(None, min_length=1, max_length=128)
    workspace_id: str | None = Field(None, max_length=200)
    granted_capabilities: list[str] = Field(default_factory=list)


class SequenceBytesRequestModel(BaseModel):
    """ — fetch a sequence record's bytes + provenance from a registered
    sequence provider (today: NCBI nuccore).

    The renderer's `import_sequence` tool POSTs this instead of fetching NCBI
    renderer-side via `@waypoint/bioinfo-client`. `provider` is a closed
    `Literal` so the route can never be steered at an arbitrary provider id;
    `format` is `genbank`-only because the NCBI nuccore provider fetches
    `gbwithparts` (a FASTA selector is a future provider capability)."""

    provider: Literal["ncbi-nuccore"] = Field(
        "ncbi-nuccore",
        description="Sequence provider id. Only NCBI nuccore is wired today.",
    )
    external_id: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="Provider accession, e.g. 'NC_000913.3'",
    )
    format: Literal["genbank"] = Field(
        "genbank",
        description="Record format. Only GenBank is supported today.",
    )
    workspace_id: str | None = Field(
        None,
        max_length=200,
        description="Workspace context for fetch_log scoping; omit for system fetches",
    )
    granted_capabilities: list[str] = Field(default_factory=list)


class SequenceUrlBytesRequestModel(BaseModel):
    """Credential-free public GenBank/FASTA source for ``import_sequence``."""

    url: str = Field(..., min_length=1, max_length=2000)
    workspace_id: str | None = Field(
        None,
        max_length=200,
        description="Workspace context for fetch_log scoping",
    )
    granted_capabilities: list[str] = Field(default_factory=list)


class PaperSourceRequestModel(BaseModel):
    url: str = Field(..., min_length=1, max_length=2000)
    workspace_id: str | None = Field(None, max_length=200)
    granted_capabilities: list[str] = Field(default_factory=list)


class PaperSourceResponseModel(BaseModel):
    kind: Literal["pdf", "captured_text"]
    original_url: str
    canonical_url: str
    media_type: str
    response_sha256: str
    byte_count: int
    title: str
    captured_at: str
    pdf_base64: str | None = None
    captured_text: str | None = None
    captured_text_sha256: str | None = None


class _StrictPaperGraphModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PaperGraphIdentifierModel(_StrictPaperGraphModel):
    scheme: Literal["pmid", "pmcid", "doi"]
    value: str = Field(..., min_length=1, max_length=500)


class PaperGraphSourceModel(_StrictPaperGraphModel):
    kind: Literal["pdf", "captured_text"]
    path: str | None = Field(None, min_length=1, max_length=500)
    title: str | None = Field(None, min_length=1, max_length=200)
    media_type: str | None = Field(None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def require_pdf_path(self) -> "PaperGraphSourceModel":
        if self.kind == "pdf" and self.path is None:
            raise ValueError("PDF paper graph sources require a workspace path")
        return self


class PaperGraphPdfRectModel(_StrictPaperGraphModel):
    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)
    width: float = Field(..., gt=0.0, le=1.0)
    height: float = Field(..., gt=0.0, le=1.0)


class PaperGraphPdfLocatorModel(_StrictPaperGraphModel):
    kind: Literal["pdf_rects"]
    page: int = Field(..., ge=1)
    rects: list[PaperGraphPdfRectModel] = Field(..., min_length=1, max_length=100)


class PaperGraphTextLocatorModel(_StrictPaperGraphModel):
    kind: Literal["text_span"]
    start: int = Field(..., ge=0)
    end: int = Field(..., ge=1)

    @model_validator(mode="after")
    def require_forward_span(self) -> "PaperGraphTextLocatorModel":
        if self.end <= self.start:
            raise ValueError("Text evidence end must be greater than start")
        return self


PaperGraphLocatorModel = Annotated[
    PaperGraphPdfLocatorModel | PaperGraphTextLocatorModel,
    Field(discriminator="kind"),
]
PaperGraphBlockId = Annotated[
    str,
    Field(pattern=r"^(?:p[1-9]\d*-b[1-9]\d*|text-b[1-9]\d*)$"),
]


class PaperGraphEvidenceModel(_StrictPaperGraphModel):
    block_ids: list[PaperGraphBlockId] = Field(..., min_length=1, max_length=100)
    quote: str = Field(..., min_length=1, max_length=50_000)
    locator: PaperGraphLocatorModel


class PaperGraphTraceModel(_StrictPaperGraphModel):
    relationship: Literal["identifies_as", "cites", "uses_method_from", "supplement_to"]
    target: PaperGraphIdentifierModel
    evidence: PaperGraphEvidenceModel


class PaperGraphRecordRequestModel(_StrictPaperGraphModel):
    workspace_id: str = Field(..., min_length=1, max_length=2_000)
    source_sha256: str = Field(..., pattern=r"^(?:sha256:)?[a-f0-9]{64}$")
    source: PaperGraphSourceModel
    traces: list[PaperGraphTraceModel] = Field(..., min_length=1, max_length=100)
    granted_capabilities: list[str] = Field(default_factory=list, max_length=100)


class PaperGraphIdentifierResponseModel(_StrictPaperGraphModel):
    scheme: str
    value: str
    node_id: str


class PaperGraphRecordResponseModel(_StrictPaperGraphModel):
    source_uri: str
    source_sha256: str
    edge_count: int
    identifiers: list[PaperGraphIdentifierResponseModel]
    replayed: bool


class PaperGraphQueryRequestModel(_StrictPaperGraphModel):
    workspace_id: str = Field(..., min_length=1, max_length=2_000)
    source_sha256: str = Field(..., pattern=r"^(?:sha256:)?[a-f0-9]{64}$")
    depth: int = Field(1, ge=1, le=2)
    max_nodes: int = Field(100, ge=1, le=100)
    granted_capabilities: list[str] = Field(default_factory=list, max_length=100)


class PaperGraphNodeResponseModel(_StrictPaperGraphModel):
    id: str
    kind: Literal["paper_source", "publication_identifier"]
    sha256: str | None = None
    source: dict[str, Any] | None = None
    scheme: str | None = None
    value: str | None = None


class PaperGraphEdgeResponseModel(_StrictPaperGraphModel):
    id: str
    source_node_id: str
    target_node_id: str
    relationship: str
    evidence: str
    trace: dict[str, Any]


class PaperGraphQueryResponseModel(_StrictPaperGraphModel):
    source_uri: str
    nodes: list[PaperGraphNodeResponseModel]
    edges: list[PaperGraphEdgeResponseModel]
    truncated: bool


class SequenceBytesResponseModel(BaseModel):
    """The fetched record as UTF-8 text plus provider/source provenance.

    `content` is the GenBank record text (returned inline, not via a header,
    so non-ASCII organism/definition fields can't break header encoding).
    `metadata` is the provider's light header parse (organism, definition,
    length, topology, taxon_id, accession, locus)."""

    provider: str
    external_id: str
    format: str
    content: str
    content_sha256: str
    source_url: str | None = None
    license: str | None = None
    attribution: str | None = None
    version_identifier: str | None = None
    etag: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ExternalResourceModel(BaseModel):
    id: str
    provider: str
    external_id: str
    external_url: str | None
    data_file_id: str | None
    version_identifier: str | None
    etag: str | None
    license: str | None
    attribution: str | None
    metadata: dict[str, Any]
    fetched_at: str
    last_checked: str


class UcscTrackSearchRequestModel(BaseModel):
    genome: str = Field(..., min_length=1, max_length=64)
    query: str = Field("", max_length=200)
    limit: int = Field(50, ge=1, le=200)
    hub_url: str | None = Field(None, max_length=2048)
    workspace_id: str | None = Field(None, max_length=200)
    granted_capabilities: list[str] = Field(default_factory=list)


class UcscTrackAttributeModel(BaseModel):
    """One fact the catalog declares about a track, such as cellType=vagina."""

    key: str
    value: str
    origin: Literal["subgroup", "metadata"]


class UcscTrackSignalScaleModel(BaseModel):
    """The value range a publisher intends a signal track to be drawn against."""

    auto: bool
    minimum: float | None = None
    maximum: float | None = None
    always_zero: bool


class UcscTrackContainerModel(BaseModel):
    """One grouping a hub declares above a track, outermost first."""

    track: str
    short_label: str
    long_label: str | None = None
    kind: Literal["composite", "super", "view", "container"]


class UcscTrackModel(BaseModel):
    track: str
    short_label: str
    long_label: str
    group: str | None = None
    track_type: str
    scientific_kind: Literal[
        "transcript",
        "interval",
        "quantitative",
        "peak",
        "repeat",
        "reads",
        "variants",
        "unsupported",
    ]
    format_id: Literal["ucsc-native", "bigbed", "bigwig", "bam", "vcf"]
    big_data_url: str | None = None
    big_data_index: str | None = None
    source_kind: Literal["ucsc-native", "ucsc-hub"]
    hub_url: str | None = None
    parent_track: str | None = None
    parent_parent_track: str | None = None
    catalog_color: str | None = None
    experiment_accession: str | None = None
    file_accession: str | None = None
    container_path: list[UcscTrackContainerModel] = Field(default_factory=list)
    attributes: list[UcscTrackAttributeModel] = Field(default_factory=list)
    signal_scale: UcscTrackSignalScaleModel | None = None


class UcscTrackSearchResponseModel(BaseModel):
    tracks: list[UcscTrackModel]


class UcscCatalogRequestModel(BaseModel):
    genome: str = Field(..., min_length=1, max_length=64)
    hub_url: str | None = Field(None, max_length=2048)
    workspace_id: str | None = Field(None, max_length=200)
    granted_capabilities: list[str] = Field(default_factory=list)


class UcscCatalogResponseModel(BaseModel):
    """Every renderable track in one assembly's catalog.

    ``total`` is the length of ``tracks``. It is stated anyway so a reader
    of the payload never has to infer whether anything was held back.
    """

    tracks: list[UcscTrackModel]
    total: int


class UcscTrackRegionRequestModel(BaseModel):
    genome: str = Field(..., min_length=1, max_length=64)
    track: str = Field(..., min_length=1, max_length=200)
    chrom: str | None = Field(None, min_length=1, max_length=100)
    start: int | None = Field(None, ge=0)
    end: int | None = Field(None, gt=0)
    max_items_output: int = Field(10_000, ge=1, le=1_000_000)
    hub_url: str | None = Field(None, max_length=2048)
    workspace_id: str | None = Field(None, max_length=200)
    granted_capabilities: list[str] = Field(default_factory=list)


class UcscTrackRegionResponseModel(BaseModel):
    records: list[dict[str, Any]]
    complete: bool
    items_returned: int
    max_items_output: int
    track_type: str | None = None
    big_data_url: str | None = None


class UcscTrackAdmissionRequestModel(BaseModel):
    genome: str = Field(..., min_length=1, max_length=64)
    track: str = Field(..., min_length=1, max_length=200)
    format_id: Literal["bigwig", "bigbed"]
    probe_chrom: str = Field(..., min_length=1, max_length=100)
    hub_url: str | None = Field(None, max_length=2048)
    workspace_id: str | None = Field(None, max_length=200)
    granted_capabilities: list[str] = Field(default_factory=list)


class UcscTrackAdmissionResponseModel(BaseModel):
    source_uri: str
    source_token: str
    canonical_url_hash: str
    representation_sha256: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    representation_identity_kind: Literal["strong-etag", "content-sha256"]
    format: Literal["bigwig", "bigbed"]
    byte_length: int
    accepts_ranges: Literal[True]
    etag: str | None = None
    last_modified: str | None = None
    expires_in_seconds: int
    provenance_id: str


class _UcscApiRequestModel(BaseModel):
    """Shared authority context for the typed UCSC API endpoint routes."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    workspace_id: str | None = Field(None, max_length=200)
    granted_capabilities: list[str] = Field(default_factory=list)


UcscMaxItemsOutput = Literal[-1] | Annotated[int, Field(ge=1, le=1_000_000)]


class _UcscMaxItemsApiRequestModel(_UcscApiRequestModel):
    max_items_output: UcscMaxItemsOutput | None = None


class UcscFindGenomeRequestModel(_UcscMaxItemsApiRequestModel):
    q: str = Field(..., min_length=1, max_length=500)
    browser: Literal["mustExist", "mayExist", "notExist"] = "mustExist"
    stats_only: bool = False
    year: int | None = Field(None, ge=1800, le=2200)
    category: Literal["reference", "representative"] | None = None
    status: Literal["reference", "representative"] | None = None
    level: Literal["complete", "chromosome", "scaffold", "contig"] | None = None


class UcscEmptyApiRequestModel(_UcscApiRequestModel):
    pass


class UcscGenarkGenomesRequestModel(_UcscMaxItemsApiRequestModel):
    genome: str | None = Field(None, min_length=1, max_length=200)


class UcscHubGenomesRequestModel(_UcscApiRequestModel):
    hub_url: str = Field(..., min_length=1, max_length=2048)


class UcscFilesRequestModel(_UcscMaxItemsApiRequestModel):
    genome: str = Field(..., min_length=1, max_length=200)
    format: Literal["text"] | None = None


class UcscTracksRequestModel(_UcscApiRequestModel):
    genome: str = Field(..., min_length=1, max_length=200)
    hub_url: str | None = Field(None, min_length=1, max_length=2048)
    track_leaves_only: bool = False


class UcscChromosomesRequestModel(_UcscApiRequestModel):
    genome: str = Field(..., min_length=1, max_length=200)
    hub_url: str | None = Field(None, min_length=1, max_length=2048)
    track: str | None = Field(None, min_length=1, max_length=200)


class UcscSchemaRequestModel(_UcscApiRequestModel):
    genome: str = Field(..., min_length=1, max_length=200)
    track: str = Field(..., min_length=1, max_length=200)
    hub_url: str | None = Field(None, min_length=1, max_length=2048)


class UcscSequenceRequestModel(_UcscApiRequestModel):
    genome: str = Field(..., min_length=1, max_length=200)
    chrom: str = Field(..., min_length=1, max_length=200)
    start: int | None = Field(None, ge=0)
    end: int | None = Field(None, gt=0)
    rev_comp: bool = False
    hub_url: str | None = Field(None, min_length=1, max_length=2048)

    @model_validator(mode="after")
    def validate_interval(self) -> UcscSequenceRequestModel:
        if (self.start is None) != (self.end is None):
            raise ValueError("UCSC start and end must be supplied together")
        if self.start is not None and self.end is not None and self.end <= self.start:
            raise ValueError("UCSC interval must satisfy 0 <= start < end")
        return self


class UcscTrackDataRequestModel(_UcscMaxItemsApiRequestModel):
    genome: str = Field(..., min_length=1, max_length=200)
    track: str = Field(..., min_length=1, max_length=200)
    chrom: str | None = Field(None, min_length=1, max_length=200)
    start: int | None = Field(None, ge=0)
    end: int | None = Field(None, gt=0)
    json_output_arrays: bool = False
    hub_url: str | None = Field(None, min_length=1, max_length=2048)

    @model_validator(mode="after")
    def validate_interval(self) -> UcscTrackDataRequestModel:
        if (self.start is None) != (self.end is None):
            raise ValueError("UCSC start and end must be supplied together")
        if self.start is not None:
            if self.chrom is None:
                raise ValueError("UCSC track intervals require a chromosome")
            if self.end is not None and self.end <= self.start:
                raise ValueError("UCSC interval must satisfy 0 <= start < end")
        return self


class UcscSearchRequestModel(_UcscApiRequestModel):
    search: str = Field(..., min_length=1, max_length=500)
    genome: str = Field(..., min_length=1, max_length=200)
    categories: Literal["helpDocs", "publicHubs", "trackDb"] | None = None


class UcscApiResponseModel(BaseModel):
    endpoint: UcscApiEndpoint
    data: dict[str, JsonValue] | str


_UCSC_RESPONSE_CHUNK_BYTES = 64 * 1024


def _stream_ucsc_api_envelope(
    endpoint: UcscApiEndpoint,
    payload: UcscApiPayload,
) -> AsyncIterator[bytes]:
    """Wrap a spooled UCSC value without constructing it in sidecar memory."""

    endpoint_json = json.dumps(endpoint.value, separators=(",", ":")).encode("utf-8")
    try:
        yield b'{"endpoint":' + endpoint_json + b',"data":'
        if payload.content_kind == "json":
            while chunk := payload.body.read(_UCSC_RESPONSE_CHUNK_BYTES):
                yield chunk
        else:
            decoder = codecs.getincrementaldecoder("utf-8")()
            yield b'"'
            while chunk := payload.body.read(_UCSC_RESPONSE_CHUNK_BYTES):
                text = decoder.decode(chunk, final=False)
                if text:
                    yield json.dumps(text, ensure_ascii=False)[1:-1].encode("utf-8")
            tail = decoder.decode(b"", final=True)
            if tail:
                yield json.dumps(tail, ensure_ascii=False)[1:-1].encode("utf-8")
            yield b'"'
        yield b"}"
    finally:
        payload.body.close()


class IndexedTrackAdmissionRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    source_kind: Literal["path", "url", "s3", "gcs"]
    source: str | None = Field(default=None, min_length=1, max_length=8192)
    bucket: str | None = Field(default=None, min_length=3, max_length=222)
    object_key: str | None = Field(default=None, min_length=1, max_length=4096)
    region: str | None = Field(default=None, min_length=1, max_length=128)
    requester_pays: bool = False
    billing_project: str | None = Field(default=None, min_length=1, max_length=256)
    auth_ref: str | None = Field(
        default=None,
        min_length=1,
        max_length=256,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$",
    )
    local_path_authority: str | None = Field(default=None, min_length=64, max_length=64)
    format_id: Literal[
        "bigwig",
        "bigbed",
        "bam",
        "cram",
        "bai",
        "crai",
        "csi",
        "vcf",
        "bcf",
        "tbi",
    ]
    provenance_id: str = Field(..., min_length=1, max_length=500)
    granted_capabilities: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_locator(self) -> IndexedTrackAdmissionRequestModel:
        cloud_fields = {
            "bucket": self.bucket,
            "object_key": self.object_key,
            "region": self.region,
            "billing_project": self.billing_project,
        }
        if self.source_kind in {"path", "url"}:
            if self.source is None or any(
                value is not None for value in cloud_fields.values()
            ):
                raise ValueError("path and URL sources require only the source locator")
            if self.requester_pays:
                raise ValueError("requester-pays is valid only for S3 sources")
            if self.source_kind == "path" and self.auth_ref is not None:
                raise ValueError(
                    "local indexed sources may not carry a credential reference"
                )
            return self
        if self.source is not None or self.bucket is None or self.object_key is None:
            raise ValueError("object-storage sources require a bucket and object key")
        if self.source_kind == "s3":
            if self.billing_project is not None:
                raise ValueError("billing projects are valid only for GCS sources")
            if self.requester_pays and self.auth_ref is None:
                raise ValueError(
                    "requester-pays S3 sources require a credential reference"
                )
        else:
            if self.region is not None or self.requester_pays:
                raise ValueError(
                    "S3 region and requester-pays are invalid for GCS sources"
                )
            if self.billing_project is not None and self.auth_ref is None:
                raise ValueError("GCS billing projects require a credential reference")
        return self


class SourceCredentialRegistrationRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    auth_ref: str = Field(
        ...,
        min_length=1,
        max_length=256,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$",
    )
    kind: Literal[
        "http-bearer",
        "http-basic",
        "http-header",
        "aws-sigv4",
        "gcs-oauth",
    ]
    material: dict[str, str] = Field(..., min_length=1, max_length=3)


class SourceCredentialRegistrationResponseModel(BaseModel):
    auth_ref: str
    kind: Literal[
        "http-bearer",
        "http-basic",
        "http-header",
        "aws-sigv4",
        "gcs-oauth",
    ]


class SourceCredentialRemovalRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    auth_ref: str = Field(
        ...,
        min_length=1,
        max_length=256,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$",
    )


class SourceCredentialRemovalResponseModel(BaseModel):
    auth_ref: str
    removed: bool


class IndexedTrackAdmissionResponseModel(BaseModel):
    source_uri: str
    source_token: str
    canonical_url_hash: str
    format: Literal[
        "bigwig",
        "bigbed",
        "bam",
        "cram",
        "bai",
        "crai",
        "csi",
        "vcf",
        "bcf",
        "tbi",
    ]
    byte_length: int
    accepts_ranges: Literal[True]
    etag: str | None = None
    last_modified: str | None = None
    expires_in_seconds: int
    provenance_id: str


class IndexedTrackMaterializationRequestModel(BaseModel):
    source_token: str = Field(..., min_length=16, max_length=200)


class IndexedTrackMaterializationResponseModel(BaseModel):
    source_path: str
    representation_sha256: str = Field(..., min_length=64, max_length=64)
    canonical_url_hash: str = Field(..., min_length=64, max_length=64)
    format: Literal[
        "bigwig",
        "bigbed",
        "bam",
        "cram",
        "bai",
        "crai",
        "csi",
        "vcf",
        "bcf",
        "tbi",
    ]
    byte_length: int
    expires_in_seconds: int


class IndexedVariantReferenceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    name: str = Field(..., min_length=1, max_length=512)
    length: int = Field(..., gt=0)


class IndexedVariantRuntimeRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    source_token: str = Field(..., min_length=16, max_length=200)
    index_token: str = Field(..., min_length=16, max_length=200)
    references: list[IndexedVariantReferenceModel] = Field(..., min_length=1)

    @model_validator(mode="after")
    def validate_unique_references(self) -> IndexedVariantRuntimeRequestModel:
        names = [reference.name for reference in self.references]
        if len(names) != len(set(names)):
            raise ValueError("variant references must have unique names")
        if any(any(character.isspace() for character in name) for name in names):
            raise ValueError("variant reference names may not contain whitespace")
        return self


class IndexedVariantRuntimeResponseModel(BaseModel):
    format: Literal["vcf", "bcf"]
    source_identity: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    assembly_revision: str = Field(
        ..., pattern=r"^variant-assembly-v1:sha256:[0-9a-f]{64}$"
    )
    matched_references: list[str] = Field(..., min_length=1)
    samples: list[str]
    expires_in_seconds: int = Field(..., gt=0)


class IndexedVariantPageRequestModel(IndexedVariantRuntimeRequestModel):
    source_identity: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    assembly_revision: str = Field(
        ..., pattern=r"^variant-assembly-v1:sha256:[0-9a-f]{64}$"
    )
    cursor: str | None = Field(default=None, max_length=4096)
    limit: int = Field(default=100, ge=1, le=200)


class IndexedVariantRegionRequestModel(IndexedVariantRuntimeRequestModel):
    source_identity: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    assembly_revision: str = Field(
        ..., pattern=r"^variant-assembly-v1:sha256:[0-9a-f]{64}$"
    )
    chrom: str = Field(..., min_length=1, max_length=512, pattern=r"^\S+$")
    start: int = Field(..., ge=0)
    end: int = Field(..., gt=0)
    limit: int = Field(default=10_000, ge=1, le=10_000)

    @model_validator(mode="after")
    def validate_region(self) -> IndexedVariantRegionRequestModel:
        if self.end <= self.start:
            raise ValueError("variant region end must be greater than start")
        if self.end - self.start > 5_000_000:
            raise ValueError("variant region exceeds the 5,000,000-base viewport limit")
        return self


class HtsgetPreparationRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    endpoint: str = Field(..., min_length=1, max_length=8192)
    resource_id: str = Field(..., min_length=1, max_length=2048)
    data_class: Literal["reads", "variants"]
    format: Literal["BAM", "CRAM", "VCF", "BCF"]
    references: list[IndexedVariantReferenceModel] = Field(..., min_length=1)
    auth_ref: str | None = Field(default=None, min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_source_contract(self) -> HtsgetPreparationRequestModel:
        valid = (self.data_class == "reads" and self.format in {"BAM", "CRAM"}) or (
            self.data_class == "variants" and self.format in {"VCF", "BCF"}
        )
        if not valid:
            raise ValueError("htsget data class and format do not match")
        names = [reference.name for reference in self.references]
        if len(names) != len(set(names)):
            raise ValueError("htsget references must have unique names")
        return self


class HtsgetPreparationResponseModel(BaseModel):
    source_token: str
    source_identity: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    data_class: Literal["reads", "variants"]
    format: Literal["BAM", "CRAM", "VCF", "BCF"]
    references: list[IndexedVariantReferenceModel]
    matched_references: list[str]
    samples: list[str]
    assembly_revision: str = Field(
        ..., pattern=r"^variant-assembly-v1:sha256:[0-9a-f]{64}$"
    )
    expires_in_seconds: int = Field(..., gt=0)


class HtsgetVariantPageRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    source_token: str = Field(..., min_length=16, max_length=200)
    source_identity: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    assembly_revision: str = Field(
        ..., pattern=r"^variant-assembly-v1:sha256:[0-9a-f]{64}$"
    )
    references: list[IndexedVariantReferenceModel] = Field(..., min_length=1)
    cursor: str | None = Field(default=None, max_length=4096)
    limit: int = Field(default=100, ge=1, le=200)


class HtsgetVariantRegionRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    source_token: str = Field(..., min_length=16, max_length=200)
    source_identity: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    assembly_revision: str = Field(
        ..., pattern=r"^variant-assembly-v1:sha256:[0-9a-f]{64}$"
    )
    references: list[IndexedVariantReferenceModel] = Field(..., min_length=1)
    chrom: str = Field(..., min_length=1, max_length=512, pattern=r"^\S+$")
    start: int = Field(..., ge=0)
    end: int = Field(..., gt=0)
    limit: int = Field(default=10_000, ge=1, le=10_000)

    @model_validator(mode="after")
    def validate_region(self) -> HtsgetVariantRegionRequestModel:
        if self.end <= self.start:
            raise ValueError("variant region end must be greater than start")
        if self.end - self.start > 5_000_000:
            raise ValueError("variant region exceeds the 5,000,000-base viewport limit")
        names = [reference.name for reference in self.references]
        if len(names) != len(set(names)):
            raise ValueError("htsget references must have unique names")
        return self


@router.post(
    "/fetch",
    response_model=FetchResponseModel,
    summary="Fetch and register an external biology resource",
)
async def post_fetch(
    body: FetchRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
    x_dnaforge_action_id: str | None = Header(
        default=None, alias="X-DNAForge-Action-Id"
    ),
) -> FetchResponseModel:
    """Fetch + persist an external resource. Idempotent on (provider, external_id)."""
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()

    try:
        response = await service.fetch(
            FetchRequest(
                provider=body.provider,
                raw_id=body.external_id,
                workspace_id=body.workspace_id,
                granted_capabilities=_effective_external_capabilities(
                    body.granted_capabilities
                ),
                bind_to=body.bind_to.model_dump() if body.bind_to else None,
                agent_action_id=x_dnaforge_action_id,
            )
        )
    except CapabilityDenied as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "capability_denied",
                "required": exc.required,
                "granted": exc.granted,
            },
        ) from exc
    except CircuitOpen as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "circuit_open",
                "origin": exc.origin,
                "retry_after_s": exc.opens_at_s,
            },
        ) from exc
    except UnknownProvider as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "unknown_provider", "message": str(exc)},
        ) from exc
    except ServiceError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "invalid_request", "message": str(exc)},
        ) from exc
    except ProviderError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "error": "provider_error",
                "failure_kind": exc.failure_kind,
                "message": str(exc),
                "status_code": exc.status_code,
            },
        ) from exc

    return FetchResponseModel(
        external_resource_id=response.external_resource_id,
        provider=body.provider,
        external_id=response.external_id,
        cache_hit=response.cache_hit,
        license=response.license,
        attribution=response.attribution,
        metadata=response.metadata,
        xref_count=response.xref_count,
        binding_id=response.binding_id,
        agent_artifact_id=response.agent_artifact_id,
    )


def _ucsc_api_params(**values: str | int | bool | None) -> dict[str, str]:
    params: dict[str, str] = {}
    for name, value in values.items():
        if value is None or value is False:
            continue
        params[name] = "1" if value is True else str(value)
    return params


async def _request_ucsc_api(
    endpoint: UcscApiEndpoint,
    body: _UcscApiRequestModel,
    params: dict[str, str],
    session_token: str | None,
) -> Response:
    _enforce_session(session_token)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_ANNOTATION.value])
    service = _service_or_raise()
    try:
        payload = await service.request_ucsc_api_payload(
            endpoint,
            params=params,
            workspace_id=body.workspace_id,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except CircuitOpen as exc:
        raise _circuit_open_http(exc) from exc
    except UnknownProvider as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "unknown_provider", "message": str(exc)},
        ) from exc
    except ProviderError as exc:
        raise _provider_error_http(exc) from exc
    return StreamingResponse(
        _stream_ucsc_api_envelope(endpoint, payload),
        media_type="application/json",
        headers={
            "Cache-Control": "private, no-store",
            "X-DNAForge-UCSC-Response-Mode": "bounded-stream",
        },
    )


@router.post(
    "/ucsc/api/findGenome",
    response_model=UcscApiResponseModel,
    summary="Call UCSC findGenome",
)
async def post_ucsc_find_genome(
    body: UcscFindGenomeRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscApiResponseModel:
    return await _request_ucsc_api(
        UcscApiEndpoint.FIND_GENOME,
        body,
        _ucsc_api_params(
            q=body.q,
            browser=body.browser,
            statsOnly=body.stats_only,
            year=body.year,
            category=body.category,
            status=body.status,
            level=body.level,
            maxItemsOutput=body.max_items_output,
        ),
        x_dnaforge_session,
    )


@router.post(
    "/ucsc/api/list/publicHubs",
    response_model=UcscApiResponseModel,
    summary="Call UCSC list/publicHubs",
)
async def post_ucsc_public_hubs(
    body: UcscEmptyApiRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscApiResponseModel:
    return await _request_ucsc_api(
        UcscApiEndpoint.LIST_PUBLIC_HUBS, body, {}, x_dnaforge_session
    )


@router.post(
    "/ucsc/api/list/ucscGenomes",
    response_model=UcscApiResponseModel,
    summary="Call UCSC list/ucscGenomes",
)
async def post_ucsc_ucsc_genomes(
    body: UcscEmptyApiRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscApiResponseModel:
    return await _request_ucsc_api(
        UcscApiEndpoint.LIST_UCSC_GENOMES, body, {}, x_dnaforge_session
    )


@router.post(
    "/ucsc/api/list/genarkGenomes",
    response_model=UcscApiResponseModel,
    summary="Call UCSC list/genarkGenomes",
)
async def post_ucsc_genark_genomes(
    body: UcscGenarkGenomesRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscApiResponseModel:
    return await _request_ucsc_api(
        UcscApiEndpoint.LIST_GENARK_GENOMES,
        body,
        _ucsc_api_params(
            genome=body.genome,
            maxItemsOutput=body.max_items_output,
        ),
        x_dnaforge_session,
    )


@router.post(
    "/ucsc/api/list/hubGenomes",
    response_model=UcscApiResponseModel,
    summary="Call UCSC list/hubGenomes",
)
async def post_ucsc_hub_genomes(
    body: UcscHubGenomesRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscApiResponseModel:
    return await _request_ucsc_api(
        UcscApiEndpoint.LIST_HUB_GENOMES,
        body,
        _ucsc_api_params(hubUrl=body.hub_url),
        x_dnaforge_session,
    )


@router.post(
    "/ucsc/api/list/files",
    response_model=UcscApiResponseModel,
    summary="Call UCSC list/files",
)
async def post_ucsc_files(
    body: UcscFilesRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscApiResponseModel:
    return await _request_ucsc_api(
        UcscApiEndpoint.LIST_FILES,
        body,
        _ucsc_api_params(
            genome=body.genome,
            format=body.format,
            maxItemsOutput=body.max_items_output,
        ),
        x_dnaforge_session,
    )


@router.post(
    "/ucsc/api/list/tracks",
    response_model=UcscApiResponseModel,
    summary="Call UCSC list/tracks",
)
async def post_ucsc_tracks(
    body: UcscTracksRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscApiResponseModel:
    return await _request_ucsc_api(
        UcscApiEndpoint.LIST_TRACKS,
        body,
        _ucsc_api_params(
            genome=body.genome,
            hubUrl=body.hub_url,
            trackLeavesOnly=body.track_leaves_only,
        ),
        x_dnaforge_session,
    )


@router.post(
    "/ucsc/api/list/chromosomes",
    response_model=UcscApiResponseModel,
    summary="Call UCSC list/chromosomes",
)
async def post_ucsc_chromosomes(
    body: UcscChromosomesRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscApiResponseModel:
    return await _request_ucsc_api(
        UcscApiEndpoint.LIST_CHROMOSOMES,
        body,
        _ucsc_api_params(
            genome=body.genome,
            hubUrl=body.hub_url,
            track=body.track,
        ),
        x_dnaforge_session,
    )


@router.post(
    "/ucsc/api/list/schema",
    response_model=UcscApiResponseModel,
    summary="Call UCSC list/schema",
)
async def post_ucsc_schema(
    body: UcscSchemaRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscApiResponseModel:
    return await _request_ucsc_api(
        UcscApiEndpoint.LIST_SCHEMA,
        body,
        _ucsc_api_params(
            genome=body.genome,
            track=body.track,
            hubUrl=body.hub_url,
        ),
        x_dnaforge_session,
    )


@router.post(
    "/ucsc/api/getData/sequence",
    response_model=UcscApiResponseModel,
    summary="Call UCSC getData/sequence",
)
async def post_ucsc_sequence(
    body: UcscSequenceRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscApiResponseModel:
    return await _request_ucsc_api(
        UcscApiEndpoint.GET_SEQUENCE,
        body,
        _ucsc_api_params(
            genome=body.genome,
            chrom=body.chrom,
            start=body.start,
            end=body.end,
            revComp=body.rev_comp,
            hubUrl=body.hub_url,
        ),
        x_dnaforge_session,
    )


@router.post(
    "/ucsc/api/getData/track",
    response_model=UcscApiResponseModel,
    summary="Call UCSC getData/track",
)
async def post_ucsc_track_data(
    body: UcscTrackDataRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscApiResponseModel:
    return await _request_ucsc_api(
        UcscApiEndpoint.GET_TRACK,
        body,
        _ucsc_api_params(
            genome=body.genome,
            track=body.track,
            chrom=body.chrom,
            start=body.start,
            end=body.end,
            maxItemsOutput=body.max_items_output,
            jsonOutputArrays=body.json_output_arrays,
            hubUrl=body.hub_url,
        ),
        x_dnaforge_session,
    )


@router.post(
    "/ucsc/api/search",
    response_model=UcscApiResponseModel,
    summary="Call UCSC search",
)
async def post_ucsc_search(
    body: UcscSearchRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscApiResponseModel:
    return await _request_ucsc_api(
        UcscApiEndpoint.SEARCH,
        body,
        _ucsc_api_params(
            search=body.search,
            genome=body.genome,
            categories=body.categories,
        ),
        x_dnaforge_session,
    )


_UCSC_CATALOG_MAX_TRACKS = 150_000

_UCSC_CATALOG_PAYLOADS: OrderedDict[str, tuple[Any, bytes]] = OrderedDict()
_UCSC_CATALOG_PAYLOAD_MAX_ENTRIES = 4


def _ucsc_track_model(track: Any) -> UcscTrackModel:
    """One catalog leaf on the wire, with everything the catalog declared."""
    return UcscTrackModel(
        track=track.track,
        short_label=track.short_label,
        long_label=track.long_label,
        group=track.group,
        track_type=track.track_type,
        scientific_kind=track.scientific_kind,
        format_id=track.format_id,
        big_data_url=track.big_data_url,
        big_data_index=track.big_data_index,
        source_kind=track.source_kind,
        hub_url=track.hub_url,
        parent_track=track.parent_track,
        parent_parent_track=track.parent_parent_track,
        catalog_color=track.catalog_color,
        experiment_accession=track.experiment_accession,
        file_accession=track.file_accession,
        container_path=[
            UcscTrackContainerModel(
                track=container.track,
                short_label=container.short_label,
                long_label=container.long_label,
                kind=container.kind,
            )
            for container in track.container_path
        ],
        attributes=[
            UcscTrackAttributeModel(
                key=attribute.key,
                value=attribute.value,
                origin=attribute.origin,
            )
            for attribute in track.attributes
        ],
        signal_scale=(
            UcscTrackSignalScaleModel(
                auto=track.signal_scale.auto,
                minimum=track.signal_scale.minimum,
                maximum=track.signal_scale.maximum,
                always_zero=track.signal_scale.always_zero,
            )
            if track.signal_scale
            else None
        ),
    )


@router.post(
    "/ucsc/tracks/search",
    response_model=UcscTrackSearchResponseModel,
    summary="Search the official UCSC track catalog for an assembly",
)
async def post_ucsc_track_search(
    body: UcscTrackSearchRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscTrackSearchResponseModel:
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_ANNOTATION.value])
    service = _service_or_raise()
    try:
        tracks = await service.search_ucsc_tracks(
            body.genome,
            body.query,
            limit=body.limit,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
            hub_url=body.hub_url,
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except CircuitOpen as exc:
        raise _circuit_open_http(exc) from exc
    except UnknownProvider as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "unknown_provider", "message": str(exc)},
        ) from exc
    except ProviderError as exc:
        raise _provider_error_http(exc) from exc
    return UcscTrackSearchResponseModel(
        tracks=[_ucsc_track_model(track) for track in tracks]
    )


@router.post(
    "/ucsc/tracks/catalog",
    response_model=UcscCatalogResponseModel,
    response_class=Response,
    summary="Read an assembly's whole renderable UCSC track catalog",
)
async def post_ucsc_catalog(
    body: UcscCatalogRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> Response:
    """Hand over the entire catalog so the caller can count it honestly.

    A truncated search cannot report how many tracks a folder holds or how
    many results a query really had, because it has already thrown both away.
    The largest catalog UCSC publishes is a couple of megabytes of JSON and
    the sidecar keeps it parsed in memory, so returning all of it costs less
    than the round trips a paged version would need.
    """
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_ANNOTATION.value])
    service = _service_or_raise()
    try:
        tracks = await service.list_ucsc_catalog(
            body.genome,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
            hub_url=body.hub_url,
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except CircuitOpen as exc:
        raise _circuit_open_http(exc) from exc
    except UnknownProvider as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "unknown_provider", "message": str(exc)},
        ) from exc
    except ProviderError as exc:
        raise _provider_error_http(exc) from exc
    if len(tracks) > _UCSC_CATALOG_MAX_TRACKS:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail={
                "error": "catalog_too_large",
                "message": (
                    f"catalog holds {len(tracks)} tracks, above the "
                    f"{_UCSC_CATALOG_MAX_TRACKS} that may be served whole"
                ),
                "total": len(tracks),
                "limit": _UCSC_CATALOG_MAX_TRACKS,
            },
        )
    cache_key = f"{body.genome}\u0000{body.hub_url or ''}"
    cached = _UCSC_CATALOG_PAYLOADS.get(cache_key)
    if cached is not None and cached[0] is tracks:
        _UCSC_CATALOG_PAYLOADS.move_to_end(cache_key)
        return Response(content=cached[1], media_type="application/json")

    models = [_ucsc_track_model(track) for track in tracks]
    payload = UcscCatalogResponseModel(tracks=models, total=len(models))
    encoded = payload.model_dump_json().encode("utf-8")
    _UCSC_CATALOG_PAYLOADS[cache_key] = (tracks, encoded)
    _UCSC_CATALOG_PAYLOADS.move_to_end(cache_key)
    while len(_UCSC_CATALOG_PAYLOADS) > _UCSC_CATALOG_PAYLOAD_MAX_ENTRIES:
        _UCSC_CATALOG_PAYLOADS.popitem(last=False)
    return Response(content=encoded, media_type="application/json")


@router.post(
    "/ucsc/tracks/region",
    response_model=UcscTrackRegionResponseModel,
    summary="Fetch a UCSC interval or bounded whole-track snapshot",
)
async def post_ucsc_track_region(
    body: UcscTrackRegionRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscTrackRegionResponseModel:
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_ANNOTATION.value])
    coordinates = (body.chrom, body.start, body.end)
    if any(value is None for value in coordinates) and not all(
        value is None for value in coordinates
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "invalid_request",
                "message": "UCSC chromosome, start, and end must be supplied together",
            },
        )
    if body.start is not None and body.end is not None and body.end <= body.start:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "invalid_request",
                "message": "UCSC interval must satisfy start < end",
            },
        )
    service = _service_or_raise()
    try:
        result = await service.fetch_ucsc_track_region(
            genome=body.genome,
            track=body.track,
            chrom=body.chrom,
            start=body.start,
            end=body.end,
            max_items_output=body.max_items_output,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
            hub_url=body.hub_url,
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except CircuitOpen as exc:
        raise _circuit_open_http(exc) from exc
    except UnknownProvider as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "unknown_provider", "message": str(exc)},
        ) from exc
    except ProviderError as exc:
        raise _provider_error_http(exc) from exc
    return UcscTrackRegionResponseModel(
        records=result.records,
        complete=result.complete,
        items_returned=result.items_returned,
        max_items_output=result.max_items_output,
        track_type=result.track_type,
        big_data_url=result.big_data_url,
    )


@router.post(
    "/ucsc/tracks/admit",
    response_model=UcscTrackAdmissionResponseModel,
    summary="Admit an indexed UCSC BigWig or BigBed source",
)
async def post_ucsc_track_admission(
    body: UcscTrackAdmissionRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UcscTrackAdmissionResponseModel:
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_ANNOTATION.value])
    service = _service_or_raise()
    try:
        result = await service.admit_ucsc_track(
            genome=body.genome,
            track=body.track,
            format_id=body.format_id,
            probe_chrom=body.probe_chrom,
            hub_url=body.hub_url,
            workspace_id=body.workspace_id,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except CircuitOpen as exc:
        raise _circuit_open_http(exc) from exc
    except ProviderError as exc:
        raise _provider_error_http(
            exc, provider_miss_status=status.HTTP_404_NOT_FOUND
        ) from exc
    except RemoteRangeSourceError as exc:
        raise _remote_range_error_http("source_not_admitted", exc) from exc
    grant = result.grant
    return UcscTrackAdmissionResponseModel(
        source_uri=result.source_uri,
        source_token=grant.source_token,
        canonical_url_hash=grant.canonical_url_hash,
        representation_sha256=result.representation_sha256,
        representation_identity_kind=result.representation_identity_kind,
        format=grant.format,
        byte_length=grant.byte_length,
        accepts_ranges=grant.accepts_ranges,
        etag=grant.etag,
        last_modified=grant.last_modified,
        expires_in_seconds=grant.expires_in_seconds,
        provenance_id=grant.provenance_id,
    )


@router.post(
    "/credential-broker/register",
    response_model=SourceCredentialRegistrationResponseModel,
    summary="Register one process-local genomic source credential",
)
async def post_source_credential_registration(
    body: SourceCredentialRegistrationRequestModel,
    request: Request,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> SourceCredentialRegistrationResponseModel:
    _enforce_session(x_dnaforge_session)
    require_human_operation_authority(request)
    try:
        descriptor = _service_or_raise().register_source_credential(
            auth_ref=body.auth_ref,
            kind=body.kind,
            material=dict(body.material),
        )
    except CredentialBrokerError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": exc.failure_kind, "message": str(exc)},
        ) from exc
    return SourceCredentialRegistrationResponseModel(
        auth_ref=descriptor.auth_ref,
        kind=descriptor.kind,
    )


@router.post(
    "/credential-broker/remove",
    response_model=SourceCredentialRemovalResponseModel,
    summary="Remove one process-local genomic source credential",
)
async def post_source_credential_removal(
    body: SourceCredentialRemovalRequestModel,
    request: Request,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> SourceCredentialRemovalResponseModel:
    _enforce_session(x_dnaforge_session)
    require_human_operation_authority(request)
    try:
        removed = _service_or_raise().remove_source_credential(body.auth_ref)
    except CredentialBrokerError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": exc.failure_kind, "message": str(exc)},
        ) from exc
    return SourceCredentialRemovalResponseModel(auth_ref=body.auth_ref, removed=removed)


@router.post(
    "/indexed-tracks/admit",
    response_model=IndexedTrackAdmissionResponseModel,
    summary="Admit an explicitly selected local or public indexed genomic source",
)
async def post_indexed_track_admission(
    body: IndexedTrackAdmissionRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> IndexedTrackAdmissionResponseModel:
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_ANNOTATION.value])
    _enforce_local_indexed_source_authority(body)
    service = _service_or_raise()
    try:
        grant = await service.admit_indexed_track_source(
            source_kind=body.source_kind,
            source=body.source,
            expected_format=body.format_id,
            provenance_id=body.provenance_id,
            bucket=body.bucket,
            object_key=body.object_key,
            region=body.region,
            requester_pays=body.requester_pays,
            billing_project=body.billing_project,
            auth_ref=body.auth_ref,
        )
    except (RemoteRangeSourceError, ValueError) as exc:
        if isinstance(exc, ValueError):
            exc = RemoteRangeSourceError(str(exc))
        raise _remote_range_error_http("source_not_admitted", exc) from exc
    return IndexedTrackAdmissionResponseModel(
        source_uri=grant.source_uri,
        source_token=grant.source_token,
        canonical_url_hash=grant.canonical_url_hash,
        format=grant.format,
        byte_length=grant.byte_length,
        accepts_ranges=grant.accepts_ranges,
        etag=grant.etag,
        last_modified=grant.last_modified,
        expires_in_seconds=grant.expires_in_seconds,
        provenance_id=grant.provenance_id,
    )


@router.post(
    "/indexed-tracks/materialize",
    response_model=IndexedTrackMaterializationResponseModel,
    summary="Materialize one admitted remote index into a managed native snapshot",
)
async def post_indexed_track_materialization(
    body: IndexedTrackMaterializationRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> IndexedTrackMaterializationResponseModel:
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_ANNOTATION.value])
    service = _service_or_raise()
    try:
        result = await service.materialize_remote_track_source(body.source_token)
    except RemoteRangeSourceError as exc:
        raise _remote_range_error_http("source_not_materialized", exc) from exc
    return IndexedTrackMaterializationResponseModel(
        source_path=result.source_path,
        representation_sha256=result.representation_sha256,
        canonical_url_hash=result.grant.canonical_url_hash,
        format=result.grant.format,
        byte_length=result.grant.byte_length,
        expires_in_seconds=result.grant.expires_in_seconds,
    )


@router.post(
    "/indexed-variants/prepare",
    response_model=IndexedVariantRuntimeResponseModel,
    summary="Validate one admitted remote VCF/BCF source and native index",
)
async def post_indexed_variant_preparation(
    request: Request,
    body: IndexedVariantRuntimeRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> IndexedVariantRuntimeResponseModel:
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_ANNOTATION.value])
    try:
        source, index, source_identity = await _remote_variant_resources(
            _service_or_raise(),
            request,
            source_token=body.source_token,
            index_token=body.index_token,
        )
        references = _variant_reference_identities(body.references)
        variants = _load_remote_variant_process_service()
        pool = get_pool_manager().get(PoolName.TILE_IO.value)
        async with pool.slot():
            prepared = await variants.prepare_remote_variant_source(
                _native_range_proxy_url(request, source),
                index.source_path,
                [reference.model_dump(mode="json") for reference in references],
                source_format=source.format,
                source_identity=source_identity,
            )
    except QueueRefusal as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error": "variant_capacity_unavailable",
                "message": "Variant query capacity is temporarily unavailable.",
            },
        ) from exc
    except RemoteRangeSourceError as exc:
        raise _remote_range_error_http("variant_source_unavailable", exc) from exc
    except (ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "variant_source_invalid", "message": str(exc)},
        ) from exc
    except ModuleNotFoundError as exc:
        if exc.name != "pysam":
            raise
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "variant_source_unavailable",
                "message": "Remote variant viewing is unavailable in this runtime.",
            },
        ) from exc
    except Exception as exc:
        raise _remote_variant_query_http(exc) from exc

    return IndexedVariantRuntimeResponseModel(
        format=source.format,
        source_identity=prepared["sourceIdentity"],
        assembly_revision=prepared["assemblyRevision"],
        matched_references=prepared["matchedReferences"],
        samples=prepared["samples"],
        expires_in_seconds=min(
            source.expires_in_seconds, index.grant.expires_in_seconds
        ),
    )


@router.post(
    "/indexed-variants/page",
    summary="Read one bounded page from an admitted remote VCF/BCF source",
)
async def post_indexed_variant_page(
    request: Request,
    body: IndexedVariantPageRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> JSONResponse:
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_ANNOTATION.value])
    try:
        source, index, source_identity = await _remote_variant_resources(
            _service_or_raise(),
            request,
            source_token=body.source_token,
            index_token=body.index_token,
        )
        references = _variant_reference_identities(body.references)
        expected_revision = variant_assembly_revision(references)
        if (
            source_identity != body.source_identity
            or expected_revision != body.assembly_revision
        ):
            raise ValueError(
                "The remote variant source or reference changed after preparation."
            )
        variants = _load_remote_variant_process_service()
        pool = get_pool_manager().get(PoolName.TILE_IO.value)
        async with pool.slot():
            result = await variants.query_remote_variant_page(
                _native_range_proxy_url(request, source),
                index.source_path,
                [reference.name for reference in references],
                source_identity=source_identity,
                assembly_revision=expected_revision,
                cursor=body.cursor,
                limit=body.limit,
            )
    except QueueRefusal as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error": "variant_capacity_unavailable",
                "message": "Variant query capacity is temporarily unavailable.",
            },
        ) from exc
    except RemoteRangeSourceError as exc:
        raise _remote_range_error_http("variant_source_unavailable", exc) from exc
    except (ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "variant_source_changed", "message": str(exc)},
        ) from exc
    except ModuleNotFoundError as exc:
        if exc.name != "pysam":
            raise
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "variant_source_unavailable",
                "message": "Remote variant viewing is unavailable in this runtime.",
            },
        ) from exc
    except Exception as exc:
        raise _remote_variant_query_http(exc) from exc
    return JSONResponse(content=result)


@router.post(
    "/indexed-variants/region",
    summary="Read one bounded region from an admitted remote VCF/BCF source",
)
async def post_indexed_variant_region(
    request: Request,
    body: IndexedVariantRegionRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> JSONResponse:
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_ANNOTATION.value])
    try:
        source, index, source_identity = await _remote_variant_resources(
            _service_or_raise(),
            request,
            source_token=body.source_token,
            index_token=body.index_token,
        )
        references = _variant_reference_identities(body.references)
        expected_revision = variant_assembly_revision(references)
        reference_lengths = {
            reference.name: reference.length for reference in references
        }
        if (
            source_identity != body.source_identity
            or expected_revision != body.assembly_revision
            or body.chrom not in reference_lengths
            or body.end > reference_lengths.get(body.chrom, 0)
        ):
            raise ValueError(
                "The remote variant source, reference, or region changed after preparation."
            )
        variants = _load_remote_variant_process_service()
        pool = get_pool_manager().get(PoolName.TILE_IO.value)
        async with pool.slot():
            result = await variants.query_remote_variant_region(
                _native_range_proxy_url(request, source),
                index.source_path,
                source_identity=source_identity,
                chrom=body.chrom,
                start=body.start,
                end=body.end,
                limit=body.limit,
            )
    except QueueRefusal as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error": "variant_capacity_unavailable",
                "message": "Variant query capacity is temporarily unavailable.",
            },
        ) from exc
    except RemoteRangeSourceError as exc:
        raise _remote_range_error_http("variant_source_unavailable", exc) from exc
    except (ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "variant_source_changed", "message": str(exc)},
        ) from exc
    except ModuleNotFoundError as exc:
        if exc.name != "pysam":
            raise
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "variant_source_unavailable",
                "message": "Remote variant viewing is unavailable in this runtime.",
            },
        ) from exc
    except Exception as exc:
        raise _remote_variant_query_http(exc) from exc
    return JSONResponse(content=result)


@router.post(
    "/htsget/prepare",
    response_model=HtsgetPreparationResponseModel,
    summary="Admit an htsget read or variant source without exposing its ticket",
)
async def post_htsget_preparation(
    body: HtsgetPreparationRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> HtsgetPreparationResponseModel:
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_ANNOTATION.value])
    try:
        prepared = await _service_or_raise().prepare_htsget_source(
            endpoint=body.endpoint,
            resource_id=body.resource_id,
            data_class=body.data_class,
            source_format=body.format,
            references=[
                reference.model_dump(mode="json") for reference in body.references
            ],
            auth_ref=body.auth_ref,
        )
    except HtsgetSourceError as exc:
        raise _htsget_error_http(exc) from exc
    return HtsgetPreparationResponseModel(
        source_token=prepared.source_token,
        source_identity=prepared.source_identity,
        data_class=prepared.data_class,
        format=prepared.format,
        references=[
            IndexedVariantReferenceModel(name=name, length=length)
            for name, length in prepared.references
        ],
        matched_references=list(prepared.matched_references),
        samples=list(prepared.samples),
        assembly_revision=prepared.assembly_revision,
        expires_in_seconds=prepared.expires_in_seconds,
    )


@router.post(
    "/htsget/variants/page",
    summary="Read one bounded page from a prepared htsget VCF/BCF source",
)
async def post_htsget_variant_page(
    body: HtsgetVariantPageRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> JSONResponse:
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_ANNOTATION.value])
    try:
        result = await _service_or_raise().query_htsget_variant_page(
            body.source_token,
            source_identity=body.source_identity,
            assembly_revision=body.assembly_revision,
            references=[
                reference.model_dump(mode="json") for reference in body.references
            ],
            cursor=body.cursor,
            limit=body.limit,
        )
    except HtsgetSourceError as exc:
        raise _htsget_error_http(exc) from exc
    except Exception as exc:
        raise _remote_variant_query_http(exc) from exc
    return JSONResponse(content=result)


@router.post(
    "/htsget/variants/region",
    summary="Read one bounded region from a prepared htsget VCF/BCF source",
)
async def post_htsget_variant_region(
    body: HtsgetVariantRegionRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> JSONResponse:
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_ANNOTATION.value])
    try:
        result = await _service_or_raise().query_htsget_variant_region(
            body.source_token,
            source_identity=body.source_identity,
            assembly_revision=body.assembly_revision,
            references=[
                reference.model_dump(mode="json") for reference in body.references
            ],
            chrom=body.chrom,
            start=body.start,
            end=body.end,
            limit=body.limit,
        )
    except HtsgetSourceError as exc:
        raise _htsget_error_http(exc) from exc
    except Exception as exc:
        raise _remote_variant_query_http(exc) from exc
    return JSONResponse(content=result)


def _load_remote_variant_process_service() -> Any:
    from ..services import remote_variant_process

    return remote_variant_process


def _variant_reference_identities(
    values: list[IndexedVariantReferenceModel],
) -> list[VariantReferenceIdentity]:
    return [
        VariantReferenceIdentity.model_validate(value.model_dump(mode="json"))
        for value in values
    ]


async def _remote_variant_resources(
    service: ExternalResourcesService,
    request: Request,
    *,
    source_token: str,
    index_token: str,
) -> tuple[RemoteRangeGrant, RemoteRangeMaterialization, str]:
    source, index_grant = await asyncio.gather(
        service.get_remote_track_grant(source_token),
        service.get_remote_track_grant(index_token),
    )
    if not source.source_uri.startswith(("http://", "https://")):
        raise ValueError("Remote variant sources must use an admitted HTTP URL.")
    valid_pair = (source.format == "vcf" and index_grant.format in {"tbi", "csi"}) or (
        source.format == "bcf" and index_grant.format == "csi"
    )
    if not valid_pair:
        raise ValueError("The remote variant source and index formats do not match.")
    index = await service.materialize_remote_track_source(index_token)
    identity = _remote_variant_source_identity(source, index)
    _native_range_proxy_url(request, source)
    return source, index, identity


def _remote_variant_source_identity(
    source: RemoteRangeGrant, index: RemoteRangeMaterialization
) -> str:
    receipt = json.dumps(
        {
            "contract": "dnaforge.remote-variant-source.v1",
            "source": {
                "url": source.canonical_url_hash,
                "format": source.format,
                "length": source.byte_length,
                "etag": source.etag,
                "lastModified": source.last_modified,
            },
            "index": {
                "url": index.grant.canonical_url_hash,
                "format": index.grant.format,
                "length": index.grant.byte_length,
                "etag": index.grant.etag,
                "lastModified": index.grant.last_modified,
                "sha256": index.representation_sha256,
            },
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(receipt.encode("utf-8")).hexdigest()


def _native_range_proxy_url(request: Request, grant: RemoteRangeGrant) -> str:
    server = request.scope.get("server")
    if not isinstance(server, tuple) or len(server) != 2:
        raise ValueError("The native variant proxy has no server authority.")
    host, port = server
    if not isinstance(host, str) or not isinstance(port, int) or port <= 0:
        raise ValueError("The native variant proxy server authority is invalid.")
    try:
        is_loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        is_loopback = host.casefold() == "localhost"
    if not is_loopback:
        raise ValueError("The native variant proxy must run on loopback.")
    address = f"[{host}]" if ":" in host else host
    return (
        f"http://dnaforge-source:{grant.source_token}@{address}:{port}"
        f"/external/range-proxy/source.{grant.format}"
    )


def _remote_variant_query_http(exc: Exception) -> HTTPException:
    name = type(exc).__name__
    if name == "VariantAssemblyMismatchError":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "variant_assembly_mismatch", "message": str(exc)},
        )
    if name in {"VariantSourceGenerationChangedError", "VariantSourceNotFoundError"}:
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "variant_source_changed", "message": str(exc)},
        )
    if name in {"VariantIndexError", "VariantQueryError"}:
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "variant_source_invalid", "message": str(exc)},
        )
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail={
            "error": "variant_source_failed",
            "message": "Remote variant processing failed.",
        },
    )


def _enforce_local_indexed_source_authority(
    body: IndexedTrackAdmissionRequestModel,
) -> None:
    if body.source_kind != "path":
        if body.local_path_authority is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Remote indexed sources may not carry local-file authority.",
            )
        return

    session_token = os.environ.get("DNAFORGE_MCP_SESSION_TOKEN")
    if body.source is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A local indexed source path is required.",
        )
    canonical_path = os.path.realpath(os.path.abspath(body.source))
    payload = ("dnaforge.local-indexed-track-authority.v1\0" + canonical_path).encode(
        "utf-8"
    )
    expected = hmac.new(
        (session_token or "").encode("utf-8"), payload, hashlib.sha256
    ).hexdigest()
    if (
        not body.local_path_authority
        or not session_token
        or not hmac.compare_digest(body.local_path_authority, expected)
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "The local indexed source was not authorized by the native DNAForge file picker."
            ),
        )


@router.get(
    "/range",
    response_class=Response,
    status_code=status.HTTP_206_PARTIAL_CONTENT,
    summary="Read a standard HTTP byte range from an admitted genomic source",
)
async def get_remote_range(
    range_header: str | None = Header(default=None, alias="Range"),
    source_token: str | None = Header(default=None, alias="X-DNAForge-Source-Token"),
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> Response:
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_ANNOTATION.value])
    if source_token is None or not 16 <= len(source_token) <= 200:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": "missing_source_token",
                "message": "A source grant is required.",
            },
        )
    start, length = _parse_single_byte_range(range_header)
    service = _service_or_raise()
    try:
        result = await service.read_remote_track_range(source_token, start, length)
    except RemoteRangeSourceError as exc:
        raise _remote_range_read_error_http(exc) from exc
    headers = {
        "Content-Length": str(len(result.payload)),
        "Content-Range": f"bytes {result.start}-{result.end}/{result.byte_length}",
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
    }
    if result.etag:
        headers["ETag"] = result.etag
    if result.last_modified:
        headers["Last-Modified"] = result.last_modified
    return Response(
        status_code=status.HTTP_206_PARTIAL_CONTENT,
        content=result.payload,
        media_type="application/octet-stream",
        headers=headers,
    )


_RANGE_PROXY_SUFFIXES = {
    "bam": (".bam",),
    "cram": (".cram",),
    "bai": (".bai",),
    "crai": (".crai",),
    "csi": (".csi",),
    "vcf": (".vcf", ".vcf.gz", ".vcf.bgz"),
    "bcf": (".bcf",),
    "tbi": (".tbi",),
}
_RANGE_PROXY_BASIC_USER = "dnaforge-source"


def _native_source_token(request: Request) -> str:
    """Read one source grant from libcurl's HTTP Basic authorization header."""

    values = request.headers.getlist("authorization")
    token: str | None = None
    if len(values) == 1:
        scheme, separator, encoded = values[0].partition(" ")
        if separator and scheme.casefold() == "basic":
            try:
                decoded = base64.b64decode(encoded, validate=True).decode("ascii")
            except (ValueError, UnicodeDecodeError):
                decoded = ""
            username, colon, password = decoded.partition(":")
            if colon and hmac.compare_digest(username, _RANGE_PROXY_BASIC_USER):
                token = password
    if token is None or not 16 <= len(token) <= 200:
        raise _remote_range_read_error_http(
            RemoteRangeSourceError(
                "The remote range grant is missing or expired",
                failure_kind="grant_expired",
                retryable=True,
            )
        )
    return token


@router.api_route(
    "/range-proxy/{resource_name}",
    methods=["GET"],
    response_class=Response,
    summary="Expose one admitted indexed source to native htslib on loopback",
)
async def proxy_remote_indexed_source(
    request: Request,
    resource_name: str,
    range_header: str | None = Header(default=None, alias="Range"),
) -> Response:
    """Translate a native request into the bounded remote-range service.

    htslib cannot attach Electron's private sidecar session header. The opaque,
    process-local source token is therefore supplied as an HTTP Basic password
    in the loopback URL. Uvicorn logs only the path, so the grant is not copied
    into normal access logs. It is never serialized into a Track View and still
    inherits expiry, DNS-rebinding protection, validator checks, read limits,
    and byte bounds from ``RemoteRangeService``.
    """

    source_token = _native_source_token(request)
    service = _service_or_raise()
    try:
        grant = await service.get_remote_track_grant(source_token)
    except RemoteRangeSourceError as exc:
        raise _remote_range_read_error_http(exc) from exc
    suffixes = _RANGE_PROXY_SUFFIXES.get(grant.format)
    if suffixes is None or not resource_name.casefold().endswith(suffixes):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "source_name_mismatch",
                "message": "The native range URL does not match its admitted source format.",
            },
        )
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
    }
    if grant.etag:
        headers["ETag"] = grant.etag
    if grant.last_modified:
        headers["Last-Modified"] = grant.last_modified
    if request.method == "HEAD":
        headers["Content-Length"] = str(grant.byte_length)
        return Response(status_code=status.HTTP_200_OK, headers=headers)

    if range_header is None:
        headers["Content-Length"] = str(grant.byte_length)
        headers["Connection"] = "close"
        return StreamingResponse(
            _stream_admitted_source(
                service,
                source_token,
                start=0,
                end_exclusive=grant.byte_length,
            ),
            status_code=status.HTTP_200_OK,
            media_type="application/octet-stream",
            headers=headers,
        )

    start, length, stream_to_end = _parse_native_byte_range(
        range_header,
        byte_length=grant.byte_length,
    )
    if stream_to_end:
        end = start + length - 1
        headers.update(
            {
                "Content-Length": str(length),
                "Content-Range": f"bytes {start}-{end}/{grant.byte_length}",
                "Connection": "close",
            }
        )
        return StreamingResponse(
            _stream_admitted_source(
                service,
                source_token,
                start=start,
                end_exclusive=start + length,
            ),
            status_code=status.HTTP_206_PARTIAL_CONTENT,
            media_type="application/octet-stream",
            headers=headers,
        )

    try:
        result = await service.read_remote_track_range(source_token, start, length)
    except RemoteRangeSourceError as exc:
        raise _remote_range_read_error_http(exc) from exc
    headers.update(
        {
            "Content-Length": str(len(result.payload)),
            "Content-Range": f"bytes {result.start}-{result.end}/{result.byte_length}",
        }
    )
    return Response(
        status_code=status.HTTP_206_PARTIAL_CONTENT,
        content=result.payload,
        media_type="application/octet-stream",
        headers=headers,
    )


router.add_api_route(
    "/range-proxy/{resource_name}",
    proxy_remote_indexed_source,
    methods=["HEAD"],
    response_class=Response,
    include_in_schema=False,
)


async def _stream_admitted_source(
    service: ExternalResourcesService,
    source_token: str,
    *,
    start: int,
    end_exclusive: int,
) -> AsyncIterator[bytes]:
    chunk_bytes = 1024 * 1024
    while start < end_exclusive:
        result = await service.read_remote_track_range(
            source_token,
            start,
            min(chunk_bytes, end_exclusive - start),
        )
        yield result.payload
        start += len(result.payload)


def _parse_native_byte_range(
    value: str,
    *,
    byte_length: int,
) -> tuple[int, int, bool]:
    """Parse the single-range forms emitted by htslib/libcurl.

    Fixed ranges remain capped at one service read. Open-ended ranges may span
    the source because htslib uses them to verify an alignment file's EOF
    marker; the response is still fetched through the bounded range service in
    one-MiB chunks. Suffix ranges follow RFC 9110 and use the same streaming
    path only when they exceed the ordinary per-read cap.
    """

    if not value.startswith("bytes=") or "," in value:
        raise _native_range_not_satisfiable(byte_length)
    start_text, end_text = value.removeprefix("bytes=").split("-", 1)
    if not start_text:
        if not end_text.isdigit() or int(end_text) < 1:
            raise _native_range_not_satisfiable(byte_length)
        length = min(int(end_text), byte_length)
        start = byte_length - length
        return start, length, length > 8 * 1024 * 1024
    if not start_text.isdigit() or (end_text and not end_text.isdigit()):
        raise _native_range_not_satisfiable(byte_length)

    start = int(start_text)
    if start >= byte_length:
        raise _native_range_not_satisfiable(byte_length)
    if not end_text:
        return start, byte_length - start, True

    requested_end = int(end_text)
    if requested_end < start:
        raise _native_range_not_satisfiable(byte_length)
    end = min(requested_end, byte_length - 1)
    length = end - start + 1
    if length > 8 * 1024 * 1024:
        raise _native_range_not_satisfiable(byte_length)
    return start, length, False


def _native_range_not_satisfiable(byte_length: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
        detail={"error": "invalid_range", "message": "The byte range is invalid."},
        headers={"Content-Range": f"bytes */{byte_length}"},
    )


def _parse_single_byte_range(value: str | None) -> tuple[int, int]:
    if value is None or not value.startswith("bytes=") or "," in value:
        raise HTTPException(
            status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
            detail={
                "error": "invalid_range",
                "message": "A single explicit byte range is required.",
            },
        )
    bounds = value.removeprefix("bytes=").split("-", 1)
    if len(bounds) != 2 or not bounds[0].isdigit() or not bounds[1].isdigit():
        raise HTTPException(
            status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
            detail={"error": "invalid_range", "message": "The byte range is invalid."},
        )
    start, end = (int(bound) for bound in bounds)
    length = end - start + 1
    if end < start or length > 8 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
            detail={
                "error": "invalid_range",
                "message": "The byte range is invalid or too large.",
            },
        )
    return start, length


@router.post(
    "/uniprot/search",
    response_model=UniProtSearchResponseModel,
    response_model_exclude_none=True,
    summary=": UniProt /uniprotkb/search wrapper for the resolver chain",
)
async def post_uniprot_search(
    body: UniProtSearchRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UniProtSearchResponseModel:
    """Wrap UniProt /search with rate-limit + breaker + backoff. Logs to
    external_fetch_log for substrate provenance."""
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    try:
        hits = await service.search_uniprot(
            body.query,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
            size=body.size,
            include_sequence=body.include_sequence,
        )
    except CapabilityDenied as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "capability_denied",
                "required": exc.required,
                "granted": exc.granted,
            },
        ) from exc
    except CircuitOpen as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "circuit_open",
                "origin": exc.origin,
                "retry_after_s": exc.opens_at_s,
            },
        ) from exc
    except UnknownProvider as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "unknown_provider", "message": str(exc)},
        ) from exc
    except ServiceError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "invalid_request", "message": str(exc)},
        ) from exc
    except ProviderError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "error": "provider_error",
                "failure_kind": exc.failure_kind,
                "message": str(exc),
                "status_code": exc.status_code,
            },
        ) from exc
    return UniProtSearchResponseModel(
        hits=[
            UniProtSearchHitModel(
                accession=h.accession,
                reviewed=h.reviewed,
                sequence=h.sequence,
                taxon_id=h.taxon_id,
                organism=h.organism,
            )
            for h in hits
        ]
    )


class NebTmBatchRequestModel(BaseModel):
    """Many primers, one NEB /tm/batch submission."""

    sequences: list[str] = Field(
        ...,
        min_length=1,
        description="Primer sequences (>=10 bp, A/C/G/T). Submitted as one NEB batch.",
    )
    prodcode: str = Field("q5-0", description="NEB product code (e.g. q5-0 for Q5)")
    conc_nm: float = Field(250.0, gt=0, description="Primer concentration (nM)")
    workspace_id: str | None = Field(
        None, description="workspace context for fetch_log scoping"
    )
    granted_capabilities: list[str] = Field(default_factory=list)


class NebTmRequestModel(BaseModel):
    """: NEB Tm calculator (tmapi.neb.com) wrapper.

    Submits a primer (or forward/reverse pair) and returns NEB's authoritative
    Tm / annealing temperature for the chosen polymerase product (Q5, ...). The
    renderer uses this as the authoritative displayed/stored Tm when the NEB Tm
    model is selected; the local SantaLucia calc stays the offline fallback.
    """

    seq1: str = Field(
        ..., min_length=10, description="Primary primer (>=10 bp, A/C/G/T)"
    )
    seq2: str | None = Field(
        None, description="Optional reverse primer; enables the pair-level Ta"
    )
    prodcode: str = Field("q5-0", description="NEB product code (e.g. q5-0 for Q5)")
    conc_nm: float = Field(250.0, gt=0, description="Primer concentration (nM)")
    workspace_id: str | None = Field(
        None, description="workspace context for fetch_log scoping"
    )
    granted_capabilities: list[str] = Field(default_factory=list)


class NebTmOligoModel(BaseModel):
    tm: float
    gc_fraction: float
    length: int
    seq: str


class NebTmResponseModel(BaseModel):
    prodcode: str
    conc_nm: float
    p1: NebTmOligoModel
    p2: NebTmOligoModel | None = None
    ta: float | None = None
    api_version: str
    notes: list[str]


class NebTmBatchResponseModel(BaseModel):
    results: list[NebTmResponseModel]


@router.post(
    "/neb/tm",
    response_model=NebTmResponseModel,
    response_model_exclude_none=True,
    summary=": NEB Tm calculator (tmapi.neb.com) wrapper",
)
async def post_neb_tm(
    body: NebTmRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> NebTmResponseModel:
    """Wrap NEB's Tm API with the substrate's rate-limit + breaker + backoff.
    Requires the `external-compute:tm` capability (submits sequence content)."""
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    try:
        result = await service.compute_primer_tm(
            body.seq1,
            seq2=body.seq2,
            prodcode=body.prodcode,
            conc_nm=body.conc_nm,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
        )
    except CapabilityDenied as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "capability_denied",
                "required": exc.required,
                "granted": exc.granted,
            },
        ) from exc
    except CircuitOpen as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "circuit_open",
                "origin": exc.origin,
                "retry_after_s": exc.opens_at_s,
            },
        ) from exc
    except UnknownProvider as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "unknown_provider", "message": str(exc)},
        ) from exc
    except ProviderError as exc:
        code = (
            exc.status_code
            if exc.status_code and 400 <= exc.status_code < 500
            else status.HTTP_502_BAD_GATEWAY
        )
        raise HTTPException(
            status_code=code,
            detail={
                "error": "provider_error",
                "failure_kind": exc.failure_kind,
                "message": str(exc),
                "status_code": exc.status_code,
            },
        ) from exc
    return _neb_tm_response(result)


@router.post(
    "/neb/tm/batch",
    response_model=NebTmBatchResponseModel,
    response_model_exclude_none=True,
    summary=": NEB Tm calculator batch wrapper",
)
async def post_neb_tm_batch(
    body: NebTmBatchRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> NebTmBatchResponseModel:
    """One NEB /tm/batch call for every submitted primer."""
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    try:
        results = await service.compute_primer_tm_batch(
            body.sequences,
            prodcode=body.prodcode,
            conc_nm=body.conc_nm,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
        )
    except CapabilityDenied as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "capability_denied",
                "required": exc.required,
                "granted": exc.granted,
            },
        ) from exc
    except CircuitOpen as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "circuit_open",
                "origin": exc.origin,
                "retry_after_s": exc.opens_at_s,
            },
        ) from exc
    except UnknownProvider as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "unknown_provider", "message": str(exc)},
        ) from exc
    except ProviderError as exc:
        code = (
            exc.status_code
            if exc.status_code and 400 <= exc.status_code < 500
            else status.HTTP_502_BAD_GATEWAY
        )
        raise HTTPException(
            status_code=code,
            detail={
                "error": "provider_error",
                "failure_kind": exc.failure_kind,
                "message": str(exc),
                "status_code": exc.status_code,
            },
        ) from exc
    return NebTmBatchResponseModel(results=[_neb_tm_response(item) for item in results])


def _neb_tm_response(result: Any) -> NebTmResponseModel:
    return NebTmResponseModel(
        prodcode=result.prodcode,
        conc_nm=result.conc_nm,
        p1=NebTmOligoModel(
            tm=result.p1.tm,
            gc_fraction=result.p1.gc_fraction,
            length=result.p1.length,
            seq=result.p1.seq,
        ),
        p2=(
            NebTmOligoModel(
                tm=result.p2.tm,
                gc_fraction=result.p2.gc_fraction,
                length=result.p2.length,
                seq=result.p2.seq,
            )
            if result.p2
            else None
        ),
        ta=result.ta,
        api_version=result.api_version,
        notes=result.notes,
    )


@router.post(
    "/uniprot/by-sequence",
    response_model=UniProtBySequenceResponseModel,
    summary="Look up UniProt entries by exact protein-sequence MD5 match",
)
async def post_uniprot_by_sequence(
    body: UniProtBySequenceRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UniProtBySequenceResponseModel:
    """The structure drawer's primary resolution mechanism.

    Computes MD5 of the supplied protein (uppercase, trailing stop
    stripped — matching UniProt's stored `md5` convention) and queries
    UniProt's `checksum:<hex>` field. Returns sorted hits (reviewed
    Swiss-Prot first) so callers don't need to re-sort.

    Empty `hits` list = no UniProt entry has this exact sequence.
    Caller should fall through to homology search (deferred to v2).
    """
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    try:
        query_identity, hits = await service.search_uniprot_by_sequence(
            body.sequence,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
            size=body.size,
        )
    except CapabilityDenied as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "capability_denied",
                "required": exc.required,
                "granted": exc.granted,
            },
        ) from exc
    except CircuitOpen as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "circuit_open",
                "origin": exc.origin,
                "retry_after_s": exc.opens_at_s,
            },
        ) from exc
    except UnknownProvider as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "unknown_provider", "message": str(exc)},
        ) from exc
    except ServiceError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "invalid_request", "message": str(exc)},
        ) from exc
    except ProviderError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "error": "provider_error",
                "failure_kind": exc.failure_kind,
                "message": str(exc),
                "status_code": exc.status_code,
            },
        ) from exc
    return UniProtBySequenceResponseModel(
        md5=query_identity.checksum_md5,
        query_identity=QueryIdentityModel(
            kind="protein_sequence",
            normalized_length=query_identity.normalized_length,
            checksum_md5=query_identity.checksum_md5,
            checksum_sha256=query_identity.checksum_sha256,
            canonical_form="waypoint-protein-v2",
            canonical_lookup_sequence=query_identity.canonical_lookup_sequence,
            canonical_form_applied=query_identity.canonical_form_applied,
            ineligible=query_identity.ineligible,
            ineligible_reason=query_identity.ineligible_reason,
            evidence=[
                QueryIdentityEvidenceModel(kind=evidence.kind, residue=evidence.residue)
                for evidence in query_identity.evidence
            ],
        ),
        hits=[
            UniProtBySequenceHitModel(
                accession=h.accession,
                reviewed=h.reviewed,
                match_evidence=MatchEvidenceModel(
                    kind="exact_sequence_checksum",
                    checksum_md5=query_identity.checksum_md5,
                    sequence_identity=1.0,
                    rank=index,
                    rank_reasons=[
                        "checksum_match",
                        "reviewed" if h.reviewed else "unreviewed",
                    ],
                ),
                pdb_ids=list(h.pdb_ids),
                pdb_xrefs=[
                    PdbXrefModel(
                        pdb_id=xref.pdb_id,
                        method=xref.method,
                        resolution=xref.resolution,
                        chains=list(xref.chains),
                        raw_properties=xref.raw_properties,
                    )
                    for xref in h.pdb_xrefs
                ],
            )
            for index, h in enumerate(hits)
        ],
    )


@router.post(
    "/alphafold/validate",
    response_model=AfdbValidateResponseModel,
    summary=": AlphaFold DB existence check for the resolver chain",
)
async def post_afdb_validate(
    body: AfdbValidateRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> AfdbValidateResponseModel:
    """Existence check against AFDB's `/api/prediction/{accession}`.

    Returns `exists=False` on miss; raises 502 only on real upstream
    failures. Logs to external_fetch_log."""
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    try:
        hit = await service.validate_afdb_exists(
            body.accession,
            fragment=body.fragment,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
        )
    except CapabilityDenied as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "capability_denied",
                "required": exc.required,
                "granted": exc.granted,
            },
        ) from exc
    except CircuitOpen as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "circuit_open",
                "origin": exc.origin,
                "retry_after_s": exc.opens_at_s,
            },
        ) from exc
    except ServiceError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "invalid_request", "message": str(exc)},
        ) from exc
    except ProviderError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "error": "provider_error",
                "failure_kind": exc.failure_kind,
                "message": str(exc),
                "status_code": exc.status_code,
            },
        ) from exc
    if hit is None:
        return AfdbValidateResponseModel(
            accession=None,
            mean_plddt=None,
            latest_version=None,
            cif_url=None,
            provider_identity_key=None,
            fragment=None,
            model_id=None,
            exists=False,
        )
    return AfdbValidateResponseModel(
        accession=hit.accession,
        mean_plddt=hit.mean_plddt,
        latest_version=hit.latest_version,
        cif_url=hit.cif_url,
        provider_identity_key=_alphafold_identity_key_for_hit(hit),
        fragment=hit.fragment,
        model_id=hit.model_id,
        exists=True,
    )


@router.post(
    "/rcsb/validate",
    response_model=RcsbValidateResponseModel,
    summary="Validate a PDB id and return RCSB metadata without persisting it",
)
async def post_rcsb_validate(
    body: RcsbValidateRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> RcsbValidateResponseModel:
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    try:
        result = await service.validate_rcsb_entry(
            body.pdb_id,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except RCSBEntryNotFound:
        return RcsbValidateResponseModel(valid=False)
    except ProviderError as exc:
        raise _provider_error_http(exc) from exc
    except CircuitOpen as exc:
        raise _circuit_open_http(exc) from exc
    return RcsbValidateResponseModel(
        valid=True,
        pdb_id=(result.metadata.get("pdb_id") or body.pdb_id).upper(),
        metadata=result.metadata,
        license=result.license,
        attribution=result.attribution,
    )


@router.post(
    "/rcsb/sequence-search",
    response_model=RcsbSequenceSearchResponseModel,
    summary="Search RCSB polymer entities by protein, RNA, or DNA sequence",
)
async def post_rcsb_sequence_search(
    body: RcsbSequenceSearchRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> RcsbSequenceSearchResponseModel:
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    try:
        hits = await service.search_rcsb_by_sequence(
            body.sequence,
            sequence_type=body.sequence_type,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
            identity_cutoff=body.identity_cutoff,
            evalue_cutoff=body.evalue_cutoff,
            size=body.size,
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except ProviderError as exc:
        raise _provider_error_http(exc) from exc
    except CircuitOpen as exc:
        raise _circuit_open_http(exc) from exc
    return RcsbSequenceSearchResponseModel(
        hits=[
            RcsbSequenceSearchHitModel(
                identifier=hit.identifier,
                pdb_id=hit.pdb_id,
                entity_id=hit.entity_id,
                score=hit.score,
                sequence_identity=hit.sequence_identity,
                evalue=hit.evalue,
                bit_score=hit.bit_score,
            )
            for hit in hits
        ]
    )


@router.post(
    "/alphafold/summary",
    response_model=AlphaFoldSummaryResponseModel,
    summary="Validate an AlphaFold prediction and return summary metadata",
)
async def post_alphafold_summary(
    body: AlphaFoldSummaryRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> AlphaFoldSummaryResponseModel:
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    try:
        hit = await service.validate_afdb_exists(
            body.accession,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except CircuitOpen as exc:
        raise _circuit_open_http(exc) from exc
    except ProviderError as exc:
        raise _provider_error_http(exc) from exc
    if hit is None:
        return AlphaFoldSummaryResponseModel(valid=False)
    return AlphaFoldSummaryResponseModel(
        valid=True,
        accession=hit.accession,
        mean_plddt=hit.mean_plddt,
        latest_version=hit.latest_version,
        cif_url=hit.cif_url,
        provider_identity_key=_alphafold_identity_key_for_hit(hit),
        fragment=hit.fragment,
        model_id=hit.model_id,
        metadata={
            "mean_plddt": hit.mean_plddt,
            "latest_version": hit.latest_version,
            "cif_url": hit.cif_url,
            "provider_identity_key": _alphafold_identity_key_for_hit(hit),
            "fragment": hit.fragment,
            "model_id": hit.model_id,
        },
        license="CC-BY-4.0",
        attribution="AlphaFold Protein Structure Database (https://alphafold.ebi.ac.uk)",
    )


def _alphafold_identity_key_for_hit(hit: AfdbHit) -> str:
    version = f"V{hit.latest_version}" if hit.latest_version is not None else "LATEST"
    base = f"AF:{hit.accession}:{hit.fragment}:{version}"
    return f"{base}:MODEL:{hit.model_id}" if hit.model_id else base


@router.post(
    "/uniprot/summary",
    response_model=UniProtSummaryResponseModel,
    summary="Return lightweight UniProt metadata without persisting it",
)
async def post_uniprot_summary(
    body: UniProtSummaryRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> UniProtSummaryResponseModel:
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    try:
        result = await service.summarize_uniprot_entry(
            body.accession,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except ProviderError as exc:
        if exc.status_code == 404:
            return UniProtSummaryResponseModel(valid=False)
        raise _provider_error_http(exc) from exc
    except CircuitOpen as exc:
        raise _circuit_open_http(exc) from exc
    return UniProtSummaryResponseModel(
        valid=True,
        accession=(result.metadata.get("accession") or body.accession).upper(),
        metadata=result.metadata,
        license=result.license,
        attribution=result.attribution,
    )


@router.post(
    "/structure/bytes",
    summary="Fetch raw structure bytes from a known external provider",
)
async def post_structure_bytes(
    body: StructureBytesRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> Response:
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    try:
        result = await service.fetch_structure_bytes(
            provider=body.provider,
            external_id=body.external_id,
            format=body.format,
            pdb_id=body.pdb_id,
            pdb_entity_id=body.pdb_entity_id,
            label_asym_ids=body.label_asym_ids,
            auth_asym_ids=body.auth_asym_ids,
            assembly_id=body.assembly_id,
            accession=body.accession,
            fragment=body.fragment,
            version=body.version,
            model_id=body.model_id,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except StructureTooLarge as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "error": "structure_too_large",
                "byte_count": exc.byte_count,
                "max_bytes": exc.max_bytes,
            },
        ) from exc
    except ProviderError as exc:
        raise _provider_error_http(
            exc, provider_miss_status=status.HTTP_404_NOT_FOUND
        ) from exc
    except CircuitOpen as exc:
        raise _circuit_open_http(exc) from exc
    headers = {
        "X-External-Provider": result.provider,
        "X-External-Id": result.external_id,
        "X-Served-External-Id": result.served_external_id,
        "X-Structure-Format": result.format,
        "X-Source-Url": result.source_url,
        "X-License": result.license,
        "X-Attribution": result.attribution,
    }
    if result.etag:
        headers["ETag"] = result.etag
    return Response(
        content=result.content, media_type=result.content_type, headers=headers
    )


@router.post(
    "/paper/source",
    response_model=PaperSourceResponseModel,
    summary="Capture a bounded public paper URL as exact PDF bytes or readable text",
)
async def post_paper_source(
    body: PaperSourceRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> PaperSourceResponseModel:
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    try:
        result = await service.capture_paper_source(
            body.url,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except PaperSourceTooLarge as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "error": "paper_source_too_large",
                "byte_count": exc.byte_count,
                "max_bytes": exc.max_bytes,
            },
        ) from exc
    except PaperSourceRejected as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "paper_source_rejected", "message": str(exc)},
        ) from exc
    except ProviderError as exc:
        raise _provider_error_http(exc) from exc
    except CircuitOpen as exc:
        raise _circuit_open_http(exc) from exc

    return PaperSourceResponseModel(
        kind=result.kind,
        original_url=result.original_url,
        canonical_url=result.canonical_url,
        media_type=result.media_type,
        response_sha256=result.response_sha256,
        byte_count=result.byte_count,
        title=result.title,
        captured_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        pdf_base64=(
            base64.b64encode(result.pdf_bytes).decode("ascii")
            if result.pdf_bytes is not None
            else None
        ),
        captured_text=result.captured_text,
        captured_text_sha256=result.captured_text_sha256,
    )


@router.post(
    "/paper/reference-graph/record",
    response_model=PaperGraphRecordResponseModel,
    summary="Record an exact workspace-scoped paper reference trace batch",
)
async def post_paper_reference_graph_record(
    body: PaperGraphRecordRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> PaperGraphRecordResponseModel:
    _enforce_session(x_dnaforge_session)
    _require_requested_capabilities(
        body.granted_capabilities, ["read-workspace", "create-entity"]
    )
    service = _service_or_raise()
    try:
        result = await service.record_paper_reference_graph(
            workspace_id=body.workspace_id,
            source_sha256=body.source_sha256,
            source_metadata=body.source.model_dump(exclude_none=True),
            traces=[
                PaperReferenceTrace(
                    relationship=trace.relationship,
                    target=PaperIdentifier(
                        scheme=trace.target.scheme,
                        value=trace.target.value,
                    ),
                    metadata=trace.evidence.model_dump(),
                )
                for trace in body.traces
            ],
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "error": "invalid_paper_reference_trace",
                "message": str(exc),
            },
        ) from exc
    return PaperGraphRecordResponseModel(
        source_uri=result.source_uri,
        source_sha256=result.source_sha256,
        edge_count=result.edge_count,
        identifiers=[
            PaperGraphIdentifierResponseModel(
                scheme=identifier["scheme"],
                value=identifier["value"],
                node_id=identifier["nodeId"],
            )
            for identifier in result.identifiers
        ],
        replayed=result.replayed,
    )


@router.post(
    "/paper/reference-graph/query",
    response_model=PaperGraphQueryResponseModel,
    summary="Query a bounded workspace-local paper reference graph without network access",
)
async def post_paper_reference_graph_query(
    body: PaperGraphQueryRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> PaperGraphQueryResponseModel:
    _enforce_session(x_dnaforge_session)
    _require_requested_capabilities(body.granted_capabilities, ["read-workspace"])
    service = _service_or_raise()
    try:
        graph = service.query_paper_reference_graph(
            workspace_id=body.workspace_id,
            source_sha256=body.source_sha256,
            depth=body.depth,
            max_nodes=body.max_nodes,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"error": "invalid_paper_reference_query", "message": str(exc)},
        ) from exc
    return PaperGraphQueryResponseModel(
        source_uri=graph.source_uri,
        nodes=[PaperGraphNodeResponseModel(**node) for node in graph.nodes],
        edges=[
            PaperGraphEdgeResponseModel(
                id=edge["id"],
                source_node_id=edge["from"],
                target_node_id=edge["to"],
                relationship=edge["relationship"],
                evidence=edge["evidence"],
                trace=edge["trace"],
            )
            for edge in graph.edges
        ],
        truncated=graph.truncated,
    )


@router.post(
    "/sequence/bytes",
    response_model=SequenceBytesResponseModel,
    summary=": fetch a sequence record's bytes + provenance from a sequence provider",
)
async def post_sequence_bytes(
    body: SequenceBytesRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> SequenceBytesResponseModel:
    """Fetch a GenBank record from a registered sequence provider through the
    substrate's rate-limit + circuit-breaker + backoff pipeline, returning the
    record text inline. The import path's NCBI fetch  — outbound
    third-party HTTP belongs in the sidecar, not the renderer."""
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    try:
        result = await service.fetch_sequence_bytes(
            provider=body.provider,
            external_id=body.external_id,
            format=body.format,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except CircuitOpen as exc:
        raise _circuit_open_http(exc) from exc
    except UnknownProvider as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "unknown_provider", "message": str(exc)},
        ) from exc
    except SequenceTooLarge as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "error": "sequence_too_large",
                "failure_kind": exc.failure_kind,
                "byte_count": exc.byte_count,
                "max_bytes": exc.max_bytes,
            },
        ) from exc
    except ServiceError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "invalid_request", "message": str(exc)},
        ) from exc
    except ProviderError as exc:
        raise _provider_error_http(exc) from exc
    return SequenceBytesResponseModel(
        provider=result.provider,
        external_id=result.external_id,
        format=result.format,
        content=result.content.decode("utf-8", errors="replace"),
        content_sha256=result.content_sha256,
        source_url=result.source_url,
        license=result.license,
        attribution=result.attribution,
        version_identifier=result.version_identifier,
        etag=result.etag,
        metadata=result.metadata,
    )


@router.post(
    "/sequence/url-bytes",
    response_model=SequenceBytesResponseModel,
    summary="Fetch a public GenBank/FASTA URL through the guarded HTTP boundary",
)
async def post_sequence_url_bytes(
    body: SequenceUrlBytesRequestModel,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> SequenceBytesResponseModel:
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    try:
        result = await service.fetch_sequence_url_bytes(
            source_url=body.url,
            granted_capabilities=_effective_external_capabilities(
                body.granted_capabilities
            ),
            workspace_id=body.workspace_id,
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except PublicHttpBoundaryError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"error": "unsafe_sequence_url", "message": str(exc)},
        ) from exc
    except SequenceTooLarge as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "error": "sequence_too_large",
                "failure_kind": exc.failure_kind,
                "byte_count": exc.byte_count,
                "max_bytes": exc.max_bytes,
            },
        ) from exc
    except ProviderError as exc:
        raise _provider_error_http(exc) from exc
    return SequenceBytesResponseModel(
        provider=result.provider,
        external_id=result.external_id,
        format=result.format,
        content=result.content.decode("utf-8", errors="replace"),
        content_sha256=result.content_sha256,
        source_url=result.source_url,
        license=result.license,
        attribution=result.attribution,
        version_identifier=result.version_identifier,
        etag=result.etag,
        metadata=result.metadata,
    )


@router.get(
    "/structure/poster/pdb/{pdb_id}/{poster_kind}",
    summary="Fetch an RCSB static structure poster image",
)
@router.get(
    "/structure/poster/rcsb/{pdb_id}/{poster_kind}",
    summary="Fetch an RCSB static structure poster image",
)
async def get_rcsb_structure_poster(
    pdb_id: str,
    poster_kind: str,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> Response:
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_STRUCTURE.value])
    service = _service_or_raise()
    try:
        result = await service.fetch_rcsb_poster(
            pdb_id=pdb_id,
            poster_kind=poster_kind,
            granted_capabilities=[Capability.EXTERNAL_FETCH_STRUCTURE.value],
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except (StructureTooLarge, ProviderError, CircuitOpen):
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    headers = {
        "Cache-Control": "public, max-age=86400",
        "X-External-Provider": result.provider,
        "X-External-Id": result.external_id,
        "X-Source-Url": result.source_url,
    }
    if result.etag:
        headers["ETag"] = result.etag
    return Response(
        content=result.content, media_type=result.content_type, headers=headers
    )


@router.get(
    "/structure/poster/alphafold/{accession}/{fragment}/{version}",
    summary="Render an AlphaFold DB cartoon pLDDT structure poster image",
)
async def get_alphafold_structure_poster(
    accession: str,
    fragment: str,
    version: str,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> Response:
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_STRUCTURE.value])
    service = _service_or_raise()
    try:
        result = await service.fetch_alphafold_poster(
            accession=accession,
            fragment=fragment,
            version=version,
            granted_capabilities=[Capability.EXTERNAL_FETCH_STRUCTURE.value],
        )
    except CapabilityDenied as exc:
        raise _capability_denied_http(exc) from exc
    except (StructureTooLarge, ProviderError, CircuitOpen):
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    headers = {
        "Cache-Control": "public, max-age=86400",
        "X-External-Provider": result.provider,
        "X-External-Id": result.external_id,
        "X-Source-Url": result.source_url,
        "X-Poster-Cache-Hit": "true" if result.cache_hit else "false",
    }
    if result.style:
        headers["X-Poster-Style"] = result.style
    if result.render_version:
        headers["X-Poster-Render-Version"] = result.render_version
    if result.etag:
        headers["ETag"] = result.etag
    return Response(
        content=result.content, media_type=result.content_type, headers=headers
    )


@router.get(
    "/resource/by-external-id",
    response_model=ExternalResourceModel,
    summary="Read by (provider, external_id)",
)
async def get_resource_by_external_id(
    provider: str,
    external_id: str,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> ExternalResourceModel:
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    row = service.get_resource_by_external_id(provider, external_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "not_found",
                "message": f"no resource for provider={provider!r} external_id={external_id!r}",
            },
        )
    return _row_to_model(row)


class XrefListItem(BaseModel):
    """One row from external_resource_xref, surfaced for the agent xref tool."""

    from_resource_id: str
    to_resource_id: str
    xref_type: str
    evidence: str | None = None
    confidence: float | None = None
    source_provider: str | None = None
    version: str | None = None
    identity: float | None = None
    coverage: float | None = None
    alignment_coords: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None


class XrefListResponse(BaseModel):
    """Listing for a cached resource. /xrefs returns 404 (matching sibling
    /resource/by-external-id semantics) when the (provider, external_id)
    tuple isn't cached — callers must fetch first."""

    resource_id: str
    target_provider: str | None = None
    xrefs: list[XrefListItem]
    total: int


@router.get(
    "/xrefs",
    response_model=XrefListResponse,
    summary="List cross-references for a cached resource (read-only).",
)
async def get_xrefs(
    provider: str,
    external_id: str,
    target_provider: str | None = None,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> XrefListResponse:
    """Read-only — never triggers a network fetch. Returns 404 (matching
    /external/resource/by-external-id) when the (provider, external_id)
    tuple isn't cached; agents can call /external/fetch first to populate."""
    _enforce_session(x_dnaforge_session)
    _enforce_session_grant_capabilities([Capability.EXTERNAL_FETCH_XREF.value])
    service = _service_or_raise()
    resource = service.get_resource_by_external_id(provider, external_id)
    if resource is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"no resource for provider={provider!r} external_id={external_id!r} "
                "— call /external/fetch first to populate the cache"
            ),
        )
    rows = service.list_xrefs(provider, external_id, target_provider)
    items = [
        XrefListItem(
            from_resource_id=row["from_resource_id"],
            to_resource_id=row["to_resource_id"],
            xref_type=row["xref_type"],
            evidence=row.get("evidence"),
            confidence=row.get("confidence"),
            source_provider=row.get("source_provider"),
            version=row.get("version"),
            identity=row.get("identity"),
            coverage=row.get("coverage"),
            alignment_coords=row.get("alignment_coords_json"),
            metadata=row.get("metadata_json"),
        )
        for row in rows
    ]
    return XrefListResponse(
        resource_id=resource["id"],
        target_provider=target_provider,
        xrefs=items,
        total=len(items),
    )


@router.get(
    "/resource/{resource_id}",
    response_model=ExternalResourceModel,
    summary="Read by canonical id",
)
async def get_resource(
    resource_id: str,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> ExternalResourceModel:
    _enforce_session(x_dnaforge_session)
    service = _service_or_raise()
    row = service.get_resource(resource_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "not_found",
                "message": f"no resource with id={resource_id!r}",
            },
        )
    return _row_to_model(row)


def _row_to_model(row: dict[str, Any]) -> ExternalResourceModel:
    return ExternalResourceModel(
        id=row["id"],
        provider=row["provider"],
        external_id=row["external_id"],
        external_url=row.get("external_url"),
        data_file_id=row.get("data_file_id"),
        version_identifier=row.get("version_identifier"),
        etag=row.get("etag"),
        license=row.get("license"),
        attribution=row.get("attribution"),
        metadata=row.get("metadata_json") or {},
        fetched_at=row["fetched_at"],
        last_checked=row["last_checked"],
    )


def _capability_denied_http(exc: CapabilityDenied) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "error": "capability_denied",
            "required": exc.required,
            "granted": exc.granted,
        },
    )


def _circuit_open_http(exc: CircuitOpen) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "error": "circuit_open",
            "origin": exc.origin,
            "retry_after_s": exc.opens_at_s,
        },
    )


def _provider_error_http(
    exc: ProviderError,
    *,
    provider_miss_status: int = status.HTTP_502_BAD_GATEWAY,
) -> HTTPException:
    if exc.status_code == 404 and provider_miss_status == status.HTTP_404_NOT_FOUND:
        return HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "provider_not_found",
                "failure_kind": exc.failure_kind,
                "message": str(exc),
                "status_code": exc.status_code,
            },
        )
    if exc.status_code == 422:
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "invalid_request",
                "failure_kind": exc.failure_kind,
                "message": str(exc),
            },
        )
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail={
            "error": "provider_error",
            "failure_kind": exc.failure_kind,
            "message": str(exc),
            "status_code": exc.status_code,
        },
    )


def _remote_range_error_detail(
    error_code: str, exc: RemoteRangeSourceError
) -> dict[str, object]:
    detail: dict[str, object] = {
        "error": error_code,
        "failure_kind": exc.failure_kind,
        "message": str(exc),
        "retryable": exc.retryable,
    }
    if exc.status_code is not None:
        detail["status_code"] = exc.status_code
    return detail


def _remote_range_error_http(
    error_code: str, exc: RemoteRangeSourceError
) -> HTTPException:
    return HTTPException(
        status_code=(
            status.HTTP_503_SERVICE_UNAVAILABLE
            if exc.retryable
            else status.HTTP_422_UNPROCESSABLE_CONTENT
        ),
        detail=_remote_range_error_detail(error_code, exc),
    )


def _remote_range_read_error_http(exc: RemoteRangeSourceError) -> HTTPException:
    if exc.failure_kind == "range_not_satisfiable":
        status_code = status.HTTP_416_RANGE_NOT_SATISFIABLE
    elif exc.failure_kind == "grant_expired":
        status_code = status.HTTP_401_UNAUTHORIZED
    elif exc.retryable:
        status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    elif exc.failure_kind == "source_changed":
        status_code = status.HTTP_409_CONFLICT
    else:
        status_code = status.HTTP_502_BAD_GATEWAY
    return HTTPException(
        status_code=status_code,
        detail=_remote_range_error_detail("range_read_failed", exc),
    )


def _htsget_error_http(exc: HtsgetSourceError) -> HTTPException:
    if exc.failure_kind in {"grant_expired", "authentication_required"}:
        status_code = status.HTTP_401_UNAUTHORIZED
    elif exc.failure_kind == "source_changed":
        status_code = status.HTTP_409_CONFLICT
    elif exc.failure_kind == "quota_exceeded":
        status_code = status.HTTP_413_CONTENT_TOO_LARGE
    elif exc.retryable:
        status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    else:
        status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
    return HTTPException(
        status_code=status_code,
        detail={
            "error": "htsget_source_unavailable",
            "failure_kind": exc.failure_kind,
            "message": str(exc),
            "retryable": exc.retryable,
            **({"status_code": exc.status_code} if exc.status_code is not None else {}),
        },
    )
