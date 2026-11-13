import errno
import os
import socket
import subprocess
import sys
from contextlib import closing
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest

from tests import test_annotation_e2e as annotation
from tests import test_sidecar_integration as integration


@pytest.fixture
def live_target(monkeypatch):
    token = "synthetic-live-preflight-secret"
    monkeypatch.setattr(annotation, "SESSION_TOKEN", token)
    monkeypatch.setattr(annotation, "BASE_URL", "http://synthetic.invalid")
    monkeypatch.setattr(annotation, "REQUIRE_LIVE_API", True, raising=False)
    monkeypatch.setattr(integration, "SIDECAR_URL", "http://synthetic.invalid")
    monkeypatch.setattr(integration, "BASE_URL", "http://synthetic.invalid")
    monkeypatch.setattr(integration, "SIDECAR_SESSION_TOKEN", token)
    return token


def run_annotation_preflight(*, allow_absent=False):
    try:
        annotation.skip_if_no_api.__wrapped__(annotation.api_available.__wrapped__())
    except pytest.skip.Exception as exc:
        if allow_absent:
            raise
        raise AssertionError("A selected or reachable target was skipped") from exc


def run_sidecar_preflight():
    try:
        with closing(integration.sidecar.__wrapped__(Mock())) as fixture:
            next(fixture)
    except pytest.skip.Exception as exc:
        raise AssertionError("The selected target was skipped") from exc


def refused_connection():
    error = httpx.ConnectError("synthetic refusal")
    error.__cause__ = ConnectionRefusedError(errno.ECONNREFUSED, "synthetic refusal")
    return error


@pytest.mark.parametrize("required", [False, True])
@pytest.mark.parametrize("route", ["/health", "/services/"])
@pytest.mark.parametrize("status", [401, 404, 500, 503])
def test_annotation_reachable_failure_is_not_optional(
    monkeypatch, live_target, required, route, status
):
    monkeypatch.setattr(annotation, "REQUIRE_LIVE_API", required)

    def request(url, **_kwargs):
        return httpx.Response(
            status if url.endswith(route) else 200,
            text=f"reflected credential {live_target}",
        )

    monkeypatch.setattr(annotation.httpx, "get", request)
    with pytest.raises(pytest.fail.Exception) as failure:
        run_annotation_preflight()
    assert route in str(failure.value)
    assert str(status) in str(failure.value)
    assert live_target not in str(failure.value)


@pytest.mark.parametrize("required", [False, True])
def test_only_optional_unreachable_annotation_skips(monkeypatch, live_target, required):
    monkeypatch.setattr(annotation, "REQUIRE_LIVE_API", required)
    monkeypatch.setattr(
        annotation.httpx,
        "get",
        Mock(side_effect=refused_connection()),
    )
    expected = pytest.fail.Exception if required else pytest.skip.Exception
    with pytest.raises(expected) as outcome:
        run_annotation_preflight(allow_absent=not required)
    assert live_target not in str(outcome.value)


@pytest.mark.parametrize("cause_errno", [None, errno.EMFILE, errno.EACCES])
def test_optional_connect_error_requires_actual_refusal(
    monkeypatch, live_target, cause_errno
):
    monkeypatch.setattr(annotation, "REQUIRE_LIVE_API", False)
    error = httpx.ConnectError(live_target)
    if cause_errno is not None:
        error.__cause__ = OSError(cause_errno, live_target)
    monkeypatch.setattr(annotation.httpx, "get", Mock(side_effect=error))
    with pytest.raises(pytest.fail.Exception, match="ConnectError"):
        run_annotation_preflight()


@pytest.mark.parametrize("status", [201, 204])
def test_successful_preconditions_preserve_2xx_contract(
    monkeypatch, live_target, status
):
    monkeypatch.setattr(
        annotation.httpx, "get", Mock(return_value=httpx.Response(status))
    )
    run_annotation_preflight()


@pytest.mark.parametrize(
    "cause_errno", [errno.ECONNREFUSED, errno.EMFILE, errno.EACCES]
)
@pytest.mark.parametrize("required", [False, True])
def test_actual_httpx_transport_preserves_refusal_classification(
    monkeypatch, live_target, cause_errno, required
):
    monkeypatch.setattr(annotation, "REQUIRE_LIVE_API", required)
    monkeypatch.setattr(annotation, "BASE_URL", "http://127.0.0.1:8000")
    monkeypatch.setenv("HTTP_PROXY", "http://synthetic-proxy.invalid:3128")
    monkeypatch.setenv("NO_PROXY", "")
    connect = Mock(side_effect=OSError(cause_errno, live_target))
    monkeypatch.setattr(socket, "create_connection", connect)
    optional_absence = not required and cause_errno == errno.ECONNREFUSED
    expected = pytest.skip.Exception if optional_absence else pytest.fail.Exception
    with pytest.raises(expected) as outcome:
        run_annotation_preflight(allow_absent=optional_absence)
    assert live_target not in str(outcome.value)
    assert connect.call_count == 1
    assert connect.call_args.args[0] == (
        ("synthetic-proxy.invalid", 3128) if required else ("127.0.0.1", 8000)
    )


@pytest.mark.parametrize("required", [False, True])
@pytest.mark.parametrize("failure_type", [httpx.ReadTimeout, httpx.RemoteProtocolError])
def test_annotation_transport_failure_is_not_absence(
    monkeypatch, live_target, required, failure_type
):
    monkeypatch.setattr(annotation, "REQUIRE_LIVE_API", required)
    monkeypatch.setattr(
        annotation.httpx, "get", Mock(side_effect=failure_type(live_target))
    )
    with pytest.raises(pytest.fail.Exception) as failure:
        run_annotation_preflight()
    assert failure_type.__name__ in str(failure.value)
    assert live_target not in str(failure.value)
    assert failure.value.__suppress_context__


@pytest.mark.parametrize("required", [False, True])
def test_reachable_annotation_requires_supplied_credential(
    monkeypatch, live_target, required
):
    monkeypatch.setattr(annotation, "REQUIRE_LIVE_API", required)
    monkeypatch.setattr(annotation, "SESSION_TOKEN", None)
    get = Mock(return_value=httpx.Response(200))
    monkeypatch.setattr(annotation.httpx, "get", get)
    with pytest.raises(pytest.fail.Exception, match="DNAFORGE_MCP_SESSION_TOKEN"):
        run_annotation_preflight()
    assert get.call_count == 1


@pytest.mark.parametrize("required", [False, True])
def test_healthy_annotation_reaches_original_scientific_assertions(
    monkeypatch, live_target, required
):
    monkeypatch.setattr(annotation, "REQUIRE_LIVE_API", required)
    monkeypatch.setattr(annotation.httpx, "get", Mock(return_value=httpx.Response(200)))
    post = Mock(
        return_value=httpx.Response(200, json={"features": [], "sequence_length": 0})
    )
    monkeypatch.setattr(annotation.httpx, "post", post)
    run_annotation_preflight()
    annotation.TestAnnotationService().test_plannotate_empty_sequence()
    assert post.call_args.kwargs["headers"] == {"X-DNAForge-Session": live_target}


@pytest.mark.parametrize("status", [401, 404, 500, 503])
def test_explicit_sidecar_unhealthy_fails_without_spawning(
    monkeypatch, live_target, status
):
    monkeypatch.setattr(
        integration.httpx, "get", Mock(return_value=httpx.Response(status))
    )
    popen = Mock()
    monkeypatch.setattr(integration.subprocess, "Popen", popen)
    with pytest.raises(pytest.fail.Exception) as failure:
        run_sidecar_preflight()
    assert "/health" in str(failure.value)
    assert str(status) in str(failure.value)
    popen.assert_not_called()


def test_explicit_sidecar_unreachable_fails_without_spawning(monkeypatch, live_target):
    monkeypatch.setattr(
        integration.httpx, "get", Mock(side_effect=httpx.ConnectError(live_target))
    )
    popen = Mock()
    monkeypatch.setattr(integration.subprocess, "Popen", popen)
    with pytest.raises(pytest.fail.Exception) as failure:
        run_sidecar_preflight()
    assert live_target not in str(failure.value)
    popen.assert_not_called()


def test_explicit_sidecar_checks_protected_route(monkeypatch, live_target):
    get = Mock(side_effect=[httpx.Response(200), httpx.Response(401)])
    monkeypatch.setattr(integration.httpx, "get", get)
    with pytest.raises(pytest.fail.Exception, match="401"):
        run_sidecar_preflight()
    assert get.call_args.args[0].endswith("/services/")


def test_optional_listener_lost_after_health_fails(monkeypatch, live_target):
    monkeypatch.setattr(annotation, "REQUIRE_LIVE_API", False)
    monkeypatch.setattr(
        annotation.httpx,
        "get",
        Mock(side_effect=[httpx.Response(200), httpx.ConnectError(live_target)]),
    )
    with pytest.raises(pytest.fail.Exception, match="/services/"):
        run_annotation_preflight()


@pytest.mark.parametrize("supplied", [False, True])
def test_live_credential_is_captured_before_unit_test_defaults(supplied):
    env = os.environ.copy()
    env.pop("DNAFORGE_MCP_SESSION_TOKEN", None)
    env["BASE_URL"] = "http://synthetic.invalid"
    env["SIDECAR_URL"] = "http://synthetic.invalid"
    if supplied:
        env["DNAFORGE_MCP_SESSION_TOKEN"] = "synthetic-supplied-session"
    program = "\n".join(
        [
            "import tests.conftest",
            "from tests import test_annotation_e2e as annotation",
            "from tests import test_sidecar_integration as integration",
            "import os",
            "expected = 'synthetic-supplied-session' if os.environ['SUPPLIED'] == '1' else None",
            "assert annotation.SESSION_TOKEN == expected",
            "assert integration.SIDECAR_SESSION_TOKEN == expected",
            "assert annotation.REQUIRE_LIVE_API",
        ]
    )
    env["SUPPLIED"] = "1" if supplied else "0"
    result = subprocess.run(
        [sys.executable, "-c", program],
        env=env,
        text=True,
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("preflight_status", [0, 1])
def test_smoke_wrapper_requires_successful_preflight(tmp_path, preflight_status):
    uv = tmp_path / "uv"
    uv.write_text(
        f"#!{sys.executable}\n"
        "import os,sys\n"
        "from pathlib import Path\n"
        "with Path(os.environ['SMOKE_COMMAND_LOG']).open('a') as stream:\n"
        "    stream.write(' '.join(sys.argv[1:])+'\\n')\n"
        "if 'tests.live_sidecar_preflight' in sys.argv:\n"
        "    sys.exit(int(os.environ['PREFLIGHT_STATUS']))\n"
    )
    uv.chmod(0o755)
    log = tmp_path / "commands.log"
    env = {
        **os.environ,
        "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
        "SMOKE_COMMAND_LOG": str(log),
        "PREFLIGHT_STATUS": str(preflight_status),
        "DNAFORGE_MCP_SESSION_TOKEN": "synthetic-wrapper-secret",
    }
    result = subprocess.run(
        [
            "bash",
            str(Path(__file__).parents[1] / "scripts/smoke-test.sh"),
            "http://synthetic.invalid",
        ],
        env=env,
        text=True,
        capture_output=True,
        timeout=20,
    )
    commands = log.read_text().splitlines()
    assert result.returncode == preflight_status
    assert "tests.live_sidecar_preflight" in commands[0]
    assert len(commands) == (2 if preflight_status == 0 else 1)
    assert (
        "synthetic-wrapper-secret"
        not in result.stdout + result.stderr + log.read_text()
    )
