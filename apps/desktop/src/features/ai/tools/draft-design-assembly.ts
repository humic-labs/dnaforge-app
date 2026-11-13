



import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import { assemblyDispatcher, useDesignStore } from '../../design/public/store';
import type { DesignRegion } from '../../design/public/types';
import { createDesignMutationClaim } from './agent-mutation';
import { projectDesignTmResolution } from './design-projection';

export const draftDesignAssemblySchema = z
  .object({
    designId: z.string().min(1).describe('Existing design id returned by create_design.'),
    expectedVersion: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Optional design version guard. The tool refuses if the design changed.'),
  })
  .strict();

export const draftDesignAssemblyTool = resultTool({
  description:
    'Draft primers and assembly junctions for an existing DNAForge design. ' +
    'Primers belong to this design and its accepted assembly history; source provenance ' +
    'does not attach primers to source sequences. Keep source sequences and their primer attachments unchanged. ' +
    'Use this after adding at least two sequence regions to a design. ' +
    'The tool refuses regions that only split and reconstruct one unchanged source, ' +
    'a complete circular source combined with another region without an explicit cut or replacement range, ' +
    'or adjacent circular-source fragments that should be one wrapped range. ' +
    'Read get_design to inspect the drafted primers, product and remaining issues. ' +
    'Drafting keeps the design editable; graduating an assembly into a finished plasmid is a user action. ' +
    'When the user requests saved exact products or accepted assemblies, call ' +
    'preview_finalize_design_assembly, then finalize_design_assembly with the returned ' +
    'fingerprint and exact design version to save the product, primers and accepted history.',
  inputSchema: draftDesignAssemblySchema as z.ZodTypeAny,
  execute: async (
    { designId, expectedVersion }: z.infer<typeof draftDesignAssemblySchema>,
    context?: { toolCallId?: string }
  ) =>
    runDesignTool('DRAFT_DESIGN_ASSEMBLY_FAILED', async (effects) => {
      const before = useDesignStore.getState().designs[designId];
      if (!before) {
        return designToolFailure(
          'DRAFT_DESIGN_ASSEMBLY_FAILED',
          {
            designId,
            drafted: false,
            error: `Design not found: ${designId}`,
          },
          effects
        );
      }

      if (before.regions.length < 2) {
        return designToolFailure(
          'DRAFT_DESIGN_ASSEMBLY_FAILED',
          {
            designId,
            drafted: false,
            code: 'DESIGN_REGIONS_REQUIRED' as const,
            assemblyState: before.assemblyState,
            regionCount: before.regions.length,
            error:
              'At least two design regions are required before drafting assembly. If the request names another biological part, use list_files with biologyQuery to locate and inspect its real source, then add the missing requested part with add_design_region and draft again.',
          },
          effects
        );
      }

      const placeholderIndex = before.regions.findIndex((region) => region.isPlaceholder);
      if (placeholderIndex !== -1) {
        return designToolFailure(
          'DRAFT_DESIGN_ASSEMBLY_FAILED',
          {
            designId,
            drafted: false,
            assemblyState: before.assemblyState,
            regionCount: before.regions.length,
            error: `Region ${placeholderIndex + 1} is still a placeholder.`,
          },
          effects
        );
      }

    if (before.regions.some(isCompleteCircularSourceRegion)) {
      return designToolFailure('DRAFT_DESIGN_ASSEMBLY_FAILED', {
        designId,
        drafted: false,
        code: 'FULL_CIRCULAR_SOURCE_ASSEMBLY' as const,
        assemblyState: before.assemblyState,
        regionCount: before.regions.length,
        error:
          'A complete circular source combined with other regions does not define an intentional insertion or replacement junction. Inspect the source annotations and choose an insertion or replacement site. Call get_design to read the complete-source slot regionId, occupantFingerprint and design version; pass those unchanged to remove_design_region. Then use add_design_region with the chosen backbone range (1-indexed inclusive; wraps:true when crossing the origin), and draft again. Preserve the intended order of the backbone and inserted parts.',
      }, effects);
    }

    const splitCircularRange = findMergeableCircularSourceRun(before.regions);
    if (splitCircularRange) {
      if (splitCircularRange.length === splitCircularRange.sourceLength) {
        return designToolFailure('DRAFT_DESIGN_ASSEMBLY_FAILED', {
          designId,
          drafted: false,
          code: 'CIRCULAR_INSERTION_ORDER_REQUIRED' as const,
          assemblyState: before.assemblyState,
          regionCount: before.regions.length,
          adjacentSourceRegionIds: splitCircularRange.regionIds,
          error:
            'These adjacent backbone fragments reconstruct the complete circular source without an inserted part between them. Call get_design to inspect the current slots and version, then reorder_design_regions with the complete order of all regionIds and expectedDesignVersion to put the intended insert between the backbone arms at the chosen cut. Draft again. Merging them into the whole-source range would return to FULL_CIRCULAR_SOURCE_ASSEMBLY.',
        }, effects);
      }
      return designToolFailure('DRAFT_DESIGN_ASSEMBLY_FAILED', {
        designId,
        drafted: false,
        code: 'SPLIT_CIRCULAR_SOURCE_RANGE' as const,
        assemblyState: before.assemblyState,
        regionCount: before.regions.length,
        replacementRange: {
          start: splitCircularRange.start,
          end: splitCircularRange.end,
          wraps: splitCircularRange.wraps,
          length: splitCircularRange.length,
        },
        error:
          `Adjacent regions from one circular source should be one wrapped region ` +
          `${splitCircularRange.start}..${splitCircularRange.end}. Remove the split source regions, ` +
          `add that single range with wraps:${String(splitCircularRange.wraps)}, then add the replacement part in the requested order and draft again.`,
      }, effects);
    }

      if (reconstructsOneUnchangedSource(before.regions)) {
        return designToolFailure(
          'DRAFT_DESIGN_ASSEMBLY_FAILED',
          {
            designId,
            drafted: false,
            code: 'UNCHANGED_SOURCE_REASSEMBLY' as const,
            assemblyState: before.assemblyState,
            regionCount: before.regions.length,
            error:
              'These regions only split and reconstruct one unchanged source. Add the real replacement or inserted source region and omit the source range it replaces before drafting.',
          },
          effects
        );
      }

      effects.attemptedMutation();
      const dispatch = assemblyDispatcher.dispatch({
        type: 'validate',
        designId,
        expectedVersion: expectedVersion ?? before.version,
      });
      const result = await dispatch.result;
      const design = useDesignStore.getState().designs[designId];

      if (!design) {
        return designToolFailure(
          'DRAFT_DESIGN_ASSEMBLY_FAILED',
          {
            designId,
            drafted: false,
            error: 'Design disappeared while drafting assembly.',
          },
          effects
        );
      }

      if (!result.ok) {
        effects.unchanged();
        return designToolFailure(
          'DRAFT_DESIGN_ASSEMBLY_FAILED',
          {
            designId,
            drafted: false,
            assemblyState: design.assemblyState,
            regionCount: design.regions.length,
            validationErrors: design.validationErrors,
            error: result.error.message,
            refusal: result.error,
          },
          effects
        );
      }

      effects.changed({ kind: 'assembly-drafted', designId });
      const validationErrorCount = design.validationErrors.filter(
        (item) => item.severity === 'error'
      ).length;

      const receipt = {
        designId,
        drafted: validationErrorCount === 0 && design.assemblyState === 'ready',
        designName: design.name,
        assemblyMethod: design.assemblyMethod,
        assemblyState: design.assemblyState,
        status: design.status,
        version: design.version,
        previousVersion: before.version,
        regionCount: design.regions.length,
        homologyRegionCount: design.homologyRegions.length,
        goldenGateJunctionCount: design.goldenGateJunctions?.length ?? 0,
        primerPairCount: design.designPrimers.length,
        tmResolution: projectDesignTmResolution(design),
        validationErrorCount,
        validationErrors: design.validationErrors,
        changedFields: result.value.changedFields,
        mutation: createDesignMutationClaim({
          operationId: context?.toolCallId,
          toolName: 'draft_design_assembly',
          effect: 'drafted_design_assembly',
          designId,
          beforeVersion: before.version,
          afterVersion: design.version,
          changed: design.version !== before.version,
          expected: {
            assemblyState: design.assemblyState,
            regionCount: design.regions.length,
            homologyRegionCount: design.homologyRegions.length,
            goldenGateJunctionCount: design.goldenGateJunctions?.length ?? 0,
            primerPairCount: design.designPrimers.length,
            validationErrorCount,
          },
        }),
      };
      if (!receipt.drafted)
        return designToolFailure(
          'ASSEMBLY_VALIDATION_FAILED',
          {
            ...receipt,
            error:
              'The draft was computed but assembly validation did not pass. Inspect validationErrors before continuing.',
          },
          effects
        );
      return toolSuccess(receipt);
    }),
});

function isCompleteCircularSourceRegion(region: DesignRegion): boolean {
  const sourceLength = region.sourceLength;
  if (!sourceLength || sourceLength <= 0 || !region.sourceIsCircular) return false;
  if (region.sequence.length !== sourceLength) return false;

  const { sourceStart: start, sourceEnd: end } = region;
  if (start < 0 || start >= sourceLength || end < 0 || end > sourceLength) return false;

  return start <= end ? end - start === sourceLength : sourceLength - start + end === sourceLength;
}

function findMergeableCircularSourceRun(regions: DesignRegion[]): {
  start: number;
  end: number;
  wraps: boolean;
  length: number;
  sourceLength: number;
  regionIds: string[];
} | null {
  for (let runStart = 0; runStart < regions.length - 1; runStart += 1) {
    const first = regions[runStart];
    const sourceSequenceId = first?.sourceSequenceId;
    const sourceLength = first?.sourceLength;
    if (!sourceSequenceId || !sourceLength || sourceLength <= 0 || !first.sourceIsCircular) {
      continue;
    }

    let runEnd = runStart + 1;
    while (
      runEnd < regions.length &&
      regions[runEnd]?.sourceSequenceId === sourceSequenceId &&
      regions[runEnd]?.sourceLength === sourceLength &&
      regions[runEnd]?.sourceIsCircular
    ) {
      runEnd += 1;
    }
    if (runEnd - runStart < 2 || runEnd - runStart === regions.length) continue;

    const merged = mergeCircularSourceIntervals(regions.slice(runStart, runEnd), sourceLength);
    if (merged) {
      return {
        ...merged,
        sourceLength,
        regionIds: regions.slice(runStart, runEnd).map((region) => region.id),
      };
    }
    runStart = runEnd - 1;
  }
  return null;
}

function mergeCircularSourceIntervals(
  regions: DesignRegion[],
  sourceLength: number
): { start: number; end: number; wraps: boolean; length: number } | null {
  const intervals: Array<{ start: number; end: number }> = [];
  let totalLength = 0;
  for (const region of regions) {
    const { sourceStart: start, sourceEnd: end } = region;
    if (start < 0 || start >= sourceLength || end < 0 || end > sourceLength) return null;
    const expectedLength = start <= end ? end - start : sourceLength - start + end;
    if (expectedLength <= 0 || region.sequence.length !== expectedLength) return null;
    totalLength += expectedLength;
    if (start <= end) intervals.push({ start, end });
    else intervals.push({ start, end: sourceLength }, { start: 0, end });
  }

  intervals.sort((left, right) => left.start - right.start || left.end - right.end);
  const compacted: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const previous = compacted[compacted.length - 1];
    if (!previous) {
      compacted.push({ ...interval });
      continue;
    }
    if (interval.start < previous.end) return null;
    if (interval.start === previous.end) previous.end = interval.end;
    else compacted.push({ ...interval });
  }

  if (compacted.length === 1) {
    const [only] = compacted;
    return { start: only.start + 1, end: only.end, wraps: false, length: totalLength };
  }
  if (compacted.length === 2 && compacted[0]?.start === 0 && compacted[1]?.end === sourceLength) {
    return {
      start: compacted[1].start + 1,
      end: compacted[0].end,
      wraps: true,
      length: totalLength,
    };
  }
  return null;
}

function reconstructsOneUnchangedSource(regions: DesignRegion[]): boolean {
  if (regions.length < 2) return false;

  const sourceSequenceId = regions[0]?.sourceSequenceId;
  const sourceLength = regions[0]?.sourceLength;
  if (!sourceSequenceId || !sourceLength || sourceLength <= 0) return false;
  if (
    regions.some(
      (region) =>
        region.sourceSequenceId !== sourceSequenceId || region.sourceLength !== sourceLength
    )
  ) {
    return false;
  }

  const intervals: Array<{ start: number; end: number }> = [];
  for (const region of regions) {
    const { sourceStart: start, sourceEnd: end } = region;
    if (start < 0 || start >= sourceLength || end < 0 || end > sourceLength) return false;

    if (start <= end) {
      if (region.sequence.length !== end - start) return false;
      intervals.push({ start, end });
      continue;
    }

    if (!region.sourceIsCircular) return false;
    if (region.sequence.length !== sourceLength - start + end) return false;
    intervals.push({ start, end: sourceLength }, { start: 0, end });
  }

  intervals.sort((left, right) => left.start - right.start || left.end - right.end);
  let coveredUntil = 0;
  for (const interval of intervals) {
    if (interval.start !== coveredUntil || interval.end <= interval.start) return false;
    coveredUntil = interval.end;
  }
  return coveredUntil === sourceLength;
}
