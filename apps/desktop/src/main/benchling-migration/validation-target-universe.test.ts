import { describe, expect, it } from 'vitest';
import type { RelationshipResolution, SourceObject } from '../../shared/benchling-migration';
import { attachStrainRelationships } from './strain-relationship-resolver';
import { resolveOfflineRelationships } from './relationship-resolver';
import { generateValidationReport, type GenerateValidationReportInput } from './validation';

const at = '2026-11-02T00:00:00.000Z';

function object(
  stableId: string,
  sourceType: SourceObject['sourceType'],
  name: string
): SourceObject {
  return {
    id: stableId,
    stableId,
    sourceType,
    name,
    aliases: [],
    sourceUrl: `urn:dnaforge:test:${stableId}`,
    attachmentHashes: [],
    memberships: [],
    metadata: {},
    content: {},
    relationships: [],
  };
}

function fixture(duplicate: boolean, targetInitiallyPresent = false) {
  const owner = object('bfi_OWNER01', 'strain', 'Owned strain');
  owner.content = {
    kind: 'benchling_strain',
    displayName: owner.name,
    fields: [{ label: 'Plasmid', value: 'Exact named DNA', position: 0 }],
  };
  const target = object('seq_TARGET1', 'dna_sequence', 'Exact named DNA');
  const twin = object('seq_TARGET2', 'dna_sequence', 'Exact named DNA');
  const sources = attachStrainRelationships([owner, target, ...(duplicate ? [twin] : [])]);
  const initialIds = [owner.id, ...(targetInitiallyPresent ? [target.id] : [])];
  return { sources, initialIds, owner, target, twin };
}

function resolve(sources: SourceObject[]): RelationshipResolution[] {
  return resolveOfflineRelationships({
    sourceObjects: sources,
    relationships: sources.flatMap((source) => source.relationships),
    selectedSnapshotStableIdsAreAuthoritative: true,
  }).resolutions;
}

function input(
  sources: SourceObject[],
  initialIds: string[],
  resolutions = resolve(sources)
): GenerateValidationReportInput {
  const supplementary = sources.filter((source) => !initialIds.includes(source.id));
  return {
    run: {
      version: 1,
      id: 'target-universe-run',
      workspaceId: 'target-universe-workspace',
      workspacePath: '/tmp/target-universe-workspace',
      displayName: 'Target universe',
      scope: {
        version: 1,
        kind: 'file',
        acquisition: 'local_bundle',
        source: {
          id: 'local-export-target-universe',
          url: 'urn:dnaforge:local-export',
          objectType: 'notebook_entry',
        },
      },
      binding: null,
      state: 'validating',
      resumeState: null,
      attempt: 1,
      converterVersions: {},
      createdAt: at,
      updatedAt: at,
      startedAt: at,
      unlockedAt: null,
      lastError: null,
    },
    snapshot: {
      version: 1,
      id: 'target-universe-snapshot',
      runId: 'target-universe-run',
      accountHash: 'synthetic-account',
      createdAt: at,
      archiveManifestId: 'manifest',
      initialSourceObjectIds: initialIds,
      expectedSourceObjectCount: initialIds.length,
      expectedAttachmentCount: 0,
      expectedMembershipCount: 0,
      parts: supplementary.map((source) => ({
        id: `part-${source.id}`,
        kind: 'supplemental_local_export',
        sha256: `sha256:${'a'.repeat(64)}`,
        sizeBytes: 1,
        capturedAt: at,
        sourceJobId: null,
        sourceObjectId: source.id,
        supersedesPartId: null,
      })),
    },
    sourceObjects: sources,
    receipts: [],
    archiveIntegrity: { manifestEntries: [], snapshotParts: [] },
    exportJobs: [],
    exportCaptures: [],
    exportInspections: [],
    exportJobReplacements: [],
    collectionProjection: null,
    scopedFolders: [],
    expectedRenderObjectIds: [],
    renderChecks: [],
    resolutions,
  };
}

describe('relationship owner scope and complete captured target universe', () => {
  it('validates a primary audited-name strain link to its unique supplemental target', () => {
    const f = fixture(false);
    const resolutions = resolve(f.sources);
    expect(resolutions).toMatchObject([{ classification: 'exact', targetSourceId: f.target.id }]);
    const relationships = generateValidationReport(
      input(f.sources, f.initialIds, resolutions)
    ).relationships;
    expect(relationships).toMatchObject({ expected: 1, actual: 1, passed: true });
    expect(relationships.issues.filter((issue) => issue.blocking)).toEqual([]);
  });

  it('does not accept a stale exact name binding when a supplemental same-name twin arrives', () => {
    const before = fixture(false, true);
    const stale = resolve(before.sources);
    const after = fixture(true, true);
    expect(resolve(after.sources)).toMatchObject([
      { classification: 'ambiguous', targetSourceId: null },
    ]);
    const relationships = generateValidationReport(
      input(after.sources, after.initialIds, stale)
    ).relationships;
    expect(relationships.passed).toBe(false);
    expect(
      relationships.issues.some((issue) => issue.blocking && issue.code === 'internal_invariant')
    ).toBe(true);
  });

  it('keeps an ambiguous name blocking rather than choosing either supplemental twin', () => {
    const f = fixture(true);
    const resolutions = resolve(f.sources);
    expect(resolutions).toMatchObject([{ classification: 'ambiguous', targetSourceId: null }]);
    const relationships = generateValidationReport(
      input(f.sources, f.initialIds, resolutions)
    ).relationships;
    expect(relationships).toMatchObject({ expected: 1, actual: 1, passed: false });
    expect(
      relationships.issues.some((issue) => issue.blocking && issue.code === 'validation_failed')
    ).toBe(true);
  });

  it('keeps supplemental relationships outside the primary owner validation scope', () => {
    const f = fixture(false);
    f.sources[1].relationships = [
      {
        id: 'supplemental-outbound',
        sourceObjectId: f.target.id,
        targetSourceId: 'seq_ABSENT1',
        relationType: 'references',
        direction: 'outbound',
        evidence: [{ kind: 'stable_id', value: 'seq_ABSENT1' }],
      },
    ];
    const relationships = generateValidationReport(input(f.sources, f.initialIds)).relationships;
    expect(relationships).toMatchObject({ expected: 1, actual: 1, passed: true });
    expect(
      relationships.issues.some((issue) => issue.relationshipId === 'supplemental-outbound')
    ).toBe(false);
  });

  it('preserves an explicit stable-ID target despite a same-name supplemental twin', () => {
    const f = fixture(true);
    f.sources[0].relationships[0] = {
      ...f.sources[0].relationships[0],
      targetSourceId: f.target.id,
      evidence: [
        { kind: 'stable_id', value: f.target.id },
        { kind: 'source_type', value: 'sequence' },
      ],
    };
    const resolutions = resolve(f.sources);
    expect(resolutions).toMatchObject([{ classification: 'exact', targetSourceId: f.target.id }]);
    expect(
      generateValidationReport(input(f.sources, f.initialIds, resolutions)).relationships.passed
    ).toBe(true);
  });
});
