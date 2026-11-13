"""Managed-operation executor that copies a GFF3 file into the track store.

The file's bytes are stored unchanged under a version named by their SHA-256,
with a meta.json built from the request, and the track's current.json is
pointed at that version. Registering the same bytes under the same name twice
is a no-op that reports `alreadyPresent`.
"""

from __future__ import annotations

import threading
from pathlib import Path

from .operations import OperationExecutionError
from .track_registration_operation_contract import (
    RegisterTrackRequest,
    RegisterTrackResponse,
)
from .track_store import (
    META_SCHEMA,
    TrackStoreError,
    read_current,
    read_meta,
    track_directory,
    track_store_root,
    version_directory,
    version_id,
    write_current,
    write_version,
)
from .track_store.gff3_check import Gff3CheckError, check_gff3
from .track_store.layout import CURRENT_FILE, sha256_hex


def track_meta_for(request: RegisterTrackRequest, data: bytes, version: str) -> dict:
    file_name = f"{request.name}.gff3"
    license_block: dict = {"attribution": request.license_attribution}
    if request.license_spdx:
        license_block = {"spdx": request.license_spdx, **license_block}
    meta: dict = {
        "schema": META_SCHEMA,
        "track": request.name,
        "version": version,
        "assembly": {
            "accession": request.accession,
            "lengthBp": request.length_bp,
            "aliases": list(request.aliases),
        },
        "file": {
            "name": file_name,
            "format": "gff3",
            "sha256": sha256_hex(data),
            "byteLength": len(data),
        },
        "residency": {"kind": "managed"},
        "kinds": list(request.kinds),
        "label": request.label,
        "evidence": request.evidence,
        "license": license_block,
    }
    for key, value in (
        ("citation", request.citation),
        ("url", request.url),
        ("doi", request.doi),
        ("datasetVersion", request.dataset_version),
    ):
        if value:
            meta[key] = value
    source: dict = {
        "path": request.path,
        "sha256": sha256_hex(data),
        "bytes": len(data),
    }
    meta["provenance"] = {
        "producedBy": {"tool": request.produced_by or "registered from a file"},
        "inputs": [source],
    }
    return meta


def _name_taken_by_other(store_root: Path, request: RegisterTrackRequest) -> str | None:
    """The label of a different track already living under this name, or None."""
    track_dir = track_directory(store_root, request.accession, request.name)
    if not (track_dir / CURRENT_FILE).exists():
        return None
    try:
        live = read_meta(track_dir / read_current(track_dir)["version"])
    except TrackStoreError:
        return None
    same = live.get("label") == request.label and list(live.get("kinds", [])) == list(
        request.kinds
    )
    return None if same else str(live.get("label"))


async def execute_managed_track_registration(
    request: RegisterTrackRequest,
    _cancel: threading.Event,
) -> RegisterTrackResponse:
    if request.residency != "managed":
        raise OperationExecutionError(
            "TRACK_RESIDENCY_UNSUPPORTED",
            "Only managed tracks (copied into the store) can be registered in this "
            "version; linked and remote tracks are not available yet.",
        )
    try:
        data = Path(request.path).read_bytes()
    except OSError as exc:
        raise OperationExecutionError(
            "TRACK_FILE_MISSING",
            f"The track file could not be read: {exc.strerror or exc}",
        ) from exc
    try:
        summary = check_gff3(
            data,
            accession=request.accession,
            length_bp=request.length_bp,
            aliases=tuple(request.aliases),
        )
    except Gff3CheckError as exc:
        raise OperationExecutionError(
            "TRACK_FILE_INVALID",
            "Not a GFF3 file the track store can hold: " + "; ".join(exc.problems),
        ) from exc

    try:
        store_root = track_store_root()
        taken_by = (
            None
            if request.replace_existing
            else _name_taken_by_other(store_root, request)
        )
        if taken_by is not None:
            raise OperationExecutionError(
                "TRACK_NAME_TAKEN",
                f"'{request.name}' already holds '{taken_by}'. Choose another name, or pass "
                "replaceExisting to add a version under it.",
            )
        version = version_id(data)
        meta = track_meta_for(request, data, version)
        version_dir = version_directory(
            store_root, request.accession, request.name, version
        )
        already_present = version_dir.exists()
        if not already_present:
            write_version(store_root, meta, data)
        write_current(
            store_root,
            request.accession,
            request.name,
            version,
            reason=f"Registered from {Path(request.path).name}",
        )
    except TrackStoreError as exc:
        raise OperationExecutionError(
            "TRACK_STORE_" + exc.code.upper().replace("-", "_"), exc.message
        ) from exc
    except OSError as exc:
        raise OperationExecutionError(
            "TRACK_STORE_WRITE_FAILED", f"The track store could not be written: {exc}"
        ) from exc

    return RegisterTrackResponse(
        accession=request.accession,
        track=request.name,
        version=version,
        path=str(version_dir / meta["file"]["name"]),
        rows=summary.rows,
        alreadyPresent=already_present,
    )


__all__ = ["execute_managed_track_registration", "track_meta_for"]
