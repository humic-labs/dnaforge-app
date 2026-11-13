import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb } from './__tests__/test-db';
import { derivePendingRefsInDb } from './lims-pending-refs';
import { ensureSchema } from './schema';
import {
  NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
  NativeSequenceSourceVersionConflictError,
  materializeNativeWorkspaceInsideTx,
  registerNativeWorkspaceInsideTx,
  type NativeWorkspaceEntityInput,
  type NativeWorkspaceMaterializationPlan,
} from './native-workspace-materializer';

describe('native workspace materializer', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
  });

  it('keeps reviewed sequence replacement names consistent across catalog and Registry', () => {
    const workspace = {
      name: 'Replacement lab',
      path: '/tmp/native-reviewed-replacement',
      repoUuid: 'native-reviewed-replacement',
      createdAt: 1,
      lastOpenedAt: 2,
    };
    const rawId = 'provider-sequence';
    const originalHash = `sha256:${createHash('sha256').update('ACGT').digest('hex')}` as const;
    const incomingHash = `sha256:${createHash('sha256').update('TGCA').digest('hex')}` as const;
    const sequence = {
      mode: 'file' as const,
      relPath: `${workspace.path}/Existing.gb`,
      topology: 'linear' as const,
      length: 4,
      contentHash: originalHash,
      fileContentHash: originalHash,
      normalizedSequenceHash: originalHash,
    };
    const plan: NativeWorkspaceMaterializationPlan = {
      schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
      entities: [
        {
          rawId,
          type: 'sequence',
          name: 'Original name',
          locator: { kind: 'file' },
          storageType: 'file',
          relativePath: 'Existing.gb',
          fileKind: 'genbank',
        },
      ],
      links: [],
      events: [],
      limsEntities: [
        {
          entityRawId: rawId,
          input: {
            kind: 'dna_sequence',
            name: 'Original name',
            fields: { sequence },
            registrationStatus: 'registered',
            actor: 'migration',
          },
        },
      ],
    };
    const created = db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, { workspace, plan })
    )();
    const replacement: NativeWorkspaceMaterializationPlan = {
      ...plan,
      entities: [{ ...plan.entities[0]!, name: 'Reviewed incoming name' }],
      limsEntities: [
        {
          entityRawId: rawId,
          input: {
            kind: 'dna_sequence',
            name: 'Reviewed incoming name',
            fields: {
              sequence: {
                ...sequence,
                contentHash: incomingHash,
                fileContentHash: incomingHash,
                normalizedSequenceHash: incomingHash,
              },
            },
            registrationStatus: 'registered',
            actor: 'migration',
          },
        },
      ],
      existingEntityReplacements: [
        { entityRawId: rawId, kind: 'scientific', expectedScientificSha256: originalHash },
      ],
    };
    db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, { workspace, plan: replacement })
    )();
    const id = created.entityIdsByRawId[rawId];
    expect(db.prepare('SELECT name FROM catalog_entities WHERE id=?').get(id)).toEqual({
      name: 'Reviewed incoming name',
    });
    expect(db.prepare('SELECT name FROM lims_entity WHERE id=?').get(id)).toEqual({
      name: 'Reviewed incoming name',
    });
    expect(db.prepare('SELECT count(*) AS n FROM lims_entity WHERE id=?').get(id)).toEqual({
      n: 1,
    });
  });

  it('requires the caller to own a transaction', () => {
    expect(() =>
      registerNativeWorkspaceInsideTx(db, {
        name: 'Imported workspace',
        path: '/tmp/native-import',
        repoUuid: 'workspace-native-1',
        createdAt: 1,
        lastOpenedAt: 2,
      })
    ).toThrow('requires an active transaction');
  });

  it('preserves a null repository UUID and scopes entities by workspace row', () => {
    const result = db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, {
        workspace: {
          name: 'Local folder',
          path: '/tmp/native-local-folder',
          repoUuid: null,
          createdAt: 1,
          lastOpenedAt: 2,
        },
        plan: {
          schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
          entities: [
            {
              rawId: 'record-1',
              type: 'sample',
              name: 'Record 1',
              locator: { kind: 'entity', namespace: 'lims' },
              storageType: 'database',
            },
          ],
          links: [],
          events: [],
        },
      })
    )();

    expect(
      db.prepare('SELECT repo_uuid FROM workspaces WHERE id = ?').get(result.workspaceId)
    ).toEqual({ repo_uuid: null });
    expect(result.entityIdsByRawId).toEqual({ 'record-1': `ws${result.workspaceId}::record-1` });
  });

  it.each([
    'unchanged',
    'moved',
    'workspace',
    'type',
    'storage',
    'locator',
    'metadata',
    'missing-binding',
    'missing-page',
    'incoming-placement',
    'incoming-page',
  ])('checks notebook package replacement catalog authority: %s', (variant) => {
    const workspace = {
      name: 'Package replacement',
      path: '/tmp/package-replacement',
      repoUuid: null,
      createdAt: 1,
      lastOpenedAt: 2,
    };
    const placement = {
      kind: 'package',
      rootRelativePath: 'Notes',
      primaryRelativePath: 'Notes/.forge/notebook.json',
      fileKind: 'waypoint-notebook',
    } as const;
    const entity: NativeWorkspaceEntityInput = {
      rawId: 'notebook',
      name: 'Notes',
      type: 'notebook',
      storageType: 'database',
      locator: { kind: 'entity', namespace: 'page' },
      placement,
      page: {
        title: 'Original',
        content: { type: 'doc', content: [] },
        createdAt: 1,
        updatedAt: 2,
      },
    };
    const plan: NativeWorkspaceMaterializationPlan = {
      schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
      entities: [entity],
      links: [],
      events: [],
    };
    const created = db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, { workspace, plan })
    )();
    const id = created.entityIdsByRawId.notebook;
    if (variant === 'moved')
      db.prepare(
        "UPDATE catalog_entity_files SET relative_path='Moved', path=? WHERE entity_id=?"
      ).run(resolve(workspace.path, 'Moved'), id);
    if (variant === 'workspace')
      db.prepare('UPDATE catalog_entities SET workspace_id=NULL WHERE id=?').run(id);
    if (variant === 'type')
      db.prepare("UPDATE catalog_entities SET type='sequence' WHERE id=?").run(id);
    if (variant === 'storage')
      db.prepare("UPDATE catalog_entities SET storage_type='file' WHERE id=?").run(id);
    if (variant === 'locator')
      db.prepare("UPDATE catalog_entities SET locator='entity://page/other' WHERE id=?").run(id);
    if (variant === 'metadata')
      db.prepare("UPDATE catalog_entities SET metadata='{}' WHERE id=?").run(id);
    if (variant === 'missing-binding')
      db.prepare('DELETE FROM catalog_entity_files WHERE entity_id=?').run(id);
    if (variant === 'missing-page') db.prepare('DELETE FROM pages WHERE id=?').run(id);
    const before = db.prepare('SELECT id,title,content FROM pages').all();
    const incoming: NativeWorkspaceEntityInput = {
      ...entity,
      page: {
        title: 'Replacement',
        content: { type: 'doc', content: [] },
        createdAt: 1,
        updatedAt: 3,
      },
    };
    if (variant === 'incoming-placement')
      incoming.placement = {
        ...placement,
        rootRelativePath: 'Moved',
        primaryRelativePath: 'Moved/.forge/notebook.json',
      };
    if (variant === 'incoming-page') delete incoming.page;
    const apply = db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, {
        workspace,
        plan: {
          ...plan,
          entities: [incoming],
          existingEntityReplacements: [
            {
              entityRawId: 'notebook',
              kind: 'notebook_package',
              layout: 'native',
              expectedPlacement: placement,
            },
          ],
        },
      })
    );
    if (variant === 'unchanged') {
      apply();
      expect(db.prepare('SELECT title FROM pages WHERE id=?').get(id)).toEqual({
        title: 'Replacement',
      });
      expect(db.prepare('SELECT id FROM lims_entity WHERE id=?').get(id)).toBeUndefined();
    } else {
      expect(apply).toThrow(/replacement/);
      expect(db.prepare('SELECT id,title,content FROM pages').all()).toEqual(before);
    }
  });

  it.each(['protocol', 'protocol_run'] as const)(
    'replaces a checked %s package without page or Registry authority',
    (type) => {
      const workspace = {
        name: 'Protocol replacement',
        path: '/tmp/protocol-replacement',
        repoUuid: null,
        createdAt: 1,
        lastOpenedAt: 2,
      };
      const placement = {
        kind: 'package',
        rootRelativePath: 'Protocol',
        primaryRelativePath: 'Protocol/protocol.json',
        fileKind: type === 'protocol' ? 'waypoint-protocol' : 'waypoint-protocol-run',
      } as const;
      const entity: NativeWorkspaceEntityInput = {
        rawId: 'protocol',
        name: 'Before',
        type,
        storageType: 'file',
        locator: { kind: 'file' },
        placement,
      };
      const plan: NativeWorkspaceMaterializationPlan = {
        schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
        entities: [entity],
        links: [],
        events: [],
      };
      const created = db.transaction(() =>
        materializeNativeWorkspaceInsideTx(db, { workspace, plan })
      )();
      const replacement: NativeWorkspaceMaterializationPlan = {
        ...plan,
        entities: [{ ...entity, name: 'After' }],
        existingEntityReplacements: [
          {
            entityRawId: entity.rawId,
            kind: 'protocol_package',
            expectedType: type,
            layout: 'native',
            expectedPlacement: placement,
          },
        ],
      };
      const apply = () =>
        db.transaction(() =>
          materializeNativeWorkspaceInsideTx(db, { workspace, plan: replacement })
        )();
      apply();
      const id = created.entityIdsByRawId.protocol;
      expect(db.prepare('SELECT name FROM catalog_entities WHERE id=?').get(id)).toEqual({
        name: 'After',
      });
      expect(db.prepare('SELECT id FROM pages WHERE id=?').get(id)).toBeUndefined();
      expect(db.prepare('SELECT id FROM lims_entity WHERE id=?').get(id)).toBeUndefined();
      replacement.entities[0]!.page = {
        title: 'Not a notebook',
        content: { type: 'doc', content: [] },
        createdAt: 1,
        updatedAt: 2,
      };
      expect(apply).toThrow(/storage binding/);
      delete replacement.entities[0]!.page;
      db.prepare("UPDATE catalog_entities SET locator='file:///elsewhere' WHERE id=?").run(id);
      expect(apply).toThrow(/storage binding/);
    }
  );

  it('materializes v2 file, package, and catalog placements without fake paths', () => {
    const workspace = {
      name: 'Native v2 workspace',
      path: '/tmp/native-v2-workspace',
      repoUuid: null,
      createdAt: 1_000,
      lastOpenedAt: 2_000,
    };
    const result = db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, {
        workspace,
        plan: {
          schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
          entities: [
            {
              rawId: 'sequence-file',
              type: 'sequence',
              name: 'Sequence file',
              locator: { kind: 'file' },
              storageType: 'file',
              placement: {
                kind: 'file',
                relativePath: 'Sequences/sequence-file.gb',
                fileKind: 'genbank',
              },
            },
            {
              rawId: 'notebook-package',
              type: 'notebook',
              name: 'Notebook package',
              locator: { kind: 'entity', namespace: 'page' },
              storageType: 'database',
              placement: {
                kind: 'package',
                rootRelativePath: 'Notebooks/Notebook package',
                primaryRelativePath: 'Notebooks/Notebook package/.forge/notebook.json',
                fileKind: 'waypoint-notebook',
              },
              page: {
                title: 'Notebook package',
                content: { type: 'doc', content: [] },
                createdAt: 1_000,
                updatedAt: 1_000,
              },
            },
            {
              rawId: 'strain-record',
              type: 'sample',
              name: 'Strain record',
              locator: { kind: 'entity', namespace: 'lims' },
              storageType: 'database',
              placement: {
                kind: 'catalog-record',
                parentRelativePath: 'Strains',
                displayName: 'Strain record',
                catalogType: 'sample',
                presentationKind: 'strain',
              },
              migrationSource: {
                historyRunId: 'run-v2',
                sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
                sourceObjectId: 'bfi_STRAINAA',
              },
            },
          ],
          links: [],
          events: [],
          limsEntities: [
            {
              entityRawId: 'strain-record',
              input: {
                kind: 'strain',
                name: 'Strain record',
                fields: { genotypeCanonical: 'deltaX' },
                registrationStatus: 'registered',
                actor: 'migration',
              },
            },
          ],
        },
      })
    )();

    expect(
      db
        .prepare(
          `SELECT entity_id, relative_path, file_kind
           FROM catalog_entity_files
           ORDER BY relative_path`
        )
        .all()
    ).toEqual([
      {
        entity_id: `ws${result.workspaceId}::notebook-package`,
        relative_path: 'Notebooks/Notebook package',
        file_kind: 'waypoint-notebook',
      },
      {
        entity_id: `ws${result.workspaceId}::sequence-file`,
        relative_path: 'Sequences/sequence-file.gb',
        file_kind: 'genbank',
      },
    ]);
    expect(db.prepare('SELECT * FROM catalog_workspace_placements').all()).toEqual([
      expect.objectContaining({
        entity_id: `ws${result.workspaceId}::strain-record`,
        workspace_id: result.workspaceId,
        parent_relative_path: 'Strains',
        display_name: 'Strain record',
        presentation_kind: 'strain',
        status: 'active',
      }),
    ]);
    const strain = db
      .prepare('SELECT locator, metadata FROM catalog_entities WHERE id = ?')
      .get(`ws${result.workspaceId}::strain-record`) as { locator: string; metadata: string };
    expect(strain.locator).toBe(`entity://lims/ws${result.workspaceId}::strain-record`);
    expect(JSON.parse(strain.metadata)).toMatchObject({
      migrationSource: {
        historyRunId: 'run-v2',
        sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
        sourceObjectId: 'bfi_STRAINAA',
      },
    });
  });

  it('prepares a bounded statement set for a large native batch', () => {
    const workspace = {
      name: 'Large imported workspace',
      path: '/tmp/native-large-import',
      repoUuid: 'workspace-native-large',
      createdAt: 1_000,
      lastOpenedAt: 2_000,
    };
    const entityCount = 250;
    const entities = Array.from({ length: entityCount }, (_, index): NativeWorkspaceEntityInput => {
      const rawId = `strain-${index}`;
      return {
        rawId,
        type: 'sample',
        name: `Strain ${index}`,
        locator: { kind: 'entity', namespace: 'lims' },
        storageType: 'database',
        sourceIdentities: [
          {
            provider: 'benchling',
            stableObjectId: `bfi_${String(index).padStart(8, '0')}`,
            objectClass: 'registry_entity',
            bindingKind: 'observed',
          },
        ],
      };
    });
    const plan = {
      schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
      entities,
      links: entities.slice(1).map((entity, index) => ({
        sourceRawId: entity.rawId,
        relation: 'derived_from',
        targetRawId: entities[index]!.rawId,
      })),
      events: entities.map((entity, index) => ({
        id: `event-${index}`,
        entityRawId: entity.rawId,
        eventType: 'imported',
        createdAt: 2_000,
      })),
      limsEntities: entities.map((entity) => ({
        entityRawId: entity.rawId,
        input: {
          kind: 'strain',
          name: entity.name,
          fields: { genotypeCanonical: `genotype-${entity.rawId}` },
          registrationStatus: 'registered' as const,
          actor: 'migration',
          createdAt: 1_000,
        },
      })),
      limsLinks: entities.slice(1).map((entity, index) => ({
        id: `lims-link-${index}`,
        fromEntityRawId: entity.rawId,
        toEntityRawId: entities[index]!.rawId,
        type: 'associated_with',
        payload: { sourceRelation: 'derived_from' },
      })),
    };
    const prepareSpy = vi.spyOn(db, 'prepare');

    db.transaction(() => materializeNativeWorkspaceInsideTx(db, { workspace, plan }))();

    expect(prepareSpy.mock.calls.length).toBeGreaterThan(0);
    expect(prepareSpy.mock.calls.length).toBeLessThan(entityCount);
    prepareSpy.mockRestore();
  });

  it('never renames a workspace that already exists', () => {
    const workspace = {
      name: 'sundew_export_2',
      path: '/tmp/native-rename',
      repoUuid: 'workspace-native-rename',
      createdAt: 1_000,
      lastOpenedAt: 2_000,
    };
    db.transaction(() => registerNativeWorkspaceInsideTx(db, workspace))();
    db.prepare('UPDATE workspaces SET name = ? WHERE path = ?').run(
      'Sundew localization — my project',
      workspace.path
    );

    db.transaction(() =>
      registerNativeWorkspaceInsideTx(db, { ...workspace, lastOpenedAt: 9_000 })
    )();

    const row = db
      .prepare('SELECT name, last_opened_at AS lastOpenedAt FROM workspaces WHERE path = ?')
      .get(workspace.path) as { name: string; lastOpenedAt: number };
    expect(row.name).toBe('Sundew localization — my project');
    expect(row.lastOpenedAt).toBe(9_000);
  });

  it('atomically registers native folders, files, notebooks, links, events, and pages', () => {
    const workspace = {
      name: 'Imported workspace',
      path: '/tmp/native-import',
      repoUuid: 'workspace-native-1',
      createdAt: 1_000,
      lastOpenedAt: 2_000,
    };
    const result = db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, {
        workspace,
        plan: {
          schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
          entities: [
            {
              rawId: 'folder-root',
              type: 'folder',
              name: 'Lab notebook',
              locator: { kind: 'file' },
              storageType: 'file',
              relativePath: 'Imports/Lab notebook',
              fileKind: 'folder',
            },
            {
              rawId: 'sequence-1',
              type: 'sequence',
              name: 'pExample',
              locator: { kind: 'file' },
              storageType: 'file',
              relativePath: 'Imports/pExample.gb',
              fileKind: 'genbank',
              contentHash: `sha256:${'a'.repeat(64)}`,
              sizeBytes: 123,
              modifiedAt: 1_500,
            },
            {
              rawId: 'notebook-1',
              type: 'notebook',
              name: 'Experiment 1',
              locator: { kind: 'entity', namespace: 'page' },
              storageType: 'database',
              relativePath: 'Imports/Experiment 1',
              fileKind: 'waypoint-notebook',
              page: {
                title: 'Experiment 1',
                content: { type: 'doc', content: [] },
                createdAt: 1_200,
                updatedAt: 1_600,
              },
            },
          ],
          links: [
            {
              sourceRawId: 'sequence-1',
              relation: 'member_of',
              targetRawId: 'folder-root',
              confidence: 'confirmed',
            },
            {
              sourceRawId: 'notebook-1',
              relation: 'member_of',
              targetRawId: 'folder-root',
              confidence: 'confirmed',
            },
          ],
          events: [
            {
              id: 'event-import-sequence-1',
              entityRawId: 'sequence-1',
              eventType: 'artifact_imported',
              actor: 'migration',
              summary: 'Imported sequence',
              createdAt: 1_500,
            },
          ],
        },
      })
    )();

    expect(result).toMatchObject({
      entitiesMaterialized: 3,
      linksMaterialized: 2,
      eventsMaterialized: 1,
      pagesMaterialized: 1,
    });
    expect(result.entityIdsByRawId).toEqual({
      'folder-root': 'workspace-native-1::folder-root',
      'sequence-1': 'workspace-native-1::sequence-1',
      'notebook-1': 'workspace-native-1::notebook-1',
    });

    expect(
      db.prepare('SELECT type, name, locator FROM catalog_entities ORDER BY type, name').all()
    ).toEqual([
      {
        type: 'folder',
        name: 'Lab notebook',
        locator: `file://${resolve(workspace.path, 'Imports/Lab notebook')}`,
      },
      {
        type: 'notebook',
        name: 'Experiment 1',
        locator: 'entity://page/workspace-native-1::notebook-1',
      },
      {
        type: 'sequence',
        name: 'pExample',
        locator: `file://${resolve(workspace.path, 'Imports/pExample.gb')}`,
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT source_entity_id, relation, target_entity_id
           FROM catalog_entity_links ORDER BY source_entity_id`
        )
        .all()
    ).toEqual([
      {
        source_entity_id: 'workspace-native-1::notebook-1',
        relation: 'member_of',
        target_entity_id: 'workspace-native-1::folder-root',
      },
      {
        source_entity_id: 'workspace-native-1::sequence-1',
        relation: 'member_of',
        target_entity_id: 'workspace-native-1::folder-root',
      },
    ]);
    expect(db.prepare('SELECT id, title, content FROM pages').all()).toEqual([
      {
        id: 'workspace-native-1::notebook-1',
        title: 'Experiment 1',
        content: JSON.stringify({ type: 'doc', content: [] }),
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT path, relative_path, file_kind
           FROM catalog_entity_files
           WHERE entity_id = ? AND status = 'current'`
        )
        .get('workspace-native-1::notebook-1')
    ).toEqual({
      path: resolve(workspace.path, 'Imports/Experiment 1'),
      relative_path: 'Imports/Experiment 1',
      file_kind: 'waypoint-notebook',
    });
  });

  it('is idempotent and rejects a file already owned by another entity', () => {
    const workspace = {
      name: 'Imported workspace',
      path: '/tmp/native-import',
      repoUuid: 'workspace-native-1',
      createdAt: 1_000,
      lastOpenedAt: 2_000,
    };
    const plan = {
      schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
      entities: [
        {
          rawId: 'sequence-1',
          type: 'sequence' as const,
          name: 'pExample',
          locator: { kind: 'file' as const },
          storageType: 'file' as const,
          relativePath: 'Imports/pExample.gb',
          fileKind: 'genbank',
        },
      ],
      links: [],
      events: [],
    };

    db.transaction(() => materializeNativeWorkspaceInsideTx(db, { workspace, plan }))();
    db.transaction(() => materializeNativeWorkspaceInsideTx(db, { workspace, plan }))();
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entities').get()).toEqual({
      count: 1,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_files').get()).toEqual({
      count: 1,
    });

    expect(() =>
      db.transaction(() =>
        materializeNativeWorkspaceInsideTx(db, {
          workspace,
          plan: {
            ...plan,
            entities: [{ ...plan.entities[0], rawId: 'sequence-2' }],
          },
        })
      )()
    ).toThrow('locator belongs to another entity');
  });

  it('adds a new linked entity without rewriting an existing page', () => {
    const workspace = {
      name: 'Imported workspace',
      path: '/tmp/native-import',
      repoUuid: 'workspace-native-1',
      createdAt: 1_000,
      lastOpenedAt: 2_000,
    };
    db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, {
        workspace,
        plan: {
          schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
          entities: [
            {
              rawId: 'notebook-1',
              type: 'notebook',
              name: 'Experiment 1',
              locator: { kind: 'entity', namespace: 'page' },
              storageType: 'database',
              relativePath: 'Imports/Experiment 1',
              fileKind: 'waypoint-notebook',
              page: {
                title: 'Experiment 1',
                content: { type: 'doc', content: [] },
                createdAt: 1_200,
                updatedAt: 1_600,
              },
            },
          ],
          links: [],
          events: [],
        },
      })
    )();
    db.prepare('UPDATE pages SET content = ? WHERE id = ?').run(
      JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', text: 'User edit' }] }),
      'workspace-native-1::notebook-1'
    );

    db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, {
        workspace: { ...workspace, lastOpenedAt: 3_000 },
        plan: {
          schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
          existingEntityRawIds: ['notebook-1'],
          entities: [
            {
              rawId: 'sequence-1',
              type: 'sequence',
              name: 'Recovered sequence',
              locator: { kind: 'file' },
              storageType: 'file',
              relativePath: 'Imports/Recovered sequence.gb',
              fileKind: 'genbank',
            },
          ],
          links: [
            {
              sourceRawId: 'notebook-1',
              relation: 'references',
              targetRawId: 'sequence-1',
            },
          ],
          events: [],
        },
      })
    )();

    expect(db.prepare('SELECT content FROM pages').get()).toEqual({
      content: JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', text: 'User edit' }],
      }),
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entities').get()).toEqual({
      count: 2,
    });
    expect(db.prepare('SELECT relation FROM catalog_entity_links').get()).toEqual({
      relation: 'references',
    });
  });

  it('rejects an additive plan that claims an unknown existing identity', () => {
    const workspace = {
      name: 'Imported workspace',
      path: '/tmp/native-import',
      repoUuid: 'workspace-native-1',
      createdAt: 1_000,
      lastOpenedAt: 2_000,
    };

    expect(() =>
      db.transaction(() =>
        materializeNativeWorkspaceInsideTx(db, {
          workspace,
          plan: {
            schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
            existingEntityRawIds: ['missing-entity'],
            entities: [],
            links: [],
            events: [],
          },
        })
      )()
    ).toThrow('Existing native entity identity is not registered: missing-entity');
  });

  it('materializes native LIMS entities and links inside the same transaction', () => {
    const workspace = {
      name: 'Imported workspace',
      path: '/tmp/native-import',
      repoUuid: 'workspace-native-1',
      createdAt: 1_000,
      lastOpenedAt: 2_000,
    };
    const result = db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, {
        workspace,
        plan: {
          schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
          entities: ['a', 'b'].map((id) => ({
            rawId: `protein-${id}`,
            type: 'protein' as const,
            name: `Protein ${id.toUpperCase()}`,
            locator: { kind: 'file' as const },
            storageType: 'file' as const,
            relativePath: `Proteins/${id}.faa`,
            fileKind: 'fasta',
          })),
          links: [],
          events: [],
          limsEntities: ['a', 'b'].map((id) => ({
            entityRawId: `protein-${id}`,
            input: {
              kind: 'protein' as const,
              name: `Protein ${id.toUpperCase()}`,
              fields: {
                sequence: { mode: 'inline', aminoAcids: 'MKT', length: 3 },
              },
              registrationStatus: 'registered' as const,
              actor: 'migration',
              createdAt: 1_500,
            },
          })),
          limsLinks: [
            {
              id: 'link-protein-a-b',
              fromEntityRawId: 'protein-a',
              toEntityRawId: 'protein-b',
              type: 'associated_with',
              payload: { sourceRelation: 'interacts_with' },
            },
          ],
        },
      })
    )();

    expect(result).toMatchObject({ limsEntitiesMaterialized: 2, limsLinksMaterialized: 1 });
    expect(
      db
        .prepare(
          `SELECT id, from_entity_id, to_entity_id, type, payload
           FROM lims_link WHERE tombstone = 0`
        )
        .get()
    ).toEqual({
      id: 'workspace-native-1::link-protein-a-b',
      from_entity_id: 'workspace-native-1::protein-a',
      to_entity_id: 'workspace-native-1::protein-b',
      type: 'associated_with',
      payload: JSON.stringify({ sourceRelation: 'interacts_with' }),
    });
  });

  it('records ambiguous native relationships in the authoritative pending-reference audit', () => {
    const workspace = {
      name: 'Imported strains',
      path: '/tmp/native-pending-reference',
      repoUuid: 'workspace-native-pending-reference',
      createdAt: 1_000,
      lastOpenedAt: 2_000,
    };
    const entities = [
      { rawId: 'strain-child', name: 'Child' },
      { rawId: 'strain-parent-a', name: 'Shared parent' },
      { rawId: 'strain-parent-b', name: 'Shared parent' },
    ];
    const plan = {
      schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
      entities: entities.map((entity) => ({
        ...entity,
        type: 'sample' as const,
        locator: { kind: 'entity' as const, namespace: 'lims' },
        storageType: 'database' as const,
      })),
      links: [],
      events: [],
      limsEntities: entities.map((entity) => ({
        entityRawId: entity.rawId,
        input: {
          kind: 'strain' as const,
          name: entity.name,
          fields: { genotypeCanonical: `genotype-${entity.rawId}` },
          registrationStatus: 'registered' as const,
          actor: 'migration',
        },
      })),
      pendingReferences: [
        {
          id: 'strain-relationship-ambiguous-parent',
          sourceEntityRawId: 'strain-child',
          relationType: 'derives_from',
          targetName: 'Shared parent',
          targetKind: 'strain',
          classification: 'ambiguous' as const,
          candidateEntityRawIds: ['strain-parent-a', 'strain-parent-b'],
        },
      ],
    };

    db.transaction(() => materializeNativeWorkspaceInsideTx(db, { workspace, plan }))();
    db.transaction(() => materializeNativeWorkspaceInsideTx(db, { workspace, plan }))();

    expect(derivePendingRefsInDb(db)).toEqual([
      expect.objectContaining({
        referrerEntityId: 'workspace-native-pending-reference::strain-child',
        type: 'derives_from',
        targetKind: 'strain',
        targetName: 'Shared parent',
        status: 'ambiguous',
        candidateEntityIds: [
          'workspace-native-pending-reference::strain-parent-a',
          'workspace-native-pending-reference::strain-parent-b',
        ],
      }),
    ]);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM lims_audit WHERE event_type = 'import_batch_applied'`
        )
        .get()
    ).toEqual({ count: 1 });
  });

  it('preserves an unresolved relationship provider identity in the pending-reference audit', () => {
    const workspace = {
      name: 'Imported strains',
      path: '/tmp/native-pending-provider-identity',
      repoUuid: 'workspace-native-pending-provider-identity',
      createdAt: 1_000,
      lastOpenedAt: 2_000,
    };
    const plan = {
      schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
      entities: [
        {
          rawId: 'strain-child',
          type: 'sample' as const,
          name: 'Child',
          locator: { kind: 'entity' as const, namespace: 'lims' },
          storageType: 'database' as const,
        },
      ],
      links: [],
      events: [],
      limsEntities: [
        {
          entityRawId: 'strain-child',
          input: {
            kind: 'strain' as const,
            name: 'Child',
            fields: { genotypeCanonical: 'child' },
            registrationStatus: 'registered' as const,
            actor: 'migration',
          },
        },
      ],
      pendingReferences: [
        {
          id: 'strain-relationship-missing-parent',
          sourceEntityRawId: 'strain-child',
          relationType: 'derives_from',
          targetName: 'bfi_PARENTAA',
          targetKind: 'strain',
          targetProviderIdentity: {
            provider: 'benchling' as const,
            stableObjectId: 'bfi_PARENTAA',
            objectClass: 'registry_entity' as const,
          },
          classification: 'unresolved' as const,
        },
      ],
    };

    db.transaction(() => materializeNativeWorkspaceInsideTx(db, { workspace, plan }))();

    expect(derivePendingRefsInDb(db)).toEqual([
      expect.objectContaining({
        status: 'open',
        targetName: 'bfi_PARENTAA',
        candidateEntityIds: [],
        targetProviderIdentity: {
          provider: 'benchling',
          stableObjectId: 'bfi_PARENTAA',
          objectClass: 'registry_entity',
        },
      }),
    ]);
  });

  it('atomically commits a native strain, provider binding, LIMS row, and audit event', () => {
    const workspace = {
      name: 'Imported strains',
      path: '/tmp/native-strain-import',
      repoUuid: 'workspace-native-strain',
      createdAt: 1_000,
      lastOpenedAt: 2_000,
    };
    const plan = {
      schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
      entities: [
        {
          rawId: 'strain-aaaaaaaaaaaaaaaaaaaaaaaa',
          type: 'sample' as const,
          name: 'Imported strain',
          locator: { kind: 'entity' as const, namespace: 'lims' },
          storageType: 'database' as const,
          sourceIdentities: [
            {
              provider: 'benchling' as const,
              stableObjectId: 'bfi_STRAINAA',
              objectClass: 'registry_entity' as const,
              bindingKind: 'observed' as const,
            },
          ],
        },
      ],
      links: [],
      events: [
        {
          id: 'import-strain-a',
          entityRawId: 'strain-aaaaaaaaaaaaaaaaaaaaaaaa',
          eventType: 'imported',
          createdAt: 1_500,
        },
      ],
      limsEntities: [
        {
          entityRawId: 'strain-aaaaaaaaaaaaaaaaaaaaaaaa',
          input: {
            kind: 'strain' as const,
            name: 'Imported strain',
            fields: {
              sourceMetadata: {
                schemaVersion: 1,
                origin: {
                  type: 'connector',
                  connectorType: 'benchling',
                  sourceId: 'bfi_STRAINAA',
                },
                values: { Tag: ['first', 'second'] },
                entries: [
                  { label: 'Tag', value: 'first', position: 0 },
                  { label: 'Tag', value: 'second', position: 1 },
                ],
              },
            },
            registrationStatus: 'registered' as const,
            actor: 'migration',
            createdAt: 1_500,
          },
        },
      ],
    };

    expect(() =>
      db.transaction(() =>
        materializeNativeWorkspaceInsideTx(db, {
          workspace,
          plan: {
            ...plan,
            limsEntities: [
              {
                ...plan.limsEntities[0],
                input: { ...plan.limsEntities[0].input, failAfterEntityInsert: true },
              },
            ],
          },
        })
      )()
    ).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entities').get()).toEqual({
      count: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_provider_bindings').get()).toEqual({
      count: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM lims_entity').get()).toEqual({ count: 0 });

    db.transaction(() => materializeNativeWorkspaceInsideTx(db, { workspace, plan }))();
    expect(
      db
        .prepare(
          `SELECT provider, stable_object_id AS stableObjectId,
                  object_class AS objectClass, entity_id AS entityId
             FROM catalog_provider_bindings`
        )
        .get()
    ).toEqual({
      provider: 'benchling',
      stableObjectId: 'bfi_STRAINAA',
      objectClass: 'registry_entity',
      entityId: 'workspace-native-strain::strain-aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const lims = db
      .prepare('SELECT registration_status AS status, fields FROM lims_entity')
      .get() as { status: string; fields: string };
    expect(lims.status).toBe('unresolved');
    expect(JSON.parse(lims.fields)).toMatchObject({
      sourceMetadata: {
        entries: [
          { label: 'Tag', value: 'first', position: 0 },
          { label: 'Tag', value: 'second', position: 1 },
        ],
      },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_events').get()).toEqual({
      count: 1,
    });
  });

  it('completes one unresolved DNA identity in place without duplicating its binding or LIMS row', () => {
    const workspace = {
      name: 'Imported DNA',
      path: '/tmp/native-needs-sequence',
      repoUuid: 'workspace-native-needs-sequence',
      createdAt: 1_000,
      lastOpenedAt: 2_000,
    };
    const rawId = 'sequence-provider-identity';
    const sourceIdentity = {
      provider: 'benchling' as const,
      stableObjectId: 'seq_NEEDSSEQ',
      objectClass: 'sequence' as const,
      bindingKind: 'observed' as const,
    };
    db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, {
        workspace,
        plan: {
          schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
          entities: [
            {
              rawId,
              type: 'sequence',
              name: 'Imported DNA',
              locator: { kind: 'entity', namespace: 'lims' },
              storageType: 'database',
              relativePath: 'Imports/Imported DNA/.forge/benchling-native-record.json',
              fileKind: 'benchling-native-record-evidence',
              sourceIdentities: [sourceIdentity],
            },
          ],
          links: [],
          events: [],
          limsEntities: [
            {
              entityRawId: rawId,
              input: {
                kind: 'dna_sequence',
                name: 'Imported DNA',
                fields: { sequence: { mode: 'unresolved' } },
                registrationStatus: 'unresolved',
                actor: 'migration',
              },
            },
          ],
        },
      })
    )();

    const normalizedSequenceHash = `sha256:${'a'.repeat(64)}`;
    const result = db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, {
        workspace,
        plan: {
          schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
          needsSequenceCompletionRawIds: [rawId],
          entities: [
            {
              rawId,
              type: 'sequence',
              name: 'Incoming name must not replace a user rename',
              locator: { kind: 'file' },
              storageType: 'file',
              relativePath: 'Imports/Imported DNA/Imported DNA.gb',
              fileKind: 'genbank',
              contentHash: `sha256:${'b'.repeat(64)}`,
              sourceIdentities: [sourceIdentity],
            },
          ],
          links: [],
          events: [],
          limsEntities: [
            {
              entityRawId: rawId,
              input: {
                kind: 'dna_sequence',
                name: 'Incoming name must not replace a user rename',
                fields: {
                  sequence: {
                    mode: 'file',
                    relPath: resolve(workspace.path, 'Imports/Imported DNA/Imported DNA.gb'),
                    topology: 'linear',
                    length: 4,
                    contentHash: `sha256:${'b'.repeat(64)}`,
                    fileContentHash: `sha256:${'b'.repeat(64)}`,
                    normalizedSequenceHash,
                    sourceFormat: 'genbank',
                  },
                },
                registrationStatus: 'registered',
                actor: 'migration',
              },
            },
          ],
        },
      })
    )();

    expect(result.needsSequenceCompletionsAdopted).toEqual([rawId]);
    expect(result.entityIdsByRawId[rawId]).toBe(
      'workspace-native-needs-sequence::sequence-provider-identity'
    );
    expect(
      db
        .prepare(
          `SELECT name, locator, storage_type AS storageType
           FROM catalog_entities WHERE id = ?`
        )
        .get(result.entityIdsByRawId[rawId])
    ).toEqual({
      name: 'Imported DNA',
      locator: `file://${resolve(workspace.path, 'Imports/Imported DNA/Imported DNA.gb')}`,
      storageType: 'file',
    });
    const lims = db
      .prepare('SELECT registration_status AS status, fields FROM lims_entity WHERE id = ?')
      .get(result.entityIdsByRawId[rawId]) as { status: string; fields: string };
    expect(lims.status).toBe('registered');
    expect(JSON.parse(lims.fields).sequence).toMatchObject({
      mode: 'file',
      normalizedSequenceHash,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM lims_entity').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_provider_bindings').get()).toEqual({
      count: 1,
    });
  });

  it('treats equal user bases as corroboration and throws a typed conflict for different bases', () => {
    const workspace = {
      name: 'Imported DNA',
      path: '/tmp/native-user-sequence',
      repoUuid: 'workspace-native-user-sequence',
      createdAt: 1_000,
      lastOpenedAt: 2_000,
    };
    const rawId = 'sequence-provider-identity';
    const entityId = `${workspace.repoUuid}::${rawId}`;
    const initialPlan = {
      schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
      entities: [
        {
          rawId,
          type: 'sequence' as const,
          name: 'Imported DNA',
          locator: { kind: 'entity' as const, namespace: 'lims' },
          storageType: 'database' as const,
          relativePath: 'Imports/Imported DNA/.forge/benchling-native-record.json',
          fileKind: 'benchling-native-record-evidence',
        },
      ],
      links: [],
      events: [],
      limsEntities: [
        {
          entityRawId: rawId,
          input: {
            kind: 'dna_sequence' as const,
            name: 'Imported DNA',
            fields: { sequence: { mode: 'unresolved' as const } },
            registrationStatus: 'unresolved' as const,
            actor: 'migration',
          },
        },
      ],
    };
    db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, { workspace, plan: initialPlan })
    )();
    db.prepare(
      `UPDATE lims_entity
       SET fields = ?, registration_status = 'registered'
       WHERE id = ?`
    ).run(
      JSON.stringify({
        sequence: { mode: 'inline', bases: 'ATGC', topology: 'linear', length: 4 },
      }),
      entityId
    );

    const completionPlan = {
      schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
      needsSequenceCompletionRawIds: [rawId],
      entities: [
        {
          rawId,
          type: 'sequence' as const,
          name: 'Imported DNA',
          locator: { kind: 'file' as const },
          storageType: 'file' as const,
          relativePath: 'Imports/Imported DNA/Imported DNA.gb',
          fileKind: 'genbank',
        },
      ],
      links: [],
      events: [],
      limsEntities: [
        {
          entityRawId: rawId,
          input: {
            kind: 'dna_sequence' as const,
            name: 'Imported DNA',
            fields: {
              sequence: {
                mode: 'file' as const,
                relPath: resolve(workspace.path, 'Imports/Imported DNA/Imported DNA.gb'),
                topology: 'linear' as const,
                length: 4,
                contentHash: `sha256:${'b'.repeat(64)}`,
                fileContentHash: `sha256:${'b'.repeat(64)}`,
                normalizedSequenceHash: `sha256:${createHash('sha256').update('ATGC').digest('hex')}`,
                sourceFormat: 'genbank',
              },
            },
            registrationStatus: 'registered' as const,
            actor: 'migration',
          },
        },
      ],
    };

    const corroborated = db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, { workspace, plan: completionPlan })
    )();
    expect(corroborated.needsSequenceCompletionsCorroborated).toEqual([rawId]);
    expect(db.prepare('SELECT locator FROM catalog_entities WHERE id = ?').get(entityId)).toEqual({
      locator: `file://${resolve(workspace.path, 'Imports/Imported DNA/Imported DNA.gb')}`,
    });
    const corroboratedLims = db
      .prepare('SELECT fields FROM lims_entity WHERE id = ?')
      .get(entityId) as { fields: string };
    expect(JSON.parse(corroboratedLims.fields).sequence).toMatchObject({
      mode: 'file',
      normalizedSequenceHash: `sha256:${createHash('sha256').update('ATGC').digest('hex')}`,
    });

    db.prepare('UPDATE lims_entity SET fields = ? WHERE id = ?').run(
      JSON.stringify({
        sequence: { mode: 'inline', bases: 'TTTT', topology: 'linear', length: 4 },
      }),
      entityId
    );
    expect(() =>
      db.transaction(() =>
        materializeNativeWorkspaceInsideTx(db, { workspace, plan: completionPlan })
      )()
    ).toThrow(NativeSequenceSourceVersionConflictError);
  });
});
