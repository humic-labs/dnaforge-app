"""Register annotation engine capability in the ToolboxRegistry.

Reads versions from TOOL_REGISTRY and checks real binary/database state.
Called at startup. Status is updated during downloads by ensure_tools()
and ensure_databases().
"""

from ..annotation.setup import (
    get_database_status,
    is_annotation_provisioning,
    is_rfam_runtime_ready,
)
from ..annotation.tools import get_platform_binary_versions, is_downloading_tools
from ..services.plannotate import check_required_binaries, find_binaries_dir
from .registry import Capability, Component, toolbox_registry


def register_annotation_capability() -> None:
    """Register annotation engine as a base capability with all components.

    Binary names and versions are derived from get_platform_binary_versions() —
    single source of truth, filtered to the tools that actually ship on THIS
    platform. Adding a tool to TOOL_REGISTRY automatically propagates here AND to
    check_required_binaries(). A tool with no build for a platform is omitted
    rather than registered as a permanent "error" component .
    """
    tool_components = [
        Component(
            id=name,
            label=name,
            status="unavailable",
            version=version,
            source="downloaded",
        )
        for name, version in get_platform_binary_versions(
            required_by="plannotate"
        ).items()
    ]

    tool_components.append(
        Component(
            id="databases",
            label="Annotation Databases",
            status="unavailable",
            source="downloaded",
        )
    )

    toolbox_registry.register(
        Capability(
            id="annotation",
            label="Annotation Engine",
            source="builtin",
            tier="base",
            auto_install=True,
            components=tool_components,
        )
    )


def sync_annotation_status() -> None:
    """Update annotation component statuses from real state.

    Called on each /toolbox/status request (lazy, not polled).
    """
    cap = toolbox_registry.get_capability("annotation")
    if cap is None:
        return

    db_status = get_database_status()
    provisioning = is_annotation_provisioning()
    downloading_tools = is_downloading_tools()

    binaries_dir = find_binaries_dir()
    binaries = check_required_binaries(binaries_dir)

    for comp in cap.components:
        if comp.id == "databases":
            if provisioning:
                comp.status = "downloading"
                comp.progress = {
                    "phase": "provisioning",
                    "detail": "Preparing annotation databases...",
                }
            elif db_status["downloaded"] and is_rfam_runtime_ready():
                comp.status = "ready"
                comp.version = db_status.get("version")
                comp.progress = None
            else:
                comp.status = "error"
                comp.progress = (
                    None
                    if not db_status["downloaded"]
                    else {
                        "phase": "error",
                        "detail": "Rfam indexes are unavailable for this platform.",
                    }
                )
        else:
            if downloading_tools:
                comp.status = "downloading"
                comp.progress = {
                    "phase": "downloading",
                    "detail": f"Installing {comp.id}...",
                }
            else:
                binary_path = binaries.get(comp.id)
                if binary_path is not None:
                    comp.status = "ready"
                    comp.path = str(binary_path)
                    comp.progress = None
                else:
                    comp.status = "error"
                    comp.progress = None
