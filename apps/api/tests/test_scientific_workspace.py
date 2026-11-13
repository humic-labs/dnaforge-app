import threading
from pathlib import Path

import pytest

from src.services.scientific_workspace import run_scientific_workspace


@pytest.mark.asyncio
async def test_failed_neighbor_preserves_completed_artifacts_and_source(tmp_path):
    source = tmp_path / "source.fastq"
    source.write_bytes(b"@read\nACGT\n+\nIIII\n")
    cache = tmp_path / "cache"

    async def complete(root: Path) -> Path:
        artifact = root / "result.json"
        artifact.write_bytes(b'{"accepted":true}')
        return artifact

    accepted = await run_scientific_workspace(
        cache, "analysis-", threading.Event(), complete
    )

    async def fail(root: Path) -> Path:
        (root / "partial.fastq").write_bytes(source.read_bytes())
        raise ValueError("malformed next read")

    with pytest.raises(ValueError, match="malformed next read"):
        await run_scientific_workspace(cache, "analysis-", threading.Event(), fail)

    assert accepted.read_bytes() == b'{"accepted":true}'
    assert source.read_bytes() == b"@read\nACGT\n+\nIIII\n"
    assert list(cache.iterdir()) == [accepted.parent]
