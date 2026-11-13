import type { SequenceDesign } from '../design/public/types';
import {
  buildAssemblyOptimizationInput,
  type AssemblyOptimizationInput,
} from './assembly-optimization-input';

export type AssemblyProductIdentity = string;

export type AssemblyProductPendingEdits = {
  spacers?: Readonly<Record<number, string>>;
  regionSequences?: Readonly<Record<string, string>>;
};

export type TaggedAssemblyDerived<T> = {
  readonly productIdentity: AssemblyProductIdentity;
  readonly value: T;
};

export function applyAssemblyProductPendingEdits(
  design: SequenceDesign,
  pending?: AssemblyProductPendingEdits | null
): SequenceDesign {
  if (!pending) return design;
  const spacerEdits = pending.spacers;
  const regionEdits = pending.regionSequences;
  if (!spacerEdits && !regionEdits) return design;

  let regions = design.regions;
  if (regionEdits) {
    let changed = false;
    const nextRegions = design.regions.map((region) => {
      const nextSequence = regionEdits[region.id];
      if (nextSequence === undefined || nextSequence === region.sequence) return region;
      changed = true;
      return { ...region, sequence: nextSequence };
    });
    if (changed) regions = nextRegions;
  }

  let spacers = design.spacers;
  if (spacerEdits) {
    const nextSpacers = [...design.spacers];
    let changed = false;
    for (const [indexText, sequence] of Object.entries(spacerEdits)) {
      const junctionIndex = Number(indexText);
      if (!Number.isInteger(junctionIndex)) continue;
      const existingIndex = nextSpacers.findIndex(
        (spacer) => spacer.junctionIndex === junctionIndex
      );
      if (sequence.length === 0) {
        if (existingIndex >= 0) {
          nextSpacers.splice(existingIndex, 1);
          changed = true;
        }
        continue;
      }
      if (existingIndex >= 0) {
        if (nextSpacers[existingIndex].sequence !== sequence) {
          nextSpacers[existingIndex] = { ...nextSpacers[existingIndex], sequence };
          changed = true;
        }
        continue;
      }
      nextSpacers.push({
        id: `pending-spacer:${design.id}:${junctionIndex}`,
        junctionIndex,
        sequence,
      });
      changed = true;
    }
    if (changed) spacers = nextSpacers;
  }

  if (regions === design.regions && spacers === design.spacers) return design;
  return { ...design, regions, spacers };
}

export function assemblyProductIdentity(
  design: SequenceDesign,
  pending?: AssemblyProductPendingEdits | null
): AssemblyProductIdentity {
  return buildAssemblyOptimizationInput(applyAssemblyProductPendingEdits(design, pending))
    .optimizationFingerprint;
}

export function assemblyProductIdentityOf(
  input: Pick<AssemblyOptimizationInput, 'optimizationFingerprint'>
): AssemblyProductIdentity {
  return input.optimizationFingerprint;
}

export function tagAssemblyDerived<T>(
  productIdentity: AssemblyProductIdentity,
  value: T
): TaggedAssemblyDerived<T> {
  return { productIdentity, value };
}

export function freshAssemblyDerived<T>(
  currentIdentity: AssemblyProductIdentity,
  tagged: TaggedAssemblyDerived<T> | null | undefined
): T | null {
  if (!tagged) return null;
  if (!currentIdentity || !tagged.productIdentity) return null;
  if (tagged.productIdentity !== currentIdentity) return null;
  return tagged.value;
}
