"""Strict fixture replay transport for external provider HTTP calls.

Used by Electron acceptance tests that need the real sidecar routes, provider
parsers, and indexed range admission without live internet. The renderer still
calls `/external/*`; the sidecar serves outbound provider requests from fixtures
and resolves only hosts declared by those fixtures.
"""

from __future__ import annotations

import base64
import ipaddress
import json
import re
import secrets
import socket
from collections import Counter
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

_BYTE_RANGE_RE = re.compile(r"^bytes=(\d+)-(\d+)$")
_REPLAY_PUBLIC_ADDRESS = "93.184.216.34"

ReplayResolver = Callable[..., Awaitable[list[tuple]]]


def build_replay_client(
    replay_dir: str, *, trace_file: str | None = None
) -> httpx.AsyncClient:
    entries = _load_entries(Path(replay_dir))
    trace_path = Path(trace_file) if trace_file else None
    process_generation = secrets.token_hex(12)
    _trace_process_start(trace_path, process_generation)

    def handler(request: httpx.Request) -> httpx.Response:
        for entry in entries:
            if _matches(entry, request):
                authorized = _authorized(entry, request)
                _trace_request(
                    trace_path,
                    request,
                    matched=True,
                    authorized=authorized,
                    process_generation=process_generation,
                )
                if not authorized:
                    return _unauthorized_response(entry, request)
                response = entry["response"]
                if response.get("serve_ranges") is True:
                    return _range_file_response(entry, request)
                return httpx.Response(
                    status_code=int(response.get("status", 200)),
                    headers=dict(response.get("headers") or {}),
                    content=_response_content(response),
                    request=request,
                )
        _trace_request(
            trace_path,
            request,
            matched=False,
            authorized=False,
            process_generation=process_generation,
        )
        return httpx.Response(
            status_code=599,
            json={
                "error": "external_replay_miss",
                "method": request.method,
                "url": str(request.url),
            },
            headers={"X-Waypoint-External-Replay": "miss"},
            request=request,
        )

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def build_replay_resolver(replay_dir: str) -> ReplayResolver:
    """Resolve only fixture-declared hosts without consulting live DNS.

    The paired replay client uses an in-memory transport, so the returned
    globally routable address is validated but never opened as a socket. An
    undeclared host fails closed before the replay transport sees a request.
    """

    fixture_hosts = frozenset(
        str(entry["host"]).casefold()
        for entry in _load_entries(Path(replay_dir))
        if isinstance(entry.get("host"), str) and str(entry["host"]).strip()
    )

    async def resolve(host: str, port: int, *, type: socket.SocketKind) -> list[tuple]:
        if type != socket.SOCK_STREAM or host.casefold() not in fixture_hosts:
            raise socket.gaierror(socket.EAI_NONAME, "host has no replay fixture")
        return [
            (
                socket.AF_INET,
                socket.SOCK_STREAM,
                socket.IPPROTO_TCP,
                "",
                (_REPLAY_PUBLIC_ADDRESS, port),
            )
        ]

    return resolve


def _trace_request(
    trace_path: Path | None,
    request: httpx.Request,
    *,
    matched: bool,
    authorized: bool,
    process_generation: str,
) -> None:
    """Record deterministic replay traffic when an acceptance test asks for it.

    Only the shape of a request is recorded: header names and the
    authorization scheme. Header values (tokens, signatures, cookies) never
    reach the trace file, so an acceptance test can prove a credential was
    presented without the trace becoming a secret store.
    """

    if trace_path is None:
        return
    record = {
        "event": "request",
        "method": request.method.upper(),
        "originHost": _request_origin_host(request),
        "path": request.url.path,
        "range": request.headers.get("Range"),
        "matched": matched,
        "authorized": authorized,
        "authorizationScheme": _authorization_scheme(request),
        "headerNames": sorted({name.casefold() for name in request.headers}),
        "processGeneration": process_generation,
    }
    with trace_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True, separators=(",", ":")))
        handle.write("\n")


def _trace_process_start(trace_path: Path | None, process_generation: str) -> None:
    if trace_path is None:
        return
    record = {
        "event": "process-start",
        "method": "PROCESS",
        "originHost": "",
        "path": "",
        "range": None,
        "matched": True,
        "authorized": True,
        "authorizationScheme": None,
        "headerNames": [],
        "processGeneration": process_generation,
    }
    with trace_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True, separators=(",", ":")))
        handle.write("\n")


def _load_entries(replay_dir: Path) -> list[dict[str, Any]]:
    if not replay_dir.exists():
        raise RuntimeError(f"EXTERNAL_REPLAY_DIR does not exist: {replay_dir}")
    entries: list[dict[str, Any]] = []
    for path in sorted(replay_dir.glob("*.json")):
        payload = json.loads(path.read_text())
        if isinstance(payload, dict) and isinstance(payload.get("entries"), list):
            loaded = payload["entries"]
        elif isinstance(payload, dict):
            loaded = [payload]
        else:
            loaded = []
        for entry in loaded:
            if not isinstance(entry, dict):
                continue
            entries.append(
                {
                    **entry,
                    "_fixture_path": str(path.resolve()),
                    "_fixture_root": str(replay_dir.parent.resolve()),
                }
            )
    if not entries:
        raise RuntimeError(f"EXTERNAL_REPLAY_DIR has no replay entries: {replay_dir}")
    return entries


def _matches(entry: dict[str, Any], request: httpx.Request) -> bool:
    if str(entry.get("method", "GET")).upper() != request.method.upper():
        return False
    expected_scheme = entry.get("scheme")
    if expected_scheme is None and entry.get("host"):
        expected_scheme = "https"
    if expected_scheme and str(expected_scheme).lower() != request.url.scheme.lower():
        return False
    if entry.get("host") and str(entry["host"]).lower() != _request_origin_host(
        request
    ):
        return False
    if entry.get("path") and entry["path"] != request.url.path:
        return False
    expected_query = entry.get("query")
    if isinstance(expected_query, dict):
        expected_items = [(str(k), str(v)) for k, v in expected_query.items()]
    else:
        expected_items = []
    expected_query_regex = entry.get("query_regex")
    if isinstance(expected_query_regex, dict):
        expected_regex_items = [
            (str(k), str(v)) for k, v in expected_query_regex.items()
        ]
    else:
        expected_regex_items = []
    if {key for key, _value in expected_items} & {
        key for key, _value in expected_regex_items
    }:
        return False
    actual_items = [(str(k), str(v)) for k, v in request.url.params.multi_items()]
    if Counter(key for key, _value in actual_items) != Counter(
        [key for key, _value in expected_items]
        + [key for key, _value in expected_regex_items]
    ):
        return False
    if not all(item in actual_items for item in expected_items):
        return False
    actual_by_key = dict(actual_items)
    if not all(
        re.fullmatch(pattern, actual_by_key[key]) is not None
        for key, pattern in expected_regex_items
    ):
        return False
    return True


def _authorized(entry: dict[str, Any], request: httpx.Request) -> bool:
    """Apply a fixture's credential requirements like a private server would.

    ``require_headers`` demands exact header values; ``require_header_patterns``
    demands a full regular-expression match. Either list is optional. A
    request that fails the check is served an unauthorized response instead of
    the fixture body, so a broken credential path cannot pass by accident.
    """

    exact = entry.get("require_headers")
    if isinstance(exact, dict):
        for name, expected in exact.items():
            if request.headers.get(str(name)) != str(expected):
                return False
    patterns = entry.get("require_header_patterns")
    if isinstance(patterns, dict):
        for name, pattern in patterns.items():
            actual = request.headers.get(str(name))
            if actual is None or re.fullmatch(str(pattern), actual) is None:
                return False
    return True


def _unauthorized_response(
    entry: dict[str, Any], request: httpx.Request
) -> httpx.Response:
    status = int(entry.get("unauthorized_status", 401))
    return httpx.Response(
        status_code=status,
        json={
            "error": "external_replay_unauthorized",
            "method": request.method,
            "url": str(request.url),
        },
        headers={"X-Waypoint-External-Replay": "unauthorized"},
        request=request,
    )


def _authorization_scheme(request: httpx.Request) -> str | None:
    value = request.headers.get("Authorization")
    if not value:
        return None
    scheme = value.strip().split(" ", 1)[0]
    return scheme or None


def _request_origin_host(request: httpx.Request) -> str:
    """Return the logical host while retaining exact IP-pinned replay behavior."""

    request_host = request.url.host.casefold()
    try:
        ipaddress.ip_address(request_host)
    except ValueError:
        return request_host

    host_header = request.headers.get("Host", "").strip()
    if not host_header:
        return request_host
    try:
        return httpx.URL(f"{request.url.scheme}://{host_header}").host.casefold()
    except (TypeError, ValueError):
        return request_host


def _response_content(response: dict[str, Any]) -> bytes:
    if "body_base64" in response:
        return base64.b64decode(str(response["body_base64"]))
    if "json" in response:
        return json.dumps(response["json"]).encode("utf-8")
    body = response.get("body", "")
    if isinstance(body, str):
        return body.encode("utf-8")
    if isinstance(body, bytes):
        return body
    return json.dumps(body).encode("utf-8")


def _range_file_response(
    entry: dict[str, Any], request: httpx.Request
) -> httpx.Response:
    response = entry["response"]
    body_file = response.get("body_file")
    if not isinstance(body_file, str) or not body_file.strip():
        raise RuntimeError("Range replay entries require response.body_file")
    fixture_path = Path(str(entry["_fixture_path"]))
    fixture_root = Path(str(entry["_fixture_root"]))
    payload_path = (fixture_path.parent / body_file).resolve()
    if not payload_path.is_relative_to(fixture_root):
        raise RuntimeError("Range replay body_file escapes the external fixture root")
    file_size = payload_path.stat().st_size
    headers = dict(response.get("headers") or {})
    headers["Accept-Ranges"] = "bytes"
    requested = request.headers.get("Range")
    match = _BYTE_RANGE_RE.match(requested or "")
    if match is None:
        payload = payload_path.read_bytes()
        headers["Content-Length"] = str(len(payload))
        return httpx.Response(
            status_code=200,
            headers=headers,
            content=payload,
            request=request,
        )
    start, requested_end = (int(value) for value in match.groups())
    if start >= file_size or requested_end < start:
        headers["Content-Range"] = f"bytes */{file_size}"
        return httpx.Response(status_code=416, headers=headers, request=request)
    end = min(requested_end, file_size - 1)
    with payload_path.open("rb") as handle:
        handle.seek(start)
        payload = handle.read(end - start + 1)
    headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    headers["Content-Length"] = str(len(payload))
    return httpx.Response(
        status_code=206,
        headers=headers,
        content=payload,
        request=request,
    )
