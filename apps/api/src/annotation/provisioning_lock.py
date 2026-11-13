"""Kernel-released writer lease for the shared annotation installation."""

from __future__ import annotations

import asyncio
import errno
import os
import threading
import time
from pathlib import Path
from typing import BinaryIO

_LOCAL_LOCKS_GUARD = threading.Lock()
_LOCAL_LOCKS: dict[Path, threading.Lock] = {}
_PENDING_PUBLICATION_GLOBS = (
    "annotation/.annotation-db-transaction-*",
    "annotation/.annotation-db-committed-*",
    "tools/*/.tool-*-transaction-*",
    "tools/*/.tool-*-committed-*",
)


def _local_lock(path: Path) -> threading.Lock:
    with _LOCAL_LOCKS_GUARD:
        return _LOCAL_LOCKS.setdefault(path, threading.Lock())


class AnnotationInstallationLease:
    """Block until this process exclusively owns one application data root."""

    def __init__(self, application_data_root: Path, *, owner_id: str) -> None:
        root = application_data_root.expanduser().resolve(strict=False)
        self.path = root / ".annotation-provisioning.lock"
        self.owner_id = owner_id
        self._local = _local_lock(self.path)
        self._file: BinaryIO | None = None

    def acquire(self) -> None:
        if self._file is not None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local.acquire()
        file: BinaryIO | None = None
        try:
            descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
            file = os.fdopen(descriptor, "r+b", buffering=0)
            self._lock(file, blocking=True)
            file.seek(0)
            file.truncate()
            file.write((self.owner_id[:512] + "\n").encode("utf-8"))
            self._file = file
        except BaseException:
            if file is not None:
                file.close()
            self._local.release()
            raise

    async def acquire_async(self) -> None:
        await asyncio.to_thread(self.acquire)

    def release(self) -> None:
        file = self._file
        if file is None:
            return
        try:
            self._unlock(file)
        finally:
            file.close()
            self._file = None
            self._local.release()

    @classmethod
    def is_locked(cls, application_data_root: Path) -> bool:
        probe = cls(application_data_root, owner_id="status-probe")
        if probe._local.locked():
            return True
        probe.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(probe.path, os.O_RDWR | os.O_CREAT, 0o600)
        file = os.fdopen(descriptor, "r+b", buffering=0)
        try:
            try:
                cls._lock(file, blocking=False)
            except OSError as exc:
                if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                    return True
                raise
            cls._unlock(file)
            return False
        finally:
            file.close()

    @staticmethod
    def _lock(file: BinaryIO, *, blocking: bool) -> None:
        if os.name == "nt":
            import msvcrt

            file.seek(0, os.SEEK_END)
            if file.tell() == 0:
                file.write(b"\0")
            while True:
                file.seek(0)
                try:
                    msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
                    return
                except OSError as exc:
                    if not blocking or exc.errno not in {
                        errno.EACCES,
                        errno.EAGAIN,
                        errno.EDEADLK,
                    }:
                        raise
                    time.sleep(0.1)

        import fcntl

        operation = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
        fcntl.flock(file.fileno(), operation)

    @staticmethod
    def _unlock(file: BinaryIO) -> None:
        if os.name == "nt":
            import msvcrt

            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
            return

        import fcntl

        fcntl.flock(file.fileno(), fcntl.LOCK_UN)

    def __enter__(self) -> AnnotationInstallationLease:
        self.acquire()
        return self

    def __exit__(self, *_args: object) -> None:
        self.release()


def annotation_installation_is_locked(application_data_root: Path) -> bool:
    return AnnotationInstallationLease.is_locked(application_data_root)


def annotation_installation_needs_recovery(application_data_root: Path) -> bool:
    root = application_data_root.expanduser().resolve(strict=False)
    return any(
        next(root.glob(pattern), None) is not None
        for pattern in _PENDING_PUBLICATION_GLOBS
    )


__all__ = [
    "AnnotationInstallationLease",
    "annotation_installation_is_locked",
    "annotation_installation_needs_recovery",
]
