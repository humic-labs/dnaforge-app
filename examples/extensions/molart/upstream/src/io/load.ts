import { parsePDB } from './pdb';
import { parseMMCIF } from './mmcif';
import { RawStructure, StructureParseError } from './types';
import { buildStructure, BuildOptions, Structure } from '../model/structure';

export type Format = 'pdb' | 'mmcif';

export function detectFormat(text: string, filename = ''): Format {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.cif') || lower.endsWith('.mmcif')) return 'mmcif';
  if (lower.endsWith('.pdb') || lower.endsWith('.ent')) return 'pdb';
  const head = text.slice(0, 4000);
  if (/^data_/m.test(head) || /^_atom_site\./m.test(text.slice(0, 200000))) return 'mmcif';
  if (/^(ATOM  |HETATM|HEADER|MODEL )/m.test(head)) return 'pdb';
  throw new StructureParseError('Unrecognised file: expected PDB (.pdb) or mmCIF (.cif/.mmcif) text.');
}

export function parseRaw(text: string, filename = ''): RawStructure {
  if (!text || !text.trim()) throw new StructureParseError('File is empty.');
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.(pdb|ent|cif|mmcif)$/i, '') || 'structure';
  return detectFormat(text, filename) === 'mmcif' ? parseMMCIF(text, base) : parsePDB(text, base);
}

/** Parse PDB/mmCIF text into an immutable Structure. Throws StructureParseError with a readable message. */
export function loadStructure(text: string, filename = '', opts: BuildOptions = {}): Structure {
  return buildStructure(parseRaw(text, filename), opts);
}
