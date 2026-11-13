import {
  DARK_RNA_FAMILY_COLORS,
  TRANSCRIPT_COLORS,
  isTranscriptSourceType,
  rnaAccentColorForMode,
  rnaCanonicalSourceColor,
  rnaColorFamilyForType,
  type RnaColorFamily,
  type TranscriptColorRole,
} from '../../../feature-colors';
import {
  DARK_ANNOTATION_LIGHTNESS_SCALE,
  webglAnnotationColorForMode,
  type WebGLThemeMode,
} from './theme';

export const INDEXED_ANNOTATION_COLOR_BASIS_THEME = 'light' as const;

const TRANSCRIPT_COLOR_ROLES = Object.freeze(
  Object.keys(TRANSCRIPT_COLORS.light) as TranscriptColorRole[]
);

const TRANSCRIPT_COLOR_PAIRS = Object.freeze(
  TRANSCRIPT_COLOR_ROLES.map((role) =>
    Object.freeze({
      light: TRANSCRIPT_COLORS.light[role],
      dark: TRANSCRIPT_COLORS.dark[role],
    })
  )
);

const RNA_FAMILY_ORDER = Object.freeze([
  'messenger',
  'longNonCoding',
  'nonCoding',
  'micro',
  'smallNucleolar',
  'smallNuclear',
  'transfer',
  'ribosomal',
] as const satisfies readonly RnaColorFamily[]);

const RNA_TRACK_TYPE_BY_FAMILY: Readonly<Record<RnaColorFamily, string>> = Object.freeze({
  messenger: 'mRNA',
  longNonCoding: 'lncRNA',
  nonCoding: 'ncRNA',
  micro: 'miRNA',
  smallNucleolar: 'snoRNA',
  smallNuclear: 'snRNA',
  transfer: 'tRNA',
  ribosomal: 'rRNA',
});

function rnaPaletteId(trackType: string): number {
  const family = rnaColorFamilyForType(trackType);
  return family ? RNA_FAMILY_ORDER.indexOf(family) + 1 : 0;
}

const TRANSCRIPT_PALETTE_DISTANCE_FLOOR = 1e-8;

export function indexedAnnotationRuntimeThemeUniforms(
  trackType: string,
  themeMode: WebGLThemeMode | undefined
): Readonly<{ themeDark: number; transcriptPalette: number; rnaPalette: number }> {
  return Object.freeze({
    themeDark: themeMode === 'dark' ? 1 : 0,
    transcriptPalette: isTranscriptSourceType(trackType) ? 1 : 0,
    rnaPalette: rnaPaletteId(trackType),
  });
}

export function indexedAnnotationColorForRuntimeTheme(
  canonicalColor: number,
  trackType: string,
  themeMode: WebGLThemeMode | undefined
): number {
  if (themeMode !== 'dark') return canonicalColor;
  if (isTranscriptSourceType(trackType)) {
    const canonical = colorChannels(canonicalColor);
    const projected = [0, 0, 0];
    let totalWeight = 0;
    const family = rnaColorFamilyForType(trackType);
    const pairs: Array<{ light: number; dark: number }> = TRANSCRIPT_COLOR_PAIRS.map(
      (pair, index) => ({
        light: pair.light,
        dark:
          family && TRANSCRIPT_COLOR_ROLES[index] === 'ncRnaExon'
            ? rnaAccentColorForMode(trackType, 'dark')
            : pair.dark,
      })
    );
    if (family) {
      pairs.push({
        light: rnaCanonicalSourceColor(trackType),
        dark: DARK_RNA_FAMILY_COLORS[family],
      });
    }
    for (const pair of pairs) {
      const light = colorChannels(pair.light);
      const dark = colorChannels(pair.dark);
      const redDelta = canonical[0] - light[0];
      const greenDelta = canonical[1] - light[1];
      const blueDelta = canonical[2] - light[2];
      const distanceSquared = redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta;
      const weight =
        1 / Math.max(TRANSCRIPT_PALETTE_DISTANCE_FLOOR, distanceSquared * distanceSquared);
      totalWeight += weight;
      projected[0] += dark[0] * weight;
      projected[1] += dark[1] * weight;
      projected[2] += dark[2] * weight;
    }
    return colorFromChannels(
      projected[0] / totalWeight,
      projected[1] / totalWeight,
      projected[2] / totalWeight
    );
  }
  return webglAnnotationColorForMode(canonicalColor, themeMode);
}

function colorChannels(color: number): readonly [number, number, number] {
  return [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255];
}

function colorFromChannels(red: number, green: number, blue: number): number {
  const channel = (value: number): number => Math.round(Math.max(0, Math.min(1, value)) * 255);
  return (channel(red) << 16) | (channel(green) << 8) | channel(blue);
}

function glslRgb(color: number): string {
  const red = ((color >> 16) & 0xff) / 255;
  const green = ((color >> 8) & 0xff) / 255;
  const blue = (color & 0xff) / 255;
  return `vec3(${red.toFixed(9)}, ${green.toFixed(9)}, ${blue.toFixed(9)})`;
}

const transcriptPaletteProjection = TRANSCRIPT_COLOR_ROLES.map(
  (role, index) => `
    vec3 transcriptPaletteDelta${index} = canonicalRgb - ${glslRgb(TRANSCRIPT_COLORS.light[role])};
    float transcriptPaletteDistanceSquared${index} = dot(
      transcriptPaletteDelta${index},
      transcriptPaletteDelta${index}
    );
    float transcriptPaletteWeight${index} = 1.0 / max(
      ${TRANSCRIPT_PALETTE_DISTANCE_FLOOR.toFixed(9)},
      transcriptPaletteDistanceSquared${index} * transcriptPaletteDistanceSquared${index}
    );
    transcriptPaletteColor += ${
      role === 'ncRnaExon'
        ? 'indexedAnnotationRnaAccent(rnaPalette)'
        : glslRgb(TRANSCRIPT_COLORS.dark[role])
    } * transcriptPaletteWeight${index};
    transcriptPaletteTotalWeight += transcriptPaletteWeight${index};`
).join('');

const rnaAccentBranches = RNA_FAMILY_ORDER.map(
  (family, index) =>
    `  if (rnaPalette < ${(index + 1.5).toFixed(1)}) return ${glslRgb(DARK_RNA_FAMILY_COLORS[family])};`
).join('\n');

const rnaCanonicalBranches = RNA_FAMILY_ORDER.map((family, index) => {
  const trackType = RNA_TRACK_TYPE_BY_FAMILY[family];
  return `  if (rnaPalette < ${(index + 1.5).toFixed(1)}) return ${glslRgb(
    rnaCanonicalSourceColor(trackType)
  )};`;
}).join('\n');

export const INDEXED_ANNOTATION_RUNTIME_THEME_GLSL = `
vec3 indexedAnnotationRnaAccent(float rnaPalette) {
${rnaAccentBranches}
  return ${glslRgb(TRANSCRIPT_COLORS.dark.ncRnaExon)};
}

vec3 indexedAnnotationRnaCanonical(float rnaPalette) {
${rnaCanonicalBranches}
  return ${glslRgb(TRANSCRIPT_COLORS.light.ncRnaExon)};
}

vec3 indexedAnnotationRgbToHsl(vec3 color) {
  float maximum = max(max(color.r, color.g), color.b);
  float minimum = min(min(color.r, color.g), color.b);
  float lightness = (maximum + minimum) * 0.5;
  float delta = maximum - minimum;
  if (delta <= 0.000001) return vec3(0.0, 0.0, lightness);
  float saturation = delta / max(0.000001, 1.0 - abs(2.0 * lightness - 1.0));
  float hue;
  if (maximum == color.r) {
    hue = mod((color.g - color.b) / delta, 6.0);
  } else if (maximum == color.g) {
    hue = (color.b - color.r) / delta + 2.0;
  } else {
    hue = (color.r - color.g) / delta + 4.0;
  }
  hue = mod(hue / 6.0 + 1.0, 1.0);
  return vec3(hue, saturation, lightness);
}

float indexedAnnotationHueChannel(float p, float q, float t) {
  float wrapped = mod(t + 1.0, 1.0);
  if (wrapped < 1.0 / 6.0) return p + (q - p) * 6.0 * wrapped;
  if (wrapped < 0.5) return q;
  if (wrapped < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - wrapped) * 6.0;
  return p;
}

vec3 indexedAnnotationHslToRgb(vec3 hsl) {
  if (hsl.y <= 0.000001) return vec3(hsl.z);
  float q = hsl.z < 0.5
    ? hsl.z * (1.0 + hsl.y)
    : hsl.z + hsl.y - hsl.z * hsl.y;
  float p = 2.0 * hsl.z - q;
  return vec3(
    indexedAnnotationHueChannel(p, q, hsl.x + 1.0 / 3.0),
    indexedAnnotationHueChannel(p, q, hsl.x),
    indexedAnnotationHueChannel(p, q, hsl.x - 1.0 / 3.0)
  );
}

vec3 indexedAnnotationRuntimeThemeColor(
  vec3 canonicalRgb,
  float themeDark,
  float transcriptPalette,
  float rnaPalette
) {
  if (themeDark < 0.5) return canonicalRgb;
  if (transcriptPalette > 0.5) {
    vec3 transcriptPaletteColor = vec3(0.0);
    float transcriptPaletteTotalWeight = 0.0;${transcriptPaletteProjection}
    if (rnaPalette > 0.5) {
      vec3 rnaSourceDelta = canonicalRgb - indexedAnnotationRnaCanonical(rnaPalette);
      float rnaSourceDistanceSquared = dot(rnaSourceDelta, rnaSourceDelta);
      float rnaSourceWeight = 1.0 / max(
        ${TRANSCRIPT_PALETTE_DISTANCE_FLOOR.toFixed(9)},
        rnaSourceDistanceSquared * rnaSourceDistanceSquared
      );
      transcriptPaletteColor += indexedAnnotationRnaAccent(rnaPalette) * rnaSourceWeight;
      transcriptPaletteTotalWeight += rnaSourceWeight;
    }
    return transcriptPaletteColor / max(0.000001, transcriptPaletteTotalWeight);
  }
  vec3 hsl = indexedAnnotationRgbToHsl(canonicalRgb);
  float adjustedLightness = (0.24 + hsl.z * 0.18) * ${DARK_ANNOTATION_LIGHTNESS_SCALE.toFixed(9)};
  float adjustedSaturation = hsl.y < 0.05 ? hsl.y : hsl.y * 0.58;
  return indexedAnnotationHslToRgb(vec3(hsl.x, adjustedSaturation, adjustedLightness));
}
`;
