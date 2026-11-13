"""Shared pytest environment for the sidecar test suite.

Production sidecars are launched with a server-owned MCP capability grant AND a
per-launch session token. Most route tests exercise behavior *after* that launch
contract has been established, so give them the same configured baseline.
Security tests that prove fail-closed behavior opt out explicitly — see
`anonymous_client` below.

 note. Every route except a short, argued public list now requires the
session token (`src/security/local_access.py`). Without the two pieces of setup
here, roughly 110 existing call sites across ~18 test files would fail — and
they would fail with **500 MCP_SESSION_NOT_CONFIGURED**, not 401, because a
sidecar with no token configured is a misconfigured server rather than a
rejected client. That distinction is easy to lose an hour to, so it is written
down here.

Both pieces run at MODULE level, not only inside a fixture, because several test
modules build their `TestClient` at import time — before any fixture has had a
chance to run.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
from starlette.testclient import TestClient

from src.concurrency.pools import reset_pool_manager
from tests.live_sidecar_preflight import SESSION_TOKEN_AT_TEST_START
from tests.sidecar_test_client import TEST_SIDECAR_SESSION

pytest_plugins = ["tests.assembly_fixtures"]

TEST_SESSION_TOKEN = TEST_SIDECAR_SESSION

SESSION_HEADER = "X-DNAForge-Session"


os.environ.setdefault(
    "DNAFORGE_MCP_SESSION_TOKEN", SESSION_TOKEN_AT_TEST_START or TEST_SESSION_TOKEN
)
os.environ.setdefault("DNAFORGE_MCP_GRANT_CAPABILITIES", "*")
os.environ.setdefault("DNAFORGE_ALLOWED_RENDERER_ORIGIN", "null")


_ORIGINAL_TEST_CLIENT_INIT = TestClient.__init__


def _test_client_init_with_session(self, *args, **kwargs):  # type: ignore[no-untyped-def]
    """Give every `TestClient` the session header a real caller would send.

    This is deliberately a patch on the test client rather than an edit to ~110
    call sites. Magic in test infrastructure is cheap — it lives in one file
    that every contributor reads when tests behave oddly. Magic in production
    code is what  was about.

    A client that sets the header itself keeps its own value, so a test can
    still exercise a wrong or expired token.
    """
    _ORIGINAL_TEST_CLIENT_INIT(self, *args, **kwargs)
    if SESSION_HEADER not in self.headers:
        self.headers[SESSION_HEADER] = TEST_SESSION_TOKEN


TestClient.__init__ = _test_client_init_with_session  # type: ignore[method-assign]


@pytest.fixture(autouse=True)
def configured_mcp_session_grant(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[None]:
    """Model a normal launch and restore process-global pool state afterward."""

    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "*")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_SESSION_TOKEN)
    try:
        yield
    finally:
        reset_pool_manager()


def anonymous_client(app, **kwargs) -> TestClient:
    """A `TestClient` that presents no credential at all.

    The one thing the patch above makes hard is testing the refusal, which is
    the entire point of  — so hand it back explicitly.
    """
    client = TestClient(app, **kwargs)
    if SESSION_HEADER in client.headers:
        del client.headers[SESSION_HEADER]
    return client


@pytest.fixture(scope="session")
def assembly_sequences_dir(assembly_fixture_directory):
    path = assembly_fixture_directory / "sequences"
    if not path.exists():
        pytest.skip("wp-assets/00-assembly/sequences not found")
    return path
