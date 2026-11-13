"""Manifest-selected result codecs for reusable compute protocol drivers.

Drivers own transport and lifecycle. Codecs own the narrower problem of turning
one provider family’s response document into durable files and metrics. Unknown
payloads always fall back to a raw artifact instead of being discarded.
"""

from __future__ import annotations

import json
from typing import Any, Mapping

from .contract import OutputKind, ProviderJobRef, ResultBundle, ResultFile


def raw_json_bundle(
    ref: ProviderJobRef, tool_id: str, payload: Any, tool: Mapping[str, Any]
) -> ResultBundle:
    """Preserve an arbitrary response without claiming a scientific format."""
    if isinstance(payload, (Mapping, list)):
        content = json.dumps(payload, indent=2).encode()
        name = "result.json"
        media_type = "application/json"
    elif isinstance(payload, bytes):
        content = payload
        name = "result.bin"
        media_type = "application/octet-stream"
    else:
        content = str(payload if payload is not None else "").encode()
        name = "result.txt"
        media_type = "text/plain"
    return ResultBundle(
        ref=ref,
        output_kind=OutputKind.BINARY,
        files=(ResultFile(name=name, content=content, media_type=media_type),),
        provenance={
            "provider": ref.provider_id,
            "tool": tool_id,
            "remote_id": ref.remote_id,
            "endpoint": str(tool.get("path", "")),
            "codec": "raw-json",
        },
    )


def nvidia_biology_bundle(
    ref: ProviderJobRef, tool_id: str, payload: Any, tool: Mapping[str, Any]
) -> ResultBundle:
    """Decode the response families shared by NVIDIA hosted biology NIMs."""
    files: list[ResultFile] = []
    metrics: dict[str, Any] = {}
    provenance = {
        "provider": ref.provider_id,
        "tool": tool_id,
        "remote_id": ref.remote_id,
        "endpoint": str(tool.get("path", "")),
        "codec": "nvidia-biology",
    }
    kind = OutputKind.BINARY
    if isinstance(payload, Mapping):
        pdbs = payload.get("pdbs")
        if isinstance(pdbs, list):
            for i, pdb in enumerate(pdbs):
                if isinstance(pdb, str):
                    files.append(
                        ResultFile(
                            name=f"model_{i + 1}.pdb",
                            content=pdb.encode(),
                            media_type="chemical/x-pdb",
                        )
                    )
        for key in ("pdb", "structure"):
            if isinstance(payload.get(key), str):
                files.append(
                    ResultFile(
                        name="model.pdb",
                        content=payload[key].encode(),
                        media_type="chemical/x-pdb",
                    )
                )
        structures = payload.get("structures") or payload.get("cifs")
        if isinstance(structures, list):
            for i, structure in enumerate(structures):
                if isinstance(structure, Mapping) and isinstance(
                    structure.get("structure"), str
                ):
                    fmt = str(structure.get("format") or "mmcif").lower()
                    extension = "pdb" if fmt == "pdb" else "cif"
                    source = str(
                        structure.get("source")
                        or structure.get("name")
                        or f"model_{i + 1}"
                    )
                    stem = (
                        source.rsplit("/", 1)[-1].rsplit(".", 1)[0] or f"model_{i + 1}"
                    )
                    files.append(
                        ResultFile(
                            name=f"{stem}.{extension}",
                            content=structure["structure"].encode(),
                            media_type=(
                                "chemical/x-mmcif"
                                if extension == "cif"
                                else "chemical/x-pdb"
                            ),
                        )
                    )
                else:
                    text = (
                        structure
                        if isinstance(structure, str)
                        else json.dumps(structure)
                    )
                    files.append(
                        ResultFile(
                            name=f"model_{i + 1}.cif",
                            content=text.encode(),
                            media_type="chemical/x-mmcif",
                        )
                    )
        sequences = (
            payload.get("mfasta") or payload.get("sequences") or payload.get("fasta")
        )
        if isinstance(sequences, str):
            files.append(
                ResultFile(
                    name="designs.fasta",
                    content=sequences.encode(),
                    media_type="text/plain",
                )
            )
        elif isinstance(sequences, list) and all(
            isinstance(sequence, str) for sequence in sequences
        ):
            fasta = "".join(
                f">design_{index + 1}\n{sequence}\n"
                for index, sequence in enumerate(sequences)
            )
            files.append(
                ResultFile(
                    name="designs.fasta",
                    content=fasta.encode(),
                    media_type="text/plain",
                )
            )
        for key in (
            "plddt",
            "ptm",
            "iptm",
            "confidence",
            "scores",
            "affinity",
            "position_confidence",
            "pae",
            "confidence_scores",
            "ptm_scores",
            "iptm_scores",
            "ligand_iptm_scores",
            "protein_iptm_scores",
            "complex_plddt_scores",
            "complex_iplddt_scores",
            "complex_pde_scores",
            "complex_ipde_scores",
            "affinities",
        ):
            if key in payload and payload[key] not in ({}, [], None):
                metrics[key] = payload[key]
        if isinstance(payload.get("metrics"), Mapping):
            provenance["provider_timing"] = json.dumps(payload["metrics"])[:500]
    elif isinstance(payload, str) and payload.strip():
        files.append(
            ResultFile(
                name="result.txt", content=payload.encode(), media_type="text/plain"
            )
        )

    if not files:
        return raw_json_bundle(ref, tool_id, payload, tool)
    names = " ".join(file.name for file in files)
    if ".pdb" in names or ".cif" in names:
        kind = OutputKind.STRUCTURE
    elif ".fasta" in names:
        kind = OutputKind.SEQUENCE_SET
    elif ".json" in names:
        kind = OutputKind.TABLE
    return ResultBundle(
        ref=ref,
        output_kind=kind,
        files=tuple(files),
        metrics=metrics,
        provenance=provenance,
    )


RESULT_CODECS = {
    "raw-json": raw_json_bundle,
    "nvidia-biology": nvidia_biology_bundle,
}

__all__ = ["RESULT_CODECS", "nvidia_biology_bundle", "raw_json_bundle"]
