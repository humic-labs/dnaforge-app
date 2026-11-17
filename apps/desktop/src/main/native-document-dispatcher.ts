import { NativeDocumentCommandError } from '../shared/native-document-error';
import { dirname, join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  FileDocumentRequest,
  FileDocumentSnapshot,
  FileDocumentTarget,
  FileDocumentAgentRequest,
} from '../shared/file-document';
import {
  fileDocumentAgentRequestSchema,
  isFileDocumentDirtyListRequest,
} from '../shared/file-document';
import {
  documentLifecycleCapabilities,
  type NativeDocumentKind,
} from '../shared/document-lifecycle';
import type { NativeFileDocumentOwner } from './file-document-owner';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import {
  pageNativeDirtyDocuments,
  type NativeDirtyDocument,
  type NativeDirtyDocumentPage,
} from '../shared/native-document-drafts';
import { hasRequiredCapabilities } from '../shared/capability-policy';
import { inferCatalogFileKind } from '../shared/catalog-file-kind';

export interface NativeScientificDocumentAdapter {
  kind: NativeDocumentKind;
  locate(documentId: string): Promise<{ path: string; workspaceRoot: string }>;
  listDirty(): Promise<NativeDirtyDocument[]>;
  execute(
    request: FileDocumentRequest & { target: { documentId: string } }
  ): Promise<FileDocumentSnapshot>;
  assertClean(path: string): Promise<void>;
  withCleanPaths<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T>;
  relocate(source: string, destination: string): Promise<void>;
  subscribe(listener: (snapshot: FileDocumentSnapshot) => void): () => void;
  close?(): Promise<void>;
  requiredCapabilities?(request: FileDocumentRequest): readonly string[];
}
export interface NativeDocumentAgent {
  identityId: string;
  capabilities: readonly string[];
}
interface CatalogDocument {
  documentId: string;
  kind: NativeDocumentKind;
  path: string;
  workspaceRoot: string;
  bound?: boolean;
}
const scientificKinds = new Set<NativeDocumentKind>([
  'sequence',
  'notebook',
  'design',
  'protein',
  'primer',
  'protocol',
  'scientific',
]);
const kindFor = (
  path: string,
  type?: string,
  recordKind?: string,
  recordedFileKind?: string
): NativeDocumentKind => {
  const fileKind = recordedFileKind ?? inferCatalogFileKind(path);
  if (type === 'protein' || recordKind === 'protein') return 'protein';
  if (type === 'primer' || ['primer', 'oligo', 'dna_oligo', 'rna_oligo'].includes(recordKind ?? ''))
    return 'primer';
  if (
    type === 'protocol' ||
    type === 'protocol_run' ||
    recordKind === 'protocol' ||
    recordKind === 'protocol_run'
  )
    return 'protocol';
  if (type === 'sequence') return 'sequence';
  if (type === 'page' || type === 'notebook') return 'notebook';
  if (type === 'design') return 'design';
  if (
    recordKind ||
    [
      'record',
      'sample',
      'construct',
      'molecular-document',
      'structure',
      'track-view',
      'alignment',
      'trace',
      'selection',
    ].includes(type ?? '')
  )
    return 'scientific';
  if (
    fileKind === 'waypoint-entity' ||
    fileKind === 'waypoint-residue-selection' ||
    fileKind === 'dnaforge-molecular-document'
  )
    return 'scientific';
  if (fileKind === 'waypoint-notebook') return 'notebook';
  if (fileKind === 'waypoint-design') return 'design';
  if (fileKind === 'waypoint-protocol' || fileKind === 'waypoint-protocol-run') return 'protocol';
  if (
    fileKind === 'waypoint-sequence' ||
    ['genbank', 'fasta', 'fastq', 'dna', 'seq'].includes(fileKind)
  )
    return 'sequence';
  if (
    ['pdb', 'mmcif', 'binary-cif', 'alignment', 'trace'].includes(fileKind) ||
    /\.(molview|alignment|trackview)\.json$/i.test(path)
  )
    return 'scientific';
  if (/\.primer\.json$/i.test(path)) return 'primer';
  if (/\.protein\.json$/i.test(path)) return 'protein';
  if (fileKind === 'dnaforge-table') return 'table';
  if (fileKind === 'csv') return 'csv';
  if (fileKind === 'tsv') return 'tsv';
  if (
    [
      'pdf',
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'xls',
      'xlsx',
      'xlsm',
      'parquet',
      'bam',
      'cram',
      'bai',
      'crai',
      'vcf',
      'bcf',
      'bigwig',
      'bw',
      'bigbed',
      'bb',
      'zip',
      'gz',
      'tar',
      '7z',
      'sqlite',
      'db',
    ].includes(fileKind)
  )
    return 'binary';
  return 'text';
};
const reading = (request: FileDocumentRequest) =>
  request.operation.kind === 'inspect' ||
  (request.operation.kind === 'table' && request.operation.command.kind === 'inspect') ||
  (request.operation.kind === 'sequence' && request.operation.command.kind === 'inspect') ||
  (request.operation.kind === 'notebook' &&
    (request.operation.command.kind === 'inspect' ||
      request.operation.command.kind === 'schema' ||
      (request.operation.command.kind === 'table' &&
        request.operation.command.command.kind === 'inspect')));

const refusal = (message: string) => {
  const match = /^([A-Z][A-Z0-9_]+):?\s*(.*)$/s.exec(message);
  return new NativeDocumentCommandError(
    match?.[1] ?? 'DOCUMENT_ADMISSION_FAILED',
    match?.[2] || message,
    false
  );
};
const beforeEffects = async <T>(operation: () => Promise<T> | T): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof NativeDocumentCommandError) throw error;
    throw refusal(error instanceof Error ? error.message : String(error));
  }
};

export class NativeDocumentDispatcher {
  constructor(
    private readonly options: {
      ordinary: NativeFileDocumentOwner;
      db(): Database.Database;
      adapters: readonly NativeScientificDocumentAdapter[];
      workspaceRoots?(): readonly string[];
    }
  ) {}
  async listDirty(): Promise<NativeDirtyDocument[]> {
    return [
      ...(await this.options.ordinary.listDirty()),
      ...(await Promise.all(this.options.adapters.map((adapter) => adapter.listDirty()))).flat(),
    ];
  }
  async executeAgent(
    input: FileDocumentAgentRequest,
    agent: NativeDocumentAgent
  ): Promise<FileDocumentSnapshot | NativeDirtyDocumentPage> {
    const parsed = await beforeEffects(async () => fileDocumentAgentRequestSchema.parse(input));
    if (isFileDocumentDirtyListRequest(parsed))
      return beforeEffects(async () => {
        if (!agent.identityId?.trim()) throw refusal('AGENT_IDENTITY_REQUIRED');
        if (!hasRequiredCapabilities(agent.capabilities, ['read-workspace']))
          throw refusal(
            'CAPABILITY_DENIED: read-workspace is required for native dirty-document metadata.'
          );
        const documents = await this.listDirty();
        const enrolled = this.options.workspaceRoots?.() ?? [
          ...new Set(documents.map((document) => document.workspaceRoot)),
        ];
        const rows = this.options
          .db()
          .prepare(
            'SELECT name,path FROM workspaces WHERE archived_at IS NULL AND trashed_at IS NULL AND path IS NOT NULL'
          )
          .all() as Array<{ name: string; path: string }>;
        const projects = enrolled.flatMap((path) => {
          const matching = rows.filter(
            (row) => workspaceMutationRootIdentity(row.path) === workspaceMutationRootIdentity(path)
          );
          return matching.length === 1 ? [{ name: matching[0].name, path }] : [];
        });
        const current = documents.flatMap((document) => {
          const project = projects.find(
            (project) =>
              workspaceMutationRootIdentity(project.path) ===
              workspaceMutationRootIdentity(document.workspaceRoot)
          );
          return project ? [{ ...document, workspaceRoot: project.path }] : [];
        });
        return pageNativeDirtyDocuments(parsed, { projects, documents: current });
      });
    const admitted = await beforeEffects(async () => {
      const request = parsed;
      if (!agent.identityId?.trim()) throw refusal('AGENT_IDENTITY_REQUIRED');
      const target = await this.resolve(request.target),
        required = ['read-workspace'];
      if (target.kind === 'sequence') required.push('read-sequences');
      if (!reading(request)) {
        required.push('write-workspace');
        if (target.kind === 'protocol') required.push('edit-protocols');
      }
      required.push(...(this.adapter(target.kind)?.requiredCapabilities?.(request) ?? []));
      for (const capability of new Set(required))
        if (!hasRequiredCapabilities(agent.capabilities, [capability]))
          throw refusal(
            `CAPABILITY_DENIED: ${capability} is required for this ${target.kind} document.`
          );
      return { request, target };
    });
    return this.executeResolved(admitted.request, admitted.target);
  }
  async execute(
    request: FileDocumentRequest,
    client: 'native' | 'renderer' = 'native'
  ): Promise<FileDocumentSnapshot> {
    const target = await beforeEffects(() => this.resolve(request.target));
    return this.executeResolved(request, target, client);
  }

  private async executeResolved(
    request: FileDocumentRequest,
    target: CatalogDocument,
    client: 'native' | 'renderer' = 'native'
  ): Promise<FileDocumentSnapshot> {
    if (request.ordinaryOnly && scientificKinds.has(target.kind))
      throw refusal(
        'FILE_DOCUMENT_LEGACY_TARGET_UNSUPPORTED: This document requires its scientific native owner.'
      );
    const inspectEntityText = /\.entity\.json$/i.test(target.path) && !this.adapter(target.kind);
    if (scientificKinds.has(target.kind) && !inspectEntityText) {
      const adapter = this.adapter(target.kind);
      if (adapter && target.bound)
        return adapter.execute({ ...request, target: { documentId: target.documentId } });
      if (!reading(request))
        throw refusal(
          `DOCUMENT_OPERATION_UNSUPPORTED: ${target.kind} editing is not available through a native working-copy owner.`
        );
      return {
        documentId: target.documentId,
        path: target.path,
        workspaceRoot: target.workspaceRoot,
        type: target.kind,
        kind: target.kind,
        revision: 'unsupported',
        persistedRevision: 'unsupported',
        ready: true,
        readOnly: true,
        dirty: false,
        saving: false,
        canUndo: false,
        canRedo: false,
        capabilities: ['inspect'],
        content: null,
        persistedContent: null,
        diskContent: null,
        owner: { kind: target.kind, runtime: 'unsupported' },
        lifecycle: documentLifecycleCapabilities({
          readOnly: true,
          commands: ['inspect'],
          reason: 'This document kind has no connected native working-copy adapter.',
        }),
        reason: 'This document kind has no connected native working-copy adapter.',
      };
    }
    if (request.operation.kind === 'sequence')
      throw refusal('DOCUMENT_KIND_MISMATCH: This file is not a sequence document.');
    const snapshot = await this.options.ordinary.execute(
      { ...request, target: { path: target.path, workspaceRoot: target.workspaceRoot } },
      client
    );
    const kind = snapshot.type === 'unsupported' ? target.kind : snapshot.type;
    return {
      ...snapshot,
      kind,
      workspaceRoot: target.workspaceRoot,
      owner: { kind, runtime: 'native' },
      lifecycle: documentLifecycleCapabilities({
        readOnly: snapshot.readOnly,
        commands: snapshot.capabilities,
        reason: snapshot.reason,
      }),
    };
  }
  private adapter(kind: NativeDocumentKind): NativeScientificDocumentAdapter | undefined {
    return this.options.adapters.find((adapter) => adapter.kind === kind);
  }
  private async resolve(target: FileDocumentTarget): Promise<CatalogDocument> {
    const db = this.options.db();
    const select =
      "SELECT e.id AS documentId,e.type,f.path,f.file_kind AS fileKind,l.kind AS recordKind FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id LEFT JOIN lims_entity l ON l.id=e.id WHERE f.status='current' AND e.status='active'";
    let row:
      | {
          documentId: string;
          type: string;
          path: string;
          fileKind: string;
          recordKind: string | null;
        }
      | undefined;
    if ('documentId' in target) {
      const rows = db.prepare(select + ' AND e.id=? LIMIT 2').all(target.documentId) as Array<
        NonNullable<typeof row>
      >;
      if (rows.length > 1)
        throw new Error(
          'AMBIGUOUS_FILE_DOCUMENT: The catalog identity has multiple current files.'
        );
      row = rows[0];
      if (row) {
        const kind = kindFor(row.path, row.type, row.recordKind ?? undefined, row.fileKind),
          adapter = this.adapter(kind);
        const admitted = adapter
          ? await adapter.locate(row.documentId)
          : await this.options.ordinary.admitTarget({ path: row.path });
        return {
          documentId: row.documentId,
          kind,
          path: admitted.path,
          workspaceRoot: admitted.workspaceRoot,
          bound: true,
        };
      }
    }
    const admitted = await this.options.ordinary.admitTarget(target);
    const storedPath = join(
      admitted.workspaceRoot,
      relative(workspaceMutationRootIdentity(admitted.workspaceRoot), admitted.path)
    );
    const rows = db
      .prepare(
        select +
          " AND (f.path=? OR f.path=? OR (e.type IN ('sequence','page','notebook') AND (f.path=? OR f.path=?))) LIMIT 2"
      )
      .all(admitted.path, storedPath, dirname(admitted.path), dirname(storedPath)) as Array<
      NonNullable<typeof row>
    >;
    if (rows.length > 1)
      throw new Error('AMBIGUOUS_FILE_DOCUMENT: Multiple catalog identities own this path.');
    row = rows[0];
    const kind = kindFor(admitted.path, row?.type, row?.recordKind ?? undefined, row?.fileKind);
    if (scientificKinds.has(kind) && !row)
      return {
        documentId: 'path:' + admitted.path,
        kind,
        path: admitted.path,
        workspaceRoot: admitted.workspaceRoot,
      };
    return {
      documentId:
        row?.documentId ?? ('documentId' in target ? target.documentId : 'path:' + admitted.path),
      kind,
      path: admitted.path,
      workspaceRoot: admitted.workspaceRoot,
      bound: Boolean(row),
    };
  }
  subscribe(listener: (snapshot: FileDocumentSnapshot) => void): () => void {
    const detach = [
      this.options.ordinary.subscribe(listener),
      ...this.options.adapters.map((adapter) => adapter.subscribe(listener)),
    ];
    return () => {
      for (const stop of detach) stop();
    };
  }
  async rootRelinkBlocker(
    path: string
  ): Promise<'unbound-file-document' | 'scientific-document' | null> {
    const root = workspaceMutationRootIdentity(path),
      prefix = root.replace(/[\\/]+$/, '') + '/';
    const rows = this.options
      .db()
      .prepare(
        "SELECT e.type,f.path,f.file_kind AS fileKind,l.kind AS recordKind FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id LEFT JOIN lims_entity l ON l.id=e.id WHERE f.status='current' AND e.status='active' AND (f.path=? OR substr(f.path,1,?)=?)"
      )
      .all(root, prefix.length, prefix) as Array<{
      type: string;
      path: string;
      fileKind: string;
      recordKind: string | null;
    }>;
    if (
      rows.some((row) =>
        scientificKinds.has(kindFor(row.path, row.type, row.recordKind ?? undefined, row.fileKind))
      )
    )
      return 'scientific-document';
    return this.options.ordinary.rootRelinkBlocker(path);
  }

  async assertClean(path: string): Promise<void> {
    await this.options.ordinary.assertClean(path);
    for (const adapter of this.options.adapters) await adapter.assertClean(path);
  }
  withCleanPaths<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
    const owners = [this.options.ordinary, ...this.options.adapters];
    const run = (index: number): Promise<T> =>
      index === owners.length
        ? operation()
        : owners[index].withCleanPaths(paths, () => run(index + 1));
    return run(0);
  }
  async relocate(source: string, destination: string): Promise<void> {
    await this.options.ordinary.relocate(source, destination);
    for (const adapter of this.options.adapters) await adapter.relocate(source, destination);
  }
  beginLegacyMigration(): void {
    this.options.ordinary.beginLegacyMigration();
  }
  completeLegacyMigration(paths: readonly string[]): Promise<void> {
    return this.options.ordinary.completeLegacyMigration(paths);
  }
  retainLegacyDraft(input: Parameters<NativeFileDocumentOwner['retainLegacyDraft']>[0]) {
    return this.options.ordinary.retainLegacyDraft(input);
  }
  async close(): Promise<void> {
    await this.options.ordinary.close();
    for (const adapter of this.options.adapters) await adapter.close?.();
  }
}
