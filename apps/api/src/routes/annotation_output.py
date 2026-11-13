"""Parse ordinary annotation output without executing or recording a run."""

from hashlib import sha256
from io import StringIO
from typing import Literal

from dnaforge_annotation.contract import AnnotationResult
from dnaforge_annotation.files import read_annotation_output
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

MAX_ANNOTATION_OUTPUT_BYTES = 16 * 1024 * 1024


class AnnotationOutputParseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(max_length=MAX_ANNOTATION_OUTPUT_BYTES)
    format: Literal["json", "gff3"]


class AnnotationOutputParseResult(BaseModel):
    output_sha256: str
    result: AnnotationResult


router = APIRouter(tags=["Annotation"])


@router.post(
    "/annotation/output/parse",
    response_model=AnnotationOutputParseResult,
    summary="Read existing annotation output without running an analysis",
)
def parse_annotation_output(
    request: AnnotationOutputParseRequest,
) -> AnnotationOutputParseResult:
    encoded = request.content.encode("utf-8")
    if len(encoded) > MAX_ANNOTATION_OUTPUT_BYTES:
        raise HTTPException(413, "Annotation output exceeds the 16 MiB import limit")
    try:
        result = read_annotation_output(
            StringIO(request.content), format=request.format
        )
    except ValidationError as error:
        raise HTTPException(
            422, "The file does not contain a valid annotation result"
        ) from error
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return AnnotationOutputParseResult(
        output_sha256=sha256(encoded).hexdigest(), result=result
    )
