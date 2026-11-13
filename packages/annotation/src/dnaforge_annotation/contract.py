"""Validated types shared by the standalone and managed annotation paths."""

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

DbSource = Literal["protein", "nucleotide", "rna"]


class AnnotationRequest(BaseModel):
    """DNA and coordinate range to annotate."""

    model_config = ConfigDict(extra="forbid")

    sequence: str = Field(
        ...,
        description=(
            "DNA sequence to annotate (plasmid or linear). An explicitly empty "
            "sequence returns an empty result without running the engine."
        ),
    )
    linear: bool = Field(
        False, description="Treat as linear DNA instead of circular plasmid"
    )
    start: int | None = Field(
        None, description="Optional 0-indexed start of a subrange to annotate"
    )
    end: int | None = Field(
        None, description="Optional half-open end of a subrange to annotate"
    )


class AnnotationFeature(BaseModel):
    """One annotated feature with query and reference coordinates."""

    name: str
    accession: str = Field("", description="Reference database accession")
    start: int = Field(..., description="1-indexed start in the query sequence")
    end: int = Field(..., description="Inclusive end in the query sequence")
    strand: int
    identity: float = Field(
        ...,
        description="Percent identity: amino acid for protein hits, else nucleotide",
    )
    coverage: float = Field(..., description="Percent of the reference feature covered")
    fragment: bool = Field(..., description="True when the hit is a partial match")
    type: str = ""
    description: str = ""
    ref_start: int = Field(
        ..., description="Start position in reference feature (1-indexed)"
    )
    ref_end: int = Field(..., description="End position in reference feature")
    ref_length: int = Field(..., description="Total length of reference feature")
    db_source: DbSource = Field(
        ...,
        description=(
            "Database source: protein (AA identity), nucleotide (nt identity), or rna"
        ),
    )


class AnnotationResult(BaseModel):
    """Annotation features and the cleaned source sequence length."""

    features: list[AnnotationFeature] = Field(
        ..., description="Annotated features with identity/coverage scores"
    )
    sequence_length: int = Field(
        ..., description="Length of the cleaned input sequence"
    )
    error: str | None = Field(
        None,
        min_length=1,
        description="Readiness or engine failure to present; features are empty when set",
    )


class AnnotationExecutables(BaseModel):
    """Exact executable paths used by one annotation runtime."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    blastn: Path
    diamond: Path
    cmscan: Path


class AnnotationRuntime(BaseModel):
    """Explicit local resources required by a scientific annotation run."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    data_dir: Path
    executables: AnnotationExecutables
    temp_dir: Path | None = None
    threads: int = Field(1, ge=1)
    database_config: Path | None = None
