"""Bounded variant calls tied to exact coding-reference bytes and one sample."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .variant_source_operation_contract import VariantSourceResult


class SequenceVariantCallsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    source: VariantSourceResult
    chrom: str = Field(min_length=1, max_length=512)
    sequence: str = Field(min_length=1, max_length=250_000)
    sample: str = Field(min_length=1, max_length=1024)
    limit: int = Field(default=5000, ge=1, le=5000)

    @field_validator("sequence")
    @classmethod
    def validate_sequence(cls, value: str) -> str:
        value = value.upper()
        if set(value) - set("ACGTNRYKMSWBDHV"):
            raise ValueError("Reference contains invalid DNA characters.")
        return value


class SequenceVariantCall(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    id: str
    position: int = Field(ge=1)
    reference: str
    alternate: str
    allele_index: int = Field(ge=1)
    quality: float | None
    filters: list[str]
    genotype: str | None
    reference_count: int | None = Field(default=None, ge=0)
    alternate_count: int | None = Field(default=None, ge=0)
    total_allele_count: int | None = Field(default=None, ge=0)
    allele_fraction: float | None = Field(default=None, ge=0, le=1)
    unsupported_reason: str | None = None


class SequenceVariantCallsResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    source_identity: str
    reference_sha256: str
    chrom: str
    sample: str
    count_basis: Literal["FORMAT/AD; denominator=sum of all original allele depths"] = (
        "FORMAT/AD; denominator=sum of all original allele depths"
    )
    calls: list[SequenceVariantCall]
