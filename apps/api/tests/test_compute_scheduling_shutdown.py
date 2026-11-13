import asyncio
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from src import compute_scheduling as scheduling


class ComputeSchedulingShutdownTest(unittest.TestCase):
    def test_lifespan_exit_drains_an_already_queued_default_executor_callback(self):
        entered = threading.Event()
        release = threading.Event()
        performed = []

        class ControlledExecutor(ThreadPoolExecutor):
            def __init__(self, **kwargs):
                super().__init__(max_workers=1, **kwargs)

            def shutdown(self, wait=True, **kwargs):
                super().shutdown(wait=False, **kwargs)
                release.set()
                super().shutdown(wait=wait)

        def hold():
            entered.set()
            release.wait()

        async def run():
            loop = asyncio.get_running_loop()
            async with scheduling.compute_scheduling_lifespan():
                active = loop.run_in_executor(None, hold)
                while not entered.is_set():
                    await asyncio.sleep(0)
                queued = loop.run_in_executor(
                    None, lambda: performed.append("ran") or 7
                )
                self.assertEqual(performed, [])
            await active
            self.assertEqual(await queued, 7)
            self.assertEqual(performed, ["ran"])

        with patch.object(scheduling.sys, "platform", "darwin"), patch.object(
            scheduling, "prefer_current_thread"
        ), patch.object(scheduling, "ThreadPoolExecutor", ControlledExecutor):
            asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
