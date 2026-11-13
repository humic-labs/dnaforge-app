#!/usr/bin/env python3
"""Minimal DNAForge CLI plugin: stdin JSON in, stdout JSON out."""

import json
import os
import sys


def main() -> int:
    payload = json.load(sys.stdin)
    result = {
        "result": {
            "echo": payload.get("input", {}),
            "jobId": payload.get("jobId") or os.environ.get("DNAFORGE_JOB_ID"),
        }
    }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
