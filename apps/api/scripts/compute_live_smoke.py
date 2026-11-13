#!/usr/bin/env python3
"""Live smoke for a compute provider binding  /  / .

Runs the eight operations against a REAL provider with a REAL key, outside the
app, and prints one line per step. Gated on env so CI never spends money:

    COMPUTE_LIVE_EXECUTE=1 TAMARIND_API_KEY=... PYTHONPATH=. \
      python scripts/compute_live_smoke.py tamarind --tool esmfold --sequence MKT...

    COMPUTE_LIVE_EXECUTE=1 NVIDIA_API_KEY=nvapi-... PYTHONPATH=. \
      python scripts/compute_live_smoke.py nvidia-nim --tool boltz2 \
      --settings-json '{"polymers": [{"id": "A", "molecule_type": "protein", "sequence": "MKT..."}]}'

    COMPUTE_LIVE_EXECUTE=1 BOLTZ_API_KEY=sk_bc_... PYTHONPATH=. \
      python scripts/compute_live_smoke.py boltz --tool boltz-2 --sequence MKT...

    COMPUTE_LIVE_EXECUTE=1 SUBSEQ_API_KEY=... PYTHONPATH=. \
      python scripts/compute_live_smoke.py subseq --tool esmfold \
      --settings-json '{"protein_sequence": "MKT..."}'

Never prints the key. Exits non-zero on any failure so it can back an evidence
manifest entry.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

from src.compute.contract import JobState, SubmitRequest
from src.compute.service import ComputeService

ENV_KEYS = {
    "tamarind": "TAMARIND_API_KEY",
    "boltz": "BOLTZ_API_KEY",
    "nvidia-nim": "NVIDIA_API_KEY",
    "subseq": "SUBSEQ_API_KEY",
}


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("provider", choices=sorted(ENV_KEYS))
    parser.add_argument("--tool", required=True)
    parser.add_argument(
        "--sequence",
        help="protein sequence; becomes settings.sequence unless --settings-json is given",
    )
    parser.add_argument(
        "--settings-json",
        help="full settings object as JSON (for tools with a richer input shape)",
    )
    parser.add_argument("--timeout-s", type=float, default=1800)
    args = parser.parse_args()

    if os.environ.get("COMPUTE_LIVE_EXECUTE") != "1":
        print(
            "refusing: set COMPUTE_LIVE_EXECUTE=1 to spend real provider budget",
            file=sys.stderr,
        )
        return 2
    secret = os.environ.get(ENV_KEYS[args.provider])
    if not secret:
        print(f"refusing: {ENV_KEYS[args.provider]} is not set", file=sys.stderr)
        return 2

    service = ComputeService.from_manifest_dir()
    cred = service.credential_for(args.provider, secret)
    p = args.provider

    tools = await service.list_tools(p, cred, search=args.tool)
    print(f"[1/8] list_tools: {len(tools)} match(es): {[t.id for t in tools][:8]}")
    if not any(t.id == args.tool for t in tools):
        print(f"FAIL: tool {args.tool!r} not in catalog", file=sys.stderr)
        return 1

    schema = await service.get_schema(p, cred, args.tool)
    print(f"[2/8] get_schema: keys={sorted(schema.keys())[:8]}")

    if args.settings_json:
        settings = json.loads(args.settings_json)
    elif args.sequence:
        settings = {"sequence": args.sequence}
    else:
        print("refusing: pass --sequence or --settings-json", file=sys.stderr)
        return 2
    validation = await service.validate(p, cred, args.tool, settings)
    print(
        f"[3/8] validate: ok={validation.ok} problems={list(validation.problems)[:3]}"
    )
    if not validation.ok:
        return 1

    estimate = await service.estimate(p, cred, args.tool, settings)
    print(
        f"[4/8] estimate: amount={estimate.amount} unit={estimate.unit} seconds={estimate.estimated_seconds} note={estimate.note!r}"
    )

    label = f"dnaforge-smoke-{int(time.time())}"
    ref = await service.submit(p, cred, SubmitRequest(args.tool, settings, label=label))
    print(f"[5/8] submit: remote_id={ref.remote_id}")

    deadline = time.time() + args.timeout_s
    status = None
    while time.time() < deadline:
        status = await service.status(p, cred, ref)
        print(f"[6/8] status: {status.state.value} ({status.provider_state})")
        if status.is_terminal():
            break
        await asyncio.sleep(15)
    if status is None or status.state is not JobState.COMPLETED:
        print(
            f"FAIL: job did not complete: {status.state.value if status else 'no status'}",
            file=sys.stderr,
        )
        return 1

    bundle = await service.fetch_result(p, cred, ref)
    print(
        f"[7/8] fetch_result: kind={bundle.output_kind.value} files={[f.name for f in bundle.files]} metrics={dict(bundle.metrics)}"
    )
    structure = next(
        (f for f in bundle.files if f.name.lower().endswith((".pdb", ".cif"))), None
    )
    if structure and structure.content:
        head = structure.content[:60].decode("utf-8", "replace").replace("\n", " ")
        print(f"[8/8] first structure bytes: {head!r}")
    else:
        print("[8/8] no inline structure file (URL-only or non-structure output)")
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
