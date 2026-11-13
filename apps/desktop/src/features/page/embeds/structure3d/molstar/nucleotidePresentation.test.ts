/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure, Unit } from 'molstar/lib/mol-model/structure';
import { StructureRepresentationRegistry } from 'molstar/lib/mol-repr/structure/registry';
import { CartoonRepresentationProvider } from 'molstar/lib/mol-repr/structure/representation/cartoon';
import {
  createNucleotidePresentationMesh,
  filterNucleotideAtomicStructure,
  filterNucleotideVisualStructure,
  NucleotideBallAndStickRepresentationProvider,
  NucleotideCartoonRepresentationProvider,
  registerMolecularRenderProfileVisuals,
} from './nucleotidePresentation';
import {
  resolveNucleotidePresentations,
  type MolecularProfileNode,
} from './nucleotidePresentationSettings';

async function structure(includeSecondNucleotide = false) {
  const atoms = [
    ['P', -12, -10, 0, 'P'],
    ["O5'", -11, -10, 0, 'O'],
    ["C5'", -10, -10, 0, 'C'],
    ["C4'", -9, -10, 0, 'C'],
    ["C3'", -8, -10, 0, 'C'],
    ["C2'", -7, -10, 0, 'C'],
    ["C1'", -6, -10, 0, 'C'],
    ["O4'", -8, -11, 0, 'O'],
    ['N1', 1, 1, 0, 'N'],
    ['C2', 2, 1, 0, 'C'],
    ['N3', 3, 2, 0, 'N'],
    ['C4', 2.5, 3, 0, 'C'],
    ['C5', 1.5, 3, 0, 'C'],
    ['C6', 0.5, 2, 0, 'C'],
    ['N7', 1.5, 4, 0, 'N'],
    ['C8', 2.5, 4.5, 0, 'C'],
    ['N9', 3, 3.5, 0, 'N'],
    ['N6', 0, 2.5, 0, 'N'],
  ] as const;
  const line = (
    serial: number,
    name: string,
    residue: string,
    chain: string,
    seq: number,
    x: number,
    y: number,
    z: number,
    element: string
  ) =>
    `ATOM  ${String(serial).padStart(5)} ${name.padStart(4)} ${residue.padStart(3)} ${chain}${String(seq).padStart(4)}    ${x.toFixed(3).padStart(8)}${y.toFixed(3).padStart(8)}${z.toFixed(3).padStart(8)}  1.00 20.00          ${element.padStart(2)}  `;
  const pdb = [
    ...atoms.map(([name, x, y, z, element], i) => line(i + 1, name, 'A', 'R', 1, x, y, z, element)),
    ...(includeSecondNucleotide
      ? atoms.map(([name, x, y, z, element], i) =>
          line(i + 40, name, 'A', 'R', 2, x + 30, y, z, element)
        )
      : []),
    'TER',
    line(30, 'CA', 'ALA', 'P', 1, 20, 20, 0, 'C'),
    'END',
  ].join('\n');
  const parsed = await parsePDB(pdb).run();
  if (parsed.isError) throw new Error(parsed.message);
  const trajectory = await trajectoryFromPDB(parsed.result).run();
  return Structure.ofModel(trajectory.representative);
}

function names(source: Structure) {
  return source.units.flatMap((unit) =>
    Unit.isAtomic(unit)
      ? Array.from(unit.elements, (atom) =>
          unit.model.atomicHierarchy.atoms.label_atom_id.value(atom)
        )
      : []
  );
}

describe('native nucleotide presentation', () => {
  it('retains a contacted nucleotide with its sugar/phosphate geometry while simplifying other residues', async () => {
    const source = await structure(true);
    const bases = filterNucleotideAtomicStructure(source, 'base-only', [
      { auth_asym_id: 'R', auth_seq_id: 1, label_atom_id: 'P' },
    ]);
    expect(names(bases)).toContain('P');
    expect(names(bases)).toContain('N9');
    expect(names(bases)).toContain("C1'");
    expect(names(bases)).toContain("O5'");
    expect(names(bases).filter((name) => name === 'P')).toHaveLength(1);
    expect(names(bases).filter((name) => name === 'N9')).toHaveLength(2);
    expect(names(source).filter((name) => name === 'P')).toHaveLength(2);
    const nativeData = NucleotideBallAndStickRepresentationProvider.getData!(source, {
      ...NucleotideBallAndStickRepresentationProvider.defaultValues,
      dnaforgeNucleotideAtomicMode: 'base-only',
      dnaforgeNucleotideKeepAtoms: [{ auth_asym_id: 'R', auth_seq_id: 1, label_atom_id: 'P' }],
    });
    expect(names(nativeData)).toEqual(names(bases));
  });

  it('rebuilds omitted contact geometry metadata from source-qualified visible dotted endpoints', () => {
    const defaults = {
      connectorMode: 'simplified' as const,
      baseOpacity: 0.35,
      baseThickness: 0.08,
      connectorRadius: 0.15,
    };
    const detail = (): MolecularProfileNode => ({
      kind: 'representation',
      params: { type: 'ball_and_stick' },
      custom: { dnaforge_nucleotide_presentation: {} },
    });
    const first = detail();
    const second = detail();
    const root: MolecularProfileNode = {
      kind: 'root',
      children: [
        {
          kind: 'structure',
          ref: 'source-a',
          children: [
            { kind: 'component', params: { selector: 'nucleic' }, children: [first] },
            {
              kind: 'primitives',
              children: [
                {
                  kind: 'primitive',
                  params: {
                    kind: 'tube',
                    radius: 0.06,
                    dash_length: 0.12,
                    start: { expressions: [{ atom_index: 7, instance_id: '1_555' }] },
                    end: {
                      structure_ref: 'source-b',
                      expressions: [{ atom_index: 11, instance_id: '1_555' }],
                    },
                  },
                },
              ],
            },
            {
              kind: 'primitives',
              params: { opacity: 0 },
              children: [
                {
                  kind: 'primitive',
                  params: {
                    kind: 'tube',
                    start: { atom_index: 13 },
                    end: { atom_index: 14 },
                  },
                },
              ],
            },
          ],
        },
        {
          kind: 'structure',
          ref: 'source-b',
          children: [{ kind: 'component', params: { selector: 'nucleic' }, children: [second] }],
        },
      ],
    };
    resolveNucleotidePresentations(root, defaults, '#909090', { coherentAppearance: true });
    expect(first.custom?.molstar_representation_params).toMatchObject({
      dnaforgeNucleotideAtomicMode: 'base-only',
      dnaforgeNucleotideKeepAtoms: [{ atom_index: 7, instance_id: '1_555' }],
    });
    expect(second.custom?.molstar_representation_params).toMatchObject({
      dnaforgeNucleotideKeepAtoms: [{ atom_index: 11, instance_id: '1_555' }],
    });
    const firstStructure = root.children![0];
    const firstComponent = firstStructure.children![0];
    const connector = firstComponent.children!.find((node) =>
      (
        node.custom?.molstar_representation_params as { visuals?: string[] } | undefined
      )?.visuals?.includes('dnaforge-nucleotide-connector')
    );
    expect(connector?.custom?.molstar_representation_params).toMatchObject({
      dnaforgeNucleotideExclude: [{ atom_index: 7, instance_id: '1_555' }],
    });
    const recorded = JSON.stringify(root);
    resolveNucleotidePresentations(root, defaults, '#909090', { coherentAppearance: true });
    expect(JSON.stringify(root)).toBe(recorded);
    firstStructure.children = [firstComponent];
    resolveNucleotidePresentations(root, defaults, '#909090', { coherentAppearance: true });
    expect(first.custom?.molstar_representation_params).toMatchObject({
      dnaforgeNucleotideKeepAtoms: [],
    });
    expect(second.custom?.molstar_representation_params).toMatchObject({
      dnaforgeNucleotideKeepAtoms: [],
    });
  });
  it('filters actual native atoms to bases while preserving protein atoms and source coordinates', async () => {
    const source = await structure();
    expect(names(source)).toContain("C1'");
    const bases = filterNucleotideAtomicStructure(source, 'base-only');
    expect(names(bases)).toContain('N9');
    expect(names(bases)).toContain('N6');
    expect(names(bases)).toContain('CA');
    expect(names(bases)).not.toContain("C1'");
    expect(names(bases)).not.toContain('P');
    expect(filterNucleotideAtomicStructure(source, 'full')).toBe(source);
    expect(names(source)).toContain("C1'");
  });

  it('emits base faces without sugar faces or schematic connectors and uses exact residue exclusions', async () => {
    const source = await structure();
    const unit = source.units.find(
      (candidate) => Unit.isAtomic(candidate) && candidate.nucleotideElements.length
    )!;
    expect(unit).toBeDefined();
    const props = {
      sizeFactor: 0.08,
      thicknessFactor: 1,
      radialSegments: 16,
      dnaforgeNucleotideExclude: [],
    };
    const plane = createNucleotidePresentationMesh(unit, source, props, 'plane');
    expect(plane.triangleCount).toBeGreaterThan(0);
    const positions = plane.vertexBuffer.ref.value.slice(0, plane.vertexCount * 3);
    const xs = Array.from(positions).filter((_value, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeGreaterThan(-1);
    const connector = createNucleotidePresentationMesh(unit, source, props, 'connector');
    expect(connector.triangleCount).toBeGreaterThan(0);
    expect(
      Math.min(
        ...Array.from(connector.vertexBuffer.ref.value.slice(0, connector.vertexCount * 3)).filter(
          (_value, i) => i % 3 === 0
        )
      )
    ).toBeLessThan(-5);
    const exclusions = [{ auth_asym_id: 'R', auth_seq_id: 1 }];
    const hidden = createNucleotidePresentationMesh(
      unit,
      source,
      { ...props, dnaforgeNucleotideExclude: exclusions },
      'ring'
    );
    expect(hidden.triangleCount).toBe(0);
    const remainder = filterNucleotideVisualStructure(source, exclusions);
    expect(names(remainder)).toEqual(['CA']);
  });

  it('registers supported native settings once and leaves the native default visual list intact', async () => {
    const registry = new StructureRepresentationRegistry();
    const plugin = { representation: { structure: { registry } } };
    const before = registry.list.length;
    registerMolecularRenderProfileVisuals(
      plugin as Parameters<typeof registerMolecularRenderProfileVisuals>[0]
    );
    registerMolecularRenderProfileVisuals(
      plugin as Parameters<typeof registerMolecularRenderProfileVisuals>[0]
    );
    expect(registry.list).toHaveLength(before);
    expect(registry.default.provider).toBe(NucleotideCartoonRepresentationProvider);
    expect(registry.get('cartoon')).toBe(NucleotideCartoonRepresentationProvider);
    const source = await structure();
    const context = {} as Parameters<typeof CartoonRepresentationProvider.getParams>[0];
    const native = CartoonRepresentationProvider.getParams(context, source);
    const extended = registry.get('cartoon').getParams(context, source);
    expect(extended.visuals.defaultValue).toEqual(native.visuals.defaultValue);
    expect(extended.visuals.options.map(([name]) => name)).toContain(
      'dnaforge-nucleotide-base-plane'
    );
  });

  it('applies exclusion to the real native subrepresentation and independently renders plane opacity', async () => {
    const source = await structure();
    const context = {} as Parameters<typeof NucleotideCartoonRepresentationProvider.factory>[0];
    const ring = NucleotideCartoonRepresentationProvider.factory(
      context,
      NucleotideCartoonRepresentationProvider.getParams
    );
    await ring.createOrUpdate({ visuals: ['nucleotide-ring'] }, source).run();
    expect(
      ring.renderObjects.reduce((count, object) => count + object.values.drawCount.ref.value, 0)
    ).toBeGreaterThan(0);
    await ring
      .createOrUpdate(
        { dnaforgeNucleotideExclude: [{ auth_asym_id: 'R', auth_seq_id: 1 }] },
        source
      )
      .run();
    expect(
      ring.renderObjects.reduce((count, object) => count + object.values.drawCount.ref.value, 0)
    ).toBe(0);

    const plane = NucleotideCartoonRepresentationProvider.factory(
      context,
      NucleotideCartoonRepresentationProvider.getParams
    );
    await plane
      .createOrUpdate({ visuals: ['dnaforge-nucleotide-base-plane'], alpha: 0.35 }, source)
      .run();
    expect(
      plane.renderObjects.reduce((count, object) => count + object.values.drawCount.ref.value, 0)
    ).toBeGreaterThan(0);
    expect(plane.renderObjects[0].values.alpha.ref.value).toBe(0.35);
    ring.destroy();
    plane.destroy();
  });
});
