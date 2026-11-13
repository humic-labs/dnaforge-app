"""Private connection receipt, written only while the runtime owns its lease."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path


def operation_runtime_directory() -> Path:
    configured = os.environ.get("DNAFORGE_OPERATION_RUNTIME_DIR")
    return (
        Path(configured).expanduser()
        if configured
        else Path.home() / ".dnaforge" / "operations"
    )


def operation_connection_path(db_path: Path, scope_id: str) -> Path:
    """Derive the private registry filename from a ledger and operation scope."""
    explicit = os.environ.get("DNAFORGE_OPERATION_CONNECTION_FILE")
    if explicit:
        return Path(explicit).expanduser()
    runtime_key = f"{db_path.resolve()}\0{scope_id}"
    scope_digest = hashlib.sha256(runtime_key.encode()).hexdigest()[:16]
    return operation_runtime_directory() / f"{scope_digest}.connection.json"


def publish_operation_connection(
    path: Path,
    *,
    url: str,
    session_token: str,
    operation_token: str,
    scope_id: str,
    owner_id: str,
    owner_instance: str,
    mcp_stdio: bool = False,
) -> None:
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    prune_dead_operation_connections(path.parent)
    payload = {
        "version": 1,
        "url": url,
        "session_token": session_token,
        "operation_token": operation_token,
        "scope_id": scope_id,
        "owner_id": owner_id,
        "owner_instance": owner_instance,
        "mcp_stdio": mcp_stdio,
        "pid": os.getpid(),
    }
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(payload, output, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        handle = kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return code.value == 259
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def prune_dead_operation_connections(directory: Path | None = None) -> None:
    """Delete receipts whose runtime process is gone.

    A crashed or force-killed runtime never reaches its graceful retirement, so
    its receipt outlives it. The inode check spares a successor that replaced
    the file after it was read.
    """
    for path in (directory or operation_runtime_directory()).glob("*.connection.json"):
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(descriptor, "r", encoding="utf-8") as source:
                identity = os.fstat(source.fileno())
                if identity.st_size > 16_384:
                    continue
                pid = json.load(source).get("pid")
            if isinstance(pid, bool) or not isinstance(pid, int) or process_alive(pid):
                continue
            current = path.lstat()
            if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                path.unlink()
        except (OSError, ValueError, UnicodeError, AttributeError):
            continue


def retire_operation_connection(path: Path, *, owner_instance: str) -> None:
    try:
        if path.is_symlink() or path.stat().st_size > 16_384:
            return
        payload = json.loads(path.read_text("utf-8"))
        if (
            isinstance(payload, dict)
            and payload.get("owner_instance") == owner_instance
        ):
            path.unlink()
    except (OSError, ValueError, UnicodeError):
        return
