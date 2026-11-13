import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import { draftDesignAssemblyOutputSchema } from './design-output-schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDesignStore } from '../../design/store';
import type { DesignRegion } from '../../design/types';
import {
  getTmProviderRegistry,
  setTmProviderRegistry,
} from '../../design/algorithms/design-tm-refinement';
import { TmProviderRegistry, createLocalTmProvider } from '../../design/algorithms/tm-provider';
import { draftDesignAssemblyTool } from './draft-design-assembly';
import { reorderDesignRegionsTool } from './reorder-design-regions';
import { execTool } from './test-helpers';
import { getDesignTool } from './get-design';
import { createUpdateAssemblyPrimerTool } from './update-assembly-primer';

function resetDesignStore() {
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
}

function region(name: string, sequence: string): Omit<DesignRegion, 'id'> {
  return {
    sourceSequenceId: `source-${name}`,
    sourceSequenceName: name,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

describe('draft_design_assembly tool', () => {
  const originalTmRegistry = getTmProviderRegistry();

  beforeEach(() => {
    resetDesignStore();
  });

  afterEach(() => {
    setTmProviderRegistry(originalTmRegistry);
  });

  it('drafts primers and junctions for an existing design', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Derivative', 'circular', 'gibson');
    store.addRegion(designId, region('fragment 1', 'ATCG'.repeat(50)));
    store.addRegion(designId, region('fragment 2', 'GCTA'.repeat(50)));

    const result = await execDesignContract<{
      drafted: boolean;
      assemblyState: string;
      homologyRegionCount: number;
      primerPairCount: number;
      validationErrorCount: number;
      previousVersion: number;
      version: number;
      mutation: {
        operationId: string;
        effect: string;
        beforeVersion: number | null;
        afterVersion: number | null;
        target: { type: string; id: string };
        expected: { assemblyState: string; primerPairCount: number };
      };
    }>(draftDesignAssemblyOutputSchema, draftDesignAssemblyTool, { designId });

    const design = useDesignStore.getState().designs[designId];
    expect(result).toMatchObject({
      drafted: true,
      assemblyState: 'ready',
      validationErrorCount: 0,
      regionCount: 2,
    });
    expect(result.version).toBeGreaterThan(result.previousVersion);
    expect(result.mutation).toMatchObject({
      operationId: 'test',
      effect: 'drafted_design_assembly',
      beforeVersion: result.previousVersion,
      afterVersion: result.version,
      target: { type: 'design', id: designId },
      expected: {
        assemblyState: 'ready',
        primerPairCount: result.primerPairCount,
      },
    });
    expect(result.homologyRegionCount).toBeGreaterThan(0);
    expect(result.primerPairCount).toBeGreaterThan(0);
    expect(design.assemblyState).toBe('ready');
    expect(design.designPrimers.length).toBeGreaterThan(0);
  });

  it('edits the published primer identity and preserves authored chemistry through the normal draft command', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Authored derivative', 'circular', 'gibson');
    store.addRegion(designId, region('backbone', 'ATCG'.repeat(50)));
    store.addRegion(designId, region('insert', 'GCTA'.repeat(50)));
    await execTool(draftDesignAssemblyTool, { designId });
    const read = await execTool<{ version: number; primers: Array<{ forward: { id: string } }> }>(getDesignTool, { designId });
    const primerId = read.primers[0].forward.id;
    const notation = '/5Phos/CAGCTTTTGTTCCCTTTAGTGAGGGTTAATTG/3SpC3/';
    const edited = await execTool(createUpdateAssemblyPrimerTool(), {
      designId, primerId, expectedDesignVersion: read.version,
      oligo: { vendor: 'idt', notation }, annealingLength: 24,
    });
    expect(edited).toMatchObject({ ok: true, primer: { id: primerId, oligo: { notation } } });
    await execTool(draftDesignAssemblyTool, { designId });
    const after = useDesignStore.getState().designs[designId];
    expect(after.designPrimers[0].forward).toMatchObject({ id: primerId,
      sequence: 'CAGCTTTTGTTCCCTTTAGTGAGGGTTAATTG', manuallyEdited: true, oligo: { notation } });
    expect(after.validationErrors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'authored_primer_unverified', severity: 'warning' })]));
  });

  it('reports Tm resolution and schedules authoritative refinement on the agent path', async () => {
    const registry = new TmProviderRegistry().register(createLocalTmProvider(() => 50)).register({
      id: 'neb',
      supports: (model) => model.kind === 'neb',
      measure: async () => ({ tm: 68.4, source: 'neb', verified: true }),
    });
    setTmProviderRegistry(registry);
    const store = useDesignStore.getState();
    const designId = store.createDesign('Q5 derivative', 'circular', 'gibson');
    store.addRegion(designId, region('fragment 1', 'ATCG'.repeat(50)));
    store.addRegion(designId, region('fragment 2', 'GCTA'.repeat(50)));
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [designId]: { ...state.designs[designId], pcrPolymerase: 'q5' },
      },
    }));

    const result = await execDesignContract<{
      drafted: boolean;
      tmResolution: {
        model: { kind: string; prodcode?: string };
        source: string;
        pendingNebVerification: boolean;
      };
    }>(draftDesignAssemblyOutputSchema, draftDesignAssemblyTool, { designId });

    expect(result).toMatchObject({
      drafted: true,
      tmResolution: {
        model: { kind: 'neb', prodcode: 'q5-0' },
        source: 'reaction',
      },
    });
    await vi.waitFor(() => {
      const design = useDesignStore.getState().designs[designId];
      expect(design.designPrimers.length).toBeGreaterThan(0);
      expect(
        design.designPrimers.every(
          (pair) =>
            pair.forward.tmProvenance?.verified === true &&
            pair.reverse.tmProvenance?.verified === true
        )
      ).toBe(true);
    });
  });

  it('returns a clear error when the design has fewer than two regions', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Incomplete', 'circular', 'gibson');
    store.addRegion(designId, region('fragment 1', 'ATCG'.repeat(50)));

    const result = await execDesignContract<{
      drafted: boolean;
      code: string;
      error: string;
      regionCount: number;
    }>(draftDesignAssemblyOutputSchema, draftDesignAssemblyTool, { designId });

    expect(result).toMatchObject({
      drafted: false,
      code: 'DESIGN_REGIONS_REQUIRED',
      regionCount: 1,
    });
    expect(result.error).toContain('At least two');
    expect(result.error).toMatch(/biologyQuery.*add the missing requested part/iu);
    expect(useDesignStore.getState().designs[designId].assemblyState).toBe('drafting');
  });

  it('refuses regions that only split and reconstruct one unchanged source', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Renamed source', 'circular', 'gibson');
    const sourceSequence = 'ATCG'.repeat(30);
    store.addRegion(designId, {
      ...region('source first half', sourceSequence.slice(0, 60)),
      sourceSequenceId: 'source-plasmid',
      sourceStart: 0,
      sourceEnd: 60,
      sourceLength: sourceSequence.length,
      sourceIsCircular: true,
    });
    store.addRegion(designId, {
      ...region('source second half', sourceSequence.slice(60)),
      sourceSequenceId: 'source-plasmid',
      sourceStart: 60,
      sourceEnd: sourceSequence.length,
      sourceLength: sourceSequence.length,
      sourceIsCircular: true,
    });

    const result = await execDesignContract<{
      drafted: boolean;
      code: string;
      error: string;
      regionCount: number;
    }>(draftDesignAssemblyOutputSchema, draftDesignAssemblyTool, { designId });

    expect(result).toMatchObject({
      drafted: false,
      code: 'UNCHANGED_SOURCE_REASSEMBLY',
      regionCount: 2,
    });
    expect(result.error).toMatch(/unchanged source/i);
    expect(useDesignStore.getState().designs[designId].assemblyState).toBe('drafting');
  });

  it('refuses a complete circular source combined with another region', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Ambiguous insertion', 'circular', 'gibson');
    const backbone = 'ATCG'.repeat(50);
    store.addRegion(designId, {
      ...region('complete backbone', backbone),
      sourceSequenceId: 'circular-backbone',
      sourceLength: backbone.length,
      sourceIsCircular: true,
    });
    store.addRegion(designId, region('insert', 'GCTA'.repeat(50)));

    const result = await execDesignContract<{
      drafted: boolean;
      code: string;
      error: string;
      regionCount: number;
    }>(draftDesignAssemblyOutputSchema, draftDesignAssemblyTool, { designId });

    expect(result).toMatchObject({
      drafted: false,
      code: 'FULL_CIRCULAR_SOURCE_ASSEMBLY',
      regionCount: 2,
    });
    expect(result.error).toContain('remove_design_region');
    expect(useDesignStore.getState().designs[designId].assemblyState).toBe('drafting');
  });

  it('refuses adjacent circular-source fragments that should be one wrapped range', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Split circular complement', 'circular', 'gibson');
    const backbone = 'ATCG'.repeat(50);
    store.addRegion(designId, {
      ...region('backbone prefix', backbone.slice(0, 20)),
      sourceSequenceId: 'circular-backbone',
      sourceStart: 0,
      sourceEnd: 20,
      sourceLength: backbone.length,
      sourceIsCircular: true,
    });
    store.addRegion(designId, {
      ...region('backbone suffix', backbone.slice(80)),
      sourceSequenceId: 'circular-backbone',
      sourceStart: 80,
      sourceEnd: backbone.length,
      sourceLength: backbone.length,
      sourceIsCircular: true,
    });
    store.addRegion(designId, region('insert', 'GCTA'.repeat(20)));

    const result = await execDesignContract<{
      drafted: boolean;
      code: string;
      error: string;
      regionCount: number;
      replacementRange: { start: number; end: number; wraps: boolean; length: number };
    }>(draftDesignAssemblyOutputSchema, draftDesignAssemblyTool, { designId });

    expect(result).toMatchObject({
      drafted: false,
      code: 'SPLIT_CIRCULAR_SOURCE_RANGE',
      regionCount: 3,
      replacementRange: { start: 81, end: 20, wraps: true, length: 140 },
    });
    expect(result.error).toMatch(/one wrapped region.*81\.\.20/iu);
    expect(useDesignStore.getState().designs[designId].assemblyState).toBe('drafting');
  });

  it('recovers an insert followed by a complete split backbone through the returned reorder remedy', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Misordered insertion', 'circular', 'gibson');
    const backbone = 'ATCG'.repeat(50);
    store.addRegion(designId, region('insert', 'GCTA'.repeat(20)));
    store.addRegion(designId, {
      ...region('backbone prefix', backbone.slice(0, 80)),
      sourceSequenceId: 'circular-backbone',
      sourceStart: 0,
      sourceEnd: 80,
      sourceLength: backbone.length,
      sourceIsCircular: true,
    });
    store.addRegion(designId, {
      ...region('backbone suffix', backbone.slice(80)),
      sourceSequenceId: 'circular-backbone',
      sourceStart: 80,
      sourceEnd: backbone.length,
      sourceLength: backbone.length,
      sourceIsCircular: true,
    });
    const before = useDesignStore.getState().designs[designId];
    const [insert, prefix, suffix] = before.regions;
    const refused = await execTool<{
      drafted: boolean;
      code: string;
      error: string;
      adjacentSourceRegionIds: string[];
      replacementRange?: unknown;
    }>(draftDesignAssemblyTool, { designId, expectedVersion: before.version });
    expect(refused).toMatchObject({
      drafted: false,
      code: 'CIRCULAR_INSERTION_ORDER_REQUIRED',
      adjacentSourceRegionIds: [prefix.id, suffix.id],
    });
    expect(refused.replacementRange).toBeUndefined();
    expect(refused.error).toContain('reorder_design_regions');
    expect(useDesignStore.getState().designs[designId].version).toBe(before.version);

    const reordered = await execTool<{ status: string }>(reorderDesignRegionsTool, {
      designId,
      order: [prefix.id, insert.id, suffix.id],
      expectedDesignVersion: before.version,
    });
    expect(reordered.status).toBe('applied');
    const drafted = await execTool<{ drafted: boolean }>(draftDesignAssemblyTool, {
      designId,
      expectedVersion: useDesignStore.getState().designs[designId].version,
    });
    expect(drafted.drafted).toBe(true);
  });

  it('allows circular-source arms when the insert is intentionally between them', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Explicit three-fragment insertion', 'circular', 'gibson');
    const backbone = 'ATCG'.repeat(50);
    store.addRegion(designId, {
      ...region('backbone prefix', backbone.slice(0, 20)),
      sourceSequenceId: 'circular-backbone',
      sourceStart: 0,
      sourceEnd: 20,
      sourceLength: backbone.length,
      sourceIsCircular: true,
    });
    store.addRegion(designId, region('insert', 'GCTA'.repeat(20)));
    store.addRegion(designId, {
      ...region('backbone suffix', backbone.slice(80)),
      sourceSequenceId: 'circular-backbone',
      sourceStart: 80,
      sourceEnd: backbone.length,
      sourceLength: backbone.length,
      sourceIsCircular: true,
    });

    const result = await execDesignContract<{ drafted: boolean; regionCount: number }>(
      draftDesignAssemblyOutputSchema,
      draftDesignAssemblyTool,
      { designId }
    );

    expect(result).toMatchObject({ drafted: true, regionCount: 3 });
  });

  it('refuses stale expectedVersion values', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Stale', 'circular', 'gibson');
    store.addRegion(designId, region('fragment 1', 'ATCG'.repeat(50)));
    store.addRegion(designId, region('fragment 2', 'GCTA'.repeat(50)));

    const result = await execDesignContract<{
      drafted: boolean;
      error: string;
      refusal: { kind: string };
    }>(draftDesignAssemblyOutputSchema, draftDesignAssemblyTool, { designId, expectedVersion: 0 });

    expect(result.drafted).toBe(false);
    expect(result.error).toContain('changed');
    expect(result.refusal.kind).toBe('stale_state');
  });
});
