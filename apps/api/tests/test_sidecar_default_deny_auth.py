""" application-boundary authentication contract."""

from __future__ import annotations

import hashlib
import inspect
import json
import re
from pathlib import Path

import pytest
from fastapi.routing import APIRoute, iter_route_contexts
from fastapi.testclient import TestClient
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.websockets import WebSocketDisconnect

from src.main import app
from src.security.local_access import (
    DELEGATED_AGENT_AUTH_ROUTES,
    PUBLIC_STARTUP_ROUTES,
    is_delegated_agent_request,
    is_delegated_source_grant_request,
    is_mcp_http_request,
)

from .conftest import anonymous_client

SESSION_HEADER = "X-DNAForge-Session"
API_KEY_HEADER = "X-DNAForge-API-Key"
TEST_SESSION = "fixture-current-session"


_PUBLIC_EXPORT = any(
    (parent / ".dnaforge-public-export").is_file()
    for parent in Path(__file__).resolve().parents
)


def test_container_healthcheck_proves_readiness_not_public_liveness():
    dockerfile = "\n".join(
        line
        for line in (Path(__file__).parents[1] / "Dockerfile").read_text().splitlines()
        if not line.lstrip().startswith("#")
    )

    assert "urlopen('http://localhost:8000/ready')" in dockerfile
    assert "urlopen('http://localhost:8000/health')" not in dockerfile
    assert (
        "HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3"
        in dockerfile
    )


@pytest.mark.skipif(_PUBLIC_EXPORT, reason="checks files the public export leaves out")
def test_nx_docker_serve_mints_an_authenticated_session():
    api_root = Path(__file__).parents[1]
    project = json.loads((api_root / "project.json").read_text())
    command = project["targets"]["serve:docker"]["options"]["command"]

    assert "DNAFORGE_MCP_SESSION_TOKEN" in command
    assert "openssl rand" in command


def _client(*, authenticated: bool = False) -> TestClient:
    if not authenticated:
        return anonymous_client(app)
    return TestClient(app, headers={SESSION_HEADER: TEST_SESSION})


def _endpoint_or_one_private_helper_uses_resolver(
    route: APIRoute, resolver: str
) -> bool:
    source = inspect.getsource(route.endpoint)
    if resolver in source:
        return True
    for name in route.endpoint.__code__.co_names:
        candidate = route.endpoint.__globals__.get(name)
        if (
            callable(candidate)
            and getattr(candidate, "__module__", None) == route.endpoint.__module__
        ):
            try:
                if resolver in inspect.getsource(candidate):
                    return True
            except (OSError, TypeError):
                continue
    return False


def _delegated_registry_drift_message(
    live: set[tuple[str, str, str, str]],
    registered: set[tuple[str, str, str, str]],
) -> str:
    missing = sorted(live - registered)
    stale = sorted(registered - live)
    return (
        "Delegated sidecar auth registry drifted. Ordinary routes are already "
        "session-default and need no registry entry. For persistent-agent access, "
        "edit apps/api/src/security/local_access.py::DELEGATED_AGENT_AUTH_ROUTES and "
        "name an existing endpoint resolver. The live endpoint or one private helper "
        "must call that resolver. "
        f"Missing exact (method, path, route, resolver) entries: {missing or 'none'}. "
        f"Stale/invalid entries: {stale or 'none'}."
    )


def test_exact_health_and_readiness_routes_are_the_only_public_surface(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_SESSION)
    client = _client()

    assert PUBLIC_STARTUP_ROUTES == frozenset({("GET", b"/health"), ("GET", b"/ready")})
    assert client.get("/health?probe=startup").status_code == 200
    assert client.get("/ready").status_code == 200

    for method, path in (
        ("GET", "/"),
        ("GET", "/docs"),
        ("GET", "/redoc"),
        ("GET", "/openapi.json"),
        ("GET", "/sidecar/health"),
        ("GET", "/sidecar/status"),
        ("GET", "/health/"),
        ("GET", "/%68ealth"),
        ("GET", "/health%2F"),
        ("GET", "//health"),
        ("GET", "/ready%2F"),
        ("HEAD", "/health"),
        ("POST", "/health"),
        ("GET", "/not-a-route"),
    ):
        response = client.request(method, path, follow_redirects=False)
        assert response.status_code == 401, (method, path, response.text)
        if method != "HEAD":
            assert response.json()["error"]["code"] == "BAD_SESSION"


def test_public_health_contains_no_token_verifier_and_presented_session_proves_ownership(
    monkeypatch,
):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_SESSION)
    monkeypatch.setenv("WAYPOINT_APP_VERSION", "1.2.3")
    monkeypatch.setenv(
        "DNAFORGE_MCP_GRANT_CAPABILITIES",
        "external-fetch:annotation,external-fetch:structure",
    )

    client = _client()
    public_body = client.get("/health").json()
    assert public_body == {"status": "healthy", "service": "molbio-api"}
    assert hashlib.sha256(TEST_SESSION.encode()).hexdigest() not in json.dumps(
        public_body
    )

    assert client.get("/health", params={"challenge": "a" * 64}).json() == public_body

    rejected = client.get("/health", headers={SESSION_HEADER: "stale-session"})
    assert rejected.status_code == 401
    assert rejected.json()["error"]["code"] == "BAD_SESSION"

    owned = client.get("/health", headers={SESSION_HEADER: TEST_SESSION})
    assert owned.status_code == 200
    owned_body = owned.json()
    assert owned_body["app_version"] == "1.2.3"
    assert isinstance(owned_body["sidecar_source_fingerprint"], str)
    assert len(owned_body["sidecar_source_fingerprint"]) == 64
    assert "mcp_session_fingerprint" not in owned_body
    assert hashlib.sha256(TEST_SESSION.encode()).hexdigest() not in json.dumps(
        owned_body
    )
    assert "auth.default-deny.v1" in owned_body["route_features"]
    assert owned_body["mcp_grant_capabilities"] == [
        "external-fetch:annotation",
        "external-fetch:structure",
    ]


def test_readiness_fails_closed_when_server_session_is_unconfigured(monkeypatch):
    monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN", raising=False)
    client = _client()

    ready = client.get("/ready")
    assert ready.status_code == 503
    assert ready.json() == {
        "ready": False,
        "code": "MCP_SESSION_NOT_CONFIGURED",
    }

    protected = client.get("/services/")
    assert protected.status_code == 500
    assert protected.json()["error"]["code"] == "MCP_SESSION_NOT_CONFIGURED"

    owned_health = client.get("/health", headers={SESSION_HEADER: "candidate-session"})
    assert owned_health.status_code == 500
    assert owned_health.json()["error"]["code"] == "MCP_SESSION_NOT_CONFIGURED"


def test_default_policy_rejects_before_body_validation_and_accepts_current_session(
    monkeypatch,
):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_SESSION)

    rejected = _client().post("/genome/index", content=b"not-json")
    assert rejected.status_code == 401
    assert rejected.json()["error"]["code"] == "BAD_SESSION"

    accepted = _client(authenticated=True).get("/services/")
    assert accepted.status_code == 200


def test_missing_wrong_empty_and_duplicate_sessions_fail_with_one_contract(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_SESSION)
    client = _client()

    for headers in (
        None,
        {SESSION_HEADER: ""},
        {SESSION_HEADER: "wrong"},
        [(SESSION_HEADER, TEST_SESSION), (SESSION_HEADER, TEST_SESSION)],
    ):
        response = client.get("/services/", headers=headers)
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "BAD_SESSION"
        assert response.json()["detail"]["code"] == "BAD_SESSION"
        assert response.json()["detail"]["details"]["how_to_fix"]


def test_health_rejects_non_ascii_and_duplicate_sessions_with_stable_contract(
    monkeypatch,
):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_SESSION)
    client = _client()

    for headers in (
        [(b"X-DNAForge-Session", b"\xff")],
        [(SESSION_HEADER, TEST_SESSION), (SESSION_HEADER, TEST_SESSION)],
    ):
        response = client.get("/health", headers=headers)
        assert response.status_code == 401
        body = response.json()
        assert body["error"]["code"] == "BAD_SESSION"
        assert body["detail"] == body["error"]
        assert body["detail"]["details"]["how_to_fix"]


def test_api_key_never_bypasses_default_session_policy(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_SESSION)

    response = _client().get(
        "/sidecar/status", headers={API_KEY_HEADER: "dna_key_not-valid"}
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "BAD_SESSION"


def test_native_range_proxy_delegates_only_headerless_exact_token_routes(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_SESSION)
    path = "/external/range-proxy/source.bam"

    assert is_delegated_source_grant_request("GET", path)
    assert is_delegated_source_grant_request("HEAD", path)
    assert not is_delegated_source_grant_request("POST", path)
    assert not is_delegated_source_grant_request("GET", f"{path}/extra")
    assert not is_delegated_source_grant_request("GET", "/external/range-proxy")
    assert not is_delegated_source_grant_request(
        "GET", path, b"/external/range-proxy/source%2ebam"
    )

    delegated = _client().get(path)
    assert delegated.status_code in {401, 503}
    assert delegated.json().get("error", {}).get("code") != "BAD_SESSION"

    wrong_session = _client().get(path, headers={SESSION_HEADER: "wrong"})
    assert wrong_session.status_code == 401
    assert wrong_session.json()["error"]["code"] == "BAD_SESSION"

    wrong_method = _client().post(path)
    assert wrong_method.status_code == 401
    assert wrong_method.json()["error"]["code"] == "BAD_SESSION"


def test_delegated_routes_are_exact_and_backed_by_existing_agent_auth(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_SESSION)
    routes = {
        (next(iter(route.methods)), route.path, route.name): route
        for route in iter_route_contexts(app.routes)
        if isinstance(route.original_route, APIRoute) and len(route.methods) == 1
    }

    assert DELEGATED_AGENT_AUTH_ROUTES
    for rule in DELEGATED_AGENT_AUTH_ROUTES:
        route = routes.get((rule.method, rule.path_template, rule.route_name))
        assert route is not None, (
            f"Registered delegated route does not exist: {rule.method} "
            f"{rule.path_template} ({rule.route_name}). Remove or repair the exact entry in "
            "apps/api/src/security/local_access.py::DELEGATED_AGENT_AUTH_ROUTES."
        )
        dependency_names = {
            getattr(dependency.call, "__name__", "")
            for dependency in route.dependant.dependencies
        }
        assert (
            rule.resolver in dependency_names
            or _endpoint_or_one_private_helper_uses_resolver(route, rule.resolver)
        ), (
            f"Delegated route {rule.method} {rule.path_template} ({rule.route_name}) names "
            f"resolver {rule.resolver!r}, but the endpoint and its private helpers do not "
            "call it. Add the existing resolver to the route or remove the delegated entry; "
            "never replace it with an unauthenticated bypass."
        )

    live_delegated: set[tuple[str, str, str, str]] = set()
    resolver_names = (
        "resolve_persistent_agent_request",
        "resolve_authenticated_agent_context",
    )
    for route in routes.values():
        dependency_names = {
            getattr(dependency.call, "__name__", "")
            for dependency in route.dependant.dependencies
        }
        for resolver in resolver_names:
            if (
                resolver in dependency_names
                or _endpoint_or_one_private_helper_uses_resolver(route, resolver)
            ):
                method = next(iter(route.methods))
                live_delegated.add((method, route.path, route.name, resolver))

    registered_delegated = {
        (rule.method, rule.path_template, rule.route_name, rule.resolver)
        for rule in DELEGATED_AGENT_AUTH_ROUTES
    }
    assert live_delegated == registered_delegated, _delegated_registry_drift_message(
        live_delegated, registered_delegated
    )

    assert is_delegated_agent_request("POST", "/mcp/call")
    assert is_delegated_agent_request("GET", "/jobs/019abc/events")
    assert is_delegated_agent_request("POST", "/api/tools/echo/execute")
    assert not is_delegated_agent_request("GET", "/api/tools/manifest-schema")
    assert not is_delegated_agent_request("GET", "/sidecar/status")

    response = _client().post(
        "/mcp/call",
        headers={API_KEY_HEADER: "dna_key_not-valid"},
        json={"tool": "get_workspace", "args": {}},
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] != "MCP_SESSION_NOT_CONFIGURED"


def test_every_live_route_type_is_denied_before_its_handler_without_auth(monkeypatch):
    """Every route inherits session denial or its exact delegated bearer check."""

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_SESSION)
    client = _client()
    checked: list[tuple[str, str, str]] = []
    observed_types: set[str] = set()

    for route in iter_route_contexts(app.routes):
        observed_types.add(type(route.original_route).__name__)
        if isinstance(route.original_route, WebSocketRoute):
            path = re.sub(r"\{[^}]+\}", "fixture", route.path)
            with pytest.raises(WebSocketDisconnect) as rejected:
                with client.websocket_connect(path):
                    pass
            assert rejected.value.code == 4401
            checked.append(
                ("WEBSOCKET", route.path, type(route.original_route).__name__)
            )
            continue
        if isinstance(route.original_route, Mount):
            path = f"{route.path.rstrip('/')}/fixture"
            response = client.get(path, follow_redirects=False)
            assert response.status_code == 401, (
                route.path,
                response.status_code,
                response.text,
            )
            assert response.json()["error"]["code"] == "BAD_SESSION"
            checked.append(("GET", route.path, type(route.original_route).__name__))
            continue
        if not isinstance(route.original_route, Route):
            pytest.fail(
                f"Unhandled live route class {type(route.original_route).__name__}; add an explicit "
                "default-deny structural assertion for it."
            )

        path = re.sub(r"\{[^}]+\}", "fixture", route.path)
        for method in sorted(route.methods):
            if (method, route.path.encode()) in PUBLIC_STARTUP_ROUTES:
                continue
            response = client.request(
                method,
                path,
                content=b"deliberately-not-a-valid-handler-body",
                follow_redirects=False,
            )
            if is_delegated_source_grant_request(method, path):
                assert response.status_code in {401, 503}, (
                    method,
                    route.path,
                    route.name,
                    response.status_code,
                    response.text,
                )
                if method != "HEAD":
                    assert response.json().get("error", {}).get("code") != "BAD_SESSION"
                checked.append(
                    (method, route.path, type(route.original_route).__name__)
                )
                continue
            if is_mcp_http_request(method, path.encode()):
                assert response.status_code == 401, (
                    method,
                    route.path,
                    route.name,
                    response.status_code,
                    response.text,
                )
                assert response.json()["error"]["code"] == "BAD_API_KEY"
                assert response.headers["www-authenticate"] == 'Bearer realm="DNAForge"'
                checked.append(
                    (method, route.path, type(route.original_route).__name__)
                )
                continue
            assert response.status_code == 401, (
                method,
                route.path,
                route.name,
                response.status_code,
                response.text,
            )
            if method != "HEAD":
                assert response.json()["error"]["code"] == "BAD_SESSION"
            checked.append((method, route.path, type(route.original_route).__name__))

    assert len(checked) >= 25
    assert {"APIRoute", "Route"} <= observed_types
    assert observed_types <= {
        "APIRoute",
        "SanitizedOperationRoute",
        "Route",
        "Mount",
        "WebSocketRoute",
    }


def test_cors_preflight_is_outermost_but_never_authenticates_a_real_request(
    monkeypatch,
):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_SESSION)
    client = _client()
    allowed_origin = "null"

    preflight = client.options(
        "/services/",
        headers={
            "Origin": allowed_origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "X-DNAForge-Session",
        },
    )
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == allowed_origin

    unauthenticated = client.get("/services/", headers={"Origin": allowed_origin})
    assert unauthenticated.status_code == 401

    authenticated = client.get(
        "/services/",
        headers={"Origin": allowed_origin, SESSION_HEADER: TEST_SESSION},
    )
    assert authenticated.status_code == 200
    exposed = authenticated.headers.get("access-control-expose-headers", "").lower()
    assert "x-waypoint-coverage-contract" in exposed
    assert "x-structure-format" in exposed

    attacker = client.options(
        "/services/",
        headers={
            "Origin": "https://attacker.example",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert attacker.status_code == 400
    assert "access-control-allow-origin" not in attacker.headers
