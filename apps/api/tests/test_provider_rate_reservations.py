from __future__ import annotations

import asyncio
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest

from src.compute.contract import (
    ComputeRateLimitError,
    CredentialScheme,
    ProviderCredential,
    SubmitRequest,
)
from src.compute.manifests import load_manifests
from src.compute.service import ComputeService
from src.control_plane.store import ControlPlaneStore
from src.external import (
    resilience,
    service_rcsb,
    service_structure,
)
from src.external import (
    service as external_service,
)
from src.external.contract import (
    Capability,
    FetchOptions,
    FetchResult,
    ParsedId,
    ProviderHttpError,
    ProviderRateLimitError,
)
from src.external.resilience import _TokenBucket
from src.external.service import ExternalResourcesService
from src.external.structure_identity import _canonical_structure_identity


class Clock:
    def __init__(self):
        self.now = 0.0
        self.waiters = []

    def monotonic(self):
        return self.now

    async def sleep(self, delay):
        future = asyncio.get_running_loop().create_future()
        self.waiters.append((self.now + delay, future))
        await future

    async def settle(self):
        for _ in range(4):
            await asyncio.sleep(0)

    async def finish(self, tasks):
        for _ in range(100):
            await self.settle()
            if all(task.done() for task in tasks):
                return await asyncio.gather(*tasks)
            pending = [(at, future) for at, future in self.waiters if not future.done()]
            assert (
                pending
            ), "An operation is awaiting something other than its reservation"
            self.now = min(at for at, _ in pending)
            for at, future in pending:
                if at <= self.now:
                    future.set_result(None)
        pytest.fail("Reservation schedule did not terminate")


@pytest.fixture
def clock(monkeypatch):
    value = Clock()
    monkeypatch.setattr(resilience, "time", value)
    return value


@pytest.mark.parametrize(
    "capacity,rate,count,expected",
    [
        (2, 2, 5, [0, 0, 0.5, 1, 1.5]),
        (1, 1, 4, [0, 1, 2, 3]),
        (10, 10, 30, [0] * 10 + [index / 10 for index in range(1, 21)]),
    ],
)
def test_simultaneous_calls_reserve_distinct_future_tokens(
    clock, capacity, rate, count, expected
):
    bucket = _TokenBucket(capacity, rate)
    assert [bucket.take() for _ in range(count)] == pytest.approx(expected)


def test_arrival_at_reserved_wake_does_not_reuse_that_token(clock):
    bucket = _TokenBucket(1, 2)
    assert bucket.take() == 0
    assert bucket.take() == 0.5
    clock.now = 0.5
    assert bucket.take() == 0.5
    clock.now = 1
    assert bucket.take() == 0.5


def test_refill_is_capped_after_idle_and_pays_outstanding_reservations_first(clock):
    bucket = _TokenBucket(2, 2)
    assert [bucket.take() for _ in range(4)] == [0, 0, 0.5, 1]
    clock.now = 0.25
    assert bucket.take() == 1.25
    clock.now = 100
    assert [bucket.take() for _ in range(3)] == [0, 0, 0.5]


@pytest.mark.parametrize("capacity,rate", [(1, 0.5), (2, 2), (10, 10), (1.5, 3)])
def test_admission_schedule_obeys_burst_plus_refill_bound(clock, capacity, rate):
    bucket = _TokenBucket(capacity, rate)
    admissions = []
    for arrival in [0] * 8 + [0.1, 0.3, 0.3, 1, 1, 1.2, 3, 5, 20, 20, 20]:
        clock.now = arrival
        admissions.append(arrival + bucket.take())
    assert admissions == sorted(admissions)
    for start in range(len(admissions)):
        for end in range(start, len(admissions)):
            assert (
                end - start + 1
                <= capacity + rate * (admissions[end] - admissions[start]) + 1e-9
            )


@pytest.mark.parametrize(
    "capacity,rate",
    [
        (0, 1),
        (0.5, 1),
        (-1, 1),
        (float("nan"), 1),
        (float("inf"), 1),
        (1, 0),
        (1, -1),
        (1, float("nan")),
        (1, float("inf")),
    ],
)
def test_invalid_bucket_configuration_fails_before_reserving(clock, capacity, rate):
    with pytest.raises(ValueError):
        _TokenBucket(capacity, rate)


class ExternalProvider:
    provider_id = "reservation-test"

    def __init__(self, invoke):
        self.invoke = invoke

    async def fetch(self, parsed, opts):
        await self.invoke(int(parsed.canonical_id))
        return FetchResult(parsed, {"identity": parsed.canonical_id})


class ComputeBinding:
    def __init__(self, invoke):
        self.invoke = invoke

    async def list_tools(self, credential, *, search, tags):
        await self.invoke(int(search))
        return []

    async def submit(self, credential, request):
        await self.invoke(int(request.tool_id))
        return request.idempotency_key


@pytest.fixture
async def wrapper_factory(clock, monkeypatch, tmp_path):
    clients = []
    services = []

    def factory(kind, invoke, *, max_retries=0):
        if kind.startswith("compute"):
            manifest = replace(load_manifests()["boltz"], rate_limit_rps=2)
            service = ComputeService(
                {"boltz": manifest},
                binding_factory=lambda _: ComputeBinding(invoke),
                sleep=clock.sleep,
            )
            credential = ProviderCredential(
                "boltz", CredentialScheme.BEARER, "synthetic-rate-test"
            )
            if kind == "compute-read":
                return lambda index: service.list_tools(
                    "boltz", credential, search=str(index)
                )
            return lambda index: service.submit(
                "boltz",
                credential,
                SubmitRequest(str(index), {}, idempotency_key=f"operation-{index}"),
            )
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: pytest.fail("Unexpected HTTP request")
            )
        )
        clients.append(client)
        store = ControlPlaneStore(tmp_path / f"{len(clients)}.sqlite3")
        store.initialize()
        service = ExternalResourcesService(
            store, client=client, rate_limit_per_s=2, rate_limit_burst=2
        )
        services.append(service)
        monkeypatch.setattr(
            external_service,
            "asyncio",
            SimpleNamespace(
                sleep=clock.sleep, Lock=asyncio.Lock, gather=asyncio.gather
            ),
        )
        provider = ExternalProvider(invoke)
        opts = FetchOptions(max_retries=max_retries)
        if kind == "thin":
            return lambda index: service._run_through_resilience(
                provider, opts, lambda: invoke(index)
            )
        return lambda index: service._fetch_with_resilience(
            provider, ParsedId(str(index), provider.provider_id), opts, []
        )

    yield factory
    for service in services:
        await service.aclose()
    for client in clients:
        await client.aclose()


WRAPPERS = ["thin", "fetch", "compute-read", "compute-submit"]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", WRAPPERS)
async def test_actual_wrapper_invocation_times_obey_reservations(
    clock, wrapper_factory, kind
):
    calls = []

    async def invoke(index):
        calls.append((index, clock.now))
        return index

    call = wrapper_factory(kind, invoke)
    tasks = [asyncio.create_task(call(index)) for index in range(6)]
    await clock.finish(tasks)
    assert calls == [(0, 0), (1, 0), (2, 0.5), (3, 1), (4, 1.5), (5, 2)]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", WRAPPERS)
async def test_cancelled_waiter_never_invokes_or_reallocates_its_reserved_slot(
    clock, wrapper_factory, kind
):
    calls = []

    async def invoke(index):
        calls.append((index, clock.now))
        return index

    call = wrapper_factory(kind, invoke)
    tasks = [asyncio.create_task(call(index)) for index in range(6)]
    await clock.settle()
    assert calls == [(0, 0), (1, 0)]
    tasks[2].cancel()
    with pytest.raises(asyncio.CancelledError):
        await tasks[2]
    replacement = asyncio.create_task(call(6))
    await clock.finish(
        [task for index, task in enumerate(tasks) if index != 2] + [replacement]
    )
    assert calls == [(0, 0), (1, 0), (3, 1), (4, 1.5), (5, 2), (6, 2.5)]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", WRAPPERS)
async def test_distinct_provider_instances_retain_separate_budgets(
    clock, wrapper_factory, kind
):
    calls = []

    async def invoke(index):
        calls.append((index, clock.now))
        return index

    first = wrapper_factory(kind, invoke)
    second = wrapper_factory(kind, invoke)
    await clock.finish(
        [
            asyncio.create_task(first(0)),
            asyncio.create_task(first(1)),
            asyncio.create_task(second(2)),
            asyncio.create_task(second(3)),
        ]
    )
    assert calls == [(0, 0), (1, 0), (2, 0), (3, 0)]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["thin", "fetch"])
async def test_rate_limited_retry_acquires_new_capacity(clock, wrapper_factory, kind):
    calls = []
    attempts = {}

    async def invoke(index):
        attempts[index] = attempts.get(index, 0) + 1
        calls.append((index, clock.now))
        if index == 0 and attempts[index] == 1:
            raise ProviderRateLimitError("synthetic", retry_after_s=0.25)
        return index

    call = wrapper_factory(kind, invoke, max_retries=1)
    await clock.finish([asyncio.create_task(call(index)) for index in range(4)])
    assert calls == [(0, 0), (1, 0), (2, 0.5), (3, 1), (0, 1.5)]


@pytest.mark.asyncio
async def test_distinct_origins_share_service_without_sharing_budget(
    clock, monkeypatch, tmp_path
):
    calls = []

    async def invoke(index):
        calls.append((index, clock.now))

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: pytest.fail("Unexpected HTTP request")
        )
    )
    store = ControlPlaneStore(tmp_path / "origins.sqlite3")
    service = ExternalResourcesService(
        store, client=client, rate_limit_per_s=2, rate_limit_burst=2
    )
    monkeypatch.setattr(external_service, "asyncio", SimpleNamespace(sleep=clock.sleep))
    first, second = ExternalProvider(invoke), ExternalProvider(invoke)
    second.provider_id = "other-origin"
    try:
        tasks = [
            asyncio.create_task(
                service._run_through_resilience(
                    provider,
                    FetchOptions(max_retries=0),
                    lambda index=index: invoke(index),
                )
            )
            for index, provider in enumerate([first] * 4 + [second] * 4)
        ]
        await clock.finish(tasks)
        assert calls == [
            (0, 0),
            (1, 0),
            (4, 0),
            (5, 0),
            (2, 0.5),
            (6, 0.5),
            (3, 1),
            (7, 1),
        ]
    finally:
        await service.aclose()
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "owner",
    [
        "afdb-validation",
        "afdb-resolution",
        "afdb-poster",
        "afdb-poster-latest",
        "rcsb-poster",
        "rcsb-scope",
        "structure-bytes",
    ],
)
@pytest.mark.parametrize("cancel_waiter", [False, True])
async def test_every_additional_owner_reserves_before_actual_http(
    clock, monkeypatch, tmp_path, owner, cancel_waiter
):
    calls = []

    def respond(request):
        calls.append(clock.now)
        return httpx.Response(404, json={"error": "synthetic missing record"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        store = ControlPlaneStore(tmp_path / "owners.sqlite3")
        store.initialize()
        service = ExternalResourcesService(
            store, client=client, rate_limit_per_s=2, rate_limit_burst=2
        )
        for module in (service_structure, service_rcsb):
            monkeypatch.setattr(
                module,
                "asyncio",
                SimpleNamespace(sleep=clock.sleep, timeout=asyncio.timeout),
            )
        monkeypatch.setattr(
            service_structure,
            "read_cached_alphafold_cartoon_plddt_poster",
            lambda _: None,
        )
        opts = FetchOptions(max_retries=0)
        granted = [
            Capability.EXTERNAL_FETCH_ANNOTATION.value,
            Capability.EXTERNAL_FETCH_STRUCTURE.value,
        ]

        async def call():
            try:
                if owner == "afdb-validation":
                    return await service.validate_afdb_exists(
                        "P12345", granted_capabilities=granted, opts=opts
                    )
                if owner == "afdb-resolution":
                    return await service._resolve_alphafold_structure_url(
                        accession="P12345",
                        fragment="F1",
                        granted_capabilities=granted,
                        workspace_id=None,
                        opts=opts,
                        bucket=service._bucket_for("alphafold"),
                    )
                if owner in {"afdb-poster", "afdb-poster-latest"}:
                    return await service.fetch_alphafold_poster(
                        accession="P12345",
                        fragment="F1",
                        version="latest" if owner.endswith("latest") else "v4",
                        granted_capabilities=granted,
                        opts=opts,
                    )
                if owner == "rcsb-poster":
                    return await service.fetch_rcsb_poster(
                        pdb_id="1RBL",
                        poster_kind="assembly-1",
                        granted_capabilities=granted,
                        opts=opts,
                    )
                if owner == "rcsb-scope":
                    return await service._validate_rcsb_structure_scope(
                        identity=_canonical_structure_identity("rcsb", "1RBL"),
                        granted_capabilities=granted,
                        workspace_id=None,
                        opts=opts,
                        bucket=service._bucket_for("rcsb"),
                    )
                return await service.fetch_structure_bytes(
                    provider="rcsb",
                    external_id="1RBL",
                    format="mmcif",
                    granted_capabilities=granted,
                    opts=opts,
                )
            except ProviderHttpError as error:
                assert error.status_code == 404
                return "not-found"

        try:
            tasks = [asyncio.create_task(call()) for _ in range(6)]
            if cancel_waiter:
                await clock.settle()
                tasks[2].cancel()
                with pytest.raises(asyncio.CancelledError):
                    await tasks[2]
                tasks = [task for index, task in enumerate(tasks) if index != 2]
                tasks.append(asyncio.create_task(call()))
            results = await clock.finish(tasks)
            assert calls == (
                [0, 0, 1, 1.5, 2, 2.5] if cancel_waiter else [0, 0, 0.5, 1, 1.5, 2]
            )
            assert results == (
                [None] * 6 if owner == "afdb-validation" else ["not-found"] * 6
            )
        finally:
            await service.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["compute-read", "compute-submit"])
async def test_compute_rate_failure_never_replays_operation(
    clock, wrapper_factory, kind
):
    calls = []

    async def invoke(index):
        calls.append((index, clock.now))
        raise ComputeRateLimitError("synthetic")

    call = wrapper_factory(kind, invoke)

    async def rejected(index):
        with pytest.raises(ComputeRateLimitError):
            await call(index)

    await clock.finish([asyncio.create_task(rejected(index)) for index in range(4)])
    assert calls == [(0, 0), (1, 0), (2, 0.5), (3, 1)]
