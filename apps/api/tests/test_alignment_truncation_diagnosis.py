from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from src.routes import tiles
from src.services import alignment_tiles, pileup


class _Pool:
    @asynccontextmanager
    async def slot(self):
        yield


@pytest.fixture
def route_services(monkeypatch):
    monkeypatch.setattr(
        tiles, "get_pool_manager", lambda: SimpleNamespace(get=lambda _: _Pool())
    )
    monkeypatch.setattr(pileup, "_resolve_index_path", lambda _: None)
    monkeypatch.setattr(pileup, "_resolve_reference_path", lambda value: value)


@pytest.mark.parametrize("path", ["/data/reads.bam", "/data/unknown.cram"])
async def test_truncation_before_format_is_known_does_not_blame_a_cram_reference(
    route_services, monkeypatch, path
):
    def fail_open(*_args):
        raise OSError("truncated file")

    monkeypatch.setattr(pileup, "_open_alignment", fail_open)
    body = tiles._TileSourceBody(bamPath=path, chrom="chr1")
    with pytest.raises(HTTPException) as caught:
        await tiles.alignment_tile_route(0, 0, body)
    assert caught.value.status_code == 404
    assert "stream" in caught.value.detail.lower()
    assert "reference" not in caught.value.detail.lower()


@pytest.mark.parametrize("is_cram", [False, True])
async def test_late_truncation_is_an_incomplete_read_not_a_certain_reference_diagnosis(
    route_services, monkeypatch, is_cram
):
    class Bam:
        references = ("chr1",)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def get_reference_length(self, _chrom):
            return 10_000

    bam = Bam()
    bam.is_cram = is_cram
    monkeypatch.setattr(pileup, "_open_alignment", lambda *_args: bam)

    def fail_read(*_args, **_kwargs):
        raise OSError("truncated file")

    monkeypatch.setattr(alignment_tiles, "alignment_tile", fail_read)
    body = tiles._TileSourceBody(
        bamPath="/data/reads", chrom="chr1", referencePath="/data/ref.fa"
    )
    with pytest.raises(HTTPException) as caught:
        await tiles.alignment_tile_route(0, 0, body)
    assert caught.value.status_code == 404
    assert "stream" in caught.value.detail.lower()
    assert "missing" not in caught.value.detail.lower()


async def test_missing_reference_for_an_actual_cram_retains_its_specific_error(
    route_services, monkeypatch
):
    class Bam:
        is_cram = True

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(pileup, "_open_alignment", lambda *_args: Bam())
    body = tiles._TileSourceBody(bamPath="/data/reads", chrom="chr1")
    with pytest.raises(HTTPException) as caught:
        await tiles.alignment_tile_route(0, 0, body)
    assert caught.value.status_code == 404
    assert "reference" in caught.value.detail.lower()
    assert "stream" not in caught.value.detail.lower()


async def test_unrelated_os_errors_are_not_reclassified(route_services, monkeypatch):
    error = OSError("permission denied")

    def fail_open(*_args):
        raise error

    monkeypatch.setattr(pileup, "_open_alignment", fail_open)
    body = tiles._TileSourceBody(bamPath="/data/reads.bam", chrom="chr1")
    with pytest.raises(OSError) as caught:
        await tiles.alignment_tile_route(0, 0, body)
    assert caught.value is error
