# DNAForge Structure MCP Tools

This bundle documents the Mol\* MCP surface exposed by the desktop renderer.

Typical flow:

1. Call `seq_list_annotations` for an open GenBank sequence.
2. Pick a CDS `rawIndex`.
3. Call `mol_open_drawer` with `sequencePath` and `annotationIndex`, or call
   `mol_open_tab` directly with a PDB/UniProt source.
4. Use `mol_get_state`, `mol_set_representation`, `mol_set_color`,
   `mol_select_residues`, and `mol_focus` against the returned `viewerId`.
5. Call `mol_capture_screenshot` when visual evidence is needed.

The MCP companion returns screenshots as image content and keeps the full domain
result in `structuredContent` for auditability. Sidecar job metadata is
transport state under `_meta["com.dnaforge/job"]`, not part of the tool's
advertised output schema.
