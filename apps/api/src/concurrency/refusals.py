"""Structured refusals for overloaded or unsupported substrate calls."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field

RefusalKind = Literal["transient", "saturated", "unsupported"]


class QueueRefusalResponse(BaseModel):
    """Stable HTTP payload for work refused before physical execution."""

    error: Literal["queue_full"] = "queue_full"
    refusal_kind: RefusalKind
    queue_depth: int = Field(ge=0)
    pool_capacity: int = Field(ge=0)
    retry_after_seconds: int = Field(ge=0)


@dataclass
class QueueRefusal(Exception):
    pool: str
    queue_depth: int
    pool_capacity: int
    retry_after_seconds: int = 8
    refusal_kind: RefusalKind = "transient"

    def to_response(self) -> dict[str, object]:
        return QueueRefusalResponse(
            refusal_kind=self.refusal_kind,
            queue_depth=self.queue_depth,
            pool_capacity=self.pool_capacity,
            retry_after_seconds=self.retry_after_seconds,
        ).model_dump(mode="json")
