"""Typed identity and result contract for local annotation installation."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .annotation.setup import (
    ANNOTATION_DB_ASSET_VERSION,
    PLANNOTATE_DBS_SHA256,
    PLANNOTATE_DBS_VERSION,
    RFAM_SHA256,
    RFAM_VERSION,
    get_app_data_base,
)
from .annotation.tools import get_bundle_manifest
from .operations import (
    InputRevisionMismatch,
    ManagedOperationSubmission,
    OperationSubject,
)
from .services.plannotate import get_platform_suffix

_REVISION_PREFIX = "annotation-provisioning-v1:sha256:"
_INSTALLATION_PREFIX = "annotation-installation:sha256:"


class AnnotationProvisioningInput(BaseModel):
    """Server-derived desired installation; callers cannot choose a write path."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    installation_revision: str = Field(
        pattern=r"^annotation-provisioning-v1:sha256:[0-9a-f]{64}$"
    )
    installation_id: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    platform: str = Field(min_length=1, max_length=128)
    offline: bool


class AnnotationProvisioningResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    installation_revision: str = Field(
        pattern=r"^annotation-provisioning-v1:sha256:[0-9a-f]{64}$"
    )
    disposition: Literal["installed", "already_current"]
    tools_ready: bool
    databases_ready: bool
    rfam_runtime_ready: bool


class AnnotationProvisioningSubmission(BaseModel):
    """Public start shape. Installation coordinates are always server-derived."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    submission_key: str = Field(min_length=1, max_length=256)
    scope_id: str = Field(min_length=1, max_length=512)
    input_revision: str | None = Field(default=None, min_length=1, max_length=512)


def _installation_id(root: Path) -> str:
    identity = str(root.expanduser().resolve(strict=False)).encode("utf-8")
    return "sha256:" + hashlib.sha256(identity).hexdigest()


def current_annotation_provisioning_input() -> AnnotationProvisioningInput:
    """Describe the installation bytes this build expects on this machine."""

    platform = get_platform_suffix()
    manifest = get_bundle_manifest(platform)
    desired = {
        "contract": 1,
        "platform": platform,
        "tools": {
            name: {
                "available": entry["available"],
                "version": entry["version"],
                "sha256": entry.get("sha256"),
            }
            for name, entry in sorted(manifest.items())
        },
        "annotation_database_asset": ANNOTATION_DB_ASSET_VERSION,
        "rfam": {"version": RFAM_VERSION, "sha256": RFAM_SHA256},
        "plannotate_databases": {
            "version": PLANNOTATE_DBS_VERSION,
            "sha256": PLANNOTATE_DBS_SHA256,
        },
    }
    encoded = json.dumps(desired, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return AnnotationProvisioningInput(
        installation_revision=_REVISION_PREFIX + hashlib.sha256(encoded).hexdigest(),
        installation_id=_installation_id(get_app_data_base()),
        platform=platform,
        offline=os.environ.get("DNAFORGE_OFFLINE_ANNOTATION") == "1",
    )


def annotation_provisioning_subject_id(
    value: AnnotationProvisioningInput,
) -> str:
    return _INSTALLATION_PREFIX + value.installation_id.removeprefix("sha256:")


def prepare_annotation_provisioning_submission(
    submission: AnnotationProvisioningSubmission,
) -> ManagedOperationSubmission[AnnotationProvisioningInput]:
    current = current_annotation_provisioning_input()
    if (
        submission.input_revision is not None
        and submission.input_revision != current.installation_revision
    ):
        raise InputRevisionMismatch(
            "The supplied input revision does not match this annotation installation."
        )
    return ManagedOperationSubmission[AnnotationProvisioningInput](
        submission_key=submission.submission_key,
        subject=OperationSubject(
            scope_id=submission.scope_id,
            subject_id=annotation_provisioning_subject_id(current),
            input_revision=current.installation_revision,
        ),
        input=current,
    )


def annotation_provisioning_audit_parameters(value: dict) -> dict:
    """Keep installation paths out of agent and operation audit records."""

    return {
        "scope_id": value.get("scope_id"),
        "input_revision": value.get("input_revision"),
    }


__all__ = [
    "AnnotationProvisioningInput",
    "AnnotationProvisioningResult",
    "AnnotationProvisioningSubmission",
    "annotation_provisioning_audit_parameters",
    "annotation_provisioning_subject_id",
    "current_annotation_provisioning_input",
    "prepare_annotation_provisioning_submission",
]
