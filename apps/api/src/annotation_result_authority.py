"""Canonical retained annotation result identity and private authority payload."""

import hashlib
import json
from typing import Any

from dnaforge_annotation.contract import AnnotationResult

from .operations import OperationSnapshot


def result_sha256(result: AnnotationResult) -> str:
    payload = json.dumps(
        result.model_dump(mode="json", round_trip=True),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def trusted_result_context(
    snapshot: OperationSnapshot[AnnotationResult],
    result: AnnotationResult,
    result_sha256: str,
) -> dict[str, Any]:
    return {
        "schema": "dnaforge.managed-annotation-authority.v1",
        "operation": {
            "id": snapshot.id,
            "kind": snapshot.kind,
            "state": snapshot.state.value,
            "result_status": snapshot.result_status,
            "version": snapshot.version,
            "subject": snapshot.subject.model_dump(mode="json"),
        },
        "resultSha256": result_sha256,
        "result": result.model_dump(mode="json", round_trip=True),
    }
