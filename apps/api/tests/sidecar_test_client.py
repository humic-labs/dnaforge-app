"""Authenticated TestClient used by ordinary sidecar route behavior tests."""

from fastapi.testclient import TestClient

TEST_SIDECAR_SESSION = "test-suite-sidecar-session"


class AuthenticatedSidecarTestClient(TestClient):
    """Model Electron's automatic launch-session header in route tests."""

    def __init__(self, app, **kwargs):
        headers = dict(kwargs.pop("headers", {}) or {})
        headers.setdefault("X-DNAForge-Session", TEST_SIDECAR_SESSION)
        super().__init__(app, headers=headers, **kwargs)
