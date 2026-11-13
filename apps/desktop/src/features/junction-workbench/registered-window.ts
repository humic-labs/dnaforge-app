import type { DesignRegion } from '../design/public/types';

export const SOURCE_ROW_BUFFER_BP = 100;

export interface RegisteredWindow {
  registeredStartBioCol: number;
  registeredEndBioCol: number;
  length: number;
}

export function computeRegisteredWindow(
  leftRegion: Pick<DesignRegion, 'sequence'>,
  rightRegion: Pick<DesignRegion, 'sequence'>,
  maxWindowBp: number,
  spacerLength = 0
): RegisteredWindow {
  const includedSpacerLength = Math.max(0, Math.min(spacerLength, maxWindowBp));
  const availableRegionLength = Math.max(0, maxWindowBp - includedSpacerLength);
  const targetLeft = Math.floor(availableRegionLength / 2);
  const leftLength = Math.min(leftRegion.sequence.length, targetLeft);
  const rightLength = Math.min(rightRegion.sequence.length, availableRegionLength - leftLength);
  return {
    registeredStartBioCol: -leftLength,
    registeredEndBioCol: includedSpacerLength + rightLength,
    length: leftLength + includedSpacerLength + rightLength,
  };
}
