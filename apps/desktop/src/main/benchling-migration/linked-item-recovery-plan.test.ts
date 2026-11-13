import { describe, expect, it, vi } from 'vitest';
import type {
  MigrationRun,
  RelationshipResolution,
  SourceObject,
  SourceRelationship,
  ValidationLinkedItemRecoveryAttemptEvidence,
} from '../../shared/benchling-migration';
import {
  buildLinkedItemRecoveryEvidence,
  resolveLinkedItemRecoveryLocation,
} from './linked-item-recovery-plan';

const ORGANIZATION_BASE_URL = 'https://benchling.com/exampleuser';

describe('linked-item recovery plan', () => {
  it('pins the audited 41 relationships, 39 targets, and 5 source folders without network access', () => {
    const fixture = buildAuditedTopologyFixture();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const evidence = buildLinkedItemRecoveryEvidence({
        run: makeLocalZipRun(),
        sourceObjects: fixture.sourceObjects,
        resolutions: fixture.resolutions,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(evidence).not.toBeNull();
      expect(evidence).toMatchObject({
        organizationBaseUrl: ORGANIZATION_BASE_URL,
        relationshipCount: 41,
        uniqueTargetCount: 39,
        folderCount: 5,
        recoveredUniqueObjectCount: 0,
        remainingUniqueObjectCount: 39,
        repairedRelationshipCount: 0,
        remainingRelationshipCount: 41,
      });
      expect(
        evidence?.folders.map((folder) => ({
          sourceId: folder.sourceId,
          name: folder.name,
          targetCount: folder.targetCount,
          relationshipCount: folder.relationshipCount,
          countsByType: folder.countsByType,
        }))
      ).toEqual([
        {
          sourceId: 'lib_DEMOLB05',
          name: 'Plasmid sequencing results',
          targetCount: 26,
          relationshipCount: 27,
          countsByType: {
            dna_rna_sequence: 26,
            protein: 0,
            protocol: 0,
            other: 0,
          },
        },
        {
          sourceId: 'lib_DEMOLB03',
          name: 'Protocols',
          targetCount: 5,
          relationshipCount: 6,
          countsByType: {
            dna_rna_sequence: 0,
            protein: 0,
            protocol: 5,
            other: 0,
          },
        },
        {
          sourceId: 'lib_DEMOLB04',
          name: 'Test primers',
          targetCount: 4,
          relationshipCount: 4,
          countsByType: {
            dna_rna_sequence: 4,
            protein: 0,
            protocol: 0,
            other: 0,
          },
        },
        {
          sourceId: 'lib_DEMOLB07',
          name: 'Example assembly demo',
          targetCount: 2,
          relationshipCount: 2,
          countsByType: {
            dna_rna_sequence: 2,
            protein: 0,
            protocol: 0,
            other: 0,
          },
        },
        {
          sourceId: 'lib_DEMOLB01',
          name: 'Wild types',
          targetCount: 2,
          relationshipCount: 2,
          countsByType: {
            dna_rna_sequence: 1,
            protein: 1,
            protocol: 0,
            other: 0,
          },
        },
      ]);

      expect(evidence?.targets.find((target) => target.sourceId === 'seq_DEMOSQ01')).toMatchObject({
        relationshipCount: 2,
        objectType: 'dna_rna_sequence',
      });
      expect(evidence?.targets.find((target) => target.sourceId === 'prt_DEMOPR01')).toMatchObject({
        relationshipCount: 2,
        objectType: 'protocol',
      });
      expect(resolveLinkedItemRecoveryLocation(evidence!, 'folder', 'lib_DEMOLB05')).toBe(
        `${ORGANIZATION_BASE_URL}/f_/DEMOLB05-plasmid-sequencing-results/`
      );
      expect(resolveLinkedItemRecoveryLocation(evidence!, 'folder', 'lib_DEMOLB03')).toBe(
        `${ORGANIZATION_BASE_URL}/f_/DEMOLB03-protocols/`
      );
      expect(resolveLinkedItemRecoveryLocation(evidence!, 'target', 'seq_DEMOSQ01')).toBe(
        fixture.targetUrls.get('seq_DEMOSQ01')
      );
      expect(resolveLinkedItemRecoveryLocation(evidence!, 'target', 'seq_missing')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('repairs the exact legacy item-route folder URL in an already-saved report', () => {
    const fixture = buildAuditedTopologyFixture();
    const evidence = buildLinkedItemRecoveryEvidence({
      run: makeLocalZipRun(),
      sourceObjects: fixture.sourceObjects,
      resolutions: fixture.resolutions,
    });
    expect(evidence).not.toBeNull();
    const legacyEvidence = {
      ...evidence!,
      folders: evidence!.folders.map((folder) =>
        folder.sourceId === 'lib_DEMOLB05'
          ? {
              ...folder,
              sourceUrl: `${ORGANIZATION_BASE_URL}/f/lib_DEMOLB05-plasmid-sequencing-results`,
            }
          : folder
      ),
    };

    expect(resolveLinkedItemRecoveryLocation(legacyEvidence, 'folder', 'lib_DEMOLB05')).toBe(
      `${ORGANIZATION_BASE_URL}/f_/DEMOLB05-plasmid-sequencing-results/`
    );
    expect(
      resolveLinkedItemRecoveryLocation(
        {
          ...legacyEvidence,
          folders: legacyEvidence.folders.map((folder) =>
            folder.sourceId === 'lib_DEMOLB05'
              ? { ...folder, sourceUrl: `${ORGANIZATION_BASE_URL}/f_/wrong-folder/` }
              : folder
          ),
        },
        'folder',
        'lib_DEMOLB05'
      )
    ).toBeNull();
  });

  it('keeps the prior static plan while recomputing recovered objects and repaired relationships', () => {
    const fixture = buildAuditedTopologyFixture();
    const firstAttempt = makeAttempt({
      attemptId: 'attempt-1',
      outcome: 'partial',
      recoveredTargetCount: 0,
      repairedRelationshipCount: 0,
      completedAt: '2026-08-13T18:00:00.000Z',
    });
    const priorEvidence = buildLinkedItemRecoveryEvidence({
      run: makeLocalZipRun(),
      sourceObjects: fixture.sourceObjects,
      resolutions: fixture.resolutions,
      attempts: [firstAttempt],
    });
    expect(priorEvidence).not.toBeNull();

    const duplicateTargetId = 'seq_DEMOSQ01';
    const repairedIds = new Set(
      priorEvidence?.targets.find((target) => target.sourceId === duplicateTargetId)
        ?.relationshipIds ?? []
    );
    expect(repairedIds.size).toBe(2);
    const currentResolutions = fixture.resolutions.map((resolution) =>
      repairedIds.has(resolution.relationshipId)
        ? { ...resolution, classification: 'exact' as const, reason: 'Exact stable ID match.' }
        : resolution
    );
    const recoveredTarget = makeSourceObject(duplicateTargetId, []);
    const secondAttempt = makeAttempt({
      attemptId: 'attempt-2',
      outcome: 'partial',
      recoveredTargetCount: 1,
      repairedRelationshipCount: 2,
      completedAt: '2026-08-13T19:00:00.000Z',
    });

    const currentEvidence = buildLinkedItemRecoveryEvidence({
      run: makeLocalZipRun(),
      sourceObjects: [...fixture.sourceObjects, recoveredTarget],
      resolutions: currentResolutions,
      priorEvidence,
      attempts: [secondAttempt],
    });

    expect(currentEvidence).toMatchObject({
      relationshipCount: 41,
      uniqueTargetCount: 39,
      recoveredUniqueObjectCount: 1,
      remainingUniqueObjectCount: 38,
      repairedRelationshipCount: 2,
      remainingRelationshipCount: 39,
      attempts: [firstAttempt, secondAttempt],
    });
    expect(
      currentEvidence?.targets.find((target) => target.sourceId === duplicateTargetId)
    ).toMatchObject({ recovered: true, relationshipCount: 2 });
    expect(
      currentEvidence?.folders.find((folder) => folder.sourceId === 'lib_DEMOLB05')
    ).toMatchObject({ recoveredTargetCount: 1 });
  });

  it('excludes malformed, cross-organization, target-conflicting, and folder-conflicting links', () => {
    const relationships: SourceRelationship[] = [];
    const resolutions: RelationshipResolution[] = [];
    const add = (input: { id: string; targetId: string; url: string; evidenceUrl?: string }) => {
      const relationship = makeRelationship(input.id, input.targetId, input.url, input.evidenceUrl);
      relationships.push(relationship);
      resolutions.push(makeUnresolvedResolution(relationship));
    };

    add({
      id: 'rel_valid_1',
      targetId: 'seq_VALID001',
      url: `${ORGANIZATION_BASE_URL}/f/lib_VALID001-valid-folder/seq_VALID001-entry_with_seq_LOOKALIKE-name/edit`,
    });
    add({
      id: 'rel_valid_2',
      targetId: 'prt_VALID002',
      url: `${ORGANIZATION_BASE_URL}/f/lib_VALID001-valid-folder/prt_VALID002-chemical-transformation/edit`,
    });
    add({
      id: 'rel_cross_org',
      targetId: 'seq_FOREIGN1',
      url: 'https://benchling.com/another-lab/f/lib_FOREIGN1-foreign/seq_FOREIGN1-foreign/edit',
    });
    add({
      id: 'rel_query',
      targetId: 'seq_QUERY001',
      url: `${ORGANIZATION_BASE_URL}/f/lib_INVALID1-invalid/seq_QUERY001-query/edit?tab=sequence`,
    });
    add({
      id: 'rel_two_urls',
      targetId: 'seq_TWOURLS',
      url: `${ORGANIZATION_BASE_URL}/f/lib_INVALID2-invalid/seq_TWOURLS-first/edit`,
      evidenceUrl: `${ORGANIZATION_BASE_URL}/f/lib_INVALID2-invalid/seq_TWOURLS-second/edit`,
    });
    add({
      id: 'rel_conflict_a',
      targetId: 'seq_CONFLICT',
      url: `${ORGANIZATION_BASE_URL}/f/lib_CONFLICT-one/seq_CONFLICT-item/edit`,
    });
    add({
      id: 'rel_conflict_b',
      targetId: 'seq_CONFLICT',
      url: `${ORGANIZATION_BASE_URL}/f/lib_CONFLICT-two/seq_CONFLICT-item/edit`,
    });
    add({
      id: 'rel_folder_conflict_a',
      targetId: 'seq_FOLDER01',
      url: `${ORGANIZATION_BASE_URL}/f/lib_RENAMED1-old-name/seq_FOLDER01-item/edit`,
    });
    add({
      id: 'rel_folder_conflict_b',
      targetId: 'seq_FOLDER02',
      url: `${ORGANIZATION_BASE_URL}/f/lib_RENAMED1-new-name/seq_FOLDER02-item/edit`,
    });
    add({
      id: 'rel_tampered_resolution',
      targetId: 'seq_TAMPER01',
      url: `${ORGANIZATION_BASE_URL}/f/lib_INVALID3-invalid/seq_TAMPER01-item/edit`,
    });
    resolutions[resolutions.length - 1] = {
      ...resolutions[resolutions.length - 1],
      sourceObjectId: 'etr_DIFFERENT',
    };

    const evidence = buildLinkedItemRecoveryEvidence({
      run: makeLocalZipRun(),
      sourceObjects: [makeSourceObject('etr_SOURCE01', relationships)],
      resolutions,
    });

    expect(evidence).toMatchObject({
      organizationBaseUrl: ORGANIZATION_BASE_URL,
      relationshipCount: 2,
      uniqueTargetCount: 2,
      folderCount: 1,
    });
    expect(evidence?.targets.map((target) => target.sourceId).sort()).toEqual([
      'prt_VALID002',
      'seq_VALID001',
    ]);
    expect(evidence?.targets.find((target) => target.sourceId === 'seq_VALID001')?.name).toBe(
      'Entry with seq LOOKALIKE name'
    );
  });

  it('plans an unresolved notebook-entry reference as an exact recovery target', () => {
    const targetUrl = `${ORGANIZATION_BASE_URL}/f/lib_NOTEBOOK-notebooks/etr_LINKED01-linked-notebook/edit`;
    const relationship = makeRelationship('rel_notebook', 'etr_LINKED01', targetUrl);

    const evidence = buildLinkedItemRecoveryEvidence({
      run: makeLocalZipRun(),
      sourceObjects: [makeSourceObject('etr_SOURCE01', [relationship])],
      resolutions: [makeUnresolvedResolution(relationship)],
    });

    expect(evidence?.targets).toEqual([
      expect.objectContaining({
        sourceId: 'etr_LINKED01',
        name: 'Linked notebook',
        sourceUrl: targetUrl,
        folderId: 'lib_NOTEBOOK',
        recovered: false,
      }),
    ]);
    expect(resolveLinkedItemRecoveryLocation(evidence!, 'target', 'etr_LINKED01')).toBe(targetUrl);
  });

  it('fails closed when two organizations have equal recovery authority or the run is not a local ZIP', () => {
    const first = makeRelationship(
      'rel_org_a',
      'seq_ORG0001',
      `${ORGANIZATION_BASE_URL}/f/lib_ORG00001-a/seq_ORG0001-a/edit`
    );
    const second = makeRelationship(
      'rel_org_b',
      'seq_ORG0002',
      'https://benchling.com/other/f/lib_ORG00002-b/seq_ORG0002-b/edit'
    );
    const sourceObjects = [makeSourceObject('etr_SOURCE01', [first, second])];
    const resolutions = [makeUnresolvedResolution(first), makeUnresolvedResolution(second)];

    expect(
      buildLinkedItemRecoveryEvidence({
        run: makeLocalZipRun(),
        sourceObjects,
        resolutions,
      })
    ).toBeNull();
    expect(
      buildLinkedItemRecoveryEvidence({
        run: makeLocalZipRun({ localExportArtifact: undefined }),
        sourceObjects,
        resolutions,
      })
    ).toBeNull();
    expect(
      buildLinkedItemRecoveryEvidence({
        run: makeLocalZipRun({
          localExportArtifact: {
            ...makeLocalZipRun().localExportArtifact!,
            archive: null,
          },
        }),
        sourceObjects,
        resolutions,
      })
    ).toBeNull();
  });
});

function makeLocalZipRun(overrides: Partial<MigrationRun> = {}): MigrationRun {
  return {
    version: 1,
    id: 'run-local-zip',
    workspaceId: 'workspace-local-zip',
    workspacePath: '/tmp/workspace-local-zip',
    displayName: 'Benchling ZIP migration',
    scope: {
      version: 1,
      kind: 'file',
      acquisition: 'local_bundle',
      source: {
        id: 'local-export-run-local-zip',
        url: 'dnaforge-local-export://run-local-zip',
      },
    },
    binding: null,
    state: 'validating',
    resumeState: null,
    attempt: 1,
    converterVersions: { app: '0.7.14', bundle: '1', projection: '1', notebook: '1' },
    createdAt: '2026-08-13T17:00:00.000Z',
    updatedAt: '2026-08-13T17:01:00.000Z',
    startedAt: '2026-08-13T17:00:01.000Z',
    unlockedAt: null,
    lastError: null,
    localExportArtifact: {
      schema: 'dnaforge.benchling.local-export-artifact.v1',
      format: 'zip',
      logicalFilename: 'original-export.zip',
      sha256: `sha256:${'a'.repeat(64)}`,
      sizeBytes: 28_000_000,
      immutableLocalPath: '/tmp/archive/original-export.zip',
      capturedAt: '2026-08-13T17:00:00.000Z',
      archive: {
        entryCount: 100,
        totalCompressedEntryBytes: 20_000_000,
        totalUncompressedEntryBytes: 40_000_000,
      },
      resources: [],
    },
    ...overrides,
  };
}

function makeSourceObject(id: string, relationships: SourceRelationship[]): SourceObject {
  return {
    id,
    stableId: id,
    sourceType: id.startsWith('seq_')
      ? 'dna_sequence'
      : id.startsWith('prt_')
        ? 'protocol'
        : 'notebook_entry',
    name: id,
    aliases: [],
    sourceUrl: `dnaforge-local-export://run-local-zip/${id}`,
    attachmentHashes: [],
    memberships: [],
    metadata: {},
    content: {},
    relationships,
  };
}

function makeRelationship(
  id: string,
  targetSourceId: string,
  targetUrl: string,
  evidenceUrl = targetUrl
): SourceRelationship {
  return {
    id,
    sourceObjectId: 'etr_SOURCE01',
    targetSourceId,
    targetUrl,
    relationType: 'embedded_entry_reference',
    direction: 'outbound',
    evidence: [
      { kind: 'stable_id', value: targetSourceId },
      { kind: 'url', value: evidenceUrl },
    ],
  };
}

function makeUnresolvedResolution(relationship: SourceRelationship): RelationshipResolution {
  return {
    relationshipId: relationship.id,
    sourceObjectId: relationship.sourceObjectId,
    targetSourceId: relationship.targetSourceId ?? null,
    relationType: relationship.relationType ?? 'generic',
    classification: 'unresolved',
    evidence: relationship.evidence.map((item) => ({ ...item })),
    candidateSourceIds: [],
    requiresTargetedRead: false,
    reason: 'The exact related item is not present in the selected ZIP.',
  };
}

function buildAuditedTopologyFixture(): {
  sourceObjects: SourceObject[];
  resolutions: RelationshipResolution[];
  targetUrls: Map<string, string>;
} {
  const groups = [
    {
      folderId: 'lib_DEMOLB05',
      folderSlug: 'plasmid-sequencing-results',
      targetIds: [
        'seq_DEMOSQ01',
        ...Array.from(
          { length: 25 },
          (_, index) => `seq_PLSM${String(index + 2).padStart(3, '0')}`
        ),
      ],
      duplicateTargetId: 'seq_DEMOSQ01',
      targetSlug: (index: number) => `plasmid-sequencing-result-${index + 1}`,
    },
    {
      folderId: 'lib_DEMOLB03',
      folderSlug: 'protocols',
      targetIds: [
        'prt_DEMOPR01',
        ...Array.from(
          { length: 4 },
          (_, index) => `prt_PROTOCOL${String(index + 2).padStart(3, '0')}`
        ),
      ],
      duplicateTargetId: 'prt_DEMOPR01',
      targetSlug: (index: number) => `protocol-${index + 1}`,
    },
    {
      folderId: 'lib_DEMOLB04',
      folderSlug: 'test-primers',
      targetIds: Array.from(
        { length: 4 },
        (_, index) => `seq_PRIMER${String(index + 1).padStart(3, '0')}`
      ),
      duplicateTargetId: null,
      targetSlug: (index: number) => `primer-${index + 1}`,
    },
    {
      folderId: 'lib_DEMOLB07',
      folderSlug: 'example-assembly-demo',
      targetIds: ['seq_ASSEMBLY001', 'seq_ASSEMBLY002'],
      duplicateTargetId: null,
      targetSlug: (index: number) => `assembly-${index + 1}`,
    },
    {
      folderId: 'lib_DEMOLB01',
      folderSlug: 'wild-types',
      targetIds: ['seq_WILDTYPE01', 'prtn_WILDTYPE02'],
      duplicateTargetId: null,
      targetSlug: (index: number) => `wild-type-${index + 1}`,
    },
  ] as const;
  const relationships: SourceRelationship[] = [];
  const resolutions: RelationshipResolution[] = [];
  const targetUrls = new Map<string, string>();
  let relationshipNumber = 0;
  for (const group of groups) {
    group.targetIds.forEach((targetId, index) => {
      const targetUrl = `${ORGANIZATION_BASE_URL}/f/${group.folderId}-${group.folderSlug}/${targetId}-${group.targetSlug(index)}/edit`;
      targetUrls.set(targetId, targetUrl);
      const copies = targetId === group.duplicateTargetId ? 2 : 1;
      for (let copy = 0; copy < copies; copy += 1) {
        relationshipNumber += 1;
        const relationship = makeRelationship(
          `rel_${String(relationshipNumber).padStart(3, '0')}`,
          targetId,
          targetUrl
        );
        relationships.push(relationship);
        resolutions.push(makeUnresolvedResolution(relationship));
      }
    });
  }
  return {
    sourceObjects: [makeSourceObject('etr_SOURCE01', relationships)],
    resolutions,
    targetUrls,
  };
}

function makeAttempt(
  overrides: Partial<ValidationLinkedItemRecoveryAttemptEvidence>
): ValidationLinkedItemRecoveryAttemptEvidence {
  return {
    attemptId: 'attempt-1',
    selectedFileCount: 1,
    acceptedFileCount: 1,
    duplicateFileCount: 0,
    rejectedFileCount: 0,
    recoveredTargetCount: 0,
    repairedRelationshipCount: 0,
    outcome: 'partial',
    completedAt: '2026-08-13T18:00:00.000Z',
    ...overrides,
  };
}
