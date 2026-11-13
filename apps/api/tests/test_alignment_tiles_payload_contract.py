""" — alignment tiles carry reads, not renderer row ownership."""

from __future__ import annotations

from dataclasses import dataclass


def test_alignment_route_contract_accepts_guides_only() -> None:
    from src.routes.tiles import _TileSourceBody

    body = _TileSourceBody.model_validate(
        {
            "bamPath": "/data/reads.bam",
            "chrom": "chrT",
            "guidesOnly": True,
        }
    )

    assert body.guides_only is True


@dataclass
class _Read:
    query_name: str
    reference_start: int
    reference_end: int
    is_reverse: bool = False
    mapping_quality: int = 60
    is_unmapped: bool = False
    is_secondary: bool = False
    is_supplementary: bool = False
    is_duplicate: bool = False
    is_qcfail: bool = False
    flag: int = 0
    is_paired: bool = False
    is_proper_pair: bool = False
    is_read1: bool = False
    is_read2: bool = False
    mate_is_unmapped: bool = False
    mate_is_reverse: bool = False
    next_reference_start: int = -1
    template_length: int = 0
    cigartuples: list[tuple[int, int]] | None = None

    def has_tag(self, name: str) -> bool:
        return name == "NM"

    def get_tag(self, name: str) -> int:
        assert name == "NM"
        return 0


class _FakeBam:
    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def fetch(self, chrom: str, start: int, end: int):
        assert chrom == "chrT"
        reads = [
            _Read("same-qname", 100, 220),
            _Read("same-qname", 500, 640, is_reverse=True),
        ]
        return [r for r in reads if r.reference_start < end and r.reference_end > start]


def test_alignment_tile_payload_does_not_publish_renderer_lane_ownership(
    monkeypatch, tmp_path
):
    from src.services import alignment_tiles as at

    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")

    monkeypatch.setattr(at, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(at, "_resolve_index_path", lambda p: None)
    monkeypatch.setattr(at, "_resolve_reference_path", lambda p: None)
    monkeypatch.setattr(at, "_open_alignment", lambda *_args, **_kwargs: _FakeBam())

    tile = at.alignment_tile(str(fake_bam), "chrT", 0, 1024, level=0, tile_index=0)

    assert tile["count"] == 2
    assert tile["fine"] is True
    assert "laneCount" not in tile
    assert "overflowCount" not in tile
    assert [r["readId"] for r in tile["reads"]] == ["same-qname", "same-qname"]
    assert [r["start"] for r in tile["reads"]] == [100, 500]
    assert [r["strand"] for r in tile["reads"]] == ["+", "-"]
    for read in tile["reads"]:
        assert "lane" not in read
        assert "overflow" not in read


def test_alignment_tile_guides_only_keeps_aggregate_signal_without_read_rows(
    monkeypatch, tmp_path
):
    from src.services import alignment_tiles as at

    fake_bam = tmp_path / "reads.bam"
    fake_bam.write_bytes(b"fake-bam")

    monkeypatch.setattr(at, "_resolve_bam_path", lambda p: str(fake_bam))
    monkeypatch.setattr(at, "_resolve_index_path", lambda p: None)
    monkeypatch.setattr(at, "_resolve_reference_path", lambda p: None)
    monkeypatch.setattr(at, "_open_alignment", lambda *_args, **_kwargs: _FakeBam())
    monkeypatch.setattr(
        at,
        "_alternate_columns",
        lambda *_args, **_kwargs: [
            {
                "pos": 150,
                "kind": "sub",
                "length": 1,
                "refBase": "A",
                "readBase": "T",
                "coveringReadCount": 2,
                "supportingReadCount": 2,
                "weightedDepth": 2.0,
                "weightedSupport": 2.0,
                "weightedFraction": 1.0,
            }
        ],
    )

    tile = at.alignment_tile(
        str(fake_bam),
        "chrT",
        0,
        1024,
        level=3,
        tile_index=0,
        guides_only=True,
    )

    assert tile["reads"] == []
    assert tile["count"] == 0
    assert tile["sourceCount"] == 2
    assert tile["alternateColumns"] == [
        {
            "pos": 150,
            "kind": "sub",
            "length": 1,
            "refBase": "A",
            "readBase": "T",
            "coveringReadCount": 2,
            "supportingReadCount": 2,
            "weightedDepth": 2.0,
            "weightedSupport": 2.0,
            "weightedFraction": 1.0,
        }
    ]
