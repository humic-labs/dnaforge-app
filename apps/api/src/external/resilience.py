"""Provider-agnostic resilience primitives for the external_resource substrate.

Extracted from `service.py`  so the substrate's generic infrastructure
— the per-origin token-bucket rate limiter, the per-origin circuit breaker, and
the exponential-backoff + retry-classification helpers — lives in one cohesive,
independently-testable unit instead of being buried in the orchestration class.

Nothing here knows about UniProt/RCSB/NCBI or any wire format; it depends only
on the provider contract (`FetchOptions` + the typed provider errors). The
service composes these to wrap every provider call.
"""

from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field

from .contract import FetchOptions, ProviderContractError, ProviderError

DEFAULT_RATE_LIMIT_PER_S = 10.0
DEFAULT_RATE_LIMIT_BURST = 10.0
DEFAULT_BREAKER_FAILURE_THRESHOLD = 5
DEFAULT_BREAKER_RECOVERY_S = 30.0


@dataclass
class _TokenBucket:
    capacity: float
    refill_rate_per_s: float
    tokens: float = field(init=False)
    last_refill_monotonic: float = field(init=False)

    def __post_init__(self) -> None:
        if not math.isfinite(self.capacity) or self.capacity < 1:
            raise ValueError("Token bucket capacity must be finite and at least one")
        if not math.isfinite(self.refill_rate_per_s) or self.refill_rate_per_s <= 0:
            raise ValueError("Token bucket refill rate must be finite and positive")
        self.tokens = self.capacity
        self.last_refill_monotonic = time.monotonic()

    def take(self) -> float:
        """Consume one token. Returns the seconds the caller should sleep
        if no token is currently available; 0.0 means take it now."""
        now = time.monotonic()
        elapsed = now - self.last_refill_monotonic
        self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_rate_per_s)
        self.last_refill_monotonic = now
        self.tokens -= 1.0
        return max(0.0, -self.tokens / self.refill_rate_per_s)


@dataclass(frozen=True)
class _ClosedCircuit:
    failures: int = 0


@dataclass(frozen=True)
class _CoolingCircuit:
    opened_at: float
    failures: int


@dataclass(frozen=True)
class _RecoveringCircuit:
    started_at: float
    failures: int


@dataclass
class _CircuitAttempt:
    generation: int
    finished: bool = False


class _CircuitBreaker:
    def __init__(
        self,
        failure_threshold: int = DEFAULT_BREAKER_FAILURE_THRESHOLD,
        recovery_timeout_s: float = DEFAULT_BREAKER_RECOVERY_S,
        consecutive_failures: int = 0,
        opened_at_monotonic: float | None = None,
    ) -> None:
        self.failure_threshold = failure_threshold
        self.recovery_timeout_s = recovery_timeout_s
        self._generation = 0
        self._state: _ClosedCircuit | _CoolingCircuit | _RecoveringCircuit = (
            _ClosedCircuit(consecutive_failures)
            if opened_at_monotonic is None
            else _CoolingCircuit(opened_at_monotonic, consecutive_failures)
        )

    @property
    def phase(self) -> str:
        if isinstance(self._state, _ClosedCircuit):
            return "closed"
        if isinstance(self._state, _CoolingCircuit):
            return "cooldown"
        return "recovery"

    @property
    def consecutive_failures(self) -> int:
        return self._state.failures

    @property
    def opened_at_monotonic(self) -> float | None:
        if isinstance(self._state, _ClosedCircuit):
            return None
        if isinstance(self._state, _CoolingCircuit):
            return self._state.opened_at
        return self._state.started_at

    @property
    def is_open(self) -> bool:
        if isinstance(self._state, _ClosedCircuit):
            return False
        if isinstance(self._state, _RecoveringCircuit):
            return True
        return time.monotonic() - self._state.opened_at < self.recovery_timeout_s

    def try_acquire(self) -> _CircuitAttempt | None:
        if self.is_open:
            return None
        if isinstance(self._state, _CoolingCircuit):
            self._generation += 1
            self._state = _RecoveringCircuit(time.monotonic(), self._state.failures)
        return _CircuitAttempt(self._generation)

    def _finish(self, attempt: _CircuitAttempt) -> bool:
        if attempt.finished:
            return False
        attempt.finished = True
        return attempt.generation == self._generation

    def record_success(self, attempt: _CircuitAttempt) -> None:
        if not self._finish(attempt):
            return
        if not isinstance(self._state, _ClosedCircuit):
            self._generation += 1
        self._state = _ClosedCircuit()

    def record_failure(self, attempt: _CircuitAttempt) -> None:
        if not self._finish(attempt):
            return
        if isinstance(self._state, _CoolingCircuit) and self.is_open:
            return
        failures = self._state.failures + 1
        if (
            not isinstance(self._state, _ClosedCircuit)
            or failures >= self.failure_threshold
        ):
            self._generation += 1
            self._state = _CoolingCircuit(time.monotonic(), failures)
        else:
            self._state = _ClosedCircuit(failures)

    def release(self, attempt: _CircuitAttempt) -> None:
        if self._finish(attempt) and isinstance(self._state, _RecoveringCircuit):
            self._generation += 1
            self._state = _CoolingCircuit(time.monotonic(), self._state.failures)

    def opens_at_s(self) -> float:
        if isinstance(self._state, _ClosedCircuit):
            return 0.0
        if isinstance(self._state, _RecoveringCircuit):
            return self.recovery_timeout_s
        elapsed = time.monotonic() - self._state.opened_at
        return max(0.0, self.recovery_timeout_s - elapsed)


def _backoff_wait(attempt: int, opts: FetchOptions) -> float:
    """Exponential backoff with full jitter, capped at opts.max_backoff_s."""
    base = opts.initial_backoff_s * (2**attempt)
    capped = min(base, opts.max_backoff_s)
    return random.uniform(0, capped)  # noqa: S311 — jitter, not crypto


def _retry_after_seconds(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


def _is_non_retryable_client_error(exc: ProviderError) -> bool:
    return exc.status_code is not None and 400 <= exc.status_code < 500


def _is_provider_contract_error(exc: ProviderError) -> bool:
    return isinstance(exc, ProviderContractError)


def _should_record_breaker_failure(exc: ProviderError) -> bool:
    if isinstance(exc, ProviderContractError):
        return True
    status_code = exc.status_code
    if status_code is not None and 400 <= status_code < 500:
        return False
    return True


def _parse_content_length(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None
