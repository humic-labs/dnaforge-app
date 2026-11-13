# DNAForge Structure MCP Skill

Use these tools when an agent needs to inspect or control Mol\* protein
structures inside DNAForge.

## Tools

- `seq_list_annotations`: list annotations in an open sequence tab. Use this
  first to find CDS `rawIndex` values for structure drawer work.
- `mol_open_drawer`: open the protein structure drawer for a CDS annotation by
  `sequencePath` and `annotationIndex`.
- `mol_open_tab`: open a standalone Mol\* structure tab from PDB, UniProt,
  allow-listed URL, or inline PDB/mmCIF data.
- `mol_list_structures` and `mol_get_state`: inspect registered structure tabs
  and current view settings.
- `mol_set_representation` and `mol_set_color`: update the visible structure
  representation and color mode.
- `mol_select_residues` and `mol_focus`: apply PyMOL-style selections to an
  active viewer.
- `mol_capture_screenshot`: return the current Mol\* canvas as MCP image
  content.

## Operating Rules

1. Prefer `seq_list_annotations` before `mol_open_drawer`; do not guess
   annotation indexes.
2. Treat `viewerId` as the source key returned by `mol_open_tab` or
   `mol_list_structures`, for example `pdb:1TUP` or `af:P0AD86`.
3. Use PyMOL-style selections for residue operations, for example
   `chain A and resi 42-55`.
4. If a tool reports `PLUGIN_NOT_READY` or `VIEWER_NOT_FOUND`, re-list
   structures and wait for the viewer to finish loading before retrying.
