import { create } from 'zustand';

export interface StructureLinkResidueTarget {
  chain: string;
  baseChain?: string;
  labelAsymId?: string;
  authAsymId?: string;
  entityId?: string;
  operator?: string;
  residueMappingKind?: 'identity';
  residues?: StructureLinkResiduePosition[];
}

export interface StructureLinkResiduePosition {
  residueIndex: number;
  position: number;
  labelSeqId?: number;
}

export interface StructureLinkResidueMolecule {
  moleculeId: string;
  moleculeKind: string;
  label?: string;
}

export interface StructureLinkEntry {
  structureId: string;
  bindingId?: string;
  structureViewId?: string;
  ownerId?: string;
  sequenceDocumentId: string;
  cdsLabel: string;
  cdsFeatureId?: string;
  translation: string;
  cdsStart?: number;
  cdsEnd?: number;
  strand?: 1 | -1;
  residueTarget?: StructureLinkResidueTarget;
  residueTargets?: StructureLinkResidueTarget[];
  residueMolecule?: StructureLinkResidueMolecule;
}

export interface StructureCodingBounds {
  cdsStart: number;
  cdsEnd: number;
  strand: 1 | -1;
}
export function hasStructureCodingBounds<
  T extends Pick<StructureLinkEntry, 'cdsStart' | 'cdsEnd' | 'strand' | 'residueMolecule'>,
>(link: T): link is T & StructureCodingBounds {
  return (
    Number.isInteger(link.cdsStart) &&
    Number.isInteger(link.cdsEnd) &&
    (link.strand === 1 || link.strand === -1) &&
    (!link.residueMolecule || link.residueMolecule.moleculeKind === 'translated-cds')
  );
}

interface StructureLinkRegistryState {
  links: Record<string, StructureLinkEntry>;

  registerLink(entry: StructureLinkEntry): void;
  unregisterLink(structureId: string, ownerId?: string): void;
  getLink(structureId: string, ownerId?: string): StructureLinkEntry | undefined;
  getLinksBySequenceDocument(documentId: string): StructureLinkEntry[];
}

export function structureLinkRegistryKey(structureId: string, ownerId?: string): string {
  return ownerId ? `${structureId}\u0000owner\u0000${ownerId}` : structureId;
}

export const useStructureLinkRegistry = create<StructureLinkRegistryState>((set, get) => ({
  links: {},

  registerLink(entry) {
    set((state) => {
      const key = structureLinkRegistryKey(entry.structureId, entry.ownerId);
      const existing = state.links[key];
      if (
        existing &&
        existing.bindingId === entry.bindingId &&
        existing.structureViewId === entry.structureViewId &&
        existing.ownerId === entry.ownerId &&
        existing.sequenceDocumentId === entry.sequenceDocumentId &&
        existing.cdsLabel === entry.cdsLabel &&
        existing.cdsFeatureId === entry.cdsFeatureId &&
        existing.translation === entry.translation &&
        existing.cdsStart === entry.cdsStart &&
        existing.cdsEnd === entry.cdsEnd &&
        existing.strand === entry.strand &&
        sameResidueTarget(existing.residueTarget, entry.residueTarget) &&
        sameResidueTargets(existing.residueTargets, entry.residueTargets) &&
        sameResidueMolecule(existing.residueMolecule, entry.residueMolecule)
      ) {
        return state;
      }
      return {
        links: {
          ...state.links,
          [key]: entry,
        },
      };
    });
  },

  unregisterLink(structureId, ownerId) {
    set((state) => {
      if (ownerId === undefined) {
        let changed = false;
        const rest: Record<string, StructureLinkEntry> = {};
        for (const [key, entry] of Object.entries(state.links)) {
          if (entry.structureId === structureId) {
            changed = true;
            continue;
          }
          rest[key] = entry;
        }
        return changed ? { links: rest } : state;
      }
      const key = structureLinkRegistryKey(structureId, ownerId);
      if (!(key in state.links)) return state;
      const rest = { ...state.links };
      delete rest[key];
      return { links: rest };
    });
  },

  getLink(structureId, ownerId) {
    if (ownerId) {
      return get().links[structureLinkRegistryKey(structureId, ownerId)];
    }
    return get().links[structureId];
  },

  getLinksBySequenceDocument(documentId) {
    const seen = new Set<string>();
    const links: StructureLinkEntry[] = [];
    for (const link of Object.values(get().links)) {
      if (link.sequenceDocumentId !== documentId) continue;
      const key = structureLinkRegistryKey(link.structureId, link.ownerId);
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(link);
    }
    return links;
  },
}));

function sameResidueTarget(
  left: StructureLinkResidueTarget | undefined,
  right: StructureLinkResidueTarget | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.chain === right.chain &&
    left.baseChain === right.baseChain &&
    left.labelAsymId === right.labelAsymId &&
    left.authAsymId === right.authAsymId &&
    left.entityId === right.entityId &&
    left.operator === right.operator &&
    left.residueMappingKind === right.residueMappingKind &&
    sameResiduePositions(left.residues, right.residues)
  );
}

function sameResidueTargets(
  left: readonly StructureLinkResidueTarget[] | undefined,
  right: readonly StructureLinkResidueTarget[] | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((target, index) => sameResidueTarget(target, right[index]));
}

function sameResidueMolecule(
  left: StructureLinkResidueMolecule | undefined,
  right: StructureLinkResidueMolecule | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.moleculeId === right.moleculeId &&
    left.moleculeKind === right.moleculeKind &&
    left.label === right.label
  );
}

function sameResiduePositions(
  left: readonly StructureLinkResiduePosition[] | undefined,
  right: readonly StructureLinkResiduePosition[] | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every(
    (entry, index) =>
      entry.residueIndex === right[index].residueIndex &&
      entry.position === right[index].position &&
      entry.labelSeqId === right[index].labelSeqId
  );
}
