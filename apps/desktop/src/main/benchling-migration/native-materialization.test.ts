import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  MigrationRun,
  ProjectionReceipt,
  RelationshipResolution,
  SourceObject,
} from '../../shared/benchling-migration';
import type { CollectionProjection } from './collection-projection';
import { buildNativeMigrationMaterializationPlan } from './native-materialization';
import { nativeWorkspaceManifestFromPlan } from '../native-workspace-manifest';
import { sourceObjectMaterializationView } from './source-object-materialization-view';
import { readLocalRegistryTableRows } from './registry-table-input';
import { inspectNativeExportArchive } from './native-export-archive';
import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import { buildProjectionPlan, projectionDestinationVariant } from './projection';
import { projectionReceiptForPlan } from './projection-writer';
import { extractOligoClassificationEvidence } from './oligo-classification-evidence';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { materializeNativeWorkspaceInsideTx } from '../native-workspace-materializer';
import { buildDestinationInventory } from './destination-inventory';
import {
  parseNativeWorkspaceManifest,
  serializeNativeWorkspaceManifest,
} from '../../shared/native-workspace-manifest';

describe('native Benchling migration materialization', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('materializes normalized registry ZIP rows with typed fields, pinned schemas and scoped relationships', async () => {
    const fixture = buildSyntheticNativeExportZip([
      {
        path: 'records.schema.json',
        bytes: JSON.stringify({
          schema: 'benchling.registry-schema.v1',
          sourceSchemaId: 'reagent-schema',
          sourceRevisionId: 'revision-1',
          name: 'reagent',
          displayName: 'Reagent',
          recordPaths: ['records.csv'],
          fields: [
            {
              sourceFieldId: 'amount-field',
              definition: { key: 'amount', label: 'Amount', type: 'number', required: true },
            },
            {
              sourceFieldId: 'verified-field',
              definition: { key: 'verified', label: 'Verified', type: 'boolean' },
            },
            {
              sourceFieldId: 'parent-field',
              definition: {
                key: 'parent',
                label: 'Parent',
                type: 'record_relationship',
                required: true,
              },
            },
          ],
        }),
      },
      {
        path: 'records.csv',
        bytes:
          'id,name,registryid,amount,verified,parent\nbfi_RECORD01,Reagent A,REAGENT-42,0,false,bfi_RECORD02\nbfi_RECORD02,Reagent B,REAGENT-43,12.5,true,\n',
      },
    ]);
    const archive = await inspectNativeExportArchive({
      kind: 'bytes',
      logicalFilename: 'normalized-registry.zip',
      bytes: fixture.bytes,
      expectedSha256: fixture.sha256,
      expectedSizeBytes: fixture.sizeBytes,
    });
    const sourceObjects = (await readLocalRegistryTableRows(archive)).map(
      (row) => row.sourceObject
    );
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-native-registry-'));
    roots.push(workspacePath);
    const run: MigrationRun = {
      ...migrationRun(workspacePath),
      externalZipSource: {
        schema: 'dnaforge.benchling.external-zip-source.v1',
        sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
        originalPath: '/fixtures/normalized-registry.zip',
        displayName: 'normalized-registry.zip',
        zipSha256: `sha256:${fixture.sha256.replace(/^sha256:/u, '')}`,
        sizeBytes: fixture.sizeBytes,
        selectedAt: '2026-08-30T12:00:00.000Z',
      },
    };
    const receipts = sourceObjects.map((source): ProjectionReceipt => {
      const variant = projectionDestinationVariant(source);
      expect(variant).toEqual({
        kind: 'catalog-record',
        catalogType: 'record',
        presentationKind: 'record',
      });
      const destination = {
        kind: 'catalog-record',
        catalogType: 'record',
        presentationKind: 'record',
        parentRelativePath: '',
        displayName: source.name,
      } as const;
      const projection = buildProjectionPlan(source, {
        runId: run.id,
        capturedAt: run.createdAt,
        converterVersion: 'test',
        destination,
      });
      expect(projection.projection, projection.exception ?? '').toBe('native');
      expect(projection.files).toEqual([]);
      return projectionReceiptForPlan({
        sourceObjectId: source.id,
        plan: projection,
        runId: run.id,
        createdAt: run.createdAt,
      });
    });
    const plan = await buildNativeMigrationMaterializationPlan({
      run,
      sourceObjects,
      receipts,
      folderProjection: null,
      resolutions: [
        {
          ...resolution('bfi_RECORD01', 'bfi_RECORD02'),
          relationshipId: 'registry:bfi_RECORD01:parent-field',
          relationType: 'parent',
        },
      ],
    });
    expect(plan.limsEntities?.map((entity) => entity.input.registrationStatus)).toEqual([
      'registered',
      'unresolved',
    ]);
    const manifest = parseNativeWorkspaceManifest(
      serializeNativeWorkspaceManifest(
        nativeWorkspaceManifestFromPlan({ workspacePath, plan, manifestVersion: 2 })
      )
    );
    expect(manifest.entities.map((entity) => entity.type)).toEqual(['record', 'record']);
    expect(manifest.entities[0]?.metadata).toMatchObject({
      sourceRegistryId: 'REAGENT-42',
    });
    expect(manifest.entities[0]?.lims?.schemaSnapshot).toMatchObject({
      displayName: 'Reagent',
      baseKind: 'record',
      fields: [
        { key: 'amount', type: 'number', required: true },
        { key: 'verified', type: 'boolean' },
        { key: 'parent', type: 'record_relationship', required: true },
      ],
    });
    const db = createTestDb();
    try {
      ensureSchema(db, ':memory:');
      const materialized = db.transaction(() =>
        materializeNativeWorkspaceInsideTx(db, {
          workspace: {
            name: 'Registry fidelity',
            path: workspacePath,
            repoUuid: run.workspaceId,
            createdAt: 1,
            lastOpenedAt: 1,
          },
          plan,
        })
      )();
      const firstRawId = receipts[0]?.destinationObjectId;
      const secondRawId = receipts[1]?.destinationObjectId;
      if (!firstRawId || !secondRawId) throw new Error('Fixture lost a record.');
      const firstId = materialized.entityIdsByRawId[firstRawId];
      const row = db
        .prepare('SELECT fields, schema_revision_id FROM lims_entity WHERE id = ?')
        .get(firstId) as { fields: string; schema_revision_id: string };
      expect(JSON.parse(row.fields)).toMatchObject({
        amount: 0,
        verified: false,
        parent: {
          destinationEntityId: materialized.entityIdsByRawId[secondRawId],
          resolution: 'exact',
        },
      });
      expect(row.schema_revision_id).toBe(manifest.entities[0]?.lims?.schemaRevisionId);
      expect(
        db
          .prepare('SELECT presentation_kind FROM catalog_workspace_placements ORDER BY entity_id')
          .all()
      ).toEqual([{ presentation_kind: 'record' }, { presentation_kind: 'record' }]);
      expect(db.prepare('SELECT * FROM catalog_entity_files').all()).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM lims_link').get()).toEqual({ count: 1 });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      const inventory = await buildDestinationInventory({
        db,
        workspaceDbId: materialized.workspaceId,
        workspacePath,
        sourceObjects,
        assertMutationLeaseHeld: () => undefined,
      });
      expect(inventory.providerMatches).toHaveLength(2);
      expect(inventory.providerMatches).toEqual(
        expect.arrayContaining(
          sourceObjects.map((source) =>
            expect.objectContaining({
              sourceObjectId: source.id,
              state: 'matched',
              scientificComparison: 'equal',
              destination: expect.objectContaining({
                kind: 'catalog-record',
                catalogType: 'record',
              }),
            })
          )
        )
      );
      const changedRevision = structuredClone(sourceObjects);
      for (const source of changedRevision) {
        const registry = source.metadata.benchlingRegistry;
        if (
          !registry ||
          typeof registry !== 'object' ||
          !('schemaRevision' in registry) ||
          !registry.schemaRevision ||
          typeof registry.schemaRevision !== 'object'
        )
          throw new Error('Fixture schema missing.');
        Object.assign(registry.schemaRevision, { sourceRevisionId: 'new-revision-same-fields' });
      }
      const revisedInventory = await buildDestinationInventory({
        db,
        workspaceDbId: materialized.workspaceId,
        workspacePath,
        sourceObjects: changedRevision,
        assertMutationLeaseHeld: () => undefined,
      });
      expect(revisedInventory.providerMatches).toEqual(
        expect.arrayContaining(
          changedRevision.map((source) =>
            expect.objectContaining({ sourceObjectId: source.id, scientificComparison: 'changed' })
          )
        )
      );
    } finally {
      db.close();
    }
  });

  it('records honest LIMS applicability without inferring unsupported biological kinds', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-native-materialization-'));
    roots.push(workspacePath);

    const sources = [
      source('dna-1', 'dna_sequence', 'Unclassified DNA', { bases: 'ATGC' }),
      source('rna-1', 'rna_sequence', 'Unclassified RNA', { bases: 'AUGC' }),
      source('protein-1', 'protein', 'Green protein', { aminoAcids: 'MKT' }),
      source('dna-empty', 'dna_sequence', 'Empty DNA', { bases: '' }),
      source('rna-empty', 'rna_sequence', 'Empty RNA', {}),
      source('protocol-1', 'protocol', 'PCR protocol', { overview: 'Amplify DNA' }),
    ];
    const receipts = sources.map((entry) =>
      receipt(entry.id, `${entry.id}.native`, `native-${entry.id}`)
    );
    await mkdir(join(workspacePath, 'Benchling Imports'), { recursive: true });
    await Promise.all(
      receipts.map((entry) =>
        writeFile(join(workspacePath, entry.destinationPath), `native:${entry.sourceObjectId}`)
      )
    );

    const plan = await buildNativeMigrationMaterializationPlan({
      run: migrationRun(workspacePath),
      sourceObjects: sources,
      receipts,
      resolutions: [],
      folderProjection: null,
    });

    expect(metadataFor(plan.entities, 'native-dna-1').limsProjection).toEqual({
      status: 'materialized',
      kind: 'dna_sequence',
      reason: 'Registered as a generic molecule without inferring a specialized biological role.',
    });
    expect(metadataFor(plan.entities, 'native-rna-1').limsProjection).toEqual({
      status: 'materialized',
      kind: 'rna_sequence',
      reason: 'Registered as a generic molecule without inferring a specialized biological role.',
    });
    expect(metadataFor(plan.entities, 'native-protein-1').limsProjection).toEqual({
      status: 'materialized',
      kind: 'protein',
    });
    expect(metadataFor(plan.entities, 'native-dna-empty').limsProjection).toEqual({
      status: 'not_inferred',
      reason: 'The source DNA molecule has no usable nucleotide sequence.',
    });
    expect(metadataFor(plan.entities, 'native-rna-empty').limsProjection).toEqual({
      status: 'not_inferred',
      reason: 'The source RNA molecule has no usable nucleotide sequence.',
    });
    expect(metadataFor(plan.entities, 'native-protocol-1').limsProjection).toEqual({
      status: 'not_applicable',
      reason: 'This native object type has no LIMS record lifecycle.',
    });
    expect(plan.limsEntities).toHaveLength(3);
    expect(plan.limsEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityRawId: 'native-dna-1',
          input: expect.objectContaining({ kind: 'dna_sequence', name: 'Unclassified DNA' }),
        }),
        expect.objectContaining({
          entityRawId: 'native-rna-1',
          input: expect.objectContaining({ kind: 'rna_sequence', name: 'Unclassified RNA' }),
        }),
        expect.objectContaining({
          entityRawId: 'native-protein-1',
          input: expect.objectContaining({ kind: 'protein', name: 'Green protein' }),
        }),
      ])
    );
  });

  it('keeps bounded classification evidence portable on its source notebook without classifying the notebook', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'classification-portable-'));
    roots.push(workspacePath);
    const html = `<p>Forward primer: <span class="internalLink" data-internal-link='{"id":"seq_OLIGO001","iconId":"oligo"}'><a href="https://benchling.com/fixture/seq_OLIGO001-candidate/edit">Candidate</a></span></p>`;
    const notebook = source('etr_NOTEBOOK01', 'notebook_entry', 'Experiment', {
      html,
      attachments: [],
    });
    notebook.metadata.classificationEvidence = extractOligoClassificationEvidence({
      html,
      sourceObjectId: notebook.id,
      sourceEntryPath: 'Experiment.html',
      sourceEntrySha256: `sha256:${'a'.repeat(64)}`,
    });
    const projection = buildProjectionPlan(notebook, {
      runId: 'run-native-materialization',
      capturedAt: '2026-08-30T12:00:00.000Z',
      converterVersion: 'test',
      destination: {
        kind: 'package',
        rootRelativePath: 'Experiment',
        primaryRelativePath: 'Experiment/.forge/notebook.json',
      },
    });
    expect(projection.projection).toBe('native');
    for (const file of projection.files) {
      const path = join(workspacePath, file.relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.text ?? file.bytes);
    }
    const notebookReceipt = projectionReceiptForPlan({
      sourceObjectId: notebook.id,
      plan: projection,
      runId: 'run-native-materialization',
      createdAt: '2026-08-30T12:00:00.000Z',
    });
    const run: MigrationRun = {
      ...migrationRun(workspacePath),
      externalZipSource: {
        schema: 'dnaforge.benchling.external-zip-source.v1',
        sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
        originalPath: '/fixtures/notebook.zip',
        displayName: 'notebook.zip',
        zipSha256: `sha256:${'a'.repeat(64)}`,
        sizeBytes: 1,
        selectedAt: '2026-08-30T12:00:00.000Z',
      },
    };
    const plan = await buildNativeMigrationMaterializationPlan({
      run,
      sourceObjects: [sourceObjectMaterializationView(notebook)],
      receipts: [notebookReceipt],
      resolutions: [],
      folderProjection: null,
    });
    expect(plan.limsEntities).toEqual([]);
    const manifest = parseNativeWorkspaceManifest(
      serializeNativeWorkspaceManifest(
        nativeWorkspaceManifestFromPlan({ workspacePath, plan, manifestVersion: 2 })
      )
    );
    expect(manifest.entities[0]?.type).toBe('notebook');
    expect(manifest.entities[0]?.metadata?.classificationEvidence).toEqual(
      notebook.metadata.classificationEvidence
    );
  });

  it('builds a v2 catalog record without reading a synthetic evidence file', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-native-v2-record-'));
    roots.push(workspacePath);
    const strain = source('bfi_STRAINAA', 'strain', 'Strain A', {
      kind: 'benchling_strain',
      displayName: 'Strain A',
      fields: [{ label: 'Genotype', value: 'deltaX', position: 0 }],
    });
    const strainReceipt: ProjectionReceipt = {
      ...receipt(strain.id, 'unused.native', 'native-strain-a'),
      destinationPath: 'Strains/Strain A',
      destination: {
        kind: 'catalog-record',
        parentRelativePath: 'Strains',
        displayName: 'Strain A',
        catalogType: 'sample',
        presentationKind: 'strain',
      },
      nativeRepresentation: 'strain',
    };
    const run: MigrationRun = {
      ...migrationRun(workspacePath),
      externalZipSource: {
        schema: 'dnaforge.benchling.external-zip-source.v1',
        sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
        originalPath: '/Users/scientist/Benchling export.zip',
        displayName: 'Benchling export.zip',
        zipSha256: `sha256:${'a'.repeat(64)}`,
        sizeBytes: 123,
        selectedAt: '2026-08-29T12:00:00.000Z',
      },
    };

    const plan = await buildNativeMigrationMaterializationPlan({
      run,
      sourceObjects: [strain],
      receipts: [strainReceipt],
      resolutions: [],
      folderProjection: null,
    });

    expect(plan.entities).toEqual([
      expect.objectContaining({
        rawId: 'native-strain-a',
        placement: strainReceipt.destination,
        migrationSource: {
          historyRunId: run.id,
          sourceId: run.externalZipSource?.sourceId,
          sourceObjectId: strain.stableId,
        },
      }),
    ]);
    expect(plan.entities[0]).not.toHaveProperty('relativePath');
    expect(plan.entities[0]).not.toHaveProperty('fileKind');
    expect(plan.limsEntities).toEqual([
      expect.objectContaining({ entityRawId: 'native-strain-a' }),
    ]);
  });

  it('materializes sequence LIMS rows from bounded sequence facts', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-native-bounded-facts-'));
    roots.push(workspacePath);
    const dna = source('dna-bounded', 'dna_sequence', 'Bounded DNA', {
      bases: 'acgtacgt',
      topology: 'circular',
      annotations: [{ label: 'discarded before materialization' }],
    });
    const protein = source('protein-bounded', 'protein', 'Bounded protein', {
      aminoAcids: 'mkt',
    });
    const sources = [dna, protein].map(sourceObjectMaterializationView);
    const receipts = sources.map((entry) =>
      receipt(entry.id, `${entry.id}.native`, `native-${entry.id}`)
    );
    await mkdir(join(workspacePath, 'Benchling Imports'), { recursive: true });
    await Promise.all(
      receipts.map((entry) =>
        writeFile(join(workspacePath, entry.destinationPath), `native:${entry.sourceObjectId}`)
      )
    );

    const plan = await buildNativeMigrationMaterializationPlan({
      run: migrationRun(workspacePath),
      sourceObjects: sources,
      receipts,
      resolutions: [],
      folderProjection: null,
    });

    expect(plan.limsEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityRawId: 'native-dna-bounded',
          input: expect.objectContaining({
            kind: 'dna_sequence',
            fields: expect.objectContaining({
              sequence: expect.objectContaining({
                length: 8,
                topology: 'circular',
                normalizedSequenceHash:
                  'sha256:b28b7e7e6b70661dfee15d5290c4bca097ca145f721c4fbc4de73ad1d1660b8b',
              }),
            }),
          }),
        }),
        expect.objectContaining({
          entityRawId: 'native-protein-bounded',
          input: expect.objectContaining({
            kind: 'protein',
            fields: expect.objectContaining({
              sequence: expect.objectContaining({
                length: 3,
                normalizedSequenceHash:
                  'sha256:366893d2245f5f241af2eeba0a8c19ef3bf362141a7c8504d7479ce7e7f2fb66',
              }),
            }),
          }),
        }),
      ])
    );
  });

  it('materializes one native object with links from every folder membership', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-native-membership-'));
    roots.push(workspacePath);
    const dna = source('dna-1', 'dna_sequence', 'Shared DNA', { bases: 'ATGC' });
    const dnaReceipt = receipt(dna.id, 'shared.gb', 'native-dna-1');
    await mkdir(join(workspacePath, 'Benchling Imports'), { recursive: true });
    await writeFile(join(workspacePath, dnaReceipt.destinationPath), 'LOCUS shared 4 bp DNA');

    const plan = await buildNativeMigrationMaterializationPlan({
      run: migrationRun(workspacePath),
      sourceObjects: [dna],
      receipts: [dnaReceipt],
      resolutions: [],
      folderProjection: twoFolderProjection('native-dna-1'),
    });

    expect(plan.entities.filter((entity) => entity.rawId === 'native-dna-1')).toHaveLength(1);
    expect(plan.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRawId: 'folder-aaaaaaaaaaaaaaaaaaaaaaaa',
          relation: 'contains',
          targetRawId: 'native-dna-1',
        }),
        expect.objectContaining({
          sourceRawId: 'folder-bbbbbbbbbbbbbbbbbbbbbbbb',
          relation: 'contains',
          targetRawId: 'native-dna-1',
        }),
      ])
    );
  });

  it('carries the exact provider relationship identity into the portable link evidence', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-native-link-evidence-'));
    roots.push(workspacePath);
    const child = source('seq_CHILD', 'dna_sequence', 'Child DNA', { bases: 'ATGC' });
    const parent = source('seq_PARENT', 'dna_sequence', 'Parent DNA', { bases: 'ATGC' });
    const childReceipt = receipt(child.id, 'child.gb', 'native-child');
    const parentReceipt = receipt(parent.id, 'parent.gb', 'native-parent');
    await mkdir(join(workspacePath, 'Benchling Imports'), { recursive: true });
    await writeFile(join(workspacePath, childReceipt.destinationPath), 'LOCUS child 4 bp DNA');
    await writeFile(join(workspacePath, parentReceipt.destinationPath), 'LOCUS parent 4 bp DNA');

    const exact = resolution(child.id, parent.id);
    const plan = await buildNativeMigrationMaterializationPlan({
      run: migrationRun(workspacePath),
      sourceObjects: [child, parent],
      receipts: [childReceipt, parentReceipt],
      resolutions: [exact],
      folderProjection: null,
    });

    expect(plan.links).toContainEqual({
      sourceRawId: childReceipt.destinationObjectId,
      relation: exact.relationType,
      targetRawId: parentReceipt.destinationObjectId,
      evidence: {
        kind: 'migration_relationship',
        relationshipId: exact.relationshipId,
        classification: 'exact',
        targetProviderStableId: parent.stableId,
      },
    });
  });

  it('carries ambiguous strain relationships into the LIMS pending-reference plan', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-native-pending-plan-'));
    roots.push(workspacePath);
    const strainContent = (displayName: string) => ({
      kind: 'benchling_strain',
      displayName,
      fields: [{ label: 'Genotype', value: 'synthetic', position: 0 }],
    });
    const child = source('bfi_CHILDAAA', 'strain', 'Child', strainContent('Child'));
    const parentA = source(
      'bfi_PARENTAA',
      'strain',
      'Shared parent',
      strainContent('Shared parent')
    );
    const parentB = source(
      'bfi_PARENTBB',
      'strain',
      'Shared parent',
      strainContent('Shared parent')
    );
    const sources = [child, parentA, parentB];
    const receipts = sources.map((entry) =>
      receipt(entry.id, `${entry.id}.native`, `native-${entry.id}`)
    );
    await mkdir(join(workspacePath, 'Benchling Imports'), { recursive: true });
    await Promise.all(
      receipts.map((entry) =>
        writeFile(join(workspacePath, entry.destinationPath), `native:${entry.sourceObjectId}`)
      )
    );
    const ambiguous: RelationshipResolution = {
      relationshipId: 'strain-relationship-ambiguous-parent',
      sourceObjectId: child.id,
      targetSourceId: null,
      relationType: 'derives_from',
      classification: 'ambiguous',
      evidence: [
        { kind: 'name', value: 'Shared parent' },
        { kind: 'source_type', value: 'registry_entity' },
      ],
      candidateSourceIds: [parentA.id, parentB.id],
      requiresTargetedRead: false,
      reason: 'Two exact names matched.',
    };

    const plan = await buildNativeMigrationMaterializationPlan({
      run: migrationRun(workspacePath),
      sourceObjects: sources,
      receipts,
      resolutions: [ambiguous],
      folderProjection: null,
    });

    expect(plan.pendingReferences).toEqual([
      {
        id: ambiguous.relationshipId,
        sourceEntityRawId: 'native-bfi_CHILDAAA',
        relationType: 'derives_from',
        targetName: 'Shared parent',
        targetKind: 'strain',
        classification: 'ambiguous',
        candidateEntityRawIds: ['native-bfi_PARENTAA', 'native-bfi_PARENTBB'],
      },
    ]);
  });

  it('keeps an unresolved relationship exact provider identity in the pending plan', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-native-pending-identity-'));
    roots.push(workspacePath);
    const child = source('bfi_CHILDAAA', 'strain', 'Child', {
      kind: 'benchling_strain',
      displayName: 'Child',
      fields: [{ label: 'Genotype', value: 'synthetic', position: 0 }],
    });
    const childReceipt = receipt(child.id, `${child.id}.native`, `native-${child.id}`);
    await mkdir(join(workspacePath, 'Benchling Imports'), { recursive: true });
    await writeFile(
      join(workspacePath, childReceipt.destinationPath),
      `native:${childReceipt.sourceObjectId}`
    );
    const unresolved: RelationshipResolution = {
      relationshipId: 'strain-relationship-missing-parent',
      sourceObjectId: child.id,
      targetSourceId: null,
      relationType: 'derives_from',
      classification: 'unresolved',
      evidence: [
        { kind: 'stable_id', value: 'bfi_PARENTAA' },
        { kind: 'source_type', value: 'registry_entity' },
      ],
      candidateSourceIds: [],
      requiresTargetedRead: false,
      reason: 'The exact provider object is not in this export.',
    };

    const plan = await buildNativeMigrationMaterializationPlan({
      run: migrationRun(workspacePath),
      sourceObjects: [child],
      receipts: [childReceipt],
      resolutions: [unresolved],
      folderProjection: null,
    });

    expect(plan.pendingReferences).toEqual([
      expect.objectContaining({
        id: unresolved.relationshipId,
        sourceEntityRawId: childReceipt.destinationObjectId,
        targetName: 'bfi_PARENTAA',
        targetProviderIdentity: {
          provider: 'benchling',
          stableObjectId: 'bfi_PARENTAA',
          objectClass: 'registry_entity',
        },
      }),
    ]);
  });

  it('materializes strains and zero-base DNA as built-in database-backed LIMS entities', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-native-records-'));
    roots.push(workspacePath);
    const strain = source('bfi_STRAINAA', 'strain', 'Shared synthetic strain', {
      kind: 'benchling_strain',
      displayName: 'Shared synthetic strain',
      fields: [
        { label: 'Genotype', value: 'deltaX', position: 0 },
        { label: 'Resistance marker', value: 'marker one', position: 1 },
        { label: 'Resistance marker', value: 'marker two', position: 2 },
        { label: 'Blank', value: '', position: 3 },
      ],
    });
    const zeroBase = source('seq_EMPTYDNA', 'dna_sequence', 'Empty DNA', {
      kind: 'dna_sequence_needs_sequence',
      moleculeType: 'DNA',
      bases: '',
      topology: 'linear',
      annotations: [],
      genbankMetadata: {
        locus: {
          raw: 'EMPTYDNA 0 bp DNA linear 26-AUG-2026',
          name: 'EMPTYDNA',
          declaredLength: 0,
          moleculeType: 'DNA',
          topology: 'linear',
          date: '26-AUG-2026',
        },
        definition: 'Synthetic unresolved DNA.',
        keywords: [],
        comments: ['Synthetic comment only.'],
        sourceFields: [
          { label: 'LOCUS', value: 'EMPTYDNA 0 bp DNA', position: 0, lines: [] },
          {
            label: 'COMMENT',
            value: 'Synthetic comment only.',
            position: 1,
            lines: [],
          },
        ],
      },
    });
    const strainReceipt = {
      ...receipt(strain.id, 'strain/.forge/benchling-native-record.json', 'strain-native'),
      nativeRepresentation: 'strain' as const,
    };
    const zeroReceipt = {
      ...receipt(zeroBase.id, 'zero-base/.forge/benchling-native-record.json', 'sequence-native'),
      nativeRepresentation: 'dna_sequence_needs_sequence' as const,
    };
    await mkdir(join(workspacePath, 'Benchling Imports/strain/.forge'), { recursive: true });
    await mkdir(join(workspacePath, 'Benchling Imports/zero-base/.forge'), { recursive: true });
    await writeFile(join(workspacePath, strainReceipt.destinationPath), '{"kind":"strain"}');
    await writeFile(
      join(workspacePath, zeroReceipt.destinationPath),
      '{"kind":"dna_sequence_needs_sequence"}'
    );

    const plan = await buildNativeMigrationMaterializationPlan({
      run: migrationRun(workspacePath),
      sourceObjects: [strain, zeroBase],
      receipts: [strainReceipt, zeroReceipt],
      resolutions: [],
      folderProjection: null,
    });

    expect(plan.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rawId: 'strain-native',
          type: 'sample',
          locator: { kind: 'entity', namespace: 'lims' },
          storageType: 'database',
        }),
        expect.objectContaining({
          rawId: 'sequence-native',
          type: 'sequence',
          locator: { kind: 'entity', namespace: 'lims' },
          storageType: 'database',
        }),
      ])
    );
    expect(plan.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rawId: 'strain-native',
          relativePath: strainReceipt.destinationPath,
          fileKind: 'benchling-native-record-evidence',
        }),
        expect.objectContaining({
          rawId: 'sequence-native',
          relativePath: zeroReceipt.destinationPath,
          fileKind: 'benchling-native-record-evidence',
        }),
      ])
    );
    expect(plan.limsEntities).toEqual([
      expect.objectContaining({
        entityRawId: 'strain-native',
        input: expect.objectContaining({
          kind: 'strain',
          registrationStatus: 'registered',
          fields: expect.objectContaining({
            genotypeCanonical: 'deltaX',
            markers: ['marker one', 'marker two'],
            sourceMetadata: expect.objectContaining({
              entries: [
                { label: 'Genotype', value: 'deltaX', position: 0 },
                { label: 'Resistance marker', value: 'marker one', position: 1 },
                { label: 'Resistance marker', value: 'marker two', position: 2 },
                { label: 'Blank', value: '', position: 3 },
              ],
            }),
          }),
        }),
      }),
      expect.objectContaining({
        entityRawId: 'sequence-native',
        input: expect.objectContaining({
          kind: 'dna_sequence',
          registrationStatus: 'unresolved',
          fields: expect.objectContaining({
            sequence: { mode: 'unresolved' },
            sourceMetadata: expect.objectContaining({
              values: expect.objectContaining({
                comments: ['Synthetic comment only.'],
                keywords: [],
              }),
            }),
          }),
        }),
      }),
    ]);
    expect(() => nativeWorkspaceManifestFromPlan({ workspacePath, plan })).not.toThrow();
  });

  it('keeps Benchling missing-value sentinels as source evidence instead of native strain fields', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-native-missing-strain-'));
    roots.push(workspacePath);
    const strain = source('bfi_MISSINGA', 'strain', 'Incomplete synthetic strain', {
      kind: 'benchling_strain',
      displayName: 'Incomplete synthetic strain',
      fields: [
        { label: 'Genotype', value: 'None', position: 0 },
        { label: 'Source', value: '-', position: 1 },
        { label: 'Resistance marker', value: 'None', position: 2 },
      ],
    });
    const strainReceipt = {
      ...receipt(strain.id, 'strain/.forge/benchling-native-record.json', 'strain-missing'),
      nativeRepresentation: 'strain' as const,
    };
    await mkdir(join(workspacePath, 'Benchling Imports/strain/.forge'), { recursive: true });
    await writeFile(join(workspacePath, strainReceipt.destinationPath), '{"kind":"strain"}');

    const plan = await buildNativeMigrationMaterializationPlan({
      run: migrationRun(workspacePath),
      sourceObjects: [strain],
      receipts: [strainReceipt],
      resolutions: [],
      folderProjection: null,
    });

    const fields = plan.limsEntities?.[0]?.input.fields;
    expect(plan.limsEntities?.[0]?.input.registrationStatus).toBe('unresolved');
    expect(fields).not.toHaveProperty('genotypeCanonical');
    expect(fields).not.toHaveProperty('source');
    expect(fields).not.toHaveProperty('markers');
    expect(fields).toMatchObject({
      sourceMetadata: {
        entries: [
          { label: 'Genotype', value: 'None', position: 0 },
          { label: 'Source', value: '-', position: 1 },
          { label: 'Resistance marker', value: 'None', position: 2 },
        ],
      },
    });
  });

  it('links a recovered LIMS entity to an existing imported LIMS entity', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-native-recovery-links-'));
    roots.push(workspacePath);
    const existing = source('dna-existing', 'dna_sequence', 'Existing DNA', { bases: 'ATGC' });
    const recovered = source('dna-recovered', 'dna_sequence', 'Recovered DNA', {
      bases: 'GCTA',
    });
    const existingReceipt = receipt(existing.id, 'existing.gb', 'native-dna-existing');
    const recoveredReceipt = receipt(recovered.id, 'recovered.gb', 'native-dna-recovered');
    await mkdir(join(workspacePath, 'Benchling Imports'), { recursive: true });
    await writeFile(
      join(workspacePath, recoveredReceipt.destinationPath),
      'LOCUS recovered 4 bp DNA'
    );

    const plan = await buildNativeMigrationMaterializationPlan({
      run: migrationRun(workspacePath),
      sourceObjects: [existing, recovered],
      receipts: [existingReceipt, recoveredReceipt],
      resolutions: [resolution(recovered.id, existing.id)],
      folderProjection: null,
      existingEntityRawIds: new Set([existingReceipt.destinationObjectId]),
      existingLimsEntityRawIds: new Set([existingReceipt.destinationObjectId]),
    });

    expect(plan.limsEntities).toEqual([
      expect.objectContaining({ entityRawId: recoveredReceipt.destinationObjectId }),
    ]);
    expect(plan.limsLinks).toEqual([
      expect.objectContaining({
        fromEntityRawId: recoveredReceipt.destinationObjectId,
        toEntityRawId: existingReceipt.destinationObjectId,
        type: 'derives_from',
      }),
    ]);
  });
});

function twoFolderProjection(destinationObjectId: string): CollectionProjection {
  const folder = (id: string, title: string) => ({
    schema: 'dnaforge.collection.v1' as const,
    kind: 'collection' as const,
    id,
    title,
    editable: true as const,
    parentCollectionId: null,
    childCollectionIds: [],
    memberObjectIds: [destinationObjectId],
    excludedChildFolders: [],
    provenance: {
      immutableSource: true as const,
      provider: 'benchling' as const,
      sourceAccountHash: 'account-hash',
      sourceFolderId: id.replace('folder-', 'lib_'),
      sourceUrl: `https://example.benchling.com/folders/${id}`,
      sourceParentFolderId: null,
      selectedRoot: true,
      capturedAt: '2026-08-16T01:00:00.000Z',
    },
  });
  return {
    schema: 'dnaforge.collection-projection.v1',
    scopeKind: 'folder_tree',
    sourceAccountHash: 'account-hash',
    selectedRootSourceIds: ['lib_a', 'lib_b'],
    selectedSourceObjectIds: ['dna-1'],
    oneHopDependencySourceObjectIds: [],
    collections: [
      folder('folder-aaaaaaaaaaaaaaaaaaaaaaaa', 'First folder'),
      folder('folder-bbbbbbbbbbbbbbbbbbbbbbbb', 'Second folder'),
    ],
    objectMemberships: [
      {
        sourceObjectId: 'dna-1',
        destinationObjectId,
        sourceMembershipIds: ['lib_a', 'lib_b'],
        destinationCollectionIds: [
          'folder-aaaaaaaaaaaaaaaaaaaaaaaa',
          'folder-bbbbbbbbbbbbbbbbbbbbbbbb',
        ],
        omittedSourceMembershipIds: [],
        scopeRole: 'selected',
      },
    ],
  };
}

function source(
  id: string,
  sourceType: string,
  name: string,
  content: Record<string, unknown>
): SourceObject {
  return {
    id,
    stableId: id,
    sourceType,
    name,
    aliases: [],
    sourceUrl: `https://example.benchling.com/${id}`,
    attachmentHashes: [],
    memberships: [],
    createdAt: '2026-08-16T01:00:00.000Z',
    modifiedAt: '2026-08-16T01:00:00.000Z',
    metadata: {},
    content,
    relationships: [],
  };
}

function receipt(
  sourceObjectId: string,
  fileName: string,
  destinationObjectId: string
): ProjectionReceipt {
  return {
    id: `receipt-${sourceObjectId}`,
    runId: 'run-native-materialization',
    sourceObjectId,
    destinationObjectId,
    destinationPath: `Benchling Imports/${fileName}`,
    projection: 'native',
    converterId: 'test',
    converterVersion: '1',
    sourceHash: 'a'.repeat(64),
    destinationHash: 'b'.repeat(64),
    warnings: [],
    exception: null,
    formulaEvidence: [],
    createdAt: '2026-08-16T01:00:01.000Z',
  };
}

function resolution(sourceObjectId: string, targetSourceId: string): RelationshipResolution {
  return {
    relationshipId: `relationship-${sourceObjectId}-${targetSourceId}`,
    sourceObjectId,
    targetSourceId,
    relationType: 'derives_from',
    classification: 'exact',
    evidence: [],
    candidateSourceIds: [targetSourceId],
    requiresTargetedRead: false,
    reason: 'Exact stable ID match.',
  };
}

function migrationRun(workspacePath: string): MigrationRun {
  return {
    version: 1,
    id: 'run-native-materialization',
    workspaceId: 'workspace-native-materialization',
    workspacePath,
    displayName: 'Native materialization test',
    scope: {
      version: 1,
      kind: 'file',
      source: {
        id: 'dna-1',
        url: 'https://example.benchling.com/dna-1',
        objectType: 'dna_sequence',
      },
    },
    binding: null,
    state: 'ready_to_unlock',
    resumeState: null,
    attempt: 1,
    converterVersions: {},
    createdAt: '2026-08-16T01:00:00.000Z',
    updatedAt: '2026-08-16T01:00:00.000Z',
    startedAt: '2026-08-16T01:00:00.000Z',
    unlockedAt: null,
    lastError: null,
  };
}

function metadataFor(
  entities: Awaited<ReturnType<typeof buildNativeMigrationMaterializationPlan>>['entities'],
  rawId: string
): Record<string, unknown> {
  const metadata = entities.find((entry) => entry.rawId === rawId)?.metadata;
  if (!metadata) throw new Error(`Missing metadata for ${rawId}.`);
  return metadata;
}
