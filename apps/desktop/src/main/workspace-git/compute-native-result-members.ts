import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { canonicalJson } from '../../shared/canonical-json';
import { parseMolecularDocument } from '../../shared/molecular-document';
import { parseSequenceFileAsDocument } from '../../shared/parse-sequence-file';
import { stripWorkspaceScope } from '../../shared/workspace-scoped-identity';
import { parseSequencePackageDocument, fromPackageRelative } from '../../db/sequence-package';
import { parseNotebookPackageDocument } from '../../db/notebook-package';
import { readCanonicalNotebookPackage } from '../../db/notebook-package-migration';
import { pathIsAtOrUnder } from '../../shared/path-boundary';
import { scientificWorkspaceIdForRoot } from '../scientific-workspace-identity';
import { ScientificObjectStore, hasAcceptedScientificWorkspace } from '../scientific-object-store';
import type { ComputeSourceInventory } from './compute-result-retention';
import { captureSequenceMigrationAdmission } from './sequence-migration-admission';
import { migrationPathsIntersect } from './migration-paths';

const path = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !/[\\\0]/u.test(value) &&
      value.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git')
  );
export const computeNativePlanSchema = z
  .object({
    catalogHeadWitness: z.string().nullable(),
    retainedImportedPaths: z.array(path),
    members: z.array(
      z
        .object({
          path,
          entityId: z.string().min(1),
          kind: z.enum(['sequence-package', 'notebook-package', 'molecular', 'file']),
          disposition: z.enum([
            'transfer',
            'copy',
            'retain-active',
            'retain-tombstone',
            'retain-protected',
          ]),
          bindingWitness: z.string(),
          identityWitness: z.string(),
        })
        .strict()
    ),
  })
  .strict();
export type ComputeNativePlan = z.infer<typeof computeNativePlanSchema>;

export function computeNativeCatalogHead(db: Database.Database, root: string): string | null {
  const id = scientificWorkspaceIdForRoot(db, root);
  return id !== null && hasAcceptedScientificWorkspace(db, id)
    ? canonicalJson(new ScientificObjectStore(db, id).catalog().head)
    : null;
}

export function computeNativeBindingRows(db: Database.Database, root: string) {
  const rows = db
    .prepare(
      `SELECT f.id,f.entity_id,f.path,f.workspace_id,f.object_uuid,f.status,f.file_kind,
    e.workspace_id AS entity_workspace_id,e.status AS entity_status,e.type AS entity_type
    FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id`
    )
    .all() as Array<{
    id: string;
    entity_id: string;
    path: string;
    workspace_id: number | null;
    object_uuid: string | null;
    status: string;
    file_kind: string;
    entity_workspace_id: number | null;
    entity_status: string;
    entity_type: string;
  }>;
  return rows
    .filter((row) => pathIsAtOrUnder(row.path, root))
    .sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
}

export function computeNativeIdentityWitness(
  db: Database.Database,
  id: string,
  kind: string
): string {
  const entities = db
    .prepare(
      'SELECT id,type,status,workspace_id FROM catalog_entities WHERE id=? OR (? AND substr(id,-?)=?) ORDER BY id'
    )
    .all(id, kind === 'notebook-package' ? 1 : 0, id.length + 2, '::' + id) as Array<{
    id: string;
  }>;
  const bindings = entities.flatMap((entity) =>
    db
      .prepare(
        'SELECT id,entity_id,path,workspace_id,object_uuid,status FROM catalog_entity_files WHERE entity_id=? ORDER BY id'
      )
      .all(entity.id)
  );
  return canonicalJson({ entities, bindings });
}

export async function captureComputeNativeMembers(
  db: Database.Database,
  input: {
    workspaceRoot: string;
    sourceRoot: string;
    workspaceId: number;
    source: ComputeSourceInventory;
    importedPaths: string[];
    targetRoot: string;
  }
): Promise<ComputeNativePlan> {
  const root = input.sourceRoot;
  const destinationBindings = db.prepare('SELECT path FROM catalog_entity_files').all() as Array<{
    path: string;
  }>;
  const protectedPaths = captureSequenceMigrationAdmission(db, input.workspaceRoot, {
    requireWritable: true,
  }).protectedPaths;
  if (
    [...protectedPaths, ...destinationBindings.map((row) => row.path)].some((path) =>
      migrationPathsIntersect(input.targetRoot, path)
    )
  )
    throw new Error('COMPUTE_RECOVERY_NATIVE_DESTINATION_OWNED');
  const files = new Map(
    input.source.entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => [entry.relativePath, entry])
  );
  const descriptors: Array<{
    path: string;
    entityId: string;
    kind: ComputeNativePlan['members'][number]['kind'];
  }> = [];
  const covered = (path: string) =>
    descriptors.some((entry) => path === entry.path || path.startsWith(entry.path + '/'));
  const read = (path: string) => readFile(join(root, path), 'utf8');
  for (const file of [...files.keys()].sort((a, b) => a.length - b.length)) {
    const marker = /(?:^|\/)\.forge\/(plasmid|notebook)\.json$/u.exec(file);
    if (!marker) continue;
    const packagePath = file.replace(/(?:^|\/)\.forge\/[^/]+$/u, '');
    if (!packagePath) throw new Error('COMPUTE_RECOVERY_ROOT_PACKAGE_UNSUPPORTED');
    if (covered(packagePath)) {
      if (descriptors.some((entry) => entry.path === packagePath))
        throw new Error('COMPUTE_RECOVERY_NATIVE_MARKER_AMBIGUOUS');
      continue;
    }
    if (marker[1] === 'plasmid') {
      const document = parseSequencePackageDocument(await read(file));
      const product = relative(
        root,
        fromPackageRelative(document.product.file, join(root, packagePath))
      )
        .split(sep)
        .join('/');
      const source = files.get(product);
      if (
        !source ||
        source.kind !== 'file' ||
        document.product.genBankChecksum !== `sha256:${source.sha256}` ||
        !parseSequenceFileAsDocument(await read(product), product).sequence.length
      )
        throw new Error('COMPUTE_RECOVERY_NATIVE_SEQUENCE_INVALID');
      descriptors.push({ path: packagePath, entityId: document.id, kind: 'sequence-package' });
    } else {
      const raw = await read(file);
      const metadata = JSON.parse(raw) as Record<string, unknown>;
      const document =
        'formatVersion' in metadata
          ? (
              await readCanonicalNotebookPackage(
                {
                  exists: async (path) => files.has(relative(root, path).split(sep).join('/')),
                  readTextFile: (path) => readFile(path, 'utf8'),
                },
                join(root, packagePath)
              )
            ).metadata
          : parseNotebookPackageDocument(raw);
      descriptors.push({ path: packagePath, entityId: document.id, kind: 'notebook-package' });
    }
  }
  for (const file of files.keys()) {
    if (covered(file)) continue;
    if (file.split('/').includes('.forge'))
      throw new Error('COMPUTE_RECOVERY_NATIVE_DOCUMENT_UNSUPPORTED');
    if (file.toLowerCase().endsWith('.dnaforge-molecular.json'))
      descriptors.push({
        path: file,
        entityId: parseMolecularDocument(await read(file)).id,
        kind: 'molecular',
      });
  }
  const allBindings = computeNativeBindingRows(db, root);
  for (const row of allBindings.filter((row) => row.status === 'current')) {
    const path = relative(root, row.path).split(sep).join('/');
    if (covered(path)) continue;
    if (
      !files.has(path) ||
      !['genbank', 'fasta', 'fastq'].includes(row.file_kind) ||
      !parseSequenceFileAsDocument(await read(path), path).sequence.length
    )
      throw new Error('COMPUTE_RECOVERY_NATIVE_BINDING_UNSUPPORTED');
    descriptors.push({ path, entityId: row.entity_id, kind: 'file' });
  }
  const workspaceId = scientificWorkspaceIdForRoot(db, input.workspaceRoot);
  const accepted =
    workspaceId !== null && hasAcceptedScientificWorkspace(db, workspaceId)
      ? new ScientificObjectStore(db, workspaceId).catalog()
      : null;
  const seen = new Set<string>();
  const plan: ComputeNativePlan = {
    catalogHeadWitness: computeNativeCatalogHead(db, input.workspaceRoot),
    members: [],
    retainedImportedPaths: [],
  };
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.entityId))
      throw new Error('COMPUTE_RECOVERY_NATIVE_IDENTITY_DUPLICATE');
    seen.add(descriptor.entityId);
    const sourcePath = join(root, descriptor.path);
    const bindings = computeNativeBindingRows(db, sourcePath);
    if (
      bindings.some(
        (row) =>
          row.workspace_id !== input.workspaceId || row.entity_workspace_id !== input.workspaceId
      )
    )
      throw new Error('COMPUTE_RECOVERY_NATIVE_OWNER_CHANGED');
    const matches = (id: string) =>
      descriptor.kind === 'notebook-package'
        ? stripWorkspaceScope(id) === descriptor.entityId
        : id === descriptor.entityId;
    const primary = bindings.filter(
      (row) => row.status === 'current' && row.entity_status === 'active' && matches(row.entity_id)
    );
    const types =
      descriptor.kind === 'notebook-package'
        ? ['notebook', 'page']
        : descriptor.kind === 'molecular'
          ? ['molecular-document']
          : ['sequence', 'construct'];
    if (primary.some((row) => !types.includes(row.entity_type)))
      throw new Error('COMPUTE_RECOVERY_NATIVE_IDENTITY_TYPE_CHANGED');
    const protectedSlots =
      accepted?.entries.filter(
        (entry) =>
          matches(entry.resourceId) ||
          bindings.some((binding) => binding.entity_id === entry.resourceId)
      ) ?? [];
    let disposition: ComputeNativePlan['members'][number]['disposition'];
    if (protectedSlots.length) {
      disposition = protectedSlots.some((entry) => matches(entry.resourceId) && entry.tombstone)
        ? 'retain-tombstone'
        : primary.length
          ? 'retain-active'
          : 'retain-protected';
      if (disposition === 'retain-active') {
        plan.retainedImportedPaths.push(
          ...input.importedPaths
            .filter((path) => pathIsAtOrUnder(path, sourcePath))
            .map((path) => relative(root, path).split(sep).join('/'))
        );
      }
    } else {
      const existing =
        JSON.parse(computeNativeIdentityWitness(db, descriptor.entityId, descriptor.kind)).entities
          .length > 0;
      if (primary.length > 1 || (!primary.length && (bindings.length || existing)))
        throw new Error('COMPUTE_RECOVERY_NATIVE_IDENTITY_OWNED_ELSEWHERE');
      if (
        primary.length &&
        bindings.some((row) => row.status === 'current' && row.entity_status !== 'active')
      )
        throw new Error('COMPUTE_RECOVERY_NATIVE_OWNER_CHANGED');
      disposition = primary.length ? 'transfer' : 'copy';
    }
    plan.members.push({
      ...descriptor,
      disposition,
      bindingWitness: canonicalJson(bindings),
      identityWitness: computeNativeIdentityWitness(db, descriptor.entityId, descriptor.kind),
    });
  }
  return plan;
}
