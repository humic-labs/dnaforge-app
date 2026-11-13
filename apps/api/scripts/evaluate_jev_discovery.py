"""Compare the real Jev service to frozen outputs from the current TS search functions.

No lexical fallback is allowed in this experiment. Run from apps/api with the
TYPESAFE_API_KEY in the environment; never pass a secret as a CLI argument.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import statistics
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from src.control_plane.store import ControlPlaneStore
from src.external.providers.jev import (
    DISCOVERY_CAPABILITY,
    JEV_MODEL,
    DiscoveryCandidate,
    JevProvider,
)
from src.external.service import ExternalResourcesService


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        raise SystemExit("TYPESAFE_API_KEY must be configured")
    fixtures = (
        Path(__file__).resolve().parents[2] / "desktop/scripts/fixtures/jev-discovery"
    )
    candidates = json.loads((fixtures / "candidates.json").read_text())
    queries = json.loads((fixtures / "queries.json").read_text())
    baseline = json.loads(args.baseline.read_text())
    rows = []
    usage = []

    async def capture_usage(response: httpx.Response) -> None:
        await response.aread()
        if response.is_success:
            usage.append(response.json().get("usage", {}))

    with tempfile.TemporaryDirectory(prefix="jev-discovery-") as temp:
        store = ControlPlaneStore(Path(temp) / "audit.sqlite")
        store.initialize()
        async with httpx.AsyncClient(
            event_hooks={"response": [capture_usage]}
        ) as client:
            service = ExternalResourcesService(store, client=client)
            service.register(JevProvider(api_key=key, client=client))
            failures = 0
            for surface in ("tools", "skills"):
                descriptors = [
                    DiscoveryCandidate(
                        **{k: c[k] for k in ("id", "name", "description")}
                    )
                    for c in candidates[surface]
                ]
                for query in queries[surface]:
                    started = time.perf_counter()
                    row = {"surface": surface, **query}
                    try:
                        ids = await service.rank_discovery(
                            query["query"],
                            descriptors,
                            granted_capabilities=[DISCOVERY_CAPABILITY],
                        )
                        row.update(
                            ids=ids[: 4 if surface == "tools" else 8], status="ok"
                        )
                        failures = 0
                    except Exception as exc:
                        row.update(
                            ids=[],
                            status="error",
                            error=type(exc).__name__,
                            httpStatus=getattr(exc, "status_code", None),
                        )
                        failures += 1
                    row["latencyMs"] = (time.perf_counter() - started) * 1000
                    rows.append(row)
                    audit = store.list_external_fetch_log(provider="jev", limit=100)
                    if len(audit) != len(rows):
                        raise RuntimeError(
                            "Every paid request must have an audit record"
                        )
                    report = {
                        "createdAt": datetime.now(timezone.utc).isoformat(),
                        "model": JEV_MODEL,
                        "fixtureHashes": {
                            name: hashlib.sha256(
                                (fixtures / name).read_bytes()
                            ).hexdigest()
                            for name in ("candidates.json", "queries.json")
                        },
                        "usage": usage,
                        "audit": audit,
                        "baseline": baseline,
                        "jev": rows,
                        "summary": summarize(baseline["rows"], rows),
                    }
                    args.out.parent.mkdir(parents=True, exist_ok=True)
                    args.out.write_text(json.dumps(report, indent=2) + "\n")
                    print(
                        f"{query['id']} {row['status']} {row['latencyMs']:.0f}ms",
                        flush=True,
                    )
                    if failures >= 10:
                        raise SystemExit(
                            "Stopped after 10 consecutive provider failures; evidence retained"
                        )
            await service.aclose()
        store.close()
    print(json.dumps(report["summary"], indent=2))


def summarize(baseline: list[dict], jev: list[dict]) -> dict:
    def success(row: dict) -> bool:
        return row.get("status", "ok") == "ok"

    def hit(row: dict) -> bool:
        return success(row) and bool(set(row["ids"]) & set(row["expected"]))

    result = {}
    for surface in ("tools", "skills"):
        result[surface] = {}
        for method, data in (("lexical", baseline), ("jev", jev)):
            rows = [r for r in data if r["surface"] == surface]
            positives = [r for r in rows if r["expected"]]
            negatives = [r for r in rows if not r["expected"]]
            result[surface][method] = {
                "completed": len(rows),
                "positiveHitAtK": sum(map(hit, positives)),
                "positiveTotal": len(positives),
                "positiveTop1": sum(
                    success(r) and bool(r["ids"]) and r["ids"][0] in r["expected"]
                    for r in positives
                ),
                "meanReciprocalRank": (
                    round(
                        sum(
                            (
                                next(
                                    (
                                        1 / (i + 1)
                                        for i, value in enumerate(r["ids"])
                                        if value in r["expected"]
                                    ),
                                    0,
                                )
                                if success(r)
                                else 0
                            )
                            for r in positives
                        )
                        / len(positives),
                        4,
                    )
                    if positives
                    else None
                ),
                "negativeCorrect": sum(success(r) and not r["ids"] for r in negatives),
                "negativeTotal": len(negatives),
                "errors": sum(not success(r) for r in rows),
                "medianLatencyMs": (
                    round(statistics.median([r["latencyMs"] for r in rows]), 2)
                    if rows
                    else None
                ),
                "byKind": {
                    kind: {
                        "correct": sum(
                            (hit(r) if r["expected"] else success(r) and not r["ids"])
                            for r in rows
                            if r["kind"] == kind
                        ),
                        "total": sum(r["kind"] == kind for r in rows),
                    }
                    for kind in ("exact", "plain", "paraphrase", "no-match")
                },
            }
    return result


if __name__ == "__main__":
    asyncio.run(main())
