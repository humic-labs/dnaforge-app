from __future__ import annotations

import errno
import hashlib
import os
from pathlib import Path
from typing import BinaryIO

from .contracts import RuntimeOwnerConflict


class RuntimeScopeLease:
    """Kernel-released ownership lock for one control-plane runtime scope."""

    def __init__(self, database_path: Path, runtime_scope: str, owner_instance_id: str):
        scope_hash = hashlib.sha256(runtime_scope.encode("utf-8")).hexdigest()[:20]
        resolved_database = database_path.expanduser().resolve()
        self.path = resolved_database.with_name(
            f".{resolved_database.name}.operation-owner-{scope_hash}.lock"
        )
        self.runtime_scope = runtime_scope
        self.owner_instance_id = owner_instance_id
        self._file: BinaryIO | None = None

    def acquire(self) -> None:
        if self._file is not None:
            return
        descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        file = os.fdopen(descriptor, "r+b", buffering=0)
        try:
            self._lock(file)
        except OSError as exc:
            file.close()
            if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise RuntimeOwnerConflict(
                    f"Managed runtime scope {self.runtime_scope!r} already has a live owner"
                ) from exc
            raise
        file.seek(0)
        file.truncate()
        file.write(f"{self.owner_instance_id}\n".encode("utf-8"))
        self._file = file

    def release(self) -> None:
        file = self._file
        if file is None:
            return
        try:
            self._unlock(file)
        finally:
            file.close()
            self._file = None

    @staticmethod
    def _lock(file: BinaryIO) -> None:
        if os.name == "nt":
            import msvcrt

            file.seek(0)
            if not file.read(1):
                file.seek(0)
                file.write(b"\0")
            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
            return

        import fcntl

        fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    @staticmethod
    def _unlock(file: BinaryIO) -> None:
        if os.name == "nt":
            import msvcrt

            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
            return

        import fcntl

        fcntl.flock(file.fileno(), fcntl.LOCK_UN)

    def __enter__(self) -> RuntimeScopeLease:
        self.acquire()
        return self

    def __exit__(self, *_args: object) -> None:
        self.release()
