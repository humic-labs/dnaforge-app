import type { ChainSequence, ResidueLocation, Structure3dAttrs } from '../types';
import {
  canonicalJsonWithArrays,
  sha256Hex,
} from '../../../../structure-drawer/public/api/protein-identity';
import {
  mapChainResiduesToExpectedSequence,
  selectExtractedQueryChainsForStructure,
  type ChainResidueMappingUnavailableReason,
} from './structureLinkTargets';

export type ResidueIdentityRelation = 'exact' | 'substitution' | 'modified' | 'unknown';

export interface ModeledPolymerResidueDisplay {
  coordinateStatus: 'modeled';
  polymerIndex: number;
  sourceOneLetterCode: string;
  coordinateOneLetterCode: string;
  coordinateThreeLetterCode: string;
  identityRelation: ResidueIdentityRelation;
  coordinateResidue: ChainSequence['residues'][number];
  location: ResidueLocation;
}

export interface MissingPolymerResidueDisplay {
  coordinateStatus: 'missing';
  polymerIndex: number;
  sourceOneLetterCode: string;
  location: null;
}

export type PolymerResidueDisplay = ModeledPolymerResidueDisplay | MissingPolymerResidueDisplay;

export type PolymerResidueDisplayUnavailableReason =
  | ChainResidueMappingUnavailableReason
  | 'stale-revision';

export type PolymerResidueDisplayProjection =
  | {
      status: 'mapped';
      method: 'author-numbering' | 'sequence-alignment' | 'declared-empty-chain';
      sourceDigestSha256: string;
      coordinateDigestSha256: string;
      score: {
        mappedCount: number;
        matchCount: number;
        mismatchCount: number;
        coordinateCoverage: number;
        sequenceIdentity: number;
      };
      polymerLength: number;
      modeledCount: number;
      entries: PolymerResidueDisplay[];
    }
  | {
      status: 'unavailable';
      reason: PolymerResidueDisplayUnavailableReason;
    };

export interface PolymerChainResidueDisplay {
  chainKey: string;
  chain: ChainSequence;
  projection: PolymerResidueDisplayProjection;
}

export interface PolymerResidueDisplayOptions {
  expectedSourceDigestSha256?: string;
}

const STANDARD_AMINO_ACIDS = new Set([
  'ALA',
  'ARG',
  'ASN',
  'ASP',
  'CYS',
  'GLN',
  'GLU',
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
]);

export function structureChainDisplayKey(chain: ChainSequence): string {
  return [
    chain.chainId,
    chain.baseChain ?? '',
    chain.labelAsymId ?? '',
    chain.authAsymId ?? '',
    chain.entityId ?? '',
    chain.operator ?? '',
  ].join('\u0000');
}

export function createPolymerResidueDisplayProjection(
  chain: ChainSequence,
  sourceSequence: string,
  options: PolymerResidueDisplayOptions = {}
): PolymerResidueDisplayProjection {
  const normalizedSource = normalizeSequence(sourceSequence);
  const sourceDigestSha256 = sha256Hex(normalizedSource);
  if (
    options.expectedSourceDigestSha256 &&
    options.expectedSourceDigestSha256 !== sourceDigestSha256
  ) {
    return { status: 'unavailable', reason: 'stale-revision' };
  }

  const mapping = mapChainResiduesToExpectedSequence(chain, normalizedSource);
  if (mapping.status === 'unavailable') return mapping;

  const coordinateResidueQueues = coordinateResidueQueuesForChain(chain);
  const modeledByPolymerIndex = new Map<number, ModeledPolymerResidueDisplay>();
  for (const mappedResidue of mapping.residues) {
    const coordinateResidue = takeCoordinateResidue(
      coordinateResidueQueues,
      mappedResidue.position,
      mappedResidue.labelSeqId
    );
    if (!coordinateResidue) continue;

    const sourceOneLetterCode = normalizedSource[mappedResidue.residueIndex] ?? 'X';
    const coordinateOneLetterCode = normalizeOneLetterCode(coordinateResidue.name);
    const coordinateThreeLetterCode = coordinateResidue.name3.trim().toUpperCase();
    const location: ResidueLocation = {
      chain: chain.chainId,
      position: coordinateResidue.position,
      labelCompId: coordinateThreeLetterCode,
      ...(coordinateResidue.labelSeqId !== undefined
        ? { labelSeqId: coordinateResidue.labelSeqId }
        : {}),
      ...(chain.baseChain ? { baseChain: chain.baseChain } : {}),
      ...(chain.labelAsymId ? { labelAsymId: chain.labelAsymId } : {}),
      ...(chain.authAsymId ? { authAsymId: chain.authAsymId } : {}),
      ...(chain.entityId ? { entityId: chain.entityId } : {}),
      ...(chain.operator ? { operator: chain.operator } : {}),
    };
    modeledByPolymerIndex.set(mappedResidue.residueIndex, {
      coordinateStatus: 'modeled',
      polymerIndex: mappedResidue.residueIndex,
      sourceOneLetterCode,
      coordinateOneLetterCode,
      coordinateThreeLetterCode,
      identityRelation: identityRelationForResidue(
        sourceOneLetterCode,
        coordinateOneLetterCode,
        coordinateThreeLetterCode
      ),
      coordinateResidue,
      location,
    });
  }

  const entries: PolymerResidueDisplay[] = [...normalizedSource].map(
    (sourceOneLetterCode, polymerIndex) =>
      modeledByPolymerIndex.get(polymerIndex) ?? {
        coordinateStatus: 'missing',
        polymerIndex,
        sourceOneLetterCode,
        location: null,
      }
  );
  const modeledCount = entries.reduce(
    (count, entry) => count + (entry.coordinateStatus === 'modeled' ? 1 : 0),
    0
  );
  const coordinateDigestSha256 = sha256Hex(
    canonicalJsonWithArrays({
      chainKey: structureChainDisplayKey(chain),
      sequence: normalizeSequence(chain.sequence),
      residues: chain.residues.map((residue) => ({
        position: residue.position,
        labelSeqId: residue.labelSeqId ?? null,
        name: residue.name,
        name3: residue.name3,
      })),
    })
  );

  return {
    status: 'mapped',
    method: mapping.method,
    sourceDigestSha256,
    coordinateDigestSha256,
    score: {
      mappedCount: modeledCount,
      matchCount: mapping.matchCount,
      mismatchCount: mapping.mismatchCount,
      coordinateCoverage: normalizedSource.length > 0 ? modeledCount / normalizedSource.length : 0,
      sequenceIdentity: mapping.mappedCount > 0 ? mapping.matchCount / mapping.mappedCount : 0,
    },
    polymerLength: normalizedSource.length,
    modeledCount,
    entries,
  };
}

export function polymerResidueDisplayProjectionsFromExtractedQueryChains(
  attrs: Structure3dAttrs,
  chains: readonly ChainSequence[],
  sourceSequence: string,
  options: PolymerResidueDisplayOptions = {}
): PolymerChainResidueDisplay[] {
  return selectExtractedQueryChainsForStructure(attrs, chains).map((chain) => ({
    chainKey: structureChainDisplayKey(chain),
    chain,
    projection: createPolymerResidueDisplayProjection(chain, sourceSequence, options),
  }));
}

function coordinateResidueQueuesForChain(
  chain: ChainSequence
): Map<string, Array<ChainSequence['residues'][number]>> {
  const queues = new Map<string, Array<ChainSequence['residues'][number]>>();
  for (const residue of chain.residues) {
    const exactKey = coordinateResidueKey(residue.position, residue.labelSeqId);
    const exactQueue = queues.get(exactKey) ?? [];
    exactQueue.push(residue);
    queues.set(exactKey, exactQueue);
    if (residue.labelSeqId !== undefined) {
      const authorOnlyKey = coordinateResidueKey(residue.position, undefined);
      const authorOnlyQueue = queues.get(authorOnlyKey) ?? [];
      authorOnlyQueue.push(residue);
      queues.set(authorOnlyKey, authorOnlyQueue);
    }
  }
  return queues;
}

function takeCoordinateResidue(
  queues: Map<string, Array<ChainSequence['residues'][number]>>,
  position: number,
  labelSeqId: number | undefined
): ChainSequence['residues'][number] | undefined {
  const exactQueue = queues.get(coordinateResidueKey(position, labelSeqId));
  const exact = exactQueue?.shift();
  if (exact) return exact;
  return queues.get(coordinateResidueKey(position, undefined))?.shift();
}

function coordinateResidueKey(position: number, labelSeqId: number | undefined): string {
  return `${position}\u0000${labelSeqId ?? ''}`;
}

function identityRelationForResidue(
  sourceOneLetterCode: string,
  coordinateOneLetterCode: string,
  coordinateThreeLetterCode: string
): ResidueIdentityRelation {
  if (!coordinateOneLetterCode || coordinateOneLetterCode === 'X') return 'unknown';
  if (!STANDARD_AMINO_ACIDS.has(coordinateThreeLetterCode)) return 'modified';
  return sourceOneLetterCode === coordinateOneLetterCode ? 'exact' : 'substitution';
}

function normalizeSequence(sequence: string): string {
  return sequence.replace(/[^A-Za-z]/g, '').toUpperCase();
}

function normalizeOneLetterCode(value: string): string {
  const normalized = normalizeSequence(value);
  return normalized.length === 1 ? normalized : 'X';
}
