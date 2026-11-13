import argparse
import errno
import os
import sys
from http import HTTPStatus

import httpcore
import httpx
import pytest

SESSION_TOKEN_AT_TEST_START = os.environ.get("DNAFORGE_MCP_SESSION_TOKEN")


def _connection_refused(error):
    cause = error
    seen = set()
    while cause is not None and id(cause) not in seen:
        seen.add(id(cause))
        if isinstance(cause, OSError) and cause.errno == errno.ECONNREFUSED:
            return True
        if not isinstance(cause, (httpx.ConnectError, httpcore.ConnectError)):
            return False
        nested = cause.__cause__ or cause.__context__
        if (
            nested is None
            and len(cause.args) == 1
            and isinstance(cause.args[0], BaseException)
        ):
            nested = cause.args[0]
        cause = nested
    return False


def _response(base_url, route, *, headers=None, optional_absence=False):
    try:
        response = httpx.get(
            f"{base_url.rstrip('/')}{route}",
            headers=headers,
            timeout=3.0,
            trust_env=not optional_absence,
        )
    except httpx.ConnectError as exc:
        if optional_absence and _connection_refused(exc):
            return None
        raise pytest.fail.Exception(
            f"Live sidecar prerequisite {route}: ConnectError", pytrace=False
        ) from None
    except (httpx.HTTPError, httpx.InvalidURL, ValueError) as exc:
        raise pytest.fail.Exception(
            f"Live sidecar prerequisite {route}: {type(exc).__name__}", pytrace=False
        ) from None
    if not response.is_success:
        try:
            detail = HTTPStatus(response.status_code).phrase
        except ValueError:
            detail = "unexpected status"
        pytest.fail(
            f"Live sidecar prerequisite {route}: HTTP {response.status_code} ({detail})",
            pytrace=False,
        )
    return response


def probe_live_sidecar(
    base_url, *, session_token, required, protected_path="/services/"
):
    if _response(base_url, "/health", optional_absence=not required) is None:
        return False
    if not session_token:
        pytest.fail(
            "Reachable live sidecar requires a supplied DNAFORGE_MCP_SESSION_TOKEN",
            pytrace=False,
        )
    _response(
        base_url,
        protected_path,
        headers={"X-DNAForge-Session": session_token},
    )
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument(
        "--protected-path",
        choices=["/services/", "/toolbox/status"],
        default="/services/",
    )
    args = parser.parse_args()
    try:
        probe_live_sidecar(
            args.url,
            session_token=SESSION_TOKEN_AT_TEST_START,
            required=True,
            protected_path=args.protected_path,
        )
    except pytest.fail.Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print("Selected sidecar health and credential prerequisites passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
