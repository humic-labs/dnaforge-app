import { z } from 'zod';
import { molecularScientificReviewSchema } from './molecular-scientific-review';
import {
  molecularViewSchema as legacyMolecularViewSchema,
  molecularViewEvidenceSchema,
  molecularCoordinatesSchema,
} from './molecular-view-schema';
import { binaryCoordinateBytes, isBinaryCoordinateText } from './binary-coordinates';
import { assertMolecularCoordinateSize } from './molecular-storage';
import { DocumentReadError } from './document-read-failure';
import {
  molecularDataDigest,
  validateMolecularDataMapping,
  compileMolecularDataColors,
} from './molecular-data';
export {
  molecularViewEvidenceSchema,
  molecularPredictionSchema,
  molecularAlleleSchema,
  molecularComparisonSchema,
  molecularCoordinatesSchema,
  type MolecularPrediction,
  type MolecularAllele,
  type MolecularComparison,
} from './molecular-view-schema';

export { MOLECULAR_COORDINATE_MAX_BYTES as MOLECULAR_VIEW_MAX_COORDINATE_BYTES } from './molecular-storage';

const molecularViewBaseSchema = z
  .object({
    kind: z.literal('molecular-view'),
    title: z.string().min(1).max(200),
    caption: z.string().max(2000),
    scene: z.string().min(1).max(500_000),
    initialSnapshotIndex: z.number().int().nonnegative().optional(),
    cameraSnapshot: z.string().max(10_000).optional(),
    coordinates: molecularCoordinatesSchema,
    source: legacyMolecularViewSchema.shape.source.extend({
      artifactEntityId: z.string().min(1).max(500).optional(),
      artifactRevisionId: z.string().min(1).max(500).optional(),
    }),
    measurements: legacyMolecularViewSchema.shape.measurements,
    activeMeasurementId: legacyMolecularViewSchema.shape.activeMeasurementId,
    molecularData: legacyMolecularViewSchema.shape.molecularData,
    evidence: z.array(molecularViewEvidenceSchema).max(20),
    scientificReview: molecularScientificReviewSchema.optional(),
    preview: z
      .string()
      .max(2_000_000)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
    createdAt: z.number().int().nonnegative(),
    presentation: z
      .object({
        id: z.string().uuid(),
        parentReferenceId: z.string().uuid().optional(),
        changeSummary: z.string().min(1).max(1000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const PINNED_MOLECULAR_ASSET_NAME = /^asset-[2-4]\.(?:pdb|cif|bcif)$/;
const pinnedAssetSchema = molecularCoordinatesSchema.extend({
  name: z.string().regex(PINNED_MOLECULAR_ASSET_NAME),
  label: z.string().min(1).max(200),
  sourceReferenceId: z.string().uuid(),
});
export const molecularViewSchema = z.union([
  molecularViewBaseSchema.extend({ version: z.literal(1) }),
  molecularViewBaseSchema.extend({
    version: z.literal(2),
    scene: z.string().min(1).max(2_000_000),
    primarySourceReferenceId: z.string().uuid(),
    pinnedAssets: z.array(pinnedAssetSchema).min(1).max(3),
  }),
]);
export type MolecularView = z.infer<typeof molecularViewSchema>;
export type PinnedMolecularAsset = z.infer<typeof pinnedAssetSchema>;

export const molecularViewDocumentIdentitySchema = z
  .object({
    id: z.string().uuid(),
    path: z.string().min(1),
    revision: z.string().regex(/^[0-9a-f]{64}$/),
    savedReferenceId: z.string().uuid(),
  })
  .strict();

export const molecularViewTargetSchema = z
  .object({
    kind: z.literal('molecular-view-target'),
    version: z.literal(1),
    viewReferenceId: z.string().uuid(),
    viewId: z.string().min(1).max(1000).optional(),
    snapshotIndex: z.number().int().nonnegative().optional(),
    groupId: z.string().min(1).max(1000).optional(),
    document: molecularViewDocumentIdentitySchema.optional(),
  })
  .strict()
  .refine((target) => target.viewId !== undefined || target.snapshotIndex !== undefined, {
    message: 'A molecular target requires a stable view ID or a legacy snapshot index.',
  });
export type MolecularViewTarget = z.infer<typeof molecularViewTargetSchema>;

export function molecularViewTargetFromReferenceData(
  data: string | null
): MolecularViewTarget | null {
  if (!data) return null;
  try {
    const parsed = molecularViewTargetSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function molecularViewFromReferenceData(data: string | null): MolecularView | null {
  if (!data) return null;
  try {
    const parsed = molecularViewSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function coordinateDigest(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function molecularViewSourceDigests(view: MolecularView): string[] {
  const primary = `structure.${view.coordinates.format}`;
  const digests = new Map([
    [primary, view.coordinates.sha256],
    ...(view.version === 2
      ? view.pinnedAssets.map((asset) => [asset.name, asset.sha256] as [string, string])
      : []),
  ]);
  const document = JSON.parse(view.scene);
  const used = new Set<string>();
  const visit = (
    node: { kind?: string; params?: { url?: string }; children?: (typeof node)[] },
    uri = primary
  ) => {
    if (node.kind === 'download') uri = String(node.params?.url);
    if (node.kind === 'structure' && digests.has(uri)) used.add(digests.get(uri)!);
    for (const child of node.children ?? []) visit(child, uri);
  };
  if (document.kind === 'multiple') for (const snapshot of document.snapshots) visit(snapshot.root);
  else visit(document.root);
  return [...used];
}

export async function validateMolecularViewCoordinates(
  view: MolecularView,
  validated = new Map<string, MolecularView['coordinates']>()
): Promise<void> {
  if (
    view.scientificReview &&
    (await coordinateDigest(view.scene)) !== view.scientificReview.savedSceneDigestSha256
  )
    throw new Error('Saved scientific review digest does not match its exact scene.');
  const assets = [view.coordinates, ...(view.version === 2 ? view.pinnedAssets : [])];
  for (const asset of assets) {
    const previous = validated.get(asset.sha256);
    if (previous?.format === asset.format && previous.text === asset.text) continue;
    assertMolecularCoordinateSize(asset);
    if (asset.format === 'bcif' && !isBinaryCoordinateText(asset.text))
      throw new DocumentReadError('coordinates', true, {
        detail: 'Saved binary coordinates are not valid base64.',
      });
    if ((await coordinateDigest(asset.text)) !== asset.sha256)
      throw new DocumentReadError('coordinates', true, {
        detail: 'Saved molecular coordinate digest does not match its pinned bytes.',
      });
    validated.set(asset.sha256, asset);
  }
  if (view.molecularData) {
    for (const dataset of view.molecularData.datasets) {
      const { revision, ...contents } = dataset;
      if ((await molecularDataDigest(contents)) !== revision)
        throw new Error('Saved data does not match its pinned revision.');
    }
    for (const mapping of view.molecularData.mappings) {
      const { revision, ...contents } = mapping;
      if (
        (await molecularDataDigest(contents)) !== revision ||
        mapping.coordinateSha256 !== view.coordinates.sha256 ||
        !view.molecularData.datasets.some(
          (dataset) => dataset.id === mapping.datasetId && dataset.revision === mapping.dataRevision
        )
      )
        throw new Error('Saved molecular mappings do not match their data or coordinates.');
      validateMolecularDataMapping(
        view.molecularData.datasets.find(
          (dataset) => dataset.id === mapping.datasetId && dataset.revision === mapping.dataRevision
        )!,
        mapping
      );
    }
    for (const layer of view.molecularData.layers) {
      const mapping = view.molecularData.mappings.find(
        (mapping) =>
          mapping.revision === layer.mappingRevision &&
          mapping.dataRevision === layer.dataRevision &&
          mapping.datasetId === layer.datasetId
      );
      const dataset = view.molecularData.datasets.find(
        (dataset) => dataset.id === layer.datasetId && dataset.revision === layer.dataRevision
      );
      if (!mapping || !dataset) throw new Error('A saved data layer refers to an absent revision.');
      compileMolecularDataColors(dataset, mapping, layer);
    }
    if (
      view.molecularData.activeLayerId &&
      !view.molecularData.layers.some((layer) => layer.id === view.molecularData!.activeLayerId)
    )
      throw new Error('The saved active data layer is missing.');
  }
  if (
    view.source.allele &&
    view.source.prediction &&
    view.source.allele.proteinSequenceSha256 !== view.source.prediction.proteinSequenceSha256
  )
    throw new Error('The saved allele and prediction name different protein products.');
  const comparison = view.source.comparison;
  if (comparison) {
    if (view.source.prediction || view.source.allele)
      throw new Error('A comparison is a pair of models, not one predicted allele.');
    if (comparison.coordinateSha256 !== view.coordinates.sha256)
      throw new Error('Saved comparison provenance names different molecular coordinates.');
    for (const input of [comparison.reference, comparison.alternate]) {
      assertMolecularCoordinateSize(input.coordinates);
      if ((await coordinateDigest(input.coordinates.text)) !== input.coordinates.sha256)
        throw new Error('A saved comparison source does not match its pinned coordinate bytes.');
      if (
        input.prediction &&
        (input.prediction.coordinateSha256 !== input.coordinates.sha256 ||
          input.prediction.proteinSequenceSha256 !== (await coordinateDigest(input.sequence)))
      )
        throw new Error('A comparison prediction names a different protein or coordinate model.');
    }
    if (
      (await coordinateDigest(comparison.reference.sequence)) !==
        comparison.allele.referenceProteinSha256 ||
      (await coordinateDigest(comparison.alternate.sequence)) !==
        comparison.allele.proteinSequenceSha256
    )
      throw new Error('The comparison sources do not match the translated allele.');
    const mapping = comparison.allele.alternateToReference;
    const mapped = mapping.filter((position): position is number => position !== null);
    if (
      comparison.reference.sequence.length !== comparison.allele.referenceLength ||
      comparison.alternate.sequence.length !== comparison.allele.proteinLength ||
      mapped.some((p, i) => i > 0 && p <= mapped[i - 1]) ||
      comparison.alignment.pairs.some(
        (p) =>
          mapping[p.alternate] !== p.reference ||
          comparison.reference.sequence[p.reference] !== comparison.alternate.sequence[p.alternate]
      )
    )
      throw new Error('The comparison alignment does not match its residue correspondence.');
  }
  if (view.source.prediction && view.source.prediction.coordinateSha256 !== view.coordinates.sha256)
    throw new Error('Saved prediction provenance names different molecular coordinates.');
  if (
    view.source.catalogObservation &&
    view.source.catalogObservation.coordinateSha256 !== view.coordinates.sha256 &&
    (view.coordinates.format !== 'bcif' ||
      view.source.catalogObservation.coordinateSha256 !==
        (await coordinateDigest(binaryCoordinateBytes(view.coordinates.text))))
  )
    throw new Error('Saved structure provenance names different molecular coordinates.');

  const pinned = view.version === 2 ? view.pinnedAssets : [];
  const allowed = new Set([
    `structure.${view.coordinates.format}`,
    ...pinned.map((asset) => asset.name),
  ]);
  if (allowed.size !== pinned.length + 1)
    throw new Error('Saved molecular assets require unique resource names.');
  if (pinned.some((asset) => !asset.name.endsWith(`.${asset.format}`)))
    throw new Error('Saved molecular asset format does not match its resource name.');
  const document = JSON.parse(view.scene);
  const pending =
    document.kind === 'multiple'
      ? document.snapshots?.map((snapshot: { root: unknown }) => snapshot.root)
      : [document.root];
  if (!Array.isArray(pending) || !pending.length)
    throw new Error('Saved molecular scene requires at least one root.');
  if (pending.some((root) => !root || root.kind !== 'root'))
    throw new Error('Saved molecular scene has an invalid root.');
  let visited = 0;
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object' || typeof node.kind !== 'string' || ++visited > 2000)
      throw new Error('Saved molecular scene is invalid or exceeds the node limit.');
    for (const key of ['url', 'uri']) {
      const uri = node.params?.[key];
      if (uri !== undefined && !allowed.has(String(uri)))
        throw new Error('Saved molecular scene uses a resource that is not pinned.');
    }
    if (node.children !== undefined && !Array.isArray(node.children))
      throw new Error('Saved molecular scene children must be an array.');
    pending.push(...(node.children ?? []));
  }
}
