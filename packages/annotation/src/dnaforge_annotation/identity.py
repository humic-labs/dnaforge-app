"""Portable identity of the sequence and topology supplied for annotation."""

import hashlib
import json

from .contract import AnnotationRequest
from .core import clean_sequence


def annotation_input_revision(request: AnnotationRequest) -> str:
    payload = json.dumps(
        {"linear": request.linear, "sequence": clean_sequence(request.sequence)},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return "annotation-input-v1:sha256:" + hashlib.sha256(payload).hexdigest()
