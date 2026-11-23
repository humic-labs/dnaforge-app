export type { PrimerRecordRecoveryResult } from './primer-recovery-report';
import { canonicalEntityArtifactValue } from '../entity-artifact-projection';
import { isDeveloperImportSourcePath } from '../developer-import-sources';
import { limsEntityFromRow, type LimsEntity, type LimsEntityRow } from '../lims';
import {
  buildPrimerArtifact,
  defaultPrimerArtifactPath,
  parsePrimerArtifact,
  serializePrimerArtifact,
  sha256Hex,
  sanitizePrimerArtifactStem,
  validatePrimerArtifactPath,
  type PrimerArtifactV1,
  type PrimerEntitySchemaSnapshot,
} from './primer-artifact';
import { PRIMER_MANAGED_SCHEMA_FIELD_KEYS } from './primer-schema-contract';
import { parseIdtOligoNotation, type PrimerOligoCompositionV1 } from './oligo-modifications';
import type { DbPrimerRow, PrimerApplication } from './types';
import { PRIMER_ARTIFACT_SCHEMA } from '../primer-artifact-schema';
import {
  PrimerRecoveryFileError,
  primerRecoveryDiagnostic,
  type PrimerRecordRecoveryResult,
} from './primer-recovery-report';
import type { PrimerRecoveryDependencies } from './primer-recovery-port';
import { legacyPrimerRecoveryArtifactStem } from '../legacy-primer-library-recovery';
interface LegacyBindingRow {
  id: string;
  sequence_id: number;
  binding_start: number;
  binding_end: number;
  strand: number;
  source: string;
  created_at: number;
  updated_at: number;
}
interface RecoveryDependencies {
  retireTrashed(
    id: string,
    workspaceRoot: string,
    options: { mutationToken?: string }
  ): Promise<void>;
  read(
    path: string,
    workspaceRoot: string
  ): Promise<{ id: string; recoveredSource?: 'registry' | 'legacy' }>;
  project(
    artifact: PrimerArtifactV1,
    workspaceRoot: string,
    options: { mutationToken?: string }
  ): Promise<unknown>;
  commit(
    workspaceRoot: string,
    relativePaths: string[],
    dirtyBefore: Set<string>,
    message: string,
    mutationToken?: string
  ): Promise<'committed' | 'not-git' | 'failed'>;
  dirtyPaths(workspaceRoot: string, mutationToken?: string): Promise<Set<string>>;
}
export function createPrimerRecordRecoveryOwner(dependencies: PrimerRecoveryDependencies) {
  const platform = dependencies.io;
  const {
    withRendererWorkspaceMutation,
    getLimsRegistryPreview,
    buildFileDnaSequenceRef,
    generateCatalogNumber,
    findTrashedPrimerDocument,
    readPrimerRegistryRelationships,
  } = dependencies;
  async function readLegacySource(id: string) {
    const [row] = await platform().db.select<DbPrimerRow[]>('SELECT * FROM primers WHERE id = ?', [
      id,
    ]);
    if (!row) return null;
    const bindings = await platform().db.select<LegacyBindingRow[]>(
      'SELECT * FROM primer_bindings WHERE primer_id = ? ORDER BY id',
      [id]
    );
    const fingerprint = await sha256Hex(
      JSON.stringify(canonicalEntityArtifactValue({ row, bindings }))
    );
    return { row, bindings, fingerprint };
  }
  function recoveryOligo(
    sequence: string,
    orderType: 'dna' | 'rna',
    stored?: unknown,
    modifications?: string | null
  ): PrimerOligoCompositionV1 | undefined {
    if (stored !== undefined) return stored as PrimerOligoCompositionV1;
    if (modifications) {
      const parsed = parseIdtOligoNotation(modifications, {
        orderType,
        enforceVendorConstraints: false,
      });
      if (parsed.errors.length || parsed.bases !== sequence || !parsed.composition)
        throw new Error(
          'The original modification notation cannot yet be recovered without changing its chemistry.'
        );
      return parsed.composition;
    }
    return orderType === 'rna'
      ? { vendor: 'unspecified', orderType, notation: sequence, modifications: [] }
      : undefined;
  }
  async function retainLegacySource(
    artifact: PrimerArtifactV1,
    legacy: NonNullable<Awaited<ReturnType<typeof readLegacySource>>>,
    workspaceRoot: string
  ): Promise<void> {
    const { row, bindings } = legacy;
    const details: unknown = row.origin_details ? JSON.parse(row.origin_details) : null;
    if (details !== null && (typeof details !== 'object' || Array.isArray(details)))
      throw new Error('The primer origin metadata is invalid; its source record was preserved.');
    if (details && 'authority' in details && details.authority === 'primer_artifact')
      throw new Error(
        'This primer already had an authoritative document; restore that document before recovery.'
      );
    if (details && 'limsEntityId' in details && details.limsEntityId !== artifact.id)
      throw new Error(
        'The legacy primer points to a different Registry identity; both records were preserved.'
      );
    artifact.inventory = {
      origin: row.origin,
      originDetails: details as Record<string, unknown> | null,
      vendor: row.vendor,
      orderDate: row.order_date,
      scale: row.scale,
      purification: row.purification,
      modifications: row.modifications,
      stockLocation: row.stock_location,
      concentration: row.concentration,
    };
    artifact.recovery!.legacyFingerprint = legacy.fingerprint;
    artifact.recovery!.originalComputed = {
      length: row.length,
      tmC: row.tm,
      gcPercent: row.gc_percent,
    };
    for (const binding of bindings) {
      if (artifact.bindings.some((existing) => existing.id === binding.id)) continue;
      const [file] = await platform().db.select<Array<{ path: string }>>(
        'SELECT f.path FROM sequences s JOIN indexed_files f ON f.id = s.file_id WHERE s.id = ?',
        [binding.sequence_id]
      );
      if (!file || !(await platform().fs.validateWorkspacePath({ workspaceRoot, path: file.path })))
        throw new Error(
          'A primer binding target is unavailable in its project; the original binding was preserved.'
        );
      const target = await buildFileDnaSequenceRef(file.path, { workspaceRoot });
      if (binding.strand !== 1 && binding.strand !== -1)
        throw new Error('The original primer binding strand is invalid.');
      artifact.bindings.push({
        id: binding.id,
        relation: 'binds_to_sequence',
        target: {
          documentId: target.documentId,
          topology: target.topology,
          length: target.length,
          fileContentHash: target.fileContentHash ?? target.contentHash,
          normalizedSequenceHash: target.normalizedSequenceHash ?? target.contentHash,
        },
        coordinates: {
          system: 'zero_based_half_open',
          start: binding.binding_start,
          end: binding.binding_end,
          strand: binding.strand,
        },
        source: 'reconciled',
        history: {
          createdAt: binding.created_at,
          updatedAt: binding.updated_at,
          source: binding.source,
        },
      });
    }
  }
  function primerRecoverySourceFingerprint(entity: LimsEntity): Promise<string> {
    return sha256Hex(JSON.stringify(canonicalEntityArtifactValue(entity)));
  }
  async function primerRecoveryRelationshipsFingerprint(entityId: string): Promise<string> {
    return sha256Hex(
      JSON.stringify(canonicalEntityArtifactValue(await readPrimerRegistryRelationships(entityId)))
    );
  }
  async function recoverPrimerRecordsInWorkspace(
    workspaceRoot: string,
    dependencies: RecoveryDependencies,
    options: {
      mutationToken?: string;
      signal?: AbortSignal;
      legacySelection?: readonly { id: string; sourceFingerprint: string }[];
    } = {}
  ): Promise<PrimerRecordRecoveryResult> {
    const result: PrimerRecordRecoveryResult = {
      recovered: 0,
      errors: [],
      pendingArtifactPaths: [],
      records: [],
    };
    if (isDeveloperImportSourcePath(workspaceRoot)) return result;
    const [workspace] = await platform().db.select<Array<{ id: number; repo_uuid: string | null }>>(
      'SELECT id, repo_uuid FROM workspaces WHERE path = ? AND archived_at IS NULL AND trashed_at IS NULL AND access_mode = ?',
      [workspaceRoot, 'writable']
    );
    if (!workspace) return result;
    result.project = { workspaceId: workspace.id, repoUuid: workspace.repo_uuid };
    const selection = options.legacySelection
      ? new Map(options.legacySelection.map((entry) => [entry.id, entry.sourceFingerprint]))
      : null;
    if (
      selection &&
      (selection.size !== options.legacySelection!.length ||
        [...selection].some(([id, fingerprint]) => !id || !/^[a-f0-9]{64}$/.test(fingerprint)))
    )
      throw new Error('The selected legacy primer recovery identities are invalid.');
    const defaultProject =
      !selection && typeof platform().workspace.getOriginalDefaultProject === 'function'
        ? await platform().workspace.getOriginalDefaultProject()
        : null;
    const includesUnassigned =
      defaultProject?.status === 'ready' && defaultProject.project.workspaceId === workspace.id;
    const rows = selection
      ? []
      : await platform().db.select<LimsEntityRow[]>(
          `SELECT e.* FROM lims_entity e JOIN lims_schema_revision r ON r.id = e.schema_revision_id
     WHERE (e.workspace_id = ? ${includesUnassigned ? 'OR e.workspace_id IS NULL' : ''})
       AND (e.kind IN ('oligo', 'rna_oligo')
         OR CASE WHEN json_valid(e.fields) THEN json_extract(e.fields, '$.use') END = 'primer'
         OR CASE WHEN json_valid(r.fields) THEN json_extract(r.fields, '$.baseKind') END = 'primer')
     ORDER BY e.id`,
          [workspace.id]
        );
    for (const row of rows) {
      options.signal?.throwIfAborted();
      let entity: LimsEntity;
      try {
        entity = limsEntityFromRow(row);
        const initialPreview = await getLimsRegistryPreview({ entityId: entity.id });
        if (
          entity.fields.use !== 'primer' &&
          !(entity.fields.use === undefined && initialPreview.schemaSnapshot.baseKind === 'primer')
        )
          continue;
        if (entity.fields.artifact !== undefined) {
          const reference = entity.fields.artifact;
          if (
            !reference ||
            typeof reference !== 'object' ||
            !('relativePath' in reference) ||
            typeof reference.relativePath !== 'string'
          )
            throw new Error('The saved primer document reference is invalid.');
          const path = `${workspaceRoot.replace(/[\\/]+$/, '')}/${reference.relativePath}`;
          if (
            'schema' in reference &&
            reference.schema === PRIMER_ARTIFACT_SCHEMA &&
            (await findTrashedPrimerDocument(entity.id, path))
          ) {
            await dependencies.retireTrashed(entity.id, workspaceRoot, options);
            result.records.push({
              id: entity.id,
              name: entity.name,
              source: 'registry',
              status: 'trashed',
              artifactPath: path,
            });
            continue;
          }
          const saved = await dependencies.read(path, workspaceRoot);
          if (saved.id !== entity.id)
            throw new Error('The saved primer document belongs to a different record.');
          result.records.push({
            id: entity.id,
            name: entity.name,
            source: saved.recoveredSource ?? 'registry',
            status: saved.recoveredSource ? 'recovered' : 'document-backed',
            artifactPath: path,
          });
          continue;
        }
        const files = await platform().db.select<Array<{ path: string }>>(
          "SELECT path FROM catalog_entity_files WHERE entity_id = ? AND status = 'current'",
          [entity.id]
        );
        if (files.length > 0) {
          if (
            !(await Promise.all(files.map((file) => platform().fs.exists(file.path)))).some(Boolean)
          )
            throw new PrimerRecoveryFileError(
              'primer.recoveryFileMissing',
              'The primer already had an authoritative document; restore that document before recovery.'
            );
          if (files.length !== 1)
            throw new Error(
              'This primer has more than one current document; preserve them for review.'
            );
          const path = files[0].path;
          const saved = await dependencies.read(path, workspaceRoot);
          if (saved.id !== entity.id)
            throw new Error('The saved primer document belongs to a different record.');
          result.records.push({
            id: entity.id,
            name: entity.name,
            source: 'registry',
            status: 'document-backed',
            artifactPath: path,
          });
          continue;
        }
        const sequence = entity.fields.sequence;
        if (
          !sequence ||
          typeof sequence !== 'object' ||
          !('mode' in sequence) ||
          sequence.mode !== 'inline'
        )
          throw new Error(
            'The primer has no recoverable inline sequence; its source record was preserved.'
          );
        await withRendererWorkspaceMutation(
          workspaceRoot,
          async (mutationToken) => {
            options.signal?.throwIfAborted();
            const preview = await getLimsRegistryPreview({ entityId: entity.id });
            const current = preview.entity;
            if (
              current.fields.artifact !== undefined ||
              (current.fields.use !== 'primer' &&
                !(current.fields.use === undefined && preview.schemaSnapshot.baseKind === 'primer'))
            )
              return;
            if (current.workspaceId != null && current.workspaceId !== workspace.id)
              throw new Error('The primer project changed before recovery.');
            const currentSequence = current.fields.sequence;
            if (
              !currentSequence ||
              typeof currentSequence !== 'object' ||
              !('mode' in currentSequence) ||
              currentSequence.mode !== 'inline' ||
              !('bases' in currentSequence) ||
              typeof currentSequence.bases !== 'string'
            )
              throw new Error('The primer has no recoverable saved sequence.');
            const sourceFingerprint = await primerRecoverySourceFingerprint(current);
            const relationships = await readPrimerRegistryRelationships(current.id);
            const relationshipsFingerprint = await sha256Hex(
              JSON.stringify(canonicalEntityArtifactValue(relationships))
            );
            const legacy = await readLegacySource(current.id);
            const stem =
              current.id.length <= 128 && sanitizePrimerArtifactStem(current.id) === current.id
                ? current.id
                : await sha256Hex(current.id);
            const artifactPath = defaultPrimerArtifactPath(workspaceRoot, stem);
            const expectedPath = validatePrimerArtifactPath(artifactPath, workspaceRoot);
            if (!expectedPath.valid) throw new Error(expectedPath.error);
            const dirtyBefore = await dependencies.dirtyPaths(workspaceRoot, mutationToken);
            let artifact: PrimerArtifactV1;
            if (await platform().fs.exists(artifactPath)) {
              artifact = parsePrimerArtifact(await platform().fs.readTextFile(artifactPath));
              if (
                artifact.id !== current.id ||
                artifact.recovery?.sourceFingerprint !== sourceFingerprint ||
                artifact.recovery?.legacyFingerprint !== legacy?.fingerprint ||
                artifact.recovery?.relationshipsFingerprint !== relationshipsFingerprint ||
                artifact.file.workspaceRelativePath !== expectedPath.relativePath
              )
                throw new Error(
                  'An existing primer document differs from the recovery source; it was preserved.'
                );
            } else {
              const schema: PrimerEntitySchemaSnapshot = {
                ...preview.schemaSnapshot,
                baseKind: 'primer',
              };
              const defined = new Set(schema.fields.map((field) => field.key));
              const editable: Record<string, unknown> = {};
              const otherFields: Record<string, unknown> = {};
              for (const [key, value] of Object.entries(current.fields)) {
                if (PRIMER_MANAGED_SCHEMA_FIELD_KEYS.has(key)) continue;
                (defined.has(key) ? editable : otherFields)[key] = value;
              }
              for (const key of ['status', 'source']) {
                const value = current.fields[key];
                if (value !== undefined && value !== null && typeof value !== 'string')
                  throw new Error(`The primer's ${key} metadata needs review before recovery.`);
              }
              artifact = await buildPrimerArtifact({
                id: current.id,
                catalogNumber:
                  typeof current.fields.catalogNumber === 'string' && current.fields.catalogNumber
                    ? current.fields.catalogNumber
                    : await generateCatalogNumber(workspace.id, workspaceRoot, mutationToken),
                name: current.name,
                sequence: currentSequence.bases,
                oligo: recoveryOligo(
                  currentSequence.bases,
                  preview.schemaSnapshot.fields.some(
                    (field) => field.key === 'sequence' && field.type === 'rna_sequence'
                  )
                    ? 'rna'
                    : 'dna',
                  current.fields.oligo,
                  legacy?.row.modifications
                ),
                workspaceRoot,
                artifactPath,
                entitySchema: schema,
                entityFields: editable,
                notes: typeof current.fields.notes === 'string' ? current.fields.notes : null,
                application:
                  typeof current.fields.application === 'string'
                    ? (current.fields.application as PrimerApplication)
                    : null,
                actor: current.actor ?? 'primer-record-recovery',
                source: 'reconciled',
                now: current.createdAt,
              });
              artifact.entity = {
                schema,
                fields: editable,
                otherFields,
                state: {
                  registrationStatus: current.registrationStatus,
                  domainStatus: current.domainStatus,
                  archived: current.tombstone,
                  archivedAt: current.archivedAt,
                  ...(current.fields.status !== undefined
                    ? { status: current.fields.status as string | null }
                    : {}),
                  ...(current.fields.source !== undefined
                    ? { source: current.fields.source as string | null }
                    : {}),
                },
              };
              artifact.metadata.updatedAt = new Date(current.updatedAt).toISOString();
              artifact.recovery = {
                schema: 'dnaforge.primer-recovery/v1',
                source: 'registry',
                sourceFingerprint,
                relationshipsFingerprint,
                sourceActor: current.actor,
              };
              artifact.registryRelationships = relationships;
              if (current.fields.bindings !== undefined) {
                if (!Array.isArray(current.fields.bindings))
                  throw new Error('The primer bindings need review before recovery.');
                artifact.bindings = current.fields.bindings as PrimerArtifactV1['bindings'];
              }
              if (legacy) await retainLegacySource(artifact, legacy, workspaceRoot);
              artifact = parsePrimerArtifact(serializePrimerArtifact(artifact));
              await platform().fs.writeWorkspaceTextFileAtomic({
                workspaceRoot,
                path: artifactPath,
                content: serializePrimerArtifact(artifact),
                mode: 'create',
                mutationToken,
              });
            }
            result.pendingArtifactPaths.push(artifactPath);
            const history = await dependencies.commit(
              workspaceRoot,
              [artifact.file.workspaceRelativePath],
              dirtyBefore,
              `Recover primer ${current.name}`,
              mutationToken
            );
            if (history === 'failed')
              throw new Error(
                'The primer document is saved, but its project history must succeed before recovery can finish.'
              );
            await dependencies.project(artifact, workspaceRoot, { mutationToken });
            result.pendingArtifactPaths = result.pendingArtifactPaths.filter(
              (path) => path !== artifactPath
            );
            result.recovered++;
            result.records.push({
              id: current.id,
              name: current.name,
              source: 'registry',
              status: 'recovered',
              artifactPath,
            });
          },
          options.mutationToken,
          { waitForAvailability: true }
        );
      } catch (error) {
        options.signal?.throwIfAborted();
        const diagnostic = primerRecoveryDiagnostic(error);
        result.errors.push({
          path: `registry:${row.id}`,
          primerName: row.name,
          message: diagnostic.message,
        });
        result.records.push({
          id: row.id,
          name: row.name,
          source: 'registry',
          status: 'unresolved',
          ...diagnostic,
        });
      }
    }
    const legacyRows = selection
      ? selection.size === 0
        ? []
        : await platform().db.select<DbPrimerRow[]>(
            `SELECT p.* FROM primers p WHERE p.workspace_id IS NULL AND p.id IN (${[...selection].map(() => '?').join(',')})
           AND NOT EXISTS (SELECT 1 FROM lims_entity e WHERE e.id=p.id) ORDER BY p.id`,
            [...selection.keys()]
          )
      : await platform().db.select<DbPrimerRow[]>(
          `SELECT p.* FROM primers p WHERE (p.workspace_id = ? ${includesUnassigned ? 'OR p.workspace_id IS NULL' : ''})
     AND NOT EXISTS (SELECT 1 FROM lims_entity e WHERE e.id = p.id) ORDER BY p.id`,
          [workspace.id]
        );
    for (const row of legacyRows) {
      options.signal?.throwIfAborted();
      try {
        await withRendererWorkspaceMutation(
          workspaceRoot,
          async (mutationToken) => {
            const legacy = await readLegacySource(row.id);
            if (!legacy) return;
            if (selection && legacy.fingerprint !== selection.get(row.id))
              throw new Error(
                'The legacy primer changed after the recovery snapshot; its current record was preserved.'
              );
            const trashed = await findTrashedPrimerDocument(row.id);
            if (trashed) {
              await dependencies.retireTrashed(row.id, workspaceRoot, { mutationToken });
              result.records.push({
                id: row.id,
                name: row.name,
                source: 'legacy',
                status: 'trashed',
                artifactPath: trashed.path,
              });
              return;
            }
            if (legacy.row.workspace_id != null && legacy.row.workspace_id !== workspace.id)
              throw new Error('The legacy primer project changed before recovery.');
            const existing = await platform().db.select<Array<{ id: string }>>(
              'SELECT id FROM lims_entity WHERE id = ?',
              [row.id]
            );
            if (existing.length) return;
            const catalog = await platform().db.select<Array<{ id: string }>>(
              'SELECT id FROM catalog_entities WHERE id = ?',
              [row.id]
            );
            if (catalog.length)
              throw new Error(
                'The legacy identity already belongs to a catalog record; it was preserved for review.'
              );
            const stem = selection
              ? await legacyPrimerRecoveryArtifactStem(row.name, row.id)
              : row.id.length <= 128 && sanitizePrimerArtifactStem(row.id) === row.id
                ? row.id
                : await sha256Hex(row.id);
            const artifactPath = defaultPrimerArtifactPath(workspaceRoot, stem);
            const dirtyBefore = await dependencies.dirtyPaths(workspaceRoot, mutationToken);
            let artifact: PrimerArtifactV1;
            if (await platform().fs.exists(artifactPath)) {
              artifact = parsePrimerArtifact(await platform().fs.readTextFile(artifactPath));
              if (
                artifact.id !== row.id ||
                artifact.recovery?.source !== 'legacy' ||
                artifact.recovery.sourceFingerprint !== legacy.fingerprint
              )
                throw new Error(
                  'An existing primer document differs from the legacy recovery source; it was preserved.'
                );
            } else {
              const source = legacy.row;
              artifact = await buildPrimerArtifact({
                id: source.id,
                name: source.name,
                sequence: source.sequence,
                catalogNumber:
                  source.catalog_number ||
                  (await generateCatalogNumber(workspace.id, workspaceRoot, mutationToken)),
                oligo: recoveryOligo(source.sequence, 'dna', undefined, source.modifications),
                artifactPath,
                workspaceRoot,
                notes: source.notes,
                application: source.application as PrimerApplication | null,
                source: 'reconciled',
                actor: 'primer-record-recovery',
                now: source.created_at,
              });
              artifact.metadata.updatedAt = new Date(source.updated_at).toISOString();
              artifact.entity!.state = {
                registrationStatus: 'registered',
                domainStatus: source.status,
                archived: source.status === 'archived',
                archivedAt: null,
                status: source.status,
                source: source.origin,
              };
              artifact.recovery = {
                schema: 'dnaforge.primer-recovery/v1',
                source: 'legacy',
                sourceFingerprint: legacy.fingerprint,
              };
              await retainLegacySource(artifact, legacy, workspaceRoot);
              artifact = parsePrimerArtifact(serializePrimerArtifact(artifact));
              await platform().fs.writeWorkspaceTextFileAtomic({
                workspaceRoot,
                path: artifactPath,
                content: serializePrimerArtifact(artifact),
                mode: 'create',
                mutationToken,
              });
            }
            result.pendingArtifactPaths.push(artifactPath);
            const history = await dependencies.commit(
              workspaceRoot,
              [artifact.file.workspaceRelativePath],
              dirtyBefore,
              `Recover primer ${legacy.row.name}`,
              mutationToken
            );
            if (history === 'failed')
              throw new Error(
                'The primer document is saved, but its project history must succeed before recovery can finish.'
              );
            if (
              selection &&
              (await readLegacySource(row.id))?.fingerprint !== selection.get(row.id)
            )
              throw new Error(
                'The legacy primer changed before recovery publication; its current record was preserved.'
              );
            await dependencies.project(artifact, workspaceRoot, { mutationToken });
            result.pendingArtifactPaths = result.pendingArtifactPaths.filter(
              (path) => path !== artifactPath
            );
            result.recovered++;
            result.records.push({
              id: row.id,
              name: legacy.row.name,
              source: 'legacy',
              status: 'recovered',
              artifactPath,
            });
          },
          options.mutationToken,
          { waitForAvailability: true }
        );
      } catch (error) {
        options.signal?.throwIfAborted();
        const diagnostic = primerRecoveryDiagnostic(error);
        result.errors.push({
          path: `legacy-primer:${row.id}`,
          primerName: row.name,
          message: diagnostic.message,
        });
        result.records.push({
          id: row.id,
          name: row.name,
          source: 'legacy',
          status: 'unresolved',
          ...diagnostic,
        });
      }
    }
    return result;
  }
  return {
    primerRecoverySourceFingerprint,
    primerRecoveryRelationshipsFingerprint,
    recoverPrimerRecordsInWorkspace,
  };
}
