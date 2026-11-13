import { asSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import rendererToolManifest from '../../../../../../packages/core/agent-tools/renderer-tool-manifest.json';
import { DEFAULT_MOLECULAR_RENDER_PROFILE } from '../../page/public/embeds/structure3d/molstar/molecularRenderProfile';
import { molApplySceneSchema, molShowInteractionContextSchema } from './contracts';

describe('interaction-context tool contract', () => {
  it('accepts explicit question-driven interface detail without changing native contacts', () => {
    const seed = {
      structureViewId: 'view-1',
      selection: 'chain A',
      partnerSelection: 'chain B',
      presentationRole: 'interface',
      surfaceSide: 'partner',
    };
    for (const interfaceDetailSide of ['target', 'partner', 'both'])
      for (const interfaceDetailBasis of ['contacts', 'burial']) {
        const input = { ...seed, interfaceDetailSide, interfaceDetailBasis };
        expect(molShowInteractionContextSchema.parse(input)).toEqual(input);
      }
    for (const interfaceProteinAtomicMode of ['full-residue', 'sidechain-with-trace']) {
      const input = {
        ...seed,
        interfaceDetailSide: 'both',
        interfaceDetailBasis: 'burial',
        interfaceProteinAtomicMode,
      };
      expect(molShowInteractionContextSchema.parse(input)).toEqual(input);
    }
    expect(
      molShowInteractionContextSchema.safeParse({
        ...seed,
        presentationRole: 'binding-site',
        interfaceDetailSide: 'target',
      }).success
    ).toBe(false);
  });
  it('does not expose an escape for discarding deterministic contact evidence', () => {
    expect(
      molApplySceneSchema.safeParse({
        structureViewId: 'view-1',
        scene: '{}',
        discardInteractionContext: true,
      }).success
    ).toBe(false);
  });
  it('accepts exact source-scoped MVS selectors that distinguish physical coordinate copies', () => {
    const input = {
      structureViewId: 'view-1',
      sceneStructureRef: 'dnaforge:source:1',
      selection: { atom_index: 42, instance_id: 'ASM-X0-2' },
      targetSelection: { label_asym_id: 'A', instance_id: 'ASM-X0-2' },
      partnerSelection: [{ label_asym_id: 'B', instance_id: 'ASM-X0-2' }],
      presentationRole: 'interface',
      surfaceSide: 'target',
    };
    expect(molShowInteractionContextSchema.parse(input)).toEqual(input);
    expect(
      molShowInteractionContextSchema.safeParse({ ...input, sceneStructureRef: undefined }).success
    ).toBe(false);
    for (const selection of [
      {},
      [],
      [{ label_asym_id: 'A' }, {}],
      { label_asym_id: 'A', unknown: 'B' },
      { atom_index: -1 },
      Array.from({ length: 513 }, () => ({ atom_index: 1 })),
    ])
      expect(molShowInteractionContextSchema.safeParse({ ...input, selection }).success).toBe(
        false
      );
    expect(
      molShowInteractionContextSchema.safeParse({
        ...input,
        selection: Array.from({ length: 512 }, (_, atom_index) => ({ atom_index })),
      }).success
    ).toBe(true);
  });
  it('requires one existing view target and the shared bounded selection expression', () => {
    for (const target of ['structureViewId', 'bindingId', 'viewerId']) {
      expect(
        molShowInteractionContextSchema.safeParse({
          [target]: 'view-1',
          selection: 'chain A and resi 42',
        }).success
      ).toBe(true);
    }
    for (const input of [
      { selection: 'chain A' },
      { structureViewId: 'view-1', bindingId: 'binding-1', selection: 'chain A' },
      { structureViewId: 'view-1', selection: '' },
      { structureViewId: 'view-1', selection: 'x'.repeat(2001) },
      { structureViewId: 'view-1', selection: 'chain A', unknownOption: true },
    ]) {
      expect(molShowInteractionContextSchema.safeParse(input).success).toBe(false);
    }
  });

  it('requires an explicit single surface side and bounded scientific partner in the advertised request', () => {
    const seed = {
      structureViewId: 'view-1',
      selection: 'resn ATP',
      presentationRole: 'interface',
    };
    expect(molShowInteractionContextSchema.safeParse(seed).success).toBe(false);
    expect(
      molShowInteractionContextSchema.safeParse({
        ...seed,
        surfaceSide: 'both',
        partnerSelection: 'polymer',
      }).success
    ).toBe(false);
    expect(
      molShowInteractionContextSchema.safeParse({
        ...seed,
        surfaceSide: 'target',
        partnerSelection: 'polymer',
      }).success
    ).toBe(true);
    expect(
      molShowInteractionContextSchema.safeParse({
        ...seed,
        surfaceSide: 'partner',
        partnerSelection: 'x'.repeat(2001),
      }).success
    ).toBe(false);
  });

  it('forbids contact subsets and radius overrides while allowing measurement styling', () => {
    const seed = { structureViewId: 'view-1', selection: 'resn ATP' };
    expect(molShowInteractionContextSchema.parse(seed)).toEqual(seed);
    for (const maxMeasurements of [0, 6, 20]) {
      expect(
        molShowInteractionContextSchema.parse({ ...seed, maxMeasurements }).maxMeasurements
      ).toBe(maxMeasurements);
    }
    expect(
      molShowInteractionContextSchema.parse({ ...seed, focus: false, measurements: false })
    ).toMatchObject({ focus: false, measurements: false });
    for (const overrides of [
      { radius: 1 },
      { radius: 5 },
      { radius: 20 },
      { radius: 0.99 },
      { radius: 20.01 },
      { radius: NaN },
      { maxMeasurements: -1 },
      { maxMeasurements: 21 },
      { maxMeasurements: 1.5 },
      { focus: 'yes' },
      { measurements: 1 },
      { contactTypes: ['hydrogen-bonds'] },
      { detailMode: 'contact-residues' },
      { detailMode: 'neighborhood' },
    ]) {
      expect(molShowInteractionContextSchema.safeParse({ ...seed, ...overrides }).success).toBe(
        false
      );
    }
  });

  it('advertises the fixed viewer profile and complete native Focus construction in MCP', () => {
    for (const renderProfile of ['default']) {
      expect(
        molShowInteractionContextSchema.parse({
          structureViewId: 'view-1',
          selection: 'resn ATP',
          renderProfile,
        }).renderProfile
      ).toEqual(renderProfile);
    }
    for (const renderProfile of ['native', DEFAULT_MOLECULAR_RENDER_PROFILE]) {
      expect(
        molShowInteractionContextSchema.safeParse({
          structureViewId: 'view-1',
          selection: 'resn ATP',
          renderProfile,
        }).success
      ).toBe(false);
      expect(
        molApplySceneSchema.safeParse({
          structureViewId: 'view-1',
          scene: '{}',
          renderProfile,
        }).success
      ).toBe(false);
    }
    expect(
      molShowInteractionContextSchema.safeParse({
        structureViewId: 'view-1',
        selection: 'resn ATP',
        renderProfile: { ...DEFAULT_MOLECULAR_RENDER_PROFILE, unknownOption: true },
      }).success
    ).toBe(false);

    const advertised = rendererToolManifest.tools.find(
      (tool) => tool.name === 'mol_show_interaction_context'
    );
    expect(advertised).toBeDefined();
    const properties = advertised!.inputSchema.properties as Record<string, unknown>;
    expect(properties).not.toHaveProperty('contactTypes');
    expect(properties).not.toHaveProperty('detailMode');
    expect(properties).not.toHaveProperty('radius');
    const appliedProperties = asSchema(molApplySceneSchema).jsonSchema.properties as Record<
      string,
      unknown
    >;
    expect(properties.renderProfile).toEqual(appliedProperties.renderProfile);
    expect(advertised!.inputSchema).toMatchObject({
      required: ['selection'],
      oneOf: [
        { required: ['structureViewId'] },
        { required: ['bindingId'] },
        { required: ['viewerId'] },
      ],
    });
  });
});
