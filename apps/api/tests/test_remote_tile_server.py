"""Headless production HTTP contract; actual files, sockets and calculation."""

from __future__ import annotations

import importlib
import json
import socket
import stat
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pysam
import pytest


@pytest.fixture
def alignment(tmp_path: Path) -> tuple[Path, Path]:
    path = tmp_path / "reads.bam"
    with pysam.AlignmentFile(
        str(path),
        "wb",
        header={
            "HD": {"VN": "1.6", "SO": "coordinate"},
            "SQ": [{"SN": "chr1", "LN": 10000}],
        },
    ) as output:
        read = pysam.AlignedSegment()
        read.query_name = "spliced-original"
        read.query_sequence = "A" * 30
        read.query_qualities = pysam.qualitystring_to_array("I" * 30)
        read.reference_id = 0
        read.reference_start = 100
        read.mapping_quality = 60
        read.cigarstring = "10M100N20M"
        read.set_tag("MD", "30")
        output.write(read)
    pysam.index(str(path))
    return path, Path(str(path) + ".bai")


def server_class():
    return importlib.import_module("src.remote_tile_server").RemoteTileServer


def request(server, path: str, body: object | None = None, *, authorized: bool = True):
    headers = {"Content-Type": "application/json"}
    if authorized:
        headers["X-DNAForge-Session"] = server.receipt["sessionToken"]
    message = urllib.request.Request(
        f"http://127.0.0.1:{server.port}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
    )
    try:
        response = urllib.request.urlopen(message, timeout=3)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, json.loads(response.read()), dict(response.headers)


def source_body(alignment: tuple[Path, Path]) -> dict:
    return {
        "bamPath": str(alignment[0]),
        "indexPath": str(alignment[1]),
        "chrom": "chr1",
        "chromGlobalStart": 0,
    }


def test_serves_real_existing_alignment_calculation(alignment, tmp_path):
    with server_class()(
        *alignment, receipt_path=tmp_path / "connection.json"
    ) as server:
        status, tile, headers = request(
            server, "/tiles/alignment/0/0", source_body(alignment)
        )
        assert status == 200
        assert tile["reads"][0]["readId"] == "spliced-original"
        assert tile["reads"][0]["blocks"] == [
            {"start": 100, "end": 110},
            {"start": 210, "end": 230},
        ]
        assert tile["count"] == 1 and not tile["truncated"]
        assert headers["X-DNAForge-Compute-Pid"] == str(server.pid)


def test_inspects_exact_original_read_and_refuses_missing_identity(alignment, tmp_path):
    with server_class()(
        *alignment, receipt_path=tmp_path / "connection.json"
    ) as server:
        body = {
            "bamPath": str(alignment[0]),
            "indexPath": str(alignment[1]),
            "chrom": "chr1",
            "readId": "spliced-original",
            "referenceStart": 100,
            "flag": 0,
        }
        status, detail, headers = request(server, "/tiles/alignment/read", body)
        assert status == 200
        assert detail["readId"] == "spliced-original"
        assert detail["cigar"] == "10M100N20M"
        assert detail["seq"] == "A" * 30
        assert detail["baseQualities"] == [40] * 30
        assert detail["tags"]["MD"] == "30"
        assert headers["X-DNAForge-Compute-Pid"] == str(server.pid)
        assert (
            request(server, "/tiles/alignment/read", body, authorized=False)[0] == 401
        )
        assert request(server, "/tiles/alignment/read", {**body, "flag": 16})[0] == 404
        with alignment[1].open("ab") as changed:
            changed.write(b"new generation")
        assert request(server, "/tiles/alignment/read", body)[0] == 409


def test_requires_session_before_calculation(alignment, tmp_path):
    with server_class()(
        *alignment, receipt_path=tmp_path / "connection.json"
    ) as server:
        status, _, _ = request(
            server, "/tiles/alignment/0/0", source_body(alignment), authorized=False
        )
        assert status == 401


def test_admitted_header_uses_existing_metadata_and_checks_session_and_generation(
    alignment, tmp_path
):
    with server_class()(
        *alignment, receipt_path=tmp_path / "connection.json"
    ) as server:
        body = {"bamPath": str(alignment[0]), "indexPath": str(alignment[1])}
        route = "/tiles/alignment/header"
        assert request(server, route, body, authorized=False)[0] == 401
        status, header, headers = request(server, route, body)
        assert status == 200
        assert header == server.header
        assert header["references"] == [{"name": "chr1", "length": 10000, "md5": None}]
        assert header["index"]["state"] == "present"
        assert headers["X-DNAForge-Compute-Pid"] == str(server.pid)
        assert (
            request(server, route, {**body, "bamPath": "/another/source.bam"})[0] == 422
        )
        with alignment[1].open("ab") as changed:
            changed.write(b"new generation")
        assert request(server, route, body)[0] == 409


def test_normal_viewport_burst_waits_for_bounded_compute_slots(
    alignment, tmp_path, monkeypatch
):
    with server_class()(
        *alignment, receipt_path=tmp_path / "connection.json", concurrency=2
    ) as server:
        calculate = server.calculate
        release = threading.Event()

        def hold_slot(*arguments):
            assert release.wait(timeout=2)
            return calculate(*arguments)

        monkeypatch.setattr(server, "calculate", hold_slot)
        timer = threading.Timer(0.2, release.set)
        timer.start()
        with ThreadPoolExecutor(max_workers=6) as clients:
            responses = list(
                clients.map(
                    lambda _: request(
                        server, "/tiles/alignment/0/0", source_body(alignment)
                    ),
                    range(6),
                )
            )
        timer.join()
        assert [status for status, _, _ in responses] == [200] * 6
        assert all(
            tile["reads"][0]["readId"] == "spliced-original" for _, tile, _ in responses
        )


def test_rejects_another_alignment_path(alignment, tmp_path):
    with server_class()(
        *alignment, receipt_path=tmp_path / "connection.json"
    ) as server:
        body = source_body(alignment)
        body["bamPath"] = str(tmp_path / "another.bam")
        assert request(server, "/tiles/alignment/0/0", body)[0] == 422


@pytest.mark.parametrize("member", [0, 1])
def test_changed_file_generation_blocks_old_server(alignment, tmp_path, member):
    with server_class()(
        *alignment, receipt_path=tmp_path / "connection.json"
    ) as server:
        with alignment[member].open("ab") as file:
            file.write(b"changed generation")
        assert request(server, "/tiles/alignment/0/0", source_body(alignment))[0] == 409


def test_private_receipt_and_owned_cleanup(alignment, tmp_path):
    receipt = tmp_path / "connection.json"
    with server_class()(*alignment, receipt_path=receipt) as server:
        assert stat.S_IMODE(receipt.stat().st_mode) == 0o600
        saved = json.loads(receipt.read_text())
        assert saved["contract"] == "dnaforge-remote-tiles.v1"
        assert saved["platform"] and saved["pid"] == server.pid
        assert len(saved["sessionToken"]) >= 32
        port = server.port
    assert not receipt.exists()
    with socket.socket() as fresh:
        fresh.bind(("127.0.0.1", port))


def test_packaged_server_has_no_desktop_control_plane_dependency(tmp_path):
    from scripts.build_hpc_tile_server import build

    artifact = tmp_path / "server.pyz"
    build(artifact)
    code = """
import importlib.abc, sys
class NoDesktopControlPlane(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in ('dnaforge_annotation', 'fastapi'):
            raise ModuleNotFoundError('Desktop control plane must not be loaded: ' + fullname)
sys.meta_path.insert(0, NoDesktopControlPlane())
sys.path.insert(0, sys.argv[1])
from src.remote_tile_server import RemoteTileServer
assert RemoteTileServer.__module__ == 'src.remote_tile_server'
"""
    result = subprocess.run(
        [sys.executable, "-c", code, str(artifact)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
