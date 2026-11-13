from __future__ import annotations

import asyncio
import hashlib
import json
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import pysam
import pytest
import uvicorn
from fastapi import FastAPI
from starlette.testclient import TestClient

from src.control_plane.store import ControlPlaneStore
from src.external.service import ExternalResourcesService
from src.routes import external as external_routes
from src.routes.external import router as external_router
from src.security.local_access import LocalAccessMiddleware
from tests.conftest import anonymous_client


async def _public_resolver(
    _host: str, _port: int, *, type: socket.SocketKind
) -> list[tuple]:
    assert type == socket.SOCK_STREAM
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))]


def test_alignment_proxy_exposes_admitted_ranges_to_headerless_native_htslib(
    tmp_path, monkeypatch
):
    session_token = "remote-alignment-proxy-session"
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", session_token)
    bam = bytes.fromhex("1f8b08040000000000ff0600424302007f00") + bytes(110)
    bai = b"BAI\x01" + bytes(124)
    payloads = {"/sample.bam": bam, "/sample.bam.bai": bai}

    def handler(request: httpx.Request) -> httpx.Response:
        payload = payloads[request.url.path]
        if "range" not in request.headers:
            return httpx.Response(
                200,
                content=payload,
                headers={
                    "Content-Length": str(len(payload)),
                    "Accept-Ranges": "bytes",
                    "ETag": '"alignment-v1"',
                },
            )
        start_text, end_text = (
            request.headers["range"].removeprefix("bytes=").split("-")
        )
        start, end = int(start_text), int(end_text)
        content = payload[start : end + 1]
        return httpx.Response(
            206,
            content=content,
            headers={
                "Content-Range": f"bytes {start}-{end}/{len(payload)}",
                "Content-Length": str(len(content)),
                "Accept-Ranges": "bytes",
                "ETag": '"alignment-v1"',
            },
        )

    store = ControlPlaneStore(tmp_path / "remote-alignment-proxy.sqlite3")
    store.initialize()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(
        store,
        client=http_client,
        remote_range_resolver=_public_resolver,
    )
    external_routes.set_service(service)
    app = FastAPI()
    app.include_router(external_router)
    app.add_middleware(LocalAccessMiddleware)
    authenticated = TestClient(
        app,
        headers={"X-DNAForge-Session": session_token},
    )
    native = anonymous_client(app)

    def admit(source: str, format_id: str) -> dict:
        response = authenticated.post(
            "/external/indexed-tracks/admit",
            json={
                "source_kind": "url",
                "source": source,
                "format_id": format_id,
                "provenance_id": f"test:{format_id}",
                "granted_capabilities": ["external-fetch:annotation"],
            },
        )
        assert response.status_code == 200
        return response.json()

    bam_grant = admit("https://data.example.org/sample.bam", "bam")
    bai_grant = admit("https://data.example.org/sample.bam.bai", "bai")

    bam_path = "/external/range-proxy/source.bam"
    bai_path = "/external/range-proxy/source.bai"
    bam_auth = ("dnaforge-source", bam_grant["source_token"])
    bai_auth = ("dnaforge-source", bai_grant["source_token"])
    head = native.head(bam_path, auth=bam_auth)
    assert head.status_code == 200
    assert head.headers["content-length"] == str(len(bam))
    assert head.headers["accept-ranges"] == "bytes"
    assert head.content == b""

    bam_range = native.get(bam_path, headers={"Range": "bytes=16-31"}, auth=bam_auth)
    assert bam_range.status_code == 206
    assert bam_range.content == bam[16:32]
    assert bam_range.headers["content-range"] == f"bytes 16-31/{len(bam)}"

    bai_range = native.get(bai_path, headers={"Range": "bytes=0-15"}, auth=bai_auth)
    assert bai_range.status_code == 206
    assert bai_range.content == bai[:16]

    ordinary_get = native.get(bam_path, auth=bam_auth)
    assert ordinary_get.status_code == 200
    assert ordinary_get.content == bam

    open_ended = native.get(bam_path, headers={"Range": "bytes=16-"}, auth=bam_auth)
    assert open_ended.status_code == 206
    assert open_ended.content == bam[16:]
    assert open_ended.headers["content-range"] == f"bytes 16-{len(bam) - 1}/{len(bam)}"

    suffix = native.get(bam_path, headers={"Range": "bytes=-8"}, auth=bam_auth)
    assert suffix.status_code == 206
    assert suffix.content == bam[-8:]

    beyond_end = native.get(
        bam_path,
        headers={"Range": f"bytes={len(bam)}-"},
        auth=bam_auth,
    )
    assert beyond_end.status_code == 416
    assert beyond_end.headers["content-range"] == f"bytes */{len(bam)}"

    missing = native.head(
        "/external/range-proxy/source.bam",
        auth=("dnaforge-source", "not-a-real-source-token"),
    )
    assert missing.status_code == 401

    materialized = authenticated.post(
        "/external/indexed-tracks/materialize",
        json={"source_token": bai_grant["source_token"]},
    )
    assert materialized.status_code == 200, materialized.text
    materialized_body = materialized.json()
    materialized_path = Path(materialized_body["source_path"])
    assert materialized_path.read_bytes() == bai
    assert materialized_body["representation_sha256"] == hashlib.sha256(bai).hexdigest()

    asyncio.run(service.aclose())
    assert not materialized_path.exists()
    store.close()
    external_routes.set_service(None)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("alignment_format", "index_format"),
    [("bam", "bai"), ("cram", "crai")],
)
def test_native_pysam_opens_and_queries_an_admitted_remote_alignment(
    tmp_path: Path,
    monkeypatch,
    alignment_format: str,
    index_format: str,
):
    alignment_path = tmp_path / f"sample.{alignment_format}"
    reference_path = tmp_path / "reference.fa"
    if alignment_format == "cram":
        reference_path.write_text(">chr1\n" + ("N" * 1_000) + "\n", encoding="ascii")
        pysam.faidx(str(reference_path))
    with pysam.AlignmentFile(
        str(alignment_path),
        "wb" if alignment_format == "bam" else "wc",
        header={
            "HD": {"VN": "1.6", "SO": "coordinate"},
            "SQ": [{"SN": "chr1", "LN": 1_000}],
        },
        **(
            {"reference_filename": str(reference_path)}
            if alignment_format == "cram"
            else {}
        ),
    ) as writer:
        record = pysam.AlignedSegment()
        record.query_name = "read-1"
        record.query_sequence = "N" * 25
        record.flag = 0
        record.reference_id = 0
        record.reference_start = 100
        record.mapping_quality = 60
        record.cigar = ((0, 25),)
        record.query_qualities = pysam.qualitystring_to_array("I" * 25)
        writer.write(record)
    pysam.index(str(alignment_path))
    index_path = Path(f"{alignment_path}.{index_format}")
    payloads = {
        f"/sample.{alignment_format}": alignment_path.read_bytes(),
        f"/sample.{alignment_format}.{index_format}": index_path.read_bytes(),
    }

    def upstream(request: httpx.Request) -> httpx.Response:
        payload = payloads[request.url.path]
        if "range" not in request.headers:
            return httpx.Response(
                200,
                content=payload,
                headers={
                    "Content-Length": str(len(payload)),
                    "Accept-Ranges": "bytes",
                    "ETag": '"native-bam-v1"',
                },
            )
        start_text, end_text = (
            request.headers["range"].removeprefix("bytes=").split("-")
        )
        start, end = int(start_text), int(end_text)
        content = payload[start : end + 1]
        actual_end = start + len(content) - 1
        return httpx.Response(
            206,
            content=content,
            headers={
                "Content-Range": f"bytes {start}-{actual_end}/{len(payload)}",
                "Content-Length": str(len(content)),
                "Accept-Ranges": "bytes",
                "ETag": '"native-bam-v1"',
            },
        )

    token = "native-pysam-session"
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", token)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "*")
    store = ControlPlaneStore(tmp_path / "native-pysam.sqlite3")
    store.initialize()
    upstream_client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    service = ExternalResourcesService(
        store,
        client=upstream_client,
        remote_range_resolver=_public_resolver,
    )
    external_routes.set_service(service)
    app = FastAPI()
    observed_proxy_requests: list[tuple[str, str, str | None, int]] = []

    @app.middleware("http")
    async def observe_proxy_requests(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/external/range-proxy/"):
            observed_proxy_requests.append(
                (
                    request.method,
                    request.url.path,
                    request.headers.get("range"),
                    response.status_code,
                )
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
        target=lambda: server.run(sockets=[listener]),
        daemon=True,
    )
    thread.start()
    deadline = time.monotonic() + 5
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    assert server.started

    try:
        base_url = f"http://127.0.0.1:{port}"
        with httpx.Client(
            base_url=base_url, headers={"X-DNAForge-Session": token}
        ) as client:
            grants = []
            for filename, format_id in (
                (f"sample.{alignment_format}", alignment_format),
                (f"sample.{alignment_format}.{index_format}", index_format),
            ):
                response = client.post(
                    "/external/indexed-tracks/admit",
                    json={
                        "source_kind": "url",
                        "source": f"https://data.example.org/{filename}",
                        "format_id": format_id,
                        "provenance_id": f"native:{format_id}",
                        "granted_capabilities": ["external-fetch:annotation"],
                    },
                )
                assert response.status_code == 200, response.text
                grants.append(response.json())
            materialized = client.post(
                "/external/indexed-tracks/materialize",
                json={"source_token": grants[1]["source_token"]},
            )
            assert materialized.status_code == 200, materialized.text
            materialized_index_path = materialized.json()["source_path"]
        remote_alignment = (
            f"http://dnaforge-source:{grants[0]['source_token']}@127.0.0.1:{port}"
            f"/external/range-proxy/source.{alignment_format}"
        )
        child_args = [remote_alignment, materialized_index_path]
        if alignment_format == "cram":
            child_args.append(str(reference_path))
        native_workdir = tmp_path / f"native-cwd-{alignment_format}"
        native_workdir.mkdir()
        child = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "import json,sys,pysam; "
                    "k={'index_filename':sys.argv[2]}; "
                    "k.update({'reference_filename':sys.argv[3]} if len(sys.argv)>3 else {}); "
                    "a=pysam.AlignmentFile(sys.argv[1],'rb',**k); "
                    "print(json.dumps({'references':a.references,'reads':"
                    "[r.query_name for r in a.fetch('chr1',90,150)]})); a.close()"
                ),
                *child_args,
            ],
            check=False,
            capture_output=True,
            cwd=native_workdir,
            text=True,
            timeout=10,
        )
        assert child.returncode == 0, {
            "stderr": child.stderr,
            "requests": observed_proxy_requests,
        }
        observed = json.loads(child.stdout)
        assert observed == {"references": ["chr1"], "reads": ["read-1"]}
        assert list(native_workdir.iterdir()) == []
        assert any(
            method == "GET" and range_header is None and response_status == 200
            for method, _, range_header, response_status in observed_proxy_requests
        )
        if alignment_format == "bam":
            assert any(
                method == "GET"
                and range_header is not None
                and range_header.endswith("-")
                and response_status == 206
                for method, _, range_header, response_status in observed_proxy_requests
            )
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        listener.close()
        asyncio.run(service.aclose())
        store.close()
        external_routes.set_service(None)  # type: ignore[arg-type]


def test_range_proxy_schema_exports_one_get_operation() -> None:
    """The exported document must not depend on method-set iteration order.

    The proxy served GET and HEAD from one two-method route, and FastAPI drew
    that route's operation id from the unordered method set, so the exported
    OpenAPI document flipped between ``_get`` and ``_head`` across processes.
    HEAD stays a runtime-only route outside the schema.
    """

    from src.main import app

    operations = app.openapi()["paths"]["/external/range-proxy/{resource_name}"]
    assert list(operations) == ["get"]
    assert (
        operations["get"]["operationId"]
        == "proxy_remote_indexed_source_external_range_proxy__resource_name__get"
    )
