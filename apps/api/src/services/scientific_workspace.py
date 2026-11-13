from __future__ import annotations

import asyncio
import shutil
import tempfile
import threading
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TypeVar

Result = TypeVar("Result")


async def run_scientific_workspace(
    cache: Path,
    prefix: str,
    cancel: threading.Event,
    operation: Callable[[Path], Awaitable[Result]],
) -> Result:
    cache = cache.resolve()
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    root = Path(tempfile.mkdtemp(prefix=prefix, dir=cache))
    work = asyncio.create_task(operation(root))
    try:
        try:
            return await asyncio.shield(work)
        except asyncio.CancelledError:
            cancel.set()
            settlement = asyncio.gather(work, return_exceptions=True)
            while not settlement.done():
                try:
                    await asyncio.shield(settlement)
                except asyncio.CancelledError:
                    continue
            raise
    except BaseException:
        shutil.rmtree(root)
        raise
