"""Remote native reads must leave the serving Python process responsive."""

import json
import os
import signal
import subprocess
import sys
import time
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path

import pysam
import pytest

_CHILD = r"""
import asyncio, json, sys, threading, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from src.routes import tiles
from src.concurrency.pools import get_pool_manager

def native_ready():
    startup=Path(sys.argv[3])
    (startup/f'{os.getpid()}.ready').write_text('ready')
    while not (startup/'go').exists():
        time.sleep(0.005)

def observed_tile_worker(*args):
    from src.services import alignment_tiles,pileup
    original_header=pileup._open_alignment
    original_reader=alignment_tiles._open_alignment
    opened=[]
    def header(*values):
        opened.append('header')
        return original_header(*values)
    def reader(*values):
        opened.append('reader')
        return original_reader(*values)
    pileup._open_alignment=header
    alignment_tiles._open_alignment=reader
    try:
        native_ready()
        value=tiles._compute_alignment_tile(*args)
        return {**value,'nativeOpenCount':len(opened)}
    finally:
        pileup._open_alignment=original_header
        alignment_tiles._open_alignment=original_reader

def observed_header_worker(*args):
    from src.services import pileup
    native_ready()
    return tiles._compute_alignment_header(*args)

def observed_read_worker(*args):
    from src.services import alignment_tiles
    native_ready()
    return tiles._compute_alignment_read(*args)

data_capacity=get_pool_manager().get('tile_io').config.size
blocked_entered=threading.Event()
blocked_release=threading.Event()
blocked_lock=threading.Lock()
blocked_count=0

class RangeHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass
    def do_GET(self):
        global blocked_count
        if self.path=='/blocked.bam':
            with blocked_lock:
                blocked_count+=1
                if blocked_count>=data_capacity:blocked_entered.set()
            blocked_release.wait(4)
        payload=Path(sys.argv[1]).read_bytes()
        first,last=0,len(payload)-1
        value=self.headers.get('Range')
        if value:
            bounds=value.removeprefix('bytes=').split('-')
            first=int(bounds[0]) if bounds[0] else max(0,len(payload)-int(bounds[1]))
            last=min(last,int(bounds[1])) if bounds[0] and bounds[1] else last
        content=payload[first:last+1]
        self.send_response(206 if value else 200)
        self.send_header('Content-Length',str(len(content)))
        self.send_header('Accept-Ranges','bytes')
        if value:self.send_header('Content-Range',f'bytes {first}-{last}/{len(payload)}')
        self.end_headers()
        self.wfile.write(content)

class RangeServer(ThreadingHTTPServer):
    # Admit the full data burst plus the independent control connection.
    request_queue_size=max(ThreadingHTTPServer.request_queue_size,data_capacity+1)

async def release_native(jobs, expected):
    startup=Path(sys.argv[3])
    while len(list(startup.glob('*.ready')))<expected:
        for job in jobs:
            if job.done():
                await job
                raise AssertionError('Native work exited before the startup barrier')
        await asyncio.sleep(0.005)
    (startup/'ready').write_text('ready')
    while not (startup/'go').exists():
        await asyncio.sleep(0.005)

async def run():
    server=RangeServer(('127.0.0.1',0),RangeHandler)
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    source=dict(bamPath=f'http://127.0.0.1:{server.server_port}/reads.bam', indexPath=sys.argv[1]+'.bai')
    kind=sys.argv[2]
    if kind=='control':
        await tiles.alignment_header_route(tiles._AlignmentHeaderBody(**source))
        tiles._compute_alignment_tile=observed_tile_worker
        startup=Path(sys.argv[3])
        stalled={**source,'bamPath':source['bamPath'].replace('/reads.bam','/blocked.bam')}
        jobs=[asyncio.create_task(tiles.alignment_tile_route(0,0,tiles._TileSourceBody(**stalled,chrom='chr1'))) for _ in range(data_capacity)]
        try:
            await release_native(jobs,data_capacity)
            assert await asyncio.to_thread(blocked_entered.wait,2),f'All {data_capacity} admitted native data workers must be occupied; observed {blocked_count} blocked HTTP requests; jobs={[(job.done(),repr(job.exception()) if job.done() and not job.cancelled() else None) for job in jobs]}'
            result=await asyncio.wait_for(tiles.alignment_header_route(tiles._AlignmentHeaderBody(**source)),2)
            assert not blocked_release.is_set(),'Header completed while every admitted data read stayed blocked'
        finally:
            (startup/'go').write_text('go')
            blocked_release.set()
        await asyncio.gather(*jobs)
    elif kind=='tile':
        tiles._compute_alignment_tile=observed_tile_worker
        job=asyncio.create_task(tiles.alignment_tile_route(0,0,tiles._TileSourceBody(**source,chrom='chr1')))
        await release_native([job],1)
        result=await job
    elif kind=='header':
        tiles._compute_alignment_header=observed_header_worker
        job=asyncio.create_task(tiles.alignment_header_route(tiles._AlignmentHeaderBody(**source)))
        await release_native([job],1)
        result=await job
    else:
        tiles._compute_alignment_read=observed_read_worker
        job=asyncio.create_task(tiles.alignment_read_route(tiles._AlignmentReadBody(**source,chrom='chr1',readId='read1',referenceStart=10,flag=0)))
        await release_native([job],1)
        result=await job
    print(json.dumps({'status':result.status_code,'payload':json.loads(result.body)}),flush=True)
    server.shutdown()
    server.server_close()

if __name__=='__main__': asyncio.run(run())
"""


@pytest.mark.parametrize("kind", ["tile", "header", "read", "control"])
def test_real_remote_native_read_does_not_deadlock_its_range_server(tmp_path, kind):
    bam = tmp_path / "reads.bam"
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": "chr1", "LN": 10_000}],
    }
    with pysam.AlignmentFile(bam, "wb", header=header) as writer:
        read = pysam.AlignedSegment()
        read.query_name = "read1"
        read.query_sequence = "A" * 20
        read.flag = 0
        read.reference_id = 0
        read.reference_start = 10
        read.mapping_quality = 60
        read.cigar = [(0, 20)]
        read.set_tag("NM", 0)
        writer.write(read)
    pysam.index(str(bam))
    script = tmp_path / "native_remote_read.py"
    script.write_text(_CHILD)
    startup = tmp_path / "native-startup"
    startup.mkdir()
    api_root = Path(__file__).resolve().parents[1]
    process = subprocess.Popen(
        [sys.executable, str(script), str(bam), kind, str(startup)],
        cwd=api_root,
        env={**os.environ, "PYTHONPATH": str(api_root)},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        startup_deadline = time.monotonic() + 30
        while not (startup / "ready").exists():
            if process.poll() is not None:
                stdout, stderr = process.communicate(timeout=1)
                pytest.fail(
                    f"Native test setup exited before readiness: {stdout}\n{stderr}"
                )
            if time.monotonic() >= startup_deadline:
                pytest.fail("Native test setup did not reach its startup barrier")
            time.sleep(0.01)
        (startup / "go").write_text("go")
        try:
            stdout, stderr = process.communicate(timeout=6)
        except subprocess.TimeoutExpired:
            pytest.fail(
                "Remote native read blocked the Python range server for six seconds"
            )
        (tmp_path / "native.stdout").write_text(stdout)
        (tmp_path / "native.stderr").write_text(stderr)
        assert process.returncode == 0, stderr[-3000:]
        result = json.loads(stdout.strip().splitlines()[-1])
        assert result["status"] == 200
        if kind == "tile":
            assert result["payload"]["nativeOpenCount"] == 1
            assert result["payload"]["count"] == 1
            assert result["payload"]["start"] == 0
            assert result["payload"]["end"] == 1024
        elif kind in ("header", "control"):
            assert result["payload"]["references"][0]["name"] == "chr1"
            assert result["payload"]["index"]["state"] == "present"
        else:
            assert result["payload"]["readId"] == "read1"
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=2)


async def test_a_crashed_data_worker_does_not_poison_later_admitted_requests():
    from src.services import remote_htslib_process

    try:
        with pytest.raises(BrokenProcessPool):
            await remote_htslib_process.run_remote_htslib(os._exit, 17)
        worker_pid = await remote_htslib_process.run_remote_htslib(os.getpid)
        assert worker_pid != os.getpid()
        assert worker_pid > 0
    finally:
        remote_htslib_process._shutdown()


def _record_worker_then_wait(started_dir: str, release_path: str):
    Path(started_dir, str(os.getpid())).write_text("started")
    deadline = time.monotonic() + 8
    while not Path(release_path).exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    return os.getpid()


async def test_remote_alignment_execution_matches_its_admitted_capacity(tmp_path):
    import asyncio

    from src.concurrency.pools import get_pool_manager
    from src.concurrency.schema import PoolName
    from src.routes import tiles
    from src.services import remote_htslib_process

    capacity = get_pool_manager().get(PoolName.TILE_IO.value).config.size
    started = tmp_path / "started"
    started.mkdir()
    release = tmp_path / "release"
    jobs = [
        asyncio.create_task(
            tiles._run_alignment_native(
                "http://127.0.0.1/reads.bam",
                _record_worker_then_wait,
                str(started),
                str(release),
            )
        )
        for _ in range(capacity)
    ]
    try:
        deadline = time.monotonic() + 5
        while len(list(started.iterdir())) < capacity and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
        assert len(list(started.iterdir())) == capacity
    finally:
        release.write_text("release")
        await asyncio.gather(*jobs)
        remote_htslib_process._shutdown()


def _observed_alignment_worker(*args):
    """Publish the owned PID before entering an actual native HTTP read."""
    from urllib.parse import parse_qs, urlsplit

    from src.routes import tiles

    parsed = urlsplit(args[0])
    owner_path = parse_qs(parsed.query)["owner"][0]
    Path(owner_path).write_text(str(os.getpid()))
    if parsed.path == "/blocked.bam":

        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    return tiles._compute_alignment_tile(*args)


def _large_alignment_result(size):
    return b"alignment-result" * size


def _observed_alignment_read_worker(*args):
    from urllib.parse import parse_qs, urlsplit

    from src.routes import tiles

    parsed = urlsplit(args[0])
    Path(parse_qs(parsed.query)["owner"][0]).write_text(str(os.getpid()))
    if parsed.path == "/blocked.bam":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    return tiles._compute_alignment_read(*args)


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def _eventually(predicate, message, timeout=4):
    import asyncio

    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    assert predicate(), message


@pytest.fixture
def cancellable_alignment_range_server(tmp_path):
    import select
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlsplit

    bam = tmp_path / "cancel.bam"
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": "chr1", "LN": 10_000}],
    }
    with pysam.AlignmentFile(bam, "wb", header=header) as writer:
        read = pysam.AlignedSegment()
        read.query_name = "read1"
        read.query_sequence = "A" * 20
        read.flag = 0
        read.reference_id = 0
        read.reference_start = 10
        read.mapping_quality = 60
        read.cigar = [(0, 20)]
        read.set_tag("NM", 0)
        writer.write(read)
    pysam.index(str(bam))
    payload = bam.read_bytes()
    entered = {name: threading.Event() for name in ["blocked", "sibling", "queued"]}
    closed = {name: threading.Event() for name in ["blocked", "sibling"]}
    release = {name: threading.Event() for name in ["blocked", "sibling"]}

    class RangeHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            name = urlsplit(self.path).path.removeprefix("/").removesuffix(".bam")
            value = self.headers.get("Range")
            first, last = 0, len(payload) - 1
            if value:
                bounds = value.removeprefix("bytes=").split("-")
                first = (
                    int(bounds[0])
                    if bounds[0]
                    else max(0, len(payload) - int(bounds[1]))
                )
                last = min(last, int(bounds[1])) if bounds[0] and bounds[1] else last
            content = payload[first : last + 1]
            self.send_response(206 if value else 200)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Accept-Ranges", "bytes")
            if value:
                self.send_header(
                    "Content-Range", f"bytes {first}-{last}/{len(payload)}"
                )
            self.end_headers()
            if name in entered:
                entered[name].set()
            try:
                if name in release and not release[name].is_set():

                    while not release[name].is_set():
                        readable, _, _ = select.select([self.connection], [], [], 0.01)
                        if readable and self.connection.recv(1) == b"":
                            closed[name].set()
                            return
                self.wfile.write(content)
            except (BrokenPipeError, ConnectionResetError, OSError):
                if name in closed:
                    closed[name].set()

    server = ThreadingHTTPServer(("127.0.0.1", 0), RangeHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state = {
        "base": f"http://127.0.0.1:{server.server_port}",
        "index": str(bam) + ".bai",
        "entered": entered,
        "closed": closed,
        "release": release,
    }
    try:
        yield state
    finally:
        for event in release.values():
            event.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _cancellation_source(server, name, owner_path):
    from urllib.parse import urlencode

    return {
        "bamPath": server["base"]
        + f"/{name}.bam?"
        + urlencode({"owner": str(owner_path)}),
        "indexPath": server["index"],
        "chrom": "chr1",
    }


async def test_cancelled_native_alignment_reaps_its_child_before_releasing_capacity(
    tmp_path, monkeypatch, cancellable_alignment_range_server
):
    import asyncio

    from src.concurrency.pools import PoolConfig, reset_pool_manager
    from src.routes import tiles
    from src.services import remote_htslib_process

    remote_htslib_process._shutdown()
    manager = reset_pool_manager([PoolConfig("tile_io", 2, 8, "asyncio")])
    monkeypatch.setattr(tiles, "_compute_alignment_tile", _observed_alignment_worker)
    server = cancellable_alignment_range_server
    blocked_pid_file, sibling_pid_file = (
        tmp_path / "blocked.pid",
        tmp_path / "sibling.pid",
    )
    blocked = asyncio.create_task(
        tiles.alignment_tile_route(
            0,
            0,
            tiles._TileSourceBody(
                **_cancellation_source(server, "blocked", blocked_pid_file)
            ),
        )
    )
    sibling = asyncio.create_task(
        tiles.alignment_tile_route(
            0,
            0,
            tiles._TileSourceBody(
                **_cancellation_source(server, "sibling", sibling_pid_file)
            ),
        )
    )
    try:
        await _eventually(
            lambda: server["entered"]["blocked"].is_set(),
            "Native blocked read started",
            timeout=30,
        )
        await _eventually(
            lambda: server["entered"]["sibling"].is_set(),
            "Native sibling read started",
            timeout=30,
        )
        blocked_pid, sibling_pid = (
            int(blocked_pid_file.read_text()),
            int(sibling_pid_file.read_text()),
        )
        assert _pid_alive(blocked_pid) and _pid_alive(sibling_pid)
        assert manager.get("tile_io").stats()["active"] == 2
        blocked.cancel()
        await asyncio.sleep(0.03)
        blocked.cancel()
        assert (
            manager.get("tile_io").stats()["active"] == 2
        ), "Hold admission until physical child exit"
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(blocked, 3)
        assert not _pid_alive(
            blocked_pid
        ), "Cancelled native child must be physically reaped"
        await _eventually(
            lambda: server["closed"]["blocked"].is_set(),
            "Cancelled native range closed",
        )
        assert manager.get("tile_io").stats()["active"] == 1
        assert _pid_alive(
            sibling_pid
        ), "Cancelling one read must preserve the sibling child"
        server["release"]["sibling"].set()
        result = await asyncio.wait_for(sibling, 3)
        assert result.status_code == 200
        assert json.loads(result.body)["count"] == 1
        assert not _pid_alive(sibling_pid)
        assert manager.get("tile_io").stats()["active"] == 0
    finally:
        for event in server["release"].values():
            event.set()
        blocked.cancel()
        sibling.cancel()
        await asyncio.gather(blocked, sibling, return_exceptions=True)
        remote_htslib_process._shutdown()


@pytest.mark.parametrize("disconnect_stage", ["queued", "running"])
@pytest.mark.parametrize("kind", ["tile", "read"])
async def test_actual_http_disconnect_stops_remote_alignment_ownership(
    tmp_path, monkeypatch, cancellable_alignment_range_server, disconnect_stage, kind
):
    import asyncio
    import socket
    import threading

    import httpx
    import uvicorn
    from fastapi import FastAPI

    from src.concurrency.pools import PoolConfig, reset_pool_manager
    from src.routes import tiles
    from src.services import remote_htslib_process

    remote_htslib_process._shutdown()
    manager = reset_pool_manager([PoolConfig("tile_io", 2, 8, "asyncio")])
    monkeypatch.setattr(tiles, "_compute_alignment_tile", _observed_alignment_worker)
    monkeypatch.setattr(
        tiles, "_compute_alignment_read", _observed_alignment_read_worker
    )
    app = FastAPI()
    app.include_router(tiles.router)
    listener = socket.create_server(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    api = uvicorn.Server(uvicorn.Config(app, log_level="critical", lifespan="off"))
    thread = threading.Thread(target=lambda: api.run(sockets=[listener]), daemon=True)
    thread.start()
    server = cancellable_alignment_range_server
    blocked_pid_file, sibling_pid_file = (
        tmp_path / "blocked-http.pid",
        tmp_path / "sibling-http.pid",
    )
    queued_pid_file = tmp_path / "queued-http.pid"
    writers = []
    readers = []
    sibling = None
    route = "/tiles/alignment/0/0" if kind == "tile" else "/tiles/alignment/read"

    def source(name, owner_path):
        body = _cancellation_source(server, name, owner_path)
        if kind == "read":
            body.update(readId="read1", referenceStart=10, flag=0)
        return body

    async def post_without_reading(body):
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        readers.append(reader)
        writers.append(writer)
        encoded = json.dumps(body).encode()
        writer.write(
            f"POST {route} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n".encode()
            + f"Content-Length: {len(encoded)}\r\nConnection: close\r\n\r\n".encode()
            + encoded
        )
        await writer.drain()
        return writer

    try:
        await _eventually(lambda: api.started, "Owned HTTP server started")
        async with httpx.AsyncClient(timeout=httpx.Timeout(5, read=30)) as client:
            blocked_writer = await post_without_reading(
                source("blocked", blocked_pid_file)
            )
            sibling = asyncio.create_task(
                client.post(
                    f"http://127.0.0.1:{port}{route}",
                    json=source("sibling", sibling_pid_file),
                )
            )
            await _eventually(
                lambda: server["entered"]["blocked"].is_set(),
                "Blocked HTTP native read started",
                timeout=30,
            )
            await _eventually(
                lambda: server["entered"]["sibling"].is_set(),
                "Sibling HTTP native read started",
                timeout=30,
            )
            blocked_pid, sibling_pid = (
                int(blocked_pid_file.read_text()),
                int(sibling_pid_file.read_text()),
            )
            if disconnect_stage == "queued":
                queued_writer = await post_without_reading(
                    source("queued", queued_pid_file)
                )
                await _eventually(
                    lambda: manager.get("tile_io").stats()["queued"] == 1,
                    "Third request queued",
                )
                queued_writer.close()
                await queued_writer.wait_closed()
                await _eventually(
                    lambda: manager.get("tile_io").stats()["queued"] == 0,
                    "Disconnected queued request removed",
                )
                assert (
                    not queued_pid_file.exists()
                ), "Disconnected queued request must never spawn a child"
                assert not server["entered"]["queued"].is_set()
            blocked_writer.close()
            await blocked_writer.wait_closed()
            await _eventually(
                lambda: not _pid_alive(blocked_pid),
                "Actual HTTP disconnect reaped native child",
            )
            await _eventually(
                lambda: server["closed"]["blocked"].is_set(),
                "HTTP disconnect closed the native range",
            )
            await _eventually(
                lambda: manager.get("tile_io").stats()["active"] == 1,
                "Only healthy sibling owns capacity",
            )
            assert _pid_alive(sibling_pid)
            server["release"]["sibling"].set()
            result = await asyncio.wait_for(sibling, 3)
            assert result.status_code == 200
            if kind == "tile":
                assert result.json()["count"] == 1
            else:
                assert result.json()["readId"] == "read1"
            await _eventually(
                lambda: manager.get("tile_io").stats()["active"] == 0,
                "All children reaped",
            )
            assert not _pid_alive(sibling_pid)
            assert not queued_pid_file.exists()
    finally:
        for event in server["release"].values():
            event.set()
        for writer in writers:
            writer.close()
        if sibling is not None:
            await asyncio.gather(sibling, return_exceptions=True)
        api.should_exit = True
        await asyncio.to_thread(thread.join, 4)
        listener.close()
        remote_htslib_process._shutdown()


async def test_alignment_child_drains_large_result_before_reaping():
    import asyncio

    from src.services import remote_htslib_process

    expected = b"alignment-result" * 1_000_000
    try:
        result = await asyncio.wait_for(
            remote_htslib_process.run_remote_htslib(
                _large_alignment_result, 1_000_000, pool="alignment"
            ),
            timeout=5,
        )
        assert result == expected
    finally:
        remote_htslib_process._shutdown()


async def test_fatal_alignment_child_does_not_poison_a_fresh_request():
    from src.services import remote_htslib_process

    try:
        with pytest.raises(BrokenProcessPool):
            await remote_htslib_process.run_remote_htslib(
                os._exit, 17, pool="alignment"
            )
        fresh_pid = await remote_htslib_process.run_remote_htslib(
            os.getpid, pool="alignment"
        )
        assert fresh_pid > 0 and fresh_pid != os.getpid()
    finally:
        remote_htslib_process._shutdown()


@pytest.mark.parametrize("executor_load", ["native-receivers", "unrelated-work"])
@pytest.mark.parametrize("stop_reason", ["cancellation", "shutdown"])
async def test_alignment_cancellation_reaps_without_free_default_executor_threads(
    tmp_path, cancellable_alignment_range_server, executor_load, stop_reason
):
    import asyncio
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from src.concurrency.pools import PoolConfig, reset_pool_manager
    from src.services import remote_htslib_process

    remote_htslib_process._shutdown()
    manager = reset_pool_manager([PoolConfig("tile_io", 2, 8, "asyncio")])
    loop = asyncio.get_running_loop()
    previous_executor = loop._default_executor
    executor = ThreadPoolExecutor(max_workers=2)
    loop.set_default_executor(executor)
    unrelated_release = threading.Event()
    unrelated_started = [threading.Event(), threading.Event()]
    unrelated = []
    jobs = []
    server = cancellable_alignment_range_server
    pid_files = [tmp_path / "starved-blocked.pid", tmp_path / "starved-sibling.pid"]

    def unrelated_work(entered):
        entered.set()
        unrelated_release.wait()

    async def admitted_native(name, pid_file):
        source = _cancellation_source(server, name, pid_file)
        async with manager.get("tile_io").slot():
            return await remote_htslib_process.run_remote_htslib(
                _observed_alignment_worker,
                source["bamPath"],
                "chr1",
                source["indexPath"],
                None,
                0,
                0,
                0,
                False,
                pool="alignment",
            )

    try:
        if executor_load == "unrelated-work":
            unrelated = [
                asyncio.create_task(asyncio.to_thread(unrelated_work, entered))
                for entered in unrelated_started
            ]
            await _eventually(
                lambda: all(entered.is_set() for entered in unrelated_started),
                "Both default executor threads are occupied by unrelated work",
            )
        jobs = [
            asyncio.create_task(admitted_native(name, pid_file))
            for name, pid_file in zip(["blocked", "sibling"], pid_files, strict=True)
        ]
        await _eventually(
            lambda: all(
                server["entered"][name].is_set() for name in ["blocked", "sibling"]
            ),
            "Both genuine native range reads started while their parent waits for results",
            timeout=30,
        )
        pids = [int(path.read_text()) for path in pid_files]
        assert all(_pid_alive(pid) for pid in pids)
        assert manager.get("tile_io").stats()["active"] == 2
        if stop_reason == "shutdown":
            remote_htslib_process._shutdown()
            assert not any(
                _pid_alive(pid) for pid in pids
            ), "Shutdown physically reaps its children"
        for job in jobs:
            job.cancel()
        await asyncio.sleep(0.03)
        for job in jobs:
            job.cancel()
        await _eventually(
            lambda: not any(_pid_alive(pid) for pid in pids),
            "Native children must be reaped without any free default executor thread",
            timeout=2,
        )
        await _eventually(
            lambda: all(job.done() for job in jobs),
            "Cleanup must not wait for a queued receiver after the child is reaped",
            timeout=2,
        )
        assert all(job.cancelled() for job in jobs)
        assert manager.get("tile_io").stats()["active"] == 0
        await _eventually(
            lambda: all(
                server["closed"][name].is_set() for name in ["blocked", "sibling"]
            ),
            "Both native range connections closed",
        )
        assert not any(event.is_set() for event in server["release"].values())
        assert not unrelated_release.is_set()
        if executor_load == "unrelated-work":
            assert not any(job.done() for job in unrelated)
    finally:
        unrelated_release.set()
        for event in server["release"].values():
            event.set()
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, *unrelated, return_exceptions=True)
        remote_htslib_process._shutdown()
        loop.set_default_executor(previous_executor or ThreadPoolExecutor())
        executor.shutdown(wait=True, cancel_futures=True)
