"""Typed route for the built-in annotation engine .

``AnnotationRequest`` and ``AnnotationResult`` in ``services/plannotate.py``
own this wire contract. FastAPI validates the request before any computation,
the OpenAPI export describes both models exactly, and the desktop client is
generated from that description. The generic ``/services/{name}/execute``
route no longer executes built-in services; it proxies configured plugins only.
"""

from fastapi import APIRouter, HTTPException, Request, status

from ..security.operation_authority import human_operation_authority_configured
from ..services import registry
from ..services.plannotate import (
    PLANNOTATE_SERVICE_NAME,
    AnnotationRequest,
    AnnotationResult,
    PlannotateService,
)

router = APIRouter(tags=["Annotation"])


def _annotation_service() -> PlannotateService:
    service = registry.get(PLANNOTATE_SERVICE_NAME)
    if not isinstance(service, PlannotateService):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Annotation service is not registered",
        )
    return service


@router.post(
    "/annotation",
    response_model=AnnotationResult,
    response_model_exclude_none=True,
    summary="Annotate a DNA sequence with the built-in annotation engine",
)
async def annotate_sequence(
    request: Request, body: AnnotationRequest
) -> AnnotationResult:
    """Run the built-in annotation engine over one validated request.

    Readiness and engine failures stay in the result's ``error`` field with
    HTTP 200 so the desktop presents them in the annotation drawer; malformed
    requests fail with 422 before any computation.
    """
    if (
        getattr(request.app.state, "managed_operations", None) is not None
        and human_operation_authority_configured()
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "MANAGED_ANNOTATION_REQUIRED",
                "message": (
                    "This runtime owns annotation through /operations/annotation; "
                    "the foreground compatibility endpoint is unavailable."
                ),
            },
        )
    return await _annotation_service().annotate(body)
