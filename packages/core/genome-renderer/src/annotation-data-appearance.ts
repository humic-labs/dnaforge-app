export const ANNOTATION_DATA_APPEARANCE_V1 = 'annotation-data-appearance.v1' as const;

export interface SourceAnnotationAliasesV1 {
  readonly featureIndex: number;
  readonly aliases: readonly string[];
}

export interface AnnotationDataAppearanceV1 {
  readonly contract: typeof ANNOTATION_DATA_APPEARANCE_V1;
  readonly colors: readonly (readonly [string, number])[];
  readonly missingColor?: number;
  readonly themeMode: 'light' | 'dark';
  readonly fingerprint: string;
}

export interface AnnotationDataColorsV1 {
  readonly colors: ReadonlyMap<string, number>;
  readonly missingColor?: number;
  readonly sourceBindings?: readonly SourceAnnotationAliasBindingV1[];
}

export interface SourceAnnotationAliasBindingV1 {
  readonly payloadSha256: string;
  readonly contractSha256: string;
  readonly aliases: readonly SourceAnnotationAliasesV1[];
}

export function annotationAliasesForSceneV1(
  scene: {
    readonly sourceAnnotationAliases?: readonly SourceAnnotationAliasesV1[];
    readonly sourceAnnotationIdentity?: {
      readonly payloadSha256: string;
      readonly contractSha256: string;
    };
  },
  appearance?: AnnotationDataColorsV1
): readonly SourceAnnotationAliasesV1[] | undefined {
  if (scene.sourceAnnotationAliases) return scene.sourceAnnotationAliases;
  const identity = scene.sourceAnnotationIdentity;
  return (
    identity &&
    appearance?.sourceBindings?.find(
      (binding) =>
        binding.payloadSha256 === identity.payloadSha256 &&
        binding.contractSha256 === identity.contractSha256
    )?.aliases
  );
}

export function assertSourceAnnotationAliasesV1(
  table: readonly SourceAnnotationAliasesV1[],
  featureCount: number
): void {
  if (!Array.isArray(table)) throw new Error('Source annotation aliases are unavailable.');
  const indices = new Set<number>();
  for (const entry of table) {
    if (
      !entry ||
      !Number.isSafeInteger(entry.featureIndex) ||
      entry.featureIndex < 0 ||
      entry.featureIndex >= featureCount ||
      indices.has(entry.featureIndex) ||
      !Array.isArray(entry.aliases) ||
      entry.aliases.some(
        (alias) => typeof alias !== 'string' || !alias || /[\r\n\0]/.test(alias)
      ) ||
      new Set(entry.aliases).size !== entry.aliases.length
    )
      throw new Error('Source annotation aliases do not fit the compiled scene.');
    indices.add(entry.featureIndex);
  }
}

export function sourceAnnotationAliasesV1(
  qualifiers: Readonly<Record<string, string | undefined>> | undefined
): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        ['ID', 'locus_tag', 'gene_id', 'transcript_id'].flatMap((key) =>
          qualifiers?.[key] ? [qualifiers[key]!] : []
        )
      ),
    ].sort()
  );
}

export async function compileAnnotationDataAppearanceV1(input: {
  readonly colors: readonly (readonly [string, number])[];
  readonly missingColor?: number;
  readonly themeMode: 'light' | 'dark';
}): Promise<AnnotationDataAppearanceV1> {
  if (
    !input ||
    !Array.isArray(input.colors) ||
    input.colors.length > 100_000 ||
    (input.themeMode !== 'light' && input.themeMode !== 'dark')
  ) {
    throw new Error('Annotation data appearance is invalid.');
  }
  const identifiers = new Set<string>();
  const colors = input.colors
    .map((entry) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        !entry[0] ||
        /[\r\n\0]/.test(entry[0]) ||
        identifiers.has(entry[0])
      ) {
        throw new Error('Annotation data appearance identifiers are invalid.');
      }
      assertRgb(entry[1]);
      identifiers.add(entry[0]);
      return Object.freeze([entry[0], entry[1]] as const);
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (input.missingColor !== undefined) assertRgb(input.missingColor);
  const material = {
    contract: ANNOTATION_DATA_APPEARANCE_V1,
    colors: Object.freeze(colors),
    ...(input.missingColor === undefined ? {} : { missingColor: input.missingColor }),
    themeMode: input.themeMode,
  };
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(material))
  );
  return Object.freeze({
    ...material,
    fingerprint: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join(''),
  });
}

export function annotationDataColorsByFeatureV1(
  aliases: readonly SourceAnnotationAliasesV1[],
  appearance: AnnotationDataColorsV1
): ReadonlyMap<number, number> {
  const resolved = new Map<number, number>();
  for (const entry of aliases) {
    let color: number | undefined;
    for (const alias of entry.aliases) {
      const candidate = appearance.colors.get(alias);
      if (candidate === undefined) continue;
      assertRgb(candidate);
      if (color !== undefined && candidate !== color) {
        throw new Error('Annotation data aliases resolve to conflicting measurements.');
      }
      color = candidate;
    }
    if (color !== undefined) resolved.set(entry.featureIndex, color);
  }
  return resolved;
}

export function packAnnotationDataAppearanceBytesV1(
  featureIndices: ArrayLike<number>,
  colors: ReadonlyMap<number, number>,
  missingColor?: number
): Uint8Array {
  if (missingColor !== undefined) assertRgb(missingColor);
  const bytes = new Uint8Array(featureIndices.length * 4);
  for (let index = 0; index < featureIndices.length; index++) {
    const color = colors.get(featureIndices[index]) ?? missingColor;
    if (color === undefined) continue;
    assertRgb(color);
    bytes[index * 4] = color >>> 16;
    bytes[index * 4 + 1] = color >>> 8;
    bytes[index * 4 + 2] = color;
    bytes[index * 4 + 3] = 255;
  }
  return bytes;
}

function assertRgb(color: number): void {
  if (!Number.isSafeInteger(color) || color < 0 || color > 0xffffff) {
    throw new Error('Annotation data color is not an RGB value.');
  }
}

export function annotationDataAppearanceArtifactKeyV1(
  artifactKey: string,
  fingerprint: string
): string {
  if (!/^[0-9a-f]{64}$/.test(fingerprint))
    throw new Error('Annotation appearance fingerprint is invalid.');
  return `${artifactKey}:annotation-data-display-rgb.v1:${fingerprint}`;
}

export function isAnnotationDataAppearanceArtifactV1(artifactKey: string): boolean {
  return /:annotation-data-display-rgb\.v1:[0-9a-f]{64}$/.test(artifactKey);
}
