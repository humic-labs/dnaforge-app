from __future__ import annotations

import asyncio
import socket
import threading
import time
from pathlib import Path

import httpx
import pysam
import pysam.bcftools
import pytest
import uvicorn
from fastapi import FastAPI

from src.control_plane.store import ControlPlaneStore
from src.external.service import ExternalResourcesService
from src.routes import external as external_routes
from src.routes.external import router as external_router
from src.security.local_access import LocalAccessMiddleware


async def _public_resolver(
    _host: str, _port: int, *, type: socket.SocketKind
) -> list[tuple]:
    assert type == socket.SOCK_STREAM
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))]


def _write_variant_fixture(tmp_path: Path, source_format: str) -> tuple[Path, Path]:
    header = pysam.VariantHeader()
    header.add_meta("fileformat", value="VCFv4.3")
    header.contigs.add("chr1", length=1_000)
    header.formats.add("GT", 1, "String", "Genotype")
    header.add_sample("tumor")
    source = tmp_path / ("sample.vcf.gz" if source_format == "vcf" else "sample.bcf")
    mode = "wz" if source_format == "vcf" else "wb"
    with pysam.VariantFile(str(source), mode, header=header) as writer:
        record = writer.new_record(
            contig="chr1",
            start=99,
            stop=100,
            id="rs-test",
            alleles=("A", "T"),
            qual=60,
            filter="PASS",
        )
        record.samples["tumor"]["GT"] = (0, 1)
        writer.write(record)
    if source_format == "vcf":
        pysam.tabix_index(str(source), preset="vcf", force=True)
        index = Path(f"{source}.tbi")
    else:
        pysam.bcftools.index("--force", str(source))
        index = Path(f"{source}.csi")
    assert source.is_file()
    assert index.is_file()
    return source, index


@pytest.mark.parametrize(
    ("source_format", "index_format"), [("vcf", "tbi"), ("bcf", "csi")]
)
def test_remote_variant_routes_stream_native_vcf_and_bcf_without_persisting_grants(
    tmp_path: Path,
    monkeypatch,
    source_format: str,
    index_format: str,
):
    source_path, index_path = _write_variant_fixture(tmp_path, source_format)
    source_name = source_path.name
    index_name = index_path.name
    payloads = {
        f"/{source_name}": source_path.read_bytes(),
        f"/{index_name}": index_path.read_bytes(),
    }
    upstream_requests: list[tuple[str, str, str | None]] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        upstream_requests.append(
            (request.method, request.url.path, request.headers.get("range"))
        )
        payload = payloads[request.url.path]
        headers = {
            "Content-Length": str(len(payload)),
            "Accept-Ranges": "bytes",
            "ETag": f'"{request.url.path}-v1"',
        }
        if request.method == "HEAD" or "range" not in request.headers:
            return httpx.Response(
                200,
                content=b"" if request.method == "HEAD" else payload,
                headers=headers,
            )
        start_text, end_text = (
            request.headers["range"].removeprefix("bytes=").split("-", 1)
        )
        if start_text:
            start = int(start_text)
            end = int(end_text) if end_text else len(payload) - 1
        else:
            length = int(end_text)
            start = max(0, len(payload) - length)
            end = len(payload) - 1
        end = min(end, len(payload) - 1)
        content = payload[start : end + 1]
        return httpx.Response(
            206,
            content=content,
            headers={
                **headers,
                "Content-Length": str(len(content)),
                "Content-Range": f"bytes {start}-{end}/{len(payload)}",
            },
        )

    token = f"remote-{source_format}-session"
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", token)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "*")
    store = ControlPlaneStore(tmp_path / f"remote-{source_format}.sqlite3")
    store.initialize()
    upstream_client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    service = ExternalResourcesService(
        store,
        client=upstream_client,
        remote_range_resolver=_public_resolver,
    )
    external_routes.set_service(service)
    app = FastAPI()
    proxy_requests: list[tuple[str, str | None, int]] = []

    @app.middleware("http")
    async def observe_proxy_requests(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/external/range-proxy/"):
            proxy_requests.append(
                (request.method, request.headers.get("range"), response.status_code)
            )
        return response

    app.include_router(external_router)
    app.add_middleware(LocalAccessMiddleware)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(app, log_level="error", access_log=False, lifespan="off")
    )
    thread = threading.Thread(
        target=lambda: server.run(sockets=[listener]), daemon=True
    )
    thread.start()
    deadline = time.monotonic() + 5
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    assert server.started

    try:
        with httpx.Client(
            base_url=f"http://127.0.0.1:{port}",
            headers={"X-DNAForge-Session": token},
            timeout=10,
        ) as client:
            grants = []
            for filename, format_id in (
                (source_name, source_format),
                (index_name, index_format),
            ):
                response = client.post(
                    "/external/indexed-tracks/admit",
                    json={
                        "source_kind": "url",
                        "source": f"https://variants.example.org/{filename}",
                        "format_id": format_id,
                        "provenance_id": f"remote-variant:{format_id}",
                        "granted_capabilities": ["external-fetch:annotation"],
                    },
                )
                assert response.status_code == 200, response.text
                grants.append(response.json())

            prepare = client.post(
                "/external/indexed-variants/prepare",
                json={
                    "source_token": grants[0]["source_token"],
                    "index_token": grants[1]["source_token"],
                    "references": [{"name": "chr1", "length": 1_000}],
                },
            )
            assert prepare.status_code == 200, prepare.text
            prepared = prepare.json()
            assert prepared["format"] == source_format
            assert prepared["matched_references"] == ["chr1"]
            assert prepared["samples"] == ["tumor"]
            assert len(prepared["source_identity"]) == 64

            page = client.post(
                "/external/indexed-variants/page",
                json={
                    "source_token": grants[0]["source_token"],
                    "index_token": grants[1]["source_token"],
                    "source_identity": prepared["source_identity"],
                    "assembly_revision": prepared["assembly_revision"],
                    "references": [{"name": "chr1", "length": 1_000}],
                    "cursor": None,
                    "limit": 100,
                },
            )
            assert page.status_code == 200, page.text
            body = page.json()
            assert body["nextCursor"] is None
            assert body["variants"] == [
                {
                    "id": body["variants"][0]["id"],
                    "recordId": "rs-test",
                    "chrom": "chr1",
                    "start": 99,
                    "end": 100,
                    "position": 100,
                    "ref": "A",
                    "alts": ["T"],
                    "quality": 60.0,
                    "filters": ["PASS"],
                    "variantClass": "substitution",
                    "genotypes": {"tumor": "0/1"},
                }
            ]

            region = client.post(
                "/external/indexed-variants/region",
                json={
                    "source_token": grants[0]["source_token"],
                    "index_token": grants[1]["source_token"],
                    "source_identity": prepared["source_identity"],
                    "assembly_revision": prepared["assembly_revision"],
                    "references": [{"name": "chr1", "length": 1_000}],
                    "chrom": "chr1",
                    "start": 90,
                    "end": 110,
                    "limit": 10_000,
                },
            )
            assert region.status_code == 200, region.text
            assert [row["recordId"] for row in region.json()["variants"]] == ["rs-test"]
            assert region.json()["truncated"] is False

        assert any(method == "GET" for method, _, _ in proxy_requests)
        assert any(range_header is not None for _, range_header, _ in proxy_requests)
        source_requests = [
            request for request in upstream_requests if request[1] == f"/{source_name}"
        ]
        assert all(
            method == "HEAD" or range_header is not None
            for method, _, range_header in source_requests
        )
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        listener.close()
        asyncio.run(service.aclose())
        store.close()
        external_routes.set_service(None)  # type: ignore[arg-type]
