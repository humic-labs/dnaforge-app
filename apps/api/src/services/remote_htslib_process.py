"""Bounded spawned workers for native remote reads that can hold Python's GIL.

Keep native network waits outside the serving process. Control reads have their
own worker so blocked data requests cannot queue reconnection behind themselves.
Route admission and source validation remain with each existing caller.
"""

from __future__ import annotations

import asyncio
import atexit
import multiprocessing
import os
import threading
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from multiprocessing.connection import Connection
from typing import Callable, Literal, TypeVar

from ..compute_scheduling import prefer_current_thread
from ..concurrency.pools import get_pool_manager
from ..concurrency.schema import PoolName

_T = TypeVar("_T")
_LOCK = threading.Lock()
_Lane = Literal["variant", "alignment", "control"]
_EXECUTORS: dict[_Lane, ProcessPoolExecutor] = {}
_ALIGNMENT_CHILDREN: set[multiprocessing.Process] = set()
_CHILD_TERMINATION_GRACE_SECONDS = 0.5


class _AlignmentReceiver:
    def __init__(self, connection: Connection) -> None:
        self._connection = connection
        self._lock = threading.Lock()
        self._started = False
        self._abandoned = False

    def receive(self):
        with self._lock:
            if self._abandoned:
                raise EOFError
            self._started = True
        try:
            return self._connection.recv()
        finally:
            self._connection.close()

    def abandon(self) -> None:
        with self._lock:
            self._abandoned = True
            if not self._started:
                self._connection.close()


def _alignment_worker(
    sender: Connection, worker: Callable[..., object], args: tuple[object, ...]
) -> None:
    try:
        prefer_current_thread()
        try:
            result = (True, worker(*args))
        except BaseException as error:
            result = (False, error)
        sender.send(result)
    finally:
        sender.close()


def _reap_alignment_child(child: multiprocessing.Process, terminate: bool) -> None:
    if child.pid is None:
        return
    if terminate and child.is_alive():
        child.terminate()
    child.join(timeout=_CHILD_TERMINATION_GRACE_SECONDS)
    if child.is_alive():
        child.kill()
        child.join()


async def _finish_alignment_child(
    child: multiprocessing.Process,
    receiver: _AlignmentReceiver,
    receive_result: asyncio.Future | None,
    terminate: bool,
) -> None:
    cancelled_during_cleanup = False
    try:
        if child.pid is not None:
            if terminate and child.is_alive():
                child.terminate()
            loop = asyncio.get_running_loop()
            deadline = loop.time() + _CHILD_TERMINATION_GRACE_SECONDS
            killed = False
            while child.is_alive():
                if not killed and loop.time() >= deadline:
                    child.kill()
                    killed = True
                try:
                    await asyncio.sleep(0.01)
                except asyncio.CancelledError:
                    cancelled_during_cleanup = True
                    if not terminate and not killed and child.is_alive():
                        child.terminate()
                        terminate = True
            child.join(timeout=0)
    finally:
        receiver.abandon()
        if receive_result is not None:
            if not receive_result.done():
                receive_result.cancel()
            elif not receive_result.cancelled():
                try:
                    receive_result.result()
                except Exception:
                    pass
        with _LOCK:
            _ALIGNMENT_CHILDREN.discard(child)
        child.close()
    if cancelled_during_cleanup:
        raise asyncio.CancelledError


async def _run_alignment_child(
    worker: Callable[..., _T], args: tuple[object, ...]
) -> _T:
    context = multiprocessing.get_context("spawn")
    parent_pipe, sender = context.Pipe(duplex=False)
    receiver = _AlignmentReceiver(parent_pipe)
    child = context.Process(target=_alignment_worker, args=(sender, worker, args))
    receive_result = None
    received_result = False
    try:
        child.start()
        with _LOCK:
            _ALIGNMENT_CHILDREN.add(child)
        sender.close()
        receive_result = asyncio.get_running_loop().run_in_executor(
            None, receiver.receive
        )
        try:
            succeeded, result = await asyncio.shield(receive_result)
        except (EOFError, OSError) as error:
            raise BrokenProcessPool(
                "Remote alignment worker exited before returning a result"
            ) from error
        received_result = True
        if not succeeded:
            raise result
        return result
    finally:
        sender.close()
        await _finish_alignment_child(
            child, receiver, receive_result, not received_result
        )


def _executor(lane: _Lane) -> ProcessPoolExecutor:
    with _LOCK:
        executor = _EXECUTORS.get(lane)
        if executor is None:
            workers = (
                1
                if lane == "control"
                else (
                    get_pool_manager().get(PoolName.TILE_IO.value).config.size
                    if lane == "alignment"
                    else min(2, max(1, os.cpu_count() or 1))
                )
            )
            executor = ProcessPoolExecutor(
                max_workers=workers,
                mp_context=multiprocessing.get_context("spawn"),
                max_tasks_per_child=200,
                initializer=prefer_current_thread,
            )
            _EXECUTORS[lane] = executor
        return executor


def _shutdown() -> None:
    with _LOCK:
        executors = list(_EXECUTORS.values())
        _EXECUTORS.clear()
        children = list(_ALIGNMENT_CHILDREN)
    for child in children:
        _reap_alignment_child(child, terminate=True)
    for executor in executors:
        executor.shutdown(wait=False, cancel_futures=True)


atexit.register(_shutdown)


async def run_remote_htslib(
    worker: Callable[..., _T], *args: object, pool: _Lane = "variant"
) -> _T:
    if pool == "alignment":
        return await _run_alignment_child(worker, args)
    executor = _executor(pool)
    try:
        return await asyncio.get_running_loop().run_in_executor(executor, worker, *args)
    except BrokenProcessPool:
        with _LOCK:
            if _EXECUTORS.get(pool) is executor:
                _EXECUTORS.pop(pool)
        executor.shutdown(wait=False, cancel_futures=True)
        raise
