import { MmcifFormat } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { PdbFormat } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Sequence } from 'molstar/lib/mol-model/sequence';
import type { Model } from 'molstar/lib/mol-model/structure';

export type EncodedResidueCategory = 'protein' | 'dna' | 'rna' | 'nucleotide-ambiguous' | 'unknown';
export type EncodedPolymerKind = 'protein' | 'dna' | 'rna' | 'mixed' | 'unknown';

export const POLYMER_COMPONENT_CODES: Readonly<Record<string, string>> = {
  ALA: 'A',
  ARG: 'R',
  ASN: 'N',
  ASP: 'D',
  CYS: 'C',
  GLU: 'E',
  GLN: 'Q',
  GLY: 'G',
  HIS: 'H',
  ILE: 'I',
  LEU: 'L',
  LYS: 'K',
  MET: 'M',
  PHE: 'F',
  PRO: 'P',
  SER: 'S',
  THR: 'T',
  TRP: 'W',
  TYR: 'Y',
  VAL: 'V',
  SEC: 'U',
  PYL: 'O',
  MSE: 'M',
  HYP: 'P',
  TPO: 'T',
  SEP: 'S',
  PTR: 'Y',
  MLY: 'K',
  MLZ: 'K',
  M3L: 'K',
  ALY: 'K',
  CSO: 'C',
  CSD: 'C',
  OCS: 'C',
  NEP: 'H',
  HIC: 'H',
  CGU: 'E',
  DA: 'A',
  DC: 'C',
  DG: 'G',
  DT: 'T',
  A: 'A',
  C: 'C',
  G: 'G',
  U: 'U',
};

const STANDARD_COMPONENTS = new Set([
  'ALA',
  'ARG',
  'ASN',
  'ASP',
  'CYS',
  'GLU',
  'GLN',
  'GLY',
  'HIS',
  'ILE',
  'LEU',
  'LYS',
  'MET',
  'PHE',
  'PRO',
  'SER',
  'THR',
  'TRP',
  'TYR',
  'VAL',
  'SEC',
  'PYL',
  'DA',
  'DC',
  'DG',
  'DT',
  'A',
  'C',
  'G',
  'U',
]);
const DNA_COMPONENTS = new Set(['DA', 'DC', 'DG', 'DT']);
const AMBIGUOUS_COMPONENTS = new Set(['A', 'C', 'G']);
const knownCategory = (component: string): EncodedResidueCategory =>
  DNA_COMPONENTS.has(component)
    ? 'dna'
    : component === 'U'
      ? 'rna'
      : AMBIGUOUS_COMPONENTS.has(component)
        ? 'nucleotide-ambiguous'
        : 'protein';

type SourceModel = { sourceData?: Model['sourceData'] };
type Context = {
  polymers: Set<string>;
  nonPolymers: Set<string>;
  kinds: Map<string, EncodedPolymerKind>;
  parents: Map<string, string | null>;
  pdbPolymerPositions?: Set<string>;
};
const contexts = new WeakMap<object, Context>();
const parentKey = (chain: string, position: number, component: string) =>
  JSON.stringify([chain, position, component]);
function putParent(parents: Map<string, string | null>, key: string, parent: string | null) {
  parents.set(key, parents.has(key) && parents.get(key) !== parent ? null : parent);
}

function contextFor(model: SourceModel): Context {
  const cached = contexts.get(model);
  if (cached) return cached;
  const context: Context = {
    polymers: new Set(),
    nonPolymers: new Set(),
    kinds: new Map(),
    parents: new Map(),
  };
  if (MmcifFormat.is(model.sourceData)) {
    const db = model.sourceData.data.db;
    const entityTypes = new Map<string, string>();
    const entityKinds = new Map<string, EncodedPolymerKind>();
    for (let row = 0; row < db.entity._rowCount; row++)
      entityTypes.set(db.entity.id.value(row), db.entity.type.value(row));
    for (let row = 0; row < db.entity_poly._rowCount; row++) {
      const type = db.entity_poly.type.value(row);
      const kind =
        type === 'polypeptide(L)'
          ? 'protein'
          : type === 'polyribonucleotide'
            ? 'rna'
            : type === 'polydeoxyribonucleotide'
              ? 'dna'
              : type === 'polydeoxyribonucleotide/polyribonucleotide hybrid'
                ? 'mixed'
                : 'unknown';
      entityKinds.set(db.entity_poly.entity_id.value(row), kind);
    }
    for (let row = 0; row < db.struct_asym._rowCount; row++) {
      const chain = db.struct_asym.id.value(row),
        entity = db.struct_asym.entity_id.value(row);
      const type = entityTypes.get(entity);
      if (type === 'polymer' || entityKinds.has(entity)) context.polymers.add(chain);
      else if (type) context.nonPolymers.add(chain);
      if (entityKinds.has(entity)) context.kinds.set(chain, entityKinds.get(entity)!);
    }
    const modifications = db.pdbx_struct_mod_residue;
    for (let row = 0; row < modifications._rowCount; row++) {
      const chain = modifications.label_asym_id.value(row);
      const position = modifications.label_seq_id.value(row);
      const component = modifications.label_comp_id.value(row).toUpperCase();
      if (!chain || !Number.isInteger(position) || position < 1 || !component) continue;
      const rawParent = modifications.parent_comp_id.value(row).toUpperCase().trim();
      const parent = /^[A-Z0-9]{1,10}$/.test(rawParent) ? rawParent : null;
      const key = parentKey(chain, position, component);
      putParent(context.parents, key, parent);
    }
    const original = model.sourceData.data.source;
    if (PdbFormat.is(original)) {
      context.pdbPolymerPositions = new Set();
      const authorParents = new Map<string, string | null>();
      const lines = original.data.lines;
      const authorKey = (chain: string, position: number, insertion: string, component: string) =>
        JSON.stringify([chain, position, insertion, component]);
      for (let row = 0; row < lines.count; row++) {
        const line = lines.data.substring(lines.indices[2 * row], lines.indices[2 * row + 1]);
        if (!line.startsWith('MODRES')) continue;
        const chain = line.slice(16, 17).trim(),
          rawPosition = line.slice(18, 22).trim(),
          component = line.slice(12, 15).trim().toUpperCase(),
          parent = line.slice(24, 27).trim().toUpperCase();
        if (!/^-?\d+$/.test(rawPosition) || !component) continue;
        putParent(
          authorParents,
          authorKey(chain, Number(rawPosition), line.slice(22, 23).trim(), component),
          /^[A-Z0-9]{1,10}$/.test(parent) ? parent : null
        );
      }
      const native =
        'atomicHierarchy' in model && 'entities' in model && 'sequence' in model
          ? (model as Model)
          : undefined;
      const hierarchy = native?.atomicHierarchy,
        chains = hierarchy?.chains;
      if (hierarchy && chains && native) {
        for (let row = 0; row < chains._rowCount; row++) {
          if (entityTypes.get(chains.label_entity_id.value(row)) !== 'polymer') continue;
          const entity = native.entities.getEntityIndex(chains.label_entity_id.value(row));
          const sequence = native.sequence.byEntityKey[entity]?.sequence;
          if (!sequence) continue;
          const chain = chains.label_asym_id.value(row);
          context.polymers.add(chain);
          const kind =
            sequence.kind === Sequence.Kind.RNA
              ? 'rna'
              : sequence.kind === Sequence.Kind.DNA
                ? 'dna'
                : sequence.kind === Sequence.Kind.Protein
                  ? 'protein'
                  : 'unknown';
          context.kinds.set(
            chain,
            context.kinds.has(chain) && context.kinds.get(chain) !== kind ? 'unknown' : kind
          );
        }
        const seen = new Set<string>();
        for (let atom = 0; atom < hierarchy.atoms._rowCount; atom++) {
          const chainIndex = hierarchy.chainAtomSegments.index[atom];
          if (entityTypes.get(chains.label_entity_id.value(chainIndex)) !== 'polymer') continue;
          const residue = hierarchy.residueAtomSegments.index[atom],
            chain = chains.label_asym_id.value(chainIndex),
            position = hierarchy.residues.label_seq_id.value(residue),
            component = hierarchy.atoms.label_comp_id.value(atom).toUpperCase();
          if (!Number.isInteger(position) || position < 1) continue;
          const labelKey = parentKey(chain, position, component);
          context.pdbPolymerPositions.add(labelKey);
          if (seen.has(labelKey)) continue;
          seen.add(labelKey);
          const key = authorKey(
            chains.auth_asym_id.value(chainIndex).trim(),
            hierarchy.residues.auth_seq_id.value(residue),
            hierarchy.residues.pdbx_PDB_ins_code.value(residue).trim(),
            component
          );
          if (authorParents.has(key)) putParent(context.parents, labelKey, authorParents.get(key)!);
        }
      }
    }
  }
  contexts.set(model, context);
  return context;
}

export interface EncodedResidueIdentity {
  code: string;
  category: EncodedResidueCategory;
  parentCompId?: string;
  unresolved?: string;
}

export function encodedResidueIdentity(
  model: SourceModel,
  chain: string,
  position: number | undefined,
  componentId: string
): EncodedResidueIdentity | null {
  const component = componentId.toUpperCase();
  const context = contextFor(model);
  if (context.nonPolymers.has(chain)) return null;
  if (
    context.pdbPolymerPositions &&
    (position === undefined ||
      !context.pdbPolymerPositions.has(parentKey(chain, position, component)))
  )
    return null;
  const kind = context.kinds.get(chain);
  const unresolved = (reason: string): EncodedResidueIdentity => ({
    code: kind === 'rna' || kind === 'dna' || kind === 'mixed' ? 'N' : 'X',
    category: kind === 'protein' || kind === 'rna' || kind === 'dna' ? kind : 'unknown',
    unresolved: reason,
  });
  const key = position === undefined ? null : parentKey(chain, position, component);
  const hasParent = key !== null && context.parents.has(key);
  const parent = hasParent ? context.parents.get(key!) : undefined;
  const knownCode = POLYMER_COMPONENT_CODES[component];
  if (hasParent && (!parent || !STANDARD_COMPONENTS.has(parent)))
    return unresolved('The deposited parent component is absent, ambiguous or unsupported.');
  const encodedComponent = parent ?? component;
  const code = POLYMER_COMPONENT_CODES[encodedComponent];
  if (knownCode && parent && knownCode !== code)
    return unresolved('The deposited parent contradicts the known component identity.');
  if (!code)
    return context.polymers.has(chain)
      ? unresolved('The polymer component has no supported encoded parent.')
      : null;
  let category = knownCategory(encodedComponent);
  if (category === 'nucleotide-ambiguous' && (kind === 'rna' || kind === 'dna')) category = kind;
  if ((kind === 'protein' || kind === 'rna' || kind === 'dna') && category !== kind)
    return unresolved('The component identity contradicts the deposited polymer type.');
  return { code, category, ...(parent && parent !== component ? { parentCompId: parent } : {}) };
}

export function encodedPolymerKind(
  categories: ReadonlySet<EncodedResidueCategory>
): EncodedPolymerKind {
  if (!categories.size || categories.has('unknown')) return 'unknown';
  if (categories.has('protein')) return categories.size === 1 ? 'protein' : 'unknown';
  const dna = categories.has('dna'),
    rna = categories.has('rna');
  if (dna && rna) return 'mixed';
  if (dna && categories.has('nucleotide-ambiguous')) return 'unknown';
  return dna ? 'dna' : rna ? 'rna' : 'unknown';
}

export function readEncodedPolymerChain(model: Model, chainIndex: number) {
  const chains = model.atomicHierarchy.chains;
  const chainId = chains.label_asym_id.value(chainIndex);
  return readEncodedPolymerEntity(model, chainId, chains.label_entity_id.value(chainIndex));
}

export function readEncodedPolymerEntity(model: Model, chainId: string, entityId: string) {
  const entity = model.entities.getEntityIndex(entityId);
  const sequence = model.sequence.byEntityKey[entity]?.sequence;
  if (!sequence || contextFor(model).nonPolymers.has(chainId)) return null;
  const components: string[] = [],
    positions: number[] = [],
    codes: string[] = [];
  const categories = new Set<EncodedResidueCategory>();
  const unresolved: Array<{ sequenceIndex: number; components: string[]; reason: string }> = [];
  for (let index = 0; index < sequence.length; index++) {
    const position = sequence.seqId.value(index),
      component = sequence.compId.value(index);
    const alternatives = sequence.microHet.get(position) ?? [component];
    const identities = alternatives.map((value) =>
      encodedResidueIdentity(model, chainId, position, value)
    );
    const first = identities[0];
    const reason =
      identities.find((value) => value?.unresolved)?.unresolved ??
      (!first ||
      identities.some(
        (value) => !value || value.code !== first.code || value.category !== first.category
      )
        ? 'The position has unknown or differing encoded component identities.'
        : undefined);
    components.push(component);
    positions.push(position);
    if (reason) {
      const kind = contextFor(model).kinds.get(chainId);
      codes.push(
        kind === 'rna' ||
          kind === 'dna' ||
          sequence.kind === Sequence.Kind.RNA ||
          sequence.kind === Sequence.Kind.DNA
          ? 'N'
          : 'X'
      );
      categories.add(first?.category ?? 'unknown');
      unresolved.push({ sequenceIndex: index, components: alternatives, reason });
    } else {
      codes.push(first!.code);
      categories.add(first!.category);
    }
  }
  return {
    chainId,
    kind: encodedPolymerKind(categories),
    sequence: codes.join(''),
    positions,
    components,
    unresolved,
  };
}
