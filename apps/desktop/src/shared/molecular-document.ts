import { z } from 'zod';
import {
  molecularViewSchema,
  PINNED_MOLECULAR_ASSET_NAME,
  validateMolecularViewCoordinates,
  type MolecularView,
} from './molecular-view';
import { MOLECULAR_DOCUMENT_FILE_SUFFIX } from './registry-file-types';
import {
  assertMolecularDocumentExtensionsSupported,
  molecularDocumentExtensionFields,
  MolecularDocumentCompatibilityError,
} from './molecular-document-extensions';
import {
  assertMolecularCoordinateSize,
  assertMolecularDocumentSize,
  jsonStringByteLength,
  MolecularStorageError,
  MOLECULAR_COORDINATE_MAX_BYTES,
  MOLECULAR_DOCUMENT_MAX_BYTES,
  utf8ByteLength,
  type MolecularCoordinateText,
} from './molecular-storage';
import {
  parseSavedResidueSelectionDocument,
  type SavedResidueSelectionDocument,
} from '@waypoint/workspace-editor/saved-residue-selection';

export const MOLECULAR_DOCUMENT_LEGACY_SCHEMA = 'dnaforge.molecular-document.v1' as const;
export const MOLECULAR_DOCUMENT_SCHEMA = 'dnaforge.molecular-document.v2' as const;
export const MOLECULAR_DOCUMENT_SUFFIX = MOLECULAR_DOCUMENT_FILE_SUFFIX;
export const MOLECULAR_DOCUMENT_FILE_KIND = 'dnaforge-molecular-document' as const;
export { MOLECULAR_DOCUMENT_MAX_BYTES } from './molecular-storage';

const documentIdentity = {
  schema: z.literal(MOLECULAR_DOCUMENT_SCHEMA),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  currentReferenceId: z.string().uuid(),
};

const savedSelectionSchema = z.unknown().transform((value, context) => {
  try {
    return parseSavedResidueSelectionDocument(JSON.stringify(value));
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'Invalid saved selection.',
      fatal: true,
    });
    return z.NEVER;
  }
}) as z.ZodType<SavedResidueSelectionDocument, z.ZodTypeDef, unknown>;

const currentMolecularDocumentSchema = z
  .object({
    ...documentIdentity,
    ...molecularDocumentExtensionFields,
    history: z
      .array(
        z
          .object({
            referenceId: z.string().uuid(),
            snapshot: molecularViewSchema,
          })
          .strict()
      )
      .min(1),
    selections: z.array(savedSelectionSchema).optional(),
  })
  .strict()
  .superRefine((document, context) => {
    assertMolecularDocumentExtensionsSupported(document);
    const ids = new Set<string>();
    for (const [index, entry] of document.history.entries()) {
      if (ids.has(entry.referenceId))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Molecular document result reference IDs must be unique.',
          path: ['history', index, 'referenceId'],
        });
      ids.add(entry.referenceId);
    }
    if (!ids.has(document.currentReferenceId))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The current molecular result must exist in the document history.',
        path: ['currentReferenceId'],
      });
    const digests = new Set(
      document.history.flatMap(({ snapshot }) => [
        snapshot.coordinates.sha256,
        ...(snapshot.version === 2 ? snapshot.pinnedAssets.map((asset) => asset.sha256) : []),
      ])
    );
    const selectionIds = new Set<string>();
    for (const [index, selection] of (document.selections ?? []).entries()) {
      if (selectionIds.has(selection.id))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Saved selection IDs in a molecular document must be unique.',
          path: ['selections', index, 'id'],
        });
      selectionIds.add(selection.id);
      for (const revision of selection.revisions)
        for (const structure of revision.structureRevisions)
          if (!digests.has(structure.coordinateDigestSha256))
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                'A saved selection must refer to coordinates held by its molecular document.',
              path: ['selections', index],
            });
    }
  });

export function isMolecularDocumentSchema(schema: unknown): schema is string {
  return typeof schema === 'string' && /^dnaforge\.molecular-document\.v[1-9]\d*$/u.test(schema);
}

const molecularDocumentMigrations = new Map<
  string,
  (document: Record<string, unknown>) => Record<string, unknown>
>([
  [
    MOLECULAR_DOCUMENT_LEGACY_SCHEMA,
    (document) => ({ ...document, schema: MOLECULAR_DOCUMENT_SCHEMA }),
  ],
]);

function migrateMolecularDocument(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  let document = value as Record<string, unknown>;
  const seen = new Set<unknown>();
  while (document.schema !== MOLECULAR_DOCUMENT_SCHEMA) {
    if (seen.has(document.schema))
      throw new MolecularDocumentCompatibilityError(
        'MOLECULAR_DOCUMENT_MIGRATION_FAILED',
        'Cyclic document upgrade.'
      );
    seen.add(document.schema);
    const migrate = molecularDocumentMigrations.get(String(document.schema));
    if (!migrate) {
      if (isMolecularDocumentSchema(document.schema))
        throw new MolecularDocumentCompatibilityError(
          'MOLECULAR_DOCUMENT_NEWER_FORMAT',
          `${document.schema} is not supported. Open this document in a compatible app.`
        );
      return document;
    }
    document = migrate(document);
  }
  return document;
}

export const molecularDocumentSchema = z.preprocess(
  migrateMolecularDocument,
  currentMolecularDocumentSchema
);

export type MolecularDocument = z.infer<typeof molecularDocumentSchema>;

export interface MolecularDocumentLocation {
  path: string;
  workspaceRoot: string;
}

export interface ImportedCoordinateLocation extends MolecularDocumentLocation {
  expectedSourceSha256?: string;
}

export interface SavedMolecularDocument extends MolecularDocumentLocation {
  document: MolecularDocument;

  revision: string;
  warning?: string;
}

export interface SaveMolecularDocumentRequest {
  document: unknown;
  destination: MolecularDocumentLocation;
  expectedRevision: string | null;
}

export interface ReconcileMolecularDocumentSourcesRequest extends MolecularDocumentLocation {
  entityId: string;
  documentHash: string;
}

export interface MolecularDocumentSourceProjection {
  entityId: string;
  revision: string;
  sourceLinkCount: number;
}

export interface MolecularDocumentsBridge {
  resolveImportedCoordinate(
    request: ImportedCoordinateLocation
  ): Promise<MolecularDocumentLocation | null>;
  reconcileSourceLinks(
    request: ReconcileMolecularDocumentSourcesRequest,
    mutationToken?: string
  ): Promise<MolecularDocumentSourceProjection>;
  read(request: MolecularDocumentLocation): Promise<SavedMolecularDocument>;
  save(request: SaveMolecularDocumentRequest): Promise<SavedMolecularDocument>;
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const coordinatePointerSchema = z
  .object({
    format: z.enum(['pdb', 'cif', 'bcif']),
    sha256: digestSchema,
  })
  .strict();
const pinnedPointerSchema = coordinatePointerSchema.extend({
  name: z.string().regex(PINNED_MOLECULAR_ASSET_NAME),
  label: z.string(),
  sourceReferenceId: z.string().uuid(),
});
const storedDocumentSchema = z
  .object({
    ...documentIdentity,
    ...molecularDocumentExtensionFields,
    coordinateAssets: z.record(digestSchema, z.string().min(1)),
    history: z
      .array(
        z
          .object({
            referenceId: z.string().uuid(),
            snapshot: z.record(z.unknown()),
          })
          .strict()
      )
      .min(1),
    selections: z.array(z.unknown()).optional(),
  })
  .strict();
export type StoredMolecularDocument = z.infer<typeof storedDocumentSchema>;

export function getCurrentMolecularSnapshot(document: MolecularDocument): MolecularView {
  const entry = document.history.find((entry) => entry.referenceId === document.currentReferenceId);
  if (!entry) throw new Error('The current molecular result is missing from its document.');
  return entry.snapshot;
}

export function molecularDocumentSummary(document: MolecularDocument) {
  const current = getCurrentMolecularSnapshot(document);
  return {
    currentReferenceId: document.currentReferenceId,
    revisionCount: document.history.length,
    sourceCount: new Set([
      current.coordinates.sha256,
      ...(current.version === 2 ? current.pinnedAssets.map((asset) => asset.sha256) : []),
    ]).size,
  };
}

export function packMolecularDocument(value: unknown): StoredMolecularDocument {
  const { selections, ...document } = molecularDocumentSchema.parse(value);
  const hasSelections = (selections?.length ?? 0) > 0;
  const coordinateAssets: Record<string, string> = {};
  const pool = <T extends MolecularView['coordinates']>(asset: T): Omit<T, 'text'> => {
    const previous = coordinateAssets[asset.sha256];
    if (previous !== undefined && previous !== asset.text)
      throw new Error('Conflicting molecular coordinate bytes have the same digest.');
    coordinateAssets[asset.sha256] = asset.text;
    const { text: _text, ...pointer } = asset;
    return pointer;
  };
  const history = document.history.map(({ referenceId, snapshot }) => ({
    referenceId,
    snapshot:
      snapshot.version === 2
        ? {
            ...snapshot,
            coordinates: pool(snapshot.coordinates),
            pinnedAssets: snapshot.pinnedAssets.map(pool),
          }
        : { ...snapshot, coordinates: pool(snapshot.coordinates) },
  }));
  return {
    ...document,
    coordinateAssets: Object.fromEntries(
      Object.entries(coordinateAssets).sort(([a], [b]) => a.localeCompare(b))
    ),
    history,
    ...(hasSelections ? { selections } : {}),
  };
}

export function serializeMolecularDocument(value: unknown): string {
  const content = JSON.stringify(packMolecularDocument(value), null, 2) + '\n';
  assertMolecularDocumentSize(utf8ByteLength(content));
  return content;
}

export function unpackMolecularDocument(value: unknown): MolecularDocument {
  const stored = storedDocumentSchema.parse(migrateMolecularDocument(value));
  const used = new Set<string>();
  const restore = <T extends { sha256: string }>(pointer: T) => {
    const text = stored.coordinateAssets[pointer.sha256];
    if (text === undefined) throw new Error('A pinned molecular coordinate asset is missing.');
    used.add(pointer.sha256);
    return { ...pointer, text };
  };
  const history = stored.history.map(({ referenceId, snapshot }) => ({
    referenceId,
    snapshot: {
      ...snapshot,
      coordinates: restore(coordinatePointerSchema.parse(snapshot.coordinates)),
      ...(snapshot.version === 2
        ? { pinnedAssets: z.array(pinnedPointerSchema).parse(snapshot.pinnedAssets).map(restore) }
        : {}),
    },
  }));
  if (Object.keys(stored.coordinateAssets).some((digest) => !used.has(digest)))
    throw new Error('The molecular document contains an unreferenced coordinate asset.');
  return molecularDocumentSchema.parse({
    schema: stored.schema,
    id: stored.id,
    name: stored.name,
    currentReferenceId: stored.currentReferenceId,
    ...(stored.extensions ? { extensions: stored.extensions } : {}),
    ...(stored.requiredExtensions ? { requiredExtensions: stored.requiredExtensions } : {}),
    history,
    ...(stored.selections ? { selections: stored.selections } : {}),
  });
}

export function parseMolecularDocument(bytes: string): MolecularDocument {
  return unpackMolecularDocument(JSON.parse(bytes));
}

export function packedMolecularDocumentByteLength(document: StoredMolecularDocument): number {
  const { coordinateAssets, ...metadata } = document;
  const emptyPool = Object.fromEntries(Object.keys(coordinateAssets).map((key) => [key, '']));
  const envelope = JSON.stringify({ ...metadata, coordinateAssets: emptyPool }, null, 2) + '\n';
  return (
    utf8ByteLength(envelope) +
    Object.values(coordinateAssets).reduce((sum, text) => sum + jsonStringByteLength(text) - 2, 0)
  );
}

export function assertMolecularDocumentStorage(
  assets: readonly MolecularCoordinateText[],
  previous?: MolecularDocument
): number {
  for (const asset of assets) assertMolecularCoordinateSize(asset);
  const packed = previous && packMolecularDocument(previous);
  const retained = new Set(Object.values(packed?.coordinateAssets ?? {}));
  let minimumBytes = packed ? packedMolecularDocumentByteLength(packed) : 0;
  assertMolecularDocumentSize(minimumBytes);
  for (const text of new Set(assets.map((asset) => asset.text))) {
    if (!retained.has(text)) {
      minimumBytes += jsonStringByteLength(text);
      assertMolecularDocumentSize(minimumBytes);
    }
  }
  return minimumBytes;
}

export function molecularDocumentStorageStatus(
  assets: readonly MolecularCoordinateText[],
  previous?: MolecularDocument
) {
  const limits = {
    maxCoordinateBytes: MOLECULAR_COORDINATE_MAX_BYTES,
    maxDocumentBytes: MOLECULAR_DOCUMENT_MAX_BYTES,
  };
  try {
    return {
      ...limits,
      status: 'available' as const,
      minimumDocumentBytes: assertMolecularDocumentStorage(assets, previous),
    };
  } catch (error) {
    if (!(error instanceof MolecularStorageError)) throw error;
    return { ...limits, status: 'over-limit' as const, code: error.code, message: error.message };
  }
}

export async function validateMolecularDocumentCoordinates(
  document: MolecularDocument
): Promise<void> {
  const validated = new Map<string, MolecularView['coordinates']>();
  for (const entry of document.history)
    await validateMolecularViewCoordinates(entry.snapshot, validated);
}

export function savedSelectionRefsForDocument(saved: {
  path: string;
  workspaceRoot: string;
  document: { selections?: ReadonlyArray<{ id: string; currentRevisionId: string }> };
}) {
  const root = saved.workspaceRoot.replace(/[\\/]+$/, '');
  const artifactPath = saved.path.startsWith(`${root}/`)
    ? saved.path.slice(root.length + 1)
    : saved.path;
  return (saved.document.selections ?? []).map((selection) => ({
    selectionId: selection.id,
    revisionId: selection.currentRevisionId,
    artifactPath,
    visible: true,
  }));
}
