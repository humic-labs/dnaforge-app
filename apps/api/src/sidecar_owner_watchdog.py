"""Stop a packaged POSIX sidecar when its owning Electron process disappears.

Electron normally shuts the sidecar down. A crash or forced exit skips that
cleanup and previously left the old sidecar holding the profile's exclusive
control-plane lock, preventing the next app launch from starting compute.
"""

from __future__ import annotations

import os
import signal
import sys
import threading

_POLL_SECONDS = 0.5
_GRACE_SECONDS = 5.0


def _watch_owner(owner_pid: int) -> None:
    while True:
        if os.getppid() != owner_pid:
            os.kill(os.getpid(), signal.SIGTERM)
            try:
                print(
                    f"[Sidecar] Electron owner {owner_pid} exited; stopping orphaned sidecar",
                    file=sys.stderr,
                    flush=True,
                )
            except OSError:
                pass
            threading.Event().wait(_GRACE_SECONDS)
            os._exit(1)
        threading.Event().wait(_POLL_SECONDS)


def start_owner_watchdog() -> None:
    """Monitor only sidecars explicitly launched by the packaged POSIX app."""
    if os.name == "nt":
        return
    raw_pid = os.environ.get("DNAFORGE_SIDECAR_OWNER_PID")
    if not raw_pid:
        return
    if not raw_pid.isdecimal() or int(raw_pid) <= 1:
        raise RuntimeError("Invalid DNAFORGE_SIDECAR_OWNER_PID")
    owner_pid = int(raw_pid)
    if os.getppid() != owner_pid:
        raise RuntimeError("Electron sidecar owner is no longer the parent process")
    threading.Thread(
        target=_watch_owner,
        args=(owner_pid,),
        name="dnaforge-sidecar-owner-watchdog",
        daemon=True,
    ).start()
