import { RawStructure, StructureParseError } from '../io/types';
import { assignSecondaryStructure, SSSource } from './ss';

export type SS = 'H' | 'E' | 'C';
export type ResidueKind = 'protein' | 'nucleic';

export interface Residue {
  readonly index: number;
  readonly chainIndex: number;
  readonly chainId: string;
  readonly resSeq: number;
  readonly iCode: string;
  readonly name: string;
  /** 'protein' (amino acid) or 'nucleic' (DNA / RNA nucleotide). */
  readonly kind: ResidueKind;
  /** Atom indices (-1 if absent). */
  readonly n: number;
  /** The trace atom the cartoon runs through: CA for amino acids; P (else O5', C4') for nucleotides. */
  readonly ca: number;
  readonly c: number;
  readonly o: number;
  /** Atoms of this residue as a range [atomStart, atomEnd) into the atom arrays (file order). */
  readonly atomStart: number;
  readonly atomEnd: number;
  readonly ss: SS;
}

export interface Chain {
  readonly index: number;
  readonly id: string;
  /** [start, end) into residues. */
  readonly residueStart: number;
  readonly residueEnd: number;
}

export interface Structure {
  readonly id: string;
  readonly title: string;
  readonly format: 'pdb' | 'mmcif';
  /** Atom coordinates exactly as parsed (x,y,z interleaved). Never mutated by molart. */
  readonly coords: Float64Array;
  readonly atomNames: readonly string[];
  readonly atomElements: readonly string[];
  readonly atomAltLocs: readonly string[];
  /** Polymer residues in file order: amino acids (with a CA) and nucleotides (with a backbone trace atom). */
  readonly residues: readonly Residue[];
  readonly chains: readonly Chain[];
  readonly ssSource: SSSource;
  /** True when the protein part has CA atoms only (no N/C/O backbone). */
  readonly caOnly: boolean;
  readonly notes: readonly string[];
}

const AMINO = new Set(
  'ALA ARG ASN ASP CYS GLN GLU GLY HIS ILE LEU LYS MET PHE PRO SER THR TRP TYR VAL SEC PYL MSE ASX GLX UNK HYP MLY SEP TPO PTR CSO CME KCX LLP'.split(' '),
);

const NUCLEIC = new Set('A C G U T I N DA DC DG DT DU DI DN'.split(' '));
/** Longest distance (Å) between the trace atoms of two linked nucleotides. */
export const NUCLEIC_LINK = 8.5;

export interface BuildOptions {
  /** 'auto' (file records when present, else computed), 'file', or 'computed'. */
  ss?: 'auto' | 'file' | 'computed';
}

/** Build the immutable molecular model from raw parser output. */
export function buildStructure(raw: RawStructure, opts: BuildOptions = {}): Structure {
  const notes = [...raw.notes];
  // --- alternate locations: keep blank altLoc plus the first altLoc seen per residue ---
  const chosenAlt = new Map<string, string>();
  const keep: number[] = [];
  let altDropped = 0;
  raw.atoms.forEach((a, i) => {
    if (!a.altLoc) return keep.push(i);
    const key = `${a.chainId}|${a.resSeq}|${a.iCode}`;
    const ch = chosenAlt.get(key);
    if (ch === undefined) {
      chosenAlt.set(key, a.altLoc);
      keep.push(i);
    } else if (ch === a.altLoc) keep.push(i);
    else altDropped++;
  });
  if (altDropped) notes.push(`Alternate locations: kept the first altLoc per residue, ignored ${altDropped} atoms.`);

  const coords = new Float64Array(keep.length * 3);
  const atomNames: string[] = [];
  const atomElements: string[] = [];
  const atomAltLocs: string[] = [];
  keep.forEach((ai, k) => {
    const a = raw.atoms[ai];
    coords[3 * k] = a.x;
    coords[3 * k + 1] = a.y;
    coords[3 * k + 2] = a.z;
    atomNames.push(a.name);
    atomElements.push(a.element);
    atomAltLocs.push(a.altLoc);
  });

  // --- residues ---
  type Proto = { chainId: string; resSeq: number; iCode: string; name: string; n: number; ca: number; c: number; o: number; atom: boolean; first: number; last: number; p: number; o5: number; c4: number; c1: number; kind?: ResidueKind };
  const protos: Proto[] = [];
  let cur: Proto | null = null;
  keep.forEach((ai, k) => {
    const a = raw.atoms[ai];
    if (!cur || cur.chainId !== a.chainId || cur.resSeq !== a.resSeq || cur.iCode !== a.iCode || cur.name !== a.resName) {
      cur = { chainId: a.chainId, resSeq: a.resSeq, iCode: a.iCode, name: a.resName, n: -1, ca: -1, c: -1, o: -1, atom: a.record === 'ATOM', first: k, last: k, p: -1, o5: -1, c4: -1, c1: -1 };
      protos.push(cur);
    }
    cur.last = k;
    if (a.name === 'N' && cur.n < 0) cur.n = k;
    else if (a.name === 'CA' && cur.ca < 0 && a.element !== 'CA') cur.ca = k;
    else if (a.name === 'C' && cur.c < 0) cur.c = k;
    else if ((a.name === 'O' || a.name === 'OT1') && cur.o < 0) cur.o = k;
    else if (a.name === 'P' && cur.p < 0) cur.p = k;
    else {
      const nm = a.name.replace('*', "'");   // old files write C4* for C4'
      if (nm === "O5'" && cur.o5 < 0) cur.o5 = k;
      else if (nm === "C4'" && cur.c4 < 0) cur.c4 = k;
      else if (nm === "C1'" && cur.c1 < 0) cur.c1 = k;
    }
  });
  const dist = (a: number, b: number) => Math.hypot(coords[3 * a] - coords[3 * b], coords[3 * a + 1] - coords[3 * b + 1], coords[3 * a + 2] - coords[3 * b + 2]);
  for (const p of protos) {
    if (p.ca >= 0 && (AMINO.has(p.name) || (p.atom && p.n >= 0 && p.c >= 0))) p.kind = 'protein';
    else if (p.ca < 0 && (NUCLEIC.has(p.name) || (p.c1 >= 0 && p.c4 >= 0))) {
      const trace = p.p >= 0 ? p.p : p.o5 >= 0 ? p.o5 : p.c4;
      if (trace >= 0) {
        p.kind = 'nucleic';
        p.ca = trace;
      }
    }
  }
  // a nucleotide that is not part of a strand (ATP, a cofactor, a free nucleoside) is a ligand, not a polymer residue
  const nucleic = protos.filter((p) => p.kind === 'nucleic');
  nucleic.forEach((p, i) => {
    const linked = (q?: Proto) => !!q && q.chainId === p.chainId && dist(p.ca, q.ca) < NUCLEIC_LINK;
    if (!linked(nucleic[i - 1]) && !linked(nucleic[i + 1])) p.kind = undefined;
  });
  const protein = protos.filter((p) => p.kind !== undefined);
  if (protein.length === 0) throw new StructureParseError('No protein or nucleic acid residues found.');

  const chains: Chain[] = [];
  const chainIndexOf: number[] = [];
  protein.forEach((p, i) => {
    const last = chains[chains.length - 1];
    if (!last || last.id !== p.chainId || protein[i - 1].chainId !== p.chainId || protein[i - 1].kind !== p.kind) {
      if (last) (last as { residueEnd: number }).residueEnd = i;
      chains.push({ index: chains.length, id: p.chainId, residueStart: i, residueEnd: protein.length });
    }
    chainIndexOf.push(chains.length - 1);
  });

  const amino = protein.map((p, i) => (p.kind === 'protein' ? i : -1)).filter((i) => i >= 0);
  const withBackbone = amino.filter((i) => protein[i].n >= 0 && protein[i].c >= 0 && protein[i].o >= 0).length;
  const caOnly = amino.length > 0 && withBackbone < amino.length * 0.5;
  const nNucleic = protein.length - amino.length;
  if (nNucleic) notes.push(`${nNucleic} nucleotide(s): the backbone is drawn through the phosphorus atoms, each base as a slab from the backbone to its N1 (purine) or N3 (pyrimidine) atom.`);
  if (caOnly) notes.push('CA-only (or mostly CA-only) structure: ribbon orientation and secondary structure are inferred from CA geometry.');

  // --- secondary structure ---
  const ssMode = opts.ss ?? 'auto';
  // (amino acids only; nucleotides carry no secondary-structure class)
  const ss: SS[] = protein.map(() => 'C');
  let source: SSSource = 'none';
  if (amino.length) {
    const r = assignSecondaryStructure(amino.map((i) => protein[i]), amino.map((i) => chainIndexOf[i]), coords, raw.ssRanges, ssMode, caOnly);
    amino.forEach((i, k) => (ss[i] = r.ss[k]));
    source = r.source;
    notes.push(...r.notes);
  }

  const residues: Residue[] = protein.map((p, i) =>
    Object.freeze({
      index: i,
      chainIndex: chainIndexOf[i],
      chainId: p.chainId,
      resSeq: p.resSeq,
      iCode: p.iCode,
      name: p.name,
      kind: p.kind!,
      n: p.n,
      ca: p.ca,
      c: p.c,
      o: p.o,
      atomStart: p.first,
      atomEnd: p.last + 1,
      ss: ss[i],
    }),
  );

  return Object.freeze({
    id: raw.id,
    title: raw.title,
    format: raw.format,
    coords,
    atomNames: Object.freeze(atomNames),
    atomElements: Object.freeze(atomElements),
    atomAltLocs: Object.freeze(atomAltLocs),
    residues: Object.freeze(residues),
    chains: Object.freeze(chains.map((c) => Object.freeze(c))),
    ssSource: source,
    caOnly,
    notes: Object.freeze(notes),
  });
}

/** FNV-1a hash over the raw coordinate bytes: used to prove coordinates never change. */
export function coordinateFingerprint(s: Structure): string {
  const bytes = new Uint8Array(s.coords.buffer, s.coords.byteOffset, s.coords.byteLength);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[bytes.length - 1 - i], 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function residueLabel(r: Residue): string {
  return `${r.chainId || '_'}:${r.name}${r.resSeq}${r.iCode}`;
}
