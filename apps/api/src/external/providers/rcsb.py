"""RCSB PDB provider for the external_resource substrate .

This provider fetches metadata for a canonical PDB entry via the RCSB Data API.
It intentionally does not fetch structure bytes;  owns direct structure
entrypoint migration and byte caching. The metadata shape here is the foundation
 can use to rank and display PDB candidates.
"""

from __future__ import annotations

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

_PDB_ID_PATTERN = re.compile(
    r"^([0-9][A-Za-z0-9]{3})(?:/([A-Za-z0-9]+(?:,[A-Za-z0-9]+)*))?(?:#([A-Za-z0-9]+))?$"
)


class RCSBEntryNotFound(ProviderHttpError):
    """404 for the primary RCSB entry document.

    This is the only RCSB 404 that means "invalid PDB id" to validation
    callers. Polymer entity and assembly 404s are provider/contract failures:
    they indicate RCSB entry metadata referenced a subresource that could not
    be fetched.
    """


class RCSBProvider:
    """Built-in provider for RCSB PDB entry metadata."""

    provider_id: str = "rcsb"

    DEFAULT_BASE_URL: str = "https://data.rcsb.org"
    ENTRY_PATH: str = "/rest/v1/core/entry"
    POLYMER_ENTITY_PATH: str = "/rest/v1/core/polymer_entity"
    ASSEMBLY_PATH: str = "/rest/v1/core/assembly"
    STRUCTURE_PAGE_URL: str = "https://www.rcsb.org/structure"
    FILE_DOWNLOAD_URL: str = "https://files.rcsb.org/download"
    LICENSE: str = "CC0-1.0"
    ATTRIBUTION: str = "RCSB Protein Data Bank (https://www.rcsb.org)"
    POLICY_URL: str = "https://www.rcsb.org/pages/policies"

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        *,
        base_url: str | None = None,
    ) -> None:
        self._client = client
        self._base_url = base_url or self.DEFAULT_BASE_URL

    def detect_id(self, raw: str) -> ParsedId | None:
        """Parse a PDB id with an optional chain selector.

        Accepts canonical IDs such as `1RBL` and chain-scoped IDs such as
        `1RBL/A`. The canonical entry fetch still targets `1RBL`; the chain
        selector participates in the cache key through ParsedId.cache_key().
        """
        if not raw:
            return None
        scoped = parse_rcsb_external_id(raw)
        if scoped is None:
            return None
        return ParsedId(
            canonical_id=scoped["pdb_id"],
            provider=self.provider_id,
            chain=",".join(scoped.get("auth_asym_ids") or ()) or None,
            entity=scoped.get("pdb_entity_id"),
            scope=scoped["provider_identity_key"],
        )

    async def fetch(
        self,
        parsed_id: ParsedId,
        opts: FetchOptions,
    ) -> FetchResult:
        """Fetch RCSB entry metadata as JSON."""
        if self._client is None:
            raise RuntimeError(
                "RCSBProvider used without an httpx.AsyncClient - service layer must inject."
            )

        pdb_id = parsed_id.canonical_id.upper()
        entry_url = f"{self._base_url}{self.ENTRY_PATH}/{pdb_id}"
        payload, response = await self._get_json_object(
            entry_url,
            pdb_id,
            opts,
            resource_name="entry",
        )
        bytes_received = len(response.content or b"")

        response_id = _str_or_none(payload.get("rcsb_id"))
        if not response_id:
            raise ProviderContractError(
                f"RCSB entry response omitted rcsb_id for requested {pdb_id!r}",
                status_code=response.status_code,
            )
        if response_id.upper() != pdb_id:
            raise ProviderContractError(
                f"RCSB returned data for {response_id!r} but request was for {pdb_id!r}",
                status_code=response.status_code,
            )

        polymer_entity_ids = _polymer_entity_ids(payload)
        _validate_requested_entry_scope(parsed_id, payload)
        polymer_entity_payloads: list[dict[str, Any]] = []
        polymer_entity_urls: list[str] = []
        for entity_id in polymer_entity_ids:
            entity_url = (
                f"{self._base_url}{self.POLYMER_ENTITY_PATH}/{pdb_id}/{entity_id}"
            )
            entity_payload, entity_response = await self._get_json_object(
                entity_url,
                pdb_id,
                opts,
                resource_name=f"polymer entity {entity_id}",
            )
            _validate_polymer_entity_identity(
                entity_payload,
                pdb_id=pdb_id,
                entity_id=entity_id,
                status_code=entity_response.status_code,
            )
            polymer_entity_payloads.append(entity_payload)
            polymer_entity_urls.append(entity_url)
            bytes_received += len(entity_response.content or b"")

        assembly_payload: dict[str, Any] | None = None
        assembly_url: str | None = None
        scoped_identity = parse_rcsb_external_id(
            parsed_id.scope or parsed_id.cache_key()
        )
        requested_assembly = (
            scoped_identity.get("assembly_id") if scoped_identity else None
        )
        if requested_assembly:
            assembly_url = (
                f"{self._base_url}{self.ASSEMBLY_PATH}/{pdb_id}/{requested_assembly}"
            )
            assembly_payload, assembly_response = await self._get_json_object(
                assembly_url,
                pdb_id,
                opts,
                resource_name=f"assembly {requested_assembly}",
            )
            _validate_assembly_identity(
                assembly_payload,
                pdb_id=pdb_id,
                assembly_id=requested_assembly,
                status_code=assembly_response.status_code,
            )
            bytes_received += len(assembly_response.content or b"")

        metadata = _extract_entry_metadata(payload, polymer_entity_payloads)
        _validate_requested_scope(parsed_id, metadata)
        if assembly_payload is not None:
            _validate_requested_assembly_composition(
                parsed_id,
                metadata,
                assembly_payload,
                status_code=response.status_code,
            )
        if parsed_id.chain:
            metadata["requested_chain"] = parsed_id.chain
        provider_url = f"{self.STRUCTURE_PAGE_URL}/{pdb_id}"
        metadata["provider_url"] = provider_url
        metadata["source"] = {
            "provider": self.provider_id,
            "database": "Protein Data Bank",
            "api": "RCSB PDB Data API",
            "api_url": entry_url,
            "polymer_entity_urls": polymer_entity_urls,
            "assembly_urls": [assembly_url] if assembly_url else [],
        }
        metadata["structure_file_urls"] = {
            "mmcif": f"{self.FILE_DOWNLOAD_URL}/{pdb_id}.cif",
            "pdb": f"{self.FILE_DOWNLOAD_URL}/{pdb_id}.pdb",
            "bcif": f"{self.FILE_DOWNLOAD_URL}/{pdb_id}.bcif",
        }
        metadata["usage_terms"] = {
            "license": self.LICENSE,
            "policy_url": self.POLICY_URL,
        }
        metadata["attribution"] = f"{self.ATTRIBUTION}; PDB ID {pdb_id}"

        return FetchResult(
            parsed_id=parsed_id,
            metadata=metadata,
            external_url=provider_url,
            version_identifier=metadata.get("revision_version")
            or metadata.get("revision_date"),
            etag=response.headers.get("ETag"),
            license=self.LICENSE,
            attribution=metadata["attribution"],
            status_code=response.status_code,
            bytes_received=bytes_received,
        )

    async def _get_json_object(
        self,
        url: str,
        pdb_id: str,
        opts: FetchOptions,
        *,
        resource_name: str,
    ) -> tuple[dict[str, Any], httpx.Response]:
        if self._client is None:
            raise RuntimeError(
                "RCSBProvider used without an httpx.AsyncClient - service layer must inject."
            )
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
                f"RCSB {resource_name} fetch for {pdb_id} timed out after {opts.total_timeout_s}s"
            ) from exc
        except (httpx.HTTPError, OSError) as exc:
            raise ProviderHttpError(
                f"RCSB {resource_name} network error for {pdb_id}: {exc.__class__.__name__}"
            ) from exc

        if response.status_code == 429:
            retry_after = _parse_retry_after(response.headers.get("Retry-After"))
            raise ProviderRateLimitError(
                f"RCSB rate-limited {resource_name} fetch for {pdb_id}",
                retry_after_s=retry_after,
            )
        if response.status_code == 404 and resource_name == "entry":
            raise RCSBEntryNotFound(
                f"RCSB returned HTTP 404 for entry {pdb_id}",
                status_code=response.status_code,
            )
        if response.status_code == 404:
            raise ProviderContractError(
                f"RCSB returned HTTP 404 for referenced {resource_name} {pdb_id}",
                status_code=502,
            )
        if response.status_code >= 400:
            raise ProviderHttpError(
                f"RCSB returned HTTP {response.status_code} for {resource_name} {pdb_id}",
                status_code=response.status_code,
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderContractError(
                f"RCSB returned malformed JSON for {resource_name} {pdb_id}",
                status_code=response.status_code,
            ) from exc

        if not isinstance(payload, dict):
            raise ProviderContractError(
                f"RCSB response for {resource_name} {pdb_id} was JSON but "
                f"not an object (got {type(payload).__name__})",
                status_code=response.status_code,
            )
        return payload, response

    async def resolve_xrefs(
        self,
        parsed_id: ParsedId,
        target_provider: str | None = None,
    ) -> list[Xref]:
        """RCSB entry metadata does not populate substrate xrefs in ."""
        return []

    def declared_capabilities(self) -> list[Capability]:
        return [
            Capability.EXTERNAL_FETCH_ANNOTATION,
            Capability.EXTERNAL_FETCH_HOMOLOGY,
        ]


def _parse_retry_after(header: str | None) -> float | None:
    if not header:
        return None
    try:
        return float(header)
    except ValueError:
        return None


def _extract_entry_metadata(
    payload: dict[str, Any],
    polymer_entity_payloads: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Normalize RCSB entry JSON into the candidate shape  consumes."""
    pdb_id = (_str_or_none(payload.get("rcsb_id")) or "").upper() or None
    identifiers = _dict(payload.get("rcsb_entry_container_identifiers"))
    accession = _dict(payload.get("rcsb_accession_info"))
    entry_info = _dict(payload.get("rcsb_entry_info"))
    struct = _dict(payload.get("struct"))
    citation = _dict(payload.get("rcsb_primary_citation"))

    experimental_methods = _experimental_methods(payload.get("exptl"))
    resolutions = _numbers(entry_info.get("resolution_combined"))
    polymer_entity_ids = _polymer_entity_ids(payload)
    if polymer_entity_payloads is None:
        polymer_entity_payloads = _legacy_embedded_polymer_entities(payload)
    chains = _extract_chain_metadata(polymer_entity_payloads)
    chain_ids = sorted(
        {
            chain_id
            for chain in chains
            for chain_id in chain.get("auth_asym_ids", []) + chain.get("asym_ids", [])
            if isinstance(chain_id, str)
        }
    )

    revision_version = _format_revision_version(accession)
    primary_citation = _primary_citation(citation)

    return {
        "pdb_id": pdb_id,
        "title": _str_or_none(struct.get("title")),
        "description": _entry_description(struct, chains),
        "experimental_method": (
            experimental_methods[0] if experimental_methods else None
        ),
        "experimental_methods": experimental_methods,
        "resolution": resolutions[0] if resolutions else None,
        "resolution_combined": resolutions,
        "chain_count": len(chain_ids),
        "chain_ids": chain_ids,
        "chains": chains,
        "polymer_entity_ids": polymer_entity_ids,
        "assembly_ids": _strings(identifiers.get("assembly_ids")),
        "organism": _first_organism(chains),
        "deposition_date": _str_or_none(accession.get("deposit_date")),
        "initial_release_date": _str_or_none(accession.get("initial_release_date")),
        "revision_date": _str_or_none(accession.get("revision_date")),
        "revision_version": revision_version,
        "authors": _authors(payload.get("audit_author")),
        "primary_citation": primary_citation,
        "citation": primary_citation.get("doi") if primary_citation else None,
    }


def _polymer_entity_ids(payload: dict[str, Any]) -> list[str]:
    identifiers = _dict(payload.get("rcsb_entry_container_identifiers"))
    return _strings(identifiers.get("polymer_entity_ids"))


def rcsb_provider_identity_key(
    pdb_id: str,
    *,
    pdb_entity_id: str | None = None,
    label_asym_ids: tuple[str, ...] = (),
    auth_asym_ids: tuple[str, ...] = (),
    assembly_id: str | None = None,
) -> str:
    """Canonical provider identity for RCSB resources.

    This is the persistence/cache grammar shared by `/external/fetch`,
    `/external/structure/bytes`, and renderer reconciliation.
    """
    parts = [f"RCSB:{pdb_id.upper()}:ENTRY"]
    if assembly_id:
        parts.extend(["ASSEMBLY", assembly_id.upper()])
    if pdb_entity_id:
        parts.extend(["ENTITY", pdb_entity_id.upper()])
    if label_asym_ids:
        parts.extend(["LABEL_ASYM", ",".join(_canonical_scope_tokens(label_asym_ids))])
    if auth_asym_ids:
        parts.extend(["AUTH_ASYM", ",".join(_canonical_scope_tokens(auth_asym_ids))])
    return ":".join(parts)


def parse_rcsb_external_id(raw: str) -> dict[str, Any] | None:
    """Parse either legacy PDB ids or structured RCSB provider identities."""
    if not raw:
        return None
    stripped = raw.strip()
    legacy = _PDB_ID_PATTERN.fullmatch(stripped)
    if legacy is not None:
        pdb_id, chain, entity = legacy.groups()
        try:
            auth_asym_ids = (
                tuple(_canonical_scope_tokens(tuple(chain.split(",")), strict=True))
                if chain
                else ()
            )
        except ValueError:
            return None
        return {
            "pdb_id": pdb_id.upper(),
            "pdb_entity_id": entity.upper() if entity else None,
            "label_asym_ids": (),
            "auth_asym_ids": auth_asym_ids,
            "assembly_id": None,
            "provider_identity_key": rcsb_provider_identity_key(
                pdb_id.upper(),
                pdb_entity_id=entity.upper() if entity else None,
                auth_asym_ids=auth_asym_ids,
            ),
        }

    parts = stripped.split(":")
    if len(parts) < 3 or parts[0].upper() != "RCSB" or parts[2].upper() != "ENTRY":
        return None
    pdb_id = parts[1].upper()
    if not re.fullmatch(r"[0-9][A-Z0-9]{3}", pdb_id):
        return None
    scoped: dict[str, Any] = {
        "pdb_id": pdb_id,
        "pdb_entity_id": None,
        "label_asym_ids": (),
        "auth_asym_ids": (),
        "assembly_id": None,
    }
    seen_keys: set[str] = set()
    index = 3
    while index < len(parts):
        if index + 1 >= len(parts):
            return None
        key = parts[index].upper()
        value = parts[index + 1]
        if key in seen_keys:
            return None
        seen_keys.add(key)
        if key == "ASSEMBLY":
            scoped["assembly_id"] = _canonical_scope_token(value, uppercase=True)
        elif key == "ENTITY":
            scoped["pdb_entity_id"] = _canonical_scope_token(value, uppercase=True)
        elif key == "LABEL_ASYM":
            try:
                scoped["label_asym_ids"] = tuple(
                    _canonical_scope_tokens(tuple(value.split(",")), strict=True)
                )
            except ValueError:
                return None
        elif key == "AUTH_ASYM":
            try:
                scoped["auth_asym_ids"] = tuple(
                    _canonical_scope_tokens(tuple(value.split(",")), strict=True)
                )
            except ValueError:
                return None
        else:
            return None
        if scoped.get(
            {
                "ASSEMBLY": "assembly_id",
                "ENTITY": "pdb_entity_id",
                "LABEL_ASYM": "label_asym_ids",
                "AUTH_ASYM": "auth_asym_ids",
            }[key]
        ) in {None, ()}:
            return None
        index += 2
    scoped["provider_identity_key"] = rcsb_provider_identity_key(
        pdb_id,
        pdb_entity_id=scoped["pdb_entity_id"],
        label_asym_ids=scoped["label_asym_ids"],
        auth_asym_ids=scoped["auth_asym_ids"],
        assembly_id=scoped["assembly_id"],
    )
    return scoped


def _canonical_scope_tokens(
    values: tuple[str, ...],
    *,
    strict: bool = False,
) -> tuple[str, ...]:
    tokens = [_canonical_scope_token(value) for value in values]
    if strict and any(token is None for token in tokens):
        raise ValueError("invalid RCSB scope token")
    normalized = [token for token in tokens if token]
    if strict and len(set(normalized)) != len(normalized):
        raise ValueError("duplicate RCSB scope token")
    return tuple(sorted(dict.fromkeys(normalized)))


def _canonical_scope_token(value: str, *, uppercase: bool = False) -> str | None:
    token = str(value).strip()
    if not token or ":" in token or "," in token or any(ch.isspace() for ch in token):
        return None
    return token.upper() if uppercase else token


def _validate_polymer_entity_identity(
    payload: dict[str, Any],
    *,
    pdb_id: str,
    entity_id: str,
    status_code: int,
) -> None:
    identifiers = _dict(payload.get("rcsb_polymer_entity_container_identifiers"))
    response_entry_id = _str_or_none(identifiers.get("entry_id"))
    response_entity_id = _str_or_none(identifiers.get("entity_id"))
    if not response_entry_id:
        raise ProviderContractError(
            f"RCSB polymer entity response omitted entry_id for requested {pdb_id!r}",
            status_code=status_code,
        )
    if not response_entity_id:
        raise ProviderContractError(
            f"RCSB polymer entity response omitted entity_id for requested {entity_id!r}",
            status_code=status_code,
        )
    if response_entry_id and response_entry_id.upper() != pdb_id:
        raise ProviderContractError(
            f"RCSB returned polymer entity for entry {response_entry_id!r} but request was for {pdb_id!r}",
            status_code=status_code,
        )
    if response_entity_id and response_entity_id != entity_id:
        raise ProviderContractError(
            f"RCSB returned polymer entity {response_entity_id!r} but request was for {entity_id!r}",
            status_code=status_code,
        )


def _validate_assembly_identity(
    payload: dict[str, Any],
    *,
    pdb_id: str,
    assembly_id: str,
    status_code: int,
) -> None:
    identifiers = _dict(payload.get("rcsb_assembly_container_identifiers"))
    response_entry_id = _str_or_none(identifiers.get("entry_id"))
    response_assembly_id = _str_or_none(identifiers.get("assembly_id"))
    if not response_entry_id:
        raise ProviderContractError(
            f"RCSB assembly response omitted entry_id for requested {pdb_id!r}",
            status_code=status_code,
        )
    if not response_assembly_id:
        raise ProviderContractError(
            f"RCSB assembly response omitted assembly_id for requested {assembly_id!r}",
            status_code=status_code,
        )
    if response_entry_id.upper() != pdb_id:
        raise ProviderContractError(
            f"RCSB returned assembly for entry {response_entry_id!r} but request was for {pdb_id!r}",
            status_code=status_code,
        )
    if response_assembly_id != assembly_id:
        raise ProviderContractError(
            f"RCSB returned assembly {response_assembly_id!r} but request was for {assembly_id!r}",
            status_code=status_code,
        )


def _validate_requested_entry_scope(
    parsed_id: ParsedId, payload: dict[str, Any]
) -> None:
    scoped = parse_rcsb_external_id(parsed_id.scope or parsed_id.cache_key())
    if scoped is None:
        raise ProviderHttpError(
            f"invalid RCSB provider identity {parsed_id.cache_key()!r}",
            status_code=422,
        )
    requested_entity = scoped.get("pdb_entity_id")
    if requested_entity and requested_entity not in set(_polymer_entity_ids(payload)):
        raise ProviderHttpError(
            f"RCSB entity {requested_entity!r} is not present in {scoped['pdb_id']}",
            status_code=422,
        )
    requested_assembly = scoped.get("assembly_id")
    assembly_ids = set(
        _strings(
            _dict(payload.get("rcsb_entry_container_identifiers")).get("assembly_ids")
        )
    )
    if requested_assembly and requested_assembly not in assembly_ids:
        raise ProviderHttpError(
            f"RCSB assembly {requested_assembly!r} is not present in {scoped['pdb_id']}",
            status_code=422,
        )


def _validate_requested_assembly_composition(
    parsed_id: ParsedId,
    metadata: dict[str, Any],
    assembly_payload: dict[str, Any],
    *,
    status_code: int,
) -> None:
    scoped = parse_rcsb_external_id(parsed_id.scope or parsed_id.cache_key())
    if scoped is None:
        raise ProviderHttpError(
            f"invalid RCSB provider identity {parsed_id.cache_key()!r}",
            status_code=422,
        )
    requested_entity = scoped.get("pdb_entity_id")
    requested_label = tuple(scoped.get("label_asym_ids") or ())
    requested_auth = tuple(scoped.get("auth_asym_ids") or ())
    requested_assembly = scoped.get("assembly_id")
    if not requested_assembly or (
        not requested_entity and not requested_label and not requested_auth
    ):
        return

    assembly_label_ids = _assembly_label_asym_ids(assembly_payload)
    if not assembly_label_ids:
        raise ProviderContractError(
            f"RCSB assembly {requested_assembly!r} did not expose chain composition for {scoped['pdb_id']}",
            status_code=status_code,
        )

    chains = [
        chain for chain in metadata.get("chains") or [] if isinstance(chain, dict)
    ]
    scoped_chains = [
        chain
        for chain in chains
        if not requested_entity or str(chain.get("entity_id")) == requested_entity
    ]
    requested_labels = set(requested_label)
    if requested_auth:
        for chain in scoped_chains:
            pairs = [
                pair
                for pair in chain.get("chain_id_pairs") or []
                if isinstance(pair, dict)
            ]
            for pair in pairs:
                auth = _str_or_none(pair.get("auth_asym_id"))
                label = _str_or_none(pair.get("label_asym_id"))
                if auth in requested_auth and label:
                    requested_labels.add(label)
    if requested_entity and not requested_label and not requested_auth:
        for chain in scoped_chains:
            requested_labels.update(_strings(chain.get("asym_ids")))

    missing = sorted(
        label for label in requested_labels if label not in assembly_label_ids
    )
    if missing:
        raise ProviderHttpError(
            f"RCSB assembly {requested_assembly!r} does not contain label asym id(s) {missing!r}",
            status_code=422,
        )


def _parsed_requested_scope(parsed_id: ParsedId) -> dict[str, Any]:
    scoped = parse_rcsb_external_id(parsed_id.scope or parsed_id.cache_key())
    if scoped is None:
        raise ProviderHttpError(
            f"invalid RCSB provider identity {parsed_id.cache_key()!r}",
            status_code=422,
        )
    return scoped


def _requested_scope_has_selector(
    requested_entity: Any,
    requested_label: tuple[str, ...],
    requested_auth: tuple[str, ...],
    requested_assembly: Any,
) -> bool:
    return bool(
        requested_entity or requested_label or requested_auth or requested_assembly
    )


def _metadata_chain_scope_index(
    metadata: dict[str, Any], requested_entity: Any
) -> tuple[set[str], set[str], set[str], set[tuple[str, str]]]:
    chains = [
        chain for chain in metadata.get("chains") or [] if isinstance(chain, dict)
    ]
    entity_ids = {
        str(chain.get("entity_id")) for chain in chains if chain.get("entity_id")
    }
    scoped_chains = [
        chain
        for chain in chains
        if not requested_entity or str(chain.get("entity_id")) == requested_entity
    ]
    label_ids = {
        token for chain in scoped_chains for token in _strings(chain.get("asym_ids"))
    }
    auth_ids = {
        token
        for chain in scoped_chains
        for token in _strings(chain.get("auth_asym_ids"))
    }
    chain_pairs = {
        (label, auth)
        for chain in scoped_chains
        for pair in chain.get("chain_id_pairs") or []
        if isinstance(pair, dict)
        for label in [_str_or_none(pair.get("label_asym_id"))]
        for auth in [_str_or_none(pair.get("auth_asym_id"))]
        if label and auth
    }
    return entity_ids, label_ids, auth_ids, chain_pairs


def _reject_missing_scope_tokens(
    requested: tuple[str, ...], present: set[str], pdb_id: str, kind: str
) -> None:
    missing = [token for token in requested if token not in present]
    if missing:
        raise ProviderHttpError(
            f"RCSB {kind} {missing!r} are not present in {pdb_id}",
            status_code=422,
        )


def _reject_invalid_label_auth_pairs(
    requested_label: tuple[str, ...],
    requested_auth: tuple[str, ...],
    chain_pairs: set[tuple[str, str]],
    pdb_id: str,
) -> None:
    if not (requested_label and requested_auth):
        return
    matched_pairs = {
        (label, auth)
        for label, auth in chain_pairs
        if label in requested_label and auth in requested_auth
    }
    if {label for label, _auth in matched_pairs} != set(requested_label) or {
        auth for _label, auth in matched_pairs
    } != set(requested_auth):
        raise ProviderHttpError(
            f"RCSB label/auth asym selector is not a valid chain pairing in {pdb_id}",
            status_code=422,
        )


def _validate_requested_scope(parsed_id: ParsedId, metadata: dict[str, Any]) -> None:
    scoped = _parsed_requested_scope(parsed_id)
    requested_entity = scoped.get("pdb_entity_id")
    requested_label = tuple(scoped.get("label_asym_ids") or ())
    requested_auth = tuple(scoped.get("auth_asym_ids") or ())
    requested_assembly = scoped.get("assembly_id")
    if not _requested_scope_has_selector(
        requested_entity, requested_label, requested_auth, requested_assembly
    ):
        return

    entity_ids, label_ids, auth_ids, chain_pairs = _metadata_chain_scope_index(
        metadata, requested_entity
    )
    if requested_entity and requested_entity not in entity_ids:
        raise ProviderHttpError(
            f"RCSB entity {requested_entity!r} is not present in {scoped['pdb_id']}",
            status_code=422,
        )
    _reject_missing_scope_tokens(
        requested_label, label_ids, scoped["pdb_id"], "label asym id(s)"
    )
    _reject_missing_scope_tokens(
        requested_auth, auth_ids, scoped["pdb_id"], "auth asym id(s)"
    )
    _reject_invalid_label_auth_pairs(
        requested_label, requested_auth, chain_pairs, scoped["pdb_id"]
    )
    assembly_ids = set(_strings(metadata.get("assembly_ids")))
    if requested_assembly and requested_assembly not in assembly_ids:
        raise ProviderHttpError(
            f"RCSB assembly {requested_assembly!r} is not present in {scoped['pdb_id']}",
            status_code=422,
        )


def _assembly_label_asym_ids(payload: dict[str, Any]) -> set[str]:
    labels: set[str] = set()
    rows = payload.get("pdbx_struct_assembly_gen")
    if not isinstance(rows, list):
        return labels
    for row in rows:
        if not isinstance(row, dict):
            continue
        values = row.get("asym_id_list")
        if isinstance(values, str):
            labels.update(_strings(values.split(",")))
        elif isinstance(values, list):
            labels.update(_strings(values))
    return labels


def _legacy_embedded_polymer_entities(payload: dict[str, Any]) -> list[dict[str, Any]]:
    entities = payload.get("polymer_entities")
    if not isinstance(entities, list):
        return []
    return [entity for entity in entities if isinstance(entity, dict)]


def _extract_chain_metadata(entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for entity in entities:
        identifiers = _dict(entity.get("rcsb_polymer_entity_container_identifiers"))
        polymer_entity = _dict(entity.get("rcsb_polymer_entity"))
        polymer = _dict(entity.get("entity_poly"))
        organisms = _organisms(entity.get("rcsb_entity_source_organism"))
        sequence = _str_or_none(polymer.get("pdbx_seq_one_letter_code_can"))
        asym_ids = _strings(identifiers.get("asym_ids"))
        auth_asym_ids = _strings(identifiers.get("auth_asym_ids"))
        if sequence:
            sequence_length = len("".join(sequence.split()))
        else:
            sequence_length = _int_or_none(polymer.get("rcsb_sample_sequence_length"))

        out.append(
            {
                "entity_id": _str_or_none(identifiers.get("entity_id")),
                "description": _str_or_none(polymer_entity.get("pdbx_description")),
                "polymer_type": _str_or_none(
                    polymer.get("type") or polymer.get("rcsb_entity_polymer_type")
                ),
                "asym_ids": asym_ids,
                "auth_asym_ids": auth_asym_ids,
                "chain_id_pairs": [
                    {"label_asym_id": label, "auth_asym_id": auth}
                    for label, auth in zip(asym_ids, auth_asym_ids, strict=False)
                ],
                "organism": organisms[0] if organisms else None,
                "source_organisms": organisms,
                "sequence_length": sequence_length,
                "uniprot_ids": _strings(identifiers.get("uniprot_ids")),
                "reference_sequence_identifiers": _reference_sequence_identifiers(
                    identifiers.get("reference_sequence_identifiers")
                ),
            }
        )
    return out


def _reference_sequence_identifiers(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        database_name = _str_or_none(item.get("database_name"))
        database_accession = _str_or_none(item.get("database_accession"))
        if database_name and database_accession:
            out.append(
                {
                    "database_name": database_name,
                    "database_accession": database_accession,
                }
            )
    return out


def _experimental_methods(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    methods: list[str] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        method = _str_or_none(item.get("method"))
        if method and method not in methods:
            methods.append(method)
    return methods


def _organisms(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    organisms: list[str] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        organism = _str_or_none(
            item.get("ncbi_scientific_name") or item.get("scientific_name")
        )
        if organism and organism not in organisms:
            organisms.append(organism)
    return organisms


def _authors(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    authors: list[str] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = _str_or_none(item.get("name"))
        if name:
            authors.append(name)
    return authors


def _primary_citation(raw: dict[str, Any]) -> dict[str, Any]:
    if not raw:
        return {}
    return {
        "title": _str_or_none(raw.get("title")),
        "doi": _str_or_none(raw.get("pdbx_database_id_doi")),
        "pubmed_id": _str_or_none(raw.get("pdbx_database_id_pub_med")),
        "year": _int_or_none(raw.get("year")),
    }


def _entry_description(
    struct: dict[str, Any], chains: list[dict[str, Any]]
) -> str | None:
    title = _str_or_none(struct.get("title"))
    if title:
        return title
    for chain in chains:
        description = chain.get("description")
        if isinstance(description, str) and description:
            return description
    return None


def _first_organism(chains: list[dict[str, Any]]) -> str | None:
    for chain in chains:
        organism = chain.get("organism")
        if isinstance(organism, str) and organism:
            return organism
    return None


def _format_revision_version(accession: dict[str, Any]) -> str | None:
    major = _int_or_none(accession.get("major_revision"))
    minor = _int_or_none(accession.get("minor_revision"))
    if major is None or minor is None:
        return None
    return f"{major}.{minor}"


def _dict(raw: Any) -> dict[str, Any]:
    return raw if isinstance(raw, dict) else {}


def _strings(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [str(item) for item in raw if item is not None and str(item)]


def _numbers(raw: Any) -> list[float]:
    if not isinstance(raw, list):
        return []
    out: list[float] = []
    for item in raw:
        try:
            out.append(float(item))
        except (TypeError, ValueError):
            continue
    return out


def _str_or_none(raw: Any) -> str | None:
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def _int_or_none(raw: Any) -> int | None:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None
