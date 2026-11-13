"""NEB Tm provider for the external_resource substrate .

Calls NEB's public Tm calculator API (`tmapi.neb.com`) for the AUTHORITATIVE
melting / annealing temperature of a primer (or primer pair) under a chosen NEB
polymerase product (Q5, ...). Outbound 3rd-party HTTP belongs in the sidecar;
this is its architecturally correct home.

Unlike the fetch-shaped providers (NCBI, UniProt), NEB Tm is a COMPUTE call —
submit a sequence, get numbers — so it exposes `compute_tm` rather than the
resource-fetch Protocol's `fetch`. The Protocol methods are implemented as inert
stubs so the object can still `service.register(...)` and be capability-gated /
resilience-wrapped like any other provider.

The API is keyless/public. Response shape (recorded 2026-07-13):
    { "success": bool,
      "data": { "p1": [{"tm","fgc","len","seq"}], "p2"?: [...],
                "ta"?: number, "conc": number, "notes": [...] },
      "meta": { "version": "0.19.0", ... } }
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import httpx

from ..contract import (
    Capability,
    FetchOptions,
    FetchResult,
    ParsedId,
    ProviderContractError,
    ProviderHttpError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    Xref,
)

_MIN_PRIMER_LEN = 10
_DNA_RE = re.compile(r"^[ACGT]+$")


@dataclass(frozen=True)
class NebTmOligo:
    tm: float
    gc_fraction: float
    length: int
    seq: str


@dataclass(frozen=True)
class NebTmResult:
    prodcode: str
    conc_nm: float
    p1: NebTmOligo
    p2: NebTmOligo | None
    ta: float | None
    api_version: str
    notes: list[str]


class NebTmProvider:
    """Compute-only provider hitting NEB's public Tm API. See module docstring."""

    provider_id: str = "neb-tm"

    DEFAULT_BASE_URL: str = "https://tmapi.neb.com"
    TM_PATH: str = "/tm"
    TM_BATCH_PATH: str = "/tm/batch"
    LICENSE: str = (
        "NEB Tm Calculator API (tmapi.neb.com); terms per New England Biolabs"
    )
    ATTRIBUTION: str = (
        "Tm/annealing values courtesy of New England Biolabs (tmapi.neb.com)"
    )

    def __init__(
        self, client: httpx.AsyncClient | None = None, *, base_url: str | None = None
    ) -> None:
        self._client = client
        self._base_url = base_url or self.DEFAULT_BASE_URL
        self.rate_limit_per_s: float = 3.0
        self.rate_limit_burst: float = 3.0

    def detect_id(self, raw: str) -> ParsedId | None:
        return None

    async def fetch(self, parsed_id: ParsedId, opts: FetchOptions) -> FetchResult:
        raise ProviderContractError(
            "neb-tm is a compute provider; use compute_tm(), not fetch()"
        )

    async def resolve_xrefs(
        self, parsed_id: ParsedId, target_provider: str | None = None
    ) -> list[Xref]:
        return []

    def declared_capabilities(self) -> list[Capability]:
        return [Capability.EXTERNAL_COMPUTE_TM]

    async def compute_tm(
        self,
        seq1: str,
        *,
        seq2: str | None = None,
        prodcode: str = "q5-0",
        conc_nm: float = 250.0,
        opts: FetchOptions,
    ) -> NebTmResult:
        if self._client is None:
            raise RuntimeError(
                "NebTmProvider used without an httpx.AsyncClient — service layer must inject."
            )

        s1 = _normalize_seq(seq1)
        _require_valid_primer(s1)
        s2: str | None = None
        if seq2 is not None:
            s2 = _normalize_seq(seq2)
            _require_valid_primer(s2)

        params: dict[str, str] = {
            "seq1": s1,
            "prodcode": prodcode,
            "conc": _format_conc(conc_nm),
            "fmt": "long",
        }
        if s2 is not None:
            params["seq2"] = s2
        url = f"{self._base_url}{self.TM_PATH}"

        try:
            response = await self._client.get(
                url,
                params=params,
                timeout=httpx.Timeout(
                    timeout=opts.total_timeout_s, connect=opts.connect_timeout_s
                ),
                headers={"User-Agent": opts.user_agent, "Accept": "application/json"},
            )
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                f"NEB Tm request timed out after {opts.total_timeout_s}s"
            ) from exc
        except (httpx.HTTPError, OSError) as exc:
            raise ProviderHttpError(
                f"NEB Tm network error: {exc.__class__.__name__}"
            ) from exc

        if response.status_code == 429:
            raise ProviderRateLimitError(
                "NEB Tm rate-limited",
                retry_after_s=_parse_retry_after(response.headers.get("Retry-After")),
            )
        if response.status_code >= 400:
            raise ProviderHttpError(
                f"NEB Tm returned HTTP {response.status_code}",
                status_code=response.status_code,
            )

        try:
            body: Any = response.json()
        except ValueError as exc:
            raise ProviderContractError("NEB Tm returned a non-JSON body") from exc

        if not isinstance(body, dict) or not body.get("success"):
            raise ProviderContractError("NEB Tm reported an unsuccessful result")

        data = body.get("data") or {}
        meta = body.get("meta") or {}
        p1 = _parse_oligo(data.get("p1"))
        if p1 is None:
            raise ProviderContractError("NEB Tm response missing primary oligo (p1)")
        ta = data.get("ta")
        return NebTmResult(
            prodcode=prodcode,
            conc_nm=float(data.get("conc", conc_nm)),
            p1=p1,
            p2=_parse_oligo(data.get("p2")),
            ta=float(ta) if ta is not None else None,
            api_version=str(meta.get("version", "")),
            notes=list(data.get("notes") or []),
        )

    async def compute_tm_batch(
        self,
        sequences: list[str],
        *,
        prodcode: str = "q5-0",
        conc_nm: float = 250.0,
        opts: FetchOptions,
    ) -> list[NebTmResult]:
        """One POST to NEB ``/tm/batch`` for every submitted oligo.

        Each sequence is a singleton pair (``[[seq], ...]``) so a design's
        primers share one request without inventing PCR pairing. ``conc`` is
        nM, same unit as ``GET /tm``.
        """
        if self._client is None:
            raise RuntimeError(
                "NebTmProvider used without an httpx.AsyncClient — service layer must inject."
            )
        if not sequences:
            return []

        normalized: list[str] = []
        for raw in sequences:
            seq = _normalize_seq(raw)
            _require_valid_primer(seq)
            normalized.append(seq)

        url = f"{self._base_url}{self.TM_BATCH_PATH}"
        payload = {
            "seqpairs": [[seq] for seq in normalized],
            "prodcode": prodcode,
            "conc": _format_conc(conc_nm),
        }

        try:
            response = await self._client.post(
                url,
                json=payload,
                timeout=httpx.Timeout(
                    timeout=opts.total_timeout_s, connect=opts.connect_timeout_s
                ),
                headers={"User-Agent": opts.user_agent, "Accept": "application/json"},
            )
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                f"NEB Tm batch request timed out after {opts.total_timeout_s}s"
            ) from exc
        except (httpx.HTTPError, OSError) as exc:
            raise ProviderHttpError(
                f"NEB Tm batch network error: {exc.__class__.__name__}"
            ) from exc

        if response.status_code == 429:
            raise ProviderRateLimitError(
                "NEB Tm rate-limited",
                retry_after_s=_parse_retry_after(response.headers.get("Retry-After")),
            )
        if response.status_code >= 400:
            raise ProviderHttpError(
                f"NEB Tm batch returned HTTP {response.status_code}",
                status_code=response.status_code,
            )

        try:
            body: Any = response.json()
        except ValueError as exc:
            raise ProviderContractError(
                "NEB Tm batch returned a non-JSON body"
            ) from exc

        if not isinstance(body, dict) or not body.get("success"):
            raise ProviderContractError("NEB Tm batch reported an unsuccessful result")

        rows = body.get("data")
        if not isinstance(rows, list) or len(rows) != len(normalized):
            raise ProviderContractError(
                "NEB Tm batch did not return one result per submitted sequence"
            )

        meta = body.get("meta") or {}
        api_version = str(meta.get("version", ""))
        results: list[NebTmResult] = []
        for seq, row in zip(normalized, rows, strict=True):
            parsed = _parse_batch_row(row, seq=seq, conc_nm=conc_nm)
            if parsed is None:
                raise ProviderContractError(
                    "NEB Tm batch row was missing a primary oligo Tm"
                )
            results.append(
                NebTmResult(
                    prodcode=prodcode,
                    conc_nm=parsed[1],
                    p1=parsed[0],
                    p2=None,
                    ta=parsed[2],
                    api_version=api_version,
                    notes=parsed[3],
                )
            )
        return results


def _normalize_seq(seq: str) -> str:
    return "".join(seq.split()).upper()


def _require_valid_primer(seq: str) -> None:
    if len(seq) < _MIN_PRIMER_LEN or not _DNA_RE.fullmatch(seq):
        raise ProviderContractError(
            f"NEB Tm requires an A/C/G/T sequence of at least {_MIN_PRIMER_LEN} bp "
            f"(got {len(seq)})",
            status_code=422,
        )


def _format_conc(conc_nm: float) -> str:
    value = float(conc_nm)
    return str(int(value)) if value.is_integer() else str(value)


def _parse_batch_row(
    row: Any, *, seq: str, conc_nm: float
) -> tuple[NebTmOligo, float, float | None, list[str]] | None:
    """Accept both the documented batch row (``tm1``) and a GET-shaped ``p1``."""
    if not isinstance(row, dict):
        return None
    p1 = _parse_oligo(row.get("p1"))
    if p1 is None and isinstance(row.get("tm1"), (int, float)):
        p1 = NebTmOligo(
            tm=float(row["tm1"]),
            gc_fraction=float(row.get("fgc1", row.get("fgc", 0.0))),
            length=int(row.get("len1", row.get("len", len(seq)))),
            seq=str(row.get("seq1", seq)),
        )
    if p1 is None:
        return None
    ta = row.get("ta")
    return (
        p1,
        float(row.get("conc", conc_nm)),
        float(ta) if ta is not None else None,
        list(row.get("notes") or []),
    )


def _parse_oligo(entry: Any) -> NebTmOligo | None:
    if not entry or not isinstance(entry, list):
        return None
    first = entry[0]
    if not isinstance(first, dict) or "tm" not in first:
        return None
    return NebTmOligo(
        tm=float(first["tm"]),
        gc_fraction=float(first.get("fgc", 0.0)),
        length=int(first.get("len", 0)),
        seq=str(first.get("seq", "")),
    )


def _parse_retry_after(header: str | None) -> float | None:
    if not header:
        return None
    try:
        return float(header)
    except ValueError:
        return None
