"""UniProt provider-domain methods for ExternalResourcesService .

A mixin extracted from service.py. Runs on the composed ExternalResourcesService
and REQUIRES the host to provide the substrate primitives it calls via `self`
(`_client`, `_store`, `_bucket_for`, `_breaker_for`, `_origin_for`,
`_check_required_capabilities`, the `_log_*` helpers). Imports nothing from
service.py (keeps the mixin split cycle-free).
"""

from __future__ import annotations

import hashlib
import time

from .contract import (
    Capability,
    FetchOptions,
    FetchResult,
    ProviderError,
    ProviderHttpError,
)
from .providers.uniprot import UniProtProvider, UniProtSearchHit
from .service_types import (
    _ANNOTATION_REQUIRED,
    CapabilityDenied,
    CircuitOpen,
    ProteinQueryEvidence,
    ProteinQueryIdentity,
    UnknownProvider,
)


class UniProtServiceMixin:
    """UniProt search / by-sequence / summary methods. See module docstring."""

    async def search_uniprot(
        self,
        query: str,
        *,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        size: int = 1,
        opts: FetchOptions | None = None,
        include_xrefs: bool = False,
        include_sequence: bool = False,
    ) -> list[UniProtSearchHit]:
        """Translate a UniProt query string into hit accessions via the registered
        UniProt provider. Powers 's resolver chain steps 3-7.

        `include_xrefs=True` requests UniProt's `xref_pdb` field so each hit
        carries any PDB cross-references — used by the by-sequence flow to
        prefer experimental over predicted structures. Off by default to
        keep the existing search-by-name paths' wire size minimal."""
        provider = self._providers.get("uniprot")
        if provider is None:
            raise UnknownProvider("no provider registered for 'uniprot'")
        if not isinstance(provider, UniProtProvider):
            raise UnknownProvider(
                f"registered 'uniprot' provider does not support search "
                f"(got {provider.__class__.__name__})"
            )
        self._check_capabilities(provider, granted_capabilities)
        if include_xrefs and Capability.EXTERNAL_FETCH_XREF.value not in set(
            granted_capabilities
        ):
            required = sorted(
                [*_ANNOTATION_REQUIRED, Capability.EXTERNAL_FETCH_XREF.value]
            )
            raise CapabilityDenied(
                required=required, granted=sorted(granted_capabilities)
            )
        opts = opts or FetchOptions()

        async def _do_search() -> list[UniProtSearchHit]:
            if provider._client is None:
                provider._client = self._client
            return await provider.search(
                query,
                opts,
                size=size,
                include_xrefs=include_xrefs,
                include_sequence=include_sequence,
            )

        t0 = time.perf_counter()
        try:
            hits = await self._run_through_resilience(provider, opts, _do_search)
        except (ProviderError, CircuitOpen) as exc:
            latency_ms = int((time.perf_counter() - t0) * 1000)
            self._log_thin_call(
                provider=provider,
                endpoint=f"{provider.DEFAULT_BASE_URL}{provider.SEARCH_PATH}",
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=latency_ms,
                exc=exc,
            )
            raise
        latency_ms = int((time.perf_counter() - t0) * 1000)
        self._log_thin_call(
            provider=provider,
            endpoint=f"{provider.DEFAULT_BASE_URL}{provider.SEARCH_PATH}",
            granted=granted_capabilities,
            workspace_id=workspace_id,
            latency_ms=latency_ms,
            status_code=200,
        )
        return hits

    @staticmethod
    def _normalize_protein_for_md5(sequence: str) -> str:
        """Normalize a protein sequence for MD5 hashing against UniProt's
        `checksum:` field. UniProt stores the canonical mature-/precursor-
        protein WITHOUT the trailing stop codon, in uppercase single-letter
        codes. The stored `md5` on every UniProt entry is
        `MD5(sequence_value)`, which means our hash matches if and only if
        we feed the same string shape: uppercase, no whitespace, no trailing
        '*'.

        Verified empirically: P03817 (E. coli mioC, 147 aa) — UniProt's
        stored md5 is `4BFC2ED15C60BB6BF4D68FC54F668B53`, matches
        `hashlib.md5(value.upper()).hexdigest().upper()` for the stored
        sequence value.
        """
        cleaned = "".join(ch for ch in sequence if not ch.isspace()).upper()
        if cleaned.endswith("*"):
            cleaned = cleaned[:-1]
        return cleaned

    @staticmethod
    def _query_identity_for_protein(sequence: str) -> ProteinQueryIdentity:
        normalized = UniProtServiceMixin._normalize_protein_for_md5(sequence)
        evidence: list[ProteinQueryEvidence] = []
        invalid_residue = next(
            (
                residue
                for residue in normalized
                if residue != "*" and not ("A" <= residue <= "Z")
            ),
            None,
        )
        internal_stop = "*" in normalized
        if not normalized:
            return ProteinQueryIdentity(
                kind="protein_sequence",
                normalized_length=0,
                checksum_md5="",
                checksum_sha256="",
                canonical_form="waypoint-protein-v2",
                canonical_lookup_sequence=normalized,
                canonical_form_applied=True,
                ineligible=True,
                ineligible_reason="empty",
                evidence=(),
            )
        if invalid_residue is not None or internal_stop:
            if invalid_residue is not None:
                evidence.append(
                    ProteinQueryEvidence(
                        kind="protein_invalid_residue",
                        residue=invalid_residue,
                    )
                )
            if internal_stop:
                evidence.append(ProteinQueryEvidence(kind="internal_stop", residue="*"))
            ineligible_reason = (
                "internal_stop" if internal_stop else "protein_invalid_residue"
            )
            return ProteinQueryIdentity(
                kind="protein_sequence",
                normalized_length=len(normalized),
                checksum_md5="",
                checksum_sha256="",
                canonical_form="waypoint-protein-v2",
                canonical_lookup_sequence="",
                canonical_form_applied=True,
                ineligible=True,
                ineligible_reason=ineligible_reason,
                evidence=tuple(evidence),
            )
        seen_non_standard: set[str] = set()
        for residue in normalized:
            if residue in {"U", "O", "X", "B", "Z", "J"}:
                if residue in seen_non_standard:
                    continue
                seen_non_standard.add(residue)
                evidence.append(
                    ProteinQueryEvidence(kind="non_standard_residue", residue=residue)
                )
        md5_hex = (
            hashlib.md5(
                normalized.encode("ascii"),
                usedforsecurity=False,
            )
            .hexdigest()
            .upper()
            if normalized
            else ""
        )
        sha256_hex = hashlib.sha256(normalized.encode("ascii")).hexdigest()
        return ProteinQueryIdentity(
            kind="protein_sequence",
            normalized_length=len(normalized),
            checksum_md5=md5_hex,
            checksum_sha256=sha256_hex,
            canonical_form="waypoint-protein-v2",
            canonical_lookup_sequence=normalized,
            canonical_form_applied=True,
            ineligible=False,
            ineligible_reason=None,
            evidence=tuple(evidence),
        )

    async def search_uniprot_by_sequence(
        self,
        sequence: str,
        *,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        size: int = 10,
        opts: FetchOptions | None = None,
    ) -> tuple[ProteinQueryIdentity, list[UniProtSearchHit]]:
        """Look up UniProt entries whose canonical sequence MD5-matches the
        supplied protein. Powers the structure drawer's primary resolution
        mechanism: most user proteins (reference-genome CDSes, cloned wild-
        types, codon-optimized variants of known proteins) have an exact
        UniProt entry — no xref qualifiers needed.

        Returns `(query_identity, hits)` where `query_identity.checksum_md5` is the uppercase MD5 we
        queried with (echoed back so callers can audit / surface) and
        `hits` are sorted with reviewed (Swiss-Prot) entries first, then
        unreviewed (TrEMBL). For highly-conserved proteins UniProt may
        return tens of identical-sequence entries across strains; the
        Swiss-Prot prioritization picks the canonical reference.

        On a UniProt API failure this raises `ProviderError` (mapped to
        HTTP 502 at the route layer). On no match (no UniProt entry has
        this exact sequence — common for synthetic / engineered proteins)
        it returns `(query_identity, [])` and the caller falls through to the
        next resolver mechanism (homology search, deferred to v2).
        """
        provider = self._providers.get("uniprot")
        if provider is None:
            raise UnknownProvider("no provider registered for 'uniprot'")
        if not isinstance(provider, UniProtProvider):
            raise UnknownProvider(
                f"registered 'uniprot' provider does not support search "
                f"(got {provider.__class__.__name__})"
            )
        self._check_capabilities(provider, granted_capabilities)

        query_identity = self._query_identity_for_protein(sequence)
        if not query_identity.canonical_lookup_sequence or query_identity.ineligible:
            return (query_identity, [])
        query = f"checksum:{query_identity.checksum_md5}"
        hits = await self.search_uniprot(
            query,
            granted_capabilities=granted_capabilities,
            workspace_id=workspace_id,
            size=size,
            opts=opts,
            include_xrefs=Capability.EXTERNAL_FETCH_XREF.value
            in set(granted_capabilities),
        )
        sorted_hits = sorted(hits, key=lambda h: (not h.reviewed,))
        return (query_identity, sorted_hits)

    async def summarize_uniprot_entry(
        self,
        accession: str,
        *,
        granted_capabilities: list[str],
        workspace_id: str | None = None,
        opts: FetchOptions | None = None,
    ) -> FetchResult:
        """Metadata-only UniProt summary for direct AlphaFold entrypoints."""
        provider = self._providers.get("uniprot")
        if provider is None:
            raise UnknownProvider("no provider registered for 'uniprot'")
        if not isinstance(provider, UniProtProvider):
            raise UnknownProvider(
                f"registered 'uniprot' provider does not support summary "
                f"(got {provider.__class__.__name__})"
            )
        parsed = provider.detect_id(accession)
        if parsed is None:
            raise ProviderHttpError(
                f"invalid UniProt accession {accession!r}", status_code=422
            )
        self._check_capabilities(provider, granted_capabilities)
        opts = opts or FetchOptions()
        endpoint = f"{provider.DEFAULT_BASE_URL}/{parsed.canonical_id}"

        async def _do_summary() -> FetchResult:
            if provider._client is None:
                provider._client = self._client
            return await provider.fetch(parsed, opts)

        t0 = time.perf_counter()
        try:
            result = await self._run_through_resilience(provider, opts, _do_summary)
        except (ProviderError, CircuitOpen) as exc:
            latency_ms = int((time.perf_counter() - t0) * 1000)
            self._log_thin_call(
                provider=provider,
                endpoint=endpoint,
                granted=granted_capabilities,
                workspace_id=workspace_id,
                latency_ms=latency_ms,
                exc=exc,
            )
            raise
        latency_ms = int((time.perf_counter() - t0) * 1000)
        self._log_thin_call(
            provider=provider,
            endpoint=endpoint,
            granted=granted_capabilities,
            workspace_id=workspace_id,
            latency_ms=latency_ms,
            status_code=result.status_code,
        )
        return result
