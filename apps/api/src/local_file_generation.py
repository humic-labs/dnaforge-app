"""Exact stat-based identity for one local file generation."""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


class LocalFileGeneration(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    canonical_path: str = Field(alias="canonicalPath", min_length=1, max_length=4096)
    size: int = Field(ge=0)
    mtime_ns: str = Field(alias="mtimeNs", pattern=r"^\d+$")
    ctime_ns: str = Field(alias="ctimeNs", pattern=r"^\d+$")
    device: str | None = Field(default=None, pattern=r"^\d+$")
    inode: str | None = Field(default=None, pattern=r"^\d+$")


def capture_local_file_generation(
    path: str | Path,
    *,
    non_file_message: str = "The selected local source is not a file.",
) -> LocalFileGeneration:
    selected = Path(path)
    canonical = selected.resolve(strict=True)
    if not canonical.is_file():
        raise ValueError(non_file_message)
    metadata = canonical.stat()
    return LocalFileGeneration(
        canonicalPath=str(canonical),
        size=metadata.st_size,
        mtimeNs=str(metadata.st_mtime_ns),
        ctimeNs=str(metadata.st_ctime_ns),
        device=str(metadata.st_dev),
        inode=str(metadata.st_ino),
    )


__all__ = ["LocalFileGeneration", "capture_local_file_generation"]
