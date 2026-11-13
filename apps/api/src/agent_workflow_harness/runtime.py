"""Runtime helpers for the  MCP harness and console."""

from __future__ import annotations

import http.client
import json
import os
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

EXPECTED_DB_FILES = [
    "BLAST_dbs/snapgene.nsq",
    "BLAST_dbs/fpbase.dmnd",
    "BLAST_dbs/swissprot.dmnd",
    "BLAST_dbs/Rfam.cm",
    "swissprot.csv.gz",
]

FAKE_BINARIES = ["blastn", "makeblastdb", "diamond", "cmscan", "mafft"]
LOCAL_HTTP_HOSTS = {"127.0.0.1", "localhost", "::1"}

DESKTOP_BUILD_HINT = (
    "Build the desktop test app first with: "
    "cd apps/desktop && pnpm exec electron-vite build --mode test"
)

MCP_GRANT_CONFIG_PATH = (
    Path(__file__).resolve().parents[3] / "desktop/src/main/sidecar-capabilities.json"
)


class HarnessFailure(RuntimeError):
    pass


def default_mcp_grant_capabilities() -> list[str]:
    """Load the first-party sidecar grant used by the Electron launcher.

    The live harness owns both ends of its temporary MCP session. It must mint
    that session's authority explicitly, while keeping the capability list in
    the same checked-in source of truth as production Electron startup.
    """

    try:
        payload = json.loads(MCP_GRANT_CONFIG_PATH.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise HarnessFailure(
            f"could not read MCP grant config: {MCP_GRANT_CONFIG_PATH}"
        ) from exc
    capabilities = payload.get("defaultMcpGrantCapabilities")
    if (
        not isinstance(capabilities, list)
        or not capabilities
        or not all(
            isinstance(capability, str) and capability for capability in capabilities
        )
    ):
        raise HarnessFailure(
            f"invalid defaultMcpGrantCapabilities in {MCP_GRANT_CONFIG_PATH}"
        )
    return capabilities


def create_desktop_git_workspace() -> Path:
    repo_root = Path(__file__).resolve().parents[4]
    fixture = repo_root / "test-fixtures/sequences/circular/pUC19.gb"
    require(fixture.exists(), f"missing sequence fixture: {fixture}")

    workspace_root = Path.home() / ".waypoint-test"
    workspace_root.mkdir(parents=True, exist_ok=True)
    workspace_dir = Path(
        tempfile.mkdtemp(prefix="agent-workflow-workspace-", dir=workspace_root)
    )
    (workspace_dir / "notes.md").write_text("initial\n")
    sequence_dir = workspace_dir / "plasmids"
    sequence_dir.mkdir()
    plasmid_path = sequence_dir / "pUC19.gb"
    clean_plasmid_path = sequence_dir / "pUC19-clean.gb"
    shutil.copyfile(fixture, plasmid_path)
    shutil.copyfile(fixture, clean_plasmid_path)
    run_command(["git", "init"], cwd=workspace_dir)
    run_command(
        ["git", "config", "user.email", "agent-harness@example.invalid"],
        cwd=workspace_dir,
    )
    run_command(["git", "config", "user.name", "Agent Harness"], cwd=workspace_dir)
    run_command(
        ["git", "add", "notes.md", "plasmids/pUC19.gb", "plasmids/pUC19-clean.gb"],
        cwd=workspace_dir,
    )
    run_command(["git", "commit", "-m", "Initial workspace"], cwd=workspace_dir)
    (workspace_dir / "notes.md").write_text("initial\nmodified\n")
    plasmid_text = plasmid_path.read_text()
    mutated_plasmid_text = plasmid_text.replace("gagataccta", "aagataccta", 1)
    require(
        mutated_plasmid_text != plasmid_text,
        "sequence fixture did not contain expected mutation anchor",
    )
    plasmid_path.write_text(mutated_plasmid_text)
    (workspace_dir / "scratch.txt").write_text("untracked\n")
    return workspace_dir


def run_command(command: list[str], *, cwd: Path) -> None:
    result = subprocess.run(
        command,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        joined = " ".join(command)
        raise HarnessFailure(
            f"command failed in {cwd}: {joined}\n{result.stderr or result.stdout}"
        )


def node_tool_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    pnpm_path = shutil.which("pnpm")
    if pnpm_path:
        pnpm_dir = str(Path(pnpm_path).parent)
        env["PATH"] = f"{pnpm_dir}{os.pathsep}{env.get('PATH', '')}"
    if extra:
        env.update(extra)
    return env


def start_desktop_app(
    *,
    desktop_dir: Path,
    desktop_main: Path | None,
    api_port: int,
    renderer_port: int,
    renderer_token: str,
    mcp_token: str,
    db_path: Path,
    data_dir: Path,
    binaries_dir: Path,
    workspace_dir: Path | None,
    stdout_log: Path,
) -> tuple[subprocess.Popen[Any], tuple[Path, bytes | None], Path]:
    main_path = desktop_main or desktop_dir / "out/main/index.js"
    main_path = main_path.resolve()
    renderer_index = main_path.parent.parent / "renderer/index.html"
    if not main_path.exists():
        raise HarnessFailure(
            f"desktop main bundle not found: {main_path}. {DESKTOP_BUILD_HINT}"
        )
    if not renderer_index.exists():
        raise HarnessFailure(
            f"desktop renderer bundle not found: {renderer_index}. {DESKTOP_BUILD_HINT}"
        )

    env_backup = write_desktop_build_env(main_path.parent / ".env.local", api_port)
    user_data_dir: Path | None = None
    stdout: Any = None
    try:
        user_data_root = Path.home() / ".waypoint-test"
        user_data_root.mkdir(parents=True, exist_ok=True)
        user_data_dir = Path(
            tempfile.mkdtemp(prefix="agent-workflow-userdata-", dir=user_data_root)
        )
        (user_data_dir / ".welcome-seen").write_text(
            f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n"
        )

        env = node_tool_env()
        env.pop("DESKTOP_DEV_PORT", None)
        env.pop("ELECTRON_RENDERER_URL", None)
        env.update(
            {
                "DNAFORGE_MCP_SESSION_TOKEN": mcp_token,
                "DNAFORGE_MCP_AGENT_IDENTITY": "harness-agent",
                "DNAFORGE_MCP_GRANT_CAPABILITIES": json.dumps(
                    default_mcp_grant_capabilities()
                ),
                "DNAFORGE_RENDERER_BRIDGE_PORT": str(renderer_port),
                "DNAFORGE_RENDERER_BRIDGE_TOKEN": renderer_token,
                "DNAFORGE_SIDECAR_DB_PATH": str(db_path),
                "WAYPOINT_DATA_DIR": str(data_dir),
                "WAYPOINT_BINARIES_PATH": str(binaries_dir),
                "ELECTRON_DISABLE_GPU": "1",
                "NODE_ENV": "test",
                "PYTHONUNBUFFERED": "1",
                "WAYPOINT_TEST": "1",
            }
        )

        process_args = [
            "pnpm",
            "--dir",
            str(desktop_dir),
            "exec",
            "electron",
            str(main_path),
            f"--user-data-dir={user_data_dir}",
            "--e2e",
        ]
        if workspace_dir is not None:
            process_args.append(f"--workspace={workspace_dir}")
        if os.environ.get("CI"):
            process_args.append("--no-sandbox")

        stdout = stdout_log.open("w")
        process = subprocess.Popen(
            process_args,
            cwd=desktop_dir,
            env=env,
            stdout=stdout,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
    except Exception:
        if stdout:
            stdout.close()
        restore_desktop_build_env(env_backup)
        if user_data_dir:
            shutil.rmtree(user_data_dir, ignore_errors=True)
        raise

    return process, env_backup, user_data_dir


def write_desktop_build_env(env_path: Path, api_port: int) -> tuple[Path, bytes | None]:
    previous = env_path.read_bytes() if env_path.exists() else None
    env_path.write_text(
        "\n".join(
            [
                f"API_PORT={api_port}",
                f"VITE_API_URL=http://127.0.0.1:{api_port}",
                "",
            ]
        )
    )
    return env_path, previous


def restore_desktop_build_env(backup: tuple[Path, bytes | None]) -> None:
    env_path, previous = backup
    if previous is None:
        try:
            env_path.unlink()
        except FileNotFoundError:
            return
    else:
        env_path.write_bytes(previous)


def start_api_sidecar(
    *,
    api_dir: Path,
    api_port: int,
    renderer_port: int,
    renderer_token: str,
    mcp_token: str,
    db_path: Path,
    data_dir: Path,
    binaries_dir: Path,
    stdout_log: Path,
) -> subprocess.Popen[Any]:
    env = {
        **os.environ,
        "PYTHONUNBUFFERED": "1",
        "DNAFORGE_RENDERER_BRIDGE_URL": f"http://127.0.0.1:{renderer_port}",
        "DNAFORGE_RENDERER_BRIDGE_TOKEN": renderer_token,
        "DNAFORGE_MCP_SESSION_TOKEN": mcp_token,
        "DNAFORGE_MCP_AGENT_IDENTITY": "harness-agent",
        "DNAFORGE_MCP_GRANT_CAPABILITIES": json.dumps(default_mcp_grant_capabilities()),
        "DNAFORGE_SIDECAR_DB_PATH": str(db_path),
        "WAYPOINT_DATA_DIR": str(data_dir),
        "WAYPOINT_BINARIES_PATH": str(binaries_dir),
    }
    stdout = stdout_log.open("w")
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "src.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(api_port),
            "--log-level",
            "warning",
        ],
        cwd=api_dir,
        env=env,
        stdout=stdout,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )


def prepare_startup_fixtures(data_dir: Path, binaries_dir: Path) -> None:
    annotation_dir = data_dir / "annotation"
    for relative in EXPECTED_DB_FILES:
        target = annotation_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"harness-fixture")
    (annotation_dir / "version.json").write_text(json.dumps({"version": "1.2.2"}))

    binaries_dir.mkdir(parents=True, exist_ok=True)
    for name in FAKE_BINARIES:
        binary = binaries_dir / name
        binary.write_text("#!/bin/sh\nexit 0\n")
        binary.chmod(0o755)


def read_renderer_calls(log_path: Path) -> list[dict[str, Any]]:
    if not log_path.exists():
        return []
    return [
        json.loads(line) for line in log_path.read_text().splitlines() if line.strip()
    ]


def read_audit_summary(db_path: Path) -> dict[str, Any]:
    conn = sqlite3.connect(db_path)
    try:
        actions = conn.execute("SELECT COUNT(*) FROM agent_action").fetchone()[0]
        audits = conn.execute("SELECT COUNT(*) FROM audit_record").fetchone()[0]
        reasons = [
            json.loads(row[0]).get("reason")
            for row in conn.execute("SELECT capability_check_json FROM audit_record")
        ]
        tools = [
            row[0]
            for row in conn.execute(
                "SELECT DISTINCT tool_name FROM agent_action ORDER BY tool_name"
            )
        ]
        actor_counts = {
            row[0]: row[1]
            for row in conn.execute(
                "SELECT actor_kind, COUNT(*) FROM audit_record GROUP BY actor_kind"
            )
        }
        return {
            "agent_actions": actions,
            "audit_records": audits,
            "actor_counts": actor_counts,
            "capability_reasons": sorted(reason for reason in reasons if reason),
            "tools": tools,
        }
    finally:
        conn.close()


def post_json(
    url: str, payload: dict[str, Any], headers: dict[str, str]
) -> dict[str, Any]:
    return request_json(
        url,
        method="POST",
        payload=payload,
        headers={"Content-Type": "application/json", **headers},
    )


def get_json(url: str) -> dict[str, Any]:
    return request_json(url, method="GET")["body"]


def request_json(
    url: str,
    *,
    method: str,
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    host, port, target = local_http_target(url)
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    connection = http.client.HTTPConnection(host, port, timeout=10)
    try:
        connection.request(method, target, body=body, headers=headers or {})
        response = connection.getresponse()
        response_body = response.read().decode("utf-8")
        return {
            "status_code": response.status,
            "body": json.loads(response_body) if response_body else {},
        }
    finally:
        connection.close()


def local_http_target(url: str) -> tuple[str, int, str]:
    parsed = urlsplit(url)
    if parsed.scheme != "http":
        raise HarnessFailure(f"local HTTP URL must use http: {url}")
    if parsed.hostname not in LOCAL_HTTP_HOSTS:
        raise HarnessFailure(f"local HTTP URL must be loopback-only: {url}")
    try:
        port = parsed.port or 80
    except ValueError as exc:
        raise HarnessFailure(f"local HTTP URL has an invalid port: {url}") from exc
    target = parsed.path or "/"
    if parsed.query:
        target = f"{target}?{parsed.query}"
    return parsed.hostname, port, target


def wait_for_health(url: str, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            body = get_json(url)
            if body.get("ok") is True or "status" in body:
                return
        except Exception as exc:  # noqa: BLE001 - surfaced below with context
            last_error = exc
        time.sleep(0.2)
    raise HarnessFailure(f"timed out waiting for {url}: {last_error}")


def find_free_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def require(condition: bool, message: str) -> None:
    if not condition:
        raise HarnessFailure(message)


def terminate_process(proc: subprocess.Popen[Any]) -> None:
    if proc.poll() is not None:
        return
    terminate_process_group(proc, signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        terminate_process_group(proc, signal.SIGKILL)
        proc.wait(timeout=5)


def terminate_process_group(proc: subprocess.Popen[Any], sig: signal.Signals) -> None:
    try:
        if os.name == "nt":
            if sig == signal.SIGTERM:
                proc.terminate()
            else:
                proc.kill()
        else:
            os.killpg(proc.pid, sig)
    except ProcessLookupError:
        return


def dump_process_logs(*paths: Path) -> None:
    for path in paths:
        if not path.exists():
            continue
        print(f"\n--- {path.name} ---", file=sys.stderr)
        print(path.read_text(errors="replace")[-4000:], file=sys.stderr)


def copy_artifacts(source: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for path in source.iterdir():
        if path.is_file():
            (dest / path.name).write_bytes(path.read_bytes())
