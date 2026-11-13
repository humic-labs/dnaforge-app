// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { DesignRegion, SequenceDesign } from '../design/types';
import {
  assertSourceProvenanceCoversRegions,
  buildAcceptedAssemblyCanonicalDraftInput,
  buildAcceptedAssemblyProjectionInput,
  buildAcceptedAssemblyValidationSnapshot,
  buildSourceProvenanceSnapshot,
  canonicalizeAcceptedAssemblyValue,
  computeAcceptedDraftChecksum,
  isAcceptedAssemblyValidationSnapshotCurrent,
} from './accepted-canonical';

describe('accepted assembly canonical draft input', () => {
  it('binds primer rules into the accepted recipe checksum', async () => {
    const design = createDesign();
    const options = { sourceProvenance: sourceProvenanceFor(design) };
    const original = buildAcceptedAssemblyCanonicalDraftInput(design, options);
    const rules = { targetPcrTm: 65, overlapLength: 40 };
    const selected = buildAcceptedAssemblyCanonicalDraftInput(
      { ...design, primerDesignConstraints: rules },
      options
    );
    expect(selected.primerDesignConstraints).toEqual(rules);
    expect(await computeAcceptedDraftChecksum(selected)).not.toBe(
      await computeAcceptedDraftChecksum(original)
    );
  });

  it('binds the selected PCR polymerase to the accepted recipe and checksum', async () => {
    const design = createDesign();
    const options = { sourceProvenance: sourceProvenanceFor(design) };
    const original = buildAcceptedAssemblyCanonicalDraftInput(design, options);
    const selected = buildAcceptedAssemblyCanonicalDraftInput(
      { ...design, pcrPolymerase: 'q5-0' },
      options
    );
    expect(selected).toMatchObject({ pcrPolymerase: 'q5-0' });
    expect(await computeAcceptedDraftChecksum(selected)).not.toBe(
      await computeAcceptedDraftChecksum(original)
    );
    const legacy = buildAcceptedAssemblyCanonicalDraftInput(
      { ...design, pcrPolymerase: null },
      options
    );
    expect(await computeAcceptedDraftChecksum(legacy)).toBe(
      await computeAcceptedDraftChecksum(original)
    );
  });

  it('canonicalizes object keys while preserving array order', () => {
    expect(canonicalizeAcceptedAssemblyValue({ b: 1, a: [{ d: 4, c: 3 }] })).toBe(
      '{"a":[{"c":3,"d":4}],"b":1}'
    );
    expect(canonicalizeAcceptedAssemblyValue({ values: ['left', 'right'] })).toBe(
      '{"values":["left","right"]}'
    );
  });

  it('ignores volatile viewport and timestamp state when hashing accepted draft input', async () => {
    const design = createDesign();
    const baseline = buildAcceptedAssemblyCanonicalDraftInput(design, {
      sourceProvenance: sourceProvenanceFor(design),
    });
    const withViewportNoise = buildAcceptedAssemblyCanonicalDraftInput(
      {
        ...design,
        version: design.version + 9,
        selectedJunctionIndex: 1,
        scrollToPosition: 400,
        highlightRange: { start: 12, end: 20 },
        createdAt: new Date('2026-05-17T12:00:00.000Z'),
        updatedAt: new Date('2026-05-17T13:00:00.000Z'),
        assemblyResult: {
          junctions: [],
          primerPairs: [],
          pcrProducts: [],
          assembled: {
            id: 'volatile-result',
            name: 'Volatile',
            sequence: 'AAAA',
            topology: 'circular',
            length: 4,
          },
          validation: { valid: true, errors: [] },
        },
      },
      {
        sourceProvenance: sourceProvenanceFor(design),
      }
    );

    await expect(computeAcceptedDraftChecksum(withViewportNoise)).resolves.toBe(
      await computeAcceptedDraftChecksum(baseline)
    );
  });

  it('moves the checksum when spacer, primer, or Golden Gate offset biology changes', async () => {
    const design = createDesign({
      assemblyMethod: 'goldengate',
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [
        {
          junctionIndex: 0,
          junctionPosition: 12,
          offset: 0,
          overhangStart: 10,
          overhangEnd: 14,
          overhang: 'ATGC',
          source: { type: 'pcr-designed' },
          isValid: true,
        },
      ],
      designPrimers: [
        {
          fragmentIndex: 0,
          forward: primer('p-fwd', 'AAAAATGC'),
          reverse: primer('p-rev', 'GCATTTTT', 'reverse'),
        },
      ],
    });
    const baseline = await checksumFor(design);

    await expect(
      checksumFor({
        ...design,
        spacers: [{ id: 'spacer-1', junctionIndex: 0, sequence: 'GGG' }],
      })
    ).resolves.not.toBe(baseline);

    await expect(
      checksumFor({
        ...design,
        goldenGateJunctions: [{ ...design.goldenGateJunctions![0], offset: 1, overhangStart: 11 }],
      })
    ).resolves.not.toBe(baseline);

    await expect(
      checksumFor({
        ...design,
        designPrimers: [
          {
            ...design.designPrimers[0],
            forward: { ...design.designPrimers[0].forward, sequence: 'TTTTATGC' },
          },
        ],
      })
    ).resolves.not.toBe(baseline);
  });

  it('preserves source provenance details that are lost by a bare DesignRegion list', () => {
    const rdRegion = region('rd-1', 'ATGCATGC', {
      sourceType: 'rd',
      sourceSequence: 'TTTTATGCATGCGGGG',
      sourceAnnotations: [
        {
          name: 'scar',
          type: 'misc_feature',
          start: 4,
          end: 10,
          strand: 'forward',
          qualifiers: {
            note: 'restriction scar',
            citation: ['paper-1', 'paper-2'] as unknown as string,
          },
        },
      ],
      rdEnds: {
        upstream: {
          recognitionSequence: 'GAATTC',
          cutPositionTop: 5,
          cutPositionBottom: 1,
          overhangType: '5_prime',
          retainedScarSequence: 'G',
          retainedScarLength: 1,
        },
      },
    });

    const snapshot = buildSourceProvenanceSnapshot(rdRegion, {
      copiedDirection: 'reverse-complement',
      sourceConstructId: 'source-construct-1',
      sourceSequenceVersionId: 'sha256:source',
      sourceLocator: '/workspace/source.gb',
      sourceSequenceChecksum: 'sha256:source',
      includedSourceSegments: [
        { start: 4, end: 12, strand: 'reverse', role: 'included-template' },
        { start: 4, end: 10, strand: 'reverse', role: 'restriction-scar' },
      ],
    });

    expect(snapshot.sourceType).toBe('restriction-digest');
    expect(snapshot.copiedDirection).toBe('reverse-complement');
    expect(snapshot.sourceConstructId).toBe('source-construct-1');
    expect(snapshot.sourceSequenceVersionId).toBe('sha256:source');
    expect(snapshot.sourceLocator).toBe('/workspace/source.gb');
    expect(snapshot.sourceSequenceChecksum).toBe('sha256:source');
    expect(snapshot.includedSourceSegments).toContainEqual(
      expect.objectContaining({ role: 'restriction-scar', strand: 'reverse' })
    );
    expect(snapshot.rdEnds?.upstream?.retainedScarSequence).toBe('G');
    expect(snapshot.sourceAnnotations[0].qualifiers).toEqual({
      citation: ['paper-1', 'paper-2'],
      note: 'restriction scar',
    });
  });

  it('requires one explicit source provenance snapshot for every accepted region', () => {
    const design = createDesign();
    expect(() =>
      assertSourceProvenanceCoversRegions(design.regions, sourceProvenanceFor(design).slice(0, 1))
    ).toThrow(/missing region snapshots/i);
    expect(() =>
      assertSourceProvenanceCoversRegions(design.regions, [
        ...sourceProvenanceFor(design),
        buildSourceProvenanceSnapshot(design.regions[0]),
      ])
    ).toThrow(/duplicate region/i);
    expect(() =>
      assertSourceProvenanceCoversRegions(design.regions, [
        ...sourceProvenanceFor(design),
        buildSourceProvenanceSnapshot(region('unknown', 'AAAA')),
      ])
    ).toThrow(/unknown region/i);
  });

  it('builds projection input with a checksum and rejects stale validation snapshots', async () => {
    const design = createDesign();
    const projection = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: sourceProvenanceFor(design),
    });
    const snapshot = buildAcceptedAssemblyValidationSnapshot({
      designId: design.id,
      designVersion: design.version,
      assemblyMethod: design.assemblyMethod,
      projectionInputChecksum: projection.canonicalDraftChecksum,
      validatedAt: '2026-05-17T00:00:00.000Z',
    });

    expect(snapshot.clean).toBe(true);
    expect(
      isAcceptedAssemblyValidationSnapshotCurrent(snapshot, {
        designId: design.id,
        designVersion: design.version,
        assemblyMethod: design.assemblyMethod,
        projectionInputChecksum: projection.canonicalDraftChecksum,
      })
    ).toBe(true);
    expect(
      isAcceptedAssemblyValidationSnapshotCurrent(snapshot, {
        designId: design.id,
        designVersion: design.version + 1,
        assemblyMethod: design.assemblyMethod,
        projectionInputChecksum: projection.canonicalDraftChecksum,
      })
    ).toBe(false);
    expect(
      isAcceptedAssemblyValidationSnapshotCurrent(snapshot, {
        designId: design.id,
        designVersion: design.version,
        assemblyMethod: design.assemblyMethod,
        projectionInputChecksum: 'sha256:different',
      })
    ).toBe(false);
  });
});

async function checksumFor(design: SequenceDesign): Promise<string> {
  return computeAcceptedDraftChecksum(
    buildAcceptedAssemblyCanonicalDraftInput(design, {
      sourceProvenance: sourceProvenanceFor(design),
    })
  );
}

function sourceProvenanceFor(design: SequenceDesign) {
  return design.regions.map((item) => buildSourceProvenanceSnapshot(item));
}

function createDesign(overrides: Partial<SequenceDesign> = {}): SequenceDesign {
  const now = new Date('2026-05-17T00:00:00.000Z');
  return {
    id: 'design-1',
    constructId: 'construct-1',
    name: 'Accepted design',
    topology: 'circular',
    regions: [region('left', 'ATGCATGCATGC'), region('right', 'GCTAGCTAGCTA')],
    spacers: [],
    version: 4,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [
      {
        id: 'homology-1',
        junctionIndex: 0,
        junctionPosition: 12,
        start: 0,
        end: 30,
        encoding: { onLeft: 15, onRight: 15 },
        metadata: { sequence: 'ATGCATGCATGCGCTAGCTAGCTA', tmEstimate: 60, gcContent: 50 },
      },
    ],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function region(id: string, sequence: string, overrides: Partial<DesignRegion> = {}): DesignRegion {
  return {
    id,
    sourceSequenceId: `source-${id}`,
    sourceSequenceName: `Source ${id}`,
    sourceStart: 4,
    sourceEnd: 4 + sequence.length,
    sequence,
    annotations: [
      {
        name: `${id} CDS`,
        type: 'CDS',
        start: 0,
        end: sequence.length,
        strand: 'forward',
        qualifiers: { product: `${id} protein` },
      },
    ],
    sourceType: 'pcr',
    ...overrides,
  };
}

function primer(id: string, sequence: string, direction: 'forward' | 'reverse' = 'forward') {
  return {
    id,
    name: id,
    sequence,
    pbs: { start: 0, end: 4, sequence: sequence.slice(-4) },
    overhang: { length: Math.max(0, sequence.length - 4), sequence: sequence.slice(0, -4) },
    direction,
    fragmentIndex: 0,
    junctionIndex: 0,
  };
}
