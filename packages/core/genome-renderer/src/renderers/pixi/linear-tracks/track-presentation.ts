import type { TrackPresentationMetadata } from '../../../tracks/types';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function normalizeTrackColor(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized && HEX_COLOR.test(normalized) ? normalized.toLowerCase() : null;
}

export function trackRowHeightPx(
  presentation: Readonly<TrackPresentationMetadata>,
  fallback: number
): number {
  const value = presentation.rowHeightPx;
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.min(512, value as number) : fallback;
}

export function trackMaxRows(
  presentation: Readonly<TrackPresentationMetadata>,
  fallback: number
): number {
  const value = presentation.maxRows;
  return Number.isInteger(value) && (value ?? 0) > 0 ? Math.min(32_767, value as number) : fallback;
}
