import { computeChecksum } from '@waypoint/sequence-utils';
import { describe, expect, it } from 'vitest';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import type { DBCatalogEntityEvent } from '../../db/workspace-catalog';
import type { AcceptedAssemblySidecarPayload } from './accepted-types';
import { computeAcceptedDraftChecksum } from './accepted-canonical';
import {
  resolveAcceptedAssemblyRecord,
  type AcceptedRecordReaderDeps,
} from './accepted-record-reader';

describe('accepted assembly record reader', () => {
  it('resolves a construct binding, verifies the exact accepted version, and checks product bytes', async () => {
    const product = 'LOCUS       pConstruct 4 bp DNA circular\nORIGIN\n        1 atgc\n//\n';
    const checksum = await computeChecksum(product);
    const accepted = await createAcceptedRecord(checksum);
    const meta = serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: 'construct-1',
        name: 'pConstruct',
        product: { file: 'pConstruct.gb', genBankChecksum: checksum },
        assembly: { accepted: accepted as unknown as Record<string, unknown> },
      })
    );
    const files = new Map([
      ['/workspace/pConstruct/.forge/plasmid.json', meta],
      ['/workspace/pConstruct/pConstruct.gb', product],
    ]);
    const deps = createDeps(files);

    const result = await resolveAcceptedAssemblyRecord(
      { constructId: 'construct-1', acceptedAssemblyVersionId: 'accepted-1' },
      deps
    );

    expect(result).toMatchObject({
      constructId: 'construct-1',
      packageId: 'construct-1',
      packageRoot: '/workspace/pConstruct',
      productPath: '/workspace/pConstruct/pConstruct.gb',
      acceptedAssemblyVersionId: 'accepted-1',
      integrity: {
        productGenBank: 'verified',
        expectedChecksum: checksum,
        actualChecksum: checksum,
      },
    });
    expect(result.catalogEvents).toEqual([
      expect.objectContaining({
        eventType: 'assembly_finalized',
        payload: { accepted: 'accepted-1' },
      }),
    ]);
  });

  it('reopens a legacy package identified by its accepted version, not its design ID', async () => {
    const product = 'LOCUS       pConstruct 4 bp DNA circular\nORIGIN\n        1 atgc\n//\n';
    const checksum = await computeChecksum(product);
    const accepted = await createAcceptedRecord(checksum);
    const meta = serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: 'accepted-1',
        name: 'pConstruct',
        product: { file: 'pConstruct.gb', genBankChecksum: checksum },
        assembly: { accepted: accepted as unknown as Record<string, unknown> },
      })
    );
    const deps = createDeps(
      new Map([
        ['/workspace/pConstruct/.forge/plasmid.json', meta],
        ['/workspace/pConstruct/pConstruct.gb', product],
      ])
    );

    const result = await resolveAcceptedAssemblyRecord(
      { locator: '/workspace/pConstruct/.forge/plasmid.json' },
      deps
    );
    expect(result).toMatchObject({
      constructId: 'accepted-1',
      packageId: 'accepted-1',
      acceptedAssemblyVersionId: 'accepted-1',
      integrity: { productGenBank: 'verified' },
    });

    const foreignMeta = serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: 'foreign-package',
        name: 'pConstruct',
        product: { file: 'pConstruct.gb' },
        assembly: { accepted: accepted as unknown as Record<string, unknown> },
      })
    );
    await expect(
      resolveAcceptedAssemblyRecord(
        { locator: '/workspace/pConstruct/.forge/plasmid.json' },
        createDeps(new Map([['/workspace/pConstruct/.forge/plasmid.json', foreignMeta]]))
      )
    ).rejects.toThrow(/construct identity/i);
  });

  it('refuses a requested accepted version that does not match the package record', async () => {
    const product = 'LOCUS       pConstruct 4 bp DNA circular\nORIGIN\n        1 atgc\n//\n';
    const checksum = await computeChecksum(product);
    const accepted = await createAcceptedRecord(checksum);
    const meta = serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: 'construct-1',
        name: 'pConstruct',
        product: { file: 'pConstruct.gb', genBankChecksum: checksum },
        assembly: { accepted: accepted as unknown as Record<string, unknown> },
      })
    );

    await expect(
      resolveAcceptedAssemblyRecord(
        { constructId: 'construct-1', acceptedAssemblyVersionId: 'accepted-other' },
        createDeps(
          new Map([
            ['/workspace/pConstruct/.forge/plasmid.json', meta],
            ['/workspace/pConstruct/pConstruct.gb', product],
          ])
        )
      )
    ).rejects.toThrow(/version mismatch/i);
  });

  it('recomputes the frozen recipe checksum and rejects tampered accepted history', async () => {
    const product = 'LOCUS       pConstruct 4 bp DNA circular\nORIGIN\n        1 atgc\n//\n';
    const checksum = await computeChecksum(product);
    const accepted = await createAcceptedRecord(checksum);
    accepted.projectionInput.regions[0].sequence = 'AAAA';
    const meta = serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: 'construct-1',
        name: 'pConstruct',
        product: { file: 'pConstruct.gb' },
        assembly: { accepted: accepted as unknown as Record<string, unknown> },
      })
    );
    await expect(
      resolveAcceptedAssemblyRecord(
        { constructId: 'construct-1' },
        createDeps(
          new Map([
            ['/workspace/pConstruct/.forge/plasmid.json', meta],
            ['/workspace/pConstruct/pConstruct.gb', product],
          ])
        )
      )
    ).rejects.toThrow(/canonical draft checksum/i);
  });

  it('selects an older append-only accepted version after restart', async () => {
    const product = 'LOCUS       pConstruct 4 bp DNA circular\nORIGIN\n        1 atgc\n//\n';
    const checksum = await computeChecksum(product);
    const prior = await createAcceptedRecord(checksum);
    prior.acceptedAssemblyVersionId = 'accepted-prior';
    const current = structuredClone(prior);
    current.acceptedAssemblyVersionId = 'accepted-current';
    const meta = serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: 'construct-1',
        name: 'pConstruct',
        product: { file: 'pConstruct.gb' },
        assembly: {
          history: [prior as unknown as Record<string, unknown>],
          accepted: current as unknown as Record<string, unknown>,
        },
      })
    );
    const deps = createDeps(
      new Map([
        ['/workspace/pConstruct/.forge/plasmid.json', meta],
        ['/workspace/pConstruct/pConstruct.gb', product],
      ])
    );
    deps.findConstructIdForAcceptedVersion = async (id) =>
      id === 'accepted-prior' ? 'construct-1' : null;

    const result = await resolveAcceptedAssemblyRecord(
      { acceptedAssemblyVersionId: 'accepted-prior' },
      deps
    );
    expect(result).toMatchObject({
      acceptedAssemblyVersionId: 'accepted-prior',
      recordIsCurrent: false,
      integrity: { productGenBank: 'historical' },
    });
    expect(result.acceptedRecords).toHaveLength(2);
  });

  it('rejects foreign locators before reading their package metadata', async () => {
    const deps = createDeps(new Map());
    let reads = 0;
    deps.readTextFile = async () => {
      reads++;
      throw new Error('must not read');
    };
    await expect(
      resolveAcceptedAssemblyRecord({ locator: '/foreign/pConstruct' }, deps)
    ).rejects.toThrow(/outside the active writable project/i);
    expect(reads).toBe(0);
  });
});

function createDeps(files: Map<string, string>): AcceptedRecordReaderDeps {
  const event: DBCatalogEntityEvent = {
    id: 'event-1',
    entity_id: 'construct-1',
    event_type: 'assembly_finalized',
    actor: 'agent',
    summary: 'Finalized',
    payload: JSON.stringify({ accepted: 'accepted-1' }),
    created_at: 1,
  };
  return {
    getCurrentBinding: async (id) =>
      id === 'construct-1'
        ? { path: '/workspace/pConstruct', file_kind: 'waypoint-plasmid' }
        : null,
    getEntityByLocator: async () => null,
    getEvents: async () => [event],
    exists: async (path) => files.has(path),
    readTextFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing: ${path}`);
      return value;
    },
    findMetaPathForAcceptedVersion: () => null,
    findConstructIdForAcceptedVersion: async () => null,
    workspaceRoots: () => ['/workspace'],
    validateWorkspacePath: async ({ workspaceRoot, path }) =>
      path === workspaceRoot || path.startsWith(`${workspaceRoot}/`),
  };
}

async function createAcceptedRecord(
  productGenBankChecksum: string
): Promise<AcceptedAssemblySidecarPayload> {
  const projectionInput = {
    schemaVersion: 1 as const,
    designId: 'construct-1',
    designName: 'pConstruct',
    topology: 'circular' as const,
    assemblyMethod: 'gibson' as const,
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    productSequence: 'ATGC',
    regions: [
      {
        id: 'insert-1',
        sourceSequenceId: 'source-1',
        sourceSequenceName: 'Source',
        sourceType: 'pcr' as const,
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
        sourceType: 'pcr' as const,
        sourceSequenceId: 'source-1',
        sourceSequenceName: 'Source',
        sourceSequenceChecksum: 'sha256:source',
        copiedDirection: 'forward' as const,
        selectedSourceRange: { start: 0, end: 4 },
        includedSourceSegments: [{ start: 0, end: 4, role: 'included-template' as const }],
        sourceAnnotations: [],
        copiedAnnotations: [],
      },
    ],
  };
  const canonicalDraftChecksum = await computeAcceptedDraftChecksum(projectionInput);
  return {
    type: 'accepted_assembly',
    schemaVersion: 1,
    acceptedAssemblyVersionId: 'accepted-1',
    lifecycleState: 'written',
    acceptedAt: '2026-08-05T18:00:00.000Z',
    designId: 'construct-1',
    designName: 'pConstruct',
    construction: {
      method: 'gibson',
      topology: 'circular',
      canonicalDraftChecksum,
      regionCount: 1,
      spacerCount: 0,
    },
    projectionInput: { ...projectionInput, canonicalDraftChecksum },
    validationSnapshot: {
      schemaVersion: 1,
      designId: 'construct-1',
      designVersion: 5,
      assemblyMethod: 'gibson',
      projectionInputChecksum: canonicalDraftChecksum,
      validatedAt: '2026-08-05T17:59:00.000Z',
      clean: true,
      issues: [],
    },
    artifacts: {
      productGenBankPath: 'pConstruct.gb',
      sidecarJsonPath: '.forge/plasmid.json',
      primerCsvPath: 'primers/pConstruct.primers.csv',
      primerFastaPath: 'primers/pConstruct.primers.fasta',
      productSequenceChecksum: 'sha256:product',
      productGenBankChecksum,
      primerCsvChecksum: 'sha256:csv',
      primerFastaChecksum: 'sha256:fasta',
      canonicalDraftChecksum,
    },
  };
}
