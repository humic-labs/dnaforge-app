import type { AdmittedTrackSource } from './admitted-track-source';
import type { ScientificTrackKind } from './scientific-track-kind';

export type GenomicRegionalAccess =
  | 'none'
  | 'internal-index'
  | 'companion-index'
  | 'managed-index'
  | 'service'
  | 'admitted-reader';

export type GenomicQuantitativeMeaning =
  | 'unknown'
  | 'raw-read-depth'
  | 'normalized-coverage'
  | 'enrichment'
  | 'significance'
  | 'fraction'
  | 'other';

export interface GenomicViewSource {
  readonly id: string;
  readonly assemblyId: string;
  readonly scientificKind: ScientificTrackKind;
  readonly formatId?: string;
  readonly regionalAccess: GenomicRegionalAccess;
  readonly quantitativeMeaning?: GenomicQuantitativeMeaning;
}

export type GenomicViewRole = 'signal' | 'reads';
export type GenomicViewTypeId =
  | 'quantitative-signal'
  | 'regional-reads'
  | 'signal-with-read-evidence'
  | 'signal-read-pileup-v1';
type RoleCardinality = 'required' | 'optional' | 'forbidden';

export interface GenomicViewTypeDefinition {
  readonly id: GenomicViewTypeId;
  readonly roles: Readonly<Record<GenomicViewRole, RoleCardinality>>;
  readonly previewFidelity: 'not-applicable' | 'approximate';
}

export const GENOMIC_VIEW_TYPES: Readonly<Record<GenomicViewTypeId, GenomicViewTypeDefinition>> = {
  'quantitative-signal': {
    id: 'quantitative-signal',
    roles: { signal: 'required', reads: 'forbidden' },
    previewFidelity: 'not-applicable',
  },
  'regional-reads': {
    id: 'regional-reads',
    roles: { signal: 'forbidden', reads: 'required' },
    previewFidelity: 'not-applicable',
  },
  'signal-with-read-evidence': {
    id: 'signal-with-read-evidence',
    roles: { signal: 'required', reads: 'optional' },
    previewFidelity: 'approximate',
  },
  'signal-read-pileup-v1': {
    id: 'signal-read-pileup-v1',
    roles: { signal: 'required', reads: 'required' },
    previewFidelity: 'approximate',
  },
};

export interface GenomicViewBinding {
  readonly type: GenomicViewTypeId;
  readonly assemblyId: string;
  readonly boundRoles: readonly GenomicViewRole[];
  readonly previewFidelity: GenomicViewTypeDefinition['previewFidelity'];
}

export function genomicViewSourceFromAdmission(
  id: string,
  source: AdmittedTrackSource
): GenomicViewSource {
  const compatible =
    source.referenceReceipt.status === 'compatible' &&
    source.referenceReceipt.assemblyId === source.assemblyId;
  let regionalAccess: GenomicRegionalAccess = 'none';
  if (compatible && source.readerKind === 'bbi' && source.formatId === 'bigwig') {
    regionalAccess = 'internal-index';
  } else if (compatible && source.readerKind === 'bam' && source.scientificKind === 'reads') {
    if (source.request?.source.kind === 'htsget' || source.provenance.provider === 'htsget') {
      regionalAccess = 'service';
    } else if (source.alignedReadIndexState === 'created') {
      regionalAccess = 'managed-index';
    } else if (source.alignedReadIndexState === 'present' || source.index) {
      regionalAccess = 'companion-index';
    }
  }
  return {
    id,
    assemblyId: source.assemblyId,
    scientificKind: source.scientificKind,
    formatId: source.formatId,
    regionalAccess,
  };
}

export function requireGenomicViewBinding(
  type: GenomicViewTypeId,
  sources: Readonly<Partial<Record<GenomicViewRole, GenomicViewSource>>>
): GenomicViewBinding {
  const definition = GENOMIC_VIEW_TYPES[type];
  const boundRoles: GenomicViewRole[] = [];
  const sourceIds = new Set<string>();
  let assemblyId: string | null = null;
  for (const role of ['signal', 'reads'] as const) {
    const source = sources[role];
    const cardinality = definition.roles[role];
    if (!source) {
      if (cardinality === 'required') throw new Error(`${type} requires ${role}.`);
      continue;
    }
    if (cardinality === 'forbidden') throw new Error(`${type} does not accept ${role}.`);
    if (!source.id || !source.assemblyId) {
      throw new Error(`${role} source needs a stable ID and reference assembly.`);
    }
    if (sourceIds.has(source.id)) throw new Error('View roles need distinct source IDs.');
    sourceIds.add(source.id);
    if (assemblyId !== null && assemblyId !== source.assemblyId) {
      throw new Error('View sources must use the same reference assembly.');
    }
    assemblyId = source.assemblyId;
    if (role === 'signal' && source.scientificKind !== 'quantitative') {
      throw new Error('The signal role requires quantitative data.');
    }
    if (role === 'reads' && source.scientificKind !== 'reads') {
      throw new Error('The reads role requires aligned reads.');
    }
    if (source.regionalAccess === 'none') {
      throw new Error(`The ${role} source has no working regional access.`);
    }
    if (type === 'signal-read-pileup-v1') {
      if (role === 'signal' && source.formatId !== 'bigwig') {
        throw new Error('The legacy signal-to-reads view requires a quantitative BigWig.');
      }
      if (role === 'reads' && source.formatId !== 'bam' && source.formatId !== 'cram') {
        throw new Error('The legacy signal-to-reads view requires BAM or CRAM reads.');
      }
    }
    boundRoles.push(role);
  }
  return {
    type,
    assemblyId: assemblyId!,
    boundRoles,
    previewFidelity: definition.previewFidelity,
  };
}
