from __future__ import annotations

import multiprocessing
import os
from contextlib import asynccontextmanager
from pathlib import Path
from queue import Empty

import pysam
import pytest

from src.aligned_read_file_generation import capture_aligned_read_file_generation
from src.concurrency.schema import PoolName
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient


def _ensure_alignment_index_in_process(
    bam_path: str,
    source_generation: dict[str, object],
    managed_root: str,
    ready_queue,
    start_event,
    result_queue,
) -> None:
    os.environ["WAYPOINT_ALIGNMENT_INDEX_DIR"] = managed_root
    from src.services import pileup

    ready_queue.put("ready")
    start_event.wait()
    try:
        result_queue.put(
            {
                "ok": True,
                "result": pileup.ensure_alignment_index(
                    bam_path,
                    source_generation=source_generation,
                ),
            }
        )
    except BaseException as exc:
        result_queue.put({"ok": False, "error": repr(exc)})


def _bam(
    tmp_path: Path, *, name: str = "sample.bam", starts: tuple[int, ...] = (10,)
) -> Path:
    path = tmp_path / name
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": "chr1", "LN": 1_000}],
    }
    with pysam.AlignmentFile(str(path), "wb", header=header) as alignment:
        for index, start in enumerate(starts):
            read = pysam.AlignedSegment()
            read.query_name = f"read-{index + 1}"
            read.query_sequence = "A" * 20
            read.flag = 0
            read.reference_id = 0
            read.reference_start = start
            read.mapping_quality = 60
            read.cigar = ((0, 20),)
            read.query_qualities = pysam.qualitystring_to_array("I" * 20)
            read.set_tag("NM", 0)
            alignment.write(read)
    return path


def _indexed_bam(tmp_path: Path) -> Path:
    path = _bam(tmp_path)
    pysam.index(str(path))
    return path


def _file_generation(path: Path) -> dict[str, object]:
    canonical = path.resolve(strict=True)
    stat = canonical.stat()
    return {
        "canonicalPath": str(canonical),
        "size": stat.st_size,
        "mtimeNs": str(stat.st_mtime_ns),
        "ctimeNs": str(stat.st_ctime_ns),
        "device": str(stat.st_dev),
        "inode": str(stat.st_ino),
    }


def _source_generation(bam: Path, index: Path) -> dict[str, object]:
    return {
        "contract": "aligned-read-source-generation.v1",
        "alignment": _file_generation(bam),
        "index": _file_generation(index),
    }


def _managed_index_post(app, tmp_path: Path, monkeypatch, bam: Path):
    monkeypatch.setenv(
        "DNAFORGE_SIDECAR_DB_PATH", str(tmp_path / "control-plane.sqlite3")
    )
    monkeypatch.setenv("DNAFORGE_OPERATION_SCOPE", f"index-test-{tmp_path.name}")
    with TestClient(app) as client:
        return client.post("/tiles/alignment/index", json={"bamPath": str(bam)})


def _indexed_cram(tmp_path: Path) -> tuple[Path, Path]:
    reference = tmp_path / "reference.fa"
    reference.write_text(">chr1\n" + ("A" * 1_000) + "\n")
    pysam.faidx(str(reference))
    bam = _bam(tmp_path, name="cram-source.bam")
    cram = tmp_path / "sample.cram"
    with pysam.AlignmentFile(str(bam), "rb") as source:
        with pysam.AlignmentFile(
            str(cram),
            "wc",
            header=source.header,
            reference_filename=str(reference),
        ) as target:
            for read in source:
                target.write(read)
    pysam.index(str(cram))
    return cram, reference


def test_alignment_header_reports_contigs_and_readable_index(tmp_path: Path) -> None:
    from src.main import app

    bam = _indexed_bam(tmp_path)
    response = TestClient(app).post(
        "/tiles/alignment/header", json={"bamPath": str(bam)}
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "format": "bam",
        "isCram": False,
        "referenceRequired": False,
        "references": [{"name": "chr1", "length": 1_000, "md5": None}],
        "index": {"state": "present"},
    }


def test_alignment_header_uses_control_plane_capacity_not_tile_capacity(
    tmp_path: Path, monkeypatch
) -> None:
    from src.main import app
    from src.routes import tiles

    requested_pools: list[str] = []

    class RecordingPool:
        @asynccontextmanager
        async def slot(self):
            yield

    class RecordingPoolManager:
        def get(self, name: str) -> RecordingPool:
            requested_pools.append(name)
            return RecordingPool()

    monkeypatch.setattr(tiles, "get_pool_manager", lambda: RecordingPoolManager())
    bam = _indexed_bam(tmp_path)

    response = TestClient(app).post(
        "/tiles/alignment/header", json={"bamPath": str(bam)}
    )

    assert response.status_code == 200, response.text
    assert requested_pools == [PoolName.ALIGNMENT_CONTROL.value]


def test_alignment_header_missing_file_is_404() -> None:
    from src.main import app

    response = TestClient(app).post(
        "/tiles/alignment/header", json={"bamPath": "/definitely/missing/sample.bam"}
    )

    assert response.status_code == 404
    assert "alignment not found" in response.json()["detail"]


def test_admitted_generation_rejects_same_path_replacement_before_header_or_tile(
    tmp_path: Path,
) -> None:
    from src.main import app

    bam = _indexed_bam(tmp_path)
    index = Path(f"{bam}.bai")
    generation = _source_generation(bam, index)
    client = TestClient(app)
    source = {
        "bamPath": str(bam),
        "indexPath": str(index),
        "sourceGeneration": generation,
    }

    admitted = client.post("/tiles/alignment/header", json=source)
    assert admitted.status_code == 200, admitted.text

    source_stat = bam.stat()
    os.utime(bam, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns + 1_000_000))

    rejected_header = client.post("/tiles/alignment/header", json=source)
    rejected_tile = client.post(
        "/tiles/alignment/0/0",
        json={**source, "chrom": "chr1"},
    )
    rejected_coverage = client.post(
        "/tiles/coverage/0/0",
        json={**source, "chrom": "chr1"},
    )
    assert rejected_header.status_code == 409, rejected_header.text
    assert rejected_tile.status_code == 409, rejected_tile.text
    assert rejected_coverage.status_code == 409, rejected_coverage.text
    assert "changed after admission" in rejected_tile.json()["detail"]


def test_alignment_routes_admit_indexed_cram_with_its_decoding_reference(
    tmp_path: Path, monkeypatch
) -> None:
    from src.main import app

    cram, reference = _indexed_cram(tmp_path)
    client = TestClient(app)

    index = _managed_index_post(app, tmp_path, monkeypatch, cram)
    assert index.status_code == 200, index.text
    assert index.json() == {
        "format": "cram",
        "state": "present",
        "indexPath": f"{cram}.crai",
    }

    header = client.post(
        "/tiles/alignment/header",
        json={
            "bamPath": str(cram),
            "indexPath": f"{cram}.crai",
            "referencePath": str(reference),
        },
    )
    assert header.status_code == 200, header.text
    assert header.json()["format"] == "cram"
    assert header.json()["index"] == {"state": "present"}


def test_alignment_index_creates_and_reuses_atomic_managed_bai(
    tmp_path: Path, monkeypatch
) -> None:
    from src.main import app

    bam = _bam(tmp_path, name="unindexed.bam")
    adjacent = Path(str(bam) + ".bai")
    managed_root = tmp_path / "managed-indexes"
    monkeypatch.setenv("WAYPOINT_ALIGNMENT_INDEX_DIR", str(managed_root))
    assert not adjacent.exists()

    created = _managed_index_post(app, tmp_path, monkeypatch, bam)

    assert created.status_code == 200, created.text
    assert created.headers["X-DNAForge-Operation-Id"]
    index = Path(created.json()["indexPath"])
    assert created.json() == {
        "format": "bam",
        "state": "created",
        "indexPath": str(index),
    }
    assert index.parent == managed_root.resolve()
    assert not adjacent.exists()
    assert index.stat().st_size > 0
    created_mtime = index.stat().st_mtime_ns

    reused = _managed_index_post(app, tmp_path, monkeypatch, bam)
    assert reused.status_code == 200, reused.text
    assert reused.json() == {
        "format": "bam",
        "state": "present",
        "indexPath": str(index),
    }
    assert index.stat().st_mtime_ns == created_mtime

    header = TestClient(app).post(
        "/tiles/alignment/header",
        json={"bamPath": str(bam), "indexPath": str(index)},
    )
    assert header.status_code == 200, header.text
    assert header.json()["index"] == {"state": "present"}

    tile = TestClient(app).post(
        "/tiles/alignment/0/0",
        json={
            "bamPath": str(bam),
            "indexPath": str(index),
            "chrom": "chr1",
        },
    )
    assert tile.status_code == 200, tile.text
    assert tile.json()["count"] == 1


def test_alignment_index_preserves_a_corrupt_sibling_and_builds_managed(
    tmp_path: Path, monkeypatch
) -> None:
    from src.main import app

    bam = _bam(tmp_path, name="corrupt-index.bam")
    adjacent = Path(str(bam) + ".bai")
    adjacent.write_bytes(b"not-a-bai")
    managed_root = tmp_path / "managed-indexes"
    monkeypatch.setenv("WAYPOINT_ALIGNMENT_INDEX_DIR", str(managed_root))

    response = _managed_index_post(app, tmp_path, monkeypatch, bam)

    assert response.status_code == 200, response.text
    assert response.json()["state"] == "created"
    managed_index = Path(response.json()["indexPath"])
    assert managed_index.parent == managed_root.resolve()
    assert adjacent.read_bytes() == b"not-a-bai"
    with pysam.AlignmentFile(
        str(bam), "rb", index_filename=str(managed_index)
    ) as alignment:
        alignment.check_index()


def test_alignment_index_reuses_a_readable_adjacent_csi(
    tmp_path: Path, monkeypatch
) -> None:
    from src.main import app

    bam = _bam(tmp_path, name="csi-indexed.bam")
    index = Path(str(bam) + ".csi")
    pysam.index("-c", "-o", str(index), str(bam))

    response = _managed_index_post(app, tmp_path, monkeypatch, bam)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "format": "bam",
        "state": "present",
        "indexPath": str(index),
    }
    assert not Path(str(bam) + ".bai").exists()


def test_alignment_index_uses_identity_bound_managed_cache(
    tmp_path: Path, monkeypatch
) -> None:
    from src.main import app

    bam = _bam(tmp_path, name="read-only-source.bam")
    bam_bytes = bam.read_bytes()
    adjacent = Path(str(bam) + ".bai")
    managed_root = tmp_path / "managed-indexes"
    monkeypatch.setenv("WAYPOINT_ALIGNMENT_INDEX_DIR", str(managed_root))

    created = _managed_index_post(app, tmp_path, monkeypatch, bam)

    assert created.status_code == 200, created.text
    created_body = created.json()
    managed_index = Path(created_body["indexPath"])
    assert created_body == {
        "format": "bam",
        "state": "created",
        "indexPath": str(managed_index),
    }
    assert managed_index.parent == managed_root.resolve()
    assert managed_index.name.endswith(".bam.bai")
    assert managed_index.stat().st_size > 0
    assert not adjacent.exists()
    assert bam.read_bytes() == bam_bytes
    managed_mtime = managed_index.stat().st_mtime_ns

    tile = TestClient(app).post(
        "/tiles/alignment/0/0",
        json={
            "bamPath": str(bam),
            "indexPath": str(managed_index),
            "chrom": "chr1",
        },
    )
    assert tile.status_code == 200, tile.text
    assert tile.json()["count"] == 1

    reused = _managed_index_post(app, tmp_path, monkeypatch, bam)

    assert reused.status_code == 200, reused.text
    assert reused.json() == {
        "format": "bam",
        "state": "present",
        "indexPath": str(managed_index),
    }
    assert managed_index.stat().st_mtime_ns == managed_mtime

    source_stat = bam.stat()
    os.utime(
        bam,
        ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns + 1_000_000),
    )
    invalidated = _managed_index_post(app, tmp_path, monkeypatch, bam)

    assert invalidated.status_code == 200, invalidated.text
    replacement_index = Path(invalidated.json()["indexPath"])
    assert invalidated.json()["state"] == "created"
    assert replacement_index != managed_index
    assert replacement_index.is_file()
    assert managed_index.is_file()
    assert bam.read_bytes() == bam_bytes
    assert list(managed_root.glob(".*.tmp")) == []


def test_alignment_index_cache_follows_the_complete_source_generation(
    tmp_path: Path, monkeypatch
) -> None:
    from src.services import pileup

    def write_generation(path: Path, *, shift: int) -> None:
        header = {
            "HD": {"VN": "1.6", "SO": "coordinate"},
            "SQ": [{"SN": "chr1", "LN": 100_000}],
        }
        with pysam.AlignmentFile(str(path), "wb", header=header) as alignment:
            for read_index in range(1_200):
                read = pysam.AlignedSegment()
                read.query_name = f"read-{read_index:04d}"
                read.query_sequence = chr(65) * 50
                read.flag = 0
                read.reference_id = 0
                read.reference_start = shift + read_index * 5
                read.mapping_quality = 60
                read.cigar = ((0, 50),)
                read.query_qualities = pysam.qualitystring_to_array(chr(73) * 50)
                alignment.write(read)

    managed_root = tmp_path / "managed-indexes"
    monkeypatch.setenv("WAYPOINT_ALIGNMENT_INDEX_DIR", str(managed_root))
    bam = tmp_path / "reads.bam"
    replacement = tmp_path / "replacement.bam"

    write_generation(bam, shift=700)
    original_stat = bam.stat()
    first = pileup.ensure_alignment_index(str(bam))
    first_index = Path(first["indexPath"])

    write_generation(replacement, shift=20_700)
    assert replacement.stat().st_size == original_stat.st_size
    os.replace(replacement, bam)
    os.utime(bam, ns=(bam.stat().st_atime_ns, original_stat.st_mtime_ns))
    replacement_stat = bam.stat()

    assert replacement_stat.st_size == original_stat.st_size
    assert replacement_stat.st_mtime_ns == original_stat.st_mtime_ns
    assert replacement_stat.st_ctime_ns != original_stat.st_ctime_ns
    assert replacement_stat.st_ino != original_stat.st_ino

    second = pileup.ensure_alignment_index(str(bam))
    second_index = Path(second["indexPath"])
    populated = pileup.read_pileup_region(
        str(bam),
        "chr1",
        20_700,
        20_800,
        index_path=str(second_index),
    )

    assert second_index != first_index
    assert second["state"] == "created"
    assert populated["count"] == 20


def test_alignment_index_discards_staging_when_source_changes_during_build(
    tmp_path: Path, monkeypatch
) -> None:
    from src.services import pileup

    bam = _bam(tmp_path, name="changing.bam", starts=(10, 20, 30))
    replacement = _bam(tmp_path, name="replacement.bam", starts=(500, 510, 520))
    admitted = capture_aligned_read_file_generation(bam)
    managed_root = tmp_path / "managed-indexes"
    monkeypatch.setenv("WAYPOINT_ALIGNMENT_INDEX_DIR", str(managed_root))
    real_index = pileup.pysam.index

    def replace_after_build(*args: str) -> None:
        real_index(*args)
        os.replace(replacement, bam)

    monkeypatch.setattr(pileup.pysam, "index", replace_after_build)

    with pytest.raises(pileup.SourceGenerationChangedError):
        pileup.ensure_alignment_index(str(bam), source_generation=admitted)

    assert list(managed_root.glob("*.bai")) == []
    assert list(managed_root.glob(".*.tmp")) == []


def test_alignment_index_discards_publication_when_source_changes_during_validation(
    tmp_path: Path, monkeypatch
) -> None:
    from src.services import pileup

    bam = _bam(tmp_path, name="changing-after-publish.bam", starts=(10, 20, 30))
    replacement = _bam(
        tmp_path, name="replacement-after-publish.bam", starts=(500, 510, 520)
    )
    admitted = capture_aligned_read_file_generation(bam)
    managed_root = tmp_path / "managed-indexes"
    monkeypatch.setenv("WAYPOINT_ALIGNMENT_INDEX_DIR", str(managed_root))
    target = pileup._managed_index_target(bam, admitted)
    real_index_is_readable = pileup._index_is_readable
    replaced: list[Path] = []

    def replace_during_published_validation(resolved_bam: str, candidate: Path) -> bool:
        readable = real_index_is_readable(resolved_bam, candidate)
        if candidate == target and candidate.is_file() and readable and not replaced:
            os.replace(replacement, bam)
            replaced.append(candidate)
        return readable

    monkeypatch.setattr(
        pileup, "_index_is_readable", replace_during_published_validation
    )

    with pytest.raises(pileup.SourceGenerationChangedError):
        pileup.ensure_alignment_index(str(bam), source_generation=admitted)

    assert replaced == [target]
    assert list(managed_root.glob("*.bai")) == []
    assert list(managed_root.glob(".*.tmp")) == []


def test_alignment_index_serializes_one_builder_across_processes(
    tmp_path: Path, monkeypatch
) -> None:
    from src.services import pileup
    from src.services.alignment_index_lock import alignment_index_target_lock

    bam = _bam(tmp_path, name="contended.bam", starts=tuple(range(0, 4_000, 5)))
    generation = capture_aligned_read_file_generation(bam)
    generation_payload = generation.model_dump(
        mode="json", by_alias=True, exclude_none=False
    )
    managed_root = tmp_path / "managed-indexes"
    monkeypatch.setenv("WAYPOINT_ALIGNMENT_INDEX_DIR", str(managed_root))
    target = pileup._managed_index_target(bam, generation)
    context = multiprocessing.get_context("spawn")
    ready_queue = context.Queue()
    result_queue = context.Queue()
    start_event = context.Event()
    processes = [
        context.Process(
            target=_ensure_alignment_index_in_process,
            args=(
                str(bam),
                generation_payload,
                str(managed_root),
                ready_queue,
                start_event,
                result_queue,
            ),
        )
        for _ in range(2)
    ]

    try:
        with alignment_index_target_lock(target):
            for process in processes:
                process.start()
            assert [ready_queue.get(timeout=5) for _ in processes] == ["ready", "ready"]
            start_event.set()
            with pytest.raises(Empty):
                result_queue.get(timeout=0.25)

        results = [result_queue.get(timeout=10) for _ in processes]
        for process in processes:
            process.join(timeout=10)

        assert all(result["ok"] for result in results), results
        assert sorted(result["result"]["state"] for result in results) == [
            "created",
            "present",
        ]
        assert {result["result"]["indexPath"] for result in results} == {str(target)}
        assert target.is_file()
    finally:
        start_event.set()
        for process in processes:
            if process.is_alive():
                process.terminate()
            process.join(timeout=5)


def test_alignment_index_reports_when_managed_placement_fails(
    tmp_path: Path, monkeypatch
) -> None:
    from src.main import app
    from src.services import pileup as pileup_service

    bam = _bam(tmp_path, name="no-index-destination.bam")
    monkeypatch.setenv(
        "WAYPOINT_ALIGNMENT_INDEX_DIR", str(tmp_path / "managed-indexes")
    )

    def fail_all_placements(
        _resolved_bam: str, target: Path, *, source_generation: object
    ) -> bool:
        del source_generation
        raise pileup_service._IndexPlacementError(f"forced placement failure: {target}")

    monkeypatch.setattr(pileup_service, "_build_index_atomically", fail_all_placements)

    response = _managed_index_post(app, tmp_path, monkeypatch, bam)

    assert response.status_code == 422, response.text
    assert response.headers["X-DNAForge-Operation-Id"]
    assert response.json()["detail"]["code"] == "ALIGNMENT_INDEX_INVALID_SOURCE"
    assert "in the managed index cache" in response.json()["detail"]["message"]
    assert not Path(str(bam) + ".bai").exists()


def test_alignment_index_rejects_unsorted_bam_without_partial_index(
    tmp_path: Path, monkeypatch
) -> None:
    from src.main import app

    bam = _bam(tmp_path, name="unsorted.bam", starts=(100, 10))
    index = Path(str(bam) + ".bai")
    managed_root = tmp_path / "managed-indexes"
    monkeypatch.setenv("WAYPOINT_ALIGNMENT_INDEX_DIR", str(managed_root))

    response = _managed_index_post(app, tmp_path, monkeypatch, bam)

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "ALIGNMENT_INDEX_INVALID_SOURCE"
    assert "coordinate-sorted" in response.json()["detail"]["message"]
    assert not index.exists()
    assert list(managed_root.glob(".*.tmp")) == []
    assert list(managed_root.glob("*.bai")) == []
