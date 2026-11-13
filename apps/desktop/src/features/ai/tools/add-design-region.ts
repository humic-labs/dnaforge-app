   
                                                                              
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import type { Annotation } from '@waypoint/sequence-utils';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { extractDesignAnnotationsForRange } from '../../design/public/annotation-transfer';
import { isGoldenGateSchemaStructureLocked } from '../../design/public/golden-gate-schema';
import { useDesignStore } from '../../design/public/store';
import { createDesignMutationClaim } from './agent-mutation';
import { loadSequenceDocumentBiologyFile } from './path-utils';
import type { BiologyFeature } from './parse-biology-file';

export function addDesignRegionSchemaForFolders(_folders: WorkspaceFolder[]) {
  return z
    .object({
      designId: z.string().min(1).describe('Existing design id returned by create_design.'),
      documentId: z.string().min(1).describe('Stable package/catalog source sequence document ID.'),
      start: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('1-indexed inclusive source start coordinate. Defaults to the first base.'),
      end: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('1-indexed inclusive source end coordinate. Defaults to the last base.'),
      wraps: z
        .boolean()
        .optional()
        .describe('Set true when the selected circular range crosses the origin.'),
      label: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'Display name for the added design region. Defaults to the source sequence name.'
        ),
    })
    .strict();
}

export const addDesignRegionSchema = addDesignRegionSchemaForFolders([]);

export function createAddDesignRegionTool(folders: WorkspaceFolder[]) {
  const inputSchema = addDesignRegionSchemaForFolders(folders);

  return resultTool({
    description:
      'Add a source sequence range to an existing DNAForge design. ' +
      'The stable source document may belong to any open project; do not copy it or infer a project-boundary rejection. ' +
      'Use this after create_design when composing derivative plasmids from project sequences. ' +
      'Coordinates are 1-indexed and inclusive, matching GenBank feature coordinates.',
    inputSchema: inputSchema as z.ZodTypeAny,
    execute: async (
      { designId, documentId, start, end, wraps, label }: z.infer<typeof inputSchema>,
      context?: { toolCallId?: string }
    ) =>
      runDesignTool('ADD_DESIGN_REGION_FAILED', async (effects) => {
        try {
          const store = useDesignStore.getState();
          const design = store.designs[designId];
          if (!design) {
            return designToolFailure(
              'ADD_DESIGN_REGION_FAILED',
              {
                designId,
                regionId: null,
                error: `Design not found: ${designId}`,
              },
              effects
            );
          }
          if (isGoldenGateSchemaStructureLocked(design.goldenGateSchema)) {
            return designToolFailure(
              'ADD_DESIGN_REGION_FAILED',
              {
                status: 'rejected' as const,
                code: 'SCHEMA_STRUCTURE_LOCKED',
                designId,
                regionId: null,
                error:
                  'This reusable Golden Gate schema fixes the slot count and order. Use search_moclo_parts, virtual_digest, and place_digest_fragment to fill an existing slot, or clear the schema first.',
              },
              effects
            );
          }

          const loaded = await loadSequenceDocumentBiologyFile(documentId, folders);
          const parsedFile = loaded.biology;
          const source = parsedFile.sequence;
          const sequenceLength = source.sequence.length;
          if (sequenceLength <= 0) {
            return designToolFailure(
              'ADD_DESIGN_REGION_FAILED',
              {
                designId,
                regionId: null,
                error: `Source sequence is empty: ${loaded.documentId}`,
              },
              effects
            );
          }

          const range = normalizeRange({
            start,
            end,
            wraps: wraps ?? false,
            sequenceLength,
            circular: source.circular ?? false,
          });
          if ('error' in range) {
            return designToolFailure(
              'ADD_DESIGN_REGION_FAILED',
              {
                designId,
                regionId: null,
                error: range.error,
              },
              effects
            );
          }

          const sourceAnnotations = parsedFile.features.map(featureToAnnotation);
          const sequence = extractSequenceRange(source.sequence, range);
          const sourceSequenceName = label ?? (source.name || loaded.documentId);

          effects.attemptedMutation();
          store.addRegion(designId, {
            sourceSequenceId: loaded.documentId,
            sourceSequenceName,
            sourceStart: range.start,
            sourceEnd: range.end,
            sourceLength: sequenceLength,
            sourceIsCircular: Boolean(source.circular),
            sequence,
            annotations: extractDesignAnnotationsForRange(
              sourceAnnotations,
              { start: range.start, end: range.end, wraps: range.wraps },
              sequenceLength
            ),
            sourceType: 'pcr',
          });

          effects.changed({ kind: 'design-region-added', designId });
          const updatedDesign = useDesignStore.getState().designs[designId];
          const addedRegion = updatedDesign?.regions[updatedDesign.regions.length - 1];
          if (!addedRegion) {
            return designToolFailure(
              'ADD_DESIGN_REGION_FAILED',
              {
                designId,
                regionId: null,
                error: 'Design region was not added.',
              },
              effects
            );
          }

          return toolSuccess({
            designId,
            regionId: addedRegion.id,
            designName: updatedDesign.name,
            sourceDocumentId: loaded.documentId,
            sourceSequenceName,
            sourceStart: range.start,
            sourceEnd: range.end,
            sourceStart1Indexed: range.start + 1,
            sourceEnd1Indexed: range.end,
            wraps: range.wraps,
            length: sequence.length,
            sourceLength: sequenceLength,
            sourceIsCircular: Boolean(source.circular),
            annotationCount: addedRegion.annotations.length,
            regionCount: updatedDesign.regions.length,
            assemblyState: updatedDesign.assemblyState,
            version: updatedDesign.version,
            previousVersion: design.version,
            mutation: createDesignMutationClaim({
              operationId: context?.toolCallId,
              toolName: 'add_design_region',
              effect: 'added_design_region',
              designId,
              beforeVersion: design.version,
              afterVersion: updatedDesign.version,
              changed: true,
              expected: {
                regionId: addedRegion.id,
                regionCount: updatedDesign.regions.length,
                length: sequence.length,
                sourceSequenceName,
                assemblyState: updatedDesign.assemblyState,
              },
            }),
          });
        } catch (error) {
          return designToolFailure(
            'ADD_DESIGN_REGION_FAILED',
            {
              designId,
              regionId: null,
              error: `Failed to add design region: ${
                error instanceof Error ? error.message : 'Unknown error'
              }`,
            },
            effects
          );
        }
      }),
  });
}

type NormalizedRange = {
  start: number;
  end: number;
  wraps: boolean;
};

function normalizeRange({
  start,
  end,
  wraps,
  sequenceLength,
  circular,
}: {
  start?: number;
  end?: number;
  wraps: boolean;
  sequenceLength: number;
  circular: boolean;
}): NormalizedRange | { error: string } {
  const start1 = start ?? 1;
  const end1 = end ?? sequenceLength;

  if (start1 < 1 || start1 > sequenceLength || end1 < 1 || end1 > sequenceLength) {
    return {
      error: `Range ${start1}..${end1} is outside source sequence bounds 1..${sequenceLength}.`,
    };
  }

  if (wraps && !circular) {
    return { error: 'Wrapped ranges require a circular source sequence.' };
  }

  if (wraps && start1 < end1) {
    return {
      error: 'Wrapped ranges must cross the origin. Use wraps=false when start is before end.',
    };
  }

  if (!wraps && start1 > end1) {
    return {
      error:
        'Start must be less than or equal to end for non-wrapping ranges. Set wraps=true for circular ranges crossing the origin.',
    };
  }

  if (wraps && start1 === end1) {
    return { error: 'Wrapped range must include at least one base.' };
  }

  return {
    start: start1 - 1,
    end: end1,
    wraps,
  };
}

function extractSequenceRange(sequence: string, range: NormalizedRange): string {
  if (!range.wraps) {
    return sequence.slice(range.start, range.end);
  }
  return sequence.slice(range.start) + sequence.slice(0, range.end);
}

function featureToAnnotation(feature: BiologyFeature): Annotation {
  return {
    name: feature.displayName || feature.type,
    type: feature.type,
    start: feature.start,
    end: feature.end,
    direction: feature.direction === 'forward' ? 1 : feature.direction === 'reverse' ? -1 : 0,
    color: feature.color,
  };
}
