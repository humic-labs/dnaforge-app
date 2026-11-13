"""Sidecar storage capacity: Apple's reclaimable capacity, never raw-free fallback."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

Purpose = Literal["important", "opportunistic"]


class StorageCapacityUnknown(OSError):
    """The OS did not provide a valid available-capacity reading."""


@dataclass(frozen=True)
class StorageCapacity:
    destination_path: str
    available_bytes: int
    free_bytes: int
    total_bytes: int
    source: str
    purpose: Purpose


def _bytes(value: object, field: str) -> int:
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        raise ValueError(f"Missing capacity field: {field}")
    if not re.fullmatch(r"[0-9]+", str(value)):
        raise ValueError(f"Invalid capacity field: {field}")
    result = int(value)
    if result > 2**53 - 1:
        raise ValueError(f"Capacity field exceeds the safe integer range: {field}")
    return result


def read_storage_capacity(
    destination: str | Path, *, purpose: Purpose = "important"
) -> StorageCapacity:
    """Read the actual destination volume. Failure is unknown, never zero.

    This is the Python-runtime equivalent of @waypoint/platform/node-storage;
    it needs neither Node nor third-party bridge packages in the bundled sidecar.
    """
    if purpose not in ("important", "opportunistic"):
        raise ValueError("Storage capacity purpose must be important or opportunistic.")
    try:
        canonical = str(Path(destination).resolve(strict=True))
        if sys.platform != "darwin":
            usage = shutil.disk_usage(canonical)
            return StorageCapacity(
                canonical,
                usage.free,
                usage.free,
                usage.total,
                "filesystem-available",
                purpose,
            )
        script = f"""ObjC.import("Foundation");
const url = $.NSURL.fileURLWithPath({json.dumps(canonical)});
const keys = [$.NSURLVolumeTotalCapacityKey, $.NSURLVolumeAvailableCapacityKey,
  $.NSURLVolumeAvailableCapacityFor{"Important" if purpose == "important" else "Opportunistic"}UsageKey];
const error = Ref();
const values = url.resourceValuesForKeysError($(keys), error);
if (!values) throw new Error("Foundation capacity query failed");
const result = {{}};
["totalBytes", "freeBytes", "{purpose}Bytes"].forEach((name, i) => {{
  const value = values.objectForKey(keys[i]);
  if (!value) throw new Error("Foundation capacity field unavailable: " + name);
  result[name] = ObjC.unwrap(value.stringValue);
}});
JSON.stringify(result);"""
        query = subprocess.run(
            ["/usr/bin/osascript", "-l", "JavaScript", "-e", script],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
            stdin=subprocess.DEVNULL,
        )
        record = json.loads(query.stdout)
        values = {
            field: _bytes(record.get(field), field)
            for field in ("totalBytes", "freeBytes", f"{purpose}Bytes")
        }
        if any(value > values["totalBytes"] for value in values.values()):
            raise ValueError("Capacity field exceeds volume size")
        return StorageCapacity(
            canonical,
            values[f"{purpose}Bytes"],
            values["freeBytes"],
            values["totalBytes"],
            f"macos-{purpose}-usage",
            purpose,
        )
    except (
        OSError,
        ValueError,
        TypeError,
        AttributeError,
        subprocess.SubprocessError,
    ) as exc:
        raise StorageCapacityUnknown(
            f"Available storage capacity is unknown for {destination}."
        ) from exc
