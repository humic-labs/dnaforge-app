const UNRESOLVED_COMPONENT_IDS = new Set([
  '',
  '.',
  '?',
  'X',
  'UNK',
  'UNL',
  'XAA',
  'ASX',
  'GLX',
  'XLE',
]);
export function resolvedStructureComponentId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return UNRESOLVED_COMPONENT_IDS.has(normalized) ? null : normalized;
}

export function hasCompleteMolecularResidueIdentities(descriptor: unknown): boolean {
  if (!descriptor || typeof descriptor !== 'object') return false;
  const record = descriptor as {
    schemaVersion?: number;
    kind?: string;
    measured?: {
      residueCount: number;
      residueOmittedCount: number;
      residueIdentityKnownCount: number;
      residueIdentityUnknownCount: number;
      residueIdentityOmittedCount: number;
      residues?: unknown[];
    };
  };
  if (record.schemaVersion !== 2 || record.kind !== 'structure' || !record.measured) return false;
  const measured = record.measured;
  return (
    Number.isInteger(measured.residueCount) &&
    measured.residueCount > 0 &&
    measured.residueOmittedCount === 0 &&
    measured.residueIdentityKnownCount === measured.residueCount &&
    measured.residueIdentityUnknownCount === 0 &&
    measured.residueIdentityOmittedCount === 0 &&
    Array.isArray(measured.residues) &&
    measured.residues.length === measured.residueCount &&
    measured.residues.every((value) => {
      if (!value || typeof value !== 'object') return false;
      const residue = value as {
        chain?: unknown;
        authSeqId: number;
        identityStatus?: string;
        labelCompId?: unknown;
      };
      return (
        typeof residue.chain === 'string' &&
        residue.chain.trim().length > 0 &&
        Number.isInteger(residue.authSeqId) &&
        residue.authSeqId >= 1 &&
        residue.identityStatus === 'known' &&
        resolvedStructureComponentId(residue.labelCompId) !== null
      );
    })
  );
}
