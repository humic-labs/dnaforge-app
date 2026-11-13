"""AlphaFold DB existence validator .

Subsumes the renderer-side raw fetch in
`apps/desktop/src/features/structure-drawer/api/afdb-validate.ts`. The renderer
migration  routes through this module instead of hitting AFDB
directly from Electron.

Why this is a thin function module and not a full ExternalProvider:
- v1 only needs existence + pLDDT, not entry persistence. UniProt's xrefs
  already capture the AFDB linkage in the substrate; pLDDT is the only
  AFDB-specific datum the drawer surfaces.
- AFDB → AlphaFoldProvider is on the v1.5 / follow-up roadmap. Promoting this
  to a Protocol-conforming provider then is a strict superset of what's
  here; the renderer-facing route stays stable.

The route layer (`/external/alphafold/validate`) writes one
`external_fetch_log` row per call so the substrate has fetch provenance even
without an external_resource row. Sidecar policy: every renderer-driven
fetch is auditable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import httpx

from .contract import (
    FetchOptions,
    ProviderContractError,
    ProviderHttpError,
    ProviderRateLimitError,
    ProviderTimeoutError,
)

DEFAULT_AFDB_BASE_URL = "https://alphafold.ebi.ac.uk/api/prediction"
LICENSE = "CC-BY-4.0"
ATTRIBUTION = "AlphaFold Protein Structure Database (https://alphafold.ebi.ac.uk)"


@dataclass(frozen=True)
class AfdbHit:
    """AFDB has a structure prediction for the given UniProt accession.

    Surfaced to the drawer footer (`StructureDrawerFooter`) where the mean
    pLDDT renders as a confidence note. None when AFDB doesn't report it
    (some smaller predictions omit the global confidence average).

    `cif_url` is the provider-owned current structure download URL. AlphaFold
    increments model versions, so callers must not construct this from a
    hard-coded version.
    """

    accession: str
    mean_plddt: float | None
    latest_version: int | None = None
    cif_url: str | None = None
    fragment: str = "F1"
    model_id: str | None = None


async def validate_afdb_exists(
    client: httpx.AsyncClient,
    accession: str,
    opts: FetchOptions,
    *,
    fragment: str = "F1",
    base_url: str = DEFAULT_AFDB_BASE_URL,
) -> AfdbHit | None:
    """Returns AfdbHit if AFDB has a prediction for `accession`, else None.

    Maintains the renderer's null-on-biological-miss contract: 404 collapses
    to None so the resolver chain can fall through. Provider failures raise so
    fixture replay misses, 5xx, malformed JSON, and transport failures cannot
    masquerade as "AFDB has no prediction".
    """
    canonical = accession.strip().upper()
    if not canonical:
        return None
    url = f"{base_url}/{canonical}"
    try:
        response = await client.get(
            url,
            timeout=httpx.Timeout(
                timeout=opts.total_timeout_s,
                connect=opts.connect_timeout_s,
            ),
            headers={"User-Agent": opts.user_agent, "Accept": "application/json"},
        )
    except httpx.TimeoutException as exc:
        raise ProviderTimeoutError(
            f"AFDB validate for {canonical} timed out after {opts.total_timeout_s}s"
        ) from exc
    except (httpx.HTTPError, OSError) as exc:
        raise ProviderHttpError(
            f"AFDB validate network error for {canonical}: {exc.__class__.__name__}"
        ) from exc

    if response.status_code == 429:
        from .providers.uniprot import _parse_retry_after

        raise ProviderRateLimitError(
            f"AFDB validate rate-limited for {canonical}",
            retry_after_s=_parse_retry_after(response.headers.get("Retry-After")),
        )
    if response.status_code == 404:
        return None
    if response.status_code >= 400:
        raise ProviderHttpError(
            f"AFDB returned HTTP {response.status_code} for {canonical}",
            status_code=response.status_code,
        )

    try:
        entries = response.json()
    except ValueError as exc:
        raise ProviderContractError(
            f"AFDB returned malformed JSON for {canonical}",
            status_code=response.status_code,
        ) from exc
    if isinstance(entries, list) and not entries:
        return None
    if not isinstance(entries, list):
        raise ProviderContractError(
            f"AFDB response for {canonical} was not a list",
            status_code=response.status_code,
        )
    desired_fragment = fragment.strip().upper() or "F1"
    if not re.fullmatch(r"F[1-9][0-9]*", desired_fragment):
        raise ProviderHttpError(
            f"invalid AFDB fragment {fragment!r}",
            status_code=422,
        )
    entry: dict[str, object] | None = None
    parseable_fragment_count = 0
    for candidate in entries:
        if not isinstance(candidate, dict):
            raise ProviderContractError(
                f"AFDB response entry for {canonical} was not an object",
                status_code=response.status_code,
            )
        candidate_fragment = _entry_fragment(candidate)
        if candidate_fragment is not None:
            parseable_fragment_count += 1
        if candidate_fragment == desired_fragment:
            entry = candidate
            break
    if entry is None:
        if parseable_fragment_count == 0:
            raise ProviderContractError(
                f"AFDB response for {canonical} did not expose parseable model fragments",
                status_code=response.status_code,
            )
        return None
    if not isinstance(entry, dict):
        raise ProviderContractError(
            f"AFDB response entry for {canonical} was not an object",
            status_code=response.status_code,
        )
    raw_accession = entry.get("uniprotAccession") or canonical
    hit_accession = str(raw_accession).upper()
    if hit_accession != canonical:
        raise ProviderContractError(
            f"AFDB response accession {hit_accession!r} did not match request {canonical!r}",
            status_code=response.status_code,
        )
    confidence = entry.get("confidenceAvgGlobal")
    if type(confidence) not in (int, float):
        confidence = entry.get("globalMetricValue")
    latest_version = entry.get("latestVersion")
    if latest_version is not None and (
        type(latest_version) is not int or latest_version < 1
    ):
        raise ProviderContractError(
            f"AFDB response for {canonical} had invalid latestVersion {latest_version!r}",
            status_code=response.status_code,
        )
    cif_url = entry.get("cifUrl")
    parsed_model = (
        _parse_alphafold_model_from_url(cif_url) if isinstance(cif_url, str) else None
    )
    if isinstance(cif_url, str) and cif_url and parsed_model is None:
        raise ProviderContractError(
            f"AFDB response for {canonical} had non-canonical CIF URL {cif_url!r}",
            status_code=response.status_code,
        )
    if (
        parsed_model is not None
        and latest_version is not None
        and parsed_model[3] != latest_version
    ):
        raise ProviderContractError(
            f"AFDB response for {canonical} had conflicting latestVersion and CIF URL",
            status_code=response.status_code,
        )
    model_id = parsed_model[0] if parsed_model else _entry_model_id(entry)
    hit_fragment = (
        parsed_model[2] if parsed_model else _entry_fragment(entry) or desired_fragment
    )
    resolved_latest_version = (
        latest_version
        if type(latest_version) is int
        else (parsed_model[3] if parsed_model else None)
    )
    return AfdbHit(
        accession=hit_accession,
        mean_plddt=float(confidence) if type(confidence) in (int, float) else None,
        latest_version=resolved_latest_version,
        cif_url=cif_url if isinstance(cif_url, str) and cif_url else None,
        fragment=hit_fragment,
        model_id=model_id,
    )


_AFDB_MODEL_URL_RE = re.compile(
    r"^https://alphafold\.ebi\.ac\.uk/files/(AF-([A-Za-z0-9]+)-(F[1-9][0-9]*)-model_v([1-9][0-9]*))\.cif$"
)


def _parse_alphafold_model_from_url(value: object) -> tuple[str, str, str, int] | None:
    if not isinstance(value, str):
        return None
    match = _AFDB_MODEL_URL_RE.fullmatch(value)
    if match is None:
        return None
    return (
        f"AF-{match.group(2).upper()}-{match.group(3).upper()}-model_v{match.group(4)}",
        match.group(2).upper(),
        match.group(3).upper(),
        int(match.group(4)),
    )


def _entry_fragment(entry: dict[str, object]) -> str | None:
    parsed_url = _parse_alphafold_model_from_url(entry.get("cifUrl"))
    if parsed_url is not None:
        return parsed_url[2]
    for key in ("modelEntityId", "entryId", "modelId"):
        value = entry.get(key)
        if not isinstance(value, str):
            continue
        match = re.fullmatch(
            r"AF-[A-Za-z0-9]+-(F[1-9][0-9]*)(?:-model_v[1-9][0-9]*)?",
            value,
        )
        if match:
            return match.group(1).upper()
    return None


def _entry_model_id(entry: dict[str, object]) -> str | None:
    for key in ("modelEntityId", "entryId", "modelId"):
        value = entry.get(key)
        if not isinstance(value, str):
            continue
        match = re.fullmatch(
            r"AF-([A-Za-z0-9]+)-(F[1-9][0-9]*)-model_v([1-9][0-9]*)",
            value,
        )
        if match:
            return f"AF-{match.group(1).upper()}-{match.group(2).upper()}-model_v{match.group(3)}"
    return None


def _parse_retry_after(header: str | None) -> float | None:  # pragma: no cover
    from .providers.uniprot import _parse_retry_after as _impl

    return _impl(header)


__all__ = ["AfdbHit", "validate_afdb_exists", "LICENSE", "ATTRIBUTION"]
