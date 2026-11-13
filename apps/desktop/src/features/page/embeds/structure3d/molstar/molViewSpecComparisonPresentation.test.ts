import type { MolecularProfileNode } from './nucleotidePresentationSettings';
import { describe, expect, it } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import {
  preserveSharedComparisonSources,
  readSharedComparisonRegistration,
} from './molViewSpecStructureIdentity';

function registrationFixture(sourceCount = 2) {
  const b = MVSData.createBuilder();
  const sources = Array.from({ length: sourceCount }, (_, i) => `source-${i}.cif`);
  for (const [i, uri] of sources.entries())
    b.download({ url: uri })
      .parse({ format: 'mmcif' })
      .modelStructure({ ref: `source-${i}` });
  const scene = b.getState();
  scene.root.custom = { dnaforge_comparison: { layout: 'shared-scene', sources } };
  return scene;
}

function addRecordedFit(scene: ReturnType<typeof registrationFixture>, mobile = 1, reference = 0) {
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const structure = scene.root.children![mobile].children![0].children![0];
  structure.children = [
    ...(structure.children ?? []).filter((node) => node.kind !== 'transform'),
    {
      kind: 'transform',
      params: { matrix },
      custom: {
        dnaforge_alignment: {
          contract: 'source-polymer-alignment-v1',
          referenceStructureRef: `source-${reference}`,
          mobileStructureRef: `source-${mobile}`,
          referenceRegion: { label_asym_id: 'A' },
          mobileRegion: { label_asym_id: 'B' },
          pairs: [{}, {}, {}],
          rmsd: 0.5,
          matrix,
        },
      },
    },
  ];
}

function comparisonStory(scene: ReturnType<typeof registrationFixture>) {
  for (const download of scene.root.children ?? []) {
    const structure = download.children![0].children![0];
    structure.children ??= [];
    structure.children.push({
      kind: 'component',
      params: { selector: 'polymer' },
      children: [{ kind: 'representation', params: { type: 'cartoon' } }],
    });
  }
  return {
    kind: 'multiple' as const,
    metadata: scene.metadata,
    snapshots: [0, 1].map((index) => {
      const root = structuredClone(scene.root);
      root.children![1 - index].children![0].children![0].custom = { is_hidden: true };
      return { root, metadata: { title: `State ${index}` } };
    }),
  };
}

describe('comparison registration readback', () => {
  it('retains co-loaded states without inventing an overlay or requiring a fit by default', () => {
    const current = registrationFixture();
    const proposed = comparisonStory(current);
    const result = preserveSharedComparisonSources(proposed, current, 0);
    expect(result.kind === 'multiple' && result.snapshots).toHaveLength(2);
    if (result.kind !== 'multiple') throw Error('Expected a story');
    expect(result.snapshots.every((step) => step.root.children?.length === 2)).toBe(true);
    expect(result.snapshots.some((step) => step.root.custom?.dnaforge_comparison_overview)).toBe(
      false
    );
    expect(readSharedComparisonRegistration(result, 0)?.status).toBe('not-recorded');
  });

  it('does not mistake co-loaded sources or an arbitrary transform for a recorded fit', () => {
    const scene = registrationFixture();
    scene.root.children![1].children![0].children![0].children = [
      {
        kind: 'transform',
        params: { translation: [100, 0, 0] },
      },
    ];
    expect(readSharedComparisonRegistration(scene, 0)).toMatchObject({
      status: 'not-recorded',
      fits: [],
      unregisteredSources: ['source-1.cif'],
    });
  });

  it('reports partial registration instead of certifying a whole three-source comparison', () => {
    const scene = registrationFixture(3);
    addRecordedFit(scene);
    expect(readSharedComparisonRegistration(scene, 0)).toMatchObject({
      status: 'partial',
      unregisteredSources: ['source-2.cif'],
    });
    addRecordedFit(scene, 2, 1);
    expect(readSharedComparisonRegistration(scene, 0)).toMatchObject({
      status: 'recorded',
      unregisteredSources: [],
    });
  });

  it('ignores a fit whose recorded matrix differs from the applied transform', () => {
    const scene = registrationFixture();
    addRecordedFit(scene);
    const transform = scene.root.children![1].children![0].children![0].children![0];
    transform.params = { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 99, 0, 0, 1] };
    expect(readSharedComparisonRegistration(scene, 0)?.status).toBe('not-recorded');
  });
});

describe('shared aligned comparison presentation', () => {
  it('cannot fabricate an alignment record through an ordinary scene edit', () => {
    const current = registrationFixture();
    const forged = structuredClone(current);
    addRecordedFit(forged);
    const proposed = comparisonStory(forged);
    expect(() => preserveSharedComparisonSources(proposed, current, 0, 'overlay')).toThrowError(
      expect.objectContaining({ code: 'MVS_COMPARISON_ALIGNMENT_OWNED' })
    );
    const computed = preserveSharedComparisonSources(proposed, current, 0, 'overlay', true);
    expect(computed.kind === 'multiple' && computed.snapshots).toHaveLength(3);
  });

  it('requires recorded registration instead of accepting the V22 separate-view reason', () => {
    const current = registrationFixture();
    const proposed = comparisonStory(current);
    for (const snapshot of proposed.snapshots)
      snapshot.root.custom = {
        ...snapshot.root.custom,
        dnaforge_presentation_override: {
          reason:
            'Separate whole-assembly views explain the change in overall shape without an unverified invariant-region alignment or an implied antibody dissociation trajectory.',
          fields: ['comparisonPresentation', 'bindingSiteDetail', 'interfaceSurface'],
        },
      };
    expect(() => preserveSharedComparisonSources(proposed, current, 0, 'overlay')).toThrowError(
      expect.objectContaining({ code: 'MVS_COMPARISON_REGISTRATION_REQUIRED' })
    );
  });

  it('allows all-visible staging while registering a three-source comparison pair by pair', () => {
    const current = registrationFixture(3);
    const proposed = comparisonStory(current).snapshots[0].root;
    for (const download of proposed.children!)
      download.children![0].children![0].custom = { is_hidden: false };
    const staging = { ...current, root: proposed };
    expect(preserveSharedComparisonSources(staging, current, 0, 'overlay')).toBe(staging);
    addRecordedFit(staging);
    expect(preserveSharedComparisonSources(staging, current, 0, 'overlay', true)).toBe(staging);
    const story = comparisonStory(staging);
    expect(() => preserveSharedComparisonSources(story, staging, 0, 'overlay')).toThrowError(
      expect.objectContaining({ code: 'MVS_COMPARISON_REGISTRATION_REQUIRED' })
    );
  });

  it('requires a named scientific exception accounting for every pinned source', () => {
    const current = registrationFixture();
    const proposed = comparisonStory(current);
    const exception = {
      kind: 'no-corresponding-region',
      reason: 'These independently folded structures have no homologous polymer region.',
      sources: [
        { uri: 'source-0.cif', limitation: 'Its polymer is unrelated to the other source.' },
        { uri: 'source-1.cif', limitation: 'Its polymer is unrelated to the first source.' },
      ],
    };
    for (const snapshot of proposed.snapshots)
      snapshot.root.custom = {
        ...snapshot.root.custom,
        dnaforge_comparison_exception: exception,
      };
    expect(preserveSharedComparisonSources(proposed, current, 0, 'overlay')).toBe(proposed);
    proposed.snapshots[1].root.custom!.dnaforge_comparison_exception = {
      ...exception,
      sources: exception.sources.slice(0, 1),
    };
    expect(() => preserveSharedComparisonSources(proposed, current, 0, 'overlay')).toThrowError(
      expect.objectContaining({ code: 'MVS_COMPARISON_EXCEPTION_INVALID' })
    );
  });

  it('constructs a both-visible step despite a generic agent comparison override', () => {
    const current = registrationFixture();
    addRecordedFit(current);
    const proposed = comparisonStory(current);
    for (const snapshot of proposed.snapshots)
      snapshot.root.custom = {
        ...snapshot.root.custom,
        dnaforge_presentation_override: {
          reason: 'Show each state separately for clarity.',
          fields: ['comparisonPresentation'],
        },
      };
    const built = preserveSharedComparisonSources(proposed, current, 0, 'overlay');
    expect(built.kind === 'multiple' && built.snapshots).toHaveLength(3);
    expect(preserveSharedComparisonSources(proposed, current, 0, 'authored')).toBe(proposed);
  });

  it('keeps every registered source visible in a generated three-source comparison', () => {
    const current = registrationFixture(3);
    addRecordedFit(current);
    addRecordedFit(current, 2, 1);
    const proposed = comparisonStory(current);
    for (const snapshot of proposed.snapshots)
      snapshot.root.children![2].children![0].children![0].custom = { is_hidden: true };
    const built = preserveSharedComparisonSources(proposed, current, 0, 'overlay');
    if (built.kind !== 'multiple') throw Error('Expected comparison story');
    const overview = built.snapshots.find((s) => s.root.custom?.dnaforge_comparison_overview)!;
    expect(
      overview.root
        .children!.filter((n) => n.kind === 'download')
        .every((n) => n.children![0].children![0].custom?.is_hidden !== true)
    ).toBe(true);
  });

  it('constructs a visible correspondence step when authored steps hide one source at a time', () => {
    const b = MVSData.createBuilder();
    for (const [i, uri] of ['structure.cif', 'asset-2.cif'].entries()) {
      const s = b
        .download({ url: uri })
        .parse({ format: 'mmcif' })
        .modelStructure({ ref: `source-${i}` });
      s.component({ selector: 'polymer' })
        .representation({ type: 'cartoon' })
        .color({ color: '#2255aa' });
    }
    const current = b.getState();
    current.root.custom = {
      dnaforge_comparison: { layout: 'shared-scene', sources: ['structure.cif', 'asset-2.cif'] },
    };
    const mobile = current.root.children![1].children![0].children![0];
    mobile.children!.push({
      kind: 'transform',
      params: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      custom: {
        dnaforge_alignment: {
          contract: 'source-polymer-alignment-v1',
          referenceStructureRef: 'source-0',
          mobileStructureRef: 'source-1',
          referenceRegion: { label_asym_id: 'A' },
          mobileRegion: { label_asym_id: 'B' },
          rmsd: 0.5,
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          pairs: [{}, {}, {}],
        },
      },
    });
    const proposed = {
      kind: 'multiple' as const,
      metadata: current.metadata,
      snapshots: [0, 1].map((i) => {
        const root = structuredClone(current.root);
        root.children![1 - i].children![0].children![0].custom = { is_hidden: true };
        return { root, metadata: { title: `State ${i}` } };
      }),
    };
    const built = preserveSharedComparisonSources(proposed, current, 0, 'overlay');
    if (built.kind !== 'multiple') throw Error('Expected story');
    const comparison = built.snapshots.find((s) => s.root.custom?.dnaforge_comparison_overview);
    expect(comparison).toBeDefined();
    expect(comparison!.root.children!.filter((n) => n.kind === 'download')).toHaveLength(2);
    expect(
      comparison!.root
        .children!.filter((n) => n.kind === 'download')
        .every((n) => n.children![0].children![0].custom?.is_hidden !== true)
    ).toBe(true);
    expect(preserveSharedComparisonSources(built, built, 0, 'overlay')).toEqual(built);
    const edited = structuredClone(built);
    const oldOverview = edited.snapshots.find((s) => s.root.custom?.dnaforge_comparison_overview)!;
    oldOverview.root.children![1].children![0].children![0].custom = { is_hidden: true };
    const rebuilt = preserveSharedComparisonSources(edited, built, 0, 'overlay');
    if (rebuilt.kind !== 'multiple') throw Error('Expected rebuilt story');
    expect(rebuilt.snapshots).toHaveLength(4);
    expect(
      rebuilt.snapshots[3].root
        .children!.filter((n) => n.kind === 'download')
        .every((n) => n.children![0].children![0].custom?.is_hidden !== true)
    ).toBe(true);
  });
});

describe('explicit registered comparison display objects', () => {
  const display = {
    objects: [
      { structureRef: 'source-0', selector: { label_asym_id: 'A', instance_id: 'ASM-1' } },
      { structureRef: 'source-1', selector: [{ label_asym_id: 'B' }, { label_asym_id: 'C' }] },
    ],
    direction: [0, 0, -1],
    up: [0, 1, 0],
  };
  const walk = (node: MolecularProfileNode): MolecularProfileNode[] => [
    node,
    ...(node.children ?? []).flatMap((child) => walk(child)),
  ];
  function markedStory() {
    const current = registrationFixture();
    addRecordedFit(current);
    const proposed = comparisonStory(current);
    for (const snapshot of proposed.snapshots) {
      snapshot.root.custom = { ...snapshot.root.custom, dnaforge_comparison_display: display };
      snapshot.root.children!.push({
        kind: 'camera',
        params: { target: [0, 0, 0], position: [0, 0, 100] },
      });
    }
    const overview = structuredClone(proposed.snapshots[0]);
    delete overview.root.custom!.dnaforge_comparison_display;
    overview.root.children!.at(-1)!.params = { target: [9, 9, 9], position: [9, 9, 900] };
    proposed.snapshots.unshift(overview);
    return { current, proposed, originalCamera: structuredClone(overview.root.children!.at(-1)) };
  }
  it('constructs shared object focus for endpoints and generated overlay, preserving an unmarked camera and fit', () => {
    const { current, proposed, originalCamera } = markedStory();
    const fits = proposed.snapshots.map((s) =>
      walk(s.root).filter((n) => n.custom?.dnaforge_alignment)
    );
    const result = preserveSharedComparisonSources(
      proposed,
      current,
      0,
      'overlay',
      false,
      () => 10
    );
    if (result.kind !== 'multiple') throw Error('Expected story');
    expect(result.snapshots[0].root.children!.at(-1)).toEqual(originalCamera);
    const marked = result.snapshots.filter((s) => s.root.custom?.dnaforge_comparison_display);
    expect(marked).toHaveLength(3);
    for (const snapshot of marked) {
      expect(walk(snapshot.root).filter((n) => n.kind === 'camera')).toHaveLength(0);
      const scopes = walk(snapshot.root).filter((n) => n.custom?.dnaforge_comparison_focus);
      expect(scopes.map((n) => n.params.selector)).toEqual(display.objects.map((o) => o.selector));
      expect(scopes.map((n) => n.children)).toEqual(
        display.objects.map(() => [
          {
            kind: 'focus',
            params: { direction: [0, 0, -1], up: [0, 1, 0], radius_factor: 1, radius_extent: 0 },
          },
        ])
      );
      expect(scopes.every((n) => n.children.every((c) => c.kind !== 'representation'))).toBe(true);
    }
    expect(
      result.snapshots
        .slice(0, 3)
        .map((s) => walk(s.root).filter((n) => n.custom?.dnaforge_alignment))
    ).toEqual(fits);
  });
  it('rejects contradictory display objects within one comparison group', () => {
    const { current, proposed } = markedStory();
    proposed.snapshots[2].root.custom!.dnaforge_comparison_display = { ...display, up: [1, 0, 0] };
    expect(() =>
      preserveSharedComparisonSources(proposed, current, 0, 'overlay', false, () => 10)
    ).toThrowError(expect.objectContaining({ code: 'MVS_COMPARISON_DISPLAY_INCONSISTENT' }));
  });
  it('rejects unknown source, unsupported selector and empty physical object before native mutation', () => {
    for (const bad of [
      {
        ...display,
        objects: [{ ...display.objects[0], structureRef: 'absent' }, display.objects[1]],
      },
      {
        ...display,
        objects: [{ ...display.objects[0], selector: { chain: 'A' } }, display.objects[1]],
      },
    ]) {
      const { current, proposed } = markedStory();
      for (const snapshot of proposed.snapshots.slice(1))
        snapshot.root.custom!.dnaforge_comparison_display = bad;
      expect(() =>
        preserveSharedComparisonSources(proposed, current, 0, 'overlay', false, () => 10)
      ).toThrowError(expect.objectContaining({ code: 'MVS_COMPARISON_DISPLAY_INVALID' }));
    }
    const { current, proposed } = markedStory();
    expect(() =>
      preserveSharedComparisonSources(proposed, current, 0, 'overlay', false, () => 0)
    ).toThrowError(expect.objectContaining({ code: 'MVS_COMPARISON_DISPLAY_EMPTY' }));
  });
});
