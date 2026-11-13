import type { CoordinateSpace } from './types';

export function countNonGaps(sequence: string): number {
  let count = 0;
  for (const char of sequence) {
    if (char !== '-') {
      count++;
    }
  }
  return count;
}

export function isGappedMode(coordinateSpace: CoordinateSpace | undefined): boolean {
  return coordinateSpace?.mode === 'gapped';
}

export function isEditingDisabled(coordinateSpace: CoordinateSpace | undefined): boolean {
  return isGappedMode(coordinateSpace);
}

export function validateCoordinateSpace(
  coordinateSpace: CoordinateSpace | undefined,
  biologicalSequence: string
): boolean {
  if (!coordinateSpace || coordinateSpace.mode === 'biological') {
    return true;
  }

  if (coordinateSpace.mode === 'gapped') {
    if (!coordinateSpace.gappedSequence) {
      console.warn('[coordinateSpace] gappedSequence is required when mode is "gapped"');
      return false;
    }

    const gappedNonGapCount = countNonGaps(coordinateSpace.gappedSequence);
    const biologicalLength = biologicalSequence.length;

    if (gappedNonGapCount !== biologicalLength) {
      console.warn(
        `[coordinateSpace] Gapped sequence has ${gappedNonGapCount} non-gap characters but biological sequence has ${biologicalLength} — falling back to biological mode`
      );
      return false;
    }
  }

  return true;
}

export function getEffectiveSequence(
  biologicalSequence: string,
  coordinateSpace: CoordinateSpace | undefined
): string {
  if (isGappedMode(coordinateSpace) && coordinateSpace?.gappedSequence) {
    return coordinateSpace.gappedSequence;
  }
  return biologicalSequence;
}

export function getEffectiveLength(
  biologicalSequence: string,
  coordinateSpace: CoordinateSpace | undefined
): number {
  if (isGappedMode(coordinateSpace) && coordinateSpace?.gappedSequence) {
    return coordinateSpace.gappedSequence.length;
  }
  return biologicalSequence.length;
}

export function getRulerStartIndex(_coordinateSpace: CoordinateSpace | undefined): number {
  return 1;
}

export function bioToGapped(bioPos: number, gappedSequence: string): number {
  if (bioPos < 1) {
    return -1;
  }

  let bioCount = 0;
  for (let col = 0; col < gappedSequence.length; col++) {
    if (gappedSequence[col] !== '-') {
      bioCount++;
      if (bioCount === bioPos) {
        return col;
      }
    }
  }

  return -1;
}

export function gappedToBioClamped(col: number, gappedSequence: string): number {
  if (gappedSequence.length === 0) return 1;
  let c = Math.max(0, Math.min(gappedSequence.length - 1, col));
  while (c > 0 && gappedSequence[c] === '-') c--;
  let bio = 0;
  for (let i = 0; i <= c; i++) {
    if (gappedSequence[i] !== '-') bio++;
  }
  return bio || 1;
}

export function gappedToBio(col: number, gappedSequence: string): number {
  if (col < 0 || col >= gappedSequence.length) {
    return -1;
  }

  if (gappedSequence[col] === '-') {
    return -1;
  }

  let bioCount = 0;
  for (let i = 0; i <= col; i++) {
    if (gappedSequence[i] !== '-') {
      bioCount++;
    }
  }

  return bioCount;
}

export interface AnnotationGapped {
  id: string;
  name: string;
  start: number;
  end: number;
  type: string;
  strand: 1 | -1;
  color?: string;
  startCol: number;
  endCol: number;
}

export function mapAnnotationToGapped<T extends { start: number; end: number }>(
  ann: T,
  gappedSequence: string
): T & { startCol: number; endCol: number } {
  const startCol = bioToGapped(ann.start, gappedSequence);
  const endColInclusive = bioToGapped(ann.end, gappedSequence);
  const endCol = endColInclusive >= 0 ? endColInclusive + 1 : -1;

  return {
    ...ann,
    startCol,
    endCol,
  };
}

export function mapAnnotationsToGapped<T extends { start: number; end: number }>(
  annotations: T[],
  coordinateSpace: CoordinateSpace | undefined
): (T & { startCol?: number; endCol?: number })[] {
  if (!isGappedMode(coordinateSpace) || !coordinateSpace?.gappedSequence) {
    return annotations;
  }

  return annotations.map((ann) => mapAnnotationToGapped(ann, coordinateSpace.gappedSequence!));
}
