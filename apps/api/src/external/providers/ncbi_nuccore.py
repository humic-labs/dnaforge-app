"""NCBI nuccore provider for the external_resource substrate .

Fetches a nucleotide record (GenBank, full annotated) by accession from NCBI
E-utilities `efetch`, returning the GenBank text as `content_bytes` so the
service layer persists it as a `data_file` (cached, provenance-logged, behind
the substrate's circuit-breaker + rate-limiter). This is the architecturally
correct home for NCBI fetches — outbound 3rd-party HTTP belongs in the sidecar.

Scope (v1): nuccore GenBank fetch by accession. Returns the record text +
lightweight parsed metadata (organism, definition, length, topology, taxon).
Deferred: protein db / FASTA selector, a `/external/sequence/bytes` route that
hands the text back inline, and migrating the renderer-side bioinfo-client NCBI
fetch (`import_sequence`) onto this provider (the consolidation).

Accession format reference (ported from
`packages/core/bioinfo-client/src/utils/id-detection.ts isNcbiAccession`):

    [A-NR-Z]\\d{5}(\\.\\d+)?                       # 1-letter + 5 digits (legacy GenBank)
    [A-Z]{2}\\d{6}(\\.\\d+)?                        # 2-letter + 6 digits
    [A-Z]{4}\\d{8,10}(\\.\\d+)?                     # 4-letter + 8-10 digits (WGS)
    (AC|NC|NG|NM|NR|NT|NW|NZ|XM|XR)_[A-Z0-9]+(\\.\\d+)?  # RefSeq
"""

from __future__ import annotations

import hashlib
import re
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

_REFSEQ_PATTERN = re.compile(r"^(?:AC|NC|NG|NM|NR|NT|NW|NZ|XM|XR)_[A-Z0-9]+(?:\.\d+)?$")
_LEGACY_PATTERNS = (
    re.compile(r"^[A-NR-Z]\d{5}(?:\.\d+)?$"),
    re.compile(r"^[A-Z]{2}\d{6}(?:\.\d+)?$"),
    re.compile(r"^[A-Z]{4}\d{8,10}(?:\.\d+)?$"),
)

_ERROR_BODY_MARKERS = ("<ERROR>", "Error:", "Cannot retrieve", "Nothing has been found")


class NcbiNuccoreProvider:
    """Built-in provider for NCBI nuccore (nucleotide) GenBank records.

    Conforms to the `ExternalProvider` Protocol. The service layer owns the
    httpx client + persistence; this class builds the efetch URL, validates the
    response identity, and raises typed exceptions.
    """

    provider_id: str = "ncbi-nuccore"

    DEFAULT_BASE_URL: str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
    LICENSE: str = "Public domain (NCBI/GenBank; 17 U.S.C. § 105 + NCBI policy)"
    ATTRIBUTION: str = "Courtesy of the U.S. National Library of Medicine (NCBI)"

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        *,
        base_url: str | None = None,
        tool: str = "waypoint-dnaforge",
        email: str | None = None,
        api_key: str | None = None,
    ) -> None:
        self._client = client
        self._base_url = base_url or self.DEFAULT_BASE_URL
        self._tool = tool
        self._email = email
        self._api_key = api_key
        self.rate_limit_per_s: float = 10.0 if api_key else 3.0
        self.rate_limit_burst: float = self.rate_limit_per_s

    def detect_id(self, raw: str) -> ParsedId | None:
        """Parse a raw string. None if it is not an NCBI nucleotide accession.

        canonical_id keeps the FULL accession (with the version suffix) because
        efetch accepts and pins that exact record; the parsed version is also
        surfaced on ParsedId.version for provenance.
        """
        if not raw:
            return None
        candidate = raw.strip().upper()
        if not (
            _REFSEQ_PATTERN.fullmatch(candidate)
            or any(p.fullmatch(candidate) for p in _LEGACY_PATTERNS)
        ):
            return None
        version = None
        if "." in candidate:
            version = candidate.rsplit(".", 1)[1]
        return ParsedId(
            canonical_id=candidate, provider=self.provider_id, version=version
        )

    async def fetch(self, parsed_id: ParsedId, opts: FetchOptions) -> FetchResult:
        """Fetch the nuccore record as full annotated GenBank text."""
        if self._client is None:
            raise RuntimeError(
                "NcbiNuccoreProvider used without an httpx.AsyncClient — service layer must inject."
            )

        accession = parsed_id.canonical_id
        params: dict[str, str] = {
            "db": "nuccore",
            "id": accession,
            "rettype": "gbwithparts",
            "retmode": "text",
            "tool": self._tool,
        }
        if self._email:
            params["email"] = self._email
        if self._api_key:
            params["api_key"] = self._api_key
        url = f"{self._base_url}/efetch.fcgi"

        try:
            response = await self._client.get(
                url,
                params=params,
                timeout=httpx.Timeout(
                    timeout=opts.total_timeout_s, connect=opts.connect_timeout_s
                ),
                headers={"User-Agent": opts.user_agent, "Accept": "text/plain"},
            )
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                f"NCBI nuccore fetch for {accession} timed out after {opts.total_timeout_s}s"
            ) from exc
        except (httpx.HTTPError, OSError) as exc:
            raise ProviderHttpError(
                f"NCBI nuccore network error for {accession}: {exc.__class__.__name__}"
            ) from exc

        if response.status_code == 429:
            raise ProviderRateLimitError(
                f"NCBI rate-limited fetch for {accession}",
                retry_after_s=_parse_retry_after(response.headers.get("Retry-After")),
            )
        if response.status_code >= 400:
            raise ProviderHttpError(
                f"NCBI returned HTTP {response.status_code} for {accession}",
                status_code=response.status_code,
            )

        text = response.text or ""
        stripped = text.strip()
        if not stripped:
            raise ProviderContractError(
                f"NCBI returned no usable record for {accession} (empty body)",
                status_code=response.status_code,
            )
        if not stripped.startswith("LOCUS"):
            if any(marker in stripped[:400] for marker in _ERROR_BODY_MARKERS):
                raise ProviderContractError(
                    f"NCBI returned no usable record for {accession} (error body)",
                    status_code=response.status_code,
                )
            raise ProviderContractError(
                f"NCBI response for {accession} is not a GenBank record (no LOCUS line)",
                status_code=response.status_code,
            )

        content = response.content
        metadata = _parse_genbank_metadata(text)
        record_accession = (metadata.get("accession") or "").upper()
        if record_accession and not _accession_matches(accession, record_accession):
            raise ProviderContractError(
                f"NCBI returned record {record_accession!r} but request was for {accession!r}",
                status_code=response.status_code,
            )

        return FetchResult(
            parsed_id=parsed_id,
            metadata=metadata,
            content_bytes=content,
            content_mime_type="text/plain",
            content_sha256=hashlib.sha256(content).hexdigest(),
            external_url=f"https://www.ncbi.nlm.nih.gov/nuccore/{accession}",
            version_identifier=parsed_id.version,
            etag=response.headers.get("ETag"),
            license=self.LICENSE,
            attribution=self.ATTRIBUTION,
            status_code=response.status_code,
            bytes_received=len(content),
            xrefs=[],
        )

    async def resolve_xrefs(
        self, parsed_id: ParsedId, target_provider: str | None = None
    ) -> list[Xref]:
        return []

    def declared_capabilities(self) -> list[Capability]:
        return [Capability.EXTERNAL_FETCH_ANNOTATION]


def _parse_retry_after(header: str | None) -> float | None:
    if not header:
        return None
    try:
        return float(header)
    except ValueError:
        return None


_LOCUS_RE = re.compile(
    r"^LOCUS\s+(\S+)\s+(\d+)\s+bp.*?\b(circular|linear)\b", re.MULTILINE
)
_ACCESSION_RE = re.compile(r"^ACCESSION\s+(\S+)", re.MULTILINE)
_VERSION_RE = re.compile(r"^VERSION\s+(\S+)", re.MULTILINE)
_DEFINITION_RE = re.compile(r"^DEFINITION\s+(.+?)(?=^\S)", re.MULTILINE | re.DOTALL)
_ORGANISM_RE = re.compile(r'/organism="([^"]+)"')
_TAXON_RE = re.compile(r'/db_xref="taxon:(\d+)"')


def _parse_genbank_metadata(text: str) -> dict[str, Any]:
    """Light GenBank-header parse — no full feature parse (that is the desktop
    parser's job once the bytes are imported). Pulls the fields the registry /
    provenance want: accession, version, length, topology, definition, organism, taxon.
    """
    head = text[:8000]
    metadata: dict[str, Any] = {}
    if (m := _LOCUS_RE.search(head)) is not None:
        metadata["locus"] = m.group(1)
        metadata["length"] = int(m.group(2))
        metadata["topology"] = m.group(3)
    if (m := _VERSION_RE.search(head)) is not None:
        metadata["accession"] = m.group(1)
    elif (m := _ACCESSION_RE.search(head)) is not None:
        metadata["accession"] = m.group(1)
    if (m := _DEFINITION_RE.search(head)) is not None:
        metadata["definition"] = " ".join(m.group(1).split())
    if (m := _ORGANISM_RE.search(head)) is not None:
        metadata["organism"] = m.group(1)
    if (m := _TAXON_RE.search(head)) is not None:
        metadata["taxon_id"] = m.group(1)
    return metadata


def _accession_matches(requested: str, record: str) -> bool:
    """Compare accessions ignoring version (NCBI may return a different version
    than requested if the request omitted one; the base accession must match)."""
    return requested.split(".", 1)[0].upper() == record.split(".", 1)[0].upper()
