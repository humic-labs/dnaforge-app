import { z } from 'zod';

import { useCanvasStore } from '../../canvas/public/store';
import {
  assemblyIdFromIndexedGenome,
  assemblyReferencesFromIndexedGenome,
} from '../../sequence/public/attach-indexed-bigwig';
import { useLaneContractStore } from '../../sequence/public/lane-contract-store';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import type { AlignedReadSourceGenerationV1 } from '../../../shared/aligned-read-source-generation';
import { isIndexedTab } from './indexed-current-view';

export const managedAlignmentCoverageStartSchema = z
  .object({
    assemblyId: z.string().trim().min(1).max(1024),
    trackId: z.string().trim().min(1).max(1024),
  })
  .strict();

interface PreparedAlignmentCoverage {
  readonly input: {
    readonly assemblyId: string;
    readonly bamPath: string;
    readonly indexPath: string;
    readonly referencePath?: string;
    readonly sourceGeneration: AlignedReadSourceGenerationV1;
    readonly chroms: string[];
  };
}

export function projectManagedAlignmentCoveragePreparation(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const value = result as Partial<PreparedAlignmentCoverage> & { error?: unknown };
  if (
    !value.input ||
    typeof value.input.assemblyId !== 'string' ||
    !Array.isArray(value.input.chroms)
  ) {
    return typeof value.error === 'string' ? { error: value.error } : {};
  }
  return {
    input: {
      assemblyId: value.input.assemblyId,
      chromCount: value.input.chroms.length,
    },
  };
}

export function createPrepareManagedAlignmentCoverageTool() {
  return resultTool({
    description:
      'Start durable overview-coverage preparation for one mounted BAM or CRAM track. ' +
      'Returns the managed job immediately so it can be followed in Jobs, the API, the CLI, ' +
      'or agent tools.',
    inputSchema: managedAlignmentCoverageStartSchema,
    execute: async ({ assemblyId, trackId }) => {
      const candidates = Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
        panel.tabs.flatMap((tab) => {
          if (!isIndexedTab(tab)) return [];
          if (assemblyIdFromIndexedGenome(tab.indexedGenome) !== assemblyId) return [];
          const lane = useLaneContractStore
            .getState()
            .lanesForOwner(tab.id)
            .find(
              (candidate) =>
                candidate.assemblyId === assemblyId && candidate.dataset.trackId === trackId
            );
          return lane ? [{ tab, lane }] : [];
        })
      );

      if (candidates.length === 0) {
        return preparationFailure(
          'ALIGNMENT_TRACK_NOT_FOUND',
          'No mounted aligned-read track matches that assembly and track identity.'
        );
      }

      const prepared = candidates.map(({ tab, lane }) => {
        const source = lane.dataset.kind === 'pileup' ? lane.dataset.source : undefined;
        const chroms = assemblyReferencesFromIndexedGenome(tab.indexedGenome).map(
          (reference) => reference.name
        );
        if (
          !source ||
          source.admissionError ||
          !source.indexPath ||
          !source.generation ||
          chroms.length === 0
        ) {
          return null;
        }
        return {
          assemblyId,
          bamPath: source.bamPath,
          indexPath: source.indexPath,
          ...(source.referencePath ? { referencePath: source.referencePath } : {}),
          sourceGeneration: source.generation,
          chroms,
        };
      });
      if (prepared.some((value) => value === null)) {
        return preparationFailure(
          'ALIGNMENT_TRACK_NOT_ADMITTED',
          'The aligned-read track is missing its exact source generation or assembly references.'
        );
      }

      const first = prepared[0];
      if (!first) {
        return preparationFailure(
          'ALIGNMENT_TRACK_NOT_FOUND',
          'No mounted aligned-read track matches that assembly and track identity.'
        );
      }
      if (prepared.some((value) => JSON.stringify(value) !== JSON.stringify(first))) {
        return preparationFailure(
          'ALIGNMENT_TRACK_AMBIGUOUS',
          'More than one mounted track matches those identities with different sources.'
        );
      }
      return toolSuccess({ input: first });
    },
  });
}

function preparationFailure(code: string, error: string) {
  return toolFailure({
    code,
    error,
    retriable: false,
    stateChanged: false,
    partialEffects: [],
  });
}
