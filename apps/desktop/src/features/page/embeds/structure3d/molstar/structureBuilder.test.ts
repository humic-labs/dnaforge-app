import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { PluginStateObject as SO } from 'molstar/lib/mol-plugin-state/objects';
import {
  CachedParseCif,
  CachedTrajectoryFromMmCif,
  CachedTrajectoryFromPDB,
} from './decodedCoordinates';
import { fetchStructureData } from '../utils/structureData';
import {
  buildDetailContextChainTest,
  buildDetailedChainTargetTest,
  buildSelectionChainTest,
  buildDetailMembersChainTest,
  buildStructureWithComponents,
  buildRcsbScopeChainTest,
  loadStructure,
  syncActiveFocusPolymerComponents,
} from './structureBuilder';
import { polymerRepresentationTag } from './renderPlan';

vi.mock('../utils/structureData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/structureData')>();
  return {
    ...actual,
    fetchStructureData: vi.fn(),
    fetchStructureFromUrl: vi.fn(),
  };
});

const fetchStructureDataMock = vi.mocked(fetchStructureData);

beforeEach(() => {
  fetchStructureDataMock.mockReset();
});

function makePlugin(components?: Array<{ label: string; ref: string }>) {
  const cameraSnapshot = {
    position: [1, 2, 3],
    target: [4, 5, 6],
    up: [0, 1, 0],
    radius: 20,
  };
  const cameraGetSnapshot = vi.fn(() => cameraSnapshot);
  const cameraSetState = vi.fn();
  const addRepresentation = vi.fn().mockResolvedValue(undefined);
  const tryCreateComponentStatic = vi.fn().mockResolvedValue({ id: 'static-component' });
  const tryCreateComponentFromExpression = vi.fn((_structure, _expression, componentId: string) =>
    Promise.resolve(makeCreatedComponent(componentId))
  );
  const deleteRef = vi.fn();
  const commit = vi.fn().mockResolvedValue(undefined);
  const applyTransform = vi.fn((transform: unknown) => ({
    commit: vi.fn(async () =>
      transform === CachedParseCif
        ? { cell: { obj: { data: { blocks: [{ header: 'input-block' }] } } } }
        : { cell: { obj: { data: { frameCount: 1 } } } }
    ),
  }));
  const build = vi.fn(() => ({
    delete: deleteRef,
    commit,
    to: vi.fn(() => ({ apply: applyTransform })),
  }));
  const structures = [
    {
      id: 'hierarchy-structure',
      cell: { id: 'structure-cell' },
      components: (
        components ?? [
          { label: 'Structure Context', ref: 'context-ref' },
          { label: 'Active Focus', ref: 'focus-ref' },
          { label: 'Query Polymer', ref: 'query-ref' },
        ]
      ).map((component) => ({
        cell: {
          obj: { label: component.label },
          transform: { ref: component.ref },
        },
        representations: [],
      })),
    },
  ];
  return {
    builders: {
      data: {
        rawData: vi.fn(async ({ data, label }: { data: string | Uint8Array; label: string }) => ({
          ref: 'raw-data',
          obj:
            typeof data === 'string'
              ? new SO.Data.String(data, { label })
              : new SO.Data.Binary(data, { label }),
        })),
      },
      structure: {
        createModel: vi.fn().mockResolvedValue({ id: 'model' }),
        createStructure: vi.fn().mockResolvedValue({ id: 'structure' }),
        parseTrajectory: vi.fn().mockResolvedValue({ id: 'trajectory' }),
        tryCreateComponentStatic,
        tryCreateComponentFromExpression,
        representation: { addRepresentation },
      },
    },
    managers: {
      asset: { clearTag: vi.fn(), set: vi.fn() },
      structure: { hierarchy: { current: { structures } } },
    },
    state: { data: { build } },
    canvas3d: {
      setProps: vi.fn(),
      requestCameraReset: vi.fn(),
      camera: {
        getSnapshot: cameraGetSnapshot,
        setState: cameraSetState,
      },
    },
    __test: {
      addRepresentation,
      tryCreateComponentFromExpression,
      deleteRef,
      commit,
      build,
      applyTransform,
      cameraSnapshot,
      cameraGetSnapshot,
      cameraSetState,
    },
  };
}

function makeCreatedComponent(componentId: string): { id: string } {
  const component = { id: componentId };
  Object.defineProperty(component, 'ref', {
    value: componentId,
    enumerable: false,
  });
  return component;
}

describe('structureBuilder scoped components', () => {
  it('defers parsing and default styling when MolViewSpec owns the saved scene', async () => {
    const plugin = makePlugin([]);
    await loadStructure(
      plugin as never,
      { structureData: 'HEADER\nEND\n', structureDataFormat: 'pdb', coordinatesOnly: true },
      () => undefined
    );
    expect(plugin.builders.data.rawData).toHaveBeenCalledOnce();
    expect(plugin.builders.structure.parseTrajectory).not.toHaveBeenCalled();
    expect(plugin.__test.addRepresentation).not.toHaveBeenCalled();
  });

  it('uses the caller-supplied parser for file text instead of content sniffing', async () => {
    const plugin = makePlugin([]);
    const pdbTextWithCifWords = 'HEADER data_ and _atom_site are title words\nEND\n';

    await loadStructure(
      plugin as never,
      { structureData: pdbTextWithCifWords, structureDataFormat: 'pdb' },
      () => undefined
    );

    expect(plugin.builders.data.rawData).toHaveBeenCalledWith(
      { data: pdbTextWithCifWords, label: 'Uploaded Structure' },
      { state: { isGhost: true } }
    );
    expect(plugin.__test.applyTransform).toHaveBeenCalledWith(CachedTrajectoryFromPDB, {
      variant: 'pdb',
    });
    expect(plugin.__test.applyTransform).not.toHaveBeenCalledWith(
      CachedParseCif,
      expect.anything(),
      expect.anything()
    );
  });

  it('passes BinaryCIF bytes to Molstar rawData with the explicit mmCIF parser', async () => {
    const plugin = makePlugin([]);
    const bytes = new Uint8Array([131, 165, 100, 97, 116, 97, 1, 2, 3]);

    await loadStructure(
      plugin as never,
      { structureData: bytes, structureDataFormat: 'mmcif' },
      () => undefined
    );

    expect(plugin.builders.data.rawData).toHaveBeenCalledWith(
      { data: bytes, label: 'Uploaded Structure' },
      { state: { isGhost: true } }
    );
    expect(plugin.__test.applyTransform).toHaveBeenCalledWith(CachedParseCif, undefined, {
      state: { isGhost: true },
    });
    expect(plugin.__test.applyTransform).toHaveBeenCalledWith(CachedTrajectoryFromMmCif, {
      blockHeader: 'input-block',
    });
  });

  it('fetches full-entry bytes for scoped RCSB hits while building scoped components before first reveal', async () => {
    const plugin = makePlugin([]);
    fetchStructureDataMock.mockResolvedValue({ data: 'data_1fs0\n#', format: 'mmcif' });

    await loadStructure(
      plugin as never,
      {
        pdbId: '1fs0',
        structureIdentity: {
          provider: 'rcsb',
          externalId: 'RCSB:1FS0:ENTRY:AUTH_ASYM:G',
          fetchExternalId: 'RCSB:1FS0:ENTRY',
          format: 'mmcif',
          pdbId: '1FS0',
          authAsymIds: ['G'],
        },
      },
      () => undefined
    );

    const fetchIdentity = fetchStructureDataMock.mock.calls[0]?.[0];
    expect(fetchIdentity).toMatchObject({
      provider: 'rcsb',
      externalId: 'RCSB:1FS0:ENTRY:AUTH_ASYM:G',
      fetchExternalId: 'RCSB:1FS0:ENTRY',
      pdbId: '1FS0',
      authAsymIds: ['G'],
    });
    expect(plugin.builders.structure.tryCreateComponentStatic).not.toHaveBeenCalled();
    expect(
      plugin.builders.structure.tryCreateComponentFromExpression.mock.calls.map((call) => call[2])
    ).toEqual([
      'context-rcsb-polymer',
      'scoped-rcsb-polymer',
      'scoped-rcsb-ligand',
      'scoped-rcsb-ion',
      'scoped-rcsb-water',
    ]);
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure' },
      expect.anything(),
      'context-rcsb-polymer',
      { label: 'Structure Context' }
    );
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure' },
      expect.anything(),
      'scoped-rcsb-polymer',
      { label: 'Query Polymer' }
    );
  });

  it('keeps full scoped RCSB entries visible while coloring out-of-scope polymers grey', async () => {
    const plugin = makePlugin();

    await buildStructureWithComponents(
      plugin as never,
      { id: 'trajectory' },
      {
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:H',
        format: 'mmcif',
        pdbId: '1RBL',
        authAsymIds: ['H'],
      }
    );

    expect(
      plugin.builders.structure.tryCreateComponentFromExpression.mock.calls.map((call) => call[2])
    ).toEqual([
      'context-rcsb-polymer',
      'scoped-rcsb-polymer',
      'scoped-rcsb-ligand',
      'scoped-rcsb-ion',
      'scoped-rcsb-water',
    ]);
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure' },
      expect.anything(),
      'context-rcsb-polymer',
      { label: 'Structure Context' }
    );

    expect(plugin.builders.structure.representation.addRepresentation).toHaveBeenCalledWith(
      'context-rcsb-polymer',
      expect.objectContaining({
        type: 'cartoon',
        typeParams: expect.objectContaining({ sizeFactor: 0.2 }),
        color: 'chain-id',
        colorParams: expect.objectContaining({
          palette: expect.objectContaining({ name: 'colors' }),
        }),
      }),
      { tag: polymerRepresentationTag('context', 'primary') }
    );
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure' },
      expect.anything(),
      'scoped-rcsb-polymer',
      { label: 'Query Polymer' }
    );
    expect(plugin.builders.structure.representation.addRepresentation).toHaveBeenCalledWith(
      'scoped-rcsb-polymer',
      expect.objectContaining({
        type: 'cartoon',
        typeParams: expect.objectContaining({ sizeFactor: 0.2 }),
        color: 'chain-id',
      }),
      { tag: polymerRepresentationTag('query', 'primary') }
    );
    expect(plugin.builders.structure.representation.addRepresentation).toHaveBeenCalledWith(
      'scoped-rcsb-polymer',
      expect.objectContaining({
        type: 'ball-and-stick',
        typeParams: expect.objectContaining({
          sizeFactor: 0.15,
          sizeAspectRatio: 2 / 3,
          alpha: 0,
        }),
      }),
      { tag: polymerRepresentationTag('query', 'detail') }
    );
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure' },
      expect.anything(),
      'scoped-rcsb-ligand',
      { label: 'Ligand' }
    );
    const expressionByComponentId = new Map(
      plugin.builders.structure.tryCreateComponentFromExpression.mock.calls.map(
        ([, expression, componentId]) => [componentId, JSON.stringify(expression)] as const
      )
    );
    expect(expressionByComponentId.get('context-rcsb-polymer')).toContain('auth_asym_id');
    expect(expressionByComponentId.get('scoped-rcsb-polymer')).toContain('auth_asym_id');
    expect(expressionByComponentId.get('scoped-rcsb-ligand')).not.toContain('auth_asym_id');
    expect(expressionByComponentId.get('scoped-rcsb-ligand')).not.toContain('label_asym_id');
    expect(expressionByComponentId.get('scoped-rcsb-ion')).not.toContain('auth_asym_id');
    expect(expressionByComponentId.get('scoped-rcsb-ion')).not.toContain('label_asym_id');
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure' },
      expect.anything(),
      'scoped-rcsb-ion',
      { label: 'Ion' }
    );
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure' },
      expect.anything(),
      'scoped-rcsb-water',
      { label: 'Water' }
    );
    expect(plugin.builders.structure.tryCreateComponentStatic).not.toHaveBeenCalled();
    expect(plugin.builders.structure.representation.addRepresentation).toHaveBeenCalledTimes(6);
    for (const [, representationProps] of plugin.builders.structure.representation.addRepresentation
      .mock.calls) {
      expect(representationProps).not.toHaveProperty('colorTheme');
      expect(representationProps.typeParams).toMatchObject({
        ignoreHydrogens: true,
        ignoreHydrogensVariant: 'all',
      });
    }
  });

  it('combines direct scope identifiers with OR while preventing entity fallback from widening them', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orHead = (MS.core.logic.or([MS.core.rel.eq([1, 1]), MS.core.rel.eq([2, 2])]) as any).head;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const andHead = (MS.core.logic.and([MS.core.rel.eq([1, 1]), MS.core.rel.eq([2, 2])]) as any)
      .head;

    const multi = buildRcsbScopeChainTest({
      provider: 'rcsb',
      externalId: 'RCSB:1RBL:ENTITY:1',
      format: 'mmcif',
      pdbId: '1RBL',
      labelAsymIds: ['A'],
      authAsymIds: ['C'],
      pdbEntityId: '1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as any;
    expect(multi).not.toBeNull();
    expect(multi.head).toEqual(orHead);
    expect(multi.head).not.toEqual(andHead);
    expect(JSON.stringify(multi)).not.toContain('label_entity_id');

    const entityOnly = buildRcsbScopeChainTest({
      provider: 'rcsb',
      externalId: 'RCSB:1RBL:ENTITY:1',
      format: 'mmcif',
      pdbId: '1RBL',
      pdbEntityId: '1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as any;
    expect(entityOnly).not.toBeNull();
    expect(JSON.stringify(entityOnly)).toContain('label_entity_id');

    const single = buildRcsbScopeChainTest({
      provider: 'rcsb',
      externalId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:H',
      format: 'mmcif',
      pdbId: '1RBL',
      authAsymIds: ['H'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as any;
    expect(single).not.toBeNull();
    expect(single.head).not.toEqual(orHead);
    expect(single.head).not.toEqual(andHead);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(buildRcsbScopeChainTest({ provider: 'alphafold' } as any)).toBeNull();
  });

  it('builds member selection tests from direct chain identifiers before entity identifiers', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orHead = (MS.core.logic.or([MS.core.rel.eq([1, 1]), MS.core.rel.eq([2, 2])]) as any).head;
    const test = buildSelectionChainTest({
      entityIds: ['3'],
      labelAsymIds: ['C'],
      authAsymIds: ['E'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    expect(test).not.toBeNull();
    expect(test.head).toEqual(orHead);
    expect(JSON.stringify(test)).not.toContain('label_entity_id');

    const entityOnly = buildSelectionChainTest({
      entityIds: ['3'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    expect(entityOnly).not.toBeNull();
    expect(JSON.stringify(entityOnly)).toContain('label_entity_id');
  });

  it('does not treat chainIds-only as auth ids when explicit author-chain ids are present', () => {
    const explicitAuth = buildSelectionChainTest({
      authAsymIds: ['A'],
      chainIds: ['W'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const serializedExplicitAuth = JSON.stringify(explicitAuth);

    expect(serializedExplicitAuth).toContain('auth_asym_id');
    expect(serializedExplicitAuth).toContain('"A"');
    expect(serializedExplicitAuth).not.toContain('"W"');
    expect(serializedExplicitAuth).not.toContain('label_asym_id');

    const chainIdsOnly = buildSelectionChainTest({
      chainIds: ['W'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const serializedChainIdsOnly = JSON.stringify(chainIdsOnly);

    expect(serializedChainIdsOnly).toContain('auth_asym_id');
    expect(serializedChainIdsOnly).toContain('label_asym_id');
    expect(serializedChainIdsOnly).toContain('"W"');
  });

  it('builds detail chain target tests with explicit operator scope', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const andHead = (MS.core.logic.and([MS.core.rel.eq([1, 1]), MS.core.rel.eq([2, 2])]) as any)
      .head;
    const test = buildDetailedChainTargetTest({
      selection: {
        entityIds: ['2'],
        authAsymIds: ['X'],
        chainIds: ['A2'],
      },
      operator: 'ASM_2',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const serialized = JSON.stringify(test);

    expect(test).not.toBeNull();
    expect(test.head).toEqual(andHead);
    expect(serialized).toContain('auth_asym_id');
    expect(serialized).toContain('label_entity_id');
    expect(serialized).toContain('operator-name');
    expect(serialized).toContain('ASM_2');
    expect(serialized).not.toContain('A2');
  });

  it('narrows detail chain targets by entity before adding operator scope', () => {
    const test = buildDetailedChainTargetTest({
      selection: {
        entityIds: ['5'],
        labelAsymIds: ['g'],
        authAsymIds: ['G'],
        chainIds: ['g'],
      },
      operator: 'asm_1-g',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const serialized = JSON.stringify(test);

    expect(test).not.toBeNull();
    expect(serialized).toContain('label_asym_id');
    expect(serialized).toContain('auth_asym_id');
    expect(serialized).toContain('label_entity_id');
    expect(serialized).toContain('operator-name');
    expect(serialized).toContain('asm_1-g');
  });

  it('builds detail member tests from checked member ids only', () => {
    const scene = {
      schemaVersion: 1,
      sceneId: 'scene:1fs0',
      sceneKind: 'complex',
      primaryResourceId: 'RCSB:1FS0:ENTRY',
      queryAnchor: {
        memberId: 'member:atpG',
        targetSelection: { pdbId: '1FS0', entityIds: ['2'], authAsymIds: ['G'] },
      },
      members: [
        {
          memberId: 'member:atpG',
          kind: 'protein',
          displayName: 'atpG',
          selection: { pdbId: '1FS0', entityIds: ['2'], authAsymIds: ['G'] },
          mappingStatus: 'mapped_current_sequence',
        },
        {
          memberId: 'member:atpC',
          kind: 'protein',
          displayName: 'atpC',
          selection: { pdbId: '1FS0', entityIds: ['3'], authAsymIds: ['E'] },
          mappingStatus: 'unmapped',
        },
      ],
      layers: [],
      provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const test = buildDetailMembersChainTest(scene, ['member:atpC']);
    expect(test).not.toBeNull();
    expect(buildDetailMembersChainTest(scene, [])).toBeNull();
  });

  it('builds detail context tests that exclude visible detail chains', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notHead = (MS.core.logic.not([MS.core.rel.eq([1, 1])]) as any).head;
    const test = buildDetailContextChainTest([
      {
        selection: {
          entityIds: ['2'],
          labelAsymIds: ['G'],
          authAsymIds: ['G'],
          chainIds: ['G'],
        },
        operator: 'ASM_1',
      },
    ]) as any;
    const serialized = JSON.stringify(test);

    expect(test.head).toEqual(notHead);
    expect(serialized).toContain('label_asym_id');
    expect(serialized).toContain('auth_asym_id');
    expect(serialized).toContain('"G"');
  });

  it('syncs an active-focus polymer component and rebuilds context to exclude query plus focus', async () => {
    const plugin = makePlugin();

    await syncActiveFocusPolymerComponents(plugin as never, {
      schemaVersion: 1,
      sceneId: 'scene:1fs0',
      sceneKind: 'complex',
      primaryResourceId: 'RCSB:1FS0:ENTRY',
      queryAnchor: {
        memberId: 'member:atpG',
        targetSelection: { pdbId: '1FS0', entityIds: ['2'], authAsymIds: ['G'] },
      },
      activeFocus: {
        memberId: 'member:atpC',
        role: 'partner',
        mappingStatus: 'mapped_workspace',
        selection: { pdbId: '1FS0', entityIds: ['3'], authAsymIds: ['E'] },
      },
      members: [],
      layers: [],
      provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
    });

    expect(plugin.__test.deleteRef).toHaveBeenCalledWith('context-ref');
    expect(plugin.__test.deleteRef).toHaveBeenCalledWith('focus-ref');
    expect(plugin.__test.deleteRef).toHaveBeenCalledWith('query-ref');
    expect(plugin.__test.commit).toHaveBeenCalledTimes(1);
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure-cell' },
      expect.anything(),
      'scoped-rcsb-polymer',
      { label: 'Query Polymer' }
    );
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure-cell' },
      expect.anything(),
      'context-rcsb-polymer',
      { label: 'Structure Context' }
    );
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure-cell' },
      expect.anything(),
      'active-focus-rcsb-polymer',
      { label: 'Active Focus' }
    );
    expect(plugin.builders.structure.representation.addRepresentation).toHaveBeenCalledWith(
      'active-focus-rcsb-polymer',
      expect.objectContaining({ type: 'cartoon' }),
      { tag: polymerRepresentationTag('focus', 'primary') }
    );
    expect(plugin.builders.structure.representation.addRepresentation).toHaveBeenCalledWith(
      'active-focus-rcsb-polymer',
      expect.objectContaining({ type: 'ball-and-stick' }),
      { tag: polymerRepresentationTag('focus', 'detail') }
    );
  });

  it('removes stale broad polymer components before preparing stable detail member components', async () => {
    const plugin = makePlugin([
      { label: 'Polymer', ref: 'polymer-ref' },
      { label: 'Structure Context', ref: 'context-ref' },
      { label: 'Active Focus', ref: 'focus-ref' },
      { label: 'Query Polymer', ref: 'query-ref' },
    ]);

    await syncActiveFocusPolymerComponents(
      plugin as never,
      {
        schemaVersion: 1,
        sceneId: 'scene:1fs0',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:1FS0:ENTRY',
        queryAnchor: {
          memberId: 'member:atpG',
          targetSelection: { pdbId: '1FS0', entityIds: ['2'], authAsymIds: ['G'] },
        },
        activeFocus: {
          memberId: 'member:atpC',
          role: 'partner',
          mappingStatus: 'mapped_workspace',
          selection: { pdbId: '1FS0', entityIds: ['3'], authAsymIds: ['E'] },
        },
        members: [
          {
            memberId: 'member:atpG',
            kind: 'protein',
            displayName: 'atpG',
            selection: { pdbId: '1FS0', entityIds: ['2'], authAsymIds: ['G'] },
            relationToAnchor: 'query',
            mappingStatus: 'mapped_current_sequence',
          },
          {
            memberId: 'member:atpC',
            kind: 'protein',
            displayName: 'atpC',
            selection: { pdbId: '1FS0', entityIds: ['3'], authAsymIds: ['E'] },
            relationToAnchor: 'known_partner',
            mappingStatus: 'unmapped',
          },
        ],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      },
      () => true,
      ['member:atpG', 'member:atpC']
    );

    expect(
      plugin.builders.structure.tryCreateComponentFromExpression.mock.calls.map((call) => call[2])
    ).toEqual([
      'stable-detail-context-rcsb-polymer',
      'detail-member-rcsb-polymer-member-atpG',
      'detail-member-rcsb-polymer-member-atpC',
    ]);
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure-cell' },
      expect.anything(),
      'stable-detail-context-rcsb-polymer',
      { label: 'Structure Detail Context' }
    );
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure-cell' },
      expect.anything(),
      'detail-member-rcsb-polymer-member-atpG',
      { label: 'Detail Member: member:atpG' }
    );
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure-cell' },
      expect.anything(),
      'detail-member-rcsb-polymer-member-atpC',
      { label: 'Detail Member: member:atpC' }
    );
    expect(plugin.builders.structure.tryCreateComponentFromExpression).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'active-focus-rcsb-polymer',
      expect.anything()
    );
    expect(plugin.__test.deleteRef.mock.calls.map((call) => call[0])).toEqual([
      'polymer-ref',
      'context-ref',
      'focus-ref',
      'query-ref',
    ]);
    expect(plugin.__test.cameraGetSnapshot).toHaveBeenCalled();
    expect(plugin.__test.cameraSetState).toHaveBeenCalledWith(plugin.__test.cameraSnapshot, 0);
    expect(plugin.canvas3d.requestCameraReset).not.toHaveBeenCalled();
  });

  it('prepares stable per-chain context plus detail components when render targets are supplied', async () => {
    const plugin = makePlugin();

    await syncActiveFocusPolymerComponents(
      plugin as never,
      {
        schemaVersion: 1,
        sceneId: 'scene:6ybu',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:6YBU:ENTRY',
        queryAnchor: {
          memberId: 'member:bcsE',
          targetSelection: { pdbId: '6YBU', entityIds: ['3'], authAsymIds: ['E', 'F'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      },
      () => true,
      ['member:bcsE'],
      [
        {
          targetId: 'e-c-3-asm_1-c',
          memberId: 'member:bcsE',
          selection: {
            pdbId: '6YBU',
            entityIds: ['3'],
            labelAsymIds: ['C'],
            authAsymIds: ['E'],
            chainIds: ['C'],
          },
          operator: 'ASM_1',
          visible: true,
          color: 0x8a2be2,
        },
        {
          targetId: 'f-d-3-asm_1-d',
          memberId: 'member:bcsE',
          selection: {
            pdbId: '6YBU',
            entityIds: ['3'],
            labelAsymIds: ['D'],
            authAsymIds: ['F'],
            chainIds: ['D'],
          },
          operator: 'ASM_1',
          visible: false,
          color: 0x00a6d6,
        },
      ]
    );

    expect(
      plugin.builders.structure.tryCreateComponentFromExpression.mock.calls.map((call) => call[2])
    ).toEqual([
      'detail-chain-rcsb-polymer-e-c-3-asm_1-c',
      'detail-context-chain-rcsb-polymer-e-c-3-asm_1-c',
      'detail-chain-rcsb-polymer-f-d-3-asm_1-d',
      'detail-context-chain-rcsb-polymer-f-d-3-asm_1-d',
    ]);
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure-cell' },
      expect.anything(),
      'detail-chain-rcsb-polymer-e-c-3-asm_1-c',
      { label: 'Detail Chain: e-c-3-asm_1-c' }
    );
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure-cell' },
      expect.anything(),
      'detail-context-chain-rcsb-polymer-e-c-3-asm_1-c',
      { label: 'Detail Context Chain: e-c-3-asm_1-c' }
    );
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure-cell' },
      expect.anything(),
      'detail-chain-rcsb-polymer-f-d-3-asm_1-d',
      { label: 'Detail Chain: f-d-3-asm_1-d' }
    );
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      { id: 'structure-cell' },
      expect.anything(),
      'detail-context-chain-rcsb-polymer-f-d-3-asm_1-d',
      { label: 'Detail Context Chain: f-d-3-asm_1-d' }
    );
    const detailExpressions = plugin.builders.structure.tryCreateComponentFromExpression.mock.calls
      .filter((call) => String(call[2]).includes('chain-rcsb-polymer-'))
      .map((call) => JSON.stringify(call[1]));
    expect(detailExpressions).toHaveLength(4);
    for (const expression of detailExpressions) {
      expect(expression).toContain('entity-test');
      expect(expression).toContain('chain-test');
      expect(expression).toContain('entity-type');
      expect(expression).not.toContain('label_entity_id');
      expect(expression).not.toContain('atom-test');
    }

    const representationCalls =
      plugin.builders.structure.representation.addRepresentation.mock.calls;
    expect(representationCalls).toContainEqual([
      'detail-chain-rcsb-polymer-e-c-3-asm_1-c',
      expect.objectContaining({
        type: 'cartoon',
        typeParams: expect.not.objectContaining({ alpha: 0 }),
      }),
      { tag: polymerRepresentationTag('query', 'primary') },
    ]);
    expect(representationCalls).toContainEqual([
      'detail-chain-rcsb-polymer-f-d-3-asm_1-d',
      expect.objectContaining({
        type: 'cartoon',
        typeParams: expect.objectContaining({ alpha: 0 }),
      }),
      { tag: polymerRepresentationTag('query', 'primary') },
    ]);
    expect(representationCalls).toContainEqual([
      'detail-context-chain-rcsb-polymer-e-c-3-asm_1-c',
      expect.objectContaining({
        type: 'cartoon',
        typeParams: expect.objectContaining({ alpha: 0 }),
      }),
      { tag: polymerRepresentationTag('context', 'primary') },
    ]);
    expect(representationCalls).toContainEqual([
      'detail-context-chain-rcsb-polymer-f-d-3-asm_1-d',
      expect.objectContaining({
        type: 'cartoon',
        typeParams: expect.not.objectContaining({ alpha: 0 }),
      }),
      { tag: polymerRepresentationTag('context', 'primary') },
    ]);
  });

  it('preserves broad surface-owner components when preparing per-chain detail targets', async () => {
    const plugin = makePlugin([
      { label: 'Structure Context', ref: 'context-ref' },
      { label: 'Query Polymer', ref: 'query-ref' },
    ]);

    await syncActiveFocusPolymerComponents(
      plugin as never,
      {
        schemaVersion: 1,
        sceneId: 'scene:6ybu-surface-owner-preserve',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:6YBU:ENTRY',
        queryAnchor: {
          memberId: 'member:bcsE',
          targetSelection: { pdbId: '6YBU', entityIds: ['3'], authAsymIds: ['E', 'F'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      },
      () => true,
      ['member:bcsE'],
      [
        {
          targetId: 'e-c-3-asm_1-c',
          memberId: 'member:bcsE',
          selection: {
            pdbId: '6YBU',
            entityIds: ['3'],
            labelAsymIds: ['C'],
            authAsymIds: ['E'],
            chainIds: ['C'],
          },
          operator: 'ASM_1',
          visible: true,
          color: 0x8a2be2,
        },
      ]
    );

    expect(plugin.__test.deleteRef).not.toHaveBeenCalledWith('context-ref');
    expect(plugin.__test.deleteRef).not.toHaveBeenCalledWith('query-ref');
    expect(plugin.__test.deleteRef).not.toHaveBeenCalled();
  });

  it('creates a scoped detail-context fallback when MolStar rejects per-chain context components', async () => {
    const plugin = makePlugin([{ label: 'Structure Detail Context', ref: 'stale-context-ref' }]);
    plugin.builders.structure.tryCreateComponentFromExpression.mockImplementation(
      (_structure, _expression, componentId: string) => {
        if (componentId.startsWith('detail-context-chain-rcsb-polymer-')) {
          return Promise.resolve(undefined);
        }
        return Promise.resolve(makeCreatedComponent(componentId));
      }
    );

    await syncActiveFocusPolymerComponents(
      plugin as never,
      {
        schemaVersion: 1,
        sceneId: 'scene:ribosome-context-fallback',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:7ZP8:ENTRY',
        queryAnchor: {
          memberId: 'member:query',
          targetSelection: { pdbId: '7ZP8', entityIds: ['10'], authAsymIds: ['J'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      },
      () => true,
      ['member:query'],
      [
        {
          targetId: 'b-j-10-asm_1-j',
          memberId: 'member:query',
          selection: {
            pdbId: '7ZP8',
            entityIds: ['10'],
            labelAsymIds: ['J'],
            authAsymIds: ['b'],
            chainIds: ['J'],
          },
          operator: 'ASM_1',
          visible: true,
          color: 0x8a2be2,
        },
        {
          targetId: 'z-fa-32-asm_1-fa',
          memberId: 'member:context',
          selection: {
            pdbId: '7ZP8',
            entityIds: ['32'],
            labelAsymIds: ['FA'],
            authAsymIds: ['z'],
            chainIds: ['FA'],
          },
          operator: 'ASM_1',
          visible: false,
          color: 0x00a6d6,
        },
      ]
    );

    const componentIds = plugin.builders.structure.tryCreateComponentFromExpression.mock.calls.map(
      (call) => call[2]
    );
    expect(componentIds).toEqual(
      expect.arrayContaining([
        'detail-chain-rcsb-polymer-b-j-10-asm_1-j',
        'detail-context-chain-rcsb-polymer-b-j-10-asm_1-j',
        'detail-chain-rcsb-polymer-z-fa-32-asm_1-fa',
        'detail-context-chain-rcsb-polymer-z-fa-32-asm_1-fa',
        'stable-detail-context-rcsb-polymer',
      ])
    );
    expect(componentIds.filter((id) => id === 'stable-detail-context-rcsb-polymer')).toHaveLength(
      1
    );
    expect(plugin.__test.deleteRef).toHaveBeenCalledWith('stale-context-ref');
    const fallbackCall = plugin.builders.structure.tryCreateComponentFromExpression.mock.calls.find(
      (call) => call[2] === 'stable-detail-context-rcsb-polymer'
    );
    const fallbackExpression = JSON.stringify(fallbackCall?.[1]);
    expect(fallbackExpression).toContain('core.logic.not');
    expect(fallbackExpression).toContain('ASM_1');
    expect(fallbackExpression).toContain('10');
    expect(fallbackExpression).toContain('J');
    expect(fallbackExpression).not.toContain('32');
    expect(fallbackExpression).not.toContain('FA');
    expect(plugin.builders.structure.representation.addRepresentation.mock.calls).toContainEqual([
      'stable-detail-context-rcsb-polymer',
      expect.objectContaining({
        type: 'cartoon',
        typeParams: expect.not.objectContaining({ alpha: 0 }),
      }),
      { tag: polymerRepresentationTag('context', 'primary') },
    ]);
  });

  it('does not create a scoped detail-context fallback for a missing hidden selected-chain context component', async () => {
    const plugin = makePlugin([{ label: 'Structure Detail Context', ref: 'stale-context-ref' }]);
    plugin.builders.structure.tryCreateComponentFromExpression.mockImplementation(
      (_structure, _expression, componentId: string) => {
        if (componentId === 'detail-context-chain-rcsb-polymer-b-j-10-asm_1-j') {
          return Promise.resolve(undefined);
        }
        return Promise.resolve(makeCreatedComponent(componentId));
      }
    );

    await syncActiveFocusPolymerComponents(
      plugin as never,
      {
        schemaVersion: 1,
        sceneId: 'scene:selected-context-missing-no-fallback',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:7ZP8:ENTRY',
        queryAnchor: {
          memberId: 'member:query',
          targetSelection: { pdbId: '7ZP8', entityIds: ['10'], authAsymIds: ['J'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      },
      () => true,
      ['member:query'],
      [
        {
          targetId: 'b-j-10-asm_1-j',
          memberId: 'member:query',
          selection: {
            pdbId: '7ZP8',
            entityIds: ['10'],
            labelAsymIds: ['J'],
            authAsymIds: ['b'],
            chainIds: ['J'],
          },
          operator: 'ASM_1',
          visible: true,
          color: 0x8a2be2,
        },
        {
          targetId: 'z-fa-32-asm_1-fa',
          memberId: 'member:context',
          selection: {
            pdbId: '7ZP8',
            entityIds: ['32'],
            labelAsymIds: ['FA'],
            authAsymIds: ['z'],
            chainIds: ['FA'],
          },
          operator: 'ASM_1',
          visible: false,
          color: 0x00a6d6,
        },
      ]
    );

    const componentIds = plugin.builders.structure.tryCreateComponentFromExpression.mock.calls.map(
      (call) => call[2]
    );
    expect(componentIds).toEqual(
      expect.arrayContaining([
        'detail-chain-rcsb-polymer-b-j-10-asm_1-j',
        'detail-context-chain-rcsb-polymer-b-j-10-asm_1-j',
        'detail-chain-rcsb-polymer-z-fa-32-asm_1-fa',
        'detail-context-chain-rcsb-polymer-z-fa-32-asm_1-fa',
      ])
    );
    expect(componentIds).not.toContain('stable-detail-context-rcsb-polymer');
    expect(plugin.__test.deleteRef).toHaveBeenCalledWith('stale-context-ref');
    expect(plugin.builders.structure.representation.addRepresentation.mock.calls).toContainEqual([
      'detail-context-chain-rcsb-polymer-z-fa-32-asm_1-fa',
      expect.objectContaining({
        type: 'cartoon',
        typeParams: expect.not.objectContaining({ alpha: 0 }),
      }),
      { tag: polymerRepresentationTag('context', 'primary') },
    ]);
  });

  it('prepares stable per-chain context/detail components instead of a selector-rebuilt detail context', async () => {
    const plugin = makePlugin();

    await syncActiveFocusPolymerComponents(
      plugin as never,
      {
        schemaVersion: 1,
        sceneId: 'scene:6ybu-stable-chain-components',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:6YBU:ENTRY',
        queryAnchor: {
          memberId: 'member:bcsE',
          targetSelection: { pdbId: '6YBU', entityIds: ['3'], authAsymIds: ['E', 'F'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      },
      () => true,
      ['member:bcsE'],
      [
        {
          targetId: 'e-c-3-asm_1-c',
          memberId: 'member:bcsE',
          selection: {
            pdbId: '6YBU',
            entityIds: ['3'],
            labelAsymIds: ['C'],
            authAsymIds: ['E'],
            chainIds: ['C'],
          },
          operator: 'ASM_1',
          visible: true,
          color: 0x8a2be2,
        },
        {
          targetId: 'f-d-3-asm_1-d',
          memberId: 'member:bcsE',
          selection: {
            pdbId: '6YBU',
            entityIds: ['3'],
            labelAsymIds: ['D'],
            authAsymIds: ['F'],
            chainIds: ['D'],
          },
          operator: 'ASM_1',
          visible: false,
          color: 0x00a6d6,
        },
      ]
    );

    expect(
      plugin.builders.structure.tryCreateComponentFromExpression.mock.calls.map((call) => call[3])
    ).toEqual([
      { label: 'Detail Chain: e-c-3-asm_1-c' },
      { label: 'Detail Context Chain: e-c-3-asm_1-c' },
      { label: 'Detail Chain: f-d-3-asm_1-d' },
      { label: 'Detail Context Chain: f-d-3-asm_1-d' },
    ]);
  });

  it('uses the refreshed hierarchy structure cell after deleting stale broad components for per-chain detail targets', async () => {
    const plugin = makePlugin([
      { label: 'Polymer', ref: 'polymer-ref' },
      { label: 'Structure Context', ref: 'context-ref' },
      { label: 'Active Focus', ref: 'focus-ref' },
      { label: 'Query Polymer', ref: 'query-ref' },
    ]);
    const refreshedStructure = {
      id: 'refreshed-hierarchy-structure',
      cell: { id: 'refreshed-structure-cell' },
      components: [],
    };
    plugin.__test.commit.mockImplementation(async () => {
      plugin.managers.structure.hierarchy.current.structures = [refreshedStructure];
    });

    await syncActiveFocusPolymerComponents(
      plugin as never,
      {
        schemaVersion: 1,
        sceneId: 'scene:3oaa-metadata-poor',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:3OAA:ENTRY',
        queryAnchor: {
          memberId: 'member:atpG',
          targetSelection: { pdbId: '3OAA', entityIds: ['25'], authAsymIds: ['G'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      },
      () => true,
      ['member:atpG'],
      [
        {
          targetId: 'g-g-25-asm_1-g',
          memberId: 'member:atpG',
          selection: {
            pdbId: '3OAA',
            entityIds: ['25'],
            labelAsymIds: ['G'],
            authAsymIds: ['G'],
            chainIds: ['G'],
          },
          operator: 'ASM_1',
          visible: true,
          color: 0xff00a8,
        },
      ]
    );

    const creationSources =
      plugin.builders.structure.tryCreateComponentFromExpression.mock.calls.map((call) => call[0]);
    expect(creationSources).toEqual([
      { id: 'refreshed-structure-cell' },
      { id: 'refreshed-structure-cell' },
    ]);
  });

  it('does not create duplicate per-chain context components for identical MolStar selections', async () => {
    const plugin = makePlugin([]);
    plugin.builders.structure.tryCreateComponentFromExpression.mockImplementation(
      (_structure, _expression, componentId: string) =>
        Promise.resolve(makeCreatedComponent(componentId))
    );

    await syncActiveFocusPolymerComponents(
      plugin as never,
      {
        schemaVersion: 1,
        sceneId: 'scene:6ybu-realized-context',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:6YBU:ENTRY',
        queryAnchor: {
          memberId: 'member:bcsE',
          targetSelection: { pdbId: '6YBU', entityIds: ['3'], authAsymIds: ['E'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      },
      () => true,
      ['member:bcsE'],
      [
        {
          targetId: 'e-c-3-asm_1-c',
          memberId: 'member:bcsE',
          selection: {
            pdbId: '6YBU',
            entityIds: ['3'],
            labelAsymIds: ['C'],
            authAsymIds: ['E'],
            chainIds: ['C'],
          },
          operator: 'ASM_1',
          visible: true,
          color: 0x8a2be2,
        },
      ]
    );

    expect(
      plugin.builders.structure.tryCreateComponentFromExpression.mock.calls.map((call) => call[3])
    ).toEqual([
      { label: 'Detail Chain: e-c-3-asm_1-c' },
      { label: 'Detail Context Chain: e-c-3-asm_1-c' },
    ]);
  });

  it('adds missing representations to realized detail chain components by ref', async () => {
    const plugin = makePlugin([{ label: 'Detail Chain: e-c-3-asm_1-c', ref: 'detail-e-ref' }]);
    plugin.builders.structure.tryCreateComponentFromExpression.mockImplementation(
      (_structure, _expression, componentId: string) =>
        Promise.resolve(makeCreatedComponent(componentId))
    );

    await syncActiveFocusPolymerComponents(
      plugin as never,
      {
        schemaVersion: 1,
        sceneId: 'scene:6ybu-realized-detail-chain',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:6YBU:ENTRY',
        queryAnchor: {
          memberId: 'member:bcsE',
          targetSelection: { pdbId: '6YBU', entityIds: ['3'], authAsymIds: ['E'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      },
      () => true,
      ['member:bcsE'],
      [
        {
          targetId: 'e-c-3-asm_1-c',
          memberId: 'member:bcsE',
          selection: {
            pdbId: '6YBU',
            entityIds: ['3'],
            labelAsymIds: ['C'],
            authAsymIds: ['E'],
            chainIds: ['C'],
          },
          operator: 'ASM_1',
          visible: true,
          color: 0x8a2be2,
        },
      ]
    );

    expect(plugin.builders.structure.representation.addRepresentation).toHaveBeenCalledWith(
      'detail-e-ref',
      expect.objectContaining({
        type: 'cartoon',
        typeParams: expect.not.objectContaining({ alpha: 0 }),
      }),
      { tag: polymerRepresentationTag('query', 'primary') }
    );
  });

  it('removes stale broad detail context without rebuilding selector-owned chain components on checkbox visibility changes', async () => {
    const plugin = makePlugin([
      { label: 'Structure Detail Context', ref: 'detail-context-ref' },
      { label: 'Detail Chain: e-c-3-asm_1-c', ref: 'detail-e-ref' },
      { label: 'Detail Context Chain: e-c-3-asm_1-c', ref: 'context-e-ref' },
      { label: 'Detail Chain: f-d-3-asm_1-d', ref: 'detail-f-ref' },
      { label: 'Detail Context Chain: f-d-3-asm_1-d', ref: 'context-f-ref' },
    ]);
    const scene = {
      schemaVersion: 1,
      sceneId: 'scene:6ybu-stable-chain-toggle',
      sceneKind: 'complex',
      primaryResourceId: 'RCSB:6YBU:ENTRY',
      queryAnchor: {
        memberId: 'member:bcsE',
        targetSelection: { pdbId: '6YBU', entityIds: ['3'], authAsymIds: ['E', 'F'] },
      },
      members: [],
      layers: [],
      provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const baseTargets = [
      {
        targetId: 'e-c-3-asm_1-c',
        memberId: 'member:bcsE',
        selection: {
          pdbId: '6YBU',
          entityIds: ['3'],
          labelAsymIds: ['C'],
          authAsymIds: ['E'],
          chainIds: ['C'],
        },
        operator: 'ASM_1',
        visible: true,
        color: 0x8a2be2,
      },
      {
        targetId: 'f-d-3-asm_1-d',
        memberId: 'member:bcsE',
        selection: {
          pdbId: '6YBU',
          entityIds: ['3'],
          labelAsymIds: ['D'],
          authAsymIds: ['F'],
          chainIds: ['D'],
        },
        operator: 'ASM_1',
        visible: false,
        color: 0x00a6d6,
      },
    ];

    await syncActiveFocusPolymerComponents(
      plugin as never,
      scene,
      () => true,
      ['member:bcsE'],
      baseTargets
    );

    expect(plugin.__test.deleteRef).toHaveBeenCalledWith('detail-context-ref');
    expect(plugin.__test.deleteRef).not.toHaveBeenCalledWith('detail-e-ref');
    expect(plugin.__test.deleteRef).not.toHaveBeenCalledWith('context-e-ref');
    expect(plugin.__test.deleteRef).not.toHaveBeenCalledWith('detail-f-ref');
    expect(plugin.__test.deleteRef).not.toHaveBeenCalledWith('context-f-ref');
    expect(plugin.builders.structure.tryCreateComponentFromExpression).not.toHaveBeenCalled();

    plugin.managers.structure.hierarchy.current.structures[0].components =
      plugin.managers.structure.hierarchy.current.structures[0].components.filter(
        (component) => component.cell.obj.label !== 'Structure Detail Context'
      );
    plugin.__test.deleteRef.mockClear();
    plugin.builders.structure.tryCreateComponentFromExpression.mockClear();
    await syncActiveFocusPolymerComponents(
      plugin as never,
      scene,
      () => true,
      ['member:bcsE'],
      [baseTargets[0], { ...baseTargets[1], visible: true }]
    );

    expect(plugin.__test.deleteRef).not.toHaveBeenCalled();
    expect(plugin.builders.structure.tryCreateComponentFromExpression).not.toHaveBeenCalled();
  });

  it('does not rebuild selector-owned chain detail components when checkbox visibility changes', async () => {
    const plugin = makePlugin([
      { label: 'Detail Chain: e-c-3-asm_1-c', ref: 'detail-e-ref' },
      { label: 'Detail Context Chain: e-c-3-asm_1-c', ref: 'context-e-ref' },
      { label: 'Detail Chain: f-d-3-asm_1-d', ref: 'detail-f-ref' },
      { label: 'Detail Context Chain: f-d-3-asm_1-d', ref: 'context-f-ref' },
    ]);
    const scene = {
      schemaVersion: 1,
      sceneId: 'scene:6ybu-no-toggle-rebuild',
      sceneKind: 'complex',
      primaryResourceId: 'RCSB:6YBU:ENTRY',
      queryAnchor: {
        memberId: 'member:bcsE',
        targetSelection: { pdbId: '6YBU', entityIds: ['3'], authAsymIds: ['E', 'F'] },
      },
      members: [],
      layers: [],
      provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const baseTargets = [
      {
        targetId: 'e-c-3-asm_1-c',
        memberId: 'member:bcsE',
        selection: {
          pdbId: '6YBU',
          entityIds: ['3'],
          labelAsymIds: ['C'],
          authAsymIds: ['E'],
          chainIds: ['C'],
        },
        operator: 'ASM_1',
        visible: true,
        color: 0x8a2be2,
      },
      {
        targetId: 'f-d-3-asm_1-d',
        memberId: 'member:bcsE',
        selection: {
          pdbId: '6YBU',
          entityIds: ['3'],
          labelAsymIds: ['D'],
          authAsymIds: ['F'],
          chainIds: ['D'],
        },
        operator: 'ASM_1',
        visible: false,
        color: 0x00a6d6,
      },
    ];

    await syncActiveFocusPolymerComponents(
      plugin as never,
      scene,
      () => true,
      ['member:bcsE'],
      baseTargets
    );

    plugin.__test.deleteRef.mockClear();
    plugin.builders.structure.tryCreateComponentFromExpression.mockClear();
    await syncActiveFocusPolymerComponents(
      plugin as never,
      scene,
      () => true,
      ['member:bcsE'],
      [baseTargets[0], { ...baseTargets[1], visible: true }]
    );

    expect(plugin.__test.deleteRef).not.toHaveBeenCalled();
    expect(plugin.builders.structure.tryCreateComponentFromExpression).not.toHaveBeenCalled();
  });

  it('rebuilds the detail context when selection changes without rebuilding selected detail components', async () => {
    const plugin = makePlugin([
      { label: 'Structure Detail Context', ref: 'old-detail-context-ref' },
      { label: 'Detail Member: member:atpG', ref: 'old-atpg-ref' },
      { label: 'Detail Member: member:atpC', ref: 'old-atpc-ref' },
    ]);
    const scene = {
      schemaVersion: 1,
      sceneId: 'scene:1fs0-stale-detail',
      sceneKind: 'complex',
      primaryResourceId: 'RCSB:1FS0:ENTRY',
      queryAnchor: {
        memberId: 'member:atpG',
        targetSelection: {
          pdbId: '1FS0',
          entityIds: ['2'],
          authAsymIds: ['G'],
          chainIds: ['G'],
        },
      },
      members: [
        {
          memberId: 'member:atpG',
          kind: 'protein',
          displayName: 'atpG',
          selection: {
            pdbId: '1FS0',
            entityIds: ['2'],
            authAsymIds: ['G'],
            chainIds: ['G'],
          },
          relationToAnchor: 'query',
          mappingStatus: 'mapped_current_sequence',
        },
        {
          memberId: 'member:atpC',
          kind: 'protein',
          displayName: 'atpC',
          selection: { pdbId: '1FS0', entityIds: ['3'], authAsymIds: ['E'], chainIds: ['E'] },
          relationToAnchor: 'known_partner',
          mappingStatus: 'unmapped',
        },
      ],
      layers: [],
      provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await syncActiveFocusPolymerComponents(plugin as never, scene, () => true, ['member:atpG']);

    expect(plugin.__test.deleteRef).toHaveBeenCalledWith('old-detail-context-ref');
    expect(plugin.__test.deleteRef).toHaveBeenCalledWith('old-atpc-ref');
    expect(plugin.__test.deleteRef).not.toHaveBeenCalledWith('old-atpg-ref');
    expect(
      plugin.builders.structure.tryCreateComponentFromExpression.mock.calls.map((call) => call[2])
    ).toEqual(['stable-detail-context-rcsb-polymer']);

    plugin.__test.deleteRef.mockClear();
    plugin.builders.structure.tryCreateComponentFromExpression.mockClear();
    await syncActiveFocusPolymerComponents(plugin as never, scene, () => true, ['member:atpG']);

    expect(plugin.__test.deleteRef).not.toHaveBeenCalled();
    expect(plugin.builders.structure.tryCreateComponentFromExpression).not.toHaveBeenCalled();
  });

  it('removes stale active-focus components when the new focus has no renderable chain selectors', async () => {
    const plugin = makePlugin();

    await syncActiveFocusPolymerComponents(plugin as never, {
      schemaVersion: 1,
      sceneId: 'scene:1fs0',
      sceneKind: 'complex',
      primaryResourceId: 'RCSB:1FS0:ENTRY',
      queryAnchor: {
        memberId: 'member:atpG',
        targetSelection: { pdbId: '1FS0', entityIds: ['2'], authAsymIds: ['G'] },
      },
      activeFocus: {
        memberId: 'member:unknown',
        role: 'partner',
        mappingStatus: 'unmapped',
        selection: { pdbId: '1FS0' },
      },
      members: [],
      layers: [],
      provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
    });

    expect(plugin.__test.deleteRef).toHaveBeenCalledWith('context-ref');
    expect(plugin.__test.deleteRef).toHaveBeenCalledWith('focus-ref');
    expect(plugin.__test.deleteRef).toHaveBeenCalledWith('query-ref');
    expect(
      plugin.builders.structure.tryCreateComponentFromExpression.mock.calls.map((call) => call[2])
    ).toEqual(['context-rcsb-polymer', 'scoped-rcsb-polymer']);
  });
});
