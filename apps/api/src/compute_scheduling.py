from __future__ import annotations

import asyncio
import ctypes
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import AsyncIterator, Literal, TypedDict

from anyio import to_thread

_USER_INITIATED = 0x19
_QOS_NAMES = {
    0x00: "unspecified",
    0x09: "background",
    0x11: "utility",
    0x15: "default",
    _USER_INITIATED: "userInitiated",
    0x21: "userInteractive",
}


class _SchedulingError(TypedDict, total=False):
    preferenceError: str


class SchedulingObservation(_SchedulingError):
    status: Literal["observed", "unsupported", "unavailable"]
    platform: str
    pid: int
    nativeThreadId: str | None
    requestedQos: int | None
    requestedClass: str | None
    relativePriority: int | None


class _DarwinQosControls:
    def __init__(self) -> None:
        self.library = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        self.library.pthread_self.argtypes = []
        self.library.pthread_self.restype = ctypes.c_void_p
        self.library.pthread_get_qos_class_np.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_uint),
            ctypes.POINTER(ctypes.c_int),
        ]
        self.library.pthread_get_qos_class_np.restype = ctypes.c_int
        self.library.pthread_set_qos_class_self_np.argtypes = [
            ctypes.c_uint,
            ctypes.c_int,
        ]
        self.library.pthread_set_qos_class_self_np.restype = ctypes.c_int

    def read(self) -> tuple[int, int]:
        qos = ctypes.c_uint()
        relative = ctypes.c_int()
        result = self.library.pthread_get_qos_class_np(
            self.library.pthread_self(), ctypes.byref(qos), ctypes.byref(relative)
        )
        if result:
            raise OSError(result, os.strerror(result))
        return qos.value, relative.value

    def set(self, qos: int, relative: int) -> None:
        result = self.library.pthread_set_qos_class_self_np(qos, relative)
        if result:
            raise OSError(result, os.strerror(result))


@lru_cache(maxsize=1)
def _qos_controls() -> _DarwinQosControls:
    return _DarwinQosControls()


def read_current_thread_scheduling() -> SchedulingObservation:
    observation: SchedulingObservation = {
        "status": "unsupported",
        "platform": sys.platform,
        "pid": os.getpid(),
        "nativeThreadId": str(threading.get_native_id()),
        "requestedQos": None,
        "requestedClass": None,
        "relativePriority": None,
    }
    if sys.platform != "darwin":
        return observation
    try:
        qos, relative = _qos_controls().read()
    except (OSError, AttributeError):
        observation["status"] = "unavailable"
        return observation
    observation.update(
        status="observed",
        requestedQos=qos,
        requestedClass=_QOS_NAMES.get(qos),
        relativePriority=relative,
    )
    return observation


def prefer_current_thread() -> SchedulingObservation:
    observation = read_current_thread_scheduling()
    qos = observation["requestedQos"]
    if qos is None or qos >= _USER_INITIATED:
        return observation
    try:
        _qos_controls().set(_USER_INITIATED, 0)
    except (OSError, AttributeError) as error:
        return {**read_current_thread_scheduling(), "preferenceError": str(error)}
    return read_current_thread_scheduling()


@asynccontextmanager
async def compute_scheduling_lifespan() -> AsyncIterator[None]:
    prefer_current_thread()
    executor = None
    if sys.platform == "darwin":
        executor = ThreadPoolExecutor(
            thread_name_prefix="dnaforge-compute", initializer=prefer_current_thread
        )
        asyncio.get_running_loop().set_default_executor(executor)
    try:
        yield
    finally:
        if executor is not None:
            await to_thread.run_sync(executor.shutdown)


async def scheduling_status() -> dict[str, SchedulingObservation]:
    event_loop = read_current_thread_scheduling()
    default_executor = await asyncio.to_thread(read_current_thread_scheduling)
    return {"eventLoop": event_loop, "defaultExecutor": default_executor}
