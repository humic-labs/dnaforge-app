import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildNestedFolderTreeNativeExportFixture,
  buildSyntheticNativeExportZip,
  type SyntheticZipFixture,
} from './__fixtures__/native-export-zip-fixture';
import { ContentArchive } from './content-archive';
import { selectExternalZipSource } from './external-zip-source';
import type { VerifiedLocalBenchlingZipExport } from './local-export-bundle';
import { decodeWorkspaceAppendExport } from './workspace-append-decoder';
import { sourceObjectMaterializationView } from './source-object-materialization-view';
import { inspectNativeExportArchive } from './native-export-archive';
import { surveyRegistryTableReviews } from './registry-table-review';
import { buildProjectionPlan } from './projection';
import type { RegistryTableMappingDecision } from '../../shared/benchling-registry-table-review';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const DESTINATION_FOLDER = 'lib_APPEND_DESTINATION';
const APPEND_CONTEXT = {
  runId: 'migration_APPEND_TREE',
  attemptId: 'attempt_APPEND_TREE',
  artifactId: 'artifact_APPEND_TREE',
} as const;
const SEQUENCE_A =
  'LOCUS       seq_APPEND1       8 bp    DNA     linear\nDEFINITION  Appended DNA.\nORIGIN\n        1 acgtacgt\n//\n';
const SEQUENCE_B =
  'LOCUS       seq_APPEND2       8 bp    DNA     linear\nDEFINITION  Second appended DNA.\nORIGIN\n        1 ttttaaaa\n//\n';

describe('decodeWorkspaceAppendExport', () => {
  it('keeps an invalid UTF-8 source as a file without dropping a valid sibling', async () => {
    const badPath = 'Lab/Unreadable sequence (seq_UNREAD1).gb';
    const fixture = buildSyntheticNativeExportZip([
      { path: badPath, bytes: Uint8Array.from([0xff, 0xfe, 0xfd]) },
      { path: 'Lab/Good sequence (seq_GOODSEQ12).gb', bytes: SEQUENCE_B },
    ]);
    const { artifact, archive } = await artifactFor(fixture);
    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-31T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
    });
    expect(result.matched).toHaveLength(2);
    const bad = result.matched.find((entry) => entry.sourceObject.sourcePath === badPath);
    expect(bad?.sourceObject).toMatchObject({
      stableId: 'seq_UNREAD1',
      sourceType: 'unsupported_object',
      metadata: { nativeParseException: expect.stringContaining('could not become an editable') },
      content: { rawAccess: { entryPath: badPath } },
    });
    expect(
      result.matched.find((entry) => entry.sourceObject.stableId === 'seq_GOODSEQ12')?.sourceObject
        .sourceType
    ).toBe('dna_sequence');
  });

  it('preserves one verified entry as a file while keeping another record editable', async () => {
    const failedPath = 'Lab/Bad sequence (seq_BADSEQ12).gb';
    const fixture = buildSyntheticNativeExportZip([
      { path: failedPath, bytes: SEQUENCE_A },
      { path: 'Lab/Good sequence (seq_GOODSEQ12).gb', bytes: SEQUENCE_B },
    ]);
    const { artifact, archive } = await artifactFor(fixture);
    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-31T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
      fallbackEntryPaths: [failedPath],
    });
    expect(result.matched).toHaveLength(2);
    const fallback = result.matched.find((entry) => entry.sourceObject.sourcePath === failedPath);
    const good = result.matched.find((entry) => entry.sourceObject.stableId === 'seq_GOODSEQ12');
    expect(fallback?.sourceObject).toMatchObject({
      stableId: 'seq_BADSEQ12',
      sourceType: 'unsupported_object',
      content: { rawAccess: { entryPath: failedPath } },
    });
    expect(good?.sourceObject.sourceType).toBe('dna_sequence');
    const planFor = (source: NonNullable<typeof fallback>['sourceObject']) =>
      buildProjectionPlan(source, {
        runId: APPEND_CONTEXT.runId,
        capturedAt: '2026-08-31T00:00:00.000Z',
        converterVersion: 'test',
      });
    expect(planFor(fallback!.sourceObject).projection).toBe('fallback');
    expect(planFor(good!.sourceObject).projection).toBe('native');
  });

  it('refuses fallback paths that are not selected verified records', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'Lab/Good sequence (seq_GOODSEQ12).gb', bytes: SEQUENCE_B },
    ]);
    const { artifact, archive } = await artifactFor(fixture);
    await expect(
      decodeWorkspaceAppendExport({
        artifact,
        archive,
        capturedAt: '2026-08-31T00:00:00.000Z',
        destinationFolderId: DESTINATION_FOLDER,
        ...APPEND_CONTEXT,
        fallbackEntryPaths: ['Lab/Absent sequence (seq_ABSENT12).gb'],
      })
    ).rejects.toMatchObject({ code: 'native_export_fallback_selection_invalid' });
  });

  it('decodes reviewed local table rows through the same production path as appended ZIPs', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'Registry/Records.csv', bytes: 'Name,Value\nSame,0\nSame,2\n' },
    ]);
    const { artifact, archive } = await artifactFor(fixture);
    const inspected = await inspectNativeExportArchive(artifact.nativeExportDecoderSource);
    const candidate = (await surveyRegistryTableReviews(inspected))[0];
    if (candidate.status !== 'ready') throw new Error('Expected table fixture.');
    const { archiveSha256, entryPath, entrySha256, entrySizeBytes } = candidate;
    const decision: RegistryTableMappingDecision = {
      kind: 'registry_table_mapping',
      version: 1,
      source: { archiveSha256, entryPath, entrySha256, entrySizeBytes },
      outcome: {
        kind: 'records',
        headersSha256: candidate.headersSha256,
        rowCount: 2,
        columns: [{ kind: 'name' }, { kind: 'field', label: 'Value', type: 'number' }],
      },
    };
    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-31T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
      reviewedTables: [decision],
    });
    expect(result.matched).toHaveLength(2);
    expect(new Set(result.matched.map((row) => row.sourceObject.id)).size).toBe(2);
    expect(result.matched.map((entry) => entry.sourceObject.metadata.benchlingRegistry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldValues: { column_2: 0 },
          reviewedTable: expect.objectContaining({
            actionId: APPEND_CONTEXT.attemptId,
            rowOrdinal: 1,
          }),
        }),
        expect.objectContaining({
          fieldValues: { column_2: 2 },
          reviewedTable: expect.objectContaining({
            actionId: APPEND_CONTEXT.attemptId,
            rowOrdinal: 2,
          }),
        }),
      ])
    );
    expect(result.hierarchyCapture?.memberships.map((item) => item.sourceObjectId).sort()).toEqual(
      result.matched.map((row) => row.sourceObject.id).sort()
    );
  });

  it('retains exact provider-type and authored-role evidence without automatically classifying DNA', async () => {
    const target = 'seq_OLIGO001';
    const url = `https://benchling.com/dnaforge-fixture/${target}-candidate/edit`;
    const chip = `<span class="internalLink" data-internal-link='${JSON.stringify({ id: target, iconId: 'oligo', url })}'><a href="${url}">Candidate</a></span>`;
    const fixture = buildSyntheticNativeExportZip([
      { path: `Lab/Candidate (${target}).gb`, bytes: SEQUENCE_A },
      {
        path: 'Lab/Experiment (etr_NOTEBOOK01).html',
        bytes: `<html><body><h1>Experiment</h1><div data-test-component="EditableComponent" data-test-element="root">Redesigned forward primer – ${chip} – overlaps the template</div></body></html>`,
      },
    ]);
    const { artifact, archive } = await artifactFor(fixture);
    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-30T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
    });
    const sequence = result.matched.find(
      (entry) => entry.sourceObject.stableId === target
    )!.sourceObject;
    const notebook = result.matched.find(
      (entry) => entry.sourceObject.stableId === 'etr_NOTEBOOK01'
    )!.sourceObject;
    expect(sequence.sourceType).toBe('dna_sequence');
    expect(notebook.metadata.classificationEvidence).toMatchObject({
      schema: 'dnaforge.benchling.classification-evidence.v1',
      facts: [
        { channel: 'provider_display_type', targetSourceId: target, value: 'oligo' },
        {
          channel: 'authored_role',
          targetSourceId: target,
          value: 'primer',
          excerpt: 'Redesigned forward primer',
        },
      ],
    });
    expect(sourceObjectMaterializationView(notebook).metadata.classificationEvidence).toEqual(
      notebook.metadata.classificationEvidence
    );
  });

  it('imports explicitly identified registry rows through the production ZIP reader', async () => {
    const fixture = buildSyntheticNativeExportZip([
      {
        path: 'Registry/reagents.schema.json',
        bytes: JSON.stringify({
          schema: 'benchling.registry-schema.v1',
          sourceSchemaId: 'schema_FIDELITY_REAGENT',
          sourceRevisionId: 'revision_FIDELITY_REAGENT_1',
          sourceRevisionNumber: 1,
          name: 'fidelity_reagent',
          displayName: 'Fidelity reagent',
          recordPaths: ['Registry/reagents.csv'],
          fields: [
            {
              sourceFieldId: 'field_CONCENTRATION',
              definition: { key: 'concentration', label: 'Concentration', type: 'number' },
            },
            {
              sourceFieldId: 'field_VERIFIED',
              definition: { key: 'verified', label: 'Verified', type: 'boolean' },
            },
          ],
        }),
      },
      {
        path: 'Registry/reagents.csv',
        bytes:
          'id,name,concentration,verified\nbfi_FIDELITYA,Reagent A,12.5,true\nbfi_FIDELITYB,Reagent B,0,false\n',
      },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-30T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
    });

    expect(result.matched.map((entry) => entry.sourceObject.stableId).sort()).toEqual([
      'bfi_FIDELITYA',
      'bfi_FIDELITYB',
    ]);
    expect(result.matched.map((entry) => entry.canonicalEntryPath)).toEqual([
      'Registry/reagents.csv',
      'Registry/reagents.csv',
    ]);
    expect(result.matched[0]?.sourceObject).toMatchObject({
      sourceType: 'registry_record',
      schemaId: 'schema_FIDELITY_REAGENT',
      name: 'Reagent A',
      metadata: {
        benchlingRegistry: { fieldValues: { concentration: 12.5, verified: true } },
      },
    });
    expect(result.matched[1]?.sourceObject).toMatchObject({
      metadata: { benchlingRegistry: { fieldValues: { concentration: 0, verified: false } } },
    });
  });

  it('accepts every supported canonical object, not only a named allowlist', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'Appended DNA (seq_APPEND1).gb', bytes: SEQUENCE_A },
      { path: 'Second appended DNA (seq_APPEND2).gb', bytes: SEQUENCE_B },
      {
        path: 'Appended notebook (etr_APPENDNB).html',
        bytes: '<html><body><h1>Appended notebook</h1></body></html>',
      },
      {
        path: 'Registry entity (bfi_APPENDREG).html',
        bytes: '<html><body><h1>Registry entity</h1></body></html>',
      },
      {
        path: 'Registry entity (bfi_APPENDREG).txt',
        bytes: 'Registry entity\nStatus: active\n',
      },
      {
        path: 'Text-only registry entity (bfi_APPENDTXT).txt',
        bytes: 'Text-only registry entity\nStatus: active\n',
      },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-20T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
    });

    expect(result.matched.map((entry) => entry.sourceObject.stableId).sort()).toEqual([
      'bfi_APPENDREG',
      'bfi_APPENDTXT',
      'etr_APPENDNB',
      'seq_APPEND1',
      'seq_APPEND2',
    ]);
    expect(result.ignoredCanonicalObjectCount).toBe(0);
  });

  it('keeps each decoded object bound to the stable ID in its own filename', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'Appended DNA (seq_APPEND1).gb', bytes: SEQUENCE_A },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-20T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
    });

    const [only] = result.matched;
    expect(only.sourceObject.id).toBe('seq_APPEND1');
    expect(only.sourceObject.stableId).toBe('seq_APPEND1');
    expect(only.canonicalEntryPath).toBe('Appended DNA (seq_APPEND1).gb');
  });

  it('ignores files that carry no canonical stable ID rather than guessing one', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'oPNC1186.gb', bytes: SEQUENCE_A },
      { path: 'notes.txt', bytes: 'not a canonical object' },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-20T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
    });

    expect(result.matched).toEqual([]);
  });

  it('refuses a filename that names more than one canonical ID', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'Ambiguous (seq_AMBIG001) (seq_AMBIG002).gb', bytes: SEQUENCE_A },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    await expect(
      decodeWorkspaceAppendExport({
        artifact,
        archive,
        capturedAt: '2026-08-20T00:00:00.000Z',
        destinationFolderId: DESTINATION_FOLDER,
        ...APPEND_CONTEXT,
      })
    ).rejects.toThrow(/ambiguous/i);
  });

  it('does not mistake a short seq_ token in the object title for a second stable ID', async () => {
    const fixture = buildSyntheticNativeExportZip([
      {
        path: 'HIS3.seq_Dn OLI612 (seq_DemoSeq5).gb',
        bytes: SEQUENCE_A.replaceAll('seq_APPEND1', 'seq_DemoSeq5'),
      },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-20T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
    });

    expect(result.matched.map((entry) => entry.sourceObject.stableId)).toEqual(['seq_DemoSeq5']);
  });

  it('refuses when the decoded object disagrees with the ID in its filename', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'Mislabelled (seq_APPEND1).gb', bytes: SEQUENCE_A },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    await expect(
      decodeWorkspaceAppendExport({
        artifact,
        archive,
        capturedAt: '2026-08-20T00:00:00.000Z',
        destinationFolderId: DESTINATION_FOLDER,
        ...APPEND_CONTEXT,
        decodeNativeExport: async () =>
          ({
            sourceObjects: [
              {
                id: 'seq_SOMETHINGELSE',
                stableId: 'seq_SOMETHINGELSE',
                sourcePath: 'Mislabelled (seq_APPEND1).gb',
                type: 'sequence',
                relationships: [],
                metadata: {},
              },
            ],
            entries: [],
            attachments: [],
          }) as never,
      })
    ).rejects.toThrow(/does not match the stable ID/i);
  });

  it('refuses when a canonical file decodes to nothing at all', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'Appended DNA (seq_APPEND1).gb', bytes: SEQUENCE_A },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    await expect(
      decodeWorkspaceAppendExport({
        artifact,
        archive,
        capturedAt: '2026-08-20T00:00:00.000Z',
        destinationFolderId: DESTINATION_FOLDER,
        ...APPEND_CONTEXT,
        decodeNativeExport: async () =>
          ({ sourceObjects: [], entries: [], attachments: [] }) as never,
      })
    ).rejects.toThrow(/did not decode/i);
  });

  it('carries the appended notebook relationships so its references can resolve', async () => {
    const fixture = buildSyntheticNativeExportZip([
      {
        path: 'Appended notebook (etr_APPENDNB).html',
        bytes:
          '<html><body><h1>Appended notebook</h1>' +
          '<a href="https://benchling.com/acme/f/lib_x/seq_APPEND1-dna/edit" ' +
          `data-internal-link='{"type":"sequence","id":"seq_APPEND1"}'>Linked</a>` +
          '</body></html>',
      },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-20T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
    });

    const [notebook] = result.matched;
    expect(notebook.sourceObject.relationships.length).toBeGreaterThan(0);
    expect(notebook.sourceObject.relationships.map((entry) => entry.targetSourceId)).toContain(
      'seq_APPEND1'
    );
  });

  it('maps the ZIP root to the destination and preserves every descendant membership', async () => {
    const fixture = buildNestedFolderTreeNativeExportFixture();
    const { artifact, archive } = await artifactFor(fixture.archive);

    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-20T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
    });
    const hierarchyCapture = result.hierarchyCapture;
    if (!hierarchyCapture) throw new Error('Expected nested append hierarchy capture.');

    const childByPath = new Map(
      hierarchyCapture.folders.map((folder) => [folder.archiveRelativePath, folder])
    );
    expect(hierarchyCapture).toMatchObject({
      runId: APPEND_CONTEXT.runId,
      attemptId: APPEND_CONTEXT.attemptId,
      artifactId: APPEND_CONTEXT.artifactId,
      artifactSha256: artifact.sha256,
      destinationRootSourceId: DESTINATION_FOLDER,
      zipRootName: fixture.rootFolderName,
    });
    expect([...childByPath.keys()].sort()).toEqual([
      'Alpha',
      'Alpha/Grandchild',
      'Beta',
      'Delta',
      'Epsilon',
      'Gamma',
      'Registry',
    ]);
    expect(childByPath.get('Alpha/Grandchild')?.parentSourceId).toBe(
      childByPath.get('Alpha')?.sourceId
    );
    const membershipPaths = new Map<string, string>([[DESTINATION_FOLDER, '']]);
    for (const folder of hierarchyCapture.folders) {
      membershipPaths.set(folder.sourceId, folder.archiveRelativePath);
    }
    expect(
      hierarchyCapture.memberships
        .map(
          (membership) =>
            `${membership.sourceObjectId}\0${membershipPaths.get(membership.folderSourceId)}`
        )
        .sort()
    ).toEqual(
      fixture.expectedMembershipPairs
        .map((pair) =>
          pair.replace(`${fixture.rootFolderName}/`, '').replace(fixture.rootFolderName, '')
        )
        .sort()
    );
    expect(
      result.matched.find((entry) => entry.sourceObject.stableId === 'seq_TREESHARED')?.sourceObject
        .memberships
    ).toEqual([childByPath.get('Alpha')?.sourceId, childByPath.get('Beta')?.sourceId].sort());
  });

  it('replays one artifact exactly and ignores ZIP entry ordering in the logical tree', async () => {
    const entries = [
      { path: 'One Root/Child/Second (seq_APPEND2).gb', bytes: SEQUENCE_B },
      { path: 'One Root/First (seq_APPEND1).gb', bytes: SEQUENCE_A },
    ] as const;
    const first = await artifactFor(buildSyntheticNativeExportZip(entries));
    const replay = await decodeWorkspaceAppendExport({
      artifact: first.artifact,
      archive: first.archive,
      capturedAt: '2026-08-20T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
    });
    const exactReplay = await decodeWorkspaceAppendExport({
      artifact: first.artifact,
      archive: first.archive,
      capturedAt: '2026-08-20T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
    });
    expect(exactReplay.hierarchyCapture).toEqual(replay.hierarchyCapture);

    const reordered = await artifactFor(buildSyntheticNativeExportZip([...entries].reverse()));
    const reorderedResult = await decodeWorkspaceAppendExport({
      artifact: reordered.artifact,
      archive: reordered.archive,
      capturedAt: '2026-08-20T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
      artifactId: 'artifact_APPEND_TREE_REORDERED',
    });
    const replayCapture = replay.hierarchyCapture;
    const reorderedCapture = reorderedResult.hierarchyCapture;
    if (!replayCapture || !reorderedCapture) {
      throw new Error('Expected replayed nested append hierarchy captures.');
    }
    expect(reorderedCapture.folders).toEqual(replayCapture.folders);
    expect(reorderedCapture.memberships).toEqual(replayCapture.memberships);
  });

  it('preserves multiple exported roots as siblings under the destination', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'Root A/First (seq_APPEND1).gb', bytes: SEQUENCE_A },
      { path: 'Root B/Second (seq_APPEND2).gb', bytes: SEQUENCE_B },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-20T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
    });

    expect(result.hierarchyCapture?.folders.map((folder) => folder.name).sort()).toEqual([
      'Root A',
      'Root B',
    ]);
    expect(
      result.matched.map((entry) => ({
        id: entry.sourceObject.stableId,
        memberships: entry.sourceObject.memberships,
      }))
    ).toEqual([
      { id: 'seq_APPEND1', memberships: [result.hierarchyCapture?.folders[0]?.sourceId] },
      { id: 'seq_APPEND2', memberships: [result.hierarchyCapture?.folders[1]?.sourceId] },
    ]);
  });

  it('refuses an append ZIP whose logical folder path escapes its root', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'Selected Root/../Escape/First (seq_APPEND1).gb', bytes: SEQUENCE_A },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    await expect(
      decodeWorkspaceAppendExport({
        artifact,
        archive,
        capturedAt: '2026-08-20T00:00:00.000Z',
        destinationFolderId: DESTINATION_FOLDER,
        ...APPEND_CONTEXT,
      })
    ).rejects.toThrow(/unsafe segment|safe archive|selected root directory/i);
  });

  it('leaves memberships empty when the run has no destination folder', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'Appended DNA (seq_APPEND1).gb', bytes: SEQUENCE_A },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-20T00:00:00.000Z',
      destinationFolderId: null,
      ...APPEND_CONTEXT,
    });

    expect(result.matched[0].sourceObject.memberships).toEqual([]);
  });

  it.each(['archived', 'external'] as const)(
    'gives each object only its own %s attachments',
    async (mode) => {
      const fixture = buildSyntheticNativeExportZip([
        {
          path: 'First notebook (etr_APPENDN1).html',
          bytes: '<html><body><h1>First</h1></body></html>',
        },
        {
          path: 'Second notebook (etr_APPENDN2).html',
          bytes: '<html><body><h1>Second</h1></body></html>',
        },
        { path: 'First notebook (etr_APPENDN1) diagram.png', bytes: 'first-attachment-bytes' },
        { path: 'Second notebook (etr_APPENDN2) diagram.png', bytes: 'second-attachment-bytes' },
      ]);
      const { artifact, archive, zipPath } = await artifactFor(fixture);
      const external =
        mode === 'external'
          ? await selectExternalZipSource({
              sourcePath: zipPath,
              selectedAt: '2026-08-20T00:00:00.000Z',
            })
          : undefined;

      const result = await decodeWorkspaceAppendExport({
        artifact,
        archive,
        externalZipEntries: external?.entries,
        capturedAt: '2026-08-20T00:00:00.000Z',
        destinationFolderId: DESTINATION_FOLDER,
        ...APPEND_CONTEXT,
      });

      const attachmentsById = new Map(
        result.matched.map((entry) => [
          entry.sourceObject.stableId,
          entry.attachments.map((attachment) => attachment.evidence.logicalFilename).sort(),
        ])
      );
      expect(attachmentsById.get('etr_APPENDN1')).toEqual([
        'First notebook (etr_APPENDN1) diagram.png',
      ]);
      expect(attachmentsById.get('etr_APPENDN2')).toEqual([
        'Second notebook (etr_APPENDN2) diagram.png',
      ]);
    }
  );

  it('converges alternate HTML and GenBank attachment claims on the same sequence', async () => {
    const fixture = buildSyntheticNativeExportZip([
      {
        path: 'OEA042 (seq_DEMOSQ02).gb',
        bytes: SEQUENCE_A.replaceAll('seq_APPEND1', 'seq_DEMOSQ02'),
      },
      {
        path: 'OEA042 (seq_DEMOSQ02).html',
        bytes: '<html><body><h1>OEA042</h1></body></html>',
      },
      {
        path: 'OEA042 (seq_DEMOSQ02) image.png.png',
        bytes: 'opaque-image-bytes',
      },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-20T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
    });

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].sourceObject.stableId).toBe('seq_DEMOSQ02');
    expect(
      result.matched[0].attachments.map((attachment) => attachment.evidence.logicalFilename)
    ).toEqual(['OEA042 (seq_DEMOSQ02) image.png.png']);
  });

  it('records the appending archive on each object so its provenance is traceable', async () => {
    const fixture = buildSyntheticNativeExportZip([
      { path: 'Appended DNA (seq_APPEND1).gb', bytes: SEQUENCE_A },
    ]);
    const { artifact, archive } = await artifactFor(fixture);

    const result = await decodeWorkspaceAppendExport({
      artifact,
      archive,
      capturedAt: '2026-08-20T00:00:00.000Z',
      destinationFolderId: DESTINATION_FOLDER,
      ...APPEND_CONTEXT,
    });

    expect(result.matched[0].sourceObject.metadata).toMatchObject({
      workspaceAppend: expect.objectContaining({ appendedExportSha256: artifact.sha256 }),
    });
  });
});

async function artifactFor(fixture: SyntheticZipFixture): Promise<{
  artifact: VerifiedLocalBenchlingZipExport;
  archive: ContentArchive;
  zipPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'workspace-append-decoder-'));
  roots.push(root);
  const zipPath = join(root, 'appended.zip');
  await writeFile(zipPath, fixture.bytes);
  const archive = new ContentArchive(join(root, 'archive'));
  const blob = await archive.putFile(zipPath, { expectedSize: fixture.bytes.length });
  const artifact: VerifiedLocalBenchlingZipExport = {
    schema: 'dnaforge.benchling.local-export-artifact.v1',
    format: 'zip',
    logicalFilename: 'appended.zip',
    sha256: `sha256:${blob.sha256}`,
    sizeBytes: blob.size,
    immutableLocalPath: blob.path,
    nativeExportDecoderSource: {
      kind: 'local_path',
      logicalFilename: 'appended.zip',
      localPath: blob.path,
      expectedSha256: `sha256:${blob.sha256}`,
      expectedSizeBytes: blob.size,
      duplicateSupportEntryPolicy: 'identical_root_benchling_css',
    },
    resources: [],
    archive: { blobSha256: blob.sha256, sizeBytes: blob.size },
  } as unknown as VerifiedLocalBenchlingZipExport;
  return { artifact, archive, zipPath };
}
