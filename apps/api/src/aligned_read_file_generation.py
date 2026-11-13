"""One stat-based identity for local aligned-read source files."""

from __future__ import annotations

from pathlib import Path

from .local_file_generation import LocalFileGeneration, capture_local_file_generation


class AlignedReadFileGeneration(LocalFileGeneration):
    """Named wire contract retained for aligned-read OpenAPI consumers."""


def capture_aligned_read_file_generation(
    path: str | Path,
) -> AlignedReadFileGeneration:
    generation = capture_local_file_generation(
        path,
        non_file_message="The aligned-read source bundle contains a non-file path.",
    )
    return AlignedReadFileGeneration.model_validate(
        generation.model_dump(mode="json", by_alias=True, exclude_none=False)
    )


__all__ = [
    "AlignedReadFileGeneration",
    "capture_aligned_read_file_generation",
]
