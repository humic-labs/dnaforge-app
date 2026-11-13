import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_ROOT))

from src.compute_scheduling import (  # noqa: E402
    compute_scheduling_lifespan,
    prefer_current_thread,
    read_current_thread_scheduling,
    scheduling_status,
)
from src.services import remote_htslib_process as remote  # noqa: E402

SOURCE_PATHS = (
    "src/compute_scheduling.py",
    "src/main.py",
    "src/routes/sidecar.py",
    "src/services/remote_htslib_process.py",
    "src/services/coverage_pyramid.py",
    "src/tools/adjacency/alignment.py",
    "scripts/prove_compute_scheduling.py",
)


async def probe():
    before = read_current_thread_scheduling()
    try:
        async with compute_scheduling_lifespan():
            observations = await scheduling_status()
            with ThreadPoolExecutor(
                max_workers=1, initializer=prefer_current_thread
            ) as executor:
                observations[
                    "explicitThread"
                ] = await asyncio.get_running_loop().run_in_executor(
                    executor, read_current_thread_scheduling
                )
            for lane in ("variant", "control", "alignment"):
                observations[lane] = await remote.run_remote_htslib(
                    read_current_thread_scheduling, pool=lane
                )
    finally:
        for executor in remote._EXECUTORS.values():
            executor.shutdown(wait=True, cancel_futures=True)
        remote._EXECUTORS.clear()
    for name, observation in observations.items():
        if observation["status"] != "observed" or observation["requestedQos"] < 0x19:
            raise AssertionError(
                f"{name} did not observe requested userInitiated QoS: {observation}"
            )
    serving = observations["eventLoop"]
    if serving["pid"] != os.getpid():
        raise AssertionError("Serving observation belongs to a different process")
    if observations["defaultExecutor"]["nativeThreadId"] == serving["nativeThreadId"]:
        raise AssertionError(
            "Default executor observation did not run in a worker thread"
        )
    for lane in ("variant", "control", "alignment"):
        if observations[lane]["pid"] == serving["pid"]:
            raise AssertionError(f"{lane} did not run in a spawned process")
    return {"before": before, "observations": observations}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This proof requires an actual macOS host")
    sources = {
        name: hashlib.sha256((API_ROOT / name).read_bytes()).hexdigest()
        for name in SOURCE_PATHS
    }
    result = {"asyncio": asyncio.run(probe())}
    if importlib.util.find_spec("uvloop") is not None:
        import uvloop

        with asyncio.Runner(loop_factory=uvloop.new_event_loop) as runner:
            result["uvloop"] = runner.run(probe())
    else:
        result["uvloop"] = {
            "status": "unqualified",
            "reason": "uvloop is not installed",
        }
    payload = {
        "schema": "dnaforge.compute-scheduling-proof.v1",
        "sourceCommit": subprocess.check_output(
            ["git", "-C", str(API_ROOT), "rev-parse", "HEAD"], text=True
        ).strip(),
        "sourceHashes": sources,
        "platform": sys.platform,
        "python": sys.version,
        "loops": result,
        "unqualified": [
            "effectiveQos",
            "nativeLibraryCreatedThreads",
            "externalHelperThreads",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n")
    print(json.dumps({"ok": True, "output": str(args.output), "loops": list(result)}))


if __name__ == "__main__":
    main()
