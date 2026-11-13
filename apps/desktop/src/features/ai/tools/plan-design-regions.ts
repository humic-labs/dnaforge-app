   
                                                                         
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import type { BiologyFeature } from './parse-biology-file';
import { loadSequenceDocumentBiologyFile } from './path-utils';
import { sequenceResourceUri } from './get-sequence';

const DEFAULT_REGION_COUNT = 2;
const DEFAULT_REGION_LENGTH = 500;
const MAX_REGION_COUNT = 10;

export function planDesignRegionsSchemaForFolders(_folders: WorkspaceFolder[]) {
  return z
    .object({
      documentId: z
        .string()
        .min(1)
        .describe(
          'Stable package/catalog source sequence ID or waypoint://sequence/{documentId} URI.'
        ),
      maxRegions: z
        .number()
        .int()
        .min(1)
        .max(MAX_REGION_COUNT)
        .default(DEFAULT_REGION_COUNT)
        .describe(
          'Maximum number of source regions to suggest. Must be 1 through 10; defaults to 2.'
        ),
      preferredRegionLength: z
        .number()
        .int()
        .positive()
        .max(10_000)
        .default(DEFAULT_REGION_LENGTH)
        .describe('Preferred fallback range length in base pairs. Defaults to 500 bp.'),
      includeFeatureBackedRegions: z
        .boolean()
        .default(true)
        .describe('Prefer annotated features when useful before falling back to sequence windows.'),
    })
    .strict();
}

export const planDesignRegionsSchema = planDesignRegionsSchemaForFolders([]);

export function createPlanDesignRegionsTool(folders: WorkspaceFolder[]) {
  const inputSchema = planDesignRegionsSchemaForFolders(folders);

  return resultTool({
    description:
      'Suggest 1-indexed inclusive source ranges for add_design_region. ' +
      'Use this after import_sequence or get_sequence when an agent needs concrete design ' +
      'region coordinates from a source sequence. For each feature in a circular source, ' +
      'replacementRetainedRange is the exact wrapped or contiguous complement to use when replacing only that feature.',
    inputSchema: inputSchema as z.ZodTypeAny,
    execute: async ({
      documentId: inputDocumentId,
      maxRegions = DEFAULT_REGION_COUNT,
      preferredRegionLength = DEFAULT_REGION_LENGTH,
      includeFeatureBackedRegions = true,
    }: z.infer<typeof inputSchema>) =>
      runDesignTool('PLAN_DESIGN_REGIONS_FAILED', async (effects) => {
        try {
          const loaded = await loadSequenceDocumentBiologyFile(inputDocumentId, folders);
          const parsedFile = loaded.biology;
          const parsed = parsedFile.sequence;
          const sequenceLength = parsed.length ?? parsed.sequence?.length ?? 0;
          if (sequenceLength <= 0) {
            return designToolFailure(
              'PLAN_DESIGN_REGIONS_FAILED',
              {
                planned: false,
                documentId: loaded.documentId,
                resourceUri: sequenceResourceUri(loaded.documentId),
                error: 'Source sequence is empty.',
              },
              effects
            );
          }

          const regions = planDesignRegions({
            features: parsedFile.features,
            includeFeatureBackedRegions,
            maxRegions,
            preferredRegionLength,
            sequenceLength,
            sourceIsCircular: parsed.circular === true,
          });

          return toolSuccess({
            planned: true,
            documentId: loaded.documentId,
            resourceUri: sequenceResourceUri(loaded.documentId),
            name: parsed.name || loaded.documentId,
            format: parsedFile.format,
            circular: parsed.circular,
            length: sequenceLength,
            featureCount: parsedFile.features.length,
            requestedRegionCount: maxRegions,
            regionCount: regions.length,
            strategy: 'feature_then_even_windows',
            regions,
          });
        } catch (error) {
          return designToolFailure(
            'PLAN_DESIGN_REGIONS_FAILED',
            {
              planned: false,
              documentId: inputDocumentId,
              resourceUri: sequenceResourceUri(inputDocumentId),
              error: `Failed to plan design regions: ${
                error instanceof Error ? error.message : 'Unknown error'
              }`,
            },
            effects
          );
        }
      }),
  });
}

type PlannedRegion = {
  label: string;
  start: number;
  end: number;
  length: number;
  source: 'feature' | 'window';
  reason: string;
  featureType?: string;
  featureName?: string;
  replacementRetainedRange?: {
    start: number;
    end: number;
    wraps: boolean;
    length: number;
  };
};

type PlanDesignRegionsInput = {
  features: BiologyFeature[];
  includeFeatureBackedRegions: boolean;
  maxRegions: number;
  preferredRegionLength: number;
  sequenceLength: number;
  sourceIsCircular: boolean;
};

function planDesignRegions({
  features,
  includeFeatureBackedRegions,
  maxRegions,
  preferredRegionLength,
  sequenceLength,
  sourceIsCircular,
}: PlanDesignRegionsInput): PlannedRegion[] {
  const regions: PlannedRegion[] = [];

  if (includeFeatureBackedRegions) {
    for (const feature of features) {
      const candidate = featureToRegion(feature, sequenceLength, sourceIsCircular);
      if (!candidate || overlapsAny(candidate, regions)) {
        continue;
      }
      regions.push(candidate);
      if (regions.length >= maxRegions) {
        return regions;
      }
    }
  }

  let nextStart = 1;
  while (regions.length < maxRegions && nextStart <= sequenceLength) {
    const window = nextNonOverlappingWindow({
      start: nextStart,
      regions,
      preferredRegionLength,
      sequenceLength,
    });
    if (!window) {
      break;
    }
    const candidate: PlannedRegion = {
      label: `Source bases ${window.start}-${window.end}`,
      start: window.start,
      end: window.end,
      length: window.end - window.start + 1,
      source: 'window',
      reason: 'Even source-window fallback for design composition.',
    };
    regions.push(candidate);
    nextStart = candidate.end + 1;
  }

  return regions;
}

function featureToRegion(
  feature: BiologyFeature,
  sequenceLength: number,
  sourceIsCircular: boolean
): PlannedRegion | null {
  if (!Number.isInteger(feature.start) || !Number.isInteger(feature.end)) {
    return null;
  }
  const start = feature.start;
  const end = feature.end;
  if (start < 1 || end < start || end > sequenceLength) {
    return null;
  }
  const length = end - start + 1;
  if (isWholeSequenceSourceFeature(feature, length, sequenceLength)) {
    return null;
  }
  const featureName = feature.displayName || feature.type || `Feature ${start}-${end}`;
  return {
    label: featureName,
    start,
    end,
    length,
    source: 'feature',
    reason: `Annotated ${feature.type || 'feature'} selected from source sequence.`,
    featureType: feature.type,
    featureName,
    replacementRetainedRange: sourceIsCircular
      ? circularFeatureComplement({ start, end, length, sequenceLength })
      : undefined,
  };
}

function circularFeatureComplement({
  start,
  end,
  length,
  sequenceLength,
}: {
  start: number;
  end: number;
  length: number;
  sequenceLength: number;
}): NonNullable<PlannedRegion['replacementRetainedRange']> {
  const retainedStart = end === sequenceLength ? 1 : end + 1;
  const retainedEnd = start === 1 ? sequenceLength : start - 1;
  return {
    start: retainedStart,
    end: retainedEnd,
    wraps: retainedStart > retainedEnd,
    length: sequenceLength - length,
  };
}

function isWholeSequenceSourceFeature(
  feature: BiologyFeature,
  length: number,
  sequenceLength: number
): boolean {
  return feature.type?.toLowerCase() === 'source' && length === sequenceLength;
}

function overlapsAny(candidate: Pick<PlannedRegion, 'start' | 'end'>, regions: PlannedRegion[]) {
  return regions.some((region) => candidate.start <= region.end && candidate.end >= region.start);
}

function nextNonOverlappingWindow({
  start,
  regions,
  preferredRegionLength,
  sequenceLength,
}: {
  start: number;
  regions: PlannedRegion[];
  preferredRegionLength: number;
  sequenceLength: number;
}): Pick<PlannedRegion, 'start' | 'end'> | null {
  let candidate = start;
  const sortedRegions = [...regions].sort((a, b) => a.start - b.start);

  while (candidate <= sequenceLength) {
    let end = Math.min(candidate + preferredRegionLength - 1, sequenceLength);
    let advanced = false;

    for (const region of sortedRegions) {
      if (candidate > region.end) {
        continue;
      }
      if (end < region.start) {
        return { start: candidate, end };
      }
      if (candidate < region.start) {
        end = region.start - 1;
        return { start: candidate, end };
      }
      candidate = region.end + 1;
      advanced = true;
      break;
    }

    if (!advanced) {
      return { start: candidate, end };
    }
  }

  return null;
}
