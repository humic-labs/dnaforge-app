import type { DesignRegion, DesignSpacer, SequenceDesign } from './types';
import { selectAssemblyBoundaries } from './assembly-boundaries';

export interface AssemblySlotView {
  slotIndex: number;
  regionId: string;
  schemaSlotId: string | null;
  isEmpty: boolean;
  label: string;
  length: number;
  sourceType: string | null;
  ggType: string | null;
  rdSourceEnzyme: string | null;
  occupantFingerprint: string;
}

export interface AssemblyGapView {
  junctionIndex: number;
  spacer: { id: string; sequence: string; name: string | null; length: number } | null;
  duplicateSpacerIds: string[];
}

function fingerprint(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

export function slotOccupantFingerprint(region: DesignRegion): string {
  return fingerprint(
    JSON.stringify({
      colorIndex: region.colorIndex ?? null,
      sourceSequenceId: region.sourceSequenceId,
      sourceSequenceName: region.sourceSequenceName,
      sourceStart: region.sourceStart,
      sourceEnd: region.sourceEnd,
      sequence: region.sequence,
      annotations: region.annotations,
      sourceSequence: region.sourceSequence ?? null,
      sourceAnnotations: region.sourceAnnotations ?? null,
      sourceIsCircular: region.sourceIsCircular ?? null,
      isPlaceholder: region.isPlaceholder === true,
      sourceType: region.sourceType ?? null,
      ggType: region.ggType ?? null,
      rdOverhangs: region.rdOverhangs ?? null,
      rdSourceEnzyme: region.rdSourceEnzyme ?? null,
      rdSourceEnzymeName: region.rdSourceEnzymeName ?? null,
      rdEnds: region.rdEnds ?? null,
      rdSiblingOverhangs: region.rdSiblingOverhangs ?? null,
    })
  );
}

export function projectAssemblySlots(design: SequenceDesign): AssemblySlotView[] {
  return design.regions.map((region, slotIndex) => ({
    slotIndex,
    regionId: region.id,
    schemaSlotId: region.schemaSlotId ?? null,
    isEmpty: region.isPlaceholder === true,
    label: region.isPlaceholder ? 'Empty slot' : region.sourceSequenceName,
    length: region.sequence.length,
    sourceType: region.isPlaceholder ? null : (region.sourceType ?? null),
    ggType: region.isPlaceholder ? null : (region.ggType ?? null),
    rdSourceEnzyme: region.isPlaceholder ? null : (region.rdSourceEnzyme ?? null),
    occupantFingerprint: slotOccupantFingerprint(region),
  }));
}

export function projectAssemblyGaps(design: SequenceDesign): AssemblyGapView[] {
  const boundaries = selectAssemblyBoundaries(design);
  return boundaries.map((boundary) => ({
    junctionIndex: boundary.junctionIndex,
    spacer: boundary.spacer ? projectSpacer(boundary.spacer) : null,
    duplicateSpacerIds: boundary.duplicateSpacers.map((spacer) => spacer.id),
  }));
}

function projectSpacer(spacer: DesignSpacer) {
  return {
    id: spacer.id,
    sequence: spacer.sequence,
    name: spacer.name ?? null,
    length: spacer.sequence.length,
  };
}

export function orphanedSpacers(design: SequenceDesign): DesignSpacer[] {
  const gapCount = design.regions.length;
  return design.spacers.filter(
    (spacer) =>
      !Number.isInteger(spacer.junctionIndex) ||
      spacer.junctionIndex < 0 ||
      spacer.junctionIndex > gapCount - 1
  );
}
