// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { AcceptedAssemblySidecarPayload } from './accepted-types';
import { buildAcceptedAssemblyLineage } from './accepted-lineage';

describe('accepted assembly lineage projection', () => {
  it('keeps construct, accepted, product, and exact source versions as distinct typed nodes', () => {
    const lineage = buildAcceptedAssemblyLineage(createAcceptedRecord(), {
      constructId: 'construct-1',
      packageId: 'construct-1',
      packageRoot: '/workspace/pConstruct',
      catalogEvents: [],
    });

    expect(lineage.rootConstructId).toBe('construct-1');
    expect(lineage.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'construct:construct-1', kind: 'construct' }),
        expect.objectContaining({
          id: 'accepted-assembly:accepted-1',
          kind: 'accepted_assembly_version',
          canonicalDraftChecksum: 'sha256:draft',
        }),
        expect.objectContaining({
          id: 'product-sequence:sha256:product',
          kind: 'product_sequence_version',
          checksum: 'sha256:product',
        }),
        expect.objectContaining({
          id: 'source-sequence:source-construct-1:source-version-7',
          kind: 'source_sequence_version',
          constructId: 'source-construct-1',
          versionId: 'source-version-7',
          checksum: 'sha256:source-v7',
          identityStatus: 'stable',
        }),
      ])
    );
    expect(lineage.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'accepted_from_draft',
          from: 'accepted-assembly:accepted-1',
          to: 'draft:design-1:v5',
        }),
        expect.objectContaining({
          kind: 'uses_source_version',
          from: 'accepted-assembly:accepted-1',
          to: 'source-sequence:source-construct-1:source-version-7',
          regionId: 'insert-1',
        }),
        expect.objectContaining({
          kind: 'produces_product_version',
          from: 'accepted-assembly:accepted-1',
          to: 'product-sequence:sha256:product',
        }),
      ])
    );
  });

  it('labels legacy locator-only sources instead of inventing stable identities', () => {
    const record = createAcceptedRecord();
    record.projectionInput.sourceProvenance = [
      {
        ...record.projectionInput.sourceProvenance[0],
        sourceConstructId: undefined,
        sourceSequenceVersionId: undefined,
        sourceLocator: undefined,
      },
    ];

    const lineage = buildAcceptedAssemblyLineage(record, {
      constructId: 'construct-1',
      packageId: 'construct-1',
      packageRoot: '/workspace/pConstruct',
      catalogEvents: [],
    });

    expect(lineage.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'source_sequence_version',
        constructId: null,
        versionId: null,
        sourceSequenceId: '/workspace/sources/source.gb',
        checksum: 'sha256:source-v7',
        identityStatus: 'legacy-locator',
      })
    );
    expect(lineage.warnings).toContainEqual(
      expect.objectContaining({ code: 'legacy_source_identity', regionId: 'insert-1' })
    );
  });

  it('projects append-only accepted history, reopened drafts, and source freshness', () => {
    const prior = createAcceptedRecord();
    const current = structuredClone(prior);
    current.acceptedAssemblyVersionId = 'accepted-2';
    current.artifacts.productSequenceChecksum = 'sha256:product-2';
    const lineage = buildAcceptedAssemblyLineage([prior, current], {
      constructId: 'construct-1',
      packageId: 'construct-1',
      packageRoot: '/workspace/pConstruct',
      currentSourceChecksums: {
        '/workspace/sources/source.gb': 'sha256:newer-source',
      },
      catalogEvents: [
        {
          id: 'event-reopen',
          eventType: 'accepted_assembly_reopened',
          actor: 'agent:test',
          summary: 'Reopened',
          payload: {
            acceptedAssemblyVersionId: 'accepted-1',
            reopenedDesignId: 'draft-reopened',
            draftPath: '/workspace/reopened.wpdesign.json',
            idempotencyKey: 'reopen-once',
          },
          createdAt: 1,
        },
      ],
    });
    expect(lineage.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'accepted-assembly:accepted-1' }),
        expect.objectContaining({ id: 'accepted-assembly:accepted-2' }),
        expect.objectContaining({
          id: 'draft:draft-reopened',
          parentAcceptedAssemblyVersionId: 'accepted-1',
        }),
        expect.objectContaining({ kind: 'source_sequence_version', freshness: 'source_outdated' }),
      ])
    );
    expect(lineage.edges).toContainEqual(
      expect.objectContaining({
        kind: 'reopened_from',
        from: 'draft:draft-reopened',
        to: 'accepted-assembly:accepted-1',
      })
    );
  });
});

function createAcceptedRecord(): AcceptedAssemblySidecarPayload {
  return {
    type: 'accepted_assembly',
    schemaVersion: 1,
    acceptedAssemblyVersionId: 'accepted-1',
    lifecycleState: 'written',
    acceptedAt: '2026-08-05T18:00:00.000Z',
    acceptedBy: 'agent:test',
    designId: 'design-1',
    designName: 'pConstruct',
    construction: {
      method: 'gibson',
      topology: 'circular',
      canonicalDraftChecksum: 'sha256:draft',
      regionCount: 1,
      spacerCount: 0,
    },
    projectionInput: {
      schemaVersion: 1,
      designId: 'design-1',
      designName: 'pConstruct',
      topology: 'circular',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      productSequence: 'ATGC',
      regions: [
        {
          id: 'insert-1',
          sourceSequenceId: '/workspace/sources/source.gb',
          sourceSequenceName: 'Source',
          sourceType: 'pcr',
          sourceStart: 0,
          sourceEnd: 4,
          sequence: 'ATGC',
          annotations: [],
        },
      ],
      spacers: [],
      homologyRegions: [],
      designPrimers: [],
      sourceProvenance: [
        {
          regionId: 'insert-1',
          sourceType: 'pcr',
          sourceSequenceId: '/workspace/sources/source.gb',
          sourceSequenceName: 'Source',
          sourceConstructId: 'source-construct-1',
          sourceSequenceVersionId: 'source-version-7',
          sourceLocator: '/workspace/sources/source.gb',
          sourceSequenceChecksum: 'sha256:source-v7',
          sourceLength: 4,
          sourceIsCircular: false,
          copiedDirection: 'forward',
          selectedSourceRange: { start: 0, end: 4 },
          includedSourceSegments: [{ start: 0, end: 4, role: 'included-template' }],
          sourceAnnotations: [],
          copiedAnnotations: [],
        },
      ],
      canonicalDraftChecksum: 'sha256:draft',
    },
    validationSnapshot: {
      schemaVersion: 1,
      designId: 'design-1',
      designVersion: 5,
      assemblyMethod: 'gibson',
      projectionInputChecksum: 'sha256:draft',
      validatedAt: '2026-08-05T17:59:00.000Z',
      clean: true,
      issues: [],
    },
    artifacts: {
      productGenBankPath: '/workspace/pConstruct/pConstruct.gb',
      sidecarJsonPath: '/workspace/pConstruct/.forge/plasmid.json',
      primerCsvPath: '/workspace/pConstruct/primers/pConstruct.primers.csv',
      primerFastaPath: '/workspace/pConstruct/primers/pConstruct.primers.fasta',
      productSequenceChecksum: 'sha256:product',
      productGenBankChecksum: 'sha256:genbank',
      primerCsvChecksum: 'sha256:csv',
      primerFastaChecksum: 'sha256:fasta',
      canonicalDraftChecksum: 'sha256:draft',
    },
  };
}
