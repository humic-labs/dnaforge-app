"""Portable cross-process serialization for one filesystem target."""

from __future__ import annotations

import errno
import os
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO, Iterator


@dataclass
class _LocalLockOwner:
    lock: threading.Lock = field(default_factory=threading.Lock)
    users: int = 0


_LOCAL_LOCKS_GUARD = threading.Lock()
_LOCAL_LOCKS: dict[Path, _LocalLockOwner] = {}


def file_target_lock_path(target: Path) -> Path:
    return target.with_suffix(target.suffix + ".lock")


def _lock_file(file: BinaryIO) -> None:
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
                if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                    raise
                time.sleep(0.1)

    import fcntl

    fcntl.flock(file.fileno(), fcntl.LOCK_EX)


def _unlock_file(file: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        file.seek(0)
        msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
        return

    import fcntl

    fcntl.flock(file.fileno(), fcntl.LOCK_UN)


@contextmanager
def file_target_lock(target: Path) -> Iterator[None]:
    """Block until this process exclusively owns one shared target."""

    lock_path = file_target_lock_path(target).resolve(strict=False)
    with _LOCAL_LOCKS_GUARD:
        owner = _LOCAL_LOCKS.get(lock_path)
        if owner is None:
            owner = _LocalLockOwner()
            _LOCAL_LOCKS[lock_path] = owner
        owner.users += 1
    try:
        with owner.lock:
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
            with os.fdopen(descriptor, "r+b", buffering=0) as file:
                _lock_file(file)
                try:
                    yield
                finally:
                    _unlock_file(file)
    finally:
        with _LOCAL_LOCKS_GUARD:
            owner.users -= 1
            if owner.users == 0 and _LOCAL_LOCKS.get(lock_path) is owner:
                _LOCAL_LOCKS.pop(lock_path, None)


__all__ = ["file_target_lock", "file_target_lock_path"]
