import type { FeatureKind } from '@waypoint/genome-data/annotation-catalog';

import { annotationTypeAccentColor } from '../../../../feature-colors';
import { webglAnnotationColorForMode, type WebGLThemeMode } from '../../shared/theme';
import { normalizeTrackColor } from '../track-presentation';

const TRANSCRIPTION_UNIT_COLOR = { light: 0x475569, dark: 0x94a3b8 } as const;

export function catalogKindColor(kind: FeatureKind, mode: WebGLThemeMode): number {
  switch (kind) {
    case 'promoter':
      return annotationTypeAccentColor('promoter', mode);
    case 'terminator':
      return annotationTypeAccentColor('terminator', mode);
    case 'tss':
      return annotationTypeAccentColor('regulatory', mode);
    case 'transcription_unit':
      return TRANSCRIPTION_UNIT_COLOR[mode];
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function catalogTrackColor(
  kind: FeatureKind,
  presentationColor: string | undefined,
  mode: WebGLThemeMode
): number {
  const override = normalizeTrackColor(presentationColor);
  if (override === null) return catalogKindColor(kind, mode);
  return webglAnnotationColorForMode(Number.parseInt(override.slice(1), 16), mode);
}

export const TRANSCRIPTION_UNIT_GENE_PALETTE: Readonly<Record<WebGLThemeMode, readonly number[]>> =
  {
    light: [0xf76707, 0x0ca678, 0x7048e8, 0xd6336c, 0x1c7ed6, 0xf08c00, 0x1098ad, 0x66a80f],
    dark: [0xffa94d, 0x38d9a9, 0x9775fa, 0xf783ac, 0x4dabf7, 0xffd43b, 0x3bc9db, 0xa9e34b],
  };
