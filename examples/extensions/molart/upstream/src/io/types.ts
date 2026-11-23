/** Raw parser output shared by the PDB and mmCIF readers. */

export interface RawAtom {
  record: 'ATOM' | 'HETATM';
  name: string;
  altLoc: string; // '' when absent
  resName: string;
  chainId: string; // author chain id
  resSeq: number; // author residue number
  iCode: string; // '' when absent
  x: number;
  y: number;
  z: number;
  occupancy: number;
  bFactor: number;
  element: string;
}

export interface ResidueKey {
  chainId: string;
  resSeq: number;
  iCode: string;
}

export interface SSRange {
  type: 'H' | 'E';
  start: ResidueKey;
  end: ResidueKey;
}

export interface RawStructure {
  id: string;
  title: string;
  format: 'pdb' | 'mmcif';
  atoms: RawAtom[];
  /** Secondary-structure ranges declared in the file (HELIX/SHEET or struct_conf/struct_sheet_range). */
  ssRanges: SSRange[];
  /** Non-fatal notes produced during parsing (e.g. ignored models, altloc choices). */
  notes: string[];
}

export class StructureParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructureParseError';
  }
}
