import { describe, expect, it } from 'vitest';
import type { SequenceDesign } from '../design/public/types';
import { hydrateDesign } from '../design/public/store';
import type { AcceptedAssemblySidecarPayload } from './accepted-types';
import { buildAcceptedAssemblySourceProvenance } from './accepted-service';
import {
  assertHistoricalComponentSelectionsCurrent,
  catalogHistoricalAssemblyComponents,
  composeHistoricalAssemblyComponents,
  preserveHistoricalComputedChoices,
} from './historical-component-composition';

function acceptedVersion(
  id: string,
  firstSequence: string,
  includeJoinAndPrimers = false
): AcceptedAssemblySidecarPayload {
  const projectionInput = {
    schemaVersion: 1 as const,
    designId: 'original-design',
    constructId: 'construct-1',
    designName: 'Construct',
    topology: 'linear' as const,
    assemblyMethod: 'gibson' as const,
    backboneSequenceId: null,
    defaultHomologyLength: 2,
    productSequence: `${firstSequence}second`,
    regions: [
      {
        id: 'left',
        sourceSequenceId: 'source-left',
        sourceSequenceName: 'Left',
        sourceType: 'pcr' as const,
        sourceStart: 0,
        sourceEnd: firstSequence.length,
        sequence: firstSequence,
        annotations: [],
      },
      {
        id: 'right',
        sourceSequenceId: 'source-right',
        sourceSequenceName: 'Right',
        sourceType: 'pcr' as const,
        sourceStart: 0,
        sourceEnd: 6,
        sequence: 'second',
        annotations: [],
      },
    ],
    spacers: [{ id: 'spacer-left-right', junctionIndex: 0, sequence: 'space' }],
    homologyRegions: includeJoinAndPrimers
      ? [
          {
            id: 'left-right-homology',
            junctionIndex: 0,
            junctionPosition: firstSequence.length,
            start: firstSequence.length - 1,
            end: firstSequence.length + 1,
            encoding: { onLeft: 1, onRight: 1 },
          },
        ]
      : [],
    designPrimers: includeJoinAndPrimers
      ? [
          {
            fragmentIndex: 0,
            forward: {
              id: 'forward-left',
              name: 'Forward',
              sequence: 'primer-forward',
              pbs: { start: 0, end: 2, sequence: 'pr' },
              overhang: { length: 0, sequence: '' },
              direction: 'forward' as const,
              fragmentIndex: 0,
              junctionIndex: 0,
            },
            reverse: {
              id: 'reverse-left',
              name: 'Reverse',
              sequence: 'primer-reverse',
              pbs: { start: 2, end: 4, sequence: 'im' },
              overhang: { length: 0, sequence: '' },
              direction: 'reverse' as const,
              fragmentIndex: 0,
              junctionIndex: 0,
            },
          },
        ]
      : [],
    sourceProvenance: [],
    canonicalDraftChecksum: `sha256:${id}`,
  };
  return {
    type: 'accepted_assembly',
    schemaVersion: 1,
    acceptedAssemblyVersionId: id,
    acceptedAt: '2026-09-30T00:00:00.000Z',
    designId: 'original-design',
    designName: 'Construct',
    construction: {
      method: 'gibson',
      topology: 'linear',
      canonicalDraftChecksum: projectionInput.canonicalDraftChecksum,
      regionCount: 2,
      spacerCount: 1,
    },
    projectionInput,
    validationSnapshot: {
      schemaVersion: 1,
      designId: 'original-design',
      designVersion: 1,
      assemblyMethod: 'gibson',
      projectionInputChecksum: projectionInput.canonicalDraftChecksum,
      validatedAt: '2026-09-30T00:00:00.000Z',
      clean: true,
      issues: [],
    },
    artifacts: {
      productGenBankPath: 'contents/product.gb',
      sidecarJsonPath: 'contents/assembly.json',
      primerCsvPath: 'contents/primers.csv',
      primerFastaPath: 'contents/primers.fasta',
      productSequenceChecksum: 'sha256:product',
      primerCsvChecksum: 'sha256:csv',
      primerFastaChecksum: 'sha256:fasta',
      canonicalDraftChecksum: projectionInput.canonicalDraftChecksum,
    },
  };
}

function draft(): SequenceDesign {
  return {
    id: 'draft-1234567890abcdef1234567890abcdef',
    constructId: 'construct-1',
    parentAcceptedAssemblyVersionId: 'accepted-base',
    name: 'Construct',
    topology: 'linear',
    regions: [
      {
        id: 'left',
        sourceSequenceId: 'source-left',
        sourceSequenceName: 'Left',
        sourceStart: 0,
        sourceEnd: 5,
        sequence: 'first',
        annotations: [],
      },
      {
        id: 'right',
        sourceSequenceId: 'source-right',
        sourceSequenceName: 'Right',
        sourceStart: 0,
        sourceEnd: 6,
        sequence: 'second',
        annotations: [],
      },
    ],
    spacers: [],
    version: 4,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 2,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    acceptedAssemblyVersions: [],
    activeAcceptedAssemblyVersionId: 'accepted-base',
    createdAt: new Date('2026-09-30T00:00:00.000Z'),
    updatedAt: new Date('2026-09-30T00:00:00.000Z'),
  };
}

describe('historical assembly component composition', () => {
  it('catalogs version-pinned regions and gap-anchored spacers without positional target identity', async () => {
    const catalog = await catalogHistoricalAssemblyComponents([
      acceptedVersion('accepted-base', 'first'),
      acceptedVersion('accepted-older', 'older'),
    ]);
    expect(catalog.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'region',
          acceptedAssemblyVersionId: 'accepted-older',
          regionId: 'left',
          componentDigest: expect.stringMatching(/^sha256:/),
        }),
        expect.objectContaining({
          kind: 'spacer',
          acceptedAssemblyVersionId: 'accepted-older',
          leftRegionId: 'left',
          rightRegionId: 'right',
        }),
      ])
    );
  });

  it('stages an exact historical region into the same draft without calling it accepted', async () => {
    const records = [
      acceptedVersion('accepted-base', 'first'),
      acceptedVersion('accepted-older', 'older'),
    ];
    const catalog = await catalogHistoricalAssemblyComponents(records);
    const source = catalog.components.find(
      (item) =>
        item.kind === 'region' &&
        item.acceptedAssemblyVersionId === 'accepted-older' &&
        item.regionId === 'left'
    );
    expect(source).toBeDefined();
    const original = draft();
    const staged = await composeHistoricalAssemblyComponents(original, records, [
      {
        source: source!,
        target: { kind: 'region', regionId: 'left' },
      },
    ]);
    expect(staged.id).toBe(original.id);
    expect(staged.parentAcceptedAssemblyVersionId).toBe('accepted-base');
    expect(staged.regions[0].sequence).toBe('older');
    expect(staged.version).toBe(5);
    expect(staged.assemblyState).toBe('drafting');
    expect(staged.activeAcceptedAssemblyVersionId).toBeNull();
    expect(staged.acceptedAssemblyVersions).toEqual([]);
  });

  it('rejects a changed historical component digest before mutating the draft', async () => {
    const records = [
      acceptedVersion('accepted-base', 'first'),
      acceptedVersion('accepted-older', 'older'),
    ];
    const catalog = await catalogHistoricalAssemblyComponents(records);
    const source = catalog.components.find(
      (item) =>
        item.kind === 'region' &&
        item.acceptedAssemblyVersionId === 'accepted-older' &&
        item.regionId === 'left'
    );
    expect(source).toBeDefined();
    await expect(
      composeHistoricalAssemblyComponents(draft(), records, [
        {
          source: { ...source!, componentDigest: 'sha256:stale' },
          target: { kind: 'region', regionId: 'left' },
        },
      ])
    ).rejects.toThrow(/digest/i);
  });

  it('keys a historical join by neighbors and a primer pair by region and directions', async () => {
    const catalog = await catalogHistoricalAssemblyComponents([
      acceptedVersion('accepted-older', 'older', true),
    ]);
    expect(catalog.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'join',
          leftRegionId: 'left',
          rightRegionId: 'right',
          method: 'gibson',
        }),
        expect.objectContaining({
          kind: 'primer-pair',
          regionId: 'left',
          directions: ['forward', 'reverse'],
        }),
      ])
    );
  });

  it('stages multiple parts together but refuses a validator that would replace a selected primer', async () => {
    const records = [acceptedVersion('accepted-older', 'older', true)];
    const catalog = await catalogHistoricalAssemblyComponents(records);
    const source = (kind: string) => {
      const match = catalog.components.find((item) => item.kind === kind);
      if (!match) throw new Error(`Missing ${kind} source`);
      return match;
    };
    const staged = await composeHistoricalAssemblyComponents(draft(), records, [
      { source: source('region'), target: { kind: 'region', regionId: 'left' } },
      {
        source: source('spacer'),
        target: {
          kind: 'spacer',
          leftRegionId: 'left',
          rightRegionId: 'right',
        },
      },
      {
        source: source('join'),
        target: {
          kind: 'join',
          leftRegionId: 'left',
          rightRegionId: 'right',
        },
      },
      { source: source('primer-pair'), target: { kind: 'primer-pair', regionId: 'left' } },
    ]);
    expect(staged.historicalComponentSources).toHaveLength(4);
    expect(staged.homologyRegions).toHaveLength(1);
    expect(staged.designPrimers).toHaveLength(1);
    const rehydrated = hydrateDesign(staged);
    expect(rehydrated.homologyRegions).toEqual(staged.homologyRegions);
    expect(rehydrated.designPrimers).toEqual(staged.designPrimers);
    await expect(assertHistoricalComponentSelectionsCurrent(rehydrated)).resolves.toBeUndefined();
    await expect(
      preserveHistoricalComputedChoices(staged, {
        homologyRegions: staged.homologyRegions,
        goldenGateJunctions: undefined,
        designPrimers: [
          {
            ...staged.designPrimers[0],
            forward: { ...staged.designPrimers[0].forward, sequence: 'different-primer' },
          },
        ],
      })
    ).rejects.toThrow(/selected historical primer pair differs/i);
  });

  it('does not assign a spacer to an ambiguous legacy gap', async () => {
    const record = acceptedVersion('accepted-older', 'older');
    record.projectionInput.regions[1].id = 'left';
    const catalog = await catalogHistoricalAssemblyComponents([record]);
    expect(catalog.components).toEqual([]);
    expect(catalog.unavailable[0].reason).toMatch(/duplicate region identities/i);
  });

  it('does not re-resolve a mixed historical region against the current source', async () => {
    const records = [acceptedVersion('accepted-older', 'older')];
    const catalog = await catalogHistoricalAssemblyComponents(records);
    const source = catalog.components.find(
      (item) => item.kind === 'region' && item.regionId === 'left'
    );
    if (!source) throw new Error('Missing source region');
    const staged = await composeHistoricalAssemblyComponents(draft(), records, [
      {
        source,
        target: { kind: 'region', regionId: 'left' },
      },
    ]);
    let currentSourceLookups = 0;
    const provenance = await buildAcceptedAssemblySourceProvenance(staged, {}, async () => {
      currentSourceLookups += 1;
      return {
        sourceConstructId: 'current-construct',
        sourceSequenceVersionId: 'current-version',
        sourceLocator: 'current-location',
      };
    });
    expect(currentSourceLookups).toBe(0);
    expect(provenance[0].sourceSequenceVersionId).toBeUndefined();
    staged.regions[0] = { ...staged.regions[0], sequence: 'edited-after-staging' };
    await expect(assertHistoricalComponentSelectionsCurrent(staged)).rejects.toThrow(/restage/i);
  });
});
