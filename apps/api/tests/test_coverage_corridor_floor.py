"""Source-keyed complete L15 corridor-floor artifact contract."""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

import numpy as np
import pytest

from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient


def _segments(lengths: list[tuple[str, int]]) -> list[dict]:
    out: list[dict] = []
    cursor = 0
    for chrom, length in lengths:
        out.append({"chrom": chrom, "start": 0, "end": length, "globalStart": cursor})
        cursor += length
    return out


def _prepare_source(monkeypatch, tmp_path, lengths, *, base_bins=8):
    from src.services import coverage_corridor_floor as floor
    from src.services import coverage_pyramid as cp

    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    bam = tmp_path / "reads.bam"
    index = tmp_path / "reads.bam.bai"
    reference = tmp_path / "reference.fa"
    bam.write_bytes(b"bam-v1")
    index.write_bytes(b"index-v1")
    reference.write_bytes(b"reference-v1")
    reference.with_name(reference.name + ".fai").write_bytes(b"fai-v1")
    monkeypatch.setenv("WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR", str(cache_dir))
    monkeypatch.setattr(cp, "BASE_BINS", base_bins)
    cp._clear_base_layer_memory_cache()
    segments = _segments(lengths)
    for ordinal, segment in enumerate(segments):
        path = cp._base_layer_cache_path(
            str(bam), segment["chrom"], str(index), str(reference)
        )
        assert path is not None
        np.save(
            path,
            np.arange(base_bins, dtype=np.float32) + ordinal * 10,
            allow_pickle=False,
        )
    return floor, cp, bam, index, reference, segments


def _decode(payload: bytes):
    header_len = struct.unpack_from("<I", payload, 0)[0]
    header = json.loads(payload[4 : 4 + header_len].decode("utf-8"))
    return header, payload[4 + header_len :]


def _file_generation(path: Path) -> dict[str, object]:
    canonical = path.resolve(strict=True)
    metadata = canonical.stat()
    return {
        "canonicalPath": str(canonical),
        "size": metadata.st_size,
        "mtimeNs": str(metadata.st_mtime_ns),
        "ctimeNs": str(metadata.st_ctime_ns),
        "device": str(metadata.st_dev),
        "inode": str(metadata.st_ino),
    }


def _source_generation(bam: Path, index: Path, reference: Path) -> dict[str, object]:
    return {
        "contract": "aligned-read-source-generation.v1",
        "alignment": _file_generation(bam),
        "index": _file_generation(index),
        "reference": _file_generation(reference),
        "referenceIndex": _file_generation(
            reference.with_name(reference.name + ".fai")
        ),
    }


def _generation_key(generation: dict[str, object]) -> str:
    def file_key(value: object) -> str:
        assert isinstance(value, dict)
        return "\0".join(
            str(value.get(field, ""))
            for field in (
                "canonicalPath",
                "size",
                "mtimeNs",
                "ctimeNs",
                "device",
                "inode",
            )
        )

    return "\1".join(
        [
            str(generation["contract"]),
            file_key(generation["alignment"]),
            file_key(generation["index"]),
            file_key(generation["reference"]),
            file_key(generation["referenceIndex"]),
        ]
    )


def test_request_fingerprint_matches_renderer_generation_contract(
    monkeypatch, tmp_path
):
    floor, _cp, bam, index, reference, segments = _prepare_source(
        monkeypatch, tmp_path, [("chr1", 65_536)]
    )
    generation = _source_generation(bam, index, reference)
    segment_identity = "\n".join(
        [
            "coverage-assembly-placement.v1",
            *[
                "\0".join(
                    [
                        segment["chrom"],
                        str(segment["start"]),
                        str(segment["end"]),
                        str(segment["globalStart"]),
                    ]
                )
                for segment in segments
            ],
        ]
    )
    prefix = "\0".join(
        [
            "coverage-corridor-floor-request.v1",
            str(bam),
            str(index),
            str(reference),
            _generation_key(generation),
        ]
    )
    expected = hashlib.sha256(f"{prefix}\n{segment_identity}".encode()).hexdigest()

    assert (
        floor.coverage_corridor_floor_request_fingerprint(
            str(bam),
            segments,
            index_path=str(index),
            reference_fasta=str(reference),
            source_generation=generation,
        )
        == expected
    )


def test_ready_floor_binds_source_assembly_statistic_ranges_layout_and_checksum(
    monkeypatch, tmp_path
):
    floor, cp, bam, index, reference, segments = _prepare_source(
        monkeypatch,
        tmp_path,
        [("chr1", 65_536), ("chr2", 32_768)],
    )

    monkeypatch.setattr(
        cp,
        "_open_alignment",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("scan")),
    )
    monkeypatch.setattr(
        cp,
        "_build_base_layer",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("build")),
    )
    artifact = floor.coverage_corridor_floor_artifact(
        str(bam),
        segments,
        index_path=str(index),
        reference_fasta=str(reference),
    )
    manifest, data = _decode(artifact.payload)

    assert manifest == artifact.manifest
    assert manifest["contract"] == "coverage-corridor-floor.v1"
    assert manifest["statistic"] == "fixed-base-peak-mean-v1"
    assert manifest["level"] == 15
    assert manifest["binSize"] == 32_768
    assert manifest["complete"] is True
    assert manifest["assemblyStart"] == 0
    assert manifest["assemblyEnd"] == 98_304
    assert [row["chrom"] for row in manifest["segments"]] == ["chr1", "chr2"]
    assert [row["count"] for row in manifest["segments"]] == [2, 1]
    assert all(row["complete"] is True for row in manifest["segments"])
    assert manifest["sourceIdentity"]
    assert manifest[
        "requestFingerprint"
    ] == floor.coverage_corridor_floor_request_fingerprint(
        str(bam), segments, index_path=str(index), reference_fasta=str(reference)
    )
    assert manifest["orderedAssemblyFingerprint"] == (
        floor.coverage_corridor_floor_assembly_fingerprint(segments)
    )
    assert manifest["dataChecksumSha256"] == hashlib.sha256(data).hexdigest()
    assert manifest["byteLayout"] == {
        "framing": "uint32le-json-header-padded4-then-data",
        "dtype": "float32",
        "endian": "little",
        "headerLengthPrefixBytes": 4,
        "headerPaddedBytes": struct.unpack_from("<I", artifact.payload, 0)[0],
        "dataOffset": 4 + struct.unpack_from("<I", artifact.payload, 0)[0],
        "dataByteLength": len(data),
    }
    for row in manifest["segments"]:
        raw = data[row["byteOffset"] : row["byteOffset"] + row["byteLength"]]
        assert row["checksumSha256"] == hashlib.sha256(raw).hexdigest()
    assert manifest["depthScale"]["basisStatistic"] == manifest["statistic"]
    assert manifest["depthScale"]["scaleDepth"] >= 1

    for segment in segments:
        base_path = cp._base_layer_cache_path(
            str(bam), segment["chrom"], str(index), str(reference)
        )
        assert base_path is not None
        base_path.unlink()
    cp._clear_base_layer_memory_cache()
    monkeypatch.setattr(
        cp,
        "_load_cached_base_layer",
        lambda _path: (_ for _ in ()).throw(
            AssertionError("derived artifact was not reused")
        ),
    )
    repeated = floor.coverage_corridor_floor_artifact(
        str(bam),
        segments,
        index_path=str(index),
        reference_fasta=str(reference),
    )
    assert repeated.payload == artifact.payload


def test_cache_miss_fails_before_loading_any_ready_chromosome(monkeypatch, tmp_path):
    floor, cp, bam, index, reference, segments = _prepare_source(
        monkeypatch,
        tmp_path,
        [("chr1", 65_536), ("chr2", 32_768)],
    )
    missing = cp._base_layer_cache_path(str(bam), "chr2", str(index), str(reference))
    assert missing is not None
    missing.unlink()
    loads = 0

    monkeypatch.setattr(
        cp,
        "_open_alignment",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("scan")),
    )
    monkeypatch.setattr(
        cp,
        "_build_base_layer",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("build")),
    )

    def forbidden_load(_path):
        nonlocal loads
        loads += 1
        raise AssertionError("partial cache must fail before array I/O")

    monkeypatch.setattr(cp, "_load_cached_base_layer", forbidden_load)
    with pytest.raises(floor.CoverageCorridorFloorNotPreparedError, match="chr2"):
        floor.coverage_corridor_floor_artifact(
            str(bam),
            segments,
            index_path=str(index),
            reference_fasta=str(reference),
        )
    assert loads == 0


def test_source_replacement_cannot_reuse_stale_floor_cache(monkeypatch, tmp_path):
    floor, _cp, bam, index, reference, segments = _prepare_source(
        monkeypatch,
        tmp_path,
        [("chr1", 65_536)],
    )
    first = floor.coverage_corridor_floor_artifact(
        str(bam), segments, index_path=str(index), reference_fasta=str(reference)
    )
    bam.write_bytes(b"bam-v2-with-a-different-source-identity")

    with pytest.raises(floor.CoverageCorridorFloorNotPreparedError, match="chr1"):
        floor.coverage_corridor_floor_artifact(
            str(bam), segments, index_path=str(index), reference_fasta=str(reference)
        )
    assert first.manifest["sourceIdentity"]


def test_exact_grch38_primary_segment_order_is_preserved(monkeypatch, tmp_path):
    grch38 = [
        ("chr1", 248_956_422),
        ("chr2", 242_193_529),
        ("chr3", 198_295_559),
        ("chr4", 190_214_555),
        ("chr5", 181_538_259),
        ("chr6", 170_805_979),
        ("chr7", 159_345_973),
        ("chr8", 145_138_636),
        ("chr9", 138_394_717),
        ("chr10", 133_797_422),
        ("chr11", 135_086_622),
        ("chr12", 133_275_309),
        ("chr13", 114_364_328),
        ("chr14", 107_043_718),
        ("chr15", 101_991_189),
        ("chr16", 90_338_345),
        ("chr17", 83_257_441),
        ("chr18", 80_373_285),
        ("chr19", 58_617_616),
        ("chr20", 64_444_167),
        ("chr21", 46_709_983),
        ("chr22", 50_818_468),
        ("chrX", 156_040_895),
        ("chrY", 57_227_415),
    ]
    floor, _cp, bam, index, reference, segments = _prepare_source(
        monkeypatch, tmp_path, grch38, base_bins=1
    )

    artifact = floor.coverage_corridor_floor_artifact(
        str(bam), segments, index_path=str(index), reference_fasta=str(reference)
    )

    assert artifact.manifest["assemblyEnd"] == 3_088_269_832
    assert [row["chrom"] for row in artifact.manifest["segments"]] == [
        chrom for chrom, _length in grch38
    ]
    assert sum(row["count"] for row in artifact.manifest["segments"]) == 94_257
    assert artifact.manifest["byteLayout"]["dataByteLength"] == 94_257 * 4


def test_route_returns_425_without_falling_back_to_legacy_or_build(monkeypatch):
    from src.main import app
    from src.services import coverage_corridor_floor
    from src.services.coverage_corridor_floor import (
        CoverageCorridorFloorNotPreparedError,
    )

    def not_prepared(*_args, **_kwargs):
        raise CoverageCorridorFloorNotPreparedError("not prepared")

    monkeypatch.setattr(
        coverage_corridor_floor, "coverage_corridor_floor_artifact", not_prepared
    )
    response = TestClient(app).post(
        "/tiles/coverage-corridor-floor",
        json={
            "bamPath": "/fixtures/HG002.bam",
            "segments": [
                {"chrom": "chr1", "start": 0, "end": 248_956_422, "chromGlobalStart": 0}
            ],
        },
    )

    assert response.status_code == 425
    assert response.json() == {"detail": "not prepared"}


def test_route_exposes_integrity_headers_to_renderer(monkeypatch, tmp_path):
    from src.main import app

    floor, _cp, bam, index, reference, segments = _prepare_source(
        monkeypatch,
        tmp_path,
        [("chr1", 65_536)],
    )
    generation = _source_generation(bam, index, reference)
    response = TestClient(app).post(
        "/tiles/coverage-corridor-floor",
        headers={"Origin": "http://localhost:1497"},
        json={
            "bamPath": str(bam),
            "indexPath": str(index),
            "referencePath": str(reference),
            "sourceGeneration": generation,
            "segments": [
                {
                    "chrom": segment["chrom"],
                    "start": segment["start"],
                    "end": segment["end"],
                    "chromGlobalStart": segment["globalStart"],
                }
                for segment in segments
            ],
        },
    )

    assert response.status_code == 200
    assert response.headers["X-Waypoint-Coverage-Contract"] == (
        "coverage-corridor-floor.v1"
    )
    assert response.headers["X-Waypoint-Coverage-Source"]
    exposed = {
        header.strip().lower()
        for header in response.headers["Access-Control-Expose-Headers"].split(",")
    }
    assert {
        "x-waypoint-coverage-contract",
        "x-waypoint-coverage-source",
    } <= exposed
    manifest, _data = _decode(response.content)
    assert manifest[
        "requestFingerprint"
    ] == floor.coverage_corridor_floor_request_fingerprint(
        str(bam),
        segments,
        index_path=str(index),
        reference_fasta=str(reference),
        source_generation=generation,
    )


def test_noncontiguous_or_partial_segment_contract_is_rejected(monkeypatch, tmp_path):
    floor, _cp, bam, index, reference, _segments_ready = _prepare_source(
        monkeypatch, tmp_path, [("chr1", 65_536)]
    )
    with pytest.raises(ValueError, match="complete chromosome"):
        floor.coverage_corridor_floor_artifact(
            str(bam),
            [{"chrom": "chr1", "start": 1, "end": 65_536, "globalStart": 0}],
            index_path=str(index),
            reference_fasta=str(reference),
        )
    with pytest.raises(ValueError, match="contiguous"):
        floor.coverage_corridor_floor_artifact(
            str(bam),
            [{"chrom": "chr1", "start": 0, "end": 65_536, "globalStart": 10}],
            index_path=str(index),
            reference_fasta=str(reference),
        )
