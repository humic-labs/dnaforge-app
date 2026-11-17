import { z } from 'zod';

import { googleSpreadsheetIdSchema, googleWorksheetIdSchema } from '../../google-sheets';

import { LIMS_ENTITY_KINDS } from '../../lims-kinds';

import { isAbsolutePathLike, isSafeWorkspaceRelativePath } from '../../path-boundary';

import { sha256Hex } from '../../primer-artifacts/primer-artifact';

import { planSheetSync, type SheetSyncValue } from './planner';

const valueSchema: z.ZodType<SheetSyncValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(valueSchema),
    z.record(valueSchema),
  ])
);

const nonempty = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);

const relativePath = nonempty.refine(
  isSafeWorkspaceRelativePath,
  'The sync artifact must remain inside its project.'
);

const recordSchema = z
  .object({
    kind: nonempty,
    name: nonempty,
    fields: z.record(valueSchema),
    oligoNotation: nonempty.optional(),
  })
  .strict();

const revisionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const rowKeySchema = nonempty.refine((value) => value === value.trim());

const pendingSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('create'),
      rows: z
        .array(
          z.discriminatedUnion('owner', [
            z
              .object({
                owner: z.literal('primer'),
                entityId: nonempty,
                key: rowKeySchema,
                artifactRelativePath: relativePath,
              })
              .strict(),
            z
              .object({ owner: z.literal('record'), key: rowKeySchema, entityId: nonempty })
              .strict(),
          ])
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('update-record'),
      key: rowKeySchema,
      entityId: nonempty,
      operationId: z.string().uuid(),
      expectedEventSeq: z.number().int().positive(),
      name: nonempty,
      fields: z.record(valueSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('update-primer'),
      key: rowKeySchema,
      entityId: nonempty,
      artifactRelativePath: relativePath,
      priorContent: nonempty,
    })
    .strict(),
]);

const sourceMappingSchema = z.object({
  keyColumn: nonempty,
  forcedKind: z.enum(LIMS_ENTITY_KINDS),
  columnMappings: z.array(
    z
      .object({
        sourceColumn: nonempty,
        mappedField: z.string().optional(),
        mappingMode: z.enum(['mapped', 'source_only', 'ignored']).optional(),
        confidence: z
          .enum(['deterministic', 'agent_suggested', 'user_overridden', 'learned'])
          .optional(),
      })
      .strict()
  ),
});

export const excelSourceSchema = sourceMappingSchema
  .extend({ path: nonempty.refine(isAbsolutePathLike), sheetName: nonempty })
  .strict();

export const googleSourceSchema = sourceMappingSchema
  .extend({
    provider: z.literal('google-sheets'),
    spreadsheetId: googleSpreadsheetIdSchema,
    sheetId: googleWorksheetIdSchema,
  })
  .strict();

export type GoogleSyncSource = z.infer<typeof googleSourceSchema>;

const connectionSchema = z
  .object({
    schema: z.literal('dnaforge.sheet-sync'),
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    importSetId: nonempty,
    source: z.union([excelSourceSchema, googleSourceSchema]),
    destinationRelativePath: z
      .string()
      .refine((value) => value === '' || isSafeWorkspaceRelativePath(value)),
    revision: revisionSchema,
    enabled: z.boolean().default(true),
    finalization: z
      .object({
        id: z.string().uuid(),
        sourceRevision: revisionSchema,
        snapshotPaths: z.array(relativePath),
      })
      .strict()
      .nullable()
      .default(null),
    pending: z
      .object({
        revision: revisionSchema,
        snapshotHash: revisionSchema,
        snapshotRelativePath: relativePath,
        operation: pendingSchema,
      })
      .strict()
      .nullable()
      .default(null),
    checkpoints: z.array(
      z
        .object({
          key: nonempty.refine((value) => value === value.trim()),
          entityId: nonempty,
          artifactRelativePath: relativePath,
          source: recordSchema,
          applied: recordSchema,
        })
        .strict()
    ),
  })
  .strict();

const snapshotSchema = z
  .object({
    schema: z.literal('dnaforge.sheet-sync-snapshot'),
    schemaVersion: z.literal(1),
    sourceRevision: revisionSchema,
    rows: z.array(
      z
        .object({
          key: rowKeySchema,
          record: recordSchema,
          values: z.record(valueSchema),
          sourceRow: z.number().int().positive().optional(),
        })
        .strict()
    ),
  })
  .strict();

export type SheetSyncSnapshot = z.infer<typeof snapshotSchema>;

export function parseSheetSyncSnapshot(content: string): SheetSyncSnapshot {
  const snapshot = snapshotSchema.parse(JSON.parse(content));
  planSheetSync({ sourceRows: snapshot.rows, checkpoints: [], targets: [] });
  return snapshot;
}

export function sheetSyncWorkspacePath(workspaceRoot: string, relativePath: string): string {
  if (!isSafeWorkspaceRelativePath(relativePath))
    throw new Error('The sync artifact must remain inside its project.');
  const separator = workspaceRoot.includes('\\') ? '\\' : '/';
  return `${workspaceRoot.replace(/[\\/]+$/, '')}${separator}${relativePath.split('/').join(separator)}`;
}

export type SheetSyncConnection = z.infer<typeof connectionSchema>;

function validateSheetSyncConnection(value: unknown): SheetSyncConnection {
  const connection = connectionSchema.parse(value);
  if (
    connection.pending &&
    connection.pending.snapshotRelativePath !==
      sheetSyncSnapshotRelativePath(connection.pending.snapshotHash)
  )
    throw new Error('Spreadsheet pending snapshot identity does not match its revision.');
  planSheetSync({ sourceRows: [], checkpoints: connection.checkpoints, targets: [] });
  return connection;
}

export function parseSheetSyncConnection(content: string): SheetSyncConnection {
  return validateSheetSyncConnection(JSON.parse(content));
}

export function sheetSyncSnapshotRelativePath(revision: string): string {
  return `.waypoint/sheet-sync/snapshots/${revisionSchema.parse(revision).slice(7)}.json`;
}

export function sheetSyncConnectionRelativePath(id: string): string {
  return `.waypoint/sheet-sync/${z.string().uuid().parse(id)}.json`;
}

export interface StoredSheetSyncConnection {
  connection: SheetSyncConnection;
  content: string;
}

export type SheetSyncConnectionEntry =
  | { kind: 'connection'; stored: StoredSheetSyncConnection }
  | { kind: 'invalid'; name: string; message: string };

export function sheetSyncSourceView(source: SheetSyncConnection['source']): {
  sourcePath: string;
  sheetName: string;
  provider: 'google-sheets' | 'local-excel';
} {
  return 'provider' in source
    ? {
        provider: 'google-sheets',
        sourcePath: `https://docs.google.com/spreadsheets/d/${source.spreadsheetId}/edit#gid=${source.sheetId}`,
        sheetName: `Sheet ${source.sheetId}`,
      }
    : { provider: 'local-excel', sourcePath: source.path, sheetName: source.sheetName };
}
import type { ArtifactIO } from '../../artifact-io';
export type SheetSyncFiles = Pick<
  ArtifactIO['fs'],
  'exists' | 'readTextFile' | 'writeWorkspaceTextFileAtomic' | 'readDir'
>;
export function createSheetSyncPersistence(fs: SheetSyncFiles) {
  async function writeSheetSyncSnapshot(input: {
    workspaceRoot: string;
    snapshot: SheetSyncSnapshot;
    mutationToken: string;
  }) {
    const snapshot = snapshotSchema.parse(input.snapshot);
    const content = `${JSON.stringify(snapshot, null, 2)}\n`;
    parseSheetSyncSnapshot(content);
    const hash = `sha256:${await sha256Hex(content)}`;
    const relativePath = sheetSyncSnapshotRelativePath(hash);
    const path = sheetSyncWorkspacePath(input.workspaceRoot, relativePath);
    if (await fs.exists(path)) {
      if ((await fs.readTextFile(path)) !== content)
        throw new Error('Spreadsheet pending snapshot was modified.');
    } else {
      await fs.writeWorkspaceTextFileAtomic({
        workspaceRoot: input.workspaceRoot,
        path,
        content,
        mode: 'create',
        mutationToken: input.mutationToken,
        artifactNoun: 'spreadsheet row snapshot',
      });
    }
    return { hash, relativePath };
  }

  async function readSheetSyncSnapshot(input: {
    workspaceRoot: string;
    pending: NonNullable<SheetSyncConnection['pending']>;
  }): Promise<SheetSyncSnapshot> {
    const content = await fs.readTextFile(
      sheetSyncWorkspacePath(input.workspaceRoot, input.pending.snapshotRelativePath)
    );
    if (`sha256:${await sha256Hex(content)}` !== input.pending.snapshotHash)
      throw new Error('Spreadsheet pending snapshot was modified.');
    const snapshot = parseSheetSyncSnapshot(content);
    if (snapshot.sourceRevision !== input.pending.revision)
      throw new Error('Spreadsheet pending snapshot belongs to a different source revision.');
    return snapshot;
  }

  async function writeSheetSyncConnection(input: {
    workspaceRoot: string;
    connection: SheetSyncConnection;
    expectedContent?: string;
    mutationToken: string;
  }) {
    const connection = validateSheetSyncConnection(input.connection);
    const content = `${JSON.stringify(connection, null, 2)}\n`;
    const path = sheetSyncWorkspacePath(
      input.workspaceRoot,
      sheetSyncConnectionRelativePath(connection.id)
    );
    if (input.expectedContent !== undefined) {
      const prior = parseSheetSyncConnection(input.expectedContent);
      if (prior.id !== connection.id)
        throw new Error('Cannot replace a different spreadsheet connection.');
      if (
        prior.importSetId !== connection.importSetId ||
        prior.destinationRelativePath !== connection.destinationRelativePath ||
        JSON.stringify(prior.source) !== JSON.stringify(connection.source)
      )
        throw new Error('Reconnect the spreadsheet before changing its source or row mapping.');
    }
    await fs.writeWorkspaceTextFileAtomic({
      workspaceRoot: input.workspaceRoot,
      path,
      content,
      mode: input.expectedContent === undefined ? 'create' : 'replace',
      ...(input.expectedContent === undefined
        ? {}
        : { expectedContentHash: await sha256Hex(input.expectedContent) }),
      mutationToken: input.mutationToken,
      artifactNoun: 'spreadsheet sync checkpoint',
    });
    return { path, content, connection };
  }

  async function loadSheetSyncConnection(
    workspaceRoot: string,
    id: string
  ): Promise<StoredSheetSyncConnection> {
    const path = sheetSyncWorkspacePath(workspaceRoot, sheetSyncConnectionRelativePath(id));
    const content = await fs.readTextFile(path);
    const connection = parseSheetSyncConnection(content);
    if (connection.id !== id) throw new Error('Spreadsheet connection file identity changed.');
    return { connection, content };
  }

  async function listSheetSyncConnections(
    workspaceRoot: string
  ): Promise<SheetSyncConnectionEntry[]> {
    const directory = sheetSyncWorkspacePath(workspaceRoot, '.waypoint/sheet-sync');
    if (!(await fs.exists(directory))) return [];
    const entries: SheetSyncConnectionEntry[] = [];
    for (const file of await fs.readDir(directory)) {
      if (!file.isFile || !file.name.endsWith('.json')) continue;
      try {
        entries.push({
          kind: 'connection',
          stored: await loadSheetSyncConnection(workspaceRoot, file.name.slice(0, -5)),
        });
      } catch (error) {
        entries.push({
          kind: 'invalid',
          name: file.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return entries;
  }
  return {
    writeSheetSyncSnapshot,
    readSheetSyncSnapshot,
    writeSheetSyncConnection,
    loadSheetSyncConnection,
    listSheetSyncConnections,
  };
}
export type SheetSyncPersistence = ReturnType<typeof createSheetSyncPersistence>;
