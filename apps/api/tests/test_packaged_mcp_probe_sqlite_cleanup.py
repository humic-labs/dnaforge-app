"""Release-probe contracts that must hold on Windows file semantics."""

from __future__ import annotations

import ast
from pathlib import Path

PROBE = Path(__file__).parents[1] / "scripts" / "verify_packaged_mcp.py"


def test_every_probe_sqlite_connection_has_an_explicit_close_context() -> None:
    """sqlite3's context manager does not close files; Windows needs closing()."""
    tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))
    sqlite_connections = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "sqlite3"
        and node.func.attr == "connect"
    ]
    explicitly_closed = {
        id(node.args[0])
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "closing"
        and node.args
    }

    assert sqlite_connections, "the packaged MCP probe should exercise its SQLite state"
    assert all(
        id(connection) in explicitly_closed for connection in sqlite_connections
    ), (
        "every sqlite3.connect() in the packaged MCP probe must be wrapped in closing(); "
        "the connection context manager commits or rolls back but does not close the file"
    )
