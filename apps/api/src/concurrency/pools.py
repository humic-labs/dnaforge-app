"""Named pool accounting for sidecar tool execution."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator

from .refusals import QueueRefusal
from .schema import PoolName


@dataclass(frozen=True)
class PoolConfig:
    name: str
    size: int
    max_queued_jobs: int
    backing: str


class ManagedPool:
    def __init__(self, config: PoolConfig):
        self.config = config
        self._semaphore = asyncio.Semaphore(config.size)
        self._lock = asyncio.Lock()
        self._active = 0
        self._queued = 0

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        marked_queued = False
        async with self._lock:
            if self._semaphore.locked():
                if self._queued >= self.config.max_queued_jobs:
                    refusal_kind = (
                        "saturated"
                        if self._queued >= self.config.max_queued_jobs * 2
                        else "transient"
                    )
                    raise QueueRefusal(
                        pool=self.config.name,
                        queue_depth=self._queued,
                        pool_capacity=self.config.size,
                        refusal_kind=refusal_kind,
                    )
                self._queued += 1
                marked_queued = True
        try:
            await self._semaphore.acquire()
            async with self._lock:
                if marked_queued:
                    self._queued -= 1
                    marked_queued = False
                self._active += 1
            try:
                yield
            finally:
                async with self._lock:
                    self._active -= 1
                self._semaphore.release()
        except BaseException:
            if marked_queued:
                async with self._lock:
                    self._queued = max(0, self._queued - 1)
            raise

    def stats(self) -> dict:
        return {
            "size": self.config.size,
            "active": self._active,
            "queued": self._queued,
            "backing": self.config.backing,
            "max_queued_jobs": self.config.max_queued_jobs,
        }


class PoolManager:
    def __init__(self, configs: list[PoolConfig] | None = None):
        configs = configs or default_pool_configs()
        self._pools = {config.name: ManagedPool(config) for config in configs}

    def get(self, name: str) -> ManagedPool:
        try:
            return self._pools[name]
        except KeyError as exc:
            raise KeyError(f"Unknown pool: {name}") from exc

    async def run(self, pool_name: str, coro):
        async with self.get(pool_name).slot():
            return await coro

    def stats(self) -> dict:
        return {name: pool.stats() for name, pool in self._pools.items()}


def default_pool_configs() -> list[PoolConfig]:
    cpu_count = os.cpu_count() or 4
    return [
        PoolConfig(PoolName.CPU_FAST.value, max(1, cpu_count), 32, "process"),
        PoolConfig(
            PoolName.CPU_SLOW.value, min(4, max(2, cpu_count // 2)), 16, "process"
        ),
        PoolConfig(PoolName.WARM_MODEL.value, 1, 8, "process-warm"),
        PoolConfig(PoolName.NETWORK_IO.value, 10, 64, "asyncio"),
        PoolConfig(PoolName.GPU.value, 1, 4, "process-future"),
        PoolConfig(PoolName.TILE_IO.value, min(8, max(2, cpu_count)), 64, "asyncio"),
        PoolConfig(PoolName.ALIGNMENT_CONTROL.value, 2, 16, "asyncio"),
    ]


_POOL_MANAGER: PoolManager | None = None


def get_pool_manager() -> PoolManager:
    global _POOL_MANAGER
    if _POOL_MANAGER is None:
        _POOL_MANAGER = PoolManager()
    return _POOL_MANAGER


def reset_pool_manager(configs: list[PoolConfig] | None = None) -> PoolManager:
    global _POOL_MANAGER
    _POOL_MANAGER = PoolManager(configs)
    return _POOL_MANAGER
