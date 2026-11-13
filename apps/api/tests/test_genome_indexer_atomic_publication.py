from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from src.services.genome_indexer import (
    GenomeIndexerError,
    GenomeMetadata,
    IndexerResult,
    _publish_staged_bundle,
    _read_committed_bundle,
    _source_identity,
)


def _stage(root: Path, name: str, marker: str) -> Path:
    staging = root / f".{name}.{marker}.staging"
    staging.mkdir()
    (staging / f"{name}.fa.gz").write_text(f">{name}\n{marker * 4}\n")
    (staging / f"{name}.fa.gz.fai").write_text(f"{name}\t4\t7\t4\t5\n")
    (staging / f"{name}.fa.gz.gzi").write_bytes(f"gzi-{marker}".encode())
    (staging / f"{name}.gff3.gz").write_bytes(f"gff-{marker}".encode())
    (staging / f"{name}.gff3.gz.tbi").write_bytes(f"tbi-{marker}".encode())
    return staging


def _publish(
    *, staging: Path, output: Path, source: Path, source_identity: dict[str, int | str]
) -> IndexerResult:
    return _publish_staged_bundle(
        staging_dir=staging,
        output_dir=output,
        input_path=source,
        source_identity=source_identity,
        name="chr1",
        metadata=GenomeMetadata(length=4, circular=False, feature_count=1),
        cancel_check=None,
    )


def test_bundle_appears_with_one_atomic_directory_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.gb"
    source.write_text("source-a")
    output = tmp_path / "derived" / "chr1-generation"
    output.parent.mkdir()
    staging = _stage(output.parent, "chr1", "A")
    renames: list[tuple[Path, Path]] = []
    original_rename = os.rename

    def record_rename(source_path: Path, destination_path: Path) -> None:
        assert not output.exists()
        renames.append((Path(source_path), Path(destination_path)))
        original_rename(source_path, destination_path)

    monkeypatch.setattr("src.services.genome_indexer.os.rename", record_rename)

    result = _publish(
        staging=staging,
        output=output,
        source=source,
        source_identity=_source_identity(source),
    )

    assert not staging.exists()
    assert result.fasta_path == output / "chr1.fa.gz"
    assert result.fai_path == output / "chr1.fa.gz.fai"
    assert result.gff_path == output / "chr1.gff3.gz"
    assert result.tbi_path == output / "chr1.gff3.gz.tbi"
    receipt = json.loads((output / "chr1.waypoint-bundle.json").read_text())
    assert receipt["schemaVersion"] == 1
    assert len(receipt["generationId"]) == 64
    assert set(receipt["members"]) == {"fasta", "fai", "gzi", "gff", "tbi"}
    assert (output / "chr1.fa.gz.gzi").read_bytes() == b"gzi-A"
    assert renames == [(staging, output)]


def test_same_source_writers_commit_one_coherent_generation(tmp_path: Path) -> None:
    source = tmp_path / "source.gb"
    source.write_text("source-a")
    output = tmp_path / "derived" / "chr1-generation"
    output.parent.mkdir()
    source_receipt = _source_identity(source)
    stages = [_stage(output.parent, "chr1", marker) for marker in ("A", "B")]

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(
                lambda staging: _publish(
                    staging=staging,
                    output=output,
                    source=source,
                    source_identity=source_receipt,
                ),
                stages,
            )
        )

    assert all(result.fasta_path == output / "chr1.fa.gz" for result in results)
    fasta_marker = "A" if "AAAA" in (output / "chr1.fa.gz").read_text() else "B"
    assert (output / "chr1.gff3.gz").read_bytes() == f"gff-{fasta_marker}".encode()
    assert (output / "chr1.gff3.gz.tbi").read_bytes() == f"tbi-{fasta_marker}".encode()
    assert all(not staging.exists() for staging in stages)


def test_different_source_cannot_replace_committed_generation(tmp_path: Path) -> None:
    first_source = tmp_path / "first.gb"
    second_source = tmp_path / "second.gb"
    first_source.write_text("source-a")
    second_source.write_text("source-b")
    output = tmp_path / "derived" / "chr1-generation"
    output.parent.mkdir()
    first_stage = _stage(output.parent, "chr1", "A")
    _publish(
        staging=first_stage,
        output=output,
        source=first_source,
        source_identity=_source_identity(first_source),
    )
    before = {path.name: path.read_bytes() for path in output.iterdir()}

    second_stage = _stage(output.parent, "chr1", "B")
    with pytest.raises(GenomeIndexerError, match="refusing to replace non-atomic"):
        _publish(
            staging=second_stage,
            output=output,
            source=second_source,
            source_identity=_source_identity(second_source),
        )

    assert {path.name: path.read_bytes() for path in output.iterdir()} == before


def test_source_change_before_commit_never_publishes(tmp_path: Path) -> None:
    source = tmp_path / "source.gb"
    source.write_text("source-a")
    source_receipt = _source_identity(source)
    output = tmp_path / "derived" / "chr1-generation"
    output.parent.mkdir()
    staging = _stage(output.parent, "chr1", "A")
    source.write_text("source-b-longer")

    with pytest.raises(GenomeIndexerError, match="changed while it was being indexed"):
        _publish(
            staging=staging,
            output=output,
            source=source,
            source_identity=source_receipt,
        )

    assert not output.exists()


def test_tampered_receipt_generation_is_never_reused(tmp_path: Path) -> None:
    source = tmp_path / "source.gb"
    source.write_text("source-a")
    source_receipt = _source_identity(source)
    output = tmp_path / "derived" / "chr1-generation"
    output.parent.mkdir()
    _publish(
        staging=_stage(output.parent, "chr1", "A"),
        output=output,
        source=source,
        source_identity=source_receipt,
    )
    receipt_path = output / "chr1.waypoint-bundle.json"
    receipt = json.loads(receipt_path.read_text())
    receipt["metadata"]["length"] = 99
    receipt_path.write_text(json.dumps(receipt))

    with pytest.raises(GenomeIndexerError, match="generation identifier is invalid"):
        _read_committed_bundle(
            output_dir=output,
            name="chr1",
            source_identity=source_receipt,
            cancel_check=None,
        )


def test_oversized_sparse_receipt_is_rejected_before_json_decode(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.gb"
    source.write_text("source-a")
    source_receipt = _source_identity(source)
    output = tmp_path / "derived" / "chr1-generation"
    output.parent.mkdir()
    _publish(
        staging=_stage(output.parent, "chr1", "A"),
        output=output,
        source=source,
        source_identity=source_receipt,
    )
    receipt_path = output / "chr1.waypoint-bundle.json"
    with receipt_path.open("wb") as handle:
        handle.truncate(65 * 1024)

    with pytest.raises(GenomeIndexerError, match="unreadable receipt"):
        _read_committed_bundle(
            output_dir=output,
            name="chr1",
            source_identity=source_receipt,
            cancel_check=None,
        )


def test_receipt_swap_to_symlink_is_rejected_at_the_open_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.gb"
    source.write_text("source-a")
    source_receipt = _source_identity(source)
    output = tmp_path / "derived" / "chr1-generation"
    output.parent.mkdir()
    _publish(
        staging=_stage(output.parent, "chr1", "A"),
        output=output,
        source=source,
        source_identity=source_receipt,
    )
    receipt_path = output / "chr1.waypoint-bundle.json"
    attacker_receipt = tmp_path / "attacker-receipt.json"
    attacker_receipt.write_bytes(receipt_path.read_bytes())
    original_open = os.open
    swapped = False

    def swap_before_open(path: Path, flags: int) -> int:
        nonlocal swapped
        if not swapped and Path(path) == receipt_path:
            swapped = True
            receipt_path.unlink()
            receipt_path.symlink_to(attacker_receipt)
        return original_open(path, flags)

    monkeypatch.setattr("src.services.genome_indexer.os.open", swap_before_open)

    with pytest.raises(GenomeIndexerError, match="unreadable receipt"):
        _read_committed_bundle(
            output_dir=output,
            name="chr1",
            source_identity=source_receipt,
            cancel_check=None,
        )
