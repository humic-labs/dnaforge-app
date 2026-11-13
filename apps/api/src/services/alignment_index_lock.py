"""Alignment-index names for the shared portable target lock."""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .file_target_lock import file_target_lock, file_target_lock_path


def alignment_index_lock_path(target: Path) -> Path:
    return file_target_lock_path(target)


@contextmanager
def alignment_index_target_lock(target: Path) -> Iterator[None]:
    with file_target_lock(target):
        yield


__all__ = ["alignment_index_lock_path", "alignment_index_target_lock"]
