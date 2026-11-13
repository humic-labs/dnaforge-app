"""Cancellation-safe coalescing for identical asynchronous provider reads."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Hashable
from typing import Generic, TypeVar

KeyT = TypeVar("KeyT", bound=Hashable)
ValueT = TypeVar("ValueT")


class AsyncSingleFlight(Generic[KeyT, ValueT]):
    """Let concurrent callers share one producer without sharing cancellation.

    The producer outlives any individual waiter. This matters when a renderer
    unmounts during React's development lifecycle or a viewport tile is
    cancelled while another consumer still needs the same immutable content.
    Completed and failed producers are retired so later calls can read the
    persistent cache or begin a genuine retry.
    """

    def __init__(self) -> None:
        self._tasks: dict[KeyT, asyncio.Task[ValueT]] = {}
        self._lock = asyncio.Lock()

    async def run(
        self,
        key: KeyT,
        producer: Callable[[], Awaitable[ValueT]],
    ) -> ValueT:
        async with self._lock:
            task = self._tasks.get(key)
            if task is not None and task.done():
                self._tasks.pop(key, None)
                task = None
            if task is None:
                task = asyncio.create_task(producer())
                self._tasks[key] = task
                task.add_done_callback(
                    lambda completed, completed_key=key: self._task_finished(
                        completed_key, completed
                    )
                )
        return await asyncio.shield(task)

    def _task_finished(self, key: KeyT, completed: asyncio.Task[ValueT]) -> None:
        if not completed.cancelled():
            completed.exception()
        if self._tasks.get(key) is completed:
            self._tasks.pop(key, None)
