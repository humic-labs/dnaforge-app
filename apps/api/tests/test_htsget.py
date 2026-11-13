from __future__ import annotations

import base64
import socket
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pysam
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.control_plane.store import ControlPlaneStore
from src.external.credential_broker import CredentialBroker
from src.external.htsget import HtsgetService, HtsgetSourceError
from src.external.service import ExternalResourcesService
from src.routes import external as external_routes
from src.routes.external import router as external_router
from src.routes.tiles import router as tiles_router
from src.services.dna_coverage_shellout import (
    DnaCoverageNotFoundError,
    find_dna_coverage_binary,
)


async def _public_resolver(
    host: str, _port: int, *, type: socket.SocketKind
) -> list[tuple]:
    assert type == socket.SOCK_STREAM
    address = "127.0.0.1" if host == "127.0.0.1" else "1.1.1.1"
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]


def _bam_fixture(tmp_path: Path) -> bytes:
    path = tmp_path / "reads.bam"
    header = {"HD": {"VN": "1.6"}, "SQ": [{"SN": "chr1", "LN": 1_000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as writer:
        read = pysam.AlignedSegment()
        read.query_name = "read-1"
        read.query_sequence = "A" * 20
        read.flag = 0
        read.reference_id = 0
        read.reference_start = 99
        read.mapping_quality = 60
        read.cigar = ((0, 20),)
        read.query_qualities = pysam.qualitystring_to_array("I" * 20)
        read.set_tag("MD", "20")
        read.set_tag("NM", 0)
        writer.write(read)
    return path.read_bytes()


def _vcf_fixture(tmp_path: Path) -> bytes:
    path = tmp_path / "calls.vcf.gz"
    header = pysam.VariantHeader()
    header.add_meta("fileformat", value="VCFv4.3")
    header.contigs.add("chr1", length=1_000)
    header.formats.add("GT", 1, "String", "Genotype")
    header.add_sample("tumor")
    with pysam.VariantFile(str(path), "wz", header=header) as writer:
        for start, identifier in ((99, "rs-one"), (199, "rs-two")):
            record = writer.new_record(
                contig="chr1",
                start=start,
                stop=start + (21 if identifier == "rs-one" else 1),
                id=identifier,
                alleles=(("N", "<DEL>") if identifier == "rs-one" else ("A", "T")),
                qual=50,
                filter="PASS",
            )
            record.samples["tumor"]["GT"] = (0, 1)
            writer.write(record)
    return path.read_bytes()


def _data_uri(payload: bytes, media_type: str) -> str:
    return f"data:{media_type};base64,{base64.b64encode(payload).decode('ascii')}"


@pytest.mark.asyncio
async def test_htsget_reads_keep_ticket_capabilities_ephemeral_and_fetch_regions(
    tmp_path: Path,
) -> None:
    bam = _bam_fixture(tmp_path)
    requests: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.host == "htsget.example.org":
            query = parse_qs(request.url.query.decode())
            assert request.url.path == "/reads/sample"
            assert query["format"] == ["BAM"]
            if query.get("class") == ["header"]:
                return httpx.Response(
                    200,
                    json={
                        "htsget": {
                            "format": "BAM",
                            "urls": [
                                {
                                    "url": _data_uri(bam, "application/vnd.ga4gh.bam"),
                                    "class": "header",
                                }
                            ],
                        }
                    },
                )
            assert query["referenceName"] == ["chr1"]
            assert query["start"] == ["90"]
            assert query["end"] == ["140"]
            return httpx.Response(
                200,
                json={
                    "htsget": {
                        "format": "BAM",
                        "urls": [
                            {
                                "url": (
                                    "https://blocks.example.org/body.bam"
                                    "?X-Amz-Signature=short-lived-secret"
                                ),
                                "headers": {
                                    "Authorization": "Bearer short-lived-secret"
                                },
                                "class": "body",
                            }
                        ],
                    }
                },
            )
        assert request.url.host == "blocks.example.org"
        assert request.headers["authorization"] == "Bearer short-lived-secret"
        return httpx.Response(
            200, content=bam, headers={"Content-Encoding": "identity"}
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    service = HtsgetService(
        client, resolver=_public_resolver, root=tmp_path / "runtime"
    )
    try:
        prepared = await service.prepare(
            endpoint="https://htsget.example.org",
            resource_id="sample",
            data_class="reads",
            source_format="BAM",
            references=[{"name": "chr1", "length": 1_000}],
        )
        assert prepared.format == "BAM"
        assert prepared.references == (("chr1", 1_000),)
        assert len(prepared.source_identity) == 64
        assert "secret" not in repr(prepared)

        snapshot = await service.materialize_region(
            prepared.source_token,
            reference_name="chr1",
            start=90,
            end=140,
        )
        try:
            assert snapshot.path.suffix == ".bam"
            assert snapshot.index_path is not None and snapshot.index_path.is_file()
            with pysam.AlignmentFile(
                str(snapshot.path), "rb", index_filename=str(snapshot.index_path)
            ) as alignment:
                assert [
                    read.query_name for read in alignment.fetch("chr1", 90, 140)
                ] == ["read-1"]
        finally:
            snapshot.cleanup()

        regional_ticket = next(
            request
            for request in requests
            if request.url.host == "htsget.example.org"
            and "referenceName" in request.url.params
        )
        assert regional_ticket.url.params["start"] == "90"
        assert regional_ticket.url.params["end"] == "140"
        assert all("secret" not in str(value) for value in prepared.__dict__.values())
    finally:
        await service.aclose()
        await client.aclose()


@pytest.mark.asyncio
async def test_htsget_variants_page_without_persisting_ticket_urls(
    tmp_path: Path,
) -> None:
    vcf = _vcf_fixture(tmp_path)
    ticket_queries: list[dict[str, list[str]]] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/variants/cohort"
        query = parse_qs(request.url.query.decode())
        ticket_queries.append(query)
        return httpx.Response(
            200,
            json={
                "htsget": {
                    "format": "VCF",
                    "urls": [
                        {
                            "url": _data_uri(vcf, "application/vnd.ga4gh.vcf"),
                            "class": (
                                "header" if query.get("class") == ["header"] else "body"
                            ),
                        }
                    ],
                }
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    service = HtsgetService(
        client, resolver=_public_resolver, root=tmp_path / "runtime"
    )
    try:
        prepared = await service.prepare(
            endpoint="https://htsget.example.org",
            resource_id="cohort",
            data_class="variants",
            source_format="VCF",
            references=[{"name": "chr1", "length": 1_000}],
        )
        assert prepared.samples == ("tumor",)
        first = await service.query_variant_page(
            prepared.source_token,
            source_identity=prepared.source_identity,
            assembly_revision=prepared.assembly_revision,
            references=[{"name": "chr1", "length": 1_000}],
            cursor=None,
            limit=1,
        )
        assert [variant["recordId"] for variant in first["variants"]] == ["rs-one"]
        assert first["nextCursor"] is not None
        second = await service.query_variant_page(
            prepared.source_token,
            source_identity=prepared.source_identity,
            assembly_revision=prepared.assembly_revision,
            references=[{"name": "chr1", "length": 1_000}],
            cursor=first["nextCursor"],
            limit=1,
        )
        assert [variant["recordId"] for variant in second["variants"]] == ["rs-two"]
        assert second["nextCursor"] is None
        region = await service.query_variant_region(
            prepared.source_token,
            source_identity=prepared.source_identity,
            assembly_revision=prepared.assembly_revision,
            references=[{"name": "chr1", "length": 1_000}],
            chrom="chr1",
            start=100,
            end=150,
            limit=10_000,
        )
        assert [variant["recordId"] for variant in region["variants"]] == ["rs-one"]
        assert region["truncated"] is False
        assert any(query.get("referenceName") == ["chr1"] for query in ticket_queries)
        assert all(
            int(query["end"][0]) > int(query["start"][0])
            for query in ticket_queries
            if "referenceName" in query
        )
    finally:
        await service.aclose()
        await client.aclose()


@pytest.mark.asyncio
async def test_htsget_rejects_private_ticket_blocks_and_missing_auth_refs(
    tmp_path: Path,
) -> None:
    bam = _bam_fixture(tmp_path)

    def upstream(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "htsget": {
                    "format": "BAM",
                    "urls": [{"url": "http://127.0.0.1/private.bam"}],
                }
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    service = HtsgetService(
        client, resolver=_public_resolver, root=tmp_path / "runtime"
    )
    try:
        with pytest.raises(HtsgetSourceError, match="not connected"):
            await service.prepare(
                endpoint="https://htsget.example.org",
                resource_id="sample",
                data_class="reads",
                source_format="BAM",
                references=[{"name": "chr1", "length": 1_000}],
                auth_ref="cloud-profile",
            )
        with pytest.raises(HtsgetSourceError, match="public host"):
            await service.prepare(
                endpoint="https://htsget.example.org",
                resource_id="sample",
                data_class="reads",
                source_format="BAM",
                references=[{"name": "chr1", "length": 1_000}],
            )
        assert bam
    finally:
        await service.aclose()
        await client.aclose()


@pytest.mark.asyncio
async def test_htsget_uses_broker_credential_for_every_ticket_only(
    tmp_path: Path,
) -> None:
    bam = _bam_fixture(tmp_path)
    canary = "INERT_HTSGET_CREDENTIAL_CANARY_123456"
    observed: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        observed.append(request)
        assert request.url.host == "htsget.example.org"
        assert request.headers["authorization"] == f"Bearer {canary}"
        return httpx.Response(
            200,
            json={
                "htsget": {
                    "format": "BAM",
                    "urls": [{"url": _data_uri(bam, "application/vnd.ga4gh.bam")}],
                }
            },
        )

    broker = CredentialBroker()
    broker.register(
        auth_ref="credential:private-htsget",
        kind="http-bearer",
        material={"token": canary},
    )
    client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    service = HtsgetService(
        client,
        resolver=_public_resolver,
        root=tmp_path / "private-runtime",
        credential_broker=broker,
    )
    try:
        prepared = await service.prepare(
            endpoint="https://htsget.example.org",
            resource_id="sample",
            data_class="reads",
            source_format="BAM",
            references=[{"name": "chr1", "length": 1_000}],
            auth_ref="credential:private-htsget",
        )
        snapshot = await service.materialize_region(
            prepared.source_token,
            reference_name="chr1",
            start=90,
            end=140,
        )
        snapshot.cleanup()
        assert len(observed) == 2
        assert canary not in repr(prepared)
        assert canary not in repr(service.get_session(prepared.source_token))
    finally:
        await service.aclose()
        await client.aclose()


def _dna_coverage_built() -> bool:
    try:
        find_dna_coverage_binary()
    except DnaCoverageNotFoundError:
        return False
    return True


@pytest.mark.skipif(not _dna_coverage_built(), reason="dna-coverage helper not built")
def test_htsget_routes_drive_alignment_tiles_and_variant_pages(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bam = _bam_fixture(tmp_path)
    vcf = _vcf_fixture(tmp_path)
    regional_queries: list[dict[str, list[str]]] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        query = parse_qs(request.url.query.decode())
        is_reads = request.url.path == "/reads/sample"
        assert is_reads or request.url.path == "/variants/cohort"
        if "referenceName" in query:
            regional_queries.append(query)
        payload = bam if is_reads else vcf
        source_format = "BAM" if is_reads else "VCF"
        return httpx.Response(
            200,
            json={
                "htsget": {
                    "format": source_format,
                    "urls": [{"url": _data_uri(payload, "application/octet-stream")}],
                }
            },
        )

    token = "htsget-route-session"
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", token)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "*")
    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    upstream_client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    service = ExternalResourcesService(
        store,
        client=upstream_client,
        public_http_resolver=_public_resolver,
    )
    external_routes.set_service(service)
    app = FastAPI()
    app.include_router(external_router)
    app.include_router(tiles_router)
    try:
        with TestClient(app, headers={"X-DNAForge-Session": token}) as client:
            reads = client.post(
                "/external/htsget/prepare",
                json={
                    "endpoint": "https://htsget.example.org",
                    "resource_id": "sample",
                    "data_class": "reads",
                    "format": "BAM",
                    "references": [{"name": "chr1", "length": 1_000}],
                },
            )
            assert reads.status_code == 200, reads.text
            prepared_reads = reads.json()
            assert set(prepared_reads) == {
                "source_token",
                "source_identity",
                "data_class",
                "format",
                "references",
                "matched_references",
                "samples",
                "assembly_revision",
                "expires_in_seconds",
            }
            assert "url" not in reads.text.casefold()
            assert "authorization" not in reads.text.casefold()

            source_fields = {
                "htsgetToken": prepared_reads["source_token"],
                "htsgetSourceIdentity": prepared_reads["source_identity"],
                "htsgetFormat": "BAM",
            }
            header = client.post("/tiles/alignment/header", json=source_fields)
            assert header.status_code == 200, header.text
            assert header.json()["references"] == [
                {"name": "chr1", "length": 1_000, "md5": None}
            ]
            assert header.json()["index"] == {"state": "present"}

            alignment = client.post(
                "/tiles/alignment/0/0",
                json={**source_fields, "chrom": "chr1", "chromGlobalStart": 0},
            )
            assert alignment.status_code == 200, alignment.text
            assert alignment.json()["count"] == 1
            assert alignment.json()["reads"][0]["readId"] == "read-1"

            coverage = client.post(
                "/tiles/coverage/0/0",
                json={**source_fields, "chrom": "chr1", "chromGlobalStart": 0},
            )
            assert coverage.status_code == 200, coverage.text
            assert coverage.json()["maxDepth"] == 1.0

            assembly_coverage = client.post(
                "/tiles/coverage-assembly/0/0",
                json={
                    **source_fields,
                    "segments": [
                        {
                            "chrom": "chr1",
                            "start": 0,
                            "end": 1_000,
                            "chromGlobalStart": 0,
                        }
                    ],
                },
            )
            assert assembly_coverage.status_code == 200, assembly_coverage.text
            assert assembly_coverage.json()["maxDepth"] == 1.0
            assert assembly_coverage.json()["provenance"] == {
                "method": "htsget-regional",
                "exact": True,
            }

            unsupported_requests = (
                (
                    "/tiles/coverage/readiness",
                    {**source_fields, "chroms": ["chr1"]},
                ),
                (
                    "/tiles/coverage/precompute",
                    {**source_fields, "chroms": ["chr1"]},
                ),
                (
                    "/tiles/coverage-corridor-floor",
                    {
                        **source_fields,
                        "segments": [
                            {
                                "chrom": "chr1",
                                "start": 0,
                                "end": 1_000,
                                "chromGlobalStart": 0,
                            }
                        ],
                    },
                ),
            )
            for path, payload in unsupported_requests:
                unsupported = client.post(path, json=payload)
                assert unsupported.status_code == 422, unsupported.text
                assert "unavailable for htsget" in unsupported.text

            variants = client.post(
                "/external/htsget/prepare",
                json={
                    "endpoint": "https://htsget.example.org",
                    "resource_id": "cohort",
                    "data_class": "variants",
                    "format": "VCF",
                    "references": [{"name": "chr1", "length": 1_000}],
                },
            )
            assert variants.status_code == 200, variants.text
            prepared_variants = variants.json()
            page = client.post(
                "/external/htsget/variants/page",
                json={
                    "source_token": prepared_variants["source_token"],
                    "source_identity": prepared_variants["source_identity"],
                    "assembly_revision": prepared_variants["assembly_revision"],
                    "references": [{"name": "chr1", "length": 1_000}],
                    "cursor": None,
                    "limit": 100,
                },
            )
            assert page.status_code == 200, page.text
            assert [row["recordId"] for row in page.json()["variants"]] == [
                "rs-one",
                "rs-two",
            ]
            region = client.post(
                "/external/htsget/variants/region",
                json={
                    "source_token": prepared_variants["source_token"],
                    "source_identity": prepared_variants["source_identity"],
                    "assembly_revision": prepared_variants["assembly_revision"],
                    "references": [{"name": "chr1", "length": 1_000}],
                    "chrom": "chr1",
                    "start": 90,
                    "end": 150,
                    "limit": 10_000,
                },
            )
            assert region.status_code == 200, region.text
            assert [row["recordId"] for row in region.json()["variants"]] == ["rs-one"]
            assert region.json()["truncated"] is False
        assert regional_queries
        assert all("start" in query and "end" in query for query in regional_queries)
    finally:
        import asyncio

        asyncio.run(service.aclose())
        store.close()
        external_routes.set_service(None)  # type: ignore[arg-type]
