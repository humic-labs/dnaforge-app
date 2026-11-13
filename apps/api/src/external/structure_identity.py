"""Structure-format identity + validation machinery for the external substrate.

Extracted from `service.py` . This is provider-FORMAT knowledge — how
to canonicalize a structure request into a provider identity, map it to a
download URL, and validate that returned mmCIF/PDB/CIF bytes are actually the
requested structure. It has no business in the provider-agnostic orchestration
class; the service composes these pure helpers.

Pure functions only (no `self`, no I/O): they parse/validate bytes and strings,
raising `ProviderContractError` on a deterministic provider contract violation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .afdb import ATTRIBUTION as AFDB_ATTRIBUTION
from .afdb import LICENSE as AFDB_LICENSE
from .contract import ProviderContractError, ProviderHttpError
from .providers.rcsb import (
    RCSBProvider,
    parse_rcsb_external_id,
    rcsb_provider_identity_key,
)


@dataclass(frozen=True)
class CanonicalStructureIdentity:
    provider: str
    provider_identity_key: str
    pdb_id: str | None = None
    pdb_entity_id: str | None = None
    label_asym_ids: tuple[str, ...] = ()
    auth_asym_ids: tuple[str, ...] = ()
    assembly_id: str | None = None
    accession: str | None = None
    fragment: str | None = None
    version: str | None = None
    model_id: str | None = None


def _validate_structure_bytes_content(
    content: bytes,
    *,
    format: str,
    content_type: str | None,
    provider: str,
    identity: str,
    canonical_identity: CanonicalStructureIdentity,
    status_code: int,
) -> None:
    if not content:
        raise ProviderContractError(
            f"{provider} returned an empty {format} structure body for {identity}",
            status_code=status_code,
        )

    prefix = content[:65536].decode("utf-8", errors="ignore")
    stripped = prefix.lstrip("\ufeff\r\n\t ")
    lower_type = (content_type or "").lower()
    lower_prefix = stripped[:1024].lower()
    if "text/html" in lower_type or lower_prefix.startswith(
        ("<!doctype html", "<html")
    ):
        raise ProviderContractError(
            f"{provider} returned HTML instead of {format} structure bytes for {identity}",
            status_code=status_code,
        )

    if format == "mmcif":
        if b"data_" not in content:
            raise ProviderContractError(
                f"{provider} returned a non-mmCIF body for {identity}",
                status_code=status_code,
            )
        _validate_mmcif_identity(
            content,
            provider=provider,
            identity=identity,
            canonical_identity=canonical_identity,
            status_code=status_code,
        )
        return

    if format == "pdb":
        pdb_markers = (
            "HEADER",
            "TITLE ",
            "ATOM  ",
            "HETATM",
            "MODEL ",
            "CRYST1",
            "REMARK",
        )
        if not any(marker in prefix for marker in pdb_markers):
            raise ProviderContractError(
                f"{provider} returned a non-PDB body for {identity}",
                status_code=status_code,
            )
        _validate_pdb_identity(
            prefix,
            provider=provider,
            identity=identity,
            canonical_identity=canonical_identity,
            status_code=status_code,
        )
        return

    raise ProviderContractError(
        f"unsupported structure byte format {format!r} for {identity}",
        status_code=422,
    )


def _validate_mmcif_identity(
    content: bytes,
    *,
    provider: str,
    identity: str,
    canonical_identity: CanonicalStructureIdentity,
    status_code: int,
) -> None:
    expected = _expected_structure_payload_id(canonical_identity)
    first_block = _mmcif_first_data_block(content)
    if first_block is None:
        raise ProviderContractError(
            f"{provider} returned mmCIF without a data block id for {identity}",
            status_code=status_code,
        )
    data_id, data_block = first_block
    if re.search(r"(?m)^\s*_atom_site\.", data_block) is None:
        raise ProviderContractError(
            f"{provider} returned mmCIF without atom_site data in block {data_id!r} for {identity}",
            status_code=status_code,
        )
    if expected is None:
        return
    if data_id.upper() != expected.upper():
        raise ProviderContractError(
            f"{provider} returned mmCIF data block {data_id!r} for requested {identity}",
            status_code=status_code,
        )


def _mmcif_first_data_block(content: bytes) -> tuple[str, str] | None:
    text = content.decode("utf-8", errors="ignore")
    matches = list(re.finditer(r"(?m)^\s*data_([^\s#]+)", text))
    if not matches:
        return None
    first = matches[0]
    block_end = matches[1].start() if len(matches) > 1 else len(text)
    return first.group(1).strip(), text[first.start() : block_end]


def _validate_pdb_identity(
    prefix: str,
    *,
    provider: str,
    identity: str,
    canonical_identity: CanonicalStructureIdentity,
    status_code: int,
) -> None:
    if canonical_identity.provider != "rcsb" or not canonical_identity.pdb_id:
        return
    for line in prefix.splitlines():
        if not line.startswith("HEADER"):
            continue
        tokens = line.split()
        if not tokens:
            break
        returned = tokens[-1].upper()
        if returned != canonical_identity.pdb_id.upper():
            raise ProviderContractError(
                f"{provider} returned PDB id {returned!r} for requested {identity}",
                status_code=status_code,
            )
        return
    raise ProviderContractError(
        f"{provider} returned PDB bytes without a HEADER id for {identity}",
        status_code=status_code,
    )


def _expected_structure_payload_id(identity: CanonicalStructureIdentity) -> str | None:
    if identity.provider == "rcsb" and identity.pdb_id:
        return identity.pdb_id
    if identity.provider == "alphafold" and identity.accession and identity.fragment:
        return f"AF-{identity.accession}-{identity.fragment}"
    return None


def _rcsb_identity_has_scope(identity: CanonicalStructureIdentity) -> bool:
    return bool(
        identity.pdb_entity_id
        or identity.label_asym_ids
        or identity.auth_asym_ids
        or identity.assembly_id
    )


_UNIPROT_ACCESSION_RE = re.compile(
    r"^(?:[A-Z][0-9][A-Z0-9]{3}[0-9]|"
    r"[A-Z][0-9][A-Z][A-Z0-9]{2}[0-9][A-Z][A-Z0-9]{2}[0-9])(?:-\d+)?$"
)


def _canonical_structure_identity(
    provider: str,
    external_id: str,
    *,
    pdb_id: str | None = None,
    pdb_entity_id: str | None = None,
    label_asym_ids: list[str] | None = None,
    auth_asym_ids: list[str] | None = None,
    assembly_id: str | None = None,
    accession: str | None = None,
    fragment: str | None = None,
    version: str | None = None,
    model_id: str | None = None,
) -> CanonicalStructureIdentity:
    if provider == "rcsb":
        scoped_rcsb = parse_rcsb_external_id(external_id)
        if scoped_rcsb is None:
            raise ProviderHttpError(
                f"invalid RCSB PDB id {external_id!r}", status_code=422
            )
        canonical_pdb_id = str(scoped_rcsb["pdb_id"])
        if pdb_id and pdb_id.strip().upper() != canonical_pdb_id:
            raise ProviderHttpError(
                f"RCSB pdb_id {pdb_id!r} does not match external_id {external_id!r}",
                status_code=422,
            )
        entity_id = _normalize_structure_scope_token(
            _merge_structure_scope_value(
                pdb_entity_id,
                scoped_rcsb.get("pdb_entity_id"),
                field="pdb_entity_id",
            ),
            field="pdb_entity_id",
        )
        label_ids = _normalize_structure_scope_tokens(
            _merge_structure_scope_list(
                label_asym_ids,
                scoped_rcsb.get("label_asym_ids"),
                field="label_asym_ids",
            ),
            field="label_asym_ids",
        )
        auth_ids = _normalize_structure_scope_tokens(
            _merge_structure_scope_list(
                auth_asym_ids,
                scoped_rcsb.get("auth_asym_ids"),
                field="auth_asym_ids",
            ),
            field="auth_asym_ids",
        )
        assembly = _normalize_structure_scope_token(
            _merge_structure_scope_value(
                assembly_id,
                scoped_rcsb.get("assembly_id"),
                field="assembly_id",
            ),
            field="assembly_id",
        )
        provider_identity_key = rcsb_provider_identity_key(
            canonical_pdb_id,
            pdb_entity_id=entity_id,
            label_asym_ids=label_ids,
            auth_asym_ids=auth_ids,
            assembly_id=assembly,
        )
        return CanonicalStructureIdentity(
            provider="rcsb",
            provider_identity_key=provider_identity_key,
            pdb_id=canonical_pdb_id,
            pdb_entity_id=entity_id,
            label_asym_ids=label_ids,
            auth_asym_ids=auth_ids,
            assembly_id=assembly,
        )
    if provider == "alphafold":
        scoped_af = _parse_scoped_alphafold_external_id(external_id)
        raw = external_id.strip().upper()
        scoped = re.fullmatch(
            r"AF:([A-Z0-9]+):(F[1-9][0-9]*):(LATEST|V[1-9][0-9]*)",
            raw,
        )
        if scoped:
            canonical = scoped.group(1)
            canonical_fragment = scoped.group(2)
            canonical_version = scoped.group(3)
        elif scoped_af:
            canonical = str(scoped_af["accession"])
            canonical_fragment = str(scoped_af["fragment"])
            canonical_version = str(scoped_af["version"])
        else:
            canonical = raw
            canonical_fragment = "F1"
            canonical_version = "LATEST"
        if not _UNIPROT_ACCESSION_RE.fullmatch(canonical):
            raise ProviderHttpError(
                f"invalid AlphaFold UniProt accession {external_id!r}",
                status_code=422,
            )
        if accession and accession.strip().upper() != canonical:
            raise ProviderHttpError(
                f"AlphaFold accession {accession!r} does not match external_id {external_id!r}",
                status_code=422,
            )
        if fragment and fragment.strip().upper() != canonical_fragment:
            raise ProviderHttpError(
                f"AlphaFold fragment {fragment!r} does not match external_id {external_id!r}",
                status_code=422,
            )
        explicit_version = version.strip().upper() if version else None
        if explicit_version and not re.fullmatch(
            r"LATEST|V[1-9][0-9]*", explicit_version
        ):
            raise ProviderHttpError(
                f"invalid AlphaFold version {version!r}",
                status_code=422,
            )
        if (
            explicit_version
            and canonical_version != "LATEST"
            and explicit_version != canonical_version
        ):
            raise ProviderHttpError(
                f"AlphaFold version {version!r} does not match external_id {external_id!r}",
                status_code=422,
            )
        if explicit_version and canonical_version == "LATEST":
            canonical_version = explicit_version
        normalized_model_id = _normalize_alphafold_model_id(
            _merge_structure_scope_value(
                model_id,
                scoped_af.get("model_id") if scoped_af else None,
                field="model_id",
            )
        )
        if normalized_model_id:
            model_accession, model_fragment, model_version = _parse_alphafold_model_id(
                normalized_model_id
            )
            if model_accession != canonical or model_fragment != canonical_fragment:
                raise ProviderHttpError(
                    f"AlphaFold model_id {model_id!r} does not match external_id {external_id!r}",
                    status_code=422,
                )
            if canonical_version == "LATEST":
                canonical_version = model_version
            elif canonical_version != model_version:
                raise ProviderHttpError(
                    f"AlphaFold model_id {model_id!r} does not match external_id {external_id!r}",
                    status_code=422,
                )
        elif canonical_version != "LATEST":
            normalized_model_id = (
                f"AF-{canonical}-{canonical_fragment}-model_v{canonical_version[1:]}"
            )
        return CanonicalStructureIdentity(
            provider="alphafold",
            provider_identity_key=_alphafold_provider_identity_key(
                canonical,
                fragment=canonical_fragment,
                version=canonical_version,
                model_id=normalized_model_id,
            ),
            accession=canonical,
            fragment=canonical_fragment,
            version=canonical_version,
            model_id=normalized_model_id,
        )
    raise ProviderHttpError(
        f"unsupported structure provider {provider!r}", status_code=422
    )


def _parse_scoped_alphafold_external_id(external_id: str) -> dict[str, Any] | None:
    parts = external_id.strip().split(":")
    if parts[0].upper() != "AF":
        return None
    if len(parts) < 4:
        raise ProviderHttpError(
            f"invalid scoped AlphaFold external_id {external_id!r}", status_code=422
        )
    accession = parts[1].upper()
    fragment = parts[2].upper()
    version = parts[3].upper()
    if not re.fullmatch(r"F[1-9][0-9]*", fragment) or not re.fullmatch(
        r"LATEST|V[1-9][0-9]*", version
    ):
        raise ProviderHttpError(
            f"invalid scoped AlphaFold external_id {external_id!r}", status_code=422
        )
    scoped: dict[str, Any] = {
        "accession": accession,
        "fragment": fragment,
        "version": version,
    }
    if len(parts) == 4:
        return scoped
    if len(parts) == 6 and parts[4].upper() == "MODEL" and parts[5].strip():
        scoped["model_id"] = parts[5]
        return scoped
    raise ProviderHttpError(
        f"invalid scoped AlphaFold external_id {external_id!r}", status_code=422
    )


def _merge_structure_scope_value(
    explicit: str | None, scoped: Any, *, field: str
) -> str | None:
    explicit_value = explicit.strip() if explicit is not None else None
    scoped_value = str(scoped).strip() if scoped is not None else None
    if (
        explicit_value
        and scoped_value
        and explicit_value.upper() != scoped_value.upper()
    ):
        raise ProviderHttpError(
            f"{field} {explicit!r} does not match scoped external_id value {scoped_value!r}",
            status_code=422,
        )
    return explicit_value or scoped_value or None


def _merge_structure_scope_list(
    explicit: list[str] | None, scoped: Any, *, field: str
) -> list[str]:
    explicit_values = [value for value in (explicit or []) if value.strip()]
    scoped_values = [str(value) for value in (scoped or []) if str(value).strip()]
    if explicit_values and scoped_values:
        explicit_normalized = _normalize_structure_scope_tokens(
            explicit_values, field=field
        )
        scoped_normalized = _normalize_structure_scope_tokens(
            scoped_values, field=field
        )
        if explicit_normalized != scoped_normalized:
            raise ProviderHttpError(
                f"{field} {explicit!r} does not match scoped external_id value {scoped_values!r}",
                status_code=422,
            )
    return explicit_values or scoped_values


def _alphafold_provider_identity_key(
    accession: str,
    *,
    fragment: str,
    version: str,
    model_id: str | None,
) -> str:
    base = f"AF:{accession}:{fragment}:{version}"
    return f"{base}:MODEL:{model_id}" if model_id else base


def _normalize_structure_scope_tokens(
    values: list[str], *, field: str
) -> tuple[str, ...]:
    normalized = [
        token
        for token in (
            _normalize_structure_scope_token(value, field=field, uppercase=False)
            for value in values
        )
        if token
    ]
    return tuple(sorted(dict.fromkeys(normalized)))


def _normalize_structure_scope_token(
    value: str | None, *, field: str, uppercase: bool = True
) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if ":" in normalized or "," in normalized or any(ch.isspace() for ch in normalized):
        raise ProviderHttpError(
            f"invalid {field} scope token {value!r}",
            status_code=422,
        )
    return normalized.upper() if uppercase else normalized


def _normalize_alphafold_model_id(value: str | None) -> str | None:
    token = _normalize_structure_scope_token(value, field="model_id", uppercase=False)
    if token is None:
        return None
    match = re.fullmatch(
        r"AF-([A-Za-z0-9]+)-F([1-9][0-9]*)-model_v([1-9][0-9]*)",
        token,
    )
    if not match:
        raise ProviderHttpError(
            f"invalid AlphaFold model_id {value!r}",
            status_code=422,
        )
    return f"AF-{match.group(1).upper()}-F{match.group(2)}-model_v{match.group(3)}"


def _parse_alphafold_model_id(model_id: str) -> tuple[str, str, str]:
    match = re.fullmatch(
        r"AF-([A-Z0-9]+)-(F[1-9][0-9]*)-model_v([1-9][0-9]*)",
        model_id,
    )
    if not match:
        raise ProviderHttpError(
            f"invalid AlphaFold model_id {model_id!r}",
            status_code=422,
        )
    return match.group(1), match.group(2), f"V{match.group(3)}"


def _validate_alphafold_cif_url(
    value: str,
    *,
    accession: str,
    fragment: str,
    latest_version: int | None,
) -> tuple[str, str, str]:
    match = re.fullmatch(
        r"https://alphafold\.ebi\.ac\.uk/files/(AF-([A-Za-z0-9]+)-(F[1-9][0-9]*)-model_v([1-9][0-9]*))\.cif",
        value,
    )
    if match is None:
        raise ProviderContractError(
            f"AlphaFold returned non-canonical CIF URL {value!r}",
            status_code=502,
        )
    model_id = (
        f"AF-{match.group(2).upper()}-{match.group(3).upper()}-model_v{match.group(4)}"
    )
    returned_accession, returned_fragment, returned_version = _parse_alphafold_model_id(
        model_id
    )
    if returned_accession != accession or returned_fragment != fragment:
        raise ProviderContractError(
            f"AlphaFold returned CIF URL {value!r} for the wrong model",
            status_code=502,
        )
    if latest_version is not None and returned_version != f"V{latest_version}":
        raise ProviderContractError(
            f"AlphaFold returned CIF URL {value!r} that conflicts with latestVersion {latest_version}",
            status_code=502,
        )
    return value, returned_version, model_id


def _structure_download_info(
    identity: CanonicalStructureIdentity, format: str
) -> tuple[str, str, str, str]:
    if identity.provider == "rcsb":
        if format not in {"mmcif", "pdb"}:
            raise ProviderHttpError(
                f"unsupported RCSB structure format {format!r}",
                status_code=422,
            )
        extension = "cif" if format == "mmcif" else "pdb"
        content_type = "chemical/x-mmcif" if format == "mmcif" else "chemical/x-pdb"
        canonical = identity.pdb_id or ""
        return (
            f"{RCSBProvider.FILE_DOWNLOAD_URL}/{canonical}.{extension}",
            content_type,
            RCSBProvider.LICENSE,
            f"{RCSBProvider.ATTRIBUTION}; PDB ID {canonical}",
        )
    if identity.provider == "alphafold":
        if format != "mmcif":
            raise ProviderHttpError(
                f"unsupported AlphaFold structure format {format!r}",
                status_code=422,
            )
        return (
            "",
            "chemical/x-mmcif",
            AFDB_LICENSE,
            AFDB_ATTRIBUTION,
        )
    raise ProviderHttpError(
        f"unsupported structure provider {identity.provider!r}", status_code=422
    )
