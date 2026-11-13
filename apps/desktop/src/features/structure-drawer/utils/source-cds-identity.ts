import type { StructureDrawerRequest } from '../types/structure-drawer';

export interface SourceCdsIdentity {
  type: 'CDS';
  name: string;
  start: number;
  end: number;
  direction: 1 | -1;
}

export function sourceCdsIdentityForRequest(
  request: StructureDrawerRequest | null | undefined,
  sequenceDocumentId: string
): SourceCdsIdentity | null {
  if (!request?.cdsBounds || request.entityId !== sequenceDocumentId) return null;

  return {
    type: 'CDS',
    name: request.cdsLabel ?? 'CDS',
    start: request.cdsBounds.cdsStart + 1,
    end: request.cdsBounds.cdsEnd + 1,
    direction: request.cdsBounds.strand,
  };
}
