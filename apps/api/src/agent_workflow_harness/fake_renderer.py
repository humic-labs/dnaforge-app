"""Fake renderer bridge used by the  MCP harness."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any


def start_fake_renderer(
    *,
    renderer_port: int,
    renderer_token: str,
    renderer_log: Path,
    stdout_log: Path,
) -> subprocess.Popen[Any]:
    stdout = stdout_log.open("w")
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "src.agent_workflow_harness.fake_renderer",
            "--port",
            str(renderer_port),
            "--token",
            renderer_token,
            "--log",
            str(renderer_log),
        ],
        stdout=stdout,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )


def run_fake_renderer(port: int, token: str, log_path: Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                self.write_json(200, {"ok": True})
            else:
                self.write_json(404, {"ok": False})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/__tools/call":
                self.write_json(404, {"ok": False})
                return

            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            headers = {key.lower(): value for key, value in self.headers.items()}
            with log_path.open("a") as handle:
                handle.write(json.dumps({"headers": headers, "body": body}) + "\n")

            if headers.get("x-dnaforge-session") != token:
                self.write_json(
                    401,
                    {
                        "ok": False,
                        "error": {
                            "code": "BAD_SESSION",
                            "message": "bad renderer session",
                            "retriable": True,
                        },
                    },
                )
                return

            if body.get("tool_name") != "get_workspace":
                self.write_json(
                    404,
                    {
                        "ok": False,
                        "error": {
                            "code": "UNKNOWN_TOOL",
                            "message": "fake renderer only supports get_workspace",
                            "retriable": False,
                        },
                    },
                )
                return

            self.write_json(
                200,
                {
                    "ok": True,
                    "result": {
                        "ok": True,
                        "projects": [],
                        "referenceFolders": [],
                        "workspaceId": None,
                        "workspaceFile": None,
                        "focusedPanelId": "main",
                        "folders": [],
                        "panels": [{"id": "main", "tabs": [], "activeTabId": None}],
                    },
                    "audit_id": "renderer-audit-harness",
                },
            )

        def log_message(self, _format: str, *_args: object) -> None:
            return

        def write_json(self, status: int, payload: dict[str, Any]) -> None:
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = HTTPServer(("127.0.0.1", port), Handler)
    server.serve_forever()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--log", type=Path, required=True)
    args = parser.parse_args()
    run_fake_renderer(args.port, args.token, args.log)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
