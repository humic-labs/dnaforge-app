import os
import subprocess
import sys
import unittest
from pathlib import Path

_PROBE = """
import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from src import compute_scheduling as scheduling

shutdown_started = threading.Event()
work_started = threading.Event()

class ObservedExecutor(ThreadPoolExecutor):
    def shutdown(self, *args, **kwargs):
        shutdown_started.set()
        return super().shutdown(*args, **kwargs)

async def loop_callback():
    return 7

async def run():
    loop = asyncio.get_running_loop()
    def work():
        work_started.set()
        shutdown_started.wait()
        return asyncio.run_coroutine_threadsafe(loop_callback(), loop).result()
    async with scheduling.compute_scheduling_lifespan():
        active = loop.run_in_executor(None, work)
        while not work_started.is_set():
            await asyncio.sleep(0)
    assert await active == 7
    print(json.dumps({"loopResponsive": True, "workerResult": await active}))

with patch.object(scheduling.sys, "platform", "darwin"), patch.object(
    scheduling, "prefer_current_thread"
), patch.object(scheduling, "ThreadPoolExecutor", ObservedExecutor):
    asyncio.run(run())
"""


class ComputeSchedulingLoopShutdownTest(unittest.TestCase):
    def test_owned_executor_drain_keeps_the_serving_loop_available_to_workers(self):
        result = subprocess.run(
            [sys.executable, "-c", _PROBE],
            env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
            capture_output=True,
            text=True,
            timeout=3,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('"loopResponsive": true', result.stdout)
        self.assertIn('"workerResult": 7', result.stdout)


if __name__ == "__main__":
    unittest.main()
