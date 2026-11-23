import { RawAtom, RawStructure, SSRange, StructureParseError } from './types';

const col = (line: string, a: number, b: number) => line.substring(a - 1, b);

/** Parse a legacy-format PDB file. Only the first MODEL is read. */
export function parsePDB(text: string, fallbackId = 'structure'): RawStructure {
  const atoms: RawAtom[] = [];
  const ssRanges: SSRange[] = [];
  const notes: string[] = [];
  let id = '';
  let title = '';
  let modelCount = 0;
  let inFirstModel = true;
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const rec = line.substring(0, 6);
    if (rec === 'MODEL ') {
      modelCount++;
      inFirstModel = modelCount === 1;
      continue;
    }
    if (rec === 'ENDMDL') {
      if (modelCount >= 1) inFirstModel = false;
      continue;
    }
    if (rec === 'HEADER') {
      id = col(line, 63, 66).trim();
      continue;
    }
    if (rec === 'TITLE ') {
      title += (title ? ' ' : '') + col(line, 11, 80).trim();
      continue;
    }
    if (rec === 'HELIX ') {
      ssRanges.push({
        type: 'H',
        start: { chainId: col(line, 20, 20).trim(), resSeq: parseInt(col(line, 22, 25), 10), iCode: col(line, 26, 26).trim() },
        end: { chainId: col(line, 32, 32).trim(), resSeq: parseInt(col(line, 34, 37), 10), iCode: col(line, 38, 38).trim() },
      });
      continue;
    }
    if (rec === 'SHEET ') {
      ssRanges.push({
        type: 'E',
        start: { chainId: col(line, 22, 22).trim(), resSeq: parseInt(col(line, 23, 26), 10), iCode: col(line, 27, 27).trim() },
        end: { chainId: col(line, 33, 33).trim(), resSeq: parseInt(col(line, 34, 37), 10), iCode: col(line, 38, 38).trim() },
      });
      continue;
    }
    if ((rec === 'ATOM  ' || rec === 'HETATM') && inFirstModel) {
      if (line.length < 54) throw new StructureParseError(`PDB line ${li + 1}: ATOM record too short`);
      const x = parseFloat(col(line, 31, 38));
      const y = parseFloat(col(line, 39, 46));
      const z = parseFloat(col(line, 47, 54));
      const resSeq = parseInt(col(line, 23, 26), 10);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(resSeq)) {
        throw new StructureParseError(`PDB line ${li + 1}: invalid coordinates or residue number`);
      }
      const name = col(line, 13, 16).trim();
      let element = col(line, 77, 78).trim();
      if (!element) element = name.replace(/[^A-Za-z]/g, '').charAt(0);
      atoms.push({
        record: rec === 'ATOM  ' ? 'ATOM' : 'HETATM',
        name,
        altLoc: col(line, 17, 17).trim(),
        resName: col(line, 18, 20).trim(),
        chainId: col(line, 22, 22).trim(),
        resSeq,
        iCode: col(line, 27, 27).trim(),
        x,
        y,
        z,
        occupancy: parseFloat(col(line, 55, 60)) || 1,
        bFactor: parseFloat(col(line, 61, 66)) || 0,
        element: element.toUpperCase(),
      });
    }
  }
  if (modelCount > 1) notes.push(`File contains ${modelCount} models; only MODEL 1 is used.`);
  if (atoms.length === 0) throw new StructureParseError('No ATOM/HETATM records found in PDB file.');
  return { id: id || fallbackId, title, format: 'pdb', atoms, ssRanges, notes };
}
