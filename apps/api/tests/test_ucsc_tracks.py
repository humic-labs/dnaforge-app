from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import socket
import tempfile
import threading
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import src.external.providers.ucsc as ucsc_provider_module
from src.control_plane.store import ControlPlaneStore
from src.external.contract import ProviderContractError
from src.external.providers.ucsc import UcscApiEndpoint, UcscProvider
from src.external.replay import build_replay_client
from src.external.service import ExternalResourcesService
from src.routes import external as external_routes
from src.routes.external import router as external_router

TEST_TOKEN = "ucsc-test-session"


@pytest.mark.parametrize(
    ("source", "hub_url", "expected"),
    [
        (
            "/gbdb/hg38/bbi/gc5BaseBw/gc5Base.bw",
            None,
            "https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/gc5BaseBw/gc5Base.bw",
        ),
        (
            "/gbdb/hg38/fantom5/Adipocyte%20-%20subcutaneous%2c%20donor2.CNhs11371.11336-117F4.hg38.ctss.rev.bw",
            None,
            "https://hgdownload.soe.ucsc.edu/gbdb/hg38/fantom5/Adipocyte%2520-%2520subcutaneous%252c%2520donor2.CNhs11371.11336-117F4.hg38.ctss.rev.bw",
        ),
        (
            "/gbdb/hg38/example/a b#c?d+e%.bb",
            None,
            "https://hgdownload.soe.ucsc.edu/gbdb/hg38/example/a%20b%23c%3Fd%2Be%25.bb",
        ),
        (
            "https://encode-public.s3.amazonaws.com/sample%20name.bigWig",
            None,
            "https://encode-public.s3.amazonaws.com/sample%20name.bigWig",
        ),
        (
            "data/sample%20name.bw",
            "https://example.org/hub/hub.txt",
            "https://example.org/hub/data/sample%20name.bw",
        ),
        (
            "/data/sample%20name.bw",
            "https://example.org/hub/hub.txt",
            "https://example.org/data/sample%20name.bw",
        ),
    ],
    ids=(
        "ordinary-native",
        "literal-percent-native",
        "reserved-native",
        "absolute-url",
        "hub-relative",
        "hub-root",
    ),
)
def test_ucsc_binary_source_distinguishes_native_paths_from_urls(
    source, hub_url, expected
):
    assert UcscProvider().resolve_big_data_url(source, hub_url=hub_url) == expected


def _local_path_authority(path: str) -> str:
    canonical_path = os.path.realpath(os.path.abspath(path))
    payload = ("dnaforge.local-indexed-track-authority.v1\0" + canonical_path).encode(
        "utf-8"
    )
    return hmac.new(TEST_TOKEN.encode("utf-8"), payload, hashlib.sha256).hexdigest()


class _ChunkedJsonBody(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks
        self.chunks_read = 0

    async def __aiter__(self):
        for chunk in self._chunks:
            self.chunks_read += 1
            yield chunk


def _track_catalog() -> dict:
    return {
        "hg38": {
            "knownGene": {
                "shortLabel": "MANE Select",
                "longLabel": "Matched Annotation from NCBI and EMBL-EBI transcripts",
                "type": "bigGenePred knownGenePep knownGeneMrna",
                "group": "genes",
                "bigDataUrl": "/gbdb/hg38/mane/mane.bb",
            },
            "gc5BaseBw": {
                "shortLabel": "GC Percent",
                "longLabel": "GC percent in 5-base windows",
                "type": "bigWig 0 100",
                "group": "map",
                "viewLimits": "0:30",
                "alwaysZero": "on",
                "subGroups": "cellType=vagina factor=POLR2A view=peaks",
                "metadata": 'ontology_id=10191-103E2 sequence_tech="h CAGE"',
            },
            "bamLeaf": {
                "shortLabel": "Remote reads",
                "longLabel": "Coordinate-sorted reads",
                "type": "bam",
                "group": "reads",
            },
            "variants": {
                "shortLabel": "ClinVar",
                "longLabel": "Clinically reported variants",
                "type": "vcfTabix",
                "group": "variation",
            },
            "peaks": {
                "shortLabel": "Open chromatin",
                "longLabel": "Accessible-chromatin peaks",
                "type": "bigNarrowPeak",
                "group": "regulation",
            },
            "repeats": {
                "shortLabel": "RepeatMasker",
                "longLabel": "Interspersed repeats",
                "type": "rmsk",
                "group": "repeats",
            },
            "intervals": {
                "shortLabel": "Conservation intervals",
                "longLabel": "Ordinary genomic intervals",
                "type": "bigBed",
                "group": "comparative",
            },
            "cpgIslandExt": {
                "shortLabel": "CpG Islands",
                "longLabel": "CpG Islands (Islands < 300 Bases are Light Green)",
                "type": "bed 4 +",
                "parent": "cpgIslandSuper pack",
                "group": "regulation",
                "color": "0,100,0",
            },
            "wgEncodeReg4": {
                "shortLabel": "ENCODE Regulation",
                "longLabel": "ENCODE regulatory evidence",
                "superTrack": "on",
                "wgEncodeReg4Epigenetics": {
                    "shortLabel": "Epigenetic marks",
                    "longLabel": "Histone marks and DNase signal",
                    "compositeContainer": "TRUE",
                    "compositeTrack": "on",
                    "wgEncodeReg4Epigenetics_ENCFF230LAU": {
                        "shortLabel": "ENCSR109DTU Signal",
                        "longLabel": "Activated B cell male adult 22 years treated with 0.5 μM CpG ODN for 24 hours DNase signal",
                        "type": "bigWig",
                        "parent": "wgEncodeReg4Epigenetics off",
                        "parentParent": "wgEncodeReg4",
                        "bigDataUrl": "https://encode-public.s3.amazonaws.com/2021/11/30/ebf9d085-b2ab-4c2c-bd6e-c6663c77de48/ENCFF230LAU.bigWig",
                        "color": "6,218,147",
                    },
                },
            },
        },
        "downloadTime": "2026:07:28T00:00:00Z",
    }


def _region_payload(*, items_returned: int = 2) -> dict:
    return {
        "genome": "hg38",
        "track": "knownGene",
        "trackType": "bigGenePred",
        "chrom": "chr1",
        "start": 920000,
        "end": 930000,
        "itemsReturned": items_returned,
        "bigDataUrl": "/gbdb/hg38/bbi/gc5BaseBw/gc5Base.bw",
        "knownGene": [
            {
                "chrom": "chr1",
                "chromStart": 924431,
                "chromEnd": 944574,
                "name": "ENST00000342066.8",
                "strand": "+",
                "geneName": "SAMD11",
                "thickStart": 925150,
                "thickEnd": 943900,
                "blockCount": 3,
                "blockSizes": "950,525,1250,",
                "chromStarts": "0,5100,18893,",
                "exonFrames": "0,1,2,",
            },
            {
                "chrom": "chr1",
                "chromStart": 925730,
                "chromEnd": 944581,
                "name": "ENST00000616016.5",
                "strand": "-",
                "geneName": "SAMD11",
                "thickStart": 926100,
                "thickEnd": 943700,
                "blockCount": 2,
                "blockSizes": "725,1400,",
                "chromStarts": "0,17451,",
                "exonFrames": "1,0,",
            },
        ][:items_returned],
    }


def _cpg_region_payload() -> dict:
    """Real hg38 cpgIslandExt response shape captured from UCSC on 2026-08-16."""

    return {
        "genome": "hg38",
        "track": "cpgIslandExt",
        "trackType": "bed 4 +",
        "chrom": "chr1",
        "start": 0,
        "end": 100000,
        "itemsReturned": 1,
        "cpgIslandExt": [
            {
                "bin": 585,
                "chrom": "chr1",
                "chromStart": 28735,
                "chromEnd": 29737,
                "name": "CpG: 111",
                "length": 1002,
                "cpgNum": 111,
                "gcNum": 731,
                "perCpg": 22.2,
                "perGc": 73,
                "obsExp": 0.85,
            }
        ],
    }


def _cpg_whole_payload() -> dict:
    """Real UCSC whole-track shape: chromosome keys wrap record lists."""

    chr1_record = dict(_cpg_region_payload()["cpgIslandExt"][0])
    chr1_record.pop("chrom")
    return {
        "genome": "hg38",
        "track": "cpgIslandExt",
        "trackType": "bed 4 +",
        "itemsReturned": 2,
        "cpgIslandExt": {
            "chr1": [chr1_record],
            "chr2": [
                {
                    "bin": 585,
                    "chromStart": 10655,
                    "chromEnd": 11165,
                    "name": "CpG: 43",
                    "length": 510,
                    "cpgNum": 43,
                    "gcNum": 309,
                    "perCpg": 16.9,
                    "perGc": 60.6,
                    "obsExp": 0.92,
                }
            ],
        },
    }


async def _public_resolver(
    _host: str, _port: int, *, type: socket.SocketKind
) -> list[tuple]:
    assert type == socket.SOCK_STREAM
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))]


@pytest.mark.asyncio
async def test_provider_normalizes_catalog_and_preserves_unsupported_leaves():
    request_count = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        assert request.url.path == "/list/tracks"
        assert request.url.params["genome"] == "hg38"
        assert "trackLeavesOnly" not in request.url.params
        return httpx.Response(200, json=_track_catalog())

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)

    leaves = await provider.list_tracks("hg38")

    assert provider.rate_limit_per_s == 1.0
    assert [leaf.track for leaf in leaves] == [
        "knownGene",
        "wgEncodeReg4Epigenetics_ENCFF230LAU",
        "gc5BaseBw",
        "peaks",
        "repeats",
        "intervals",
        "cpgIslandExt",
        "bamLeaf",
        "variants",
    ]
    by_track = {leaf.track: leaf for leaf in leaves}
    assert by_track["knownGene"].scientific_kind == "transcript"
    assert by_track["knownGene"].format_id == "bigbed"
    assert by_track["knownGene"].short_label == "MANE Select"
    assert by_track["knownGene"].source_kind == "ucsc-native"
    assert by_track["knownGene"].hub_url is None
    assert by_track["gc5BaseBw"].scientific_kind == "quantitative"
    assert by_track["gc5BaseBw"].format_id == "bigwig"
    assert by_track["peaks"].scientific_kind == "peak"
    assert by_track["repeats"].scientific_kind == "repeat"
    assert by_track["intervals"].scientific_kind == "interval"
    assert by_track["cpgIslandExt"].scientific_kind == "interval"
    assert by_track["cpgIslandExt"].format_id == "ucsc-native"
    assert by_track["cpgIslandExt"].big_data_url is None
    assert by_track["cpgIslandExt"].parent_track == "cpgIslandSuper"
    assert by_track["cpgIslandExt"].catalog_color == "0,100,0"
    encode = by_track["wgEncodeReg4Epigenetics_ENCFF230LAU"]
    assert encode.parent_track == "wgEncodeReg4Epigenetics"
    assert encode.parent_parent_track == "wgEncodeReg4"
    assert [
        (container.track, container.short_label, container.kind)
        for container in encode.container_path
    ] == [
        ("wgEncodeReg4", "ENCODE Regulation", "super"),
        ("wgEncodeReg4Epigenetics", "Epigenetic marks", "composite"),
    ]
    assert by_track["knownGene"].container_path == ()
    assert encode.catalog_color == "6,218,147"
    assert encode.experiment_accession == "ENCSR109DTU"
    assert encode.file_accession == "ENCFF230LAU"
    assert by_track["bamLeaf"].scientific_kind == "reads"
    assert by_track["bamLeaf"].format_id == "bam"
    assert by_track["variants"].scientific_kind == "variants"
    assert by_track["variants"].format_id == "vcf"
    assert await provider.list_tracks("hg38") == leaves
    assert request_count == 1

    await client.aclose()


@pytest.mark.asyncio
async def test_provider_keeps_the_facts_and_scale_a_catalog_declares():
    """trackDb states what a track measured and how to draw it; keep both.

    A consortium publishes thousands of tracks whose labels differ by a word,
    and the facets are the only machine-readable thing that tells them apart.
    """

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_track_catalog())

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)
    leaves = {leaf.track: leaf for leaf in await provider.list_tracks("hg38")}

    signal = leaves["gc5BaseBw"]
    assert [
        (attribute.key, attribute.value, attribute.origin)
        for attribute in signal.attributes
    ] == [
        ("cellType", "vagina", "subgroup"),
        ("factor", "POLR2A", "subgroup"),
        ("ontology_id", "10191-103E2", "metadata"),
        ("sequence_tech", "h CAGE", "metadata"),
    ]
    assert all(attribute.key != "view" for attribute in signal.attributes)
    assert signal.signal_scale is not None
    assert (
        signal.signal_scale.minimum,
        signal.signal_scale.maximum,
        signal.signal_scale.always_zero,
        signal.signal_scale.auto,
    ) == (0.0, 30.0, True, False)

    assert leaves["knownGene"].attributes == ()
    assert leaves["knownGene"].signal_scale is None

    await client.aclose()


@pytest.mark.asyncio
async def test_exact_track_identifier_is_not_truncated_after_fifty_fuzzy_matches(
    tmp_path,
):
    fuzzy_tracks = {
        f"relatedTrack{index:02d}": {
            "shortLabel": f"A related track {index:02d}",
            "longLabel": "targetTrack related catalog entry",
            "type": "bed 4 +",
            "group": "regulation",
        }
        for index in range(60)
    }
    catalog = {
        "hg38": {
            **fuzzy_tracks,
            "targetTrack": {
                "shortLabel": "ZZ exact target",
                "longLabel": "Exact targetTrack catalog entry",
                "type": "bed 4 +",
                "group": "regulation",
            },
        }
    }

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/list/tracks"
        return httpx.Response(200, json=catalog)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    store = ControlPlaneStore(tmp_path / "ucsc-exact-search.sqlite3")
    store.initialize()
    service = ExternalResourcesService(store, client=client)
    service.register(UcscProvider(client=client))
    try:
        tracks = await service.search_ucsc_tracks(
            "hg38",
            "targetTrack",
            limit=50,
            granted_capabilities=["external-fetch:annotation"],
        )
    finally:
        await service.aclose()
        await client.aclose()

    assert len(tracks) == 50
    assert tracks[0].track == "targetTrack"
    assert sum(track.track == "targetTrack" for track in tracks) == 1


@pytest.mark.asyncio
async def test_provider_validates_and_caches_exact_hub_assembly():
    hub_url = "https://example.org/hg38/hub.txt"
    requests: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.url.path)
        assert request.url.params["hubUrl"] == hub_url
        if request.url.path == "/list/hubGenomes":
            return httpx.Response(
                200,
                json={
                    "hubUrl": hub_url,
                    "hg38": {
                        "organism": "Human",
                        "trackDbFile": "hg38/trackDb.txt",
                    },
                },
            )
        if request.url.path == "/list/tracks":
            assert request.url.params["genome"] == "hg38"
            return httpx.Response(
                200,
                json={
                    "hg38": {
                        "hubGenes": {
                            "shortLabel": "Hub genes",
                            "longLabel": "Genes from a public hub",
                            "type": "bigBed",
                            "bigDataUrl": "genes.bb",
                        },
                        "hubReads": {
                            "shortLabel": "Hub reads",
                            "longLabel": "Aligned reads from a public hub",
                            "type": "bam",
                            "bigDataUrl": "https://reads.example.org/hub/sample.cram",
                            "bigDataIndex": "https://reads.example.org/hub/sample.cram.crai",
                        },
                    }
                },
            )
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)

    assert await provider.list_hub_genomes(hub_url) == {"hg38"}
    assert await provider.list_hub_genomes(hub_url) == {"hg38"}
    leaves = await provider.list_tracks("hg38", hub_url=hub_url)
    by_track = {leaf.track: leaf for leaf in leaves}
    assert by_track["hubGenes"].source_kind == "ucsc-hub"
    assert by_track["hubGenes"].hub_url == hub_url
    assert by_track["hubGenes"].big_data_index is None
    assert by_track["hubReads"].scientific_kind == "reads"
    assert (
        by_track["hubReads"].big_data_url == "https://reads.example.org/hub/sample.cram"
    )
    assert (
        by_track["hubReads"].big_data_index
        == "https://reads.example.org/hub/sample.cram.crai"
    )
    assert requests == ["/list/hubGenomes", "/list/tracks"]

    with pytest.raises(ProviderContractError, match="public host"):
        provider.normalize_hub_url("http://127.0.0.1/hub.txt")
    await client.aclose()


@pytest.mark.asyncio
async def test_provider_bounds_catalog_cache_and_refreshes_recent_entries():
    request_counts: dict[str, int] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        genome = request.url.params["genome"]
        request_counts[genome] = request_counts.get(genome, 0) + 1
        return httpx.Response(
            200,
            json={
                genome: {
                    f"track-{genome}": {
                        "shortLabel": genome,
                        "longLabel": f"Catalog for {genome}",
                        "type": "bigBed",
                    }
                }
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)
    limit = ucsc_provider_module._CATALOG_CACHE_MAX_ENTRIES

    for index in range(limit):
        await provider.list_tracks(f"genome-{index}")
    await provider.list_tracks("genome-0")
    await provider.list_tracks(f"genome-{limit}")

    await provider.list_tracks("genome-1")
    await provider.list_tracks("genome-0")

    assert request_counts["genome-1"] == 2
    assert request_counts["genome-0"] == 1
    assert len(provider._catalog_cache) == limit
    await client.aclose()


@pytest.mark.asyncio
async def test_provider_bounds_hub_genome_cache_and_refreshes_recent_entries():
    request_counts: dict[str, int] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        hub_url = request.url.params["hubUrl"]
        request_counts[hub_url] = request_counts.get(hub_url, 0) + 1
        return httpx.Response(
            200,
            json={
                "hubUrl": hub_url,
                "hg38": {"organism": "Human", "trackDbFile": "trackDb.txt"},
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)
    limit = ucsc_provider_module._HUB_GENOME_CACHE_MAX_ENTRIES
    hubs = [f"https://hub-{index}.example.org/hub.txt" for index in range(limit + 1)]

    for hub_url in hubs[:limit]:
        await provider.list_hub_genomes(hub_url)
    await provider.list_hub_genomes(hubs[0])
    await provider.list_hub_genomes(hubs[limit])

    await provider.list_hub_genomes(hubs[1])
    await provider.list_hub_genomes(hubs[0])

    assert request_counts[hubs[1]] == 2
    assert request_counts[hubs[0]] == 1
    assert len(provider._hub_genome_cache) == limit
    await client.aclose()


@pytest.mark.asyncio
async def test_provider_marks_cap_saturation_incomplete():
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_region_payload(items_returned=2))

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)

    result = await provider.fetch_track_region(
        genome="hg38",
        track="knownGene",
        chrom="chr1",
        start=920000,
        end=930000,
        max_items_output=2,
    )

    assert result.complete is False
    assert result.items_returned == 2
    assert result.records[0]["geneName"] == "SAMD11"
    await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("max_items_output", [100_000, 1_000_000])
async def test_provider_fetches_one_bounded_whole_track_snapshot(max_items_output):
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=_cpg_whole_payload())

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)

    result = await provider.fetch_track_region(
        genome="hg38",
        track="cpgIslandExt",
        chrom=None,
        start=None,
        end=None,
        max_items_output=max_items_output,
    )

    assert result.complete is True
    assert result.records[0]["chromStart"] == 28735
    assert [record["chrom"] for record in result.records] == ["chr1", "chr2"]
    assert dict(requests[0].url.params) == {
        "genome": "hg38",
        "track": "cpgIslandExt",
        "maxItemsOutput": str(max_items_output),
    }
    await client.aclose()


@pytest.mark.asyncio
async def test_provider_rejects_oversized_track_json_before_reading_the_body(
    monkeypatch,
):
    monkeypatch.setattr(ucsc_provider_module, "_MAX_JSON_RESPONSE_BYTES", 16)
    stream = _ChunkedJsonBody([b"{" + b" " * 30 + b"}"])

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"Content-Length": "32"},
            stream=stream,
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)

    with pytest.raises(ProviderContractError, match="oversized track response"):
        await provider.fetch_track_region(
            genome="hg38",
            track="cpgIslandExt",
            chrom=None,
            start=None,
            end=None,
            max_items_output=100_000,
        )

    assert stream.chunks_read == 0
    await client.aclose()


@pytest.mark.asyncio
async def test_provider_stops_streaming_track_json_at_the_byte_budget(monkeypatch):
    monkeypatch.setattr(ucsc_provider_module, "_MAX_JSON_RESPONSE_BYTES", 16)
    stream = _ChunkedJsonBody([b"1234567890", b"abcdefghij", b"never-read"])

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)

    with pytest.raises(ProviderContractError, match="oversized track response"):
        await provider.fetch_track_region(
            genome="hg38",
            track="cpgIslandExt",
            chrom=None,
            start=None,
            end=None,
            max_items_output=100_000,
        )

    assert stream.chunks_read == 2
    await client.aclose()


@pytest.mark.asyncio
async def test_provider_streams_json_above_the_materialization_limit(monkeypatch):
    upstream_body = b'{"genomes":{"large":"bounded-stream-canary"}}'
    stream = _ChunkedJsonBody([upstream_body[:17], upstream_body[17:]])
    monkeypatch.setattr(ucsc_provider_module, "_MAX_JSON_RESPONSE_BYTES", 16)

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)

    payload = await provider.request_api_payload(UcscApiEndpoint.LIST_UCSC_GENOMES)

    try:
        assert payload.byte_length == len(upstream_body)
        assert payload.content_kind == "json"
        assert payload.body.read() == upstream_body
    finally:
        payload.body.close()
    assert stream.chunks_read == 2
    await client.aclose()


@pytest.mark.asyncio
async def test_provider_keeps_spooled_file_work_off_the_event_loop(monkeypatch):
    loop_thread_id = threading.get_ident()
    original_spooled_temporary_file = tempfile.SpooledTemporaryFile
    spools: list[Any] = []

    class ThreadRecordingSpool:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self._inner = original_spooled_temporary_file(*args, **kwargs)
            self.thread_ids = {
                "write": [],
                "seek": [],
                "read": [],
                "close": [],
            }
            self.rolled = False
            spools.append(self)

        def write(self, value: bytes) -> int:
            self.thread_ids["write"].append(threading.get_ident())
            written = self._inner.write(value)
            self.rolled = self.rolled or bool(getattr(self._inner, "_rolled", False))
            return written

        def seek(self, offset: int, whence: int = 0) -> int:
            self.thread_ids["seek"].append(threading.get_ident())
            return self._inner.seek(offset, whence)

        def read(self, size: int = -1) -> bytes:
            self.thread_ids["read"].append(threading.get_ident())
            return self._inner.read(size)

        def close(self) -> None:
            self.thread_ids["close"].append(threading.get_ident())
            self._inner.close()

    json_parse_thread_ids: list[int] = []
    text_decode_thread_ids: list[int] = []
    original_json_loader = ucsc_provider_module._load_json_and_close
    original_text_decoder = ucsc_provider_module._decode_text_and_close

    def record_json_loader(payload):
        json_parse_thread_ids.append(threading.get_ident())
        return original_json_loader(payload)

    def record_text_decoder(payload):
        text_decode_thread_ids.append(threading.get_ident())
        return original_text_decoder(payload)

    monkeypatch.setattr(ucsc_provider_module, "_JSON_SPOOL_MEMORY_BYTES", 8)
    monkeypatch.setattr(
        ucsc_provider_module.tempfile,
        "SpooledTemporaryFile",
        ThreadRecordingSpool,
    )
    monkeypatch.setattr(
        ucsc_provider_module, "_load_json_and_close", record_json_loader
    )
    monkeypatch.setattr(
        ucsc_provider_module, "_decode_text_and_close", record_text_decoder
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == UcscApiEndpoint.LIST_FILES.value:
            return httpx.Response(200, content=b"one-file\n" * 4)
        return httpx.Response(200, json={"genomes": {"large": "x" * 32}})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)
    try:
        json_result = await provider.request_api(UcscApiEndpoint.LIST_UCSC_GENOMES)
        text_result = await provider.request_api(
            UcscApiEndpoint.LIST_FILES,
            params={"genome": "hs1", "format": "text"},
        )
    finally:
        await client.aclose()

    assert json_result == {"genomes": {"large": "x" * 32}}
    assert text_result == "one-file\n" * 4
    assert json_parse_thread_ids and loop_thread_id not in json_parse_thread_ids
    assert text_decode_thread_ids and loop_thread_id not in text_decode_thread_ids
    assert len(spools) == 2
    for spool in spools:
        assert spool.rolled is True
        for operation in ("write", "seek", "read", "close"):
            assert spool.thread_ids[operation]
            assert loop_thread_id not in spool.thread_ids[operation]


@pytest.mark.parametrize(
    ("endpoint", "params", "helper_name", "response_body"),
    [
        (
            UcscApiEndpoint.LIST_UCSC_GENOMES,
            {},
            "_load_json_and_close",
            b'{"genomes":{"hg38":{"description":"Human"}}}',
        ),
        (
            UcscApiEndpoint.LIST_FILES,
            {"genome": "hg38", "format": "text"},
            "_decode_text_and_close",
            b"one-file\ntwo-file\n",
        ),
    ],
    ids=("json", "text"),
)
@pytest.mark.asyncio
async def test_provider_cancellation_waits_for_spooled_parser_to_close(
    monkeypatch,
    endpoint,
    params,
    helper_name,
    response_body,
):
    worker_started = threading.Event()
    worker_release = threading.Event()
    worker_finished = threading.Event()
    captured_payloads: list[Any] = []
    original_helper = getattr(ucsc_provider_module, helper_name)

    def blocking_helper(payload):
        captured_payloads.append(payload)
        worker_started.set()
        try:
            if not worker_release.wait(timeout=5.0):
                raise TimeoutError("test did not release the UCSC spool worker")
            return original_helper(payload)
        finally:
            if not payload.closed:
                payload.close()
            worker_finished.set()

    monkeypatch.setattr(ucsc_provider_module, helper_name, blocking_helper)

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=response_body)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)
    request_task = asyncio.create_task(provider.request_api(endpoint, params=params))
    try:
        assert await asyncio.to_thread(
            worker_started.wait, 1.0
        ), "UCSC spool parser worker did not start"
        request_task.cancel()

        completed, _ = await asyncio.wait({request_task}, timeout=0.05)
        assert (
            not completed
        ), "request cancellation propagated before the spool parser settled"
        assert (
            worker_finished.is_set() is False
        ), "spool parser unexpectedly finished before its test release"

        worker_release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(request_task, timeout=1.0)

        assert (
            worker_finished.is_set() is True
        ), "request cancellation propagated before the spool parser finished"
        assert len(captured_payloads) == 1
        assert (
            captured_payloads[0].closed is True
        ), "request cancellation propagated before the spool payload closed"
    finally:
        worker_release.set()
        if not request_task.done():
            request_task.cancel()
            try:
                await asyncio.wait_for(request_task, timeout=1.0)
            except asyncio.CancelledError:
                pass
        await client.aclose()


@pytest.mark.asyncio
async def test_real_ucsc_replay_keeps_cpg_availability_assembly_specific():
    client = build_replay_client("tests/fixtures/external/replay")
    provider = UcscProvider(client=client)
    try:
        hg38 = {leaf.track: leaf for leaf in await provider.list_tracks("hg38")}
        assert hg38["cpgIslandExt"].scientific_kind == "interval"
        assert hg38["cpgIslandExt"].format_id == "ucsc-native"
        hg38_region = await provider.fetch_track_region(
            genome="hg38",
            track="cpgIslandExt",
            chrom="chr1",
            start=0,
            end=100000,
            max_items_output=100,
        )
        assert hg38_region.complete is True
        assert hg38_region.records[0] == _cpg_region_payload()["cpgIslandExt"][0]

        ce11 = {leaf.track: leaf for leaf in await provider.list_tracks("ce11")}
        assert ce11["cpgIslandExt"].scientific_kind == "interval"
        assert ce11["cpgIslandExt"].format_id == "ucsc-native"
        ce11_region = await provider.fetch_track_region(
            genome="ce11",
            track="cpgIslandExt",
            chrom="chrI",
            start=0,
            end=100000,
            max_items_output=100,
        )
        assert ce11_region.complete is True
        assert ce11_region.items_returned == 5
        assert ce11_region.records[0]["chromStart"] == 3770

        saccer3 = {leaf.track: leaf for leaf in await provider.list_tracks("sacCer3")}
        assert "cpgIslandExt" not in saccer3
        assert {
            "phastConsElements7way",
            "crisprRanges",
            "gap",
            "gold",
        }.issubset(saccer3)
        assert all(
            saccer3[track].scientific_kind == "interval"
            for track in ("phastConsElements7way", "crisprRanges", "gap", "gold")
        )
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_complete_ucsc_sparse_snapshot_reuses_the_profile_track_cache(
    tmp_path, monkeypatch
):
    provider_requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal provider_requests
        if request.url.path == "/getData/track":
            provider_requests += 1
            return httpx.Response(200, json=_cpg_whole_payload())
        return httpx.Response(404)

    monkeypatch.setenv(
        "WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR", str(tmp_path / "public-track-cache")
    )
    monkeypatch.setenv("WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES", "1048576")
    store = ControlPlaneStore(tmp_path / "ucsc-snapshot.sqlite3")
    store.initialize()

    async def read_with_fresh_service():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        service = ExternalResourcesService(store, client=client)
        service.register(UcscProvider(client=client))
        try:
            return await service.fetch_ucsc_track_region(
                genome="hg38",
                track="cpgIslandExt",
                chrom=None,
                start=None,
                end=None,
                max_items_output=100_000,
                granted_capabilities=["external-fetch:annotation"],
            )
        finally:
            await service.aclose()
            await client.aclose()

    first = await read_with_fresh_service()
    second = await read_with_fresh_service()

    assert first.complete is True
    assert second == first
    assert provider_requests == 1


@pytest.mark.asyncio
async def test_sparse_snapshot_cache_accepts_provider_count_after_record_normalization(
    tmp_path, monkeypatch
):
    provider_requests = 0
    payload = _cpg_whole_payload()
    payload["itemsReturned"] = 3
    payload["cpgIslandExt"]["chr2"].append("provider metadata")

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal provider_requests
        if request.url.path == "/getData/track":
            provider_requests += 1
            return httpx.Response(200, json=payload)
        return httpx.Response(404)

    monkeypatch.setenv(
        "WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR", str(tmp_path / "public-track-cache")
    )
    monkeypatch.setenv("WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES", "1048576")
    store = ControlPlaneStore(tmp_path / "ucsc-normalized-snapshot.sqlite3")
    store.initialize()

    async def read_with_fresh_service():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        service = ExternalResourcesService(store, client=client)
        service.register(UcscProvider(client=client))
        try:
            return await service.fetch_ucsc_track_region(
                genome="hg38",
                track="cpgIslandExt",
                chrom=None,
                start=None,
                end=None,
                max_items_output=100_000,
                granted_capabilities=["external-fetch:annotation"],
            )
        finally:
            await service.aclose()
            await client.aclose()

    first = await read_with_fresh_service()
    second = await read_with_fresh_service()

    assert len(first.records) == 2
    assert first.items_returned == 3
    assert second == first
    assert provider_requests == 1


@pytest.mark.asyncio
async def test_concurrent_whole_snapshots_share_one_provider_request(
    tmp_path, monkeypatch
):
    provider_started = asyncio.Event()
    release_provider = asyncio.Event()
    provider_requests = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal provider_requests
        if request.url.path != "/getData/track":
            return httpx.Response(404)
        provider_requests += 1
        provider_started.set()
        await release_provider.wait()
        return httpx.Response(200, json=_cpg_whole_payload())

    monkeypatch.delenv("WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR", raising=False)
    store = ControlPlaneStore(tmp_path / "ucsc-single-flight.sqlite3")
    store.initialize()
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=client)
    service.register(UcscProvider(client=client))

    async def read_snapshot():
        return await service.fetch_ucsc_track_region(
            genome="hg38",
            track="cpgIslandExt",
            chrom=None,
            start=None,
            end=None,
            max_items_output=100_000,
            granted_capabilities=["external-fetch:annotation"],
        )

    try:
        first = asyncio.create_task(read_snapshot())
        await provider_started.wait()
        second = asyncio.create_task(read_snapshot())
        await asyncio.sleep(0)
        release_provider.set()
        results = await asyncio.gather(first, second)
    finally:
        await service.aclose()
        await client.aclose()

    assert results[0] == results[1]
    assert provider_requests == 1


@pytest.mark.parametrize("max_items_output", [100_000, 1_000_000])
def test_ucsc_routes_cross_session_capability_and_provider_boundaries(
    tmp_path, monkeypatch, max_items_output
):
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.url.path)
        if request.url.path == "/list/tracks":
            return httpx.Response(200, json=_track_catalog())
        if request.url.path == "/getData/track":
            if request.url.params["track"] == "cpgIslandExt":
                if "chrom" not in request.url.params:
                    return httpx.Response(200, json=_cpg_whole_payload())
                return httpx.Response(200, json=_cpg_region_payload())
            return httpx.Response(200, json=_region_payload())
        return httpx.Response(404)

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_TOKEN)
    store = ControlPlaneStore(tmp_path / "ucsc-routes.sqlite3")
    store.initialize()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=http_client)
    service.register(UcscProvider(client=http_client))
    external_routes.set_service(service)

    app = FastAPI()
    app.include_router(external_router)
    client = TestClient(app, headers={"X-DNAForge-Session": TEST_TOKEN})

    search = client.post(
        "/external/ucsc/tracks/search",
        json={
            "genome": "hg38",
            "query": "matched annotation",
            "limit": 20,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert search.status_code == 200
    assert [item["track"] for item in search.json()["tracks"]] == ["knownGene"]
    assert search.json()["tracks"][0]["source_kind"] == "ucsc-native"

    cpg_search = client.post(
        "/external/ucsc/tracks/search",
        json={
            "genome": "hg38",
            "query": "CpG islands",
            "limit": 20,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert cpg_search.status_code == 200
    assert cpg_search.json()["tracks"] == [
        {
            "track": "cpgIslandExt",
            "short_label": "CpG Islands",
            "long_label": "CpG Islands (Islands < 300 Bases are Light Green)",
            "group": "regulation",
            "track_type": "bed 4 +",
            "scientific_kind": "interval",
            "format_id": "ucsc-native",
            "big_data_url": None,
            "big_data_index": None,
            "source_kind": "ucsc-native",
            "hub_url": None,
            "parent_track": "cpgIslandSuper",
            "parent_parent_track": None,
            "catalog_color": "0,100,0",
            "experiment_accession": None,
            "file_accession": None,
            "container_path": [],
            "attributes": [],
            "signal_scale": None,
        }
    ]

    cpg_region = client.post(
        "/external/ucsc/tracks/region",
        json={
            "genome": "hg38",
            "track": "cpgIslandExt",
            "chrom": "chr1",
            "start": 0,
            "end": 100000,
            "max_items_output": 1000,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert cpg_region.status_code == 200
    assert cpg_region.json()["complete"] is True
    assert cpg_region.json()["records"] == _cpg_region_payload()["cpgIslandExt"]

    cpg_whole = client.post(
        "/external/ucsc/tracks/region",
        json={
            "genome": "hg38",
            "track": "cpgIslandExt",
            "max_items_output": max_items_output,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert cpg_whole.status_code == 200
    assert cpg_whole.json()["complete"] is True
    assert [record["chrom"] for record in cpg_whole.json()["records"]] == [
        "chr1",
        "chr2",
    ]

    cached_search = client.post(
        "/external/ucsc/tracks/search",
        json={
            "genome": "hg38",
            "query": "percent",
            "limit": 20,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert cached_search.status_code == 200
    assert [item["track"] for item in cached_search.json()["tracks"]] == ["gc5BaseBw"]

    region = client.post(
        "/external/ucsc/tracks/region",
        json={
            "genome": "hg38",
            "track": "knownGene",
            "chrom": "chr1",
            "start": 920000,
            "end": 930000,
            "max_items_output": 1000,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert region.status_code == 200
    assert region.json()["complete"] is True
    assert region.json()["records"][0]["chromStart"] == 924431
    assert requests == [
        "/list/tracks",
        "/getData/track",
        "/getData/track",
        "/getData/track",
    ]

    denied = client.post(
        "/external/ucsc/tracks/search",
        json={
            "genome": "hg38",
            "query": "gene",
            "limit": 20,
            "granted_capabilities": [],
        },
    )
    assert denied.status_code == 403

    external_routes.set_service(None)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("etag", "identity_kind"),
    [
        ('"gc-v1"', "strong-etag"),
        ('"gc,v1"', "strong-etag"),
        ('W/"gc-v1"', "content-sha256"),
        ("not-an-rfc-etag", "content-sha256"),
        ('"gc-v1", "gc-v2"', "content-sha256"),
    ],
    ids=("strong", "strong-comma", "weak", "malformed", "combined"),
)
@pytest.mark.parametrize(
    ("native_path", "download_path"),
    [
        (
            "/gbdb/hg38/bbi/gc5BaseBw/gc5Base.bw",
            "/gbdb/hg38/bbi/gc5BaseBw/gc5Base.bw",
        ),
        (
            "/gbdb/hg38/fantom5/Adipocyte%20-%20subcutaneous%2c%20donor2.CNhs11371.11336-117F4.hg38.ctss.rev.bw",
            "/gbdb/hg38/fantom5/Adipocyte%2520-%2520subcutaneous%252c%2520donor2.CNhs11371.11336-117F4.hg38.ctss.rev.bw",
        ),
    ],
    ids=("ordinary-native", "literal-percent-native"),
)
def test_ucsc_admission_resolves_native_bigwig_then_serves_opaque_ranges(
    tmp_path, monkeypatch, etag, identity_kind, native_path, download_path
):
    binary_payload = bytes.fromhex("26fc8f88") + bytes(124) + b"abcdefgh" + bytes(56)
    binary_requests: list[str] = []
    current_etag = {"value": etag}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/getData/track":
            return httpx.Response(
                200,
                json={
                    **_region_payload(items_returned=0),
                    "bigDataUrl": native_path,
                    "gc5BaseBw": [],
                    "track": "gc5BaseBw",
                    "trackType": "bigWig",
                },
            )
        if request.url.raw_path.decode("ascii") == download_path:
            byte_range = request.headers.get("range")
            binary_requests.append(byte_range)
            if byte_range is None:
                return httpx.Response(
                    200,
                    content=binary_payload,
                    headers={
                        "Content-Length": str(len(binary_payload)),
                        "ETag": current_etag["value"],
                    },
                )
            start_text, end_text = byte_range.removeprefix("bytes=").split("-")
            start, end = int(start_text), int(end_text)
            body = binary_payload[start : end + 1]
            return httpx.Response(
                206,
                content=body,
                headers={
                    "Content-Range": f"bytes {start}-{end}/{len(binary_payload)}",
                    "Content-Length": str(len(body)),
                    "ETag": current_etag["value"],
                },
            )
        return httpx.Response(404)

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_TOKEN)
    store = ControlPlaneStore(tmp_path / "ucsc-admission.sqlite3")
    store.initialize()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=http_client)
    service._remote_range._resolver = _public_resolver
    clock = {"now": 100.0}

    def ticking_clock() -> float:
        current = clock["now"]
        clock["now"] += 3.0
        return current

    service._remote_range._clock = ticking_clock
    service.register(UcscProvider(client=http_client))
    external_routes.set_service(service)
    app = FastAPI()
    app.include_router(external_router)
    client = TestClient(app, headers={"X-DNAForge-Session": TEST_TOKEN})

    admitted = client.post(
        "/external/ucsc/tracks/admit",
        json={
            "genome": "hg38",
            "track": "gc5BaseBw",
            "format_id": "bigwig",
            "probe_chrom": "chr1",
            "big_data_url": "https://untrusted.example/other.bw",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert admitted.status_code == 200
    admission = admitted.json()
    assert admission["source_uri"] == f"https://hgdownload.soe.ucsc.edu{download_path}"
    assert admission["byte_length"] == len(binary_payload)
    assert admission["accepts_ranges"] is True
    assert admission["expires_in_seconds"] == 30 * 60 - 3
    if identity_kind == "strong-etag":
        source_uri = f"https://hgdownload.soe.ucsc.edu{download_path}"
        canonical_url_hash = hashlib.sha256(source_uri.encode()).hexdigest()
        receipt = "\0".join(
            (
                "dnaforge.http-strong-representation.v1",
                canonical_url_hash,
                "bigwig",
                str(len(binary_payload)),
                etag,
            )
        )
        expected_representation = hashlib.sha256(receipt.encode()).hexdigest()
    else:
        expected_representation = hashlib.sha256(binary_payload).hexdigest()
    assert admission["representation_sha256"] == expected_representation
    assert admission["representation_identity_kind"] == identity_kind
    active_source_token = admission["source_token"]

    if identity_kind == "strong-etag":
        same_generation = client.post(
            "/external/ucsc/tracks/admit",
            json={
                "genome": "hg38",
                "track": "gc5BaseBw",
                "format_id": "bigwig",
                "probe_chrom": "chr1",
                "granted_capabilities": ["external-fetch:annotation"],
            },
        )
        assert same_generation.status_code == 200
        assert (
            same_generation.json()["representation_sha256"]
            == admission["representation_sha256"]
        )

        current_etag["value"] = '"gc-v2"'
        changed_generation = client.post(
            "/external/ucsc/tracks/admit",
            json={
                "genome": "hg38",
                "track": "gc5BaseBw",
                "format_id": "bigwig",
                "probe_chrom": "chr1",
                "granted_capabilities": ["external-fetch:annotation"],
            },
        )
        assert changed_generation.status_code == 200
        changed_admission = changed_generation.json()
        assert (
            changed_admission["representation_sha256"]
            != admission["representation_sha256"]
        )

        stale_range = client.get(
            "/external/range",
            headers={
                "Range": "bytes=128-135",
                "X-DNAForge-Source-Token": admission["source_token"],
            },
        )
        assert stale_range.status_code == 409
        active_source_token = changed_admission["source_token"]

    ranged = client.get(
        "/external/range",
        headers={
            "Range": "bytes=128-135",
            "X-DNAForge-Source-Token": active_source_token,
        },
    )
    assert ranged.status_code == 206
    assert ranged.content == b"abcdefgh"
    assert ranged.headers["content-range"] == f"bytes 128-135/{len(binary_payload)}"
    assert ranged.headers["accept-ranges"] == "bytes"
    assert binary_requests == (
        [
            "bytes=0-63",
            "bytes=0-63",
            "bytes=0-63",
            "bytes=128-135",
            "bytes=128-135",
        ]
        if identity_kind == "strong-etag"
        else ["bytes=0-63", None]
    )

    external_routes.set_service(None)  # type: ignore[arg-type]


def test_ucsc_admission_marks_a_missing_remote_bigwig_terminal(tmp_path, monkeypatch):
    track = "CD14MonocytesTreatedWithTrehaloseDimycolateTDMDonor1_CNhs13467_ctss_fwd"
    source_path = (
        "/gbdb/hg38/fantom5/CD14%2b%20monocytes%20-%20treated%20with%20Trehalose"
        "%20dimycolate%20%28TDM%29%2c%20donor1.CNhs13467.11862-125A8.hg38.ctss.fwd.bw"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/getData/track":
            return httpx.Response(
                200,
                json={
                    **_region_payload(items_returned=0),
                    track: [],
                    "track": track,
                    "trackType": "bigWig",
                    "bigDataUrl": source_path,
                },
            )
        if request.url.raw_path.decode().split("?", 1)[0] == source_path:
            return httpx.Response(404)
        return httpx.Response(404)

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_TOKEN)
    store = ControlPlaneStore(tmp_path / "ucsc-missing-admission.sqlite3")
    store.initialize()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=http_client)
    service._remote_range._resolver = _public_resolver
    service.register(UcscProvider(client=http_client))
    external_routes.set_service(service)
    app = FastAPI()
    app.include_router(external_router)
    client = TestClient(app, headers={"X-DNAForge-Session": TEST_TOKEN})

    response = client.post(
        "/external/ucsc/tracks/admit",
        json={
            "genome": "hg38",
            "track": track,
            "format_id": "bigwig",
            "probe_chrom": "chr1",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == {
        "error": "source_not_admitted",
        "failure_kind": "remote_http_error",
        "message": "The remote track file was not found (HTTP 404)",
        "retryable": False,
        "status_code": 404,
    }

    external_routes.set_service(None)  # type: ignore[arg-type]


def test_ucsc_admission_marks_remote_503_as_retryable(tmp_path, monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/getData/track":
            return httpx.Response(
                200,
                json={
                    **_region_payload(items_returned=0),
                    "temporarilyUnavailableBigWig": [],
                    "track": "temporarilyUnavailableBigWig",
                    "trackType": "bigWig",
                    "bigDataUrl": "/gbdb/hg38/transient/signal.bw",
                },
            )
        return httpx.Response(503)

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_TOKEN)
    store = ControlPlaneStore(tmp_path / "ucsc-retryable-admission.sqlite3")
    store.initialize()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=http_client)
    service._remote_range._resolver = _public_resolver
    service.register(UcscProvider(client=http_client))
    external_routes.set_service(service)
    app = FastAPI()
    app.include_router(external_router)
    client = TestClient(app, headers={"X-DNAForge-Session": TEST_TOKEN})

    response = client.post(
        "/external/ucsc/tracks/admit",
        json={
            "genome": "hg38",
            "track": "temporarilyUnavailableBigWig",
            "format_id": "bigwig",
            "probe_chrom": "chr1",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "error": "source_not_admitted",
        "failure_kind": "remote_http_error",
        "message": "The remote track request failed (HTTP 503)",
        "retryable": True,
        "status_code": 503,
    }

    external_routes.set_service(None)  # type: ignore[arg-type]


def test_explicit_url_and_local_bigwig_share_the_opaque_range_route(
    tmp_path, monkeypatch
):
    binary_requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        byte_range = request.headers["range"]
        binary_requests.append(byte_range)
        if byte_range == "bytes=0-63":
            return httpx.Response(
                206,
                content=bytes.fromhex("26fc8f88") + bytes(60),
                headers={
                    "Content-Range": "bytes 0-63/100000",
                    "ETag": '"linked-v1"',
                },
            )
        return httpx.Response(
            206,
            content=b"remote!!",
            headers={
                "Content-Range": "bytes 128-135/100000",
                "ETag": '"linked-v1"',
            },
        )

    local_source = tmp_path / "workflow-output.bigWig"
    local_source.write_bytes(bytes.fromhex("26fc8f88") + bytes(124) + b"local!!!")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_TOKEN)
    store = ControlPlaneStore(tmp_path / "indexed-track-admission.sqlite3")
    store.initialize()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=http_client)
    service._remote_range._resolver = _public_resolver
    external_routes.set_service(service)
    app = FastAPI()
    app.include_router(external_router)
    client = TestClient(app, headers={"X-DNAForge-Session": TEST_TOKEN})

    linked = client.post(
        "/external/indexed-tracks/admit",
        json={
            "source_kind": "url",
            "source": "https://workflow.example.org/results/sample.bigWig",
            "format_id": "bigwig",
            "provenance_id": "explicit-url",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert linked.status_code == 200
    linked_grant = linked.json()
    linked_range = client.get(
        "/external/range",
        headers={
            "Range": "bytes=128-135",
            "X-DNAForge-Source-Token": linked_grant["source_token"],
        },
    )
    assert linked_range.status_code == 206
    assert linked_range.content == b"remote!!"

    unauthorized_local = client.post(
        "/external/indexed-tracks/admit",
        json={
            "source_kind": "path",
            "source": str(local_source),
            "format_id": "bigwig",
            "provenance_id": "local-file",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert unauthorized_local.status_code == 403
    assert "native DNAForge file picker" in unauthorized_local.json()["detail"]

    local = client.post(
        "/external/indexed-tracks/admit",
        json={
            "source_kind": "path",
            "source": str(local_source),
            "local_path_authority": _local_path_authority(str(local_source)),
            "format_id": "bigwig",
            "provenance_id": "local-file",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert local.status_code == 200
    local_grant = local.json()
    assert local_grant["source_uri"].startswith("file://")
    local_range = client.get(
        "/external/range",
        headers={
            "Range": "bytes=128-135",
            "X-DNAForge-Source-Token": local_grant["source_token"],
        },
    )
    assert local_range.status_code == 206
    assert local_range.content == b"local!!!"

    local_source.write_bytes(bytes.fromhex("26fc8f88") + bytes(124) + b"changed!")
    replaced_range = client.get(
        "/external/range",
        headers={
            "Range": "bytes=128-135",
            "X-DNAForge-Source-Token": local_grant["source_token"],
        },
    )
    assert replaced_range.status_code == 409
    assert replaced_range.json()["detail"] == {
        "error": "range_read_failed",
        "failure_kind": "source_changed",
        "message": "The local genomic source changed after admission",
        "retryable": False,
    }

    expired_grant = client.get(
        "/external/range",
        headers={
            "Range": "bytes=0-7",
            "X-DNAForge-Source-Token": "expired-source-token-value",
        },
    )
    assert expired_grant.status_code == 401
    assert expired_grant.json()["detail"]["failure_kind"] == "grant_expired"

    out_of_bounds = client.get(
        "/external/range",
        headers={
            "Range": "bytes=256-263",
            "X-DNAForge-Source-Token": local_grant["source_token"],
        },
    )
    assert out_of_bounds.status_code == 416
    assert out_of_bounds.json()["detail"]["failure_kind"] == "range_not_satisfiable"
    assert binary_requests == ["bytes=0-63", "bytes=128-135"]

    external_routes.set_service(None)  # type: ignore[arg-type]


def test_explicit_url_admission_rejects_private_dns_before_network_io(
    tmp_path, monkeypatch
):
    """Pin the existing remote-range SSRF boundary with an inert route canary."""
    network_called = False

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal network_called
        network_called = True
        return httpx.Response(500)

    async def private_resolver(
        _host: str, _port: int, *, type: socket.SocketKind
    ) -> list[tuple]:
        assert type == socket.SOCK_STREAM
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_TOKEN)
    store = ControlPlaneStore(tmp_path / "indexed-track-private-dns.sqlite3")
    store.initialize()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=http_client)
    service._remote_range._resolver = private_resolver
    external_routes.set_service(service)
    app = FastAPI()
    app.include_router(external_router)
    client = TestClient(app, headers={"X-DNAForge-Session": TEST_TOKEN})

    response = client.post(
        "/external/indexed-tracks/admit",
        json={
            "source_kind": "url",
            "source": "https://localhost/inert-loopback-canary.bigWig",
            "format_id": "bigwig",
            "provenance_id": "explicit-url",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )

    assert response.status_code == 422
    assert "public host" in response.json()["detail"]["message"]
    assert network_called is False

    external_routes.set_service(None)  # type: ignore[arg-type]


def test_ucsc_hub_route_requires_exact_assembly_and_preserves_source(
    tmp_path, monkeypatch
):
    hub_url = "https://example.org/hg38/hub.txt"
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.url.path)
        if request.url.path == "/list/hubGenomes":
            return httpx.Response(
                200,
                json={
                    "hubUrl": hub_url,
                    "hg38": {"trackDbFile": "hg38/trackDb.txt"},
                },
            )
        if request.url.path == "/list/tracks":
            return httpx.Response(
                200,
                json={
                    "hg38": {
                        "hubGenes": {
                            "shortLabel": "Hub genes",
                            "longLabel": "Genes from a public hub",
                            "type": "bigBed",
                            "bigDataUrl": "genes.bb",
                        }
                    }
                },
            )
        if request.url.path == "/getData/track":
            return httpx.Response(
                200,
                json={
                    "genome": "hg38",
                    "track": "hubGenes",
                    "trackType": "bigBed",
                    "itemsReturned": 0,
                    "bigDataUrl": "genes.bb",
                    "hubGenes": [],
                },
            )
        if request.url.path == "/hg38/genes.bb":
            byte_range = request.headers["range"]
            start_text, end_text = byte_range.removeprefix("bytes=").split("-")
            start, end = int(start_text), int(end_text)
            binary = bytes.fromhex("ebf28987") + bytes(124)
            payload = binary[start : end + 1]
            return httpx.Response(
                206,
                content=payload,
                headers={
                    "Content-Range": f"bytes {start}-{end}/{len(binary)}",
                    "Content-Length": str(len(payload)),
                    "ETag": '"hub-genes-v1"',
                },
            )
        return httpx.Response(404)

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_TOKEN)
    store = ControlPlaneStore(tmp_path / "ucsc-hub-routes.sqlite3")
    store.initialize()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=http_client)
    service._remote_range._resolver = _public_resolver
    service.register(UcscProvider(client=http_client))
    external_routes.set_service(service)
    app = FastAPI()
    app.include_router(external_router)
    client = TestClient(app, headers={"X-DNAForge-Session": TEST_TOKEN})

    response = client.post(
        "/external/ucsc/tracks/search",
        json={
            "genome": "hg38",
            "query": "genes",
            "hub_url": hub_url,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200
    assert response.json()["tracks"][0] == {
        "track": "hubGenes",
        "short_label": "Hub genes",
        "long_label": "Genes from a public hub",
        "group": None,
        "track_type": "bigBed",
        "scientific_kind": "interval",
        "format_id": "bigbed",
        "big_data_url": "genes.bb",
        "big_data_index": None,
        "source_kind": "ucsc-hub",
        "hub_url": hub_url,
        "parent_track": None,
        "parent_parent_track": None,
        "catalog_color": None,
        "experiment_accession": None,
        "file_accession": None,
        "container_path": [],
        "attributes": [],
        "signal_scale": None,
    }
    assert requests == ["/list/hubGenomes", "/list/tracks"]

    admitted = client.post(
        "/external/ucsc/tracks/admit",
        json={
            "genome": "hg38",
            "track": "hubGenes",
            "format_id": "bigbed",
            "probe_chrom": "chr1",
            "hub_url": hub_url,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert admitted.status_code == 200
    assert admitted.json()["source_uri"] == "https://example.org/hg38/genes.bb"
    assert admitted.json()["representation_identity_kind"] == "strong-etag"
    assert requests == [
        "/list/hubGenomes",
        "/list/tracks",
        "/getData/track",
        "/hg38/genes.bb",
    ]

    incompatible = client.post(
        "/external/ucsc/tracks/search",
        json={
            "genome": "hg19",
            "query": "",
            "hub_url": hub_url,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert incompatible.status_code == 422
    assert "does not advertise exact hg19" in incompatible.json()["detail"]["message"]
    assert requests == [
        "/list/hubGenomes",
        "/list/tracks",
        "/getData/track",
        "/hg38/genes.bb",
    ]

    external_routes.set_service(None)  # type: ignore[arg-type]


def test_ucsc_catalog_route_returns_every_track_with_its_true_total(
    tmp_path, monkeypatch
):
    """The catalog endpoint hands over the whole thing, counted honestly.

    A capped search could not say how many tracks matched or how many a
    folder held, because it discarded both before replying. Serving the
    catalog whole is what lets the caller compute those as facts.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/list/tracks":
            return httpx.Response(200, json=_track_catalog())
        return httpx.Response(404)

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_TOKEN)
    store = ControlPlaneStore(tmp_path / "ucsc-catalog.sqlite3")
    store.initialize()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=http_client)
    service.register(UcscProvider(client=http_client))
    external_routes.set_service(service)

    app = FastAPI()
    app.include_router(external_router)
    client = TestClient(app, headers={"X-DNAForge-Session": TEST_TOKEN})

    response = client.post(
        "/external/ucsc/tracks/catalog",
        json={
            "genome": "hg38",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == len(body["tracks"])
    assert body["total"] > 0

    search = client.post(
        "/external/ucsc/tracks/search",
        json={
            "genome": "hg38",
            "query": "",
            "limit": 1,
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert search.status_code == 200
    assert len(search.json()["tracks"]) == 1
    catalog_tracks = {item["track"] for item in body["tracks"]}
    assert {item["track"] for item in search.json()["tracks"]} <= catalog_tracks


def test_ucsc_catalog_route_refuses_a_catalog_too_large_to_hold(tmp_path, monkeypatch):
    """An unbounded hub is refused here rather than exhausting the caller.

    The ceiling sits far above any real UCSC assembly, so the refusal only
    fires for a catalog nobody should try to hold whole. The caller falls back
    to the capped search when it sees this.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/list/tracks":
            return httpx.Response(200, json=_track_catalog())
        return httpx.Response(404)

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_TOKEN)
    monkeypatch.setattr(external_routes, "_UCSC_CATALOG_MAX_TRACKS", 1)
    store = ControlPlaneStore(tmp_path / "ucsc-catalog-big.sqlite3")
    store.initialize()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=http_client)
    service.register(UcscProvider(client=http_client))
    external_routes.set_service(service)

    app = FastAPI()
    app.include_router(external_router)
    client = TestClient(app, headers={"X-DNAForge-Session": TEST_TOKEN})

    response = client.post(
        "/external/ucsc/tracks/catalog",
        json={
            "genome": "hg38",
            "granted_capabilities": ["external-fetch:annotation"],
        },
    )
    assert response.status_code == 413
    assert response.json()["detail"]["error"] == "catalog_too_large"
    assert response.json()["detail"]["limit"] == 1


def test_ucsc_catalog_route_reuses_its_serialized_payload(tmp_path, monkeypatch):
    """The same parsed catalog is serialized once, not on every request.

    Rebuilding 24,000 models produced identical bytes each time and cost most
    of the request. The bytes are kept beside the exact tuple they came from,
    so a refreshed catalog still rebuilds.
    """
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/list/tracks":
            calls.append(request.url.path)
            return httpx.Response(200, json=_track_catalog())
        return httpx.Response(404)

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_TOKEN)
    external_routes._UCSC_CATALOG_PAYLOADS.clear()
    store = ControlPlaneStore(tmp_path / "ucsc-catalog-bytes.sqlite3")
    store.initialize()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=http_client)
    service.register(UcscProvider(client=http_client))
    external_routes.set_service(service)

    app = FastAPI()
    app.include_router(external_router)
    client = TestClient(app, headers={"X-DNAForge-Session": TEST_TOKEN})
    request = {
        "genome": "hg38",
        "granted_capabilities": ["external-fetch:annotation"],
    }

    first = client.post("/external/ucsc/tracks/catalog", json=request)
    second = client.post("/external/ucsc/tracks/catalog", json=request)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.content == second.content
    assert calls == ["/list/tracks"]
    assert len(external_routes._UCSC_CATALOG_PAYLOADS) == 1
