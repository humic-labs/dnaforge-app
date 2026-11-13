import type { AssemblyMethod, DesignRegion, GoldenGateEnzyme, SequenceDesign } from './types';
import { rdFragmentAssemblyBlockReason } from './rd-fragment-policy';

export interface RdFragmentAdmission {
  allowed: boolean;
  code?: 'RD_FRAGMENT_NOT_INSERT' | 'RD_ENZYME_MISMATCH';
  reason?: string;
  existingEnzyme?: GoldenGateEnzyme | null;
  incomingEnzyme?: GoldenGateEnzyme | null;
  remedy?: string;
  adoptEnzyme?: GoldenGateEnzyme;
}

export function existingRdEnzymes(design: SequenceDesign): GoldenGateEnzyme[] {
  return design.regions
    .filter((region) => (region.sourceType === 'rd' || region.rdOverhangs) && region.rdSourceEnzyme)
    .map((region) => region.rdSourceEnzyme as GoldenGateEnzyme);
}

export function planRdFragmentAdd(
  design: Pick<SequenceDesign, 'assemblyMethod' | 'regions' | 'goldenGateConfig'>,
  fragment: Pick<DesignRegion, 'ggType' | 'rdSourceEnzyme' | 'sourceType'>
): RdFragmentAdmission {
  const assemblyMethod: AssemblyMethod = design.assemblyMethod;

  const blockReason = rdFragmentAssemblyBlockReason(assemblyMethod, fragment.ggType);
  if (blockReason) {
    return {
      allowed: false,
      code: 'RD_FRAGMENT_NOT_INSERT',
      reason: blockReason,
      remedy:
        'Golden Gate can only take a fragment whose ends point inward (ggType "insert"). ' +
        'Re-run virtual_digest and choose a fragment with ggType "insert", or switch the design ' +
        'to gibson/nebuilder, which accept any physical digest fragment.',
    };
  }

  if (assemblyMethod === 'goldengate' && fragment.rdSourceEnzyme) {
    const existing = existingRdEnzymes(design as SequenceDesign);
    const conflicting = existing.find((enzyme) => enzyme !== fragment.rdSourceEnzyme);
    if (conflicting) {
      return {
        allowed: false,
        code: 'RD_ENZYME_MISMATCH',
        reason: `This fragment was cut with ${fragment.rdSourceEnzyme} but the assembly already contains ${conflicting} fragments.`,
        existingEnzyme: conflicting,
        incomingEnzyme: fragment.rdSourceEnzyme,
        remedy:
          `A Golden Gate assembly is a single Type IIS reaction, so every digest fragment must ` +
          `come from the same enzyme. Either digest this source with ${conflicting} instead, or ` +
          `remove the existing ${conflicting} fragments first.`,
      };
    }
    if (existing.length === 0 && design.goldenGateConfig?.enzyme !== fragment.rdSourceEnzyme) {
      return { allowed: true, adoptEnzyme: fragment.rdSourceEnzyme };
    }
  }

  return { allowed: true };
}
