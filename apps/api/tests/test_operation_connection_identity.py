import json
import os

import pytest

from src.managed_operations_cli import OperationConnection
from src.operation_connection import publish_operation_connection


@pytest.fixture
def published_connection(tmp_path):
    path = tmp_path / "runtime" / "connection.json"
    publish_operation_connection(
        path,
        url="http://127.0.0.1:8004",
        session_token="session",
        operation_token="operation",
        scope_id="scope",
        owner_id="local-human",
        owner_instance="runtime-owner-identity",
        mcp_stdio=True,
    )
    path.chmod(0o600)
    return path


def test_read_preserves_published_runtime_owner_metadata(published_connection):
    connection = OperationConnection.read(published_connection)

    assert connection.pid == os.getpid()
    assert connection.owner_instance == "runtime-owner-identity"
    assert connection.mcp_stdio is True


@pytest.mark.parametrize(
    "omitted_fields",
    [("pid",), ("owner_instance",), ("pid", "owner_instance")],
    ids=["without-pid", "without-owner-instance", "without-both"],
)
def test_read_accepts_omitted_legacy_owner_metadata(
    published_connection, omitted_fields
):
    body = json.loads(published_connection.read_text())
    for field in omitted_fields:
        del body[field]
    published_connection.write_text(json.dumps(body))

    connection = OperationConnection.read(published_connection)

    assert connection.pid == (None if "pid" in omitted_fields else os.getpid())
    assert connection.owner_instance == (
        None if "owner_instance" in omitted_fields else "runtime-owner-identity"
    )
    assert connection.mcp_stdio is True


def test_existing_six_positional_arguments_preserve_mcp_stdio():
    connection = OperationConnection(
        "http://127.0.0.1:8004", "session", "operation", "scope", "local-human", True
    )

    assert connection.mcp_stdio is True


def test_owner_metadata_appends_after_mcp_stdio():
    connection = OperationConnection(
        "http://127.0.0.1:8004",
        "session",
        "operation",
        "scope",
        "local-human",
        True,
        os.getpid(),
        "runtime-owner-identity",
    )

    assert connection.mcp_stdio is True
    assert connection.pid == os.getpid()
    assert connection.owner_instance == "runtime-owner-identity"


@pytest.mark.parametrize(
    "pid",
    [None, 0, -1, "123", 1.5, True, False],
    ids=["null", "zero", "negative", "string", "float", "true", "false"],
)
def test_read_rejects_present_invalid_pid(published_connection, pid):
    body = json.loads(published_connection.read_text())
    body["pid"] = pid
    published_connection.write_text(json.dumps(body))

    with pytest.raises(ValueError):
        OperationConnection.read(published_connection)


@pytest.mark.parametrize(
    "owner_instance",
    [None, "", 0, False, [], {}],
    ids=["null", "empty", "integer", "boolean", "list", "object"],
)
def test_read_rejects_present_invalid_owner_instance(
    published_connection, owner_instance
):
    body = json.loads(published_connection.read_text())
    body["owner_instance"] = owner_instance
    published_connection.write_text(json.dumps(body))

    with pytest.raises(ValueError):
        OperationConnection.read(published_connection)
