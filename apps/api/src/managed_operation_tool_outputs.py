"""Public admission receipts, distinct from renderer preparation responses."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .operations import OperationSnapshot
from .operations.contracts import OperationState


class _Receipt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ok: Literal[True]
    operationId: str


class AlignmentAdmissionOutput(_Receipt):
    result: OperationSnapshot


class SequenceAnalysisAdmissionOutput(_Receipt):
    documentId: str
    status: OperationState


class NgsAnalysisContinuationArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    documentId: str = Field(min_length=1)
    operationId: str = Field(min_length=1)
    name: str = Field(min_length=1)


class NgsAnalysisContinuation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tool: Literal["get_ngs_analysis"]
    arguments: NgsAnalysisContinuationArguments


class NgsAnalysisAdmissionOutput(SequenceAnalysisAdmissionOutput):
    continuation: NgsAnalysisContinuation


class CloneAnalysisAdmissionOutput(SequenceAnalysisAdmissionOutput):
    sessionId: str


class VariantCallsAdmissionOutput(SequenceAnalysisAdmissionOutput):
    chrom: str
