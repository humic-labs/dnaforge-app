import asyncio
import importlib
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch

from src.services import remote_htslib_process as remote


class ComputeSchedulingOwnersTest(unittest.TestCase):
    def test_every_spawn_pool_initializes_its_worker_without_changing_capacity(self):
        pools = remote._EXECUTORS.copy()
        remote._EXECUTORS.clear()
        try:
            for lane, capacity in (
                ("control", 1),
                ("variant", min(2, os.cpu_count() or 1)),
            ):
                initialized = []
                with (
                    self.subTest(lane=lane),
                    patch.object(remote, "ProcessPoolExecutor") as create,
                    patch.object(
                        remote,
                        "prefer_current_thread",
                        side_effect=lambda initialized=initialized: initialized.append(
                            True
                        ),
                    ),
                ):
                    remote._executor(lane)
                    options = create.call_args.kwargs
                    self.assertEqual(options["max_workers"], capacity)
                    self.assertEqual(options["max_tasks_per_child"], 200)
                    self.assertEqual(options["mp_context"].get_start_method(), "spawn")
                    options["initializer"]()
                    self.assertEqual(initialized, [True])
        finally:
            remote._EXECUTORS.clear()
            remote._EXECUTORS.update(pools)

    def test_alignment_process_prefers_its_thread_before_native_work(self):
        events = []
        sender = SimpleNamespace(
            send=lambda result: events.append(result),
            close=lambda: events.append("closed"),
        )
        with patch.object(
            remote, "prefer_current_thread", side_effect=lambda: events.append("prefer")
        ):
            remote._alignment_worker(sender, lambda: events.append("work") or 7, ())
        self.assertEqual(events, ["prefer", "work", (True, 7), "closed"])

    def test_status_probes_actual_loop_and_default_executor(self):
        route = importlib.import_module("src.routes.sidecar")

        async def run():
            with (
                patch.object(
                    route,
                    "get_pool_manager",
                    return_value=SimpleNamespace(stats=lambda: {}),
                ),
                patch.object(
                    route,
                    "get_job_manager",
                    return_value=SimpleNamespace(counts=lambda: {}),
                ),
            ):
                result = await route.sidecar_status()
            observation = result["scheduling"]
            self.assertEqual(observation["eventLoop"]["pid"], os.getpid())
            self.assertEqual(
                observation["eventLoop"]["nativeThreadId"],
                str(threading.get_native_id()),
            )
            self.assertNotEqual(
                observation["eventLoop"]["nativeThreadId"],
                observation["defaultExecutor"]["nativeThreadId"],
            )
            self.assertEqual(observation["defaultExecutor"]["pid"], os.getpid())
            self.assertNotIn("effectiveQos", str(result))

        asyncio.run(run())

    def test_coverage_pool_initializes_before_chromosome_work(self):
        from src.services import coverage_pyramid as coverage

        initialized = threading.local()
        capacities = []

        class CheckedPool(ThreadPoolExecutor):
            def __init__(self, **kwargs):
                capacities.append(kwargs["max_workers"])
                super().__init__(**kwargs)

            def submit(self, fn, *args, **kwargs):
                def run():
                    self_test.assertTrue(getattr(initialized, "preferred", False))
                    return fn(*args, **kwargs)

                return super().submit(run)

        self_test = self
        with (
            patch.object(
                coverage, "_resolve_bam_path", return_value="https://example.org/a.bam"
            ),
            patch.object(coverage, "_open_alignment") as opened,
            patch.object(coverage, "_coverage_precompute_workers", return_value=2),
            patch.object(coverage, "ThreadPoolExecutor", CheckedPool),
            patch.object(
                coverage,
                "prefer_current_thread",
                side_effect=lambda: setattr(initialized, "preferred", True),
            ),
        ):
            opened.return_value.__enter__.return_value.references = []
            result = coverage.coverage_pyramid_precompute("unused", ["chrA", "chrB"])
        self.assertEqual(capacities, [2])
        self.assertEqual([row["chrom"] for row in result], ["chrA", "chrB"])


if __name__ == "__main__":
    unittest.main()
