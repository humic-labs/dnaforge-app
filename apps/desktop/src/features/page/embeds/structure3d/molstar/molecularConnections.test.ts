import { describe, expect, it } from 'vitest';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { Structure } from 'molstar/lib/mol-model/structure';
import { Column } from 'molstar/lib/mol-data/db';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import type { MolstarPlugin } from './cache';
import cif from './fixtures/molecular-attachment-3tyg.cif?raw';
import hemeCif from './fixtures/molecular-attachment-1hrc.cif?raw';
import { pageMolecularConnections } from './molecularConnectionReadback';
import {
  readMolecularConnections,
  readMolecularConnectionCoverage,
  requireMolecularAttachmentCoverage,
  resolveMolViewSpecAttachments,
  molecularAtomSelector,
  type AttachmentDocument,
} from './molecularConnections';

async function source(text = cif) {
  const parsed = await CIF.parseText(text).run();
  if (parsed.isError) throw new Error(parsed.message);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  return Structure.ofModel(trajectory.representative);
}

function select(structure: Structure, selector: unknown) {
  return substructureFromSelector(
    structure,
    componentPropsFromSelector(selector as Parameters<typeof componentPropsFromSelector>[0])
  );
}

function plugin(
  structure: Structure,
  atomistic: Array<{ source: Structure; visuals?: string[]; type?: string; alpha?: number }> = []
): MolstarPlugin {
  return {
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [
              {
                cell: { obj: { data: structure } },
                components: atomistic.map((entry) => ({
                  cell: { obj: { label: 'Attached molecule', data: entry.source } },
                  representations: [
                    {
                      cell: {
                        params: { values: { type: { name: entry.type ?? 'ball-and-stick' } } },
                        obj: {
                          data: {
                            repr: {
                              state: { visible: true, alphaFactor: 1 },
                              props: {
                                alpha: entry.alpha ?? 1,
                                visuals: entry.visuals ?? [
                                  'element-sphere',
                                  'intra-bond',
                                  'inter-bond',
                                ],
                              },
                            },
                          },
                        },
                      },
                    },
                  ],
                })),
              },
            ],
          },
        },
      },
    },
  } as unknown as MolstarPlugin;
}

function document(extraAtomic = false): AttachmentDocument {
  return {
    root: {
      kind: 'root',
      children: [
        {
          kind: 'structure',
          params: { type: 'model' },
          children: [
            {
              kind: 'component',
              params: { selector: [{ label_asym_id: 'D' }, { label_asym_id: 'E' }] },
              children: [
                {
                  kind: 'representation',
                  params: { type: 'ball_and_stick' },
                  custom: {
                    dnaforge_carbon_color: '#eed885',
                    dnaforge_legend_label: 'Glycans',
                  },
                },
              ],
            },
            {
              kind: 'component',
              params: { selector: { label_asym_id: 'A' } },
              children: [
                {
                  kind: 'representation',
                  params: { type: extraAtomic ? 'ball_and_stick' : 'cartoon' },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

describe('source-derived molecular attachment integrity', () => {
  it('publishes source atom selectors without leaking reordered internal graph indices', async () => {
    const structure = await source(hemeCif);
    const hierarchy = structure.models[0].atomicHierarchy;
    const sourceIndices = Int32Array.from(
      { length: hierarchy.atoms._rowCount },
      (_, index) => hierarchy.atoms._rowCount - index - 1
    );
    Object.defineProperty(hierarchy, 'atomSourceIndex', {
      value: Column.ofIntArray(sourceIndices),
    });
    const native = readMolecularConnectionCoverage(plugin(structure));
    const page = pageMolecularConnections(native);
    expect(page.connections.length).toBeGreaterThan(0);
    for (const connection of page.connections) {
      const internal = native.find((record) => record.id === connection.id)!;
      for (const side of ['a', 'b'] as const) {
        const point = internal[side];
        expect(connection[side]).not.toHaveProperty('atomIndex');
        expect(connection[side]).not.toHaveProperty('residueIndex');
        if (point.atomIndex === null) continue;
        expect(connection[side].selector.atom_index).toBe(sourceIndices[point.atomIndex]);
        expect(
          select(structure, connection[side].selector).units.flatMap((unit) =>
            Array.from(unit.elements)
          )
        ).toEqual([point.atomIndex]);
      }
    }
  });
  it('closes each structure against its own source graph in a comparison', async () => {
    const glycan = await source();
    const heme = await source(hemeCif);
    const authored = document();
    const first = authored.root!.children![0];
    const second = structuredClone(first);
    second.children![0].params!.selector = { label_comp_id: 'HEC' };
    second.children![1].params!.selector = 'polymer';
    authored.root!.children!.push(second);
    const viewer = plugin(glycan);
    viewer.managers.structure.hierarchy.current.structures.push(
      plugin(heme).managers.structure.hierarchy.current.structures[0]
    );
    const resolved = resolveMolViewSpecAttachments(viewer, authored, (node) =>
      node.children?.[0].params?.selector &&
      JSON.stringify(node.children[0].params.selector).includes('HEC')
        ? heme
        : glycan
    );
    const nodes = resolved.root!.children!;
    expect(nodes).toHaveLength(2);
    const glycanAtoms = select(glycan, nodes[0].children![0].params!.selector);
    const hemeAtoms = select(heme, nodes[1].children![0].params!.selector);
    expect(select(glycanAtoms, { label_asym_id: 'A' }).elementCount).toBeGreaterThan(0);
    expect(select(hemeAtoms, { label_comp_id: 'HEC' }).elementCount).toBeGreaterThan(0);
    expect(select(hemeAtoms, { label_asym_id: 'A', auth_seq_id: 14 }).elementCount).toBeGreaterThan(
      0
    );
    expect(select(hemeAtoms, { label_asym_id: 'D' }).elementCount).toBe(0);
    expect(
      nodes.every(
        (n) =>
          n.children![0].custom?.dnaforge_attachment_integrity ===
          'source-bond-selection-closure-v1'
      )
    ).toBe(true);
  });
  it('compacts complete native chains while preserving exact partial atom membership', async () => {
    const structure = await source(hemeCif);
    const complete = molecularAtomSelector(structure);
    expect(JSON.stringify(complete).length).toBeLessThan(256);
    expect(select(structure, complete).elementCount).toBe(structure.elementCount);
    const partial = select(structure, { label_comp_id: 'HEC', label_atom_id: 'CAB' });
    expect(select(structure, molecularAtomSelector(partial, structure)).elementCount).toBe(1);
  });
  it('links bond owners by native component reference without repeating expanded selection labels', async () => {
    const structure = await source(hemeCif);
    const viewer = plugin(structure, [{ source: structure }]);
    const component = viewer.managers.structure.hierarchy.current.structures[0].components[0];
    component.cell.transform = { ...component.cell.transform, ref: 'native-atomic-owner' };
    component.cell.obj!.label =
      'Custom Selection: ' +
      JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ atom_index: i })));
    const coverage = readMolecularConnectionCoverage(viewer).filter((c) => c.status === 'drawn');
    expect(coverage.length).toBeGreaterThan(0);
    expect(
      coverage.every((c) => JSON.stringify(c.representationOwners) === '["native-atomic-owner"]')
    ).toBe(true);
  });

  it('repairs a non-glycan heme surface using deposited covalent links without turning metal coordination into covalent geometry', async () => {
    const structure = await source(hemeCif);
    const inventory = readMolecularConnections(plugin(structure));
    expect(inventory.filter((connection) => connection.attachment)).toHaveLength(2);
    expect(inventory.filter((connection) => connection.kind === 'metal-coordination')).toHaveLength(
      2
    );
    const authored: AttachmentDocument = {
      root: {
        kind: 'root',
        children: [
          {
            kind: 'structure',
            params: { type: 'model' },
            children: [
              {
                kind: 'component',
                params: { selector: { label_comp_id: 'HEC' } },
                children: [
                  {
                    kind: 'representation',
                    params: { type: 'surface' },
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const resolved = resolveMolViewSpecAttachments(plugin(structure), authored);
    const components = resolved.root!.children![0].children!;
    expect(components[0]).toEqual(authored.root!.children![0].children![0]);
    const endpoints = select(structure, components[1].params!.selector);
    expect(endpoints).toMatchObject({ elementCount: 8 });
    expect(select(endpoints, { label_comp_id: 'HEC' }).elementCount).toBe(2);
    expect(select(endpoints, { type_symbol: 'FE' }).elementCount).toBe(0);
    const coverage = readMolecularConnectionCoverage(
      plugin(structure, [
        { source: select(structure, { label_comp_id: 'HEC' }), type: 'molecular-surface' },
        { source: endpoints, visuals: ['intra-bond', 'inter-bond'] },
      ])
    );
    expect(
      coverage.filter((connection) => connection.attachment).map((connection) => connection.status)
    ).toEqual(['drawn', 'drawn']);
    expect(
      coverage
        .filter((connection) => connection.kind === 'metal-coordination')
        .every((connection) => connection.representationOwners.length === 0)
    ).toBe(true);
    expect(resolveMolViewSpecAttachments(plugin(structure), resolved)).toEqual(resolved);
  });

  it('does not classify a visible surface-only attached molecule as not depicted', async () => {
    const structure = await source();
    const viewer = plugin(structure, [
      {
        source: select(structure, [{ label_asym_id: 'D' }, { label_asym_id: 'E' }]),
        type: 'molecular-surface',
        alpha: 0.3,
      },
    ]);
    expect(readMolecularConnectionCoverage(viewer).map((connection) => connection.status)).toEqual([
      'missing-attachment-geometry',
      'missing-attachment-geometry',
    ]);
    expect(() => requireMolecularAttachmentCoverage(viewer)).toThrow(
      'Covalent attachment is not drawn'
    );
  });

  it('preserves a surface-only presentation and adds only real attachment bond endpoints', async () => {
    const structure = await source();
    const authored = document();
    const surface = authored.root!.children![0].children![0];
    surface.children![0].params!.type = 'surface';
    surface.children![0].children = [{ kind: 'opacity', params: { opacity: 0.3 } }];
    const resolved = resolveMolViewSpecAttachments(plugin(structure), authored);
    expect(resolved.root!.children![0].children![0]).toEqual(surface);
    const connectors = resolved.root!.children![0].children!.filter(
      (component) => component.custom?.dnaforge_attachment_integrity === 'source-bond-connector-v1'
    );
    expect(connectors).toHaveLength(1);
    const endpoints = select(structure, connectors[0].params!.selector);
    expect(endpoints).toMatchObject({ elementCount: 10 });
    expect(select(endpoints, { label_atom_id: 'CA' }).elementCount).toBe(2);
    expect(select(endpoints, { label_comp_id: 'NAG' }).elementCount).toBe(2);
    const visuals = connectors[0].children![0].custom!.molstar_representation_params as {
      visuals: string[];
    };
    expect(visuals.visuals).toEqual(['intra-bond', 'inter-bond']);
    const viewer = plugin(structure, [
      { source: select(structure, surface.params!.selector), type: 'molecular-surface' },
      { source: endpoints, visuals: visuals.visuals },
    ]);
    expect(readMolecularConnectionCoverage(viewer).map((connection) => connection.status)).toEqual([
      'drawn',
      'drawn',
    ]);
    expect(resolveMolViewSpecAttachments(plugin(structure), resolved)).toEqual(resolved);
  });

  it('reuses a parent atomic owner without adding a duplicate or full glycan detail', async () => {
    const structure = await source();
    const authored = document(true);
    const surface = authored.root!.children![0].children![0];
    surface.children![0].params!.type = 'surface';
    const resolved = resolveMolViewSpecAttachments(plugin(structure), authored);
    const components = resolved.root!.children![0].children!;
    expect(components).toHaveLength(2);
    expect(components[0]).toEqual(surface);
    const atomic = select(structure, components[1].params!.selector);
    expect(atomic.elementCount).toBe(18);
    expect(select(atomic, { label_comp_id: 'NAG' }).elementCount).toBe(2);
    expect(
      readMolecularConnectionCoverage(plugin(structure, [{ source: atomic }])).map(
        (connection) => connection.status
      )
    ).toEqual(['drawn', 'drawn']);
  });

  it('does not create attachment geometry for an invisible surface', async () => {
    const structure = await source();
    const authored = document();
    const surface = authored.root!.children![0].children![0];
    surface.children![0].params!.type = 'surface';
    surface.children![0].children = [{ kind: 'opacity', params: { opacity: 0 } }];
    expect(resolveMolViewSpecAttachments(plugin(structure), authored)).toEqual(authored);
    const viewer = plugin(structure, [
      { source: select(structure, surface.params!.selector), type: 'molecular-surface', alpha: 0 },
    ]);
    expect(readMolecularConnectionCoverage(viewer).map((connection) => connection.status)).toEqual([
      'not-depicted',
      'not-depicted',
    ]);
  });

  it('refuses a fabricated cartoon connection when the parent trace coordinate is missing', async () => {
    const missingTrace = cif
      .split('\n')
      .filter((line) => !(line.startsWith('ATOM ') && / 104 ASN A CA /.test(line)))
      .join('\n');
    const structure = await source(missingTrace);
    const authored = document();
    authored.root!.children![0].children![0].children![0].params!.type = 'surface';
    expect(() => resolveMolViewSpecAttachments(plugin(structure), authored)).toThrow(
      'polymer trace'
    );
  });

  it('reports the two deposited covalent bonds with exact native source endpoints', async () => {
    const inventory = readMolecularConnections(plugin(await source()));
    expect(inventory).toHaveLength(2);
    expect(
      inventory
        .map((connection) => [
          connection.a.labelAsymId,
          connection.a.authSeqId,
          connection.a.labelAtomId,
          connection.b.labelAsymId,
          connection.b.authSeqId,
          connection.b.labelAtomId,
        ])
        .sort()
    ).toEqual([
      ['A', 104, 'ND2', 'E', 1, 'C1'],
      ['A', 121, 'ND2', 'D', 1, 'C1'],
    ]);
    expect(
      inventory.every(
        (connection) =>
          connection.source === 'deposited-struct_conn' &&
          connection.bondPresent &&
          connection.attachment &&
          connection.a.coordinateAvailable &&
          connection.b.coordinateAvailable
      )
    ).toBe(true);
  });

  it('detects the real missing bonds when only glycans own atomic geometry', async () => {
    const structure = await source();
    const viewer = plugin(structure, [
      { source: select(structure, [{ label_asym_id: 'D' }, { label_asym_id: 'E' }]) },
    ]);
    expect(readMolecularConnectionCoverage(viewer).map((connection) => connection.status)).toEqual([
      'missing-attachment-geometry',
      'missing-attachment-geometry',
    ]);
    expect(() => requireMolecularAttachmentCoverage(viewer)).toThrow(
      'Covalent attachment is not drawn'
    );
  });

  it('closes the existing owner over linked parent residues and yields complete native bonds', async () => {
    const structure = await source();
    const authored = document();
    const resolved = resolveMolViewSpecAttachments(plugin(structure), authored);
    const owner = resolved.root!.children![0].children![0];
    const combined = select(structure, owner.params!.selector);
    expect(combined.elementCount).toBe(44);
    expect(
      select(structure, authored.root!.children![0].children![0].params!.selector).elementCount
    ).toBe(28);
    expect(owner.children![0].custom).toMatchObject({
      dnaforge_carbon_color: '#eed885',
      dnaforge_legend_label: 'Glycans',
    });
    const viewer = plugin(structure, [{ source: combined }]);
    expect(readMolecularConnectionCoverage(viewer).map((connection) => connection.status)).toEqual([
      'drawn',
      'drawn',
    ]);
    expect(() => requireMolecularAttachmentCoverage(viewer)).not.toThrow();
    expect(resolveMolViewSpecAttachments(plugin(structure), resolved)).toEqual(resolved);
  });

  it('rejects a second atomic owner instead of overlaying the attachment residue', async () => {
    const structure = await source();
    expect(() => resolveMolViewSpecAttachments(plugin(structure), document(true))).toThrow(
      'another atomic owner'
    );
  });

  it('does not treat endpoint inclusion as proof when the native inter-bond visual is disabled', async () => {
    const structure = await source();
    const viewer = plugin(structure, [
      { source: structure, visuals: ['element-sphere', 'intra-bond'] },
    ]);
    expect(
      readMolecularConnectionCoverage(viewer).every(
        (connection) => connection.status === 'missing-attachment-geometry'
      )
    ).toBe(true);
  });

  it('preserves a deposited connection with a missing atom and refuses fabricated attachment geometry', async () => {
    const missingAtom = cif
      .split('\n')
      .filter(
        (line) => !(line.startsWith('ATOM ') && / ND2 /.test(line) && / 104 ASN A ND2 /.test(line))
      )
      .join('\n');
    const structure = await source(missingAtom);
    const inventory = readMolecularConnections(plugin(structure));
    expect(inventory).toHaveLength(2);
    expect(
      inventory.some(
        (connection) => !connection.a.coordinateAvailable || !connection.b.coordinateAvailable
      )
    ).toBe(true);
    expect(() => resolveMolViewSpecAttachments(plugin(structure), document())).toThrow(
      'missing endpoint coordinates'
    );
  });
});

describe('one native owner for a deposited edge and computed contact guide', () => {
  async function contactDocument() {
    const structure = await source(hemeCif);
    const connection = readMolecularConnections(plugin(structure)).find(
      (c) => c.kind === 'metal-coordination' && c.bondPresent
    )!;
    expect(connection).toBeDefined();
    const guide = {
      kind: 'primitive',
      params: {
        kind: 'tube',
        start: { expressions: [connection.a.selector] },
        end: { expressions: [connection.b.selector] },
        radius: 0.06,
      },
      custom: {
        dnaforge_contact_evidence: {
          contract: 'typed-native-contact-v1',
          classification: 'Metal Coordination',
          endpointMode: 'atoms',
          featureA: { expressions: [connection.a.selector] },
          featureB: { expressions: [connection.b.selector] },
        },
      },
    };
    const document: AttachmentDocument = {
      root: {
        kind: 'root',
        children: [
          {
            kind: 'structure',
            ref: 'native:source',
            children: [
              {
                kind: 'component',
                params: { selector: [connection.a.residueSelector, connection.b.residueSelector] },
                children: [{ kind: 'representation', params: { type: 'ball_and_stick' } }],
              },
              {
                kind: 'primitives',
                custom: { dnaforge_interaction_context: 'native-interaction-context-v1' },
                params: { opacity: 1 },
                children: [guide],
              },
            ],
          },
        ],
      },
    };
    return { structure, document, guide };
  }
  const compiledGuide = (d: AttachmentDocument) => d.root!.children![0].children![1].children![0];
  it('delegates the segment to the actual deposited bond, retaining all canonical evidence', async () => {
    const { structure, document, guide } = await contactDocument();
    const { resolveMolViewSpecNativeContactOwners } = await import('./molecularConnections');
    const resolved = resolveMolViewSpecNativeContactOwners(document, () => structure);
    expect(compiledGuide(resolved).custom?.dnaforge_contact_native_owner).toMatchObject({
      kind: 'metal-coordination',
      structureRef: 'native:source',
    });
    expect(compiledGuide(resolved).params).toEqual(guide.params);
    expect(compiledGuide(resolved).custom?.dnaforge_contact_evidence).toEqual(
      guide.custom.dnaforge_contact_evidence
    );
    expect(guide.custom).not.toHaveProperty('dnaforge_contact_native_owner');
  });
  it.each([
    'hidden-component',
    'hidden-source',
    'disabled-bonds',
    'excluded-type',
    'transparent',
    'zero-size',
    'missing-endpoint',
    'wrong-instance',
  ])('keeps the computed guide when the native owner is %s', async (variant) => {
    const { structure, document } = await contactDocument();
    const parent = document.root!.children![0],
      component = parent.children![0],
      representation = component.children![0];
    const guide = compiledGuide(document);
    guide.custom = { ...guide.custom, dnaforge_contact_native_owner: { forged: true } };
    if (variant === 'hidden-component') component.custom = { is_hidden: true };
    if (variant === 'hidden-source') parent.custom = { is_hidden: true };
    if (variant === 'disabled-bonds')
      representation.custom = { molstar_representation_params: { visuals: ['element-sphere'] } };
    if (variant === 'excluded-type')
      representation.custom = {
        molstar_representation_params: { excludeTypes: ['metal-coordination'] },
      };
    if (variant === 'transparent')
      representation.custom = { molstar_representation_params: { alpha: 0 } };
    if (variant === 'zero-size')
      representation.custom = { molstar_representation_params: { sizeFactor: 0 } };
    if (variant === 'missing-endpoint')
      component.params = {
        selector: (guide.params!.start as { expressions: unknown[] }).expressions,
      };
    if (variant === 'wrong-instance')
      guide.params!.start = {
        expressions: [
          {
            ...(guide.params!.start as { expressions: object[] }).expressions[0],
            instance_id: 'other-copy',
          },
        ],
      };
    const { resolveMolViewSpecNativeContactOwners } = await import('./molecularConnections');
    const resolved = resolveMolViewSpecNativeContactOwners(document, () => structure);
    expect(compiledGuide(resolved).custom).not.toHaveProperty('dnaforge_contact_native_owner');
  });
  it('keeps a guide whose endpoints belong to different sources despite identical coordinates', async () => {
    const { structure, document } = await contactDocument();
    const other = await source(hemeCif);
    const guide = compiledGuide(document);
    guide.params!.start = { ...(guide.params!.start as object), structure_ref: 'native:other' };
    document.root!.children!.push({ kind: 'structure', ref: 'native:other', children: [] });
    const { resolveMolViewSpecNativeContactOwners } = await import('./molecularConnections');
    const resolved = resolveMolViewSpecNativeContactOwners(document, (n) =>
      n.ref === 'native:other' ? other : structure
    );
    expect(compiledGuide(resolved).custom).not.toHaveProperty('dnaforge_contact_native_owner');
  });
});
