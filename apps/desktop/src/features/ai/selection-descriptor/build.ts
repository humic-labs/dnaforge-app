import { useSequenceStore } from '../../sequence/public/store';

import { buildAnnotationDescriptor } from './annotation';
import { buildSequenceRegionDescriptor } from './sequence-region';
import { buildWholeEntityDescriptor } from './whole-entity';
import { buildStructureSelectionDescriptor } from './structure';
import type { DescriptorBuildResult, DescriptorInput } from './types';

export { LARGE_REGION_BP, RAW_FALLBACK_CAP_BP } from './sequence-region';

function isValidRange(
  range: { start: number; end: number; wraps?: boolean } | undefined
): range is {
  start: number;
  end: number;
  wraps?: boolean;
} {
  return (
    range !== undefined &&
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 1 &&
    range.end >= 1
  );
}

export function buildSelectionDescriptor(input: DescriptorInput): DescriptorBuildResult {
  if (input.kind === 'structure') {
    return (
      buildStructureSelectionDescriptor(input) ?? {
        kind: 'empty_selection',
        reason: 'no-structure-residues',
        hint: 'Select one or more residues in the structure first.',
      }
    );
  }

  const store = useSequenceStore.getState();
  const sequence = store.getSequence(input.documentId);
  if (!sequence) {
    return {
      kind: 'unavailable',
      reason: `No resident parsed sequence for "${input.documentId}". Open it in a tab first.`,
    };
  }
  const sourceVersion = store.getVersion(input.documentId);

  if (input.kind === 'whole_entity') {
    return buildWholeEntityDescriptor(input, sequence, sourceVersion);
  }

  if (input.kind === 'annotation') {
    const descriptor = buildAnnotationDescriptor(input, sequence, sourceVersion);
    if (!descriptor) {
      return {
        kind: 'empty_selection',
        reason: 'no-annotation-at-range',
        hint: 'No feature matched that location. Select a feature or a base range first.',
      };
    }
    return descriptor;
  }

  if (!isValidRange(input.range)) {
    return {
      kind: 'empty_selection',
      reason: 'no-range',
      hint: 'Select a range first, then ask about it.',
    };
  }

  return buildSequenceRegionDescriptor({ ...input, range: input.range }, sequence, sourceVersion);
}
