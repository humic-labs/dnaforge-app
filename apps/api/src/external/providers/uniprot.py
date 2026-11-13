"""UniProt provider for the external_resource substrate .

Subsumes the renderer-side raw fetches in
`apps/desktop/src/features/structure-drawer/api/uniprot-search.ts` and
`afdb-validate.ts`. The renderer migration onto this provider is deferred
to ; v1 stands the provider up here so  has something to
talk to.

V1 covers: entry fetch + db-xref resolution (UniProt → PDB / RefSeq / GeneID /
AlphaFoldDB). BLAST and homology search are OUT of v1 (codex 19, 20 — they're
compute-task-shaped, not fetch-shaped, and belong to a separate plan).

Accession format reference (UniProt's own spec, accessed during plan review):

    [OPQ][0-9][A-Z0-9]{3}[0-9]                    # 6-char (e.g. P00875)
    [A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2}     # 6 or 10 char (e.g. A0A0R4IGZ8)

Plus optional `-N` isoform suffix and `.N` version suffix:
    P00875        # canonical
    P00875-1      # isoform 1
    P00875.2      # version 2
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import httpx

from ..contract import (
    Capability,
    FetchOptions,
    FetchResult,
    ParsedId,
    ProviderContractError,
    ProviderHttpError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    Xref,
)
from .rcsb import rcsb_provider_identity_key


@dataclass(frozen=True)
class UniProtPdbXref:
    """Structured PDB cross-reference metadata from UniProt search results."""

    pdb_id: str
    method: str | None = None
    resolution: float | None = None
    chains: tuple[str, ...] = field(default_factory=tuple)
    raw_properties: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class UniProtSearchHit:
    """One row from a UniProt /uniprotkb/search result.

    Returned by `UniProtProvider.search()` and exposed via the
    `POST /external/uniprot/search` and `/external/uniprot/by-sequence`
    routes. The renderer's resolver chain consumes this to translate
    xref/gene/locus queries into canonical UniProt accessions.

    `pdb_ids` and `pdb_xrefs` are populated only when the caller passes
    `include_xrefs=True` to `search()` — empty otherwise. The structure
    drawer's by-sequence flow uses this to prefer experimental PDB
    structures over predicted AFDB models when both are available.
    """

    accession: str
    reviewed: bool
    sequence: str | None = None
    taxon_id: int | None = None
    organism: str | None = None
    pdb_ids: tuple[str, ...] = field(default_factory=tuple)
    pdb_xrefs: tuple[UniProtPdbXref, ...] = field(default_factory=tuple)


_UNIPROT_ACCESSION_PATTERN = re.compile(
    r"[OPQ][0-9][A-Z0-9]{3}[0-9]" r"|" r"[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2}"
)

_UNIPROT_RAW_PATTERN = re.compile(
    r"^("
    + _UNIPROT_ACCESSION_PATTERN.pattern
    + r")"
    + r"(?:-(\d+))?"
    + r"(?:\.(\d+))?"
    + r"$"
)


_XREF_DATABASE_TO_PROVIDER: dict[str, str] = {
    "PDB": "rcsb",
    "RefSeq": "refseq",
    "GeneID": "ncbi-gene",
    "AlphaFoldDB": "alphafold",
}


class UniProtProvider:
    """v1 built-in provider for UniProt entries.

    Conforms to the `ExternalProvider` Protocol from `..contract`. The service
    layer is responsible for HTTP-client setup and persistence; this class
    just builds URLs, parses responses, and raises typed exceptions.
    """

    provider_id: str = "uniprot"

    DEFAULT_BASE_URL: str = "https://rest.uniprot.org/uniprotkb"
    SEARCH_PATH: str = "/search"
    LICENSE: str = "CC-BY-4.0"
    ATTRIBUTION: str = "UniProt Consortium (https://www.uniprot.org)"

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        *,
        base_url: str | None = None,
    ) -> None:
        """Construct a provider bound to an httpx async client.

        The client is owned by the service layer in production (one client
        per sidecar process, shared across provider invocations). For tests,
        callers pass an httpx.AsyncClient with a MockTransport so no real
        network traffic happens.
        """
        self._client = client
        self._base_url = base_url or self.DEFAULT_BASE_URL

    def detect_id(self, raw: str) -> ParsedId | None:
        """Parse a raw string. None if not a UniProt accession.

        Accepts canonical (P00875), isoform-suffixed (P00875-1), and
        version-stamped (P00875.2). Both can co-occur (P00875-1.2 is NOT
        currently a documented UniProt format; the regex rejects it).
        """
        if not raw:
            return None
        match = _UNIPROT_RAW_PATTERN.fullmatch(raw.strip().upper())
        if match is None:
            return None
        canonical, isoform, version = match.groups()
        return ParsedId(
            canonical_id=canonical,
            provider=self.provider_id,
            isoform=isoform,
            version=version,
        )

    async def fetch(
        self,
        parsed_id: ParsedId,
        opts: FetchOptions,
    ) -> FetchResult:
        """Fetch the canonical UniProt entry as JSON.

        For an isoform-suffixed parsed_id, UniProt's URL form is
        `{base}/{accession}-{isoform}.json`. Version suffix is informational
        only — UniProt's REST surface always returns the latest release.
        """
        if self._client is None:
            raise RuntimeError(
                "UniProtProvider used without an httpx.AsyncClient — service layer must inject."
            )

        accession = parsed_id.canonical_id
        if parsed_id.isoform:
            url_id = f"{accession}-{parsed_id.isoform}"
        else:
            url_id = accession
        url = f"{self._base_url}/{url_id}.json"

        try:
            response = await self._client.get(
                url,
                timeout=httpx.Timeout(
                    timeout=opts.total_timeout_s,
                    connect=opts.connect_timeout_s,
                ),
                headers={"User-Agent": opts.user_agent, "Accept": "application/json"},
            )
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                f"UniProt fetch for {url_id} timed out after {opts.total_timeout_s}s"
            ) from exc
        except (httpx.HTTPError, OSError) as exc:
            raise ProviderHttpError(
                f"UniProt network error for {url_id}: {exc.__class__.__name__}"
            ) from exc

        if response.status_code == 429:
            retry_after = _parse_retry_after(response.headers.get("Retry-After"))
            raise ProviderRateLimitError(
                f"UniProt rate-limited fetch for {url_id}",
                retry_after_s=retry_after,
            )
        if response.status_code >= 400:
            raise ProviderHttpError(
                f"UniProt returned HTTP {response.status_code} for {url_id}",
                status_code=response.status_code,
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderContractError(
                f"UniProt returned malformed JSON for {url_id}",
                status_code=response.status_code,
            ) from exc

        if not isinstance(payload, dict):
            raise ProviderContractError(
                f"UniProt response for {url_id} was JSON but not an object "
                f"(got {type(payload).__name__})",
                status_code=response.status_code,
            )

        response_accession = (payload.get("primaryAccession") or "").upper()
        if not response_accession:
            raise ProviderContractError(
                f"UniProt response for {url_id} omitted primaryAccession",
                status_code=response.status_code,
            )
        if response_accession != accession.upper():
            raise ProviderContractError(
                f"UniProt returned data for {response_accession!r} but "
                f"request was for {accession!r}",
                status_code=response.status_code,
            )

        metadata = _extract_entry_metadata(payload)
        xrefs = _xrefs_from_payload(
            metadata.get("_uniprot_cross_references_raw") or [], self.provider_id
        )
        return FetchResult(
            parsed_id=parsed_id,
            metadata=metadata,
            external_url=f"https://www.uniprot.org/uniprotkb/{accession}/entry",
            version_identifier=str(
                payload.get("entryAudit", {}).get("entryVersion") or ""
            )
            or None,
            etag=response.headers.get("ETag"),
            license=self.LICENSE,
            attribution=self.ATTRIBUTION,
            status_code=response.status_code,
            bytes_received=len(response.content or b""),
            xrefs=xrefs,
        )

    async def resolve_xrefs(
        self,
        parsed_id: ParsedId,
        target_provider: str | None = None,
    ) -> list[Xref]:
        """Extract cross-references from the UniProt entry.

        For UniProt, fetch() already populates `FetchResult.xrefs` from the
        same response (saving a roundtrip), so the service layer reads from
        the result directly and never calls this method in v1. It exists on
        the provider for callers that want xrefs without the parent metadata
        — they pay the fetch cost.
        """
        if self._client is None:
            raise RuntimeError(
                "UniProtProvider used without an httpx.AsyncClient — service layer must inject."
            )
        result = await self.fetch(parsed_id, FetchOptions())
        if target_provider is None:
            return list(result.xrefs)
        return [x for x in result.xrefs if x.target_provider == target_provider]

    def declared_capabilities(self) -> list[Capability]:
        return [
            Capability.EXTERNAL_FETCH_ANNOTATION,
            Capability.EXTERNAL_FETCH_XREF,
        ]

    async def search(
        self,
        query: str,
        opts: FetchOptions,
        *,
        size: int = 1,
        include_xrefs: bool = False,
        include_sequence: bool = False,
    ) -> list[UniProtSearchHit]:
        """Run a UniProt /uniprotkb/search request, return hit accessions.

        Powers 's resolver chain: steps 3-7 hand opaque queries like
        `xref:embl-AAC73112.1 AND reviewed:true` or
        `gene_oln:b0001 AND organism_id:83333` to UniProt and want back the
        canonical accession. The route layer wraps this method; the provider
        owns the wire format + error mapping.

        Returns an empty list only for a real miss (`{"results":[]}`).
        Malformed 2xx payloads are provider contract failures: treating those
        as misses hides upstream/schema breakage as "no structure found".
        Raises ProviderRateLimitError on 429 (with Retry-After) and
        ProviderTimeoutError on total_timeout exceeded so the service-layer
        retry/backoff applies symmetrically with the entry-fetch path.
        """
        if self._client is None:
            raise RuntimeError(
                "UniProtProvider used without an httpx.AsyncClient — service layer must inject."
            )

        url = f"{self._base_url}{self.SEARCH_PATH}"
        fields = ["accession", "reviewed"]
        if include_xrefs:
            fields.append("xref_pdb")
        if include_sequence:
            fields.extend(["sequence", "organism_id", "organism_name"])
        params = {
            "query": query,
            "size": str(size),
            "fields": ",".join(fields),
        }
        try:
            response = await self._client.get(
                url,
                params=params,
                timeout=httpx.Timeout(
                    timeout=opts.total_timeout_s,
                    connect=opts.connect_timeout_s,
                ),
                headers={"User-Agent": opts.user_agent, "Accept": "application/json"},
            )
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                f"UniProt search timed out after {opts.total_timeout_s}s"
            ) from exc
        except (httpx.HTTPError, OSError) as exc:
            raise ProviderHttpError(
                f"UniProt search network error: {exc.__class__.__name__}"
            ) from exc

        if response.status_code == 429:
            retry_after = _parse_retry_after(response.headers.get("Retry-After"))
            raise ProviderRateLimitError(
                "UniProt search rate-limited",
                retry_after_s=retry_after,
            )
        if response.status_code >= 400:
            raise ProviderHttpError(
                f"UniProt search returned HTTP {response.status_code}",
                status_code=response.status_code,
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderContractError(
                "UniProt search returned malformed JSON",
                status_code=response.status_code,
            ) from exc
        results = payload.get("results") if isinstance(payload, dict) else None
        if not isinstance(results, list):
            raise ProviderContractError(
                "UniProt search response omitted a results list",
                status_code=response.status_code,
            )

        hits: list[UniProtSearchHit] = []
        for entry in results:
            if not isinstance(entry, dict):
                raise ProviderContractError(
                    "UniProt search response contained a non-object result",
                    status_code=response.status_code,
                )
            accession = entry.get("primaryAccession")
            entry_type = entry.get("entryType")
            if (
                not isinstance(accession, str)
                or not accession.strip()
                or _UNIPROT_ACCESSION_PATTERN.fullmatch(accession.strip().upper())
                is None
            ):
                raise ProviderContractError(
                    "UniProt search result omitted a valid primaryAccession",
                    status_code=response.status_code,
                )
            if entry_type is None:
                entry_type_text = ""
            elif isinstance(entry_type, str):
                entry_type_text = entry_type
            else:
                raise ProviderContractError(
                    "UniProt search result returned non-string entryType",
                    status_code=response.status_code,
                )
            pdb_ids: tuple[str, ...] = ()
            pdb_xrefs: tuple[UniProtPdbXref, ...] = ()
            if include_xrefs:
                pdb_xrefs = _extract_pdb_xrefs(entry.get("uniProtKBCrossReferences"))
                pdb_ids = tuple(xref.pdb_id for xref in pdb_xrefs)
            sequence_value: str | None = None
            taxon_id: int | None = None
            organism_name: str | None = None
            if include_sequence:
                sequence = entry.get("sequence")
                if isinstance(sequence, dict):
                    value = sequence.get("value")
                    if isinstance(value, str) and value.strip():
                        sequence_value = value.strip().upper()
                organism = entry.get("organism")
                if isinstance(organism, dict):
                    raw_taxon_id = organism.get("taxonId")
                    if isinstance(raw_taxon_id, int):
                        taxon_id = raw_taxon_id
                    raw_name = organism.get("scientificName")
                    if isinstance(raw_name, str) and raw_name.strip():
                        organism_name = raw_name.strip()
            hits.append(
                UniProtSearchHit(
                    accession=accession.strip().upper(),
                    reviewed="swiss-prot" in entry_type_text.lower(),
                    sequence=sequence_value,
                    taxon_id=taxon_id,
                    organism=organism_name,
                    pdb_ids=pdb_ids,
                    pdb_xrefs=pdb_xrefs,
                )
            )
        return hits


_XREF_TYPE_FOR: dict[str, str] = {
    "rcsb": "has_structure",
    "alphafold": "has_structure",
    "refseq": "codes_for_protein",
    "ncbi-gene": "codes_for_protein",
}


def _parse_retry_after(header: str | None) -> float | None:
    """Parse a Retry-After header. UniProt sends seconds-as-int; some servers
    send an HTTP-date. We accept seconds-only for v1."""
    if not header:
        return None
    try:
        return float(header)
    except ValueError:
        return None


def _extract_pdb_xrefs(xrefs: Any) -> tuple[UniProtPdbXref, ...]:
    """Pull structured PDB xrefs out of `uniProtKBCrossReferences`.

    Preserves UniProt REST order and keeps raw property strings alongside
    normalized method/resolution/chain fields.
    """
    if not isinstance(xrefs, list):
        return ()
    pdb_xrefs: list[UniProtPdbXref] = []
    for x in xrefs:
        if not isinstance(x, dict):
            continue
        if x.get("database") != "PDB":
            continue
        pdb_id = x.get("id")
        if not isinstance(pdb_id, str) or not pdb_id:
            continue
        raw_properties = _xref_properties(x.get("properties"))
        pdb_xrefs.append(
            UniProtPdbXref(
                pdb_id=pdb_id.upper(),
                method=raw_properties.get("Method"),
                resolution=_parse_resolution(raw_properties.get("Resolution")),
                chains=_parse_chains(raw_properties.get("Chains")),
                raw_properties=raw_properties,
            )
        )
    return tuple(pdb_xrefs)


def _extract_pdb_ids(xrefs: Any) -> tuple[str, ...]:
    """Pull PDB ids out of a UniProt entry's `uniProtKBCrossReferences`
    array (only present in search responses requested with
    `fields=...,xref_pdb`). Each entry shape:

        {
            "database": "PDB",
            "id": "1ABC",
            "properties": [
                {"key": "Method", "value": "X-ray"},
                {"key": "Resolution", "value": "2.10 A"},
                {"key": "Chains", "value": "A=1-150"},
            ],
        }

    Order is preserved (UniProt's REST orders by entry; the resolver's
    "first PDB wins" policy treats this as the canonical order). The
    follow-up source-management ticket replaces this with a richer
    selection (best resolution, chain coverage, user choice).
    """
    return tuple(xref.pdb_id for xref in _extract_pdb_xrefs(xrefs))


def _xref_properties(properties: Any) -> dict[str, str]:
    if not isinstance(properties, list):
        return {}
    result: dict[str, str] = {}
    for prop in properties:
        if not isinstance(prop, dict):
            continue
        key = prop.get("key")
        value = prop.get("value")
        if isinstance(key, str) and isinstance(value, str):
            result[key] = value
    return result


def _parse_resolution(value: str | None) -> float | None:
    if not value:
        return None
    match = re.search(r"\d+(?:\.\d+)?", value)
    if match is None:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _parse_chains(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    chains: list[str] = []
    seen: set[str] = set()
    for chunk in value.split(","):
        left = chunk.split("=", 1)[0]
        for chain in re.split(r"[/;]", left):
            normalized = chain.strip()
            if normalized and normalized not in seen:
                chains.append(normalized)
                seen.add(normalized)
    return tuple(chains)


def _extract_entry_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    """Pull provider-derived fields from a UniProt entry JSON.

    Only stores what's useful for downstream display + xref resolution. The
    raw cross-reference array is preserved under a private key so
    resolve_xrefs() can read it without re-fetching. Workspace-private user
    content does NOT belong here — `external_resource.metadata_json` is
    globally scoped per the schema's privacy invariant.
    """
    primary = payload.get("primaryAccession") or ""
    organism = payload.get("organism") or {}
    sequence = payload.get("sequence") or {}
    genes = payload.get("genes") or []
    primary_gene_name: str | None = None
    if genes:
        primary_gene_name = (genes[0].get("geneName") or {}).get("value")
    protein_description = payload.get("proteinDescription") or {}
    recommended = protein_description.get("recommendedName") or {}
    full_name = (recommended.get("fullName") or {}).get("value")

    ec_numbers: list[str] = []
    for ec in recommended.get("ecNumbers") or []:
        if isinstance(ec, dict) and ec.get("value"):
            ec_numbers.append(ec["value"])

    entry_type = (payload.get("entryType") or "").lower()
    reviewed = "swiss-prot" in entry_type

    return {
        "name": full_name,
        "gene": primary_gene_name,
        "organism": organism.get("scientificName"),
        "taxon_id": str(organism.get("taxonId")) if organism.get("taxonId") else None,
        "length": sequence.get("length"),
        "ec_numbers": ec_numbers,
        "reviewed": reviewed,
        "primary_accession": primary,
        "_uniprot_cross_references_raw": payload.get("uniProtKBCrossReferences", []),
    }


def _xrefs_from_payload(
    cross_refs_raw: list[dict[str, Any]],
    source_provider: str,
) -> list[Xref]:
    """Translate the UniProt response's `uniProtKBCrossReferences` array
    into the substrate's Xref shape.

    Only xrefs to providers in `_XREF_DATABASE_TO_PROVIDER` are emitted —
    other databases (EMBL, Pfam, GO, etc.) are dropped until the substrate
    has rows for them. AFDB xrefs are tagged `predicted` because AlphaFold
    structures are computed predictions; PDB xrefs are `asserted` because
    they reference experimental structures.
    """
    xrefs: list[Xref] = []
    for entry in cross_refs_raw:
        db = entry.get("database")
        xref_id = entry.get("id")
        if not db or not xref_id:
            continue
        mapped_provider = _XREF_DATABASE_TO_PROVIDER.get(db)
        if mapped_provider is None:
            continue
        xref_type = _XREF_TYPE_FOR.get(mapped_provider, "related_to")
        evidence = "predicted" if mapped_provider == "alphafold" else "asserted"
        confidence = 1.0 if evidence == "asserted" else None
        raw_properties = _xref_properties(entry.get("properties"))
        metadata = _xref_metadata_from_properties(entry.get("properties") or [])
        xrefs.append(
            Xref(
                target_provider=mapped_provider,
                target_external_id=_canonical_xref_target_external_id(
                    mapped_provider,
                    str(xref_id),
                    raw_properties,
                ),
                xref_type=xref_type,
                evidence=evidence,
                source_provider=source_provider,
                confidence=confidence,
                metadata=metadata,
            )
        )
    return xrefs


def _canonical_xref_target_external_id(
    target_provider: str,
    external_id: str,
    raw_properties: dict[str, str],
) -> str:
    if target_provider == "rcsb":
        return rcsb_provider_identity_key(
            external_id,
            auth_asym_ids=_parse_chains(raw_properties.get("Chains")),
        )
    return external_id


def _xref_metadata_from_properties(properties: list[dict[str, Any]]) -> dict[str, Any]:
    """Convert UniProt's `[{key, value}, ...]` property bag to a flat dict.

    UniProt cross-reference entries look like:
        {"database": "PDB", "id": "1RBL",
         "properties": [{"key": "Method", "value": "X-ray"},
                        {"key": "Resolution", "value": "2.20 A"}, ...]}
    """
    out: dict[str, Any] = {}
    for prop in properties:
        if not isinstance(prop, dict):
            continue
        key = prop.get("key")
        value = prop.get("value")
        if not key:
            continue
        out[key] = value
    return out
