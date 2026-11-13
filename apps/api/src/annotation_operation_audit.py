from __future__ import annotations

import hashlib
import json
from typing import Any

from dnaforge_annotation.contract import AnnotationRequest
from pydantic import ValidationError

from .annotation_operation_contract import annotation_input_revision


def _bounded_string(value: Any, *, max_length: int) -> str | None:
    return value if isinstance(value, str) and len(value) <= max_length else None


def annotation_submission_audit_parameters(args: dict[str, Any]) -> dict[str, Any]:
    subject_value = args.get("subject")
    subject = subject_value if isinstance(subject_value, dict) else {}
    input_value = args.get("input")
    annotation_input = input_value if isinstance(input_value, dict) else {}
    sequence_value = annotation_input.get("sequence")
    sequence = sequence_value if isinstance(sequence_value, str) else None

    derived_revision: str | None = None
    try:
        parsed_input = AnnotationRequest.model_validate(annotation_input)
        derived_revision = annotation_input_revision(parsed_input)
    except ValidationError:
        pass

    input_summary: dict[str, Any] = {
        "sequence_length": len(sequence) if sequence is not None else None,
        "sequence_sha256": (
            "sha256:" + hashlib.sha256(sequence.encode("utf-8")).hexdigest()
            if sequence is not None
            else None
        ),
        "input_revision": derived_revision,
        "linear": (
            annotation_input.get("linear")
            if isinstance(annotation_input.get("linear"), bool)
            else None
        ),
    }
    for coordinate in ("start", "end"):
        value = annotation_input.get(coordinate)
        input_summary[coordinate] = (
            value
            if isinstance(value, int)
            and not isinstance(value, bool)
            and -(2**63) <= value < 2**63
            else None
        )

    return {
        "submission_key": _bounded_string(args.get("submission_key"), max_length=256),
        "subject": {
            "scope_id": _bounded_string(subject.get("scope_id"), max_length=512),
            "subject_id": _bounded_string(subject.get("subject_id"), max_length=1024),
            "claimed_input_revision": _bounded_string(
                subject.get("input_revision"), max_length=512
            ),
        },
        "input": input_summary,
    }


def recorded_annotation_import_audit_parameters(
    args: dict[str, Any],
) -> dict[str, Any]:
    subject_value = args.get("subject")
    subject = subject_value if isinstance(subject_value, dict) else {}
    receipt_value = args.get("receipt")
    receipt = receipt_value if isinstance(receipt_value, dict) else {}
    request_value = receipt.get("request")
    request = request_value if isinstance(request_value, dict) else {}
    sequence_value = request.get("sequence")
    sequence = sequence_value if isinstance(sequence_value, str) else None
    input_value = receipt.get("input")
    receipt_input = input_value if isinstance(input_value, dict) else {}
    result_value = receipt.get("result")
    result = result_value if isinstance(result_value, dict) else {}
    features = result.get("features")
    canonical = json.dumps(args, sort_keys=True, separators=(",", ":"), default=str)
    return {
        "subject": {
            "scope_id": _bounded_string(subject.get("scope_id"), max_length=512),
            "subject_id": _bounded_string(subject.get("subject_id"), max_length=1024),
            "claimed_input_revision": _bounded_string(
                subject.get("input_revision"), max_length=512
            ),
        },
        "receipt": {
            "schema_version": receipt.get("schema_version"),
            "reported_run_id": _bounded_string(receipt.get("run_id"), max_length=128),
            "outcome": _bounded_string(receipt.get("outcome"), max_length=64),
            "input_revision": _bounded_string(
                receipt_input.get("revision"), max_length=512
            ),
            "sequence_length": len(sequence) if sequence is not None else None,
            "sequence_sha256": (
                "sha256:" + hashlib.sha256(sequence.encode("utf-8")).hexdigest()
                if sequence is not None
                else None
            ),
            "feature_count": len(features) if isinstance(features, list) else None,
            "payload_sha256": "sha256:"
            + hashlib.sha256(canonical.encode()).hexdigest(),
        },
    }
