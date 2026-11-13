import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import {
  materializeNativeWorkspaceInsideTx,
  type NativeWorkspaceMaterializationPlan,
} from './native-workspace-materializer';
import { writeNativeWorkspaceManifest } from './native-workspace-manifest';
import { readNativeSequenceClassificationReview } from './native-sequence-classification-review';
import { extractOligoClassificationEvidence } from './benchling-migration/oligo-classification-evidence';
import {
  updateLimsEntityInsideTx,
  linkLimsEntitiesInsideTx,
  insertAuditEvent,
} from './lims-engine-core';
import { replaceLimsOutgoingRelationshipsInDb } from './lims';
import type { OligoClassificationReview } from '../shared/oligo-classification';
import {
  applyNativeSequenceClassification,
  mutateNativeCatalogSequence,
} from './native-sequence-classification';
import { getEntityRowById } from './lims-engine-core';
import { limsEntityFromRow, parseLimsSchemaFields } from '../shared/lims';
import * as publication from './native-catalog-publication';
import { recoverNativeCatalogRecordPublications } from './native-catalog-record-mutations';
import { reconcileNativeCatalogRecordsFromFile } from './native-catalog-record-reconcile';
import { registerNativeWorkspaceInsideTx } from './native-workspace-materializer';
import { scopedProjectionId } from '../shared/workspace-scoped-identity';
import { relocateEntityFile, relinkMovedEntityFile } from './ipc/workspace-relocate';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import { installNativeDocumentTestProfile } from './__tests__/native-document-profile-fixture';

installNativeDocumentTestProfile();

vi.setConfig({ testTimeout: 30_000 });

let relocationDb: Database.Database;
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('./ipc/database', () => ({ getDb: () => relocationDb }));
vi.mock('./ipc/path-allowlist', () => ({
  withSafeWritablePaths: async <T>(
    requests: readonly { path: string }[],
    operation: (paths: readonly string[]) => Promise<T>
  ) => operation(requests.map(({ path }) => workspaceMutationRootIdentity(path))),
}));

const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const genbank = (bases: string, topology = 'linear') =>
  `LOCUS       Candidate ${bases.length} bp DNA ${topology}\nDEFINITION  Classification fixture.\nFEATURES             Location/Qualifiers\n     misc_feature    1..4\n                     /label="Keep annotation"\nORIGIN\n        1 ${bases.toLowerCase()}\n//\n`;
describe('file-bound native sequence classification review', () => {
  let root: string, workspacePath: string, entityId: string, db: Database.Database;
  const target = 'seq_OLIGO001';
  const bases = 'ACGTACGTACGTACGTACGTACGT';
  const catalog = () => join(workspacePath, '.forge/catalog.json');
  const review = () => readNativeSequenceClassificationReview(db, entityId);
  const token = (value: OligoClassificationReview) => {
    if (value.status !== 'review') throw new Error(JSON.stringify(value));
    return value.reviewToken;
  };
  beforeEach(async ({ task }) => {
    root = await mkdtemp(join(tmpdir(), 'classification-review-'));
    workspacePath = join(root, 'workspace');
    if (task.name.includes('symlink-spelled workspace')) {
      const physical = join(root, 'physical-parent');
      const alias = join(root, 'alias-parent');
      await mkdir(physical);
      await symlink(physical, alias, 'dir');
      workspacePath = join(alias, 'workspace');
    }
    await mkdir(workspacePath);
    db = openFileTestDb(join(root, 'profile.sqlite'));
    relocationDb = db;
    ensureSchema(db, join(root, 'profile.sqlite'));
    const rna = task.name.includes('RNA oligo');
    const sourceBases = rna ? bases.replaceAll('T', 'U') : bases;
    const content = genbank(sourceBases).replace('bp DNA', rna ? 'bp RNA' : 'bp DNA');
    await writeFile(join(workspacePath, 'Candidate.gb'), content);
    const evidence = extractOligoClassificationEvidence({
      html: `<p>Forward primer: <span class="internalLink" data-internal-link='{"id":"${target}","iconId":"oligo"}'>Candidate</span></p>`,
      sourceObjectId: 'etr_NOTEBOOK01',
      sourceEntryPath: 'Experiment.html',
      sourceEntrySha256: sha('source'),
    });
    const plan: NativeWorkspaceMaterializationPlan = {
      schema: 'dnaforge.native-workspace-materialization.v1',
      entities: [
        {
          rawId: 'sequence-one',
          type: 'sequence',
          name: 'Candidate',
          locator: { kind: 'file' },
          storageType: 'file',
          placement: { kind: 'file', relativePath: 'Candidate.gb', fileKind: 'genbank' },
          sourceIdentities: [
            {
              provider: 'benchling',
              stableObjectId: target,
              objectClass: 'sequence',
              bindingKind: 'observed',
            },
          ],
        },
        {
          rawId: 'source-notebook',
          type: 'notebook',
          name: 'Experiment',
          locator: { kind: 'entity', namespace: 'page' },
          storageType: 'database',
          placement: {
            kind: 'package',
            rootRelativePath: 'Experiment',
            primaryRelativePath: 'Experiment/.forge/notebook.json',
            fileKind: 'notebook',
          },
          sourceIdentities: [
            {
              provider: 'benchling',
              stableObjectId: 'etr_NOTEBOOK01',
              objectClass: 'notebook',
              bindingKind: 'observed',
            },
          ],
          metadata: { classificationEvidence: evidence },
        },
      ],
      links: [],
      events: [],
      limsEntities: [
        {
          entityRawId: 'sequence-one',
          input: {
            kind: rna ? 'rna_sequence' : 'dna_sequence',
            name: 'Candidate',
            fields: {
              sequence: {
                mode: 'file',
                documentId: 'sequence-one',
                relPath: join(workspacePath, 'Candidate.gb'),
                length: bases.length,
                topology: 'linear',
                contentHash: sha(content),
                fileContentHash: sha(content),
                normalizedSequenceHash: sha(sourceBases),
                sourceFormat: 'gb',
              },
              notes: 'Preserve',
            },
          },
        },
      ],
    };
    const result = db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, {
        workspace: {
          name: 'Fixture',
          path: workspacePath,
          repoUuid: 'classification-fixture',
          createdAt: 1,
          lastOpenedAt: 1,
        },
        plan,
      })
    )();
    entityId = result.entityIdsByRawId['sequence-one'];
    await writeNativeWorkspaceManifest({ workspacePath, plan, manifestVersion: 2 });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  it('reviews exact source observations against real sequence bytes without writing', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get();
    const bytes = await readFile(catalog());
    expect(review()).toMatchObject({
      status: 'review',
      entityId,
      targetSourceId: target,
      currentKind: 'dna_sequence',
      evidenceLimited: false,
      assessment: { status: 'suggested', kind: 'oligo', use: 'primer' },
      sequence: { length: 24, topology: 'linear', molecule: 'dna' },
    });
    expect(token(review())).toBe(token(review()));
    expect(db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get()).toEqual(before);
    expect(await readFile(catalog())).toEqual(bytes);
  });
  it('changes the token for later registry edits and changed contributing evidence', async () => {
    const before = token(review());
    db.transaction(() =>
      updateLimsEntityInsideTx(db, { id: entityId, fields: { notes: 'Later edit' } })
    )();
    const next = token(review());
    expect(next).not.toBe(before);
    const manifest = JSON.parse(await readFile(catalog(), 'utf8'));
    manifest.entities[1].metadata.classificationEvidence.facts[1].excerpt = 'Reverse primer';
    await writeFile(catalog(), JSON.stringify(manifest));
    expect(token(review())).not.toBe(next);
  });
  it('does not guess when the portable source identity is ambiguous', async () => {
    const manifest = JSON.parse(await readFile(catalog(), 'utf8'));
    manifest.entities[0].sourceIdentities.push({
      ...manifest.entities[0].sourceIdentities[0],
      stableObjectId: 'seq_OTHER001',
    });
    await writeFile(catalog(), JSON.stringify(manifest));
    expect(review()).toMatchObject({ status: 'unavailable', reason: 'ambiguous_source_identity' });
  });
  it('requires complete evidence and does not borrow a mismatched source owner', async () => {
    const manifest = JSON.parse(await readFile(catalog(), 'utf8'));
    manifest.entities[1].metadata.classificationEvidence.facts[0].sourceObjectId =
      'etr_DIFFERENT01';
    await writeFile(catalog(), JSON.stringify(manifest));
    expect(review()).toMatchObject({
      status: 'review',
      evidenceLimited: true,
      assessment: { status: 'needs_review', reason: 'incomplete_evidence' },
    });
  });
  it.each([
    ['circular', genbank(bases, 'circular'), 'circular_sequence'],
    ['multiple', genbank(bases) + genbank(bases), 'multiple_sequences'],
    ['changed', genbank('CCCCACGTACGTACGTACGTACGT'), 'sequence_projection_outdated'],
    ['empty', genbank(''), 'missing_sequence'],
  ])(
    'refuses a %s file even if the stored metadata looks usable',
    async (_label, content, reason) => {
      await writeFile(join(workspacePath, 'Candidate.gb'), content);
      expect(review()).toMatchObject({ status: 'unavailable', reason });
    }
  );
  it('does not offer classification for archived records', () => {
    db.prepare('UPDATE lims_entity SET tombstone=1 WHERE id=?').run(entityId);
    expect(review()).toMatchObject({ status: 'unavailable', reason: 'archived_sequence' });
  });
  const runDatabase = <T>(operation: () => T) => operation();
  const apply = (
    requestId = 'classify-one',
    reviewToken = token(review()),
    choice: { kind: 'classify'; use: 'primer' | null } | { kind: 'keep_generic' } = {
      kind: 'classify',
      use: 'primer',
    }
  ) =>
    applyNativeSequenceClassification({
      db,
      runDatabase,
      input: { entityId, requestId, reviewToken, choice },
    });
  it.each(['reference', 'archived', 'trashed'] as const)(
    'refuses classification for a %s project before changing its database or files',
    async (state) => {
      const reviewToken = token(review());
      if (state === 'reference') db.prepare("UPDATE workspaces SET access_mode='reference'").run();
      else
        db.prepare(
          `UPDATE workspaces SET ${state === 'archived' ? 'archived_at' : 'trashed_at'}=3`
        ).run();
      const before = await readFile(catalog(), 'utf8');
      const beforeEntity = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(entityId);
      await expect(apply(`permission-${state}`, reviewToken)).rejects.toThrow(
        /WORKSPACE_READ_ONLY|WORKSPACE_INACTIVE/
      );
      expect(await readFile(catalog(), 'utf8')).toBe(before);
      expect(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(entityId)).toEqual(
        beforeEntity
      );
    }
  );

  const reconstruct = async () =>
    reconcileNativeCatalogRecordsFromFile(db, {
      workspaceRoot: workspacePath,
      expectedManifestSha256: sha(await readFile(catalog(), 'utf8')),
    });
  const freshProfile = (repoUuid = 'classification-fixture') => {
    db.close();
    db = openFileTestDb(join(root, 'fresh.sqlite'));
    ensureSchema(db, join(root, 'fresh.sqlite'));
    db.transaction(() =>
      registerNativeWorkspaceInsideTx(db, {
        path: workspacePath,
        name: 'Copied workspace',
        repoUuid,
        createdAt: 1,
        lastOpenedAt: 1,
      })
    )();
  };
  it('reconstructs classification and later edits in a fresh profile without touching the file', async () => {
    await apply();
    await mutateNativeCatalogSequence({
      db,
      runDatabase,
      action: 'update',
      input: {
        id: entityId,
        operationId: 'before-copy',
        expectedEventSeq: limsEntityFromRow(getEntityRowById(db, entityId)).eventSeq!,
        fields: { notes: 'My later note', use: 'probe' },
      },
    });
    const bytes = await readFile(join(workspacePath, 'Candidate.gb'));
    freshProfile();
    expect(await reconstruct()).toBe(1);
    const entity = limsEntityFromRow(getEntityRowById(db, entityId));
    expect(entity).toMatchObject({
      kind: 'oligo',
      tombstone: false,
      fields: {
        notes: 'My later note',
        use: 'probe',
        sequence: {
          mode: 'file',
          relPath: join(workspacePath, 'Candidate.gb'),
          length: 24,
        },
      },
    });
    const audit = db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get();
    await reconstruct();
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toEqual(entity);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get()).toEqual(audit);
    expect(await readFile(join(workspacePath, 'Candidate.gb'))).toEqual(bytes);
    expect(
      db
        .prepare('SELECT stable_object_id FROM catalog_provider_bindings WHERE entity_id=?')
        .all(entityId)
    ).toEqual([{ stable_object_id: target }]);
  });
  it('reconstructs generic file sequences in one native transaction and preserves later registry edits', async () => {
    db.transaction(() =>
      updateLimsEntityInsideTx(db, {
        id: entityId,
        name: 'Later name',
        fields: { notes: 'Later notes' },
        domainStatus: 'custom-status',
        actor: 'local-user',
      })
    )();
    await writeFile(join(workspacePath, 'Candidate.gb'), genbank(bases + 'ACGT'));
    await reconstruct();
    const current = limsEntityFromRow(getEntityRowById(db, entityId));
    expect(current).toMatchObject({
      kind: 'dna_sequence',
      name: 'Later name',
      domainStatus: 'custom-status',
      fields: {
        notes: 'Later notes',
        sequence: { length: 28, normalizedSequenceHash: sha(bases + 'ACGT') },
      },
    });
    const audit = db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get();
    await reconstruct();
    expect(db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get()).toEqual(audit);
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toEqual(current);
  });
  it('reconstructs a generic file sequence in a fresh profile with a local document identity', async () => {
    freshProfile();
    await reconstruct();
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toMatchObject({
      kind: 'dna_sequence',
      fields: {
        sequence: {
          documentId: entityId,
          relPath: join(workspacePath, 'Candidate.gb'),
          length: 24,
        },
      },
    });
  });
  it('scopes a generic sequence relationship and marks missing required fields unresolved in a fresh profile', async () => {
    const manifest = JSON.parse(await readFile(catalog(), 'utf8'));
    const lims = manifest.entities[0].lims;
    const existing = limsEntityFromRow(getEntityRowById(db, entityId));
    const revision = db
      .prepare(
        'SELECT r.fields,r.version,r.schema_id,s.display_name FROM lims_schema_revision r JOIN lims_schema s ON s.id=r.schema_id WHERE r.id=?'
      )
      .get(existing.schemaRevisionId) as {
      fields: string;
      version: number;
      schema_id: string;
      display_name: string;
    };
    lims.schemaRevisionId = `${existing.schemaRevisionId}-required`;
    lims.schemaSnapshot = {
      schemaId: revision.schema_id,
      schemaRevisionId: lims.schemaRevisionId,
      version: revision.version + 1,
      name: existing.kind,
      displayName: revision.display_name,
      baseKind: existing.kind,
      fields: parseLimsSchemaFields(revision.fields).fields,
    };
    lims.schemaSnapshot.fields.push({
      key: 'requiredNote',
      label: 'Required note',
      type: 'text',
      required: true,
    });
    lims.schemaSnapshot.fields.push({
      key: 'parent',
      label: 'Parent',
      type: 'record_relationship',
    });
    lims.fields.parent = {
      sourceTargetId: 'etr_NOTEBOOK01',
      destinationEntityId: 'source-notebook',
      relationType: 'references',
      label: 'Experiment',
      resolution: 'exact',
    };
    await writeFile(catalog(), JSON.stringify(manifest));
    freshProfile();
    await reconstruct();
    const entity = limsEntityFromRow(getEntityRowById(db, entityId));
    expect(entity.fields.parent).toMatchObject({
      destinationEntityId: scopedProjectionId('classification-fixture', 'source-notebook'),
    });
    expect(entity.registrationStatus).toBe('unresolved');
  });
  it('repairs a legacy generic reference without a document identity once', async () => {
    db.prepare(
      "UPDATE lims_entity SET fields=json_remove(fields, '$.sequence.documentId') WHERE id=?"
    ).run(entityId);
    await reconstruct();
    expect(limsEntityFromRow(getEntityRowById(db, entityId)).fields.sequence).toMatchObject({
      documentId: entityId,
    });
    const audit = db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get();
    await reconstruct();
    expect(db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get()).toEqual(audit);
  });
  it('does not create a scientific edit when the local sequence index is populated or rebuilt', async () => {
    await reconstruct();
    const original = limsEntityFromRow(getEntityRowById(db, entityId));
    const audit = db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get();
    const workspace = db.prepare('SELECT id FROM workspaces WHERE path=?').get(workspacePath) as {
      id: number;
    };
    db.prepare(
      `INSERT INTO indexed_files (id,workspace_id,path,name,extension,indexed_at)
      VALUES(100,?,?, 'Candidate.gb','gb',1)`
    ).run(workspace.id, join(workspacePath, 'Candidate.gb'));
    db.prepare(
      `INSERT INTO sequences(id,file_id,document_id,name,length) VALUES(200,100,?,'Candidate',24)`
    ).run(entityId);
    await reconstruct();
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toEqual(original);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get()).toEqual(audit);
    db.prepare('UPDATE sequences SET id=201 WHERE id=200').run();
    await reconstruct();
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toEqual(original);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get()).toEqual(audit);
  });
  it.each(['', 'foreign-workspace-document', 'sequence-one'])(
    'repairs stale document identity %j during generic reconstruction',
    async (documentId) => {
      db.prepare(
        "UPDATE lims_entity SET fields=json_set(fields, '$.sequence.documentId', ?, '$.sequence.sequenceId', 99999) WHERE id=?"
      ).run(documentId, entityId);
      await reconstruct();
      expect(limsEntityFromRow(getEntityRowById(db, entityId)).fields.sequence).toMatchObject({
        documentId: entityId,
        sequenceId: null,
      });
    }
  );
  it('keeps an ambiguous generic RNA oligo candidate inspectable but unavailable for classification', async () => {
    const content = genbank(bases).replace('bp DNA', 'bp RNA');
    await writeFile(join(workspacePath, 'Candidate.gb'), content);
    await reconstruct();
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toMatchObject({
      kind: 'rna_sequence',
      fields: { sequence: { normalizedSequenceHash: sha(bases) } },
    });
    expect(review()).toMatchObject({ status: 'unavailable', reason: 'conflicting_molecule' });
    expect(await readFile(join(workspacePath, 'Candidate.gb'), 'utf8')).toBe(content);
  });
  it('rejects thymine in an RNA oligo candidate before classification', async () => {
    await writeFile(
      join(workspacePath, 'Candidate.gb'),
      genbank(bases).replace('bp DNA', 'bp RNA')
    );
    expect(review()).toMatchObject({ status: 'unavailable', reason: 'conflicting_molecule' });
  });
  it('rejects thymine in an RNA oligo during reconstruction without changing the last good row', async () => {
    await apply();
    const before = limsEntityFromRow(getEntityRowById(db, entityId));
    await writeFile(
      join(workspacePath, 'Candidate.gb'),
      genbank(bases).replace('bp DNA', 'bp RNA')
    );
    await expect(reconstruct()).rejects.toThrow(/molecule/i);
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toEqual(before);
  });
  it.each([
    'archived',
    'missing',
    'archived-missing',
    'record-missing',
    'record-archived-missing',
  ] as const)('reconstructs %s relationships in a fresh profile', async (state) => {
    const archived = state.includes('archived');
    const missing = state.includes('missing');
    const record = state.startsWith('record-');
    if (archived) {
      await apply();
      await mutateNativeCatalogSequence({
        db,
        runDatabase,
        action: 'archive',
        input: {
          id: entityId,
          operationId: 'archive-linked',
          expectedEventSeq: limsEntityFromRow(getEntityRowById(db, entityId)).eventSeq!,
        },
      });
    }
    const manifest = JSON.parse(await readFile(catalog(), 'utf8'));
    const other = structuredClone(manifest.entities[0]);
    other.id = 'sequence-two';
    other.name = 'Second sequence';
    other.placement.relativePath = 'Second.gb';
    delete other.lifecycle;
    delete other.metadata?.classificationDecision;
    other.sourceIdentities = [
      {
        provider: 'benchling',
        stableObjectId: 'seq_OTHER002',
        objectClass: 'sequence',
        bindingKind: 'observed',
      },
    ];
    other.lims.kind = 'dna_sequence';
    other.lims.name = 'Second sequence';
    delete other.lims.schemaSnapshot;
    delete other.lims.schemaRevisionId;
    delete other.lims.fields.use;
    other.lims.fields.sequence.relPath = 'Second.gb';
    if (record) {
      other.type = 'record';
      other.placement = {
        kind: 'catalog-record',
        parentRelativePath: '',
        displayName: other.name,
        catalogType: 'record',
        presentationKind: 'record',
      };
      other.lims = {
        kind: 'reagent',
        name: other.name,
        fields: { notes: 'Linked sequence' },
        schemaRevisionId: 'reagent-v1',
        schemaSnapshot: {
          schemaId: 'reagent',
          schemaRevisionId: 'reagent-v1',
          name: 'reagent',
          displayName: 'Reagent',
          baseKind: 'record',
          version: 1,
          fields: [{ key: 'notes', label: 'Notes', type: 'text' }],
        },
      };
    }
    manifest.entities.push(other);
    manifest.limsLinks = [
      {
        id: 'sequence-pair',
        fromEntityId: 'sequence-one',
        toEntityId: 'sequence-two',
        type: 'associated_with',
        payload: { note: 'Preserve relationship' },
      },
    ];
    await writeFile(join(workspacePath, 'Second.gb'), genbank(bases));
    await writeFile(catalog(), JSON.stringify(manifest));
    if (missing)
      await rename(join(workspacePath, 'Candidate.gb'), join(root, 'temporarily-missing.gb'));
    freshProfile();
    await reconstruct();
    if (missing) {
      expect(db.prepare('SELECT COUNT(*) AS n FROM lims_link').get()).toEqual({ n: 0 });
      await rename(join(root, 'temporarily-missing.gb'), join(workspacePath, 'Candidate.gb'));
      await reconstruct();
    }
    expect(
      db.prepare('SELECT from_entity_id,to_entity_id,type,tombstone FROM lims_link').all()
    ).toEqual([
      {
        from_entity_id: entityId,
        to_entity_id: scopedProjectionId('classification-fixture', 'sequence-two'),
        type: 'associated_with',
        tombstone: 0,
      },
    ]);
    expect(limsEntityFromRow(getEntityRowById(db, entityId)).tombstone).toBe(archived);
  });
  it.each([
    'edited',
    'removed',
    'lost-edited',
    'lost-removed',
    'lost-cycle',
    'collision-active',
    'collision-removed',
  ] as const)('preserves legacy sequence link authority after %s', async (mode) => {
    const type = mode === 'lost-cycle' ? 'derives_from' : 'associated_with';
    const manifest = JSON.parse(await readFile(catalog(), 'utf8'));
    const other = structuredClone(manifest.entities[0]);
    other.id = 'sequence-two';
    other.name = 'Second sequence';
    other.placement.relativePath = 'Second.gb';
    other.sourceIdentities = [];
    other.lims.name = other.name;
    other.lims.fields.sequence.relPath = 'Second.gb';
    manifest.entities.push(other);
    await writeFile(join(workspacePath, 'Second.gb'), genbank(bases));
    await writeFile(catalog(), JSON.stringify(manifest));
    await reconstruct();
    const otherId = scopedProjectionId('classification-fixture', other.id);
    db.transaction(() =>
      linkLimsEntitiesInsideTx(db, {
        id: 'legacy-random-link',
        fromEntityId: entityId,
        toEntityId: otherId,
        type,
        actor: 'workspace-reconcile',
        payload: { notes: 'original' },
      })
    )();
    const removed = mode.includes('removed');
    replaceLimsOutgoingRelationshipsInDb(db, {
      entityId,
      actor: 'local-user',
      relationships: removed
        ? []
        : [{ toEntityId: otherId, type, payload: { notes: 'later user edit' } }],
    });
    manifest.limsLinks = [
      {
        id: 'sequence-pair',
        fromEntityId: 'sequence-one',
        toEntityId: 'sequence-two',
        type,
        payload: { notes: 'original' },
      },
    ];
    if (mode.startsWith('collision')) {
      db.transaction(() =>
        linkLimsEntitiesInsideTx(db, {
          id: scopedProjectionId('classification-fixture', 'sequence-pair'),
          fromEntityId: otherId,
          toEntityId: entityId,
          type: 'associated_with',
          actor: 'local-user',
        })
      )();
    }
    await writeFile(catalog(), JSON.stringify(manifest));
    if (mode === 'lost-cycle') {
      db.prepare('DELETE FROM lims_link WHERE id=?').run('legacy-random-link');
      db.transaction(() =>
        linkLimsEntitiesInsideTx(db, {
          id: 'later-reverse-link',
          fromEntityId: otherId,
          toEntityId: entityId,
          type,
          actor: 'local-user',
        })
      )();
      const before = db.prepare('SELECT * FROM lims_link ORDER BY id').all();
      const audit = db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get();
      await expect(reconstruct()).rejects.toThrow(/cycle/i);
      expect(db.prepare('SELECT * FROM lims_link ORDER BY id').all()).toEqual(before);
      expect(db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get()).toEqual(audit);
      return;
    }
    const before = db.prepare('SELECT * FROM lims_link ORDER BY id').all();
    const audits = db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get();
    if (mode.startsWith('lost'))
      db.prepare('DELETE FROM lims_link WHERE id=?').run('legacy-random-link');
    if (mode.startsWith('collision')) await expect(reconstruct()).rejects.toThrow(/collision/i);
    else {
      await reconstruct();
      await reconstruct();
    }
    expect(db.prepare('SELECT * FROM lims_link ORDER BY id').all()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get()).toEqual(audits);
  });
  it('reconstructs archived classification without reviving it', async () => {
    await apply();
    await mutateNativeCatalogSequence({
      db,
      runDatabase,
      action: 'archive',
      input: {
        id: entityId,
        operationId: 'archive-before-copy',
        expectedEventSeq: limsEntityFromRow(getEntityRowById(db, entityId)).eventSeq!,
      },
    });
    freshProfile();
    await reconstruct();
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toMatchObject({
      kind: 'oligo',
      tombstone: true,
    });
    expect(db.prepare('SELECT status FROM catalog_entities WHERE id=?').get(entityId)).toEqual({
      status: 'archived',
    });
  });
  it('binds a copied classified sequence to its new workspace and profile identities', async () => {
    await apply();
    const copied = join(root, 'copied-workspace');
    await cp(workspacePath, copied, { recursive: true });
    workspacePath = copied;
    freshProfile('copied-classification');
    entityId = scopedProjectionId('copied-classification', 'sequence-one');
    await reconstruct();
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toMatchObject({
      kind: 'oligo',
      fields: {
        sequence: {
          documentId: entityId,
          sequenceId: null,
          relPath: join(copied, 'Candidate.gb'),
        },
      },
    });
  });
  it('retains the file-discovery hash namespace when refreshing an unchanged classified file', async () => {
    await apply();
    const content = await readFile(join(workspacePath, 'Candidate.gb'));
    const gitHash = `git:${createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')}`;
    db.prepare('UPDATE catalog_entity_files SET content_hash=? WHERE entity_id=?').run(
      gitHash,
      entityId
    );
    await reconstruct();
    expect(
      db.prepare('SELECT content_hash FROM catalog_entity_files WHERE entity_id=?').get(entityId)
    ).toEqual({ content_hash: gitHash });
  });
  it('refreshes the file-derived reference but preserves the explicit classification and notes', async () => {
    await apply();
    await writeFile(join(workspacePath, 'Candidate.gb'), genbank(bases + 'ACGT'));
    await reconstruct();
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toMatchObject({
      kind: 'oligo',
      fields: {
        notes: 'Preserve',
        use: 'primer',
        sequence: { length: 28, normalizedSequenceHash: sha(bases + 'ACGT') },
      },
    });
  });
  it('rejects a classification decision with a different molecule before projecting anything', async () => {
    await apply();
    const manifest = JSON.parse(await readFile(catalog(), 'utf8'));
    manifest.entities[0].metadata.classificationDecision.molecule = 'rna';
    await writeFile(catalog(), JSON.stringify(manifest));
    freshProfile();
    await expect(reconstruct()).rejects.toThrow(/classification/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lims_entity').get()).toEqual({ n: 0 });
  });
  it('reconstructs RNA oligo classification without changing uracil or DNA/RNA family', async () => {
    expect(review()).toMatchObject({
      status: 'review',
      assessment: { status: 'suggested', kind: 'rna_oligo' },
    });
    await apply();
    const bytes = await readFile(join(workspacePath, 'Candidate.gb'));
    freshProfile();
    await reconstruct();
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toMatchObject({
      kind: 'rna_oligo',
      fields: { use: 'primer' },
    });
    expect(await readFile(join(workspacePath, 'Candidate.gb'))).toEqual(bytes);
  });
  it('reconstructs an explicit keep-generic choice without an oligo use', async () => {
    await apply('keep-for-copy', token(review()), { kind: 'keep_generic' });
    freshProfile();
    await reconstruct();
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toMatchObject({
      kind: 'dna_sequence',
    });
    expect(limsEntityFromRow(getEntityRowById(db, entityId)).fields).not.toHaveProperty('use');
  });
  it('preserves missing-file fingerprints and applies archived lifecycle without fabricating bytes', async () => {
    await apply();
    const before = limsEntityFromRow(getEntityRowById(db, entityId));
    db.prepare('UPDATE catalog_entity_files SET content_hash=?,size_bytes=? WHERE entity_id=?').run(
      sha(genbank(bases)),
      Buffer.byteLength(genbank(bases)),
      entityId
    );
    const file = db
      .prepare('SELECT content_hash,size_bytes FROM catalog_entity_files WHERE entity_id=?')
      .get(entityId);
    await rm(join(workspacePath, 'Candidate.gb'));
    const manifest = JSON.parse(await readFile(catalog(), 'utf8'));
    manifest.entities[0].lifecycle = { state: 'archived', archivedAt: 12345 };
    await writeFile(catalog(), JSON.stringify(manifest));
    await reconstruct();
    expect(
      db
        .prepare('SELECT content_hash,size_bytes FROM catalog_entity_files WHERE entity_id=?')
        .get(entityId)
    ).toEqual(file);
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toMatchObject({
      tombstone: true,
      archivedAt: 12345,
      fields: before.fields,
    });
    expect(db.prepare('SELECT status FROM catalog_entities WHERE id=?').get(entityId)).toEqual({
      status: 'archived',
    });
  });
  it.each([
    ['empty', genbank('')],
    ['circular', genbank(bases, 'circular')],
    ['protein', '>Candidate\nMELKQWYF\n'],
  ])('does not reconstruct a classified %s file as a usable oligo', async (_label, content) => {
    await apply();
    const before = limsEntityFromRow(getEntityRowById(db, entityId));
    const audit = db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get();
    await writeFile(join(workspacePath, 'Candidate.gb'), content);
    await expect(reconstruct()).rejects.toThrow(/sequence|oligo/i);
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get()).toEqual(audit);
  });
  it('publishes explicit classification without altering sequence bytes, bindings or IDs', async () => {
    const bytes = await readFile(join(workspacePath, 'Candidate.gb'));
    const before = limsEntityFromRow(getEntityRowById(db, entityId));
    const oldManifest = JSON.parse(await readFile(catalog(), 'utf8'));
    const requestToken = token(review());
    const result = await apply('apply-explicit', requestToken);
    expect(result).toEqual({
      status: 'applied',
      entityId,
      requestId: 'apply-explicit',
      kind: 'oligo',
      use: 'primer',
    });
    const entity = limsEntityFromRow(getEntityRowById(db, entityId));
    expect(entity).toMatchObject({
      kind: 'oligo',
      registryId: before.registryId,
      fields: { sequence: before.fields.sequence, notes: 'Preserve', use: 'primer' },
    });
    const manifest = JSON.parse(await readFile(catalog(), 'utf8'));
    expect(manifest.entities[0]).toMatchObject({
      type: 'sequence',
      placement: oldManifest.entities[0].placement,
      sourceIdentities: oldManifest.entities[0].sourceIdentities,
      lims: {
        kind: 'oligo',
        schemaSnapshot: { baseKind: 'oligo' },
        fields: { sequence: { relPath: 'Candidate.gb', pathBase: 'workspace' }, use: 'primer' },
      },
      metadata: { classificationDecision: { choice: { kind: 'classify', use: 'primer' } } },
    });
    expect(manifest.entities[1]).toEqual(oldManifest.entities[1]);
    expect(await readFile(join(workspacePath, 'Candidate.gb'))).toEqual(bytes);
    expect(db.prepare('SELECT COUNT(*) AS n FROM native_catalog_publication_outbox').get()).toEqual(
      { n: 0 }
    );
    const auditCount = db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get();
    expect(await apply('apply-explicit', requestToken)).toEqual(result);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get()).toEqual(auditCount);
    await expect(apply('apply-explicit', requestToken, { kind: 'keep_generic' })).rejects.toThrow(
      /different request/i
    );
  });
  it('records keep-generic explicitly without inventing a biological classification', async () => {
    const before = limsEntityFromRow(getEntityRowById(db, entityId));
    expect(await apply('keep', token(review()), { kind: 'keep_generic' })).toMatchObject({
      kind: 'dna_sequence',
      use: null,
    });
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toEqual(before);
    expect(
      JSON.parse(await readFile(catalog(), 'utf8')).entities[0].metadata.classificationDecision
        .choice
    ).toEqual({ kind: 'keep_generic' });
  });
  it('returns a fresh review without writes after a registry edit', async () => {
    const previous = token(review());
    db.transaction(() =>
      updateLimsEntityInsideTx(db, { id: entityId, fields: { notes: 'New note' } })
    )();
    const bytes = await readFile(catalog());
    const audit = db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get();
    expect(await apply('stale', previous)).toMatchObject({
      status: 'stale',
      review: { status: 'review' },
    });
    expect(await readFile(catalog())).toEqual(bytes);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get()).toEqual(audit);
  });
  it('keeps reviewed scientific facts valid across a derived file-metadata refresh', async () => {
    const reviewed = token(review());
    const before = limsEntityFromRow(getEntityRowById(db, entityId));
    const sizeBytes = (await readFile(join(workspacePath, 'Candidate.gb'))).length;
    db.transaction(() =>
      updateLimsEntityInsideTx(db, {
        id: entityId,
        fields: {
          sequence: {
            ...(before.fields.sequence as Record<string, unknown>),
            sequenceId: 123,
            documentId: entityId,
            modifiedAt: Date.now(),
            sizeBytes,
          },
        },
        actor: 'workspace-reconcile',
      })
    )();
    expect(token(review())).toBe(reviewed);
    expect(await apply('after-derived-refresh', reviewed)).toMatchObject({
      status: 'applied',
      kind: 'oligo',
    });
    expect(limsEntityFromRow(getEntityRowById(db, entityId)).fields.sequence).toMatchObject({
      sequenceId: 123,
      documentId: entityId,
    });
  });
  it('recovers a committed classification after publication interruption and returns its original receipt', async () => {
    const reviewed = token(review());
    const fault = vi
      .spyOn(publication, 'publishNativeCatalogBytes')
      .mockRejectedValueOnce(new Error('Simulated classification publication interruption'));
    await expect(apply('interrupted', reviewed)).rejects.toThrow(/interruption/);
    fault.mockRestore();
    expect(limsEntityFromRow(getEntityRowById(db, entityId)).kind).toBe('oligo');
    expect(JSON.parse(await readFile(catalog(), 'utf8')).entities[0].lims.kind).toBe(
      'dna_sequence'
    );
    db.close();
    db = openFileTestDb(join(root, 'profile.sqlite'));
    ensureSchema(db, join(root, 'profile.sqlite'));
    await recoverNativeCatalogRecordPublications({ db, runDatabase, workspacePath });
    expect(JSON.parse(await readFile(catalog(), 'utf8')).entities[0].lims.kind).toBe('oligo');
    expect(await apply('interrupted', reviewed)).toMatchObject({
      status: 'applied',
      kind: 'oligo',
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM lims_audit WHERE event_type='sequence_classification_decided'"
        )
        .get()
    ).toEqual({ n: 1 });
  });
  it.each([
    ['internal', 'renderer'],
    ['external', 'renderer'],
    ['internal', 'main'],
    ['external', 'main'],
  ] as const)(
    'recovers pending classification before a non-token %s move from %s',
    async (mode, caller) => {
      const reviewed = token(review());
      const fault = vi
        .spyOn(publication, 'publishNativeCatalogBytes')
        .mockRejectedValueOnce(new Error('Interrupted classification publication'));
      await expect(apply('before-move', reviewed)).rejects.toThrow(/Interrupted/);
      fault.mockRestore();
      const oldPath = join(workspacePath, 'Candidate.gb');
      const newPath = join(workspacePath, 'Renamed.gb');
      const beforeBytes = await readFile(oldPath);
      if (mode === 'external') await rename(oldPath, newPath);
      await (mode === 'internal' ? relocateEntityFile : relinkMovedEntityFile)(
        { workspaceRoot: workspacePath, oldPath, newPath },
        caller === 'renderer' ? 93 : undefined
      );
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM native_catalog_publication_outbox').get()
      ).toEqual({ n: 0 });
      const portable = JSON.parse(await readFile(catalog(), 'utf8')).entities[0];
      expect(portable.lims.kind).toBe('oligo');
      expect(portable.placement.relativePath).toBe('Renamed.gb');
      expect(await readFile(newPath)).toEqual(beforeBytes);
      await recoverNativeCatalogRecordPublications({ db, runDatabase, workspacePath });
      expect(await apply('before-move', reviewed)).toMatchObject({
        status: 'applied',
        kind: 'oligo',
      });
    }
  );

  it.each(['internal', 'external'] as const)(
    'keeps a symlink-spelled workspace coherent on %s move without an explicit root',
    async (mode) => {
      await apply();
      const oldPath = join(workspacePath, 'Candidate.gb');
      const newPath = join(workspacePath, 'Moved.gb');
      const bytes = await readFile(oldPath);
      if (mode === 'external') await rename(oldPath, newPath);
      await (mode === 'internal' ? relocateEntityFile : relinkMovedEntityFile)(
        { oldPath, newPath, workspaceRoot: null },
        94
      );
      const portable = JSON.parse(await readFile(catalog(), 'utf8')).entities[0];
      expect(portable.placement.relativePath).toBe('Moved.gb');
      expect(portable.lims.fields.sequence.relPath).toBe('Moved.gb');
      expect(limsEntityFromRow(getEntityRowById(db, entityId)).fields.sequence).toMatchObject({
        relPath: newPath,
      });
      expect(
        db
          .prepare('SELECT path FROM catalog_entity_files WHERE entity_id=? AND status=?')
          .get(entityId, 'current')
      ).toEqual({ path: newPath });
      expect(await readFile(newPath)).toEqual(bytes);
    }
  );

  it.each(['catalog-file', 'catalog-locator', 'indexed-file', 'lims-file'] as const)(
    'rejects mixed symlink-spelled workspace references in %s before moving',
    async (component) => {
      await apply();
      const oldPath = join(workspacePath, 'Candidate.gb');
      const newPath = join(workspacePath, 'Moved.gb');
      const physical = workspaceMutationRootIdentity(oldPath);
      if (component === 'catalog-file')
        db.prepare('UPDATE catalog_entity_files SET path=? WHERE entity_id=?').run(
          physical,
          entityId
        );
      if (component === 'catalog-locator')
        db.prepare('UPDATE catalog_entities SET locator=? WHERE id=?').run(
          `file://${physical}`,
          entityId
        );
      if (component === 'indexed-file')
        db.prepare(
          'INSERT INTO indexed_files (workspace_id,path,name,extension,indexed_at) VALUES (?,?,?,?,?)'
        ).run(1, physical, 'Candidate.gb', 'gb', 0);
      if (component === 'lims-file')
        db.prepare(
          "UPDATE lims_entity SET fields=json_set(fields,'$.sequence.relPath',?) WHERE id=?"
        ).run(physical, entityId);
      const before = await readFile(catalog());
      const bytes = await readFile(oldPath);
      await expect(
        relocateEntityFile({ oldPath, newPath, workspaceRoot: null }, 94)
      ).rejects.toThrow(/MIXED_PATH_ALIASES/);
      expect(await readFile(catalog())).toEqual(before);
      expect(await readFile(oldPath)).toEqual(bytes);
      await expect(readFile(newPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );
  it('rejects duplicate physical owners of a symlink-spelled workspace before moving', async () => {
    await apply();
    db.prepare('INSERT INTO workspaces (name,path,created_at) VALUES (?,?,?)').run(
      'Duplicate alias',
      workspaceMutationRootIdentity(workspacePath),
      0
    );
    const oldPath = join(workspacePath, 'Candidate.gb');
    const before = await readFile(oldPath);
    await expect(
      relocateEntityFile(
        { oldPath, newPath: join(workspacePath, 'Moved.gb'), workspaceRoot: null },
        94
      )
    ).rejects.toThrow(/AMBIGUOUS_WORKSPACE/);
    expect(await readFile(oldPath)).toEqual(before);
  });

  it('publishes classified sequence edits, archive, restore and undo through the same portable authority', async () => {
    await apply();
    const mutate = async (
      action: 'update' | 'archive' | 'restore' | 'revert',
      operationId: string
    ) =>
      mutateNativeCatalogSequence({
        db,
        runDatabase,
        action,
        input: {
          id: entityId,
          expectedEventSeq: limsEntityFromRow(getEntityRowById(db, entityId)).eventSeq!,
          operationId,
          ...(action === 'update'
            ? { fields: { use: 'probe', notes: 'Saved after classification' } }
            : {}),
        },
      });
    await mutate('update', 'edit-classified');
    expect(JSON.parse(await readFile(catalog(), 'utf8')).entities[0].lims.fields).toMatchObject({
      use: 'probe',
      notes: 'Saved after classification',
    });
    await mutate('archive', 'archive-classified');
    expect(JSON.parse(await readFile(catalog(), 'utf8')).entities[0].lifecycle).toMatchObject({
      state: 'archived',
    });
    await mutate('restore', 'restore-classified');
    expect(JSON.parse(await readFile(catalog(), 'utf8')).entities[0].lifecycle).toEqual({
      state: 'active',
    });
    await mutate('revert', 'undo-restore-classified');
    expect(JSON.parse(await readFile(catalog(), 'utf8')).entities[0].lifecycle).toMatchObject({
      state: 'archived',
    });
    expect(JSON.parse(await readFile(catalog(), 'utf8')).entities[0].lims.kind).toBe('oligo');
  });
  it('undoes the classification without changing sequence bytes or leaving a specialized portable type', async () => {
    const bytes = await readFile(join(workspacePath, 'Candidate.gb'));
    await apply();
    const input = {
      id: entityId,
      expectedEventSeq: limsEntityFromRow(getEntityRowById(db, entityId)).eventSeq!,
      operationId: 'undo-classification',
    };
    const result = await mutateNativeCatalogSequence({ db, runDatabase, action: 'revert', input });
    expect(result.entity.kind).toBe('dna_sequence');
    const manifest = JSON.parse(await readFile(catalog(), 'utf8'));
    expect(manifest.entities[0].lims.kind).toBe('dna_sequence');
    expect(manifest.entities[0].metadata.classificationDecision.choice).toEqual({
      kind: 'keep_generic',
    });
    expect(await mutateNativeCatalogSequence({ db, runDatabase, action: 'revert', input })).toEqual(
      result
    );
    expect(await readFile(join(workspacePath, 'Candidate.gb'))).toEqual(bytes);
  });

  it('accepts reordered sequence retry keys and returns the original result after later edits', async () => {
    await apply();
    const input = {
      id: entityId,
      expectedEventSeq: limsEntityFromRow(getEntityRowById(db, entityId)).eventSeq!,
      operationId: 'sequence-receipt-a',
      fields: { notes: 'First edit', use: 'primer' },
    };
    const original = await mutateNativeCatalogSequence({
      db,
      runDatabase,
      action: 'update',
      input,
    });
    const later = await mutateNativeCatalogSequence({
      db,
      runDatabase,
      action: 'update',
      input: {
        id: entityId,
        operationId: 'sequence-receipt-b',
        expectedEventSeq: original.entity.eventSeq!,
        fields: { notes: 'Later edit' },
      },
    });
    const bytes = await readFile(catalog());
    const audit = db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
    expect(
      await mutateNativeCatalogSequence({
        db,
        runDatabase,
        action: 'update',
        input: {
          fields: { use: 'primer', notes: 'First edit' },
          operationId: input.operationId,
          expectedEventSeq: input.expectedEventSeq,
          id: entityId,
        },
      })
    ).toEqual(original);
    expect(limsEntityFromRow(getEntityRowById(db, entityId))).toEqual(later.entity);
    expect(await readFile(catalog())).toEqual(bytes);
    expect(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(audit);
  });

  it.each([undefined, 'future'] as const)(
    'handles a sequence receipt with hash version %s without changing later edits',
    async (requestHashVersion) => {
      await apply();
      const input = {
        id: entityId,
        operationId: 'legacy-sequence-retry',
        expectedEventSeq: limsEntityFromRow(getEntityRowById(db, entityId)).eventSeq!,
        fields: { notes: 'Original' },
      };
      const original = await mutateNativeCatalogSequence({
        db,
        runDatabase,
        action: 'update',
        input: { ...input, operationId: 'original-sequence-save' },
      });
      db.transaction(() =>
        insertAuditEvent(db, {
          eventType: 'native_sequence_changed',
          operationId: `native-sequence-edit:${input.operationId}`,
          idempotencyKey: `native-sequence-edit-receipt:${input.operationId}`,
          subjectTable: 'lims_entity',
          subjectId: entityId,
          workspaceId: original.entity.workspaceId,
          payload: {
            requestHash: sha(JSON.stringify({ action: 'update', input })),
            result: original,
            ...(requestHashVersion ? { requestHashVersion } : {}),
          },
        })
      )();
      const later = await mutateNativeCatalogSequence({
        db,
        runDatabase,
        action: 'update',
        input: {
          ...input,
          operationId: 'later-sequence-save',
          expectedEventSeq: original.entity.eventSeq!,
          fields: { notes: 'Later' },
        },
      });
      const bytes = await readFile(catalog());
      const audit = db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
      const retry = () => mutateNativeCatalogSequence({ db, runDatabase, action: 'update', input });
      if (requestHashVersion) await expect(retry()).rejects.toThrow(/version/);
      else {
        expect(await retry()).toEqual(original);
        await expect(
          mutateNativeCatalogSequence({
            db,
            runDatabase,
            action: 'update',
            input: {
              fields: input.fields,
              expectedEventSeq: input.expectedEventSeq,
              operationId: input.operationId,
              id: entityId,
            },
          })
        ).rejects.toThrow(/different request/);
      }
      expect(limsEntityFromRow(getEntityRowById(db, entityId))).toEqual(later.entity);
      expect(await readFile(catalog())).toEqual(bytes);
      expect(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(audit);
    }
  );
  it('does not undo the authoritative sequence reference when undoing a file refresh', async () => {
    await apply();
    const current = limsEntityFromRow(getEntityRowById(db, entityId));
    const bytes = genbank(bases + 'ACGT');
    await writeFile(join(workspacePath, 'Candidate.gb'), bytes);
    const sequence = current.fields.sequence;
    if (!sequence || typeof sequence !== 'object') throw new Error('Missing fixture sequence');
    const live = {
      ...sequence,
      length: 28,
      contentHash: sha(bytes),
      fileContentHash: sha(bytes),
      normalizedSequenceHash: sha(bases + 'ACGT'),
    };
    await mutateNativeCatalogSequence({
      db,
      runDatabase,
      action: 'update',
      input: {
        id: entityId,
        operationId: 'file-refresh',
        expectedEventSeq: current.eventSeq!,
        fields: { sequence: live },
        actor: 'workspace-reconcile',
      },
    });
    const result = await mutateNativeCatalogSequence({
      db,
      runDatabase,
      action: 'revert',
      input: {
        id: entityId,
        operationId: 'undo-file-refresh',
        expectedEventSeq: limsEntityFromRow(getEntityRowById(db, entityId)).eventSeq!,
      },
    });
    expect(result.entity.fields.sequence).toEqual(live);
    expect(
      JSON.parse(await readFile(catalog(), 'utf8')).entities[0].lims.fields.sequence.length
    ).toBe(28);
    expect(await readFile(join(workspacePath, 'Candidate.gb'), 'utf8')).toBe(bytes);
  });
  it.each(['schema', 'status', 'archive'])(
    'preserves a later portable %s change instead of overwriting it during a scalar edit',
    async (change) => {
      await apply();
      const manifest = JSON.parse(await readFile(catalog(), 'utf8'));
      if (change === 'schema')
        manifest.entities[0].lims.schemaSnapshot.fields[0].label = 'Later sequence label';
      if (change === 'status') manifest.entities[0].lims.domainStatus = 'Later status';
      if (change === 'archive')
        manifest.entities[0].lifecycle = { state: 'archived', archivedAt: 101 };
      const bytes = JSON.stringify(manifest);
      await writeFile(catalog(), bytes);
      const before = limsEntityFromRow(getEntityRowById(db, entityId));
      await expect(
        mutateNativeCatalogSequence({
          db,
          runDatabase,
          action: 'update',
          input: {
            id: entityId,
            operationId: `conflict-${change}`,
            expectedEventSeq: before.eventSeq!,
            fields: { notes: 'New edit' },
          },
        })
      ).rejects.toThrow(/disagree|changed/i);
      expect(await readFile(catalog(), 'utf8')).toBe(bytes);
      expect(limsEntityFromRow(getEntityRowById(db, entityId))).toEqual(before);
    }
  );
  it.each(['inline', 'other-file'] as const)(
    'refuses a %s replacement through classified sequence updates',
    async (mode) => {
      await apply();
      const before = limsEntityFromRow(getEntityRowById(db, entityId));
      const manifest = await readFile(catalog());
      const audit = db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get();
      const sequence = before.fields.sequence;
      if (!sequence || typeof sequence !== 'object') throw new Error('fixture sequence');
      const other = join(workspacePath, 'Other.gb');
      await writeFile(other, genbank(bases));
      await expect(
        mutateNativeCatalogSequence({
          db,
          runDatabase,
          action: 'update',
          input: {
            id: entityId,
            operationId: `replace-${mode}`,
            expectedEventSeq: before.eventSeq!,
            fields: {
              sequence:
                mode === 'inline'
                  ? { mode: 'inline', bases, length: bases.length, topology: 'linear' }
                  : { ...sequence, relPath: other },
            },
          },
        })
      ).rejects.toThrow(/authoritative|molecule|kind|schema/i);
      expect(limsEntityFromRow(getEntityRowById(db, entityId))).toEqual(before);
      expect(await readFile(catalog())).toEqual(manifest);
      expect(db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get()).toEqual(audit);
    }
  );
  it('refuses publication recovery after the pinned schema changes', async () => {
    const originalManifest = await readFile(catalog());
    const fault = vi
      .spyOn(publication, 'publishNativeCatalogBytes')
      .mockRejectedValueOnce(new Error('Interrupted publication'));
    await expect(apply('schema-interruption')).rejects.toThrow(/Interrupted/);
    fault.mockRestore();
    const entity = limsEntityFromRow(getEntityRowById(db, entityId));
    db.prepare('UPDATE lims_schema SET display_name=? WHERE id=?').run(
      'Later schema label',
      entity.schemaId
    );
    await expect(
      recoverNativeCatalogRecordPublications({ db, runDatabase, workspacePath })
    ).rejects.toThrow(/database|changed|conflict/i);
    expect(await readFile(catalog())).toEqual(originalManifest);
    expect(db.prepare('SELECT COUNT(*) AS n FROM native_catalog_publication_outbox').get()).toEqual(
      { n: 1 }
    );
  });
});
