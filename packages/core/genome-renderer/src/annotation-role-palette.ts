import {
  rnaAccentColorForMode,
  rnaColorFamilyForType,
  transcriptColorForMode,
  type RnaColorFamily,
} from './feature-colors';
import { webglAnnotationColorForMode, type WebGLThemeMode } from './renderers/pixi/shared/theme';

export type AnnotationColorRoleKeyV1 =
  | 'transcript:intron'
  | 'transcript:utr'
  | 'transcript:cdsThick'
  | `rna-accent:${RnaColorFamily | 'none'}`
  | `source:${string}`;

export const ANNOTATION_ROLE_PALETTE_MAX_WEIGHTED_ROLES_V1 = 4;

export const ANNOTATION_ROLE_PALETTE_MAX_SHADED_ROLES_V1 = 32;

export type AnnotationRolePaletteOverridesV1 = Readonly<
  Partial<Record<AnnotationColorRoleKeyV1, number>>
>;

const RNA_FAMILIES: ReadonlySet<string> = new Set<RnaColorFamily>([
  'messenger',
  'longNonCoding',
  'nonCoding',
  'micro',
  'smallNucleolar',
  'smallNuclear',
  'transfer',
  'ribosomal',
]);

export function isAnnotationColorRoleKeyV1(value: unknown): value is AnnotationColorRoleKeyV1 {
  if (typeof value !== 'string') return false;
  if (
    value === 'transcript:intron' ||
    value === 'transcript:utr' ||
    value === 'transcript:cdsThick'
  ) {
    return true;
  }
  if (value.startsWith('rna-accent:')) {
    const family = value.slice('rna-accent:'.length);
    return family === 'none' || RNA_FAMILIES.has(family);
  }
  return /^source:[0-9a-f]{6}$/.test(value);
}

export function sourceShapeRoleKeyV1(color: number): AnnotationColorRoleKeyV1 {
  if (!Number.isInteger(color) || color < 0 || color > 0xffffff) {
    throw new Error('annotation source-shape colour is not a 24-bit integer');
  }
  return `source:${color.toString(16).padStart(6, '0')}`;
}

export function rnaAccentRoleKeyV1(transcriptType: string): AnnotationColorRoleKeyV1 {
  return `rna-accent:${rnaColorFamilyForType(transcriptType) ?? 'none'}`;
}

export function resolveAnnotationRoleColorV1(
  key: AnnotationColorRoleKeyV1,
  theme: WebGLThemeMode,
  overrides?: AnnotationRolePaletteOverridesV1
): number {
  const override = overrides?.[key];
  if (override !== undefined) return override;
  switch (key) {
    case 'transcript:intron':
      return transcriptColorForMode('intron', theme);
    case 'transcript:utr':
      return transcriptColorForMode('utr', theme);
    case 'transcript:cdsThick':
      return transcriptColorForMode('cdsThick', theme);
  }
  if (key.startsWith('rna-accent:')) {
    const family = key.slice('rna-accent:'.length);
    return rnaAccentColorForMode(RNA_FAMILY_REPRESENTATIVE_TYPE[family] ?? 'none', theme);
  }
  if (!isAnnotationColorRoleKeyV1(key)) throw new Error(`unknown annotation colour role ${key}`);
  return webglAnnotationColorForMode(Number.parseInt(key.slice('source:'.length), 16), theme);
}

const RNA_FAMILY_REPRESENTATIVE_TYPE: Readonly<Record<string, string>> = Object.freeze({
  messenger: 'mRNA',
  longNonCoding: 'lncRNA',
  nonCoding: 'ncRNA',
  micro: 'miRNA',
  smallNucleolar: 'snoRNA',
  smallNuclear: 'snRNA',
  transfer: 'tRNA',
  ribosomal: 'rRNA',
});

export class AnnotationRolePaletteBuilderV1 {
  readonly #indexByRole = new Map<AnnotationColorRoleKeyV1, number>();
  readonly #roles: AnnotationColorRoleKeyV1[] = [];

  indexOf(role: AnnotationColorRoleKeyV1): number {
    let index = this.#indexByRole.get(role);
    if (index === undefined) {
      index = this.#roles.length;
      this.#indexByRole.set(role, index);
      this.#roles.push(role);
    }
    return index;
  }

  get roles(): readonly AnnotationColorRoleKeyV1[] {
    return this.#roles;
  }
}

export function packAnnotationRolePaletteMat4V1(
  roles: readonly AnnotationColorRoleKeyV1[],
  theme: WebGLThemeMode,
  overrides?: AnnotationRolePaletteOverridesV1
): Float32Array {
  if (roles.length > ANNOTATION_ROLE_PALETTE_MAX_WEIGHTED_ROLES_V1) {
    throw new Error('annotation role palette exceeds the four-weight cell');
  }
  return packRoleColumns(roles, theme, overrides, 16);
}

export function packAnnotationRolePaletteVec4ArrayV1(
  roles: readonly AnnotationColorRoleKeyV1[],
  theme: WebGLThemeMode,
  overrides?: AnnotationRolePaletteOverridesV1
): Float32Array {
  if (roles.length > ANNOTATION_ROLE_PALETTE_MAX_SHADED_ROLES_V1) {
    throw new Error('annotation role palette exceeds the shader palette');
  }
  return packRoleColumns(roles, theme, overrides, ANNOTATION_ROLE_PALETTE_MAX_SHADED_ROLES_V1 * 4);
}

function packRoleColumns(
  roles: readonly AnnotationColorRoleKeyV1[],
  theme: WebGLThemeMode,
  overrides: AnnotationRolePaletteOverridesV1 | undefined,
  length: number
): Float32Array {
  const packed = new Float32Array(length);
  roles.forEach((role, column) => {
    const color = resolveAnnotationRoleColorV1(role, theme, overrides);
    packed[column * 4] = ((color >> 16) & 0xff) / 255;
    packed[column * 4 + 1] = ((color >> 8) & 0xff) / 255;
    packed[column * 4 + 2] = (color & 0xff) / 255;
  });
  return packed;
}

export function markAnnotationRoleCodedInstancesV1(
  instances: Float32Array,
  roleIndices: Uint8Array,
  strideFloats: number,
  colorOffset: number
): void {
  if (instances.length !== roleIndices.length * strideFloats) {
    throw new Error('annotation role indices are not parallel to the glyph records');
  }
  for (let record = 0; record < roleIndices.length; record++) {
    instances[record * strideFloats + colorOffset] = -(roleIndices[record] + 1);
  }
}
