"""Emit a real sidecar corridor-floor response for the TypeScript seam test."""

from __future__ import annotations

import base64
import json
import os
import tempfile
from pathlib import Path

import numpy as np

from tests.sidecar_test_client import (
    TEST_SIDECAR_SESSION,
    AuthenticatedSidecarTestClient,
)

GRCH38_PRIMARY_CHROMOSOMES = (
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
)
EXPECTED_GRCH38_LENGTH = 3_088_269_832
FIXTURE_BASE_BINS = 8_192
OUTPUT_PREFIX = "DNAFORGE_COVERAGE_CORRIDOR_CROSS_RUNTIME="


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


def _assembly() -> tuple[dict[str, object], list[dict[str, object]]]:
    cursor = 0
    chromosomes: list[dict[str, object]] = []
    segments: list[dict[str, object]] = []
    for order, (chrom, length) in enumerate(GRCH38_PRIMARY_CHROMOSOMES):
        chromosomes.append(
            {
                "chromosome": {
                    "id": chrom,
                    "displayName": chrom,
                    "length": length,
                },
                "globalStartBp": cursor,
                "globalEndBp": cursor + length,
                "order": order,
            }
        )
        segments.append(
            {
                "chrom": chrom,
                "start": 0,
                "end": length,
                "chromGlobalStart": cursor,
            }
        )
        cursor += length
    if cursor != EXPECTED_GRCH38_LENGTH:
        raise RuntimeError(f"GRCh38 fixture length drifted to {cursor}")
    return (
        {
            "id": "grch38-cross-runtime",
            "displayName": "GRCh38 cross-runtime fixture",
            "totalLengthBp": cursor,
            "chromosomes": chromosomes,
        },
        segments,
    )


def main() -> None:
    os.environ["DNAFORGE_MCP_SESSION_TOKEN"] = TEST_SIDECAR_SESSION
    os.environ["DNAFORGE_MCP_GRANT_CAPABILITIES"] = "*"
    os.environ["DNAFORGE_ALLOWED_RENDERER_ORIGIN"] = "null"

    from src.main import app
    from src.services import coverage_pyramid

    with tempfile.TemporaryDirectory(prefix="dnaforge-corridor-cross-runtime-") as raw:
        root = Path(raw)
        cache = root / "cache"
        cache.mkdir()
        bam = root / "reads.bam"
        index = root / "reads.bam.bai"
        reference = root / "reference.fa"
        reference_index = reference.with_name(reference.name + ".fai")
        bam.write_bytes(b"synthetic-bam-v1")
        index.write_bytes(b"synthetic-index-v1")
        reference.write_bytes(b"synthetic-reference-v1")
        reference_index.write_bytes(b"synthetic-reference-index-v1")
        os.environ["WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR"] = str(cache)
        coverage_pyramid.BASE_BINS = FIXTURE_BASE_BINS
        coverage_pyramid._clear_base_layer_memory_cache()

        assembly, segments = _assembly()
        for ordinal, (chrom, _length) in enumerate(GRCH38_PRIMARY_CHROMOSOMES):
            cache_path = coverage_pyramid._base_layer_cache_path(
                str(bam), str(chrom), str(index), str(reference)
            )
            if cache_path is None:
                raise RuntimeError(f"no base cache path for {chrom}")
            np.save(
                cache_path,
                np.full(FIXTURE_BASE_BINS, ordinal + 1, dtype=np.float32),
                allow_pickle=False,
            )

        generation = _source_generation(bam, index, reference)
        request = {
            "bamPath": str(bam),
            "indexPath": str(index),
            "referencePath": str(reference),
            "sourceGeneration": generation,
            "segments": segments,
        }
        client = AuthenticatedSidecarTestClient(app)
        try:
            response = client.post("/tiles/coverage-corridor-floor", json=request)
        finally:
            client.close()
        if response.status_code != 200:
            raise RuntimeError(
                f"corridor route returned {response.status_code}: {response.text}"
            )

        receipt = {
            "source": {
                "bamPath": str(bam),
                "indexPath": str(index),
                "referencePath": str(reference),
                "generation": generation,
            },
            "assembly": assembly,
            "payload": {
                "bytesBase64": base64.b64encode(response.content).decode("ascii"),
                "contractHeader": response.headers.get("X-Waypoint-Coverage-Contract"),
                "sourceHeader": response.headers.get("X-Waypoint-Coverage-Source"),
            },
        }
        print(OUTPUT_PREFIX + json.dumps(receipt, separators=(",", ":")))


if __name__ == "__main__":
    main()
