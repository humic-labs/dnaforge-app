// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { SequenceDesign } from '../design/types';
import {
  buildAcceptedAssemblyProjectionInput,
  buildAcceptedAssemblyValidationSnapshot,
  buildSourceProvenanceSnapshot,
} from './accepted-canonical';
import {
  appendAcceptedAssemblyVersionToDesign,
  buildAcceptedAssemblyVersion,
} from './accepted-finalization';

describe('accepted assembly finalization', () => {
  it('builds an immutable accepted version only from the currently validated projection input', async () => {
    const design = createDesign();
    const sourceProvenance = design.regions.map((region) => buildSourceProvenanceSnapshot(region));
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance,
    });
    const validationSnapshot = buildAcceptedAssemblyValidationSnapshot({
      designId: design.id,
      designVersion: design.version,
      assemblyMethod: design.assemblyMethod,
      projectionInputChecksum: projectionInput.canonicalDraftChecksum,
      validatedAt: '2026-05-17T02:00:00.000Z',
    });

    const accepted = await buildAcceptedAssemblyVersion({
      design,
      sourceProvenance,
      validationSnapshot,
      acceptedAt: '2026-05-17T02:01:00.000Z',
      acceptedBy: 'test-user',
      createId: () => 'accepted-1',
    });

    expect(accepted.id).toBe('accepted-1');
    expect(accepted.lifecycleState).toBe('accepted');
    expect(accepted.acceptedAt).toBe('2026-05-17T02:01:00.000Z');
    expect(accepted.acceptedBy).toBe('test-user');
    expect(accepted.canonicalDraftChecksum).toBe(projectionInput.canonicalDraftChecksum);
    expect(accepted.projectionInput).toEqual(projectionInput);
    expect(accepted.validationSnapshot).toEqual(validationSnapshot);
  });

  it('rejects stale validation snapshots by design version and projection checksum', async () => {
    const design = createDesign();
    const sourceProvenance = design.regions.map((region) => buildSourceProvenanceSnapshot(region));
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance,
    });
    const validationSnapshot = buildAcceptedAssemblyValidationSnapshot({
      designId: design.id,
      designVersion: design.version,
      assemblyMethod: design.assemblyMethod,
      projectionInputChecksum: projectionInput.canonicalDraftChecksum,
    });

    await expect(
      buildAcceptedAssemblyVersion({
        design: { ...design, version: design.version + 1 },
        sourceProvenance,
        validationSnapshot,
      })
    ).rejects.toThrow(/current validation snapshot/i);

    await expect(
      buildAcceptedAssemblyVersion({
        design: {
          ...design,
          spacers: [{ id: 'spacer-1', junctionIndex: 0, sequence: 'AAA' }],
        },
        sourceProvenance,
        validationSnapshot,
      })
    ).rejects.toThrow(/current validation snapshot/i);
  });

  it('rejects validation snapshots with errors', async () => {
    const design = createDesign();
    const sourceProvenance = design.regions.map((region) => buildSourceProvenanceSnapshot(region));
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance,
    });
    const validationSnapshot = buildAcceptedAssemblyValidationSnapshot({
      designId: design.id,
      designVersion: design.version,
      assemblyMethod: design.assemblyMethod,
      projectionInputChecksum: projectionInput.canonicalDraftChecksum,
      issues: [{ code: 'bad', severity: 'error', message: 'Nope' }],
    });

    await expect(
      buildAcceptedAssemblyVersion({ design, sourceProvenance, validationSnapshot })
    ).rejects.toThrow(/validation errors/i);
  });

  it('appends accepted versions to design state without discarding prior accepted drafts', async () => {
    const design = createDesign();
    const sourceProvenance = design.regions.map((region) => buildSourceProvenanceSnapshot(region));
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance,
    });
    const validationSnapshot = buildAcceptedAssemblyValidationSnapshot({
      designId: design.id,
      designVersion: design.version,
      assemblyMethod: design.assemblyMethod,
      projectionInputChecksum: projectionInput.canonicalDraftChecksum,
    });
    const first = await buildAcceptedAssemblyVersion({
      design,
      sourceProvenance,
      validationSnapshot,
      createId: () => 'accepted-1',
    });
    const second = { ...first, id: 'accepted-2' };

    const withFirst = appendAcceptedAssemblyVersionToDesign(design, first, {
      updatedAt: new Date('2026-05-17T02:02:00.000Z'),
    });
    const withSecond = appendAcceptedAssemblyVersionToDesign(withFirst, second, {
      updatedAt: new Date('2026-05-17T02:03:00.000Z'),
    });

    expect(withSecond.assemblyState).toBe('assembled');
    expect(withSecond.status).toBe('assembled');
    expect(withSecond.version).toBe(design.version + 2);
    expect(withSecond.activeAcceptedAssemblyVersionId).toBe('accepted-2');
    expect(withSecond.acceptedAssemblyVersions?.map((version) => version.id)).toEqual([
      'accepted-1',
      'accepted-2',
    ]);
    expect(design.acceptedAssemblyVersions).toBeUndefined();
  });

  it('stamps the construct id from the accepted recipe onto a legacy draft', async () => {
    const design = { ...createDesign(), constructId: undefined };
    const sourceProvenance = design.regions.map((region) => buildSourceProvenanceSnapshot(region));
    const projectionInput = await buildAcceptedAssemblyProjectionInput(
      { ...design, constructId: 'construct-9' },
      { sourceProvenance, constructId: 'construct-9' }
    );
    const validationSnapshot = buildAcceptedAssemblyValidationSnapshot({
      designId: design.id,
      designVersion: design.version,
      assemblyMethod: design.assemblyMethod,
      projectionInputChecksum: projectionInput.canonicalDraftChecksum,
    });
    const accepted = await buildAcceptedAssemblyVersion({
      design: { ...design, constructId: 'construct-9' },
      sourceProvenance,
      validationSnapshot,
      createId: () => 'accepted-construct',
    });

    const next = appendAcceptedAssemblyVersionToDesign(design, accepted);
    expect(next.constructId).toBe('construct-9');
    expect(next.id).toBe('design-1');
    expect(accepted.projectionInput.constructId).toBe('construct-9');
  });
});

function createDesign(): SequenceDesign {
  const now = new Date('2026-05-17T00:00:00.000Z');
  return {
    id: 'design-1',
    constructId: 'construct-1',
    name: 'Accepted design',
    topology: 'circular',
    regions: [
      {
        id: 'left',
        sourceSequenceId: 'source-left',
        sourceSequenceName: 'Source left',
        sourceStart: 0,
        sourceEnd: 12,
        sequence: 'ATGCATGCATGC',
        annotations: [],
        sourceType: 'pcr',
      },
      {
        id: 'right',
        sourceSequenceId: 'source-right',
        sourceSequenceName: 'Source right',
        sourceStart: 0,
        sourceEnd: 12,
        sequence: 'GCTAGCTAGCTA',
        annotations: [],
        sourceType: 'pcr',
      },
    ],
    spacers: [],
    version: 3,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}
