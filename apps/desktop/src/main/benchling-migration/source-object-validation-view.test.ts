import { describe, expect, it } from 'vitest';

import type { ProjectionReceipt, SourceObject } from '../../shared/benchling-migration';
import { sourceObjectValidationView } from './source-object-validation-view';
import { collectProjectionFormulaEvidence } from './formula-evidence';
import { buildProjectionPlan } from './projection';
import { generateValidationReport, type GenerateValidationReportInput } from './validation';

describe('sourceObjectValidationView', () => {
  it('retains exact formula evidence while releasing notebook and structured table payloads', () => {
    const source: SourceObject = {
      id: 'etr_FORMULA1',
      stableId: 'etr_FORMULA1',
      sourceType: 'notebook_entry',
      name: 'Saved results',
      aliases: [],
      sourceUrl: 'https://benchling.com/example/etr_FORMULA1',
      attachmentHashes: [],
      memberships: [],
      relationships: [],
      metadata: { formula: '=SUM(A1:A2)' },
      content: {
        html:
          '<p>large body</p>'.repeat(10_000) +
          '<table><tr><td data-formula="=BENCHLING_ONLY(A1)">42</td></tr></table>',
        tables: [
          {
            cells: [
              [
                {
                  type: 'formula',
                  value: '=OTHER(A1)',
                  computed: 7,
                  formulaCompatibility: 'unsupported',
                  stale: true,
                },
              ],
            ],
          },
        ],
      },
    };
    const expected = collectProjectionFormulaEvidence(source);
    expect(expected).toHaveLength(3);
    const view = sourceObjectValidationView(source);
    expect(collectProjectionFormulaEvidence(view)).toEqual(expected);
    expect(collectProjectionFormulaEvidence(sourceObjectValidationView(view))).toEqual(expected);
    expect(view.content).toEqual({ html: '' });
    expect(JSON.stringify(view).length).toBeLessThan(2_000);

    const input = formulaReportInput(source);
    const original = generateValidationReport(input).formulas;
    const compacted = generateValidationReport({ ...input, sourceObjects: [view] }).formulas;
    expect(compacted).toEqual(original);
    expect(compacted).toMatchObject({ expected: 3, actual: 3, supported: 1, unsupported: 2 });
    expect(compacted.issues.every((issue) => !issue.blocking)).toBe(true);
    const missingReceipt = generateValidationReport({
      ...input,
      sourceObjects: [view],
      receipts: [],
    }).formulas;
    expect(missingReceipt).toMatchObject({ expected: 3, actual: 0 });
    expect(missingReceipt.issues.some((issue) => issue.blocking)).toBe(true);
  });

  it('keeps validation evidence without retaining large scientific payloads', () => {
    const source: SourceObject = {
      id: 'seq_large',
      stableId: 'seq_large',
      sourceType: 'dna_sequence',
      name: 'Large sequence',
      registryId: 'REG-1',
      aliases: ['alias'],
      sourceUrl: 'https://benchling.example/seq_large',
      sourcePath: 'Registry/Large sequence.gb',
      attachmentHashes: [`sha256:${'b'.repeat(64)}`],
      memberships: ['folder-1'],
      createdAt: '2026-08-26T00:00:00.000Z',
      modifiedAt: '2026-08-26T01:00:00.000Z',
      metadata: {
        nativeExport: { primaryRepresentation: 'genbank' },
      },
      content: {
        kind: 'dna_sequence',
        bases: 'A'.repeat(5_000_000),
        annotations: Array.from({ length: 100 }, (_, index) => ({ index, label: 'large' })),
        html: '<p>large notebook body</p>'.repeat(1_000),
        attachments: [{ path: 'large.bin', bytes: 'x'.repeat(100_000) }],
        mediaType: 'text/plain',
        sha256: `sha256:${'a'.repeat(64)}`,
        sizeBytes: 5_000_000,
        rawAccess: {
          archivePartId: 'part-1',
          entryPath: 'Registry/Large sequence (seq_large).gb',
        },
      },
      relationships: [
        {
          id: 'relationship-1',
          sourceObjectId: 'seq_large',
          targetSourceId: 'seq_target',
          relationType: 'references',
          direction: 'outbound',
          evidence: [
            {
              kind: 'stable_id',
              value: 'seq_target',
              sourcePath: 'metadata.related',
            },
          ],
        },
      ],
    };

    const view = sourceObjectValidationView(source);

    expect(view).toMatchObject({
      id: source.id,
      stableId: source.stableId,
      sourceType: source.sourceType,
      name: source.name,
      registryId: source.registryId,
      aliases: source.aliases,
      sourceUrl: source.sourceUrl,
      sourcePath: source.sourcePath,
      attachmentHashes: source.attachmentHashes,
      memberships: source.memberships,
      createdAt: source.createdAt,
      modifiedAt: source.modifiedAt,
      metadata: source.metadata,
      relationships: source.relationships,
      content: {
        html: '',
        attachments: [],
        mediaType: 'text/plain',
        sha256: `sha256:${'a'.repeat(64)}`,
        sizeBytes: 5_000_000,
        rawAccess: {
          archivePartId: 'part-1',
          entryPath: 'Registry/Large sequence (seq_large).gb',
        },
      },
    });
    expect(view.content).not.toHaveProperty('bases');
    expect(view.content).not.toHaveProperty('annotations');
    expect(JSON.stringify(view).length).toBeLessThan(2_000);
  });

  it('preserves invalid content shapes so validation still fails closed', () => {
    const source = {
      id: 'etr_invalid',
      stableId: 'etr_invalid',
      sourceType: 'notebook_entry',
      name: 'Invalid notebook',
      aliases: [],
      sourceUrl: 'https://benchling.example/etr_invalid',
      attachmentHashes: [],
      memberships: [],
      metadata: {},
      content: 'not-an-object',
      relationships: [],
    } satisfies SourceObject;

    expect(sourceObjectValidationView(source).content).toBe('not-an-object');
  });
});

function formulaReportInput(source: SourceObject): GenerateValidationReportInput {
  const at = '2026-08-30T00:00:00.000Z';
  const plan = buildProjectionPlan(source, {
    runId: 'formula-run',
    capturedAt: at,
    converterVersion: 'test',
  });
  const receipt: ProjectionReceipt = {
    id: 'formula-receipt',
    runId: 'formula-run',
    sourceObjectId: source.id,
    destinationObjectId: plan.destinationObjectId,
    destinationPath: 'Notebook/.forge/notebook.json',
    projection: plan.projection,
    converterId: plan.converterId,
    converterVersion: plan.converterVersion,
    sourceHash: plan.sourceHash,
    destinationHash: plan.destinationHash,
    warnings: plan.warnings,
    exception: plan.exception,
    formulaEvidence: plan.formulaEvidence,
    createdAt: at,
  };
  return {
    run: {
      version: 1,
      id: 'formula-run',
      workspaceId: 'formula-workspace',
      workspacePath: '/tmp/formula-workspace',
      displayName: 'Formula import',
      scope: {
        version: 1,
        kind: 'file',
        source: {
          id: source.id,
          url: source.sourceUrl,
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
      id: 'formula-snapshot',
      runId: 'formula-run',
      accountHash: 'account',
      createdAt: at,
      archiveManifestId: 'manifest',
      initialSourceObjectIds: [source.id],
      expectedSourceObjectCount: 1,
      expectedAttachmentCount: 0,
      expectedMembershipCount: 0,
      parts: [],
    },
    sourceObjects: [source],
    receipts: [receipt],
    archiveIntegrity: { manifestEntries: [], snapshotParts: [] },
    exportJobs: [],
    exportCaptures: [],
    exportInspections: [],
    exportJobReplacements: [],
    collectionProjection: null,
    scopedFolders: [],
    expectedRenderObjectIds: [],
    renderChecks: [],
    resolutions: [],
  };
}
