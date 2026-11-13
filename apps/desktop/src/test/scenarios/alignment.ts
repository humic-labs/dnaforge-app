import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import { sha256Hex } from '../../shared/sha256-sync';
import REFERENCE_GENBANK from '../../features/alignment-manager/__tests__/__fixtures__/staleness-detection/reference.gb?raw';
import QUERY_VARIANT_GENBANK from '../../features/alignment-manager/__tests__/__fixtures__/staleness-detection/reference-with-substitutions.gb?raw';
import { sidecarScenarios } from './sidecar';
import type { AppScenario } from './types';

const REFERENCE = parseGenBankFull(REFERENCE_GENBANK);
const QUERY_VARIANT = parseGenBankFull(QUERY_VARIANT_GENBANK);

export const ALIGNMENT_STALE_REFERENCE_PATH = '/mock/test/workspace/puc19-reference.gb';
export const ALIGNMENT_STALE_DOCUMENT_ID = 'fixture:sequence:alignment-stale-puc19';
export const ALIGNMENT_STALE_QUERY_DOCUMENT_ID = 'fixture:sequence:alignment-stale-query';
export const ALIGNMENT_STALE_QUERY_PATH =
  '/mock/test/workspace/puc19-reference-with-substitutions.gb';
export const ALIGNMENT_STALE_SESSION_ID = 'alignment-stale-session';
export const ALIGNMENT_STALE_TRACK_ID = 'alignment-stale-track';

export const ALIGNMENT_STALE_REFERENCE_SEQUENCE = REFERENCE.sequence.toUpperCase();
export const ALIGNMENT_STALE_QUERY_SEQUENCE = QUERY_VARIANT.sequence.toUpperCase();
export const ALIGNMENT_STALE_MUTATIONS = findSubstitutions(
  ALIGNMENT_STALE_REFERENCE_SEQUENCE,
  ALIGNMENT_STALE_QUERY_SEQUENCE
);

function findSubstitutions(referenceSequence: string, querySequence: string) {
  if (referenceSequence.length !== querySequence.length) {
    throw new Error('staleAlignmentSession expects same-length substitution fixtures');
  }

  const mutations = [];
  for (let index = 0; index < referenceSequence.length; index++) {
    const referenceBase = referenceSequence[index];
    const alternateBase = querySequence[index];
    if (referenceBase === alternateBase) continue;
    mutations.push({
      id: `puc19-substitution-${index + 1}`,
      position: index + 1,
      type: 'substitution' as const,
      referenceBase,
      alternateBase,
      length: 1,
    });
  }
  return mutations;
}

function alignmentReferenceSequence(): AnnotatedSequence {
  return {
    ...REFERENCE,
    id: 'alignment-staleness-reference',
    name: 'pUC19 reference',
  };
}

export function staleAlignmentSession(
  options: { isStale?: boolean; staleSessionIds?: string[] } = {}
): AppScenario {
  const isStale = options.isStale ?? true;
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
  const identity =
    ((ALIGNMENT_STALE_REFERENCE_SEQUENCE.length - ALIGNMENT_STALE_MUTATIONS.length) /
      ALIGNMENT_STALE_REFERENCE_SEQUENCE.length) *
    100;

  return {
    sidecar: sidecarScenarios.fullyReady(),
    workspace: {
      folders: [{ path: '/mock/test/workspace', name: 'workspace' }],
      selectedPath: '/mock/test/workspace',
    },
    canvas: {
      tabs: [
        {
          type: 'sequence',
          entityId: ALIGNMENT_STALE_DOCUMENT_ID,
          label: 'pUC19 reference',
          sequenceDocument: {
            kind: 'catalog-sequence',
            entityId: ALIGNMENT_STALE_DOCUMENT_ID,
          },
        },
      ],
      activeTabIndex: 0,
    },
    sequences: {
      [ALIGNMENT_STALE_DOCUMENT_ID]: alignmentReferenceSequence(),
    },
    sequenceSources: {
      [ALIGNMENT_STALE_DOCUMENT_ID]: {
        sourcePath: ALIGNMENT_STALE_REFERENCE_PATH,
        name: 'pUC19 reference',
      },
      [ALIGNMENT_STALE_QUERY_DOCUMENT_ID]: {
        sourcePath: ALIGNMENT_STALE_QUERY_PATH,
        name: 'pUC19 reference with substitutions',
      },
    },
    files: {
      [ALIGNMENT_STALE_REFERENCE_PATH]: REFERENCE_GENBANK,
      [ALIGNMENT_STALE_QUERY_PATH]: QUERY_VARIANT_GENBANK,
    },
    alignment: {
      documentId: ALIGNMENT_STALE_DOCUMENT_ID,
      sourcePath: ALIGNMENT_STALE_REFERENCE_PATH,
      isStale,
      staleSessionIds: options.staleSessionIds ?? (isStale ? [ALIGNMENT_STALE_SESSION_ID] : []),
      storedChecksum: isStale
        ? 'stale-fixture-old-reference-checksum'
        : `sha256:${sha256Hex(REFERENCE_GENBANK)}`,
      activeSessionId: ALIGNMENT_STALE_SESSION_ID,
      sessions: [
        {
          id: ALIGNMENT_STALE_SESSION_ID,
          name: 'Stale verification run',
          mode: 'one-per-clone',
          tracks: [
            {
              id: ALIGNMENT_STALE_TRACK_ID,
              queryPath: ALIGNMENT_STALE_QUERY_PATH,
              label: 'pUC19 substitution variant',
              alignment: {
                alignedReference: ALIGNMENT_STALE_REFERENCE_SEQUENCE,
                alignedQuery: ALIGNMENT_STALE_QUERY_SEQUENCE,
                identity,
                coverageStart: 1,
                coverageEnd: ALIGNMENT_STALE_REFERENCE_SEQUENCE.length,
                algorithm: 'minimap2',
              },
              mutations: ALIGNMENT_STALE_MUTATIONS,
              status: 'variants',
              alignedAt: now,
            },
          ],
        },
      ],
    },
  };
}
