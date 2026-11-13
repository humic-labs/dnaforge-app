
import type { SequenceDesign } from '../../design/public/types';
import {
  orphanedSpacers,
  projectAssemblyGaps,
  projectAssemblySlots,
  type AssemblyGapView,
  type AssemblySlotView,
} from '../../design/public/slot-projection';
import { getComposedSequenceForDesign } from '../../design/public/restriction-digest';
import type { RefusalReason } from '../../assembly/public/refusals';

export interface SpacerPlacement {
  spacerId: string;
  junctionIndex: number;
  sequence: string;
  name: string | null;
  between: string;
  betweenLabels: string;
}

export interface AssemblySnapshot {
  designVersion: number;
  slotCount: number;
  slots: AssemblySlotView[];
  gaps: AssemblyGapView[];
  spacers: SpacerPlacement[];
  orphanedSpacerIds: string[];
  composedLength: number;
}

export function spacerPlacements(design: SequenceDesign): SpacerPlacement[] {
  const regions = design.regions;
  const count = regions.length;
  return (design.spacers ?? []).map((spacer) => {
    const leftId = spacer.anchor?.leftRegionId ?? regions[spacer.junctionIndex]?.id ?? null;
    const rightId =
      spacer.anchor?.rightRegionId ??
      (count > 0 ? (regions[(spacer.junctionIndex + 1) % count]?.id ?? null) : null);
    const labelFor = (id: string | null) =>
      regions.find((region) => region.id === id)?.sourceSequenceName ?? '(gone)';
    return {
      spacerId: spacer.id,
      junctionIndex: spacer.junctionIndex,
      sequence: spacer.sequence,
      name: spacer.name ?? null,
      between: `${leftId ?? '?'}→${rightId ?? '?'}`,
      betweenLabels: `${labelFor(leftId)}→${labelFor(rightId)}`,
    };
  });
}

export function assemblySnapshot(design: SequenceDesign): AssemblySnapshot {
  return {
    designVersion: design.version,
    slotCount: design.regions.length,
    slots: projectAssemblySlots(design),
    gaps: projectAssemblyGaps(design),
    spacers: spacerPlacements(design),
    orphanedSpacerIds: orphanedSpacers(design).map((spacer) => spacer.id),
    composedLength: getComposedSequenceForDesign(design).length,
  };
}

export interface SpacerDiff {
  movedSpacers: Array<{
    spacerId: string;
    sequence: string;
    wasBetween: string;
    nowBetween: string;
    wasJunctionIndex: number;
    nowJunctionIndex: number;
  }>;
  droppedSpacers: Array<{
    spacerId: string;
    sequence: string;
    name: string | null;
    wasBetween: string;
    wasBetweenLabels: string;
    wasJunctionIndex: number;
  }>;
}

export function diffSpacers(before: SpacerPlacement[], after: SpacerPlacement[]): SpacerDiff {
  const afterById = new Map(after.map((placement) => [placement.spacerId, placement]));

  const movedSpacers: SpacerDiff['movedSpacers'] = [];
  const droppedSpacers: SpacerDiff['droppedSpacers'] = [];

  for (const previous of before) {
    const current = afterById.get(previous.spacerId);
    if (!current) {
      droppedSpacers.push({
        spacerId: previous.spacerId,
        sequence: previous.sequence,
        name: previous.name,
        wasBetween: previous.between,
        wasBetweenLabels: previous.betweenLabels,
        wasJunctionIndex: previous.junctionIndex,
      });
      continue;
    }
    if (current.junctionIndex !== previous.junctionIndex || current.between !== previous.between) {
      movedSpacers.push({
        spacerId: previous.spacerId,
        sequence: previous.sequence,
        wasBetween: previous.between,
        nowBetween: current.between,
        wasJunctionIndex: previous.junctionIndex,
        nowJunctionIndex: current.junctionIndex,
      });
    }
  }

  return { movedSpacers, droppedSpacers };
}

export function draftDiscardedBy(design: SequenceDesign) {
  return {
    homologyRegions: design.homologyRegions?.length ?? 0,
    designPrimers: design.designPrimers?.length ?? 0,
    goldenGateJunctions: design.goldenGateJunctions?.length ?? 0,
  };
}

export function refusalCode(reason: RefusalReason): string {
  switch (reason.kind) {
    case 'stale_state':
      return 'stale-design-version';
    case 'bad_input':
      return 'BAD_INPUT';
    case 'state_conflict':
      return reason.conflictWith?.reason === 'missing_fragment'
        ? 'slot-not-found'
        : 'STATE_CONFLICT';
    case 'sidecar_failure':
      return 'SIDECAR_FAILURE';
  }
}

export function refusalRemedy(reason: RefusalReason): string {
  switch (reason.kind) {
    case 'stale_state':
      return 'Re-read the design with get_design and retry with the version it reports.';
    case 'bad_input':
      return reason.acceptableValues?.length
        ? `Acceptable values: ${reason.acceptableValues.join(', ')}.`
        : `Fix ${reason.field ?? 'the input'} and retry.`;
    case 'state_conflict':
      return 'Re-read the design with get_design — the thing you addressed is not there any more.';
    case 'sidecar_failure':
      return reason.retryable ? 'Transient failure; retry.' : 'Not retryable.';
  }
}

export function isRetriableRefusal(reason: RefusalReason): boolean {
  return (
    reason.kind === 'stale_state' ||
    (reason.kind === 'sidecar_failure' && reason.retryable === true)
  );
}
