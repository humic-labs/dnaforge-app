import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RestrictionEnzyme } from '@waypoint/sequence-utils';
import type { CatalogReferenceCandidate } from '../../db/catalog-reference-search';
import type { GoldenGateAssemblySchema } from './golden-gate-schema';
import { parseMocloKitDefinition } from './moclo-kit-definition';
import {
  analyzeMocloCatalogSource,
  loadMocloCatalogCandidates,
  rankMocloCatalogCandidates,
  mocloCatalogCandidateToRegion,
} from './moclo-part-catalog';

const WORKSPACE = resolve(process.cwd(), 'resources/sample-workspaces/standard-samples/workspace');

function sequencePath(relativePath: string): string {
  return resolve(WORKSPACE, relativePath);
}

function catalogReference(
  relativePath: string,
  name: string,
  entityId = `entity:${name}`
): CatalogReferenceCandidate {
  return {
    entityId,
    name,
    absolutePath: sequencePath(relativePath),
    workspaceRelativePath: relativePath,
    contentHash: `sha256:${name}`,
    objectUuid: `object:${name}`,
    sizeBytes: readFileSync(sequencePath(relativePath)).byteLength,
    sequenceDocument: { kind: 'catalog-sequence', entityId },
  };
}

function managedCatalogReference(
  packageRelativePath: string,
  productFileName: string,
  name: string,
  packageId: string
): CatalogReferenceCandidate {
  const packageRoot = sequencePath(packageRelativePath);
  const productRelativePath = `${packageRelativePath}/${productFileName}`;
  return {
    entityId: packageId,
    name,
    absolutePath: sequencePath(productRelativePath),
    workspaceRelativePath: packageRelativePath,
    contentHash: `sha256:${name}`,
    objectUuid: `object:${name}`,
    sizeBytes: readFileSync(sequencePath(productRelativePath)).byteLength,
    sequenceDocument: { kind: 'managed-sequence', packageId, packageRoot },
  };
}

function ytkDefinition() {
  const path = resolve(WORKSPACE, '.forge/moclo-kits/ytk.json');
  return parseMocloKitDefinition(readFileSync(path, 'utf8'), path);
}

function bsaI(): RestrictionEnzyme {
  const enzymeData = JSON.parse(
    readFileSync(resolve(process.cwd(), 'public/data/rebase/merged-enzymes.json'), 'utf8')
  ) as { enzymes: RestrictionEnzyme[] };
  const enzyme = enzymeData.enzymes.find((candidate) => candidate.name === 'BsaI');
  if (!enzyme) throw new Error('The checked-in REBASE data does not contain BsaI.');
  return enzyme;
}

function schema(): GoldenGateAssemblySchema {
  return {
    id: 'cidar-red-tu',
    name: 'CIDAR red fluorescent transcription unit',
    revision: 1,
    origin: { type: 'kit', kitId: 'moclo-cidar', kitName: 'CIDAR MoClo' },
    enzyme: 'BsaI',
    slots: [
      {
        id: 'rbs',
        label: 'RBS',
        outgoingOverhang: 'AATG',
        preferredRoles: [{ label: 'RBS' }],
      },
      {
        id: 'cds',
        label: 'CDS',
        outgoingOverhang: 'AGGT',
        preferredRoles: [{ label: 'CDS' }],
      },
      {
        id: 'terminator',
        label: 'Terminator',
        outgoingOverhang: 'GCTT',
        preferredRoles: [{ label: 'Terminator' }],
      },
      {
        id: 'vector',
        label: 'Destination vector',
        outgoingOverhang: 'GGAG',
        preferredRoles: [{ label: 'Destination vector' }],
      },
      {
        id: 'promoter',
        label: 'Promoter',
        outgoingOverhang: 'TACT',
        preferredRoles: [{ label: 'Promoter' }],
      },
    ],
  };
}

describe('MoClo catalog candidate discovery', () => {
  it('describes and searches the component without renaming its package or its backbone', () => {
    const reference = managedCatalogReference(
      'sequences/kits/moclo-ytk/pYTK051',
      'pYTK051.gb',
      'pYTK051',
      'sample-6382d54e'
    );
    const candidates = analyzeMocloCatalogSource({
      reference,
      content: readFileSync(reference.absolutePath, 'utf8'),
      enzyme: bsaI(),
      kitDefinitions: [ytkDefinition()],
    });
    const insert = candidates.find((candidate) => candidate.fragment.ggType === 'insert');
    expect(insert?.componentLabel).toEqual({ text: 'ScENO1 Terminator', source: 'annotation' });
    expect(insert?.name).toBe('pYTK051');
    expect(
      candidates.find((candidate) => candidate.fragment.ggType === 'backbone')?.componentLabel
    ).not.toEqual(insert?.componentLabel);
    const found = rankMocloCatalogCandidates({
      candidates,
      schema: schema(),
      slotIndex: 2,
      topology: 'circular',
      query: 'ENO1',
      includePhysicallyIncompatible: true,
    });
    expect(found.map((candidate) => candidate.id)).toEqual([insert?.id]);
    expect(mocloCatalogCandidateToRegion(found[0], 'BsaI').sourceSequenceId).toBe(
      'sample-6382d54e'
    );
  });

  it('retains package identity rather than the file-index UUID when selecting a part', () => {
    const reference = managedCatalogReference(
      'sequences/kits/moclo-ytk/pYTK009',
      'pYTK009.gb',
      'pYTK009',
      'sample-4e461e72'
    );
    const [candidate] = analyzeMocloCatalogSource({
      reference,
      content: readFileSync(reference.absolutePath, 'utf8'),
      enzyme: bsaI(),
    });
    const region = mocloCatalogCandidateToRegion(candidate, 'BsaI');
    expect(region.sourceSequenceId).toBe('sample-4e461e72');
    expect(region.sourceSequenceId).not.toBe(reference.objectUuid);
    expect(region.sourceSequenceName).toBe('pYTK009');
  });
  it('bounds catalog analysis without dropping declared kit members', async () => {
    const definition = ytkDefinition();
    const searchRecentReferences = vi.fn(async () => []);
    const searchPackageReferences = vi.fn(async () => []);
    const dependencies = {
      loadEnzymes: async () => [bsaI()],
      searchRecentReferences,
      searchPackageReferences,
      resolveDocument: vi.fn(),
      readTextFileSlice: vi.fn(),
      cache: new Map(),
    };

    await loadMocloCatalogCandidates(
      {
        workspaceRoot: WORKSPACE,
        enzymeName: 'BsaI',
        kitDefinitions: [definition],
      },
      dependencies
    );

    expect(searchPackageReferences).toHaveBeenCalledWith({
      sequencePackageIds: definition.members.map((member) => member.sequencePackageId),
      workspaceRoot: WORKSPACE,
    });
    expect(searchRecentReferences).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1_000 - definition.members.length })
    );

    const oversized = {
      ...definition,
      members: Array.from({ length: 1_001 }, (_, index) => ({
        id: `member-${index}`,
        name: `Member ${index}`,
        sequencePackageId: `package-${index}`,
      })),
    };
    searchRecentReferences.mockClear();
    searchPackageReferences.mockClear();

    await expect(
      loadMocloCatalogCandidates(
        { workspaceRoot: WORKSPACE, enzymeName: 'BsaI', kitDefinitions: [oversized] },
        dependencies
      )
    ).rejects.toThrow(/supports at most 1,000 per project/i);
    expect(searchRecentReferences).not.toHaveBeenCalled();
    expect(searchPackageReferences).not.toHaveBeenCalled();
  });

  it('keeps valid parts when another catalog document cannot be resolved', async () => {
    const relativePath = 'sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb';
    const validReference = catalogReference(relativePath, 'B0034m_BC');
    const missingReference = {
      ...validReference,
      entityId: 'missing-package',
      name: 'Missing package',
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'missing-package' } as const,
    };
    const content = readFileSync(validReference.absolutePath, 'utf8');
    const dependencies = {
      loadEnzymes: async () => [bsaI()],
      searchRecentReferences: async () => [missingReference, validReference],
      searchPackageReferences: async () => [],
      resolveDocument: async (
        document: NonNullable<CatalogReferenceCandidate['sequenceDocument']>
      ) => {
        if (document.kind === 'catalog-sequence' && document.entityId === 'missing-package') {
          throw new Error('catalog binding disappeared');
        }
        return {
          ref: validReference.sequenceDocument!,
          documentId: validReference.entityId,
          sourcePath: validReference.absolutePath,
        };
      },
      readTextFileSlice: async () => ({
        text: content,
        bytesRead: Buffer.byteLength(content),
      }),
      cache: new Map(),
    };

    const result = await loadMocloCatalogCandidates(
      { workspaceRoot: WORKSPACE, enzymeName: 'BsaI' },
      dependencies
    );

    expect(result.skippedSourceCount).toBe(1);
    expect(result.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'B0034m_BC' })])
    );
  });

  it('retries a source after a transient read failure instead of caching an empty result', async () => {
    const relativePath = 'sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb';
    const reference = catalogReference(relativePath, 'B0034m_BC');
    const content = readFileSync(reference.absolutePath, 'utf8');
    let reads = 0;
    const dependencies = {
      loadEnzymes: async () => [bsaI()],
      searchRecentReferences: async () => [reference],
      searchPackageReferences: async () => [],
      resolveDocument: async () => ({
        ref: reference.sequenceDocument!,
        documentId: reference.entityId,
        sourcePath: reference.absolutePath,
      }),
      readTextFileSlice: async () => {
        reads += 1;
        if (reads === 1) throw new Error('temporary filesystem failure');
        return { text: content, bytesRead: Buffer.byteLength(content) };
      },
      cache: new Map(),
    };

    await expect(
      loadMocloCatalogCandidates({ workspaceRoot: WORKSPACE, enzymeName: 'BsaI' }, dependencies)
    ).resolves.toMatchObject({ candidates: [], skippedSourceCount: 1 });
    const recovered = await loadMocloCatalogCandidates(
      { workspaceRoot: WORKSPACE, enzymeName: 'BsaI' },
      dependencies
    );

    expect(reads).toBe(2);
    expect(recovered.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'B0034m_BC' })])
    );
  });

  it('keeps a successful shared analysis cached when one consumer aborts', async () => {
    const relativePath = 'sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb';
    const reference = catalogReference(relativePath, 'B0034m_BC');
    const content = readFileSync(reference.absolutePath, 'utf8');
    let finishRead: ((value: { text: string; bytesRead: number }) => void) | null = null;
    let reads = 0;
    const read = new Promise<{ text: string; bytesRead: number }>((resolveRead) => {
      finishRead = resolveRead;
    });
    const cache = new Map();
    const dependencies = {
      loadEnzymes: async () => [bsaI()],
      searchRecentReferences: async () => [reference],
      searchPackageReferences: async () => [],
      resolveDocument: async () => ({
        ref: reference.sequenceDocument!,
        documentId: reference.entityId,
        sourcePath: reference.absolutePath,
      }),
      readTextFileSlice: async () => {
        reads += 1;
        return read;
      },
      cache,
    };
    const aborted = new AbortController();
    const first = loadMocloCatalogCandidates(
      { workspaceRoot: WORKSPACE, enzymeName: 'BsaI', abortSignal: aborted.signal },
      dependencies
    );
    const second = loadMocloCatalogCandidates(
      { workspaceRoot: WORKSPACE, enzymeName: 'BsaI' },
      dependencies
    );

    await vi.waitFor(() => expect(reads).toBe(1));
    aborted.abort();
    finishRead?.({ text: content, bytesRead: Buffer.byteLength(content) });

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toMatchObject({
      candidates: expect.arrayContaining([expect.objectContaining({ name: 'B0034m_BC' })]),
    });
    await loadMocloCatalogCandidates(
      { workspaceRoot: WORKSPACE, enzymeName: 'BsaI' },
      dependencies
    );
    expect(reads).toBe(1);
  });

  it('never reuses cached provenance across two documents with identical bytes', async () => {
    const relativePath = 'sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb';
    const firstReference = catalogReference(relativePath, 'First copy', 'entity:first-copy');
    const secondReference = {
      ...catalogReference(relativePath, 'Second copy', 'entity:second-copy'),
      objectUuid: 'object:second-copy',
      contentHash: firstReference.contentHash,
      sizeBytes: firstReference.sizeBytes,
    };
    const content = readFileSync(firstReference.absolutePath, 'utf8');
    let currentReference = firstReference;
    let reads = 0;
    const dependencies = {
      loadEnzymes: async () => [bsaI()],
      searchRecentReferences: async () => [currentReference],
      searchPackageReferences: async () => [],
      resolveDocument: async () => ({
        ref: currentReference.sequenceDocument!,
        documentId: currentReference.entityId,
        sourcePath: currentReference.absolutePath,
      }),
      readTextFileSlice: async () => {
        reads += 1;
        return { text: content, bytesRead: Buffer.byteLength(content) };
      },
      cache: new Map(),
    };

    const first = await loadMocloCatalogCandidates(
      { workspaceRoot: WORKSPACE, enzymeName: 'BsaI' },
      dependencies
    );
    currentReference = secondReference;
    const second = await loadMocloCatalogCandidates(
      { workspaceRoot: WORKSPACE, enzymeName: 'BsaI' },
      dependencies
    );

    expect(reads).toBe(2);
    expect(first.candidates[0]?.source.entityId).toBe('entity:first-copy');
    expect(second.candidates[0]?.source.entityId).toBe('entity:second-copy');
    expect(second.candidates[0]?.name).toBe('Second copy');
  });

  it('uses declared stable membership and never synthesizes a kit from a folder name', () => {
    const ytk = ytkDefinition();
    const member = ytk.members.find((candidate) => candidate.name === 'pYTK009');
    expect(member).toBeDefined();
    const reference = managedCatalogReference(
      'sequences/kits/moclo-ytk/pYTK009',
      'pYTK009.gb',
      'pYTK009',
      member?.sequencePackageId ?? ''
    );
    const candidates = analyzeMocloCatalogSource({
      reference,
      content: readFileSync(reference.absolutePath, 'utf8'),
      enzyme: bsaI(),
      kitDefinitions: [ytk],
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kit: { id: 'ytk', name: 'Yeast Toolkit (YTK)' },
          kitMemberId: 'pytk009',
          kitPartTypeId: 'ytk:2',
          roleEvidence: expect.arrayContaining([
            expect.objectContaining({ id: 'ytk:promoter', label: 'Promoter' }),
          ]),
        }),
      ])
    );

    const customKit = { ...ytk, id: 'my-promoters', name: 'My promoters', members: [member!] };
    const sharedCandidates = analyzeMocloCatalogSource({
      reference,
      content: readFileSync(reference.absolutePath, 'utf8'),
      enzyme: bsaI(),
      kitDefinitions: [ytk, customKit],
    });
    const ranked = rankMocloCatalogCandidates({
      candidates: sharedCandidates,
      schema: {
        ...schema(),
        origin: { type: 'kit', kitId: customKit.id, kitName: customKit.name },
      },
      slotIndex: 0,
      topology: 'circular',
      query: '',
      includePhysicallyIncompatible: true,
    });
    expect(ranked[0].kit?.id).toBe(customKit.id);
    expect(ranked[0].roleEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: expect.stringContaining('My promoters') }),
      ])
    );
    expect(sharedCandidates[0].kit?.id).toBe('ytk');

    const undeclaredReference = catalogReference(
      'sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb',
      'B0034m_BC'
    );
    expect(
      analyzeMocloCatalogSource({
        reference: undeclaredReference,
        content: readFileSync(undeclaredReference.absolutePath, 'utf8'),
        enzyme: bsaI(),
        kitDefinitions: [ytk],
      })[0]?.kit
    ).toBeNull();

    const looseReferenceWithCollidingCatalogId = catalogReference(
      'sequences/kits/moclo-ytk/pYTK009/pYTK009.gb',
      'loose pYTK009',
      member?.sequencePackageId ?? ''
    );
    expect(
      analyzeMocloCatalogSource({
        reference: looseReferenceWithCollidingCatalogId,
        content: readFileSync(looseReferenceWithCollidingCatalogId.absolutePath, 'utf8'),
        enzyme: bsaI(),
        kitDefinitions: [ytk],
      })[0]?.kit
    ).toBeNull();
  });

  it('uses the real digest engine to find the CIDAR RBS part and its physical overhangs', () => {
    const relativePath = 'sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb';
    const reference = catalogReference(relativePath, 'B0034m_BC');
    const candidates = analyzeMocloCatalogSource({
      reference,
      content: readFileSync(reference.absolutePath, 'utf8'),
      enzyme: bsaI(),
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'B0034m_BC',
          route: 'restriction-digest',
          upstreamOverhang: 'TACT',
          downstreamOverhang: 'AATG',
          kit: null,
          roleEvidence: expect.arrayContaining([
            expect.objectContaining({ label: 'RBS', source: expect.stringContaining('KEYWORDS') }),
          ]),
        }),
      ])
    );
  });

  it('keeps a physically compatible destination vector visible but ranks it as a role mismatch', () => {
    const relativePath = 'sequences/kits/moclo-cidar/DVA_BC/DVA_BC.gb';
    const reference = catalogReference(relativePath, 'DVA_BC');
    const candidates = analyzeMocloCatalogSource({
      reference,
      content: readFileSync(reference.absolutePath, 'utf8'),
      enzyme: bsaI(),
    });

    const ranked = rankMocloCatalogCandidates({
      candidates,
      schema: schema(),
      slotIndex: 0,
      topology: 'circular',
      query: '',
      includePhysicallyIncompatible: false,
    });

    expect(ranked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          upstreamOverhang: 'TACT',
          downstreamOverhang: 'AATG',
          compatibility: {
            physical: { type: 'exact' },
            role: expect.objectContaining({ type: 'mismatch' }),
          },
        }),
      ])
    );
  });

  it('uses overhangs as compatibility and applies biological type only when requested', () => {
    const rbsPath = 'sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb';
    const vectorPath = 'sequences/kits/moclo-cidar/DVA_BC/DVA_BC.gb';
    const rbsReference = catalogReference(rbsPath, 'Z RBS');
    const vectorReference = catalogReference(vectorPath, 'A destination vector');
    const rbs = analyzeMocloCatalogSource({
      reference: rbsReference,
      content: readFileSync(rbsReference.absolutePath, 'utf8'),
      enzyme: bsaI(),
    }).find(
      (candidate) =>
        candidate.upstreamOverhang === 'TACT' && candidate.downstreamOverhang === 'AATG'
    );
    const vector = analyzeMocloCatalogSource({
      reference: vectorReference,
      content: readFileSync(vectorReference.absolutePath, 'utf8'),
      enzyme: bsaI(),
    }).find(
      (candidate) =>
        candidate.upstreamOverhang === 'TACT' && candidate.downstreamOverhang === 'AATG'
    );
    if (!rbs || !vector) throw new Error('The real CIDAR fixtures must produce TACT→AATG parts.');

    const noisyUtr = {
      ...vector,
      id: `${vector.id}:noisy-utr`,
      name: 'Y 5′ UTR',
      roleEvidence: [
        { label: '5′ UTR', source: 'GenBank KEYWORDS Part subtype' },
        { label: 'RBS', source: 'secondary annotation' },
      ],
    };

    const input = {
      candidates: [rbs, vector, noisyUtr],
      schema: schema(),
      slotIndex: 0,
      topology: 'circular' as const,
      query: '',
      includePhysicallyIncompatible: false,
    };

    expect(rankMocloCatalogCandidates(input).map((candidate) => candidate.name)).toEqual([
      'A destination vector',
      'Y 5′ UTR',
      'Z RBS',
    ]);
    expect(
      rankMocloCatalogCandidates({ ...input, partTypeFilter: 'RBS' }).map(
        (candidate) => candidate.name
      )
    ).toEqual(['Z RBS']);
  });

  it('searches role, overhang, kit, route, and source name without making any one mandatory', () => {
    const relativePath = 'sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb';
    const reference = catalogReference(relativePath, 'B0034m_BC');
    const candidates = analyzeMocloCatalogSource({
      reference,
      content: readFileSync(reference.absolutePath, 'utf8'),
      enzyme: bsaI(),
    });
    const input = {
      candidates,
      schema: schema(),
      slotIndex: 0,
      topology: 'circular' as const,
      includePhysicallyIncompatible: true,
    };

    expect(rankMocloCatalogCandidates({ ...input, query: 'rbs' })).not.toHaveLength(0);
    expect(rankMocloCatalogCandidates({ ...input, query: 'AATG' })).not.toHaveLength(0);
    expect(rankMocloCatalogCandidates({ ...input, query: 'CIDAR' })).not.toHaveLength(0);
    expect(rankMocloCatalogCandidates({ ...input, query: 'digest' })).not.toHaveLength(0);
    expect(rankMocloCatalogCandidates({ ...input, query: 'B0034' })).not.toHaveLength(0);
  });
});
