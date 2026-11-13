""" sparse read-difference and exact metadata contracts.

These small indexed BAMs prove decode branches. They are not the full-source
acceptance or performance oracle.
"""

from __future__ import annotations

from pathlib import Path

import pysam
import pytest

from src.services import alignment_tiles
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient


def test_spliced_read_blocks_break_on_introns() -> None:
    read = _aligned_read(
        name="spliced",
        sequence="A" * 90,
        start=1_000,
        cigar=[(0, 50), (3, 11_000), (0, 40)],
        tags=[],
    )
    assert alignment_tiles._reference_blocks(read) == [
        {"start": 1_000, "end": 1_050},
        {"start": 12_050, "end": 12_090},
    ]


def _aligned_read(
    *,
    name: str,
    sequence: str,
    start: int,
    cigar: list[tuple[int, int]],
    tags: list[tuple[str, object]],
    flag: int = 0,
    mapq: int = 60,
    qualities: str | None = None,
) -> pysam.AlignedSegment:
    read = pysam.AlignedSegment()
    read.query_name = name
    read.query_sequence = sequence
    read.flag = flag
    read.reference_id = 0
    read.reference_start = start
    read.mapping_quality = mapq
    read.cigartuples = cigar
    read.query_qualities = pysam.qualitystring_to_array(
        qualities or ("I" * len(sequence))
    )
    read.set_tags(tags)
    return read


@pytest.fixture()
def nucleotide_alignment_fixture(tmp_path: Path) -> dict[str, str]:
    fasta = tmp_path / "reference.fa"
    fasta.write_text(">chrT\n" + ("A" * 100) + "\n", encoding="ascii")
    pysam.faidx(str(fasta))

    bam = tmp_path / "reads.bam"
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": "chrT", "LN": 100}],
        "RG": [{"ID": "rg1", "SM": "fixture"}],
    }
    with pysam.AlignmentFile(str(bam), "wb", header=header) as writer:
        first = _aligned_read(
            name="duplicate-qname",
            sequence="AAAATAAAAA",
            start=10,
            cigar=[(0, 10)],
            flag=99,
            tags=[("NM", 1), ("AS", 9), ("MD", "4A5"), ("RG", "rg1")],
        )
        first.next_reference_id = 0
        first.next_reference_start = 20
        first.template_length = 18
        writer.write(first)

        for index in range(2):
            writer.write(
                _aligned_read(
                    name=f"sub-support-{index + 2}",
                    sequence="AAAATAAAAA",
                    start=10,
                    cigar=[(0, 10)],
                    tags=[("NM", 1), ("AS", 9), ("MD", "4A5"), ("RG", "rg1")],
                )
            )

        for index in range(2):
            writer.write(
                _aligned_read(
                    name=f"reference-read-{index + 1}",
                    sequence="AAAAAAAAAA",
                    start=10,
                    cigar=[(0, 10)],
                    tags=[("NM", 0), ("AS", 10), ("MD", "10"), ("RG", "rg1")],
                )
            )

        writer.write(
            _aligned_read(
                name="excluded-duplicate",
                sequence="AAAATAAAAA",
                start=10,
                cigar=[(0, 10)],
                flag=1024,
                tags=[("NM", 1), ("AS", 9), ("MD", "4A5"), ("RG", "rg1")],
            )
        )

        insertion = _aligned_read(
            name="duplicate-qname",
            sequence="AAAAGGAAAA",
            start=20,
            cigar=[(0, 4), (1, 2), (0, 4)],
            flag=147,
            mapq=45,
            qualities="JJJJJJJJJJ",
            tags=[("NM", 2), ("AS", 8), ("MD", "8"), ("RG", "rg1")],
        )
        insertion.next_reference_id = 0
        insertion.next_reference_start = 10
        insertion.template_length = -18
        writer.write(insertion)

        writer.write(
            _aligned_read(
                name="deletion-read",
                sequence="AAAAAAAA",
                start=30,
                cigar=[(0, 4), (2, 2), (0, 4)],
                mapq=30,
                qualities="HHHHHHHH",
                tags=[("NM", 2), ("AS", 6), ("MD", "4^AA4")],
            )
        )

    pysam.index(str(bam))
    return {
        "bam": str(bam),
        "index": f"{bam}.bai",
        "reference": str(fasta),
    }


def test_alignment_tile_emits_sparse_events_and_credible_alternate_columns(
    nucleotide_alignment_fixture: dict[str, str],
) -> None:
    fixture = nucleotide_alignment_fixture

    tile = alignment_tiles.alignment_tile(
        fixture["bam"],
        "chrT",
        0,
        80,
        level=0,
        tile_index=0,
        index_path=fixture["index"],
        reference_fasta=fixture["reference"],
    )

    assert tile["count"] == 8
    assert tile["sourceCount"] == 8
    reads = {
        (read["readId"], read["start"], read["flag"]): read for read in tile["reads"]
    }

    first = reads[("duplicate-qname", 10, 99)]
    assert "seq" not in first
    assert first["mismatches"] == [
        {
            "pos": 14,
            "kind": "sub",
            "length": 1,
            "refBase": "A",
            "readBase": "T",
            "baseQ": 40,
        }
    ]
    assert first["pair"] == {
        "paired": True,
        "properPair": True,
        "readNumber": 1,
        "mateUnmapped": False,
        "mateReverse": True,
        "mateStart": 20,
        "templateLength": 18,
    }

    insertion = reads[("duplicate-qname", 20, 147)]
    assert insertion["mismatches"] == [
        {
            "pos": 24,
            "kind": "ins",
            "length": 2,
            "readBase": "GG",
            "baseQ": 41,
        }
    ]

    deletion = reads[("deletion-read", 30, 0)]
    assert deletion["mismatches"] == [
        {
            "pos": 34,
            "kind": "del",
            "length": 2,
            "refBase": "AA",
        }
    ]

    assert all(
        "mismatches" not in read
        for key, read in reads.items()
        if key[0].startswith("reference-read")
    )
    assert tile["alternateColumns"] == [
        {
            "pos": 14,
            "kind": "sub",
            "length": 1,
            "refBase": "A",
            "readBase": "T",
            "coveringReadCount": 5,
            "supportingReadCount": 3,
            "weightedDepth": pytest.approx(4.999995),
            "weightedSupport": pytest.approx(2.999697),
            "weightedFraction": pytest.approx(0.59994),
        }
    ]


def test_alternate_guides_ignore_skipped_introns_but_count_deletions(
    tmp_path: Path,
) -> None:
    bam = tmp_path / "spliced-guides.bam"
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": "chrT", "LN": 100}],
    }
    with pysam.AlignmentFile(str(bam), "wb", header=header) as writer:
        for number in range(40):
            writer.write(
                _aligned_read(
                    name=f"skipped-{number}",
                    sequence="A" * 10,
                    start=0,
                    cigar=[(0, 5), (3, 50), (0, 5)],
                    tags=[("NM", 0), ("MD", "10")],
                )
            )
        for number in range(3):
            writer.write(
                _aligned_read(
                    name=f"alternate-{number}",
                    sequence="AAAATAAAAA",
                    start=10,
                    cigar=[(0, 10)],
                    tags=[("NM", 1), ("MD", "4A5")],
                )
            )
        writer.write(
            _aligned_read(
                name="reference",
                sequence="A" * 10,
                start=10,
                cigar=[(0, 10)],
                tags=[("NM", 0), ("MD", "10")],
            )
        )
        writer.write(
            _aligned_read(
                name="deletion",
                sequence="A" * 7,
                start=12,
                cigar=[(0, 1), (2, 3), (0, 6)],
                tags=[("NM", 3), ("MD", "1^AAA6")],
            )
        )
    pysam.index(str(bam))

    tile = alignment_tiles.alignment_tile(
        str(bam),
        "chrT",
        0,
        100,
        level=0,
        tile_index=0,
        index_path=f"{bam}.bai",
    )
    assert tile["sourceCount"] == 45
    assert tile["alternateColumns"] == [
        {
            "pos": 14,
            "kind": "sub",
            "length": 1,
            "refBase": "A",
            "readBase": "T",
            "coveringReadCount": 5,
            "supportingReadCount": 3,
            "weightedDepth": pytest.approx(4.999995),
            "weightedSupport": pytest.approx(2.999697),
            "weightedFraction": pytest.approx(0.59994),
        }
    ]


def test_alignment_tile_uses_one_reference_fallback_for_missing_md(
    tmp_path: Path,
) -> None:
    fasta = tmp_path / "fallback.fa"
    fasta.write_text(">chrT\n" + ("A" * 100) + "\n", encoding="ascii")
    pysam.faidx(str(fasta))
    bam = tmp_path / "fallback.bam"
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": "chrT", "LN": 100}],
    }
    with pysam.AlignmentFile(str(bam), "wb", header=header) as writer:
        writer.write(
            _aligned_read(
                name="no-md",
                sequence="AAAATAAAAA",
                start=10,
                cigar=[(0, 10)],
                tags=[("NM", 1)],
            )
        )
    pysam.index(str(bam))

    with pytest.raises(alignment_tiles.ReferenceNotFoundError):
        alignment_tiles.alignment_tile(
            str(bam),
            "chrT",
            0,
            80,
            level=0,
            tile_index=0,
            index_path=f"{bam}.bai",
        )

    tile = alignment_tiles.alignment_tile(
        str(bam),
        "chrT",
        0,
        80,
        level=0,
        tile_index=0,
        index_path=f"{bam}.bai",
        reference_fasta=str(fasta),
    )
    assert tile["reads"][0]["mismatches"] == [
        {
            "pos": 14,
            "kind": "sub",
            "length": 1,
            "refBase": "A",
            "readBase": "T",
            "baseQ": 40,
        }
    ]


def test_single_read_metadata_uses_composite_identity_not_qname_alone(
    nucleotide_alignment_fixture: dict[str, str],
) -> None:
    fixture = nucleotide_alignment_fixture

    metadata = alignment_tiles.read_single_read_metadata(
        fixture["bam"],
        "chrT",
        read_id="duplicate-qname",
        reference_start=20,
        flag=147,
        read_number=2,
        index_path=fixture["index"],
        reference_fasta=fixture["reference"],
    )

    assert metadata == {
        "readId": "duplicate-qname",
        "chrom": "chrT",
        "start": 20,
        "end": 28,
        "strand": "-",
        "mapq": 45,
        "flag": 147,
        "cigar": "4M2I4M",
        "seq": "AAAAGGAAAA",
        "baseQualities": [41, 41, 41, 41, 41, 41, 41, 41, 41, 41],
        "pair": {
            "paired": True,
            "properPair": True,
            "readNumber": 2,
            "mateUnmapped": False,
            "mateReverse": False,
            "mateStart": 10,
            "templateLength": -18,
        },
        "tags": {"NM": 2, "AS": 8, "MD": "8", "RG": "rg1"},
    }


def test_pair_metadata_omits_cross_reference_mate_position() -> None:
    read = _aligned_read(
        name="interchromosomal-pair",
        sequence="AAAAAAAAAA",
        start=10,
        cigar=[(0, 10)],
        flag=65,
        tags=[("NM", 0), ("MD", "10")],
    )
    read.next_reference_id = 1
    read.next_reference_start = 500

    assert alignment_tiles._pair_metadata(read) == {
        "paired": True,
        "properPair": False,
        "readNumber": 1,
        "mateUnmapped": False,
        "mateReverse": False,
        "templateLength": 0,
    }


def test_alignment_routes_expose_sparse_tiles_and_exact_metadata(
    nucleotide_alignment_fixture: dict[str, str],
) -> None:
    fixture = nucleotide_alignment_fixture
    from src.main import app

    client = TestClient(app)
    tile = client.post(
        "/tiles/alignment/0/0",
        json={
            "bamPath": fixture["bam"],
            "chrom": "chrT",
            "indexPath": fixture["index"],
            "referencePath": fixture["reference"],
        },
    )
    assert tile.status_code == 200, tile.text
    assert "seq" not in tile.json()["reads"][0]
    assert tile.json()["alternateColumns"][0]["pos"] == 14

    detail = client.post(
        "/tiles/alignment/read",
        json={
            "bamPath": fixture["bam"],
            "chrom": "chrT",
            "indexPath": fixture["index"],
            "referencePath": fixture["reference"],
            "readId": "duplicate-qname",
            "referenceStart": 20,
            "flag": 147,
            "readNumber": 2,
        },
    )
    assert detail.status_code == 200, detail.text
    assert detail.json()["cigar"] == "4M2I4M"
    assert detail.json()["baseQualities"] == [41] * len(detail.json()["seq"])
    assert detail.json()["tags"] == {"NM": 2, "AS": 8, "MD": "8", "RG": "rg1"}


def test_single_read_metadata_missing_identity_returns_404(
    nucleotide_alignment_fixture: dict[str, str],
) -> None:
    fixture = nucleotide_alignment_fixture
    from src.main import app

    detail = TestClient(app).post(
        "/tiles/alignment/read",
        json={
            "bamPath": fixture["bam"],
            "chrom": "chrT",
            "indexPath": fixture["index"],
            "referencePath": fixture["reference"],
            "readId": "duplicate-qname",
            "referenceStart": 20,
            "flag": 99,
            "readNumber": 1,
        },
    )
    assert detail.status_code == 404
