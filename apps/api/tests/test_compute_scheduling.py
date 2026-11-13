import asyncio
import os
import threading
import unittest
from unittest.mock import patch

from src import compute_scheduling as scheduling


class QosControls:
    def __init__(self, qos=0x15, relative=-2):
        self.qos = qos
        self.relative = relative
        self.changes = []

    def read(self):
        return self.qos, self.relative

    def set(self, qos, relative):
        self.changes.append((qos, relative, threading.get_native_id()))
        self.qos, self.relative = qos, relative


class ComputeSchedulingTest(unittest.TestCase):
    def test_reads_actual_current_thread_identity_without_loading_darwin_on_other_platforms(
        self,
    ):
        for platform in ("linux", "win32"):
            with (
                self.subTest(platform=platform),
                patch.object(scheduling.sys, "platform", platform),
                patch.object(scheduling, "_qos_controls") as load,
            ):
                observation = scheduling.read_current_thread_scheduling()
                self.assertEqual(observation["status"], "unsupported")
                self.assertEqual(observation["pid"], os.getpid())
                self.assertEqual(
                    observation["nativeThreadId"], str(threading.get_native_id())
                )
                self.assertIsNone(observation["requestedQos"])
                self.assertIsNone(observation["requestedClass"])
                scheduling.prefer_current_thread()
                load.assert_not_called()

    def test_requests_user_initiated_before_reading_back_the_current_thread(self):
        controls = QosControls()
        with (
            patch.object(scheduling.sys, "platform", "darwin"),
            patch.object(scheduling, "_qos_controls", return_value=controls),
        ):
            result = scheduling.prefer_current_thread()
        self.assertEqual(controls.changes, [(0x19, 0, threading.get_native_id())])
        self.assertEqual(result["status"], "observed")
        self.assertEqual(result["requestedQos"], 0x19)
        self.assertEqual(result["requestedClass"], "userInitiated")

    def test_preserves_existing_user_initiated_and_higher_qos_and_relative_priority(
        self,
    ):
        for qos, name in ((0x19, "userInitiated"), (0x21, "userInteractive")):
            controls = QosControls(qos, -3)
            with (
                self.subTest(qos=qos),
                patch.object(scheduling.sys, "platform", "darwin"),
                patch.object(scheduling, "_qos_controls", return_value=controls),
            ):
                result = scheduling.prefer_current_thread()
            self.assertEqual(controls.changes, [])
            self.assertEqual(result["requestedClass"], name)
            self.assertEqual(result["relativePriority"], -3)

    def test_unavailable_read_does_not_blindly_change_priority(self):
        controls = QosControls()
        with (
            patch.object(scheduling.sys, "platform", "darwin"),
            patch.object(scheduling, "_qos_controls", return_value=controls),
            patch.object(controls, "read", side_effect=OSError("unavailable")),
        ):
            result = scheduling.prefer_current_thread()
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["requestedQos"])
        self.assertEqual(controls.changes, [])

    def test_failed_request_reports_actual_readback_without_claiming_preference(self):
        controls = QosControls()
        with (
            patch.object(scheduling.sys, "platform", "darwin"),
            patch.object(scheduling, "_qos_controls", return_value=controls),
            patch.object(controls, "set", side_effect=OSError("permission denied")),
        ):
            result = scheduling.prefer_current_thread()
        self.assertEqual(result["status"], "observed")
        self.assertEqual(result["requestedClass"], "default")
        self.assertIn("permission denied", result["preferenceError"])

    def test_startup_sets_loop_and_default_executor_before_work_and_owns_teardown(self):
        local = threading.local()
        changes = []
        executor_threads = []

        class ThreadControls:
            def read(self):
                return getattr(local, "qos", 0x15), 0

            def set(self, qos, relative):
                local.qos = qos
                changes.append(threading.get_native_id())

        async def run():
            async with scheduling.compute_scheduling_lifespan():
                first = await scheduling.scheduling_status()
                second = await scheduling.scheduling_status()
                self.assertEqual(
                    first["eventLoop"]["nativeThreadId"], str(threading.get_native_id())
                )
                self.assertNotEqual(
                    first["defaultExecutor"]["nativeThreadId"],
                    first["eventLoop"]["nativeThreadId"],
                )
                self.assertEqual(first["eventLoop"]["requestedClass"], "userInitiated")
                self.assertEqual(
                    first["defaultExecutor"]["requestedClass"], "userInitiated"
                )
                self.assertEqual(first, second)
                self.assertEqual(len(changes), 2)
                executor_threads.extend(
                    thread
                    for thread in threading.enumerate()
                    if str(thread.native_id)
                    == first["defaultExecutor"]["nativeThreadId"]
                )
                self.assertEqual(len(executor_threads), 1)

        with (
            patch.object(scheduling.sys, "platform", "darwin"),
            patch.object(scheduling, "_qos_controls", return_value=ThreadControls()),
        ):
            asyncio.run(run())
        self.assertFalse(executor_threads[0].is_alive())

    def test_non_darwin_startup_preserves_loop_executor_ownership(self):
        async def run():
            loop = asyncio.get_running_loop()
            with patch.object(loop, "set_default_executor") as install:
                async with scheduling.compute_scheduling_lifespan():
                    observation = await scheduling.scheduling_status()
                    self.assertNotEqual(
                        observation["eventLoop"]["nativeThreadId"],
                        observation["defaultExecutor"]["nativeThreadId"],
                    )
                install.assert_not_called()

        with patch.object(scheduling.sys, "platform", "linux"):
            asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
