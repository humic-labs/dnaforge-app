"""Source-keyed, ready-only broad-interaction coverage floor.

The interactive renderer needs one immutable L15 coverage surface for the full
ordered assembly.  This module derives that small surface only from coverage
pyramid base layers that already exist for the exact BAM/index/reference
identity.  It never opens an alignment and never builds a missing base layer;
foreground cache misses are explicit ``not prepared`` results.

The statistic is intentionally named honestly.  The persisted base cache holds
fixed-base peak samples and the L15 artifact mean-pools those samples:
``fixed-base-peak-mean-v1``.  It is not a max-pooled pyramid.
"""

from __future__ import annotations

import hashlib
import json
import os
import struct
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import NotRequired, TypedDict

import numpy as np

from . import coverage_pyramid as cp
from .pileup import (
    _resolve_bam_path,
    _resolve_index_path,
    _resolve_reference_path,
)

CORRIDOR_FLOOR_CONTRACT = "coverage-corridor-floor.v1"
CORRIDOR_FLOOR_REQUEST_CONTRACT = "coverage-corridor-floor-request.v1"
CORRIDOR_FLOOR_ASSEMBLY_CONTRACT = "coverage-assembly-placement.v1"
CORRIDOR_FLOOR_STATISTIC = "fixed-base-peak-mean-v1"
CORRIDOR_FLOOR_LEVEL = 15
CORRIDOR_FLOOR_BIN_SIZE_BP = 1 << CORRIDOR_FLOOR_LEVEL


class CoverageCorridorFloorSegment(TypedDict):
    chrom: str
    start: int
    end: int
    globalStart: int


class CoverageCorridorFloorDepthScale(TypedDict):
    contract: str
    basisStatistic: str
    p50: float
    p90: float
    p95: float
    p99: float
    max: float
    scaleDepth: float


class CoverageCorridorFloorManifestSegment(TypedDict):
    chrom: str
    localStart: int
    localEnd: int
    globalStart: int
    globalEnd: int
    binSize: int
    count: int
    byteOffset: int
    byteLength: int
    sourceBaseBinSize: int
    checksumSha256: str
    complete: bool


class CoverageCorridorFloorByteLayout(TypedDict):
    framing: str
    dtype: str
    endian: str
    headerLengthPrefixBytes: int
    headerPaddedBytes: int
    dataOffset: int
    dataByteLength: int


class CoverageCorridorFloorManifest(TypedDict):
    contract: str
    requestFingerprint: str
    sourceIdentity: str
    orderedAssemblyFingerprint: str
    statistic: str
    level: int
    binSize: int
    complete: bool
    assemblyStart: int
    assemblyEnd: int
    segments: list[CoverageCorridorFloorManifestSegment]
    dataChecksumSha256: str
    byteLayout: CoverageCorridorFloorByteLayout
    depthScale: CoverageCorridorFloorDepthScale
    diagnostic: NotRequired[dict[str, int]]


@dataclass(frozen=True)
class CoverageCorridorFloorArtifact:
    manifest: CoverageCorridorFloorManifest
    payload: bytes


class CoverageCorridorFloorNotPreparedError(RuntimeError):
    """Raised when any exact source-keyed base cache is absent or invalid."""


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _segment_identity_text(
    contract: str, segments: list[CoverageCorridorFloorSegment]
) -> str:
    rows = [contract]
    for segment in segments:
        rows.append(
            "\0".join(
                [
                    segment["chrom"],
                    str(segment["start"]),
                    str(segment["end"]),
                    str(segment["globalStart"]),
                ]
            )
        )
    return "\n".join(rows)


def _file_generation_key(value: object, field: str) -> str:
    if not isinstance(value, Mapping):
        raise ValueError(f"source generation {field} must be an object")
    required_fields = ("canonicalPath", "size", "mtimeNs", "ctimeNs")
    missing = [name for name in required_fields if value.get(name) is None]
    if missing:
        raise ValueError(f"source generation {field} is missing {', '.join(missing)}")
    parts = [value.get(name) for name in (*required_fields, "device", "inode")]
    return "\0".join("" if part is None else str(part) for part in parts)


def _aligned_read_source_generation_key(
    value: Mapping[str, object] | None,
) -> str:
    if value is None:
        return ""
    if value.get("contract") != "aligned-read-source-generation.v1":
        raise ValueError("unsupported aligned-read source generation contract")

    reference = value.get("reference")
    reference_index = value.get("referenceIndex")
    if (reference is None) != (reference_index is None):
        raise ValueError(
            "source generation reference and referenceIndex must appear together"
        )
    return "\1".join(
        [
            "aligned-read-source-generation.v1",
            _file_generation_key(value.get("alignment"), "alignment"),
            _file_generation_key(value.get("index"), "index"),
            (
                _file_generation_key(reference, "reference")
                if reference is not None
                else ""
            ),
            (
                _file_generation_key(reference_index, "referenceIndex")
                if reference_index is not None
                else ""
            ),
        ]
    )


def coverage_corridor_floor_request_fingerprint(
    bam_path: str,
    segments: list[CoverageCorridorFloorSegment],
    *,
    index_path: str | None = None,
    reference_fasta: str | None = None,
    source_generation: Mapping[str, object] | None = None,
) -> str:
    """Fingerprint the exact request locators and ordered assembly placement.

    This is independently reproducible by the desktop client.  The separate
    opaque ``sourceIdentity`` below additionally binds current filesystem
    identities without exposing local paths in the response.
    """

    prefix = "\0".join(
        [
            CORRIDOR_FLOOR_REQUEST_CONTRACT,
            bam_path,
            index_path or "",
            reference_fasta or "",
            _aligned_read_source_generation_key(source_generation),
        ]
    )
    return _sha256_text(
        prefix
        + "\n"
        + _segment_identity_text(CORRIDOR_FLOOR_ASSEMBLY_CONTRACT, segments)
    )


def coverage_corridor_floor_assembly_fingerprint(
    segments: list[CoverageCorridorFloorSegment],
) -> str:
    return _sha256_text(
        _segment_identity_text(CORRIDOR_FLOOR_ASSEMBLY_CONTRACT, segments)
    )


def _validate_complete_ordered_assembly(
    segments: list[CoverageCorridorFloorSegment],
) -> int:
    if not segments:
        raise ValueError("corridor floor requires at least one assembly segment")
    expected_global_start = 0
    seen: set[str] = set()
    for index, segment in enumerate(segments):
        chrom = segment["chrom"]
        start = segment["start"]
        end = segment["end"]
        global_start = segment["globalStart"]
        if not chrom or chrom in seen:
            raise ValueError(
                f"assembly segment {index} has an empty or duplicate chromosome"
            )
        if start != 0 or end <= start:
            raise ValueError(
                f"assembly segment {chrom} must cover the complete chromosome [0,end)"
            )
        if global_start != expected_global_start:
            raise ValueError(
                f"assembly segment {chrom} starts at {global_start}, expected contiguous "
                f"globalStart {expected_global_start}"
            )
        seen.add(chrom)
        expected_global_start += end - start
    return expected_global_start


def _opaque_source_identity(
    resolved_bam: str,
    resolved_index: str | None,
    resolved_reference: str | None,
) -> str:
    try:
        signatures = [
            cp._local_path_signature(resolved_bam, "bam"),
            cp._local_path_signature(resolved_index, "index"),
            cp._local_path_signature(resolved_reference, "reference"),
        ]
    except OSError as exc:
        raise CoverageCorridorFloorNotPreparedError(
            f"coverage corridor floor source identity unavailable: {exc}"
        ) from exc
    return _sha256_text("\0".join([cp._CACHE_CONTRACT_TOKEN, *signatures]))


def _fixed_base_peak_mean(
    base: np.ndarray, chrom_len: int, start: int, end: int
) -> np.ndarray:
    """Mean-pool fixed-base peak samples onto the exact chrom-local L15 grid."""

    base_len = int(len(base))
    if base_len <= 0:
        raise CoverageCorridorFloorNotPreparedError("coverage base cache is empty")
    source_bin = max(1, -(-chrom_len // base_len))
    count = max(1, -(-(end - start) // CORRIDOR_FLOOR_BIN_SIZE_BP))
    out = np.zeros(count, dtype=np.float32)
    for index in range(count):
        lo_bp = start + index * CORRIDOR_FLOOR_BIN_SIZE_BP
        hi_bp = min(end, lo_bp + CORRIDOR_FLOOR_BIN_SIZE_BP)
        source_lo = max(0, min(base_len - 1, lo_bp // source_bin))
        source_hi = max(0, min(base_len - 1, (hi_bp - 1) // source_bin))
        out[index] = float(base[source_lo : source_hi + 1].mean())
    return out


def _depth_scale(bins: list[np.ndarray]) -> CoverageCorridorFloorDepthScale:
    values = np.concatenate(bins) if bins else np.zeros(1, dtype=np.float32)
    quantiles = np.percentile(values, [50, 90, 95, 99])
    maximum = float(np.max(values)) if values.size else 0.0
    p99 = float(quantiles[3])
    return {
        "contract": "coverage-depth-scale.v1",
        "basisStatistic": CORRIDOR_FLOOR_STATISTIC,
        "p50": float(quantiles[0]),
        "p90": float(quantiles[1]),
        "p95": float(quantiles[2]),
        "p99": p99,
        "max": maximum,
        "scaleDepth": max(1.0, p99),
    }


def _encode_artifact(
    manifest: CoverageCorridorFloorManifest, data: bytes
) -> CoverageCorridorFloorArtifact:
    for _ in range(4):
        header = json.dumps(manifest, separators=(",", ":"), sort_keys=True).encode(
            "utf-8"
        )
        padded_length = len(header) + ((-len(header)) % 4)
        data_offset = 4 + padded_length
        layout = manifest["byteLayout"]
        if (
            layout["headerPaddedBytes"] == padded_length
            and layout["dataOffset"] == data_offset
        ):
            break
        layout["headerPaddedBytes"] = padded_length
        layout["dataOffset"] = data_offset
    header = json.dumps(manifest, separators=(",", ":"), sort_keys=True).encode("utf-8")
    header += b" " * ((-len(header)) % 4)
    if manifest["byteLayout"]["dataOffset"] != 4 + len(header):
        raise RuntimeError("coverage corridor floor header offset did not converge")
    payload = struct.pack("<I", len(header)) + header + data
    return CoverageCorridorFloorArtifact(manifest=manifest, payload=payload)


def _load_persisted_artifact(
    path: Path,
    *,
    source_identity: str,
    request_fingerprint: str,
    assembly_fingerprint: str,
) -> CoverageCorridorFloorArtifact | None:
    try:
        payload = path.read_bytes()
        if len(payload) < 4:
            return None
        header_len = struct.unpack_from("<I", payload, 0)[0]
        data_offset = 4 + header_len
        if header_len <= 0 or header_len % 4 != 0 or data_offset > len(payload):
            return None
        manifest = json.loads(payload[4:data_offset].decode("utf-8"))
        data = payload[data_offset:]
        if (
            manifest.get("contract") != CORRIDOR_FLOOR_CONTRACT
            or manifest.get("sourceIdentity") != source_identity
            or manifest.get("requestFingerprint") != request_fingerprint
            or manifest.get("orderedAssemblyFingerprint") != assembly_fingerprint
            or manifest.get("statistic") != CORRIDOR_FLOOR_STATISTIC
            or manifest.get("level") != CORRIDOR_FLOOR_LEVEL
            or manifest.get("binSize") != CORRIDOR_FLOOR_BIN_SIZE_BP
            or manifest.get("complete") is not True
            or manifest.get("byteLayout", {}).get("dataOffset") != data_offset
            or manifest.get("byteLayout", {}).get("dataByteLength") != len(data)
            or manifest.get("dataChecksumSha256") != hashlib.sha256(data).hexdigest()
        ):
            return None
        return CoverageCorridorFloorArtifact(manifest=manifest, payload=payload)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def _atomic_write_artifact(path: Path, payload: bytes) -> None:
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name, suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _derive_artifact(
    *,
    segments: list[CoverageCorridorFloorSegment],
    prepared: list[tuple[CoverageCorridorFloorSegment, Path]],
    assembly_end: int,
    source_identity: str,
    request_fingerprint: str,
    assembly_fingerprint: str,
) -> CoverageCorridorFloorArtifact:
    manifest_segments: list[CoverageCorridorFloorManifestSegment] = []
    arrays: list[np.ndarray] = []
    buffers: list[bytes] = []
    byte_offset = 0
    for segment, path in prepared:
        chrom_len = segment["end"] - segment["start"]
        try:
            base = cp._load_cached_base_layer(path)
        except (OSError, ValueError) as exc:
            raise CoverageCorridorFloorNotPreparedError(
                f"coverage corridor floor cache invalid for {segment['chrom']}: {exc}"
            ) from exc
        bins = _fixed_base_peak_mean(base, chrom_len, segment["start"], segment["end"])
        bins = np.asarray(bins, dtype="<f4")
        raw = bins.tobytes(order="C")
        global_end = segment["globalStart"] + chrom_len
        source_base_bin = max(1, -(-chrom_len // int(len(base))))
        manifest_segments.append(
            {
                "chrom": segment["chrom"],
                "localStart": segment["start"],
                "localEnd": segment["end"],
                "globalStart": segment["globalStart"],
                "globalEnd": global_end,
                "binSize": CORRIDOR_FLOOR_BIN_SIZE_BP,
                "count": int(len(bins)),
                "byteOffset": byte_offset,
                "byteLength": len(raw),
                "sourceBaseBinSize": source_base_bin,
                "checksumSha256": hashlib.sha256(raw).hexdigest(),
                "complete": True,
            }
        )
        arrays.append(bins)
        buffers.append(raw)
        byte_offset += len(raw)

    data = b"".join(buffers)
    manifest: CoverageCorridorFloorManifest = {
        "contract": CORRIDOR_FLOOR_CONTRACT,
        "requestFingerprint": request_fingerprint,
        "sourceIdentity": source_identity,
        "orderedAssemblyFingerprint": assembly_fingerprint,
        "statistic": CORRIDOR_FLOOR_STATISTIC,
        "level": CORRIDOR_FLOOR_LEVEL,
        "binSize": CORRIDOR_FLOOR_BIN_SIZE_BP,
        "complete": True,
        "assemblyStart": 0,
        "assemblyEnd": assembly_end,
        "segments": manifest_segments,
        "dataChecksumSha256": hashlib.sha256(data).hexdigest(),
        "byteLayout": {
            "framing": "uint32le-json-header-padded4-then-data",
            "dtype": "float32",
            "endian": "little",
            "headerLengthPrefixBytes": 4,
            "headerPaddedBytes": 0,
            "dataOffset": 0,
            "dataByteLength": len(data),
        },
        "depthScale": _depth_scale(arrays),
    }
    return _encode_artifact(manifest, data)


def coverage_corridor_floor_artifact(
    bam_path: str,
    segments: list[CoverageCorridorFloorSegment],
    *,
    index_path: str | None = None,
    reference_fasta: str | None = None,
    source_generation: Mapping[str, object] | None = None,
) -> CoverageCorridorFloorArtifact:
    """Return a complete L15 artifact from already-ready exact source caches.

    Missing cache data fails before the first base array is loaded.  No call in
    this function opens or fetches an alignment, and no missing artifact is
    generated on the request path.
    """

    assembly_end = _validate_complete_ordered_assembly(segments)
    resolved_bam = str(_resolve_bam_path(bam_path))
    resolved_index = (
        str(_resolve_index_path(index_path)) if index_path is not None else None
    )
    resolved_reference_path = _resolve_reference_path(reference_fasta)
    resolved_reference = (
        str(resolved_reference_path) if resolved_reference_path is not None else None
    )
    source_identity = _opaque_source_identity(
        resolved_bam, resolved_index, resolved_reference
    )

    request_fingerprint = coverage_corridor_floor_request_fingerprint(
        bam_path,
        segments,
        index_path=index_path,
        reference_fasta=reference_fasta,
        source_generation=source_generation,
    )
    assembly_fingerprint = coverage_corridor_floor_assembly_fingerprint(segments)
    artifact_key = _sha256_text(
        "\0".join(
            [
                CORRIDOR_FLOOR_CONTRACT,
                source_identity,
                request_fingerprint,
                assembly_fingerprint,
                CORRIDOR_FLOOR_STATISTIC,
                str(CORRIDOR_FLOOR_LEVEL),
            ]
        )
    )
    artifact_path = cp._cache_dir() / f"corridor-floor-{artifact_key}.bin"
    with cp._base_layer_lock(artifact_path):
        cached = _load_persisted_artifact(
            artifact_path,
            source_identity=source_identity,
            request_fingerprint=request_fingerprint,
            assembly_fingerprint=assembly_fingerprint,
        )
        if cached is not None:
            return cached

        prepared: list[tuple[CoverageCorridorFloorSegment, Path]] = []
        missing: list[str] = []
        for segment in segments:
            path = cp._base_layer_cache_path(
                resolved_bam,
                segment["chrom"],
                resolved_index,
                resolved_reference,
            )
            if path is None or not path.is_file():
                missing.append(segment["chrom"])
            else:
                prepared.append((segment, path))
        if missing:
            raise CoverageCorridorFloorNotPreparedError(
                "coverage corridor floor not prepared for: " + ", ".join(missing)
            )

        artifact = _derive_artifact(
            segments=segments,
            prepared=prepared,
            assembly_end=assembly_end,
            source_identity=source_identity,
            request_fingerprint=request_fingerprint,
            assembly_fingerprint=assembly_fingerprint,
        )
        _atomic_write_artifact(artifact_path, artifact.payload)
        return artifact


__all__ = [
    "CORRIDOR_FLOOR_ASSEMBLY_CONTRACT",
    "CORRIDOR_FLOOR_BIN_SIZE_BP",
    "CORRIDOR_FLOOR_CONTRACT",
    "CORRIDOR_FLOOR_LEVEL",
    "CORRIDOR_FLOOR_REQUEST_CONTRACT",
    "CORRIDOR_FLOOR_STATISTIC",
    "CoverageCorridorFloorArtifact",
    "CoverageCorridorFloorNotPreparedError",
    "coverage_corridor_floor_artifact",
    "coverage_corridor_floor_assembly_fingerprint",
    "coverage_corridor_floor_request_fingerprint",
]
