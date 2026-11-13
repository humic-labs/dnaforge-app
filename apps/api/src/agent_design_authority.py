from __future__ import annotations

from typing import Any

from .capability_policy import has_required_capabilities
from .control_plane import get_control_plane_store

DESIGN_EDIT_TOOLS = frozenset(
    {
        "set_junction_spacer",
        "set_golden_gate_schema",
        "set_moclo_factory_stage",
        "apply_moclo_schema",
        "place_digest_fragment",
        "set_primer_pbs_length",
        "set_primer_overhang_length",
        "set_golden_gate_offset",
        "set_pcr_polymerase",
        "remove_design_region",
        "reorder_design_regions",
        "apply_overhang_optimization",
        "assembly.setEditableField",
        "update_assembly_primer",
        "save_design_primers",
    }
)


def design_authoring_scope(
    tool_name: str,
    args: dict[str, Any],
    agent_identity_id: str,
    capabilities: list[str],
) -> list[str]:
    if tool_name not in DESIGN_EDIT_TOOLS and tool_name != "finalize_design_assembly":
        return capabilities
    if not has_required_capabilities(capabilities, ["create-entity"]):
        return capabilities
    design_id = args.get("designId")
    if not isinstance(design_id, str):
        return capabilities
    design_id = design_id.removeprefix("waypoint://design/")
    store = get_control_plane_store()
    if store.agent_design_owner(design_id) != agent_identity_id:
        return capabilities
    implied = ["edit-assembly"]
    if tool_name == "finalize_design_assembly":
        version = args.get("expectedDesignVersion")
        fingerprint = args.get("previewFingerprint")
        if not isinstance(version, int) or not isinstance(fingerprint, str):
            return capabilities
        if not store.agent_has_new_design_preview(
            agent_identity_id, design_id, version, fingerprint
        ):
            return capabilities
        implied = ["write-workspace", "finalize-assembly"]
    return list(dict.fromkeys([*capabilities, *implied]))
