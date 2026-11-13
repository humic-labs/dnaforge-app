import hashlib
import json
import os
import socket
import subprocess
import sys
import threading
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

pytestmark = pytest.mark.slow

BASELINE = "9084694a86f422baf5851cde7a4eace032a42c5f"
BASELINE_FILES = {
    "test_annotation_e2e.py": "d486c7fd3d02b3a8478fc074d5e5db52311f1be31e2625f36f02e7f3830bcbe9",
    "test_sidecar_integration.py": "473f49a6859a37bcc821517c4f1a204a7c6567bd772e67aca0985195565b6dca",
}
SESSION = "synthetic-subprocess-preflight-secret"
API_ROOT = Path(__file__).parents[1]
ANNOTATION_SELECTION = (
    "test_services_endpoint_lists_plannotate or test_plannotate_empty_sequence"
)


@pytest.fixture(autouse=True)
def proof_directory(tmp_path, monkeypatch):
    if "DNAFORGE_PREFLIGHT_PROOF_DIR" not in os.environ:
        monkeypatch.setenv("DNAFORGE_PREFLIGHT_PROOF_DIR", str(tmp_path / "proof"))


@contextmanager
def responder(statuses, *, port=0, broken_science=False):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def respond(self, payload):
            status = statuses.get(self.path, 200)
            token = self.headers.get("X-DNAForge-Session")
            if self.path != "/health" and token != SESSION:
                status = 401
            requests.append(
                {"path": self.path, "status": status, "authenticated": token == SESSION}
            )
            if status != 200:
                payload = {"error": f"reflected {SESSION}"}
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            payload = {"status": "healthy"}
            if self.path == "/services/":
                payload = {"services": [{"name": "plannotate_service"}]}
            self.respond(payload)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert body == {"sequence": ""}
            self.respond(
                {"features": [], "sequence_length": 1 if broken_science else 0}
            )

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        assert not thread.is_alive()


def run_pytest(
    tmp_path, target, *, url, optional=False, token=SESSION, integration=False
):
    env = os.environ.copy()
    for name in (
        "BASE_URL",
        "SIDECAR_URL",
        "DNAFORGE_MCP_SESSION_TOKEN",
        "DNAFORGE_ANNOTATION_E2E_REQUIRED",
    ):
        env.pop(name, None)
    if not optional:
        env["SIDECAR_URL" if integration else "BASE_URL"] = url
    if token is not None:
        env["DNAFORGE_MCP_SESSION_TOKEN"] = token
    report = tmp_path / "junit.xml"
    selected = "test_health_endpoint" if integration else ANNOTATION_SELECTION
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            str(target),
            "-k",
            selected,
            "-m",
            "slow or not slow",
            "-o",
            "addopts=",
            "--tb=short",
            "-q",
            f"--junitxml={report}",
        ],
        cwd=API_ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
    )
    output = result.stdout + result.stderr
    assert SESSION not in output
    assert report.exists(), output
    xml = ET.parse(report)
    assert SESSION not in report.read_text()
    cases = xml.findall(".//testcase")
    counts = {"passed": 0, "failed": 0, "errors": 0, "skipped": 0}
    for case in cases:
        if case.find("failure") is not None:
            counts["failed"] += 1
        elif case.find("error") is not None:
            counts["errors"] += 1
        elif case.find("skipped") is not None:
            counts["skipped"] += 1
        else:
            counts["passed"] += 1
    return {"exit": result.returncode, "counts": counts, "output": output}


def preserve(name, receipt):
    directory = Path(os.environ["DNAFORGE_PREFLIGHT_PROOF_DIR"])
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{name}.json").write_text(json.dumps(receipt, indent=2) + "\n")


def baseline_file(tmp_path, name):
    source = (
        API_ROOT / "tests/fixtures/live-sidecar-preflight" / f"{name}.txt"
    ).read_bytes()
    assert hashlib.sha256(source).hexdigest() == BASELINE_FILES[name]
    parent = tmp_path / "baseline"
    parent.mkdir()
    target = parent / name
    target.write_bytes(source)
    return target, hashlib.sha256(source).hexdigest()


@pytest.mark.parametrize("route", ["/health", "/services/"])
@pytest.mark.parametrize("status", [401, 404, 500, 503])
def test_reachable_selected_annotation_never_all_skipped(tmp_path, route, status):
    with responder({route: status}) as (url, requests):
        before_target, digest = baseline_file(tmp_path, "test_annotation_e2e.py")
        before = run_pytest(tmp_path, before_target, url=url)
        after = run_pytest(tmp_path, API_ROOT / "tests/test_annotation_e2e.py", url=url)
    assert before["exit"] == 0 and before["counts"]["skipped"] == 2
    assert after["exit"] == 1 and after["counts"]["errors"] == 2
    assert after["counts"]["skipped"] == 0
    assert route in after["output"] and str(status) in after["output"]
    preserve(
        f"annotation-{route.strip('/')}--{status}",
        {
            "baseline": BASELINE,
            "baselineFileSha256": digest,
            "before": before,
            "after": after,
            "requests": requests,
        },
    )


@pytest.mark.parametrize("optional", [False, True])
def test_missing_annotation_listener_classification(tmp_path, optional):
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 8000 if optional else 0))
        port = reservation.getsockname()[1]
    result = run_pytest(
        tmp_path,
        API_ROOT / "tests/test_annotation_e2e.py",
        url=f"http://127.0.0.1:{port}",
        optional=optional,
    )
    assert result["exit"] == (0 if optional else 1)
    assert result["counts"]["skipped" if optional else "errors"] == 2
    preserve(f"annotation-absent-optional-{optional}", result)


@pytest.mark.parametrize("optional", [False, True])
def test_reachable_annotation_missing_credential_fails(tmp_path, optional):
    with responder({}, port=8000 if optional else 0) as (url, requests):
        result = run_pytest(
            tmp_path,
            API_ROOT / "tests/test_annotation_e2e.py",
            url=url,
            token=None,
            optional=optional,
        )
    assert result["exit"] == 1 and result["counts"]["errors"] == 2
    assert result["counts"]["skipped"] == 0
    assert all(
        row["path"] == "/health" and not row["authenticated"] for row in requests
    )
    preserve(f"annotation-missing-credential-optional-{optional}", result)


@pytest.mark.parametrize("broken_science", [False, True])
def test_healthy_selected_target_executes_original_assertions(tmp_path, broken_science):
    with responder({}, broken_science=broken_science) as (url, requests):
        result = run_pytest(
            tmp_path, API_ROOT / "tests/test_annotation_e2e.py", url=url
        )
    assert result["exit"] == (1 if broken_science else 0)
    assert result["counts"] == {
        "passed": 1 if broken_science else 2,
        "failed": 1 if broken_science else 0,
        "errors": 0,
        "skipped": 0,
    }
    assert any(
        row["path"] == "/annotation" and row["authenticated"] for row in requests
    )
    preserve(f"annotation-scientific-control-{broken_science}", result)


@pytest.mark.parametrize("status", [401, 404, 500, 503])
def test_selected_external_integration_is_not_optional(tmp_path, status):
    with responder({"/health": status}) as (url, requests):
        before_target, digest = baseline_file(tmp_path, "test_sidecar_integration.py")
        before = run_pytest(tmp_path, before_target, url=url, integration=True)
        after = run_pytest(
            tmp_path,
            API_ROOT / "tests/test_sidecar_integration.py",
            url=url,
            integration=True,
        )
    assert before["exit"] == 0 and before["counts"]["skipped"] == 1
    assert after["exit"] == 1 and after["counts"]["errors"] == 1
    assert after["counts"]["skipped"] == 0
    preserve(
        f"integration-health-{status}",
        {
            "baseline": BASELINE,
            "baselineFileSha256": digest,
            "before": before,
            "after": after,
            "requests": requests,
        },
    )
