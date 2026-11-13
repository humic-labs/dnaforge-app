import { atomicUnitFixture } from '@/test/fixtures/molstar-unit';
import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { describe, expect, it } from 'vitest';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { Structure, StructureElement, StructureSelection } from 'molstar/lib/mol-model/structure';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { Script } from 'molstar/lib/mol-script/script';
import type { ElementIndex } from 'molstar/lib/mol-model/structure/model';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { Camera } from 'molstar/lib/mol-canvas3d/camera';
import { cameraParamsToCameraSnapshot } from 'molstar/lib/extensions/mvs/camera';
import { fovNormalizedCameraPosition } from 'molstar/lib/mol-util/camera';
import {
  FeatureTypes,
  InteractionFlag,
  InteractionType,
} from 'molstar/lib/mol-model-props/computed/interactions/common';
import {
  InteractionsProvider,
  InteractionsParams,
} from 'molstar/lib/mol-model-props/computed/interactions';
import { ContactProviderParams } from 'molstar/lib/mol-model-props/computed/interactions/interactions';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition';
import { Task } from 'molstar/lib/mol-task';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import { StructureRepresentationRegistry } from 'molstar/lib/mol-repr/structure/registry';
import { isProtein, BondType } from 'molstar/lib/mol-model/structure/model/types';
import { InteractionsRepresentationProvider } from 'molstar/lib/mol-model-props/computed/representations/interactions';
import {
  buildMolecularInteractionContext,
  molecularContactGuide,
  coalesceMolecularContactGuides,
  readManagedInteractionContacts,
  molecularContactCenterMarkers,
  resolveMolecularContactCenterMarkers,
  unsupportedNitrogenCharge,
  requireRetainedInteractionContacts,
  requireConstructedInteractionGuides,
  type Contact,
} from './molecularInteractionContext';
import {
  resolveNucleotidePresentations,
  type MolecularProfileNode,
} from './nucleotidePresentationSettings';
import cif from './fixtures/molecular-attachment-1hrc.cif?raw';
import proteinInterfaceCif from './fixtures/molecular-interface-detail-protein.cif?raw';
import overlapFixtures from './fixtures/molecular-contact-overlap-1bmf.json';
import { registerMolecularRenderProfileVisuals } from './nucleotidePresentation';
import { constructMolecularBindingRegions } from './molecularSurfaceOwnership';
import { assignMolViewSpecStructureRefs } from './molViewSpecStructureIdentity';
import { resolveMolecularDisplayGroups } from './molecularDisplayGroups';
import { resolveMolViewSpecRenderProfile } from './molecularRenderProfile';
import { preserveEquivalentGeneratedLegendEntries } from '../utils/molViewSpecStory';

async function fixture() {
  const parsed = await CIF.parseText(cif).run();
  if (parsed.isError) throw new Error(parsed.message);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const source = Structure.ofModel(trajectory.representative);
  const selected = substructureFromSelector(
    source,
    componentPropsFromSelector({ label_comp_id: 'HEC' })
  );
  const plugin = molstarPluginFixture({
    managers: {
      asset: {},
      structure: {
        hierarchy: {
          current: {
            structures: [
              {
                cell: { obj: { data: source } },
                components: [],
              },
            ],
          },
        },
      },
    },
    runTask: (task: { run: () => Promise<unknown> }) => task.run(),
  });
  const builder = MVSData.createBuilder();
  const structure = builder
    .download({ url: 'structure.cif' })
    .parse({ format: 'mmcif' })
    .modelStructure();
  structure
    .component({ selector: 'polymer' })
    .representation({ type: 'cartoon' })
    .color({ color: '#237ac9' });
  structure
    .component({ selector: { label_comp_id: 'HEC' } })
    .representation({ type: 'ball_and_stick' })
    .color({ color: '#e8aa28' });
  return {
    plugin,
    source,
    loci: Structure.toStructureElementLoci(selected),
    document: builder.getState(),
  };
}

function localColors(scene: string) {
  const root = JSON.parse(scene).root;
  const visit = (n: MolecularProfileNode): MolecularProfileNode[] => [
    n,
    ...(n.children ?? []).flatMap(visit),
  ];
  return visit(root).find(
    (n) => n.custom?.dnaforge_interaction_context === 'native-interaction-context-v1'
  )!.children![0].children;
}

describe('typed native contact depiction', () => {
  const points = (
    values: Array<[number, number, number, number]>,
    internalOffset: number
  ): Contact['a'] => {
    const unit = atomicUnitFixture({
      model: {
        atomicHierarchy: {
          atomSourceIndex: { value: (i: number) => values[i - internalOffset][0] },
        },
      },
      conformation: {
        operator: { instanceId: '1_555' },
        position: (i: number, out: Vec3) =>
          Vec3.set(out, ...(values[i - internalOffset].slice(1) as [number, number, number])),
      },
    });
    return values.map((_, i) => ({ unit, index: (internalOffset + i) as ElementIndex }));
  };
  const contact: Contact = {
    type: InteractionType.Ionic,
    label: 'Ionic Interaction',
    color: '#f0c814',
    distance: 4.8,
    a: points(
      [
        [10120, 105.496002, 45.564999, 75.087997],
        [10122, 105.737, 46.535, 73.051003],
        [10123, 106.269997, 47.696999, 74.942001],
      ],
      0
    ),
    b: points(
      [
        [22824, 102.661003, 45.037998, 69.263],
        [22825, 103.761002, 44.543999, 71.453003],
        [22826, 103.647003, 46.955002, 70.584999],
        [22827, 101.608002, 45.820999, 71.444],
      ],
      20
    ),
  };

  it('anchors ionic guides at the nearest actual charge members, with full group evidence', () => {
    const guide = molecularContactGuide(contact);
    expect(guide.params?.start).toEqual({
      expressions: [{ atom_index: 10122, instance_id: '1_555' }],
    });
    expect(guide.params?.end).toEqual({
      expressions: [{ atom_index: 22825, instance_id: '1_555' }],
    });
    const evidence = guide.custom?.dnaforge_contact_evidence as {
      endpointMode: string;
      featureA: { expressions: unknown[] };
      featureB: { expressions: unknown[] };
      featureCenterDistance: number;
      displayedDistance: number;
    };
    expect(evidence.endpointMode).toBe('nearest-charge-members');
    expect(evidence.featureA.expressions).toHaveLength(3);
    expect(evidence.featureB.expressions).toHaveLength(4);
    expect(evidence.featureCenterDistance).toBe(4.8);
    expect(evidence.displayedDistance).toBeCloseTo(3.22835, 4);
    expect(String(guide.params?.tooltip)).toContain('charge-group association');
    expect(String(guide.params?.tooltip)).toContain('not an additional hydrogen bond');
  });

  it('retains aromatic feature centers and their explicit non-atomic meaning', () => {
    const guide = molecularContactGuide({
      ...contact,
      type: InteractionType.PiStacking,
      label: 'Pi Stacking',
    });
    expect(guide.params?.start).toHaveProperty('expressions.length', 3);
    expect(guide.params?.end).toHaveProperty('expressions.length', 4);
    expect(guide.custom?.dnaforge_contact_evidence).toHaveProperty('endpointMode', 'ring-centers');
    expect(String(guide.params?.tooltip)).toContain('not an atom-to-atom bond');
    const markers = molecularContactCenterMarkers(guide);
    expect(markers).toHaveLength(2);
    expect(markers[0].params?.center).toEqual(guide.params?.start);
    expect(markers[1].params?.center).toEqual(guide.params?.end);
    expect(
      markers.every(
        (marker) => marker.params?.kind === 'ellipsoid' && marker.params?.radius === 0.12
      )
    ).toBe(true);
    const root: MolecularProfileNode = {
      kind: 'root',
      children: [
        {
          kind: 'primitives',
          custom: { dnaforge_interaction_context: 'native-interaction-context-v1' },
          children: [guide],
        },
      ],
    };
    resolveMolecularContactCenterMarkers(root);
    expect(root.children![0].children).toHaveLength(3);
    root.children![0].children = [guide];
    resolveMolecularContactCenterMarkers(root);
    resolveMolecularContactCenterMarkers(root);
    expect(root.children![0].children).toHaveLength(3);
  });

  it('preserves atom-level contact endpoints and measurements', () => {
    const atomContact = {
      ...contact,
      type: InteractionType.HydrogenBond,
      label: 'Hydrogen Bond',
      a: [contact.a[1]],
      b: [contact.b[1]],
    };
    const guide = molecularContactGuide(atomContact, true);
    expect(guide.params?.kind).toBe('distance_measurement');
    expect(guide.params?.start).toEqual({
      expressions: [{ atom_index: 10122, instance_id: '1_555' }],
    });
    expect(guide.custom?.dnaforge_contact_evidence).toHaveProperty('endpointMode', 'atoms');
    expect(molecularContactCenterMarkers(guide)).toHaveLength(0);
  });

  it('keeps coincident measurements valid under the native primitive schema', () => {
    const guide = molecularContactGuide(
      {
        ...contact,
        type: InteractionType.HydrogenBond,
        label: 'Hydrogen Bond',
        a: [contact.a[1]],
        b: [contact.b[1]],
      },
      true
    );
    const coincident = structuredClone(guide);
    coincident.custom!.dnaforge_contact_evidence = {
      ...(coincident.custom!.dnaforge_contact_evidence as object),
      classification: 'Ionic Interaction',
    };
    const children = coalesceMolecularContactGuides([guide, coincident]);
    expect(children).toHaveLength(1);
    expect(children[0].params?.kind).toBe('distance_measurement');
    expect(children[0].custom?.dnaforge_contact_evidence_set).toHaveLength(2);
    expect(children[0].params?.label_template).toBe('{{distance}} Å');
    expect(
      MVSData.validationIssues(
        {
          kind: 'single',
          metadata: { version: '1' },
          root: { kind: 'root', children: [{ kind: 'primitives', children }] },
        } as never,
        { noExtra: true }
      )
    ).toBeUndefined();
  });

  it('does not construct a guide for a chemically unsupported native classification', () => {
    expect(() =>
      molecularContactGuide({
        ...contact,
        excludedReason: 'Neutral ligand nitrogen is not a negative charge',
      })
    ).toThrow(/Neutral ligand nitrogen/);
  });

  it('does not describe grouped features as atomic hydrogen bonds', () => {
    expect(() => molecularContactGuide({ ...contact, type: InteractionType.HydrogenBond })).toThrow(
      /one classified atom/
    );
  });
});

describe('coincident classified contact segments', () => {
  const lines = (group: MolecularProfileNode) =>
    (group.children ?? []).filter((node) =>
      ['tube', 'distance_measurement'].includes(String(node.params?.kind))
    );
  const evidence = (nodes: MolecularProfileNode[]) =>
    nodes.flatMap((node) =>
      Array.isArray(node.custom?.dnaforge_contact_evidence_set)
        ? node.custom.dnaforge_contact_evidence_set
        : node.custom?.dnaforge_contact_evidence
          ? [node.custom.dnaforge_contact_evidence]
          : []
    );
  it('reports delegated native segments without changing retained evidence counts', () => {
    const group = structuredClone(overlapFixtures[0].group) as MolecularProfileNode;
    const guide = lines(group)[0];
    group.children = [guide, structuredClone(guide)];
    const scene = () =>
      JSON.stringify({
        kind: 'single',
        metadata: { version: '1' },
        root: { kind: 'root', children: [group] },
      });
    const previous = scene();
    const before = readManagedInteractionContacts(previous)[0];
    for (const node of group.children)
      node.custom = {
        ...node.custom,
        dnaforge_contact_native_owner: { contract: 'native-bond-contact-owner-v1' },
      };
    const after = readManagedInteractionContacts(scene())[0];
    expect(after.contactCount).toBe(before.contactCount);
    expect(after.nativeOwnerContactCount).toBe(1);
    expect(() => requireRetainedInteractionContacts(previous, scene())).not.toThrow();
  });
  for (const fixture of overlapFixtures) {
    it(`draws one segment per exact native endpoint pair for saved ${fixture.name}`, () => {
      const group = structuredClone(fixture.group) as MolecularProfileNode;
      const original = evidence(lines(group));
      const root: MolecularProfileNode = { kind: 'root', children: [group] };
      resolveMolecularContactCenterMarkers(root);
      expect(lines(group)).toHaveLength(fixture.segments);
      expect(
        evidence(lines(group))
          .map((record) => JSON.stringify(record))
          .sort()
      ).toEqual(original.map((record) => JSON.stringify(record)).sort());
      const once = JSON.stringify(root);
      resolveMolecularContactCenterMarkers(root);
      expect(JSON.stringify(root)).toBe(once);
    });
  }

  it('keeps atomic contact style and explains every coincident classification', () => {
    const group = structuredClone(overlapFixtures[0].group) as MolecularProfileNode;
    const root: MolecularProfileNode = { kind: 'root', children: [group] };
    resolveMolecularContactCenterMarkers(root);
    const combined = lines(group).find(
      (node) =>
        evidence([node]).some(
          (record: unknown) =>
            (record as { classification?: string }).classification === 'Ionic Interaction'
        ) &&
        evidence([node]).some(
          (record: unknown) =>
            (record as { classification?: string }).classification === 'Hydrogen Bond'
        )
    );
    expect(combined?.params?.color).toBe('#2b83ba');
    expect(String(combined?.params?.tooltip)).toContain('Hydrogen Bond');
    expect(String(combined?.params?.tooltip)).toContain('Ionic Interaction');
    expect(combined?.custom?.dnaforge_contact_evidence).toHaveProperty('endpointMode', 'atoms');
  });

  it('does not merge different coordinate instances or unclassified authored annotations', () => {
    const group = structuredClone(overlapFixtures[0].group) as MolecularProfileNode;
    const original = lines(group).find(
      (node) =>
        (node.custom?.dnaforge_contact_evidence as { endpointMode?: string })?.endpointMode ===
        'atoms'
    )!;
    const otherInstance = structuredClone(original);
    for (const point of [otherInstance.params!.start, otherInstance.params!.end])
      for (const expression of (point as { expressions: { instance_id: string }[] }).expressions)
        expression.instance_id = 'ASM-2';
    const annotation = { ...structuredClone(original), custom: undefined };
    annotation.params!.tooltip = 'Authored distance annotation';
    group.children = [original, structuredClone(original), otherInstance, annotation];
    resolveMolecularContactCenterMarkers({ kind: 'root', children: [group] });
    expect(lines(group)).toHaveLength(3);
    expect(lines(group)).toContainEqual(otherInstance);
    expect(lines(group)).toContainEqual(annotation);
  });

  it('retains every classification when a coincident segment replaces several guides', () => {
    const group = structuredClone(overlapFixtures[0].group) as MolecularProfileNode;
    const original = JSON.stringify({
      kind: 'single',
      metadata: { version: '1' },
      root: { kind: 'root', children: [group] },
    });
    const root: MolecularProfileNode = { kind: 'root', children: [group] };
    resolveMolecularContactCenterMarkers(root);
    const retained = JSON.stringify({ kind: 'single', metadata: { version: '1' }, root });
    expect(() => requireRetainedInteractionContacts(original, retained)).not.toThrow();
    const combined = lines(group).find((node) =>
      Array.isArray(node.custom?.dnaforge_contact_evidence_set)
    )!;
    combined.custom!.dnaforge_contact_evidence_set = [combined.custom!.dnaforge_contact_evidence];
    expect(() =>
      requireRetainedInteractionContacts(
        original,
        JSON.stringify({ kind: 'single', metadata: { version: '1' }, root })
      )
    ).toThrow(/computed contact/);
  });
});

describe('computed context provenance across whole-scene edits', () => {
  it('reduces repeated protein backbone while retaining native features and covalent trace paths', async () => {
    const f = await fixture();
    const parsed = await CIF.parseText(proteinInterfaceCif).run();
    if (parsed.isError) throw Error(parsed.message);
    f.source = Structure.ofModel(
      (await trajectoryFromMmCIF(parsed.result.blocks[0]).run()).representative
    );
    f.plugin.managers.structure.hierarchy.current.structures[0].cell.obj!.data = f.source;
    const builder = MVSData.createBuilder();
    builder
      .download({ url: 'protein-interface.cif' })
      .parse({ format: 'mmcif' })
      .modelStructure()
      .component({ selector: 'all' })
      .representation({ type: 'cartoon' });
    const target = { label_asym_id: 'A' };
    const loci = Structure.toStructureElementLoci(
      substructureFromSelector(f.source, componentPropsFromSelector(target))
    );
    const options = {
      targetSelector: target,
      partnerSelector: { label_asym_id: 'B' },
      presentationRole: 'interface' as const,
      surfaceSide: 'partner' as const,
      interfaceDetailSide: 'both' as const,
      interfaceDetailBasis: 'burial' as const,
      focus: false,
    };
    const defaultDetail = await buildMolecularInteractionContext(
      f.plugin,
      builder.getState(),
      loci,
      options
    );
    const reduced = await buildMolecularInteractionContext(f.plugin, builder.getState(), loci, {
      ...options,
      interfaceProteinAtomicMode: 'sidechain-with-trace',
    });
    const complete = await buildMolecularInteractionContext(f.plugin, builder.getState(), loci, {
      ...options,
      interfaceProteinAtomicMode: 'full-residue',
    });
    expect(defaultDetail.context.interfaceProteinAtomicMode).toBe('sidechain-with-trace');
    expect(defaultDetail.context.environmentAtomCount).toBe(reduced.context.environmentAtomCount);
    expect(defaultDetail.context.interfaceBurial).toEqual(reduced.context.interfaceBurial);
    expect(reduced.context.interfaceProteinAtomicMode).toBe('sidechain-with-trace');
    expect(complete.context.interfaceProteinAtomicMode).toBe('full-residue');
    expect(reduced.context.environmentAtomCount).toBeLessThan(
      complete.context.environmentAtomCount
    );
    expect(reduced.context.interfaceBurial).toEqual(complete.context.interfaceBurial);
    expect(reduced.context.contactCalculation).toEqual(complete.context.contactCalculation);
    expect(reduced.context.contactCount).toEqual(complete.context.contactCount);
    expect(reduced.context.surfaceAtomCount).toEqual(complete.context.surfaceAtomCount);
    const doc = JSON.parse(reduced.scene);
    const owner = context(doc.root);
    expect(owner.custom!.dnaforge_binding_region).toMatchObject({
      interfaceProteinAtomicMode: 'sidechain-with-trace',
    });
    const selected = substructureFromSelector(
      f.source,
      componentPropsFromSelector(owner.params!.selector as never)
    );
    const selectedAtoms = new Set(
      selected.units.flatMap((u) => Array.from(u.elements, (a) => `${u.id}:${a}`))
    );
    const required = new Set<string>();
    for (const node of walk(doc.root)) {
      const evidence = (node.custom?.dnaforge_contact_evidence_set ??
        (node.custom?.dnaforge_contact_evidence
          ? [node.custom.dnaforge_contact_evidence]
          : [])) as Array<{
        featureA: { expressions: unknown[] };
        featureB: { expressions: unknown[] };
      }>;
      for (const item of evidence)
        for (const feature of [item.featureA, item.featureB]) {
          const atoms = substructureFromSelector(
            f.source,
            componentPropsFromSelector(feature.expressions as never)
          );
          for (const u of atoms.units) for (const a of u.elements) required.add(`${u.id}:${a}`);
        }
    }
    expect(required.size).toBeGreaterThan(0);
    expect([...required].every((a) => selectedAtoms.has(a))).toBe(true);
    for (const unit of f.source.units) {
      if (unit.kind !== 0) continue;
      for (const atom of unit.elements) {
        if (!selectedAtoms.has(`${unit.id}:${atom}`)) continue;
        const residue = unit.residueIndex[atom];
        const trace = unit.model.atomicHierarchy.derived.residue.traceElementIndex[residue];
        const seen = new Set<number>([atom]);
        const queue: number[] = [atom];
        for (let i = 0; i < queue.length && !seen.has(trace); i++) {
          const index = Array.from(unit.elements, Number).indexOf(queue[i]);
          for (let e = unit.bonds.offset[index]; e < unit.bonds.offset[index + 1]; e++) {
            const next = unit.elements[unit.bonds.b[e]];
            if (
              !(unit.bonds.edgeProps.flags[e] & BondType.Flag.Covalent) ||
              unit.residueIndex[next] !== residue ||
              !selectedAtoms.has(`${unit.id}:${next}`) ||
              seen.has(next)
            )
              continue;
            seen.add(next);
            queue.push(next);
          }
        }
        expect(
          seen.has(trace),
          `${unit.id}:${atom} must retain its source covalent path to the native cartoon trace`
        ).toBe(true);
      }
    }
    expect(() => requireConstructedInteractionGuides(reduced.scene, reduced.scene)).not.toThrow();
    (owner.custom!.dnaforge_binding_region as Record<string, unknown>).interfaceProteinAtomicMode =
      'full-residue';
    expect(() => requireConstructedInteractionGuides(reduced.scene, JSON.stringify(doc))).toThrow(
      /must be constructed/
    );
  });
  it('separates protein presentation from complete burial and native guide support', async () => {
    const f = await fixture();
    const parsed = await CIF.parseText(proteinInterfaceCif).run();
    if (parsed.isError) throw Error(parsed.message);
    f.source = Structure.ofModel(
      (await trajectoryFromMmCIF(parsed.result.blocks[0]).run()).representative
    );
    f.plugin.managers.structure.hierarchy.current.structures[0].cell.obj!.data = f.source;
    const builder = MVSData.createBuilder();
    builder
      .download({ url: 'protein-interface.cif' })
      .parse({ format: 'mmcif' })
      .modelStructure()
      .component({ selector: 'all' })
      .representation({ type: 'cartoon' });
    f.document = builder.getState();
    const target = { label_asym_id: 'A' };
    const partner = { label_asym_id: 'B' };
    const loci = Structure.toStructureElementLoci(
      substructureFromSelector(f.source, componentPropsFromSelector(target))
    );
    const options = {
      targetSelector: target,
      partnerSelector: partner,
      presentationRole: 'interface' as const,
      surfaceSide: 'partner' as const,
      interfaceProteinAtomicMode: 'full-residue' as const,
      focus: false,
    };
    const originalDocument = structuredClone(f.document);
    for (const choices of [
      {},
      { interfaceDetailSide: 'target' as const },
      { interfaceDetailBasis: 'contacts' as const },
    ])
      await expect(
        buildMolecularInteractionContext(f.plugin, f.document, loci, { ...options, ...choices })
      ).rejects.toMatchObject({ code: 'INTERFACE_DETAIL_REQUIRED' });
    expect(f.document).toEqual(originalDocument);
    const both = await buildMolecularInteractionContext(f.plugin, f.document, loci, {
      ...options,
      interfaceDetailSide: 'both',
      interfaceDetailBasis: 'burial',
    });
    const bothContacts = await buildMolecularInteractionContext(f.plugin, f.document, loci, {
      ...options,
      interfaceDetailSide: 'both',
      interfaceDetailBasis: 'contacts',
    });
    const chosen = await buildMolecularInteractionContext(f.plugin, f.document, loci, {
      ...options,
      interfaceDetailSide: 'target',
      interfaceDetailBasis: 'contacts',
    });
    expect(both.context.environmentAtomCount).toBe(
      both.context.interfaceBurial!.target.atomCount +
        both.context.interfaceBurial!.partner.atomCount
    );
    expect(chosen.context.interfaceBurial).toEqual(both.context.interfaceBurial);
    expect(chosen.context.contactCalculation).toEqual(both.context.contactCalculation);
    expect(chosen.context.contactCount).toBeGreaterThan(0);
    expect(chosen.context.contactCount).toEqual(both.context.contactCount);
    expect(chosen.context.environmentAtomCount).toBeLessThan(both.context.environmentAtomCount);
    expect(bothContacts.context.interfaceBurial).toEqual(both.context.interfaceBurial);
    expect(bothContacts.context.contactCalculation).toEqual(both.context.contactCalculation);
    expect(bothContacts.context.contactCount).toEqual(both.context.contactCount);
    expect(bothContacts.context.environmentAtomCount).toBeLessThanOrEqual(
      both.context.environmentAtomCount
    );
    const document = JSON.parse(chosen.scene);
    const context = walk(document.root).find((node) => node.ref === chosen.contextRef)!;
    const region = context.custom!.dnaforge_binding_region as Record<string, unknown>;
    expect(region).toMatchObject({
      interfaceDetailSide: 'target',
      interfaceDetailBasis: 'contacts',
    });
    const displayed = substructureFromSelector(
      f.source,
      componentPropsFromSelector(context.params!.selector as never)
    );
    const displayedAtoms = new Set(
      displayed.units.flatMap((unit) => Array.from(unit.elements, (atom) => `${unit.id}:${atom}`))
    );
    const required = new Set<string>();
    for (const node of walk(document.root)) {
      const evidence = (node.custom?.dnaforge_contact_evidence_set ??
        (node.custom?.dnaforge_contact_evidence
          ? [node.custom.dnaforge_contact_evidence]
          : [])) as Array<{
        featureA: { expressions: unknown[] };
        featureB: { expressions: unknown[] };
      }>;
      for (const item of evidence)
        for (const feature of [item.featureA, item.featureB]) {
          const members = substructureFromSelector(
            f.source,
            componentPropsFromSelector(feature.expressions as never)
          );
          for (const unit of members.units)
            for (const atom of unit.elements) required.add(`${unit.id}:${atom}`);
        }
    }
    expect(required.size).toBeGreaterThan(0);
    expect([...required].every((key) => displayedAtoms.has(key))).toBe(true);
    const bothContactsDocument = JSON.parse(bothContacts.scene);
    const bothContactsOwner = walk(bothContactsDocument.root).find(
      (node) => node.ref === bothContacts.contextRef
    )!;
    expect(bothContactsOwner.custom!.dnaforge_binding_region).toMatchObject({
      interfaceDetailSide: 'both',
      interfaceDetailBasis: 'contacts',
    });
    const bothContactsAtoms = new Set(
      substructureFromSelector(
        f.source,
        componentPropsFromSelector(bothContactsOwner.params!.selector as never)
      ).units.flatMap((unit) => Array.from(unit.elements, (atom) => `${unit.id}:${atom}`))
    );
    expect([...required].every((key) => bothContactsAtoms.has(key))).toBe(true);
    expect(() =>
      requireConstructedInteractionGuides(bothContacts.scene, bothContacts.scene)
    ).not.toThrow();
    const opposing = substructureFromSelector(f.source, componentPropsFromSelector(partner));
    const opposingProteins = opposing.units.flatMap((unit) =>
      unit.kind === 0
        ? Array.from(unit.elements)
            .filter((atom) =>
              isProtein(
                unit.model.atomicHierarchy.derived.residue.moleculeType[unit.residueIndex[atom]]
              )
            )
            .map((atom) => `${unit.id}:${atom}`)
        : []
    );
    expect(opposingProteins.filter((key) => displayedAtoms.has(key) && !required.has(key))).toEqual(
      []
    );
    expect(() => requireConstructedInteractionGuides(chosen.scene, chosen.scene)).not.toThrow();
    region.interfaceDetailSide = 'partner';
    expect(() =>
      requireConstructedInteractionGuides(chosen.scene, JSON.stringify(document))
    ).toThrow(/must be constructed/);
  });
  const walk = (node: MolecularProfileNode): MolecularProfileNode[] => [
    node,
    ...(node.children ?? []).flatMap(walk),
  ];
  const context = (root: MolecularProfileNode) =>
    walk(root).find(
      (node) =>
        node.kind === 'component' &&
        node.custom?.dnaforge_interaction_context === 'native-interaction-context-v1' &&
        !node.custom?.dnaforge_surface_owner
    )!;

  it('rejects computed membership and calculation changes even while all native guides remain', async () => {
    const f = await fixture();
    const plan = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
    });
    const current = JSON.parse(plan.scene);
    const edits: Array<[string, (node: MolecularProfileNode) => void]> = [
      [
        'selector shrink',
        (node) => {
          node.params!.selector = (node.params!.selector as unknown[]).slice(1);
        },
      ],
      [
        'selector expansion',
        (node) => {
          node.params!.selector = 'all';
        },
      ],
      ...['detail', 'target', 'seed', 'partner'].map(
        (field): [string, (node: MolecularProfileNode) => void] => [
          field,
          (node) => {
            (node.custom!.dnaforge_binding_region as Record<string, unknown>)[field] = 'all';
          },
        ]
      ),
      [
        'radius',
        (node) => {
          (node.custom!.dnaforge_binding_region as Record<string, unknown>).radius = 6;
        },
      ],
      [
        'detailMode',
        (node) => {
          (node.custom!.dnaforge_binding_region as Record<string, unknown>).detailMode =
            'neighborhood';
        },
      ],
      [
        'region stripped',
        (node) => {
          delete node.custom!.dnaforge_binding_region;
        },
      ],
      [
        'marker stripped',
        (node) => {
          delete node.custom!.dnaforge_interaction_context;
        },
      ],
      [
        'ref renamed',
        (node) => {
          node.ref = 'renamed-computed-context';
        },
      ],
    ];
    for (const [name, edit] of edits) {
      const proposed = structuredClone(current);
      edit(context(proposed.root));
      expect(
        () => requireConstructedInteractionGuides(plan.scene, JSON.stringify(proposed)),
        name
      ).toThrow(/must be constructed/);
    }
  });

  it('rejects forged tags and a different coordinate source even without contact guides', async () => {
    const f = await fixture();
    const plan = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
    });
    const current = JSON.parse(plan.scene);
    const structure = walk(current.root).find((node) => node.kind === 'structure')!;
    structure.children = structure.children!.filter((node) => node.kind !== 'primitives');
    const trusted = JSON.stringify(current);
    expect(() => requireConstructedInteractionGuides(JSON.stringify(f.document), trusted)).toThrow(
      /must be constructed/
    );
    const otherSource = structuredClone(current);
    walk(otherSource.root).find((node) => node.kind === 'download')!.params!.url =
      'other-structure.cif';
    expect(() => requireConstructedInteractionGuides(trusted, JSON.stringify(otherSource))).toThrow(
      /must be constructed/
    );
    const forged = structuredClone(current);
    const extra = structuredClone(context(forged.root));
    extra.ref = 'forged-native-context';
    walk(forged.root)
      .find((node) => node.kind === 'structure')!
      .children!.push(extra);
    expect(() => requireConstructedInteractionGuides(trusted, JSON.stringify(forged))).toThrow(
      /must be constructed/
    );
  });

  it('allows context styling and a renamed unmarked overview alongside the intact native detail', async () => {
    const f = await fixture();
    const plan = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
    });
    const current = JSON.parse(plan.scene);
    const detail = structuredClone(current.root);
    const retained = context(detail);
    const region = retained.custom!.dnaforge_binding_region as Record<string, unknown>;
    region.surfaceSide = 'partner';
    region.surfaceColorMode = 'emphasis';
    retained.params!.selector = [...(retained.params!.selector as unknown[])].reverse();
    retained.children![0].children = [{ kind: 'color', params: { color: '#aa5588' } }];
    const overview = structuredClone(current.root);
    const original = context(overview);
    original.ref = 'overview-context';
    original.params!.selector = 'polymer';
    delete original.custom!.dnaforge_interaction_context;
    delete original.custom!.dnaforge_binding_region;
    const structure = walk(overview).find((node) => node.kind === 'structure')!;
    structure.children = structure.children!.filter((node) => node.kind !== 'primitives');
    const story = {
      kind: 'multiple',
      metadata: current.metadata,
      snapshots: [{ root: overview }, { root: detail }],
    };
    expect(() =>
      requireConstructedInteractionGuides(plan.scene, JSON.stringify(story))
    ).not.toThrow();
    const stripped = structuredClone(story);
    walk(stripped.snapshots[0].root).find((node) => node.ref === 'overview-context')!.ref = context(
      current.root
    ).ref;
    expect(() => requireConstructedInteractionGuides(plan.scene, JSON.stringify(stripped))).toThrow(
      /must be constructed/
    );
    expect(() =>
      requireConstructedInteractionGuides(
        plan.scene,
        JSON.stringify({ ...current, root: overview })
      )
    ).toThrow(/must be constructed/);
    const noContext = structuredClone(overview);
    const overviewStructure = walk(noContext).find((node) => node.kind === 'structure')!;
    overviewStructure.children = overviewStructure.children!.filter(
      (node) => node.ref !== 'overview-context'
    );
    expect(() =>
      requireConstructedInteractionGuides(
        plan.scene,
        JSON.stringify({
          ...story,
          snapshots: [{ root: noContext }, { root: detail }],
        })
      )
    ).not.toThrow();
  });

  it('accepts the constructed complete native context and its separate generated surface owner', async () => {
    const f = await fixture();
    const plan = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
      surfaceSide: 'partner',
    });
    const current = JSON.parse(plan.scene);
    context(current.root).children!.push({ kind: 'representation', params: { type: 'surface' } });
    const constructed = constructMolecularBindingRegions(current, () => f.source);
    expect(
      walk((constructed as typeof current).root).some((node) => node.custom?.dnaforge_surface_owner)
    ).toBe(true);
    expect(() =>
      requireConstructedInteractionGuides(plan.scene, MVSData.toMVSJ(constructed))
    ).not.toThrow();
  });
});

describe('computed contact retention across whole-scene edits', () => {
  it('refuses hand-picked or forged contact sets while allowing complete inherited styling and neutral measurements', async () => {
    const f = await fixture();
    const plan = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
    });
    const current = JSON.parse(plan.scene);
    const walk = (node: MolecularProfileNode): MolecularProfileNode[] => [
      node,
      ...(node.children ?? []).flatMap(walk),
    ];
    const edited = structuredClone(current);
    const group = walk(edited.root).find(
      (n) =>
        n.kind === 'primitives' &&
        n.custom?.dnaforge_interaction_context === 'native-interaction-context-v1'
    )!;
    for (const node of group.children!)
      if (node.params?.kind === 'tube') {
        node.params.color = '#cc4499';
        node.params.radius = 0.08;
      }
    expect(() =>
      requireConstructedInteractionGuides(plan.scene, JSON.stringify(edited))
    ).not.toThrow();
    expect(() =>
      requireConstructedInteractionGuides(JSON.stringify(f.document), plan.scene)
    ).toThrow(/must be constructed/);
    const partial = structuredClone(current);
    walk(partial.root)
      .find(
        (n) =>
          n.kind === 'primitives' &&
          n.custom?.dnaforge_interaction_context === 'native-interaction-context-v1'
      )!
      .children!.pop();
    expect(() => requireConstructedInteractionGuides(plan.scene, JSON.stringify(partial))).toThrow(
      /must be constructed/
    );
    const otherCopy = structuredClone(current);
    walk(otherCopy.root).find((n) => n.kind === 'structure')!.ref = 'wrong-coordinate-copy';
    expect(() =>
      requireConstructedInteractionGuides(plan.scene, JSON.stringify(otherCopy))
    ).toThrow(/must be constructed/);
    const fromScratch: { root: MolecularProfileNode } = structuredClone(f.document);
    const append = (primitive: MolecularProfileNode) => {
      const scene = structuredClone(fromScratch);
      scene.root.children!.push({ kind: 'primitives', children: [primitive] });
      return JSON.stringify(scene);
    };
    expect(() =>
      requireConstructedInteractionGuides(
        JSON.stringify(f.document),
        append({
          kind: 'primitive',
          params: { kind: 'tube', start: [0, 0, 0], end: [1, 0, 0], dash_length: 0.1 },
        })
      )
    ).toThrow(/must be constructed/);
    expect(() =>
      requireConstructedInteractionGuides(
        JSON.stringify(f.document),
        append({
          kind: 'primitive',
          params: {
            kind: 'line',
            start: { expression: { atom_index: 1 } },
            end: { expression: { atom_index: 2 } },
          },
        })
      )
    ).toThrow(/must be constructed/);
    expect(() =>
      requireConstructedInteractionGuides(
        JSON.stringify(f.document),
        append({ kind: 'primitive', params: { kind: 'arrow', start: [0, 0, 0], end: [1, 0, 0] } })
      )
    ).not.toThrow();
    expect(() =>
      requireConstructedInteractionGuides(
        JSON.stringify(f.document),
        append({
          kind: 'primitive',
          params: { kind: 'arrow', start: [0, 0, 0], end: [1, 0, 0], tube_dash_length: 0.1 },
        })
      )
    ).toThrow(/must be constructed/);
    expect(() =>
      requireConstructedInteractionGuides(
        JSON.stringify(f.document),
        append({
          kind: 'primitive',
          params: { kind: 'lines', vertices: [0, 0, 0, 1, 0, 0], indices: [0, 1] },
        })
      )
    ).toThrow(/must be constructed/);
    const measurement = {
      kind: 'primitive',
      params: {
        kind: 'distance_measurement',
        start: { structure_ref: 'source', expression: { atom_index: 1 } },
        end: { structure_ref: 'source', expression: { atom_index: 2 } },
      },
    };
    expect(() =>
      requireConstructedInteractionGuides(JSON.stringify(f.document), append(measurement))
    ).not.toThrow();
    for (const params of [
      { start: [0, 0, 0], end: [1, 0, 0] },
      { label_template: 'Predicted contact' },
      { label_size: 0 },
    ])
      expect(() =>
        requireConstructedInteractionGuides(
          JSON.stringify(f.document),
          append({ ...measurement, params: { ...measurement.params, ...params } })
        )
      ).toThrow(/must be constructed/);
  });
  it('discovers whole-residue Focus neighbors before choosing the same conformer for native atoms and contacts', async () => {
    const boundaryCif = `data_focus_boundary
loop_
_entity.id
_entity.type
1 polymer
2 non-polymer
loop_
_struct_asym.id
_struct_asym.entity_id
A 1
B 2
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_entity_id
_atom_site.label_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.occupancy
_atom_site.B_iso_or_equiv
_atom_site.auth_seq_id
_atom_site.auth_comp_id
_atom_site.auth_asym_id
_atom_site.auth_atom_id
_atom_site.pdbx_PDB_model_num
ATOM 1 C CA . SER A 1 1 8 0 0 1 10 1 SER A CA 1
ATOM 2 C CB A SER A 1 1 8 1 0 0.8 10 1 SER A CB 1
ATOM 3 O OG A SER A 1 1 8 2 0 0.8 10 1 SER A OG 1
ATOM 4 C CB B SER A 1 1 4 1 0 0.2 10 1 SER A CB 1
ATOM 5 O OG B SER A 1 1 4 2 0 0.2 10 1 SER A OG 1
HETATM 6 C C1 . BTN B 2 . 0 0 0 1 10 1 BTN B C1 1
#
`;
    const parsed = await CIF.parseText(boundaryCif).run();
    if (parsed.isError) throw new Error(parsed.message);
    const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
    const source = Structure.ofModel(trajectory.representative);
    const target = substructureFromSelector(
      source,
      componentPropsFromSelector({ label_comp_id: 'BTN' })
    );
    const f = await fixture();
    f.plugin.managers.structure.hierarchy.current.structures[0].cell.obj!.data = source;
    const builder = MVSData.createBuilder();
    builder
      .download({ url: 'boundary.cif' })
      .parse({ format: 'mmcif' })
      .modelStructure()
      .component({ selector: 'all' })
      .representation({ type: 'ball_and_stick' });
    const document = builder.getState();
    const loci = Structure.toStructureElementLoci(target);
    const environment = StructureSelection.unionStructure(
      Script.getStructureSelection(
        MS.struct.modifier.includeSurroundings({
          0: StructureElement.Bundle.toExpression(StructureElement.Bundle.fromLoci(loci)),
          radius: 5,
          'as-whole-residues': true,
        }),
        source
      )
    );
    expect(environment.elementCount).toBe(6);
    const registry = new StructureRepresentationRegistry();
    registry.add(InteractionsRepresentationProvider);
    let activeRoot: MolecularProfileNode | undefined = document.root;
    registerMolecularRenderProfileVisuals(
      { representation: { structure: { registry } } } as never,
      () => activeRoot
    );
    const atomIds = (selected: Structure) =>
      selected.units
        .flatMap((unit) =>
          Array.from(unit.elements, (atom) =>
            unit.model.atomicHierarchy.atomSourceIndex.value(atom)
          )
        )
        .sort((a, b) => a - b);
    const nativeAtoms = registry.get('ball-and-stick');
    const nativeContacts = registry.get('interactions');
    expect(nativeContacts.getParams({} as never, environment)).toEqual(
      InteractionsRepresentationProvider.getParams({} as never, environment)
    );
    expect(nativeContacts.defaultColorTheme).toEqual(
      InteractionsRepresentationProvider.defaultColorTheme
    );
    expect(nativeContacts.defaultValues).toEqual(InteractionsRepresentationProvider.defaultValues);
    const selectedAtoms = nativeAtoms.getData!(environment, nativeAtoms.defaultValues);
    const selectedContacts = nativeContacts.getData!(environment, nativeContacts.defaultValues);
    expect(atomIds(selectedAtoms)).toEqual([0, 1, 2, 5]);
    expect(atomIds(selectedContacts)).toEqual(atomIds(selectedAtoms));
    const plan = await buildMolecularInteractionContext(f.plugin, document, loci, { focus: false });
    const walk = (node: MolecularProfileNode): MolecularProfileNode[] => [
      node,
      ...(node.children ?? []).flatMap(walk),
    ];
    const component = walk(JSON.parse(plan.scene).root).find(
      (node) => node.custom?.dnaforge_interaction_context === 'native-interaction-context-v1'
    )!;
    const constructedAtoms = substructureFromSelector(
      source,
      componentPropsFromSelector(component.params!.selector as never)
    );
    expect(atomIds(constructedAtoms)).toEqual([5]);
    activeRoot = undefined;
    expect(nativeContacts.getData!(environment, nativeContacts.defaultValues)).toBe(environment);
    activeRoot = {
      kind: 'root',
      custom: {
        dnaforge_conformer_comparison: { reason: 'Compare deposited side-chain alternatives.' },
      },
    };
    expect(nativeContacts.getData!(environment, nativeContacts.defaultValues)).toBe(environment);
    expect(nativeAtoms.getData!(environment, nativeAtoms.defaultValues).elementCount).toBe(6);
  });

  it('retains every standard native ligand-boundary contact and excludes surrounding-only edges', async () => {
    const f = await fixture();
    const expression = StructureElement.Bundle.toExpression(
      StructureElement.Bundle.fromLoci(f.loci)
    );
    const environment = StructureSelection.unionStructure(
      Script.getStructureSelection(
        MS.struct.modifier.includeSurroundings({
          0: expression,
          radius: 5,
          'as-whole-residues': true,
        }),
        f.source
      )
    );
    const parameters = PD.getDefaultValues(InteractionsParams);
    await f.plugin.runTask(
      Task.create('Independent native Focus oracle', (ctx) =>
        InteractionsProvider.attach(
          { runtime: ctx, assetManager: f.plugin.managers.asset },
          environment,
          parameters
        )
      )
    );
    const data = InteractionsProvider.get(environment).value!;
    const target = new Set(
      StructureElement.Loci.toStructure(f.loci).units.flatMap((u) =>
        Array.from(
          u.elements,
          (atom) =>
            `${u.conformation.operator.instanceId}:${u.model.atomicHierarchy.atomSourceIndex.value(atom)}`
        )
      )
    );
    const feature = (unit: Unit, index: number) => {
      const features = data.unitsFeatures.get(unit.id)!;
      return Array.from(
        { length: features.offsets[index + 1] - features.offsets[index] },
        (_, i) =>
          `${unit.conformation.operator.instanceId}:${unit.model.atomicHierarchy.atomSourceIndex.value(unit.elements[features.members[features.offsets[index] + i]])}`
      ).sort();
    };
    const key = (type: number, a: string[], b: string[]) =>
      `${type}:${[a.join('|'), b.join('|')].sort().join(' <> ')}`;
    const expected = new Set<string>();
    let surroundingOnly = 0;
    const add = (ua: Unit, ia: number, ub: Unit, ib: number, type: number, flag: number) => {
      if (flag & InteractionFlag.Filtered) return;
      const a = feature(ua, ia),
        b = feature(ub, ib);
      const onTargetA = a.every((atom) => target.has(atom));
      const onTargetB = b.every((atom) => target.has(atom));
      if (onTargetA !== onTargetB) expected.add(key(type, a, b));
      else if (!onTargetA && !onTargetB) surroundingOnly++;
    };
    for (const unit of environment.units) {
      const edges = data.unitsContacts.get(unit.id)!;
      for (let i = 0; i < edges.a.length; i++)
        if (edges.a[i] < edges.b[i])
          add(unit, edges.a[i], unit, edges.b[i], edges.edgeProps.type[i], edges.edgeProps.flag[i]);
    }
    for (const edge of data.contacts.edges)
      add(
        environment.unitMap.get(edge.unitA)!,
        edge.indexA,
        environment.unitMap.get(edge.unitB)!,
        edge.indexB,
        edge.props.type,
        edge.props.flag
      );
    expect(surroundingOnly).toBeGreaterThan(0);
    const plan = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
    });
    const walk = (node: MolecularProfileNode): MolecularProfileNode[] => [
      node,
      ...(node.children ?? []).flatMap(walk),
    ];
    const records = walk(JSON.parse(plan.scene).root).flatMap(
      (node) =>
        node.custom?.dnaforge_contact_evidence_set ??
        (node.custom?.dnaforge_contact_evidence ? [node.custom.dnaforge_contact_evidence] : [])
    ) as Array<{
      type: number;
      featureA: { expressions: Array<{ atom_index: number; instance_id: string }> };
      featureB: { expressions: Array<{ atom_index: number; instance_id: string }> };
    }>;
    const observed = new Set(
      records.map((r) =>
        key(
          r.type,
          r.featureA.expressions.map((e) => `${e.instance_id}:${e.atom_index}`).sort(),
          r.featureB.expressions.map((e) => `${e.instance_id}:${e.atom_index}`).sort()
        )
      )
    );
    expect(observed).toEqual(expected);
    expect(plan.context.contactCount).toBe(expected.size);
    expect(plan.context.contactCalculation.parameters).toEqual(parameters);
    expect(plan.context.contactCalculation.contract).toBe('native-molstar-binding-boundary-v2');
    expect(plan.context.detailMode).toBe('contact-residues');
    for (const forbidden of [
      { contactTypes: ['hydrogen-bonds'] },
      { radius: 5 },
      { detailMode: 'neighborhood' },
    ])
      await expect(
        buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
          focus: false,
          ...forbidden,
        })
      ).rejects.toThrow(/cannot be overridden/);
  });

  it('excludes native ligand nitrogen charge assignments unsupported by deposited or computed charge', async () => {
    const f = await fixture();
    const parameters = PD.getDefaultValues(InteractionsParams);
    const ionic = ContactProviderParams.ionic.map('on');
    if (ionic.type !== 'group') throw new Error('Installed ionic parameters are unavailable.');
    parameters.providers.ionic = { name: 'on', params: PD.getDefaultValues(ionic.params) };
    await f.plugin.runTask(
      Task.create('Native ionic classifier audit', (ctx) =>
        InteractionsProvider.attach(
          { runtime: ctx, assetManager: f.plugin.managers.asset },
          f.source,
          parameters
        )
      )
    );
    const data = InteractionsProvider.get(f.source).value!;
    const found: string[] = [];
    for (const unit of f.source.units) {
      const features = data.unitsFeatures.get(unit.id)!;
      for (let feature = 0; feature < features.count; feature++) {
        if (Number(features.types[feature]) !== FeatureTypes.NegativeCharge) continue;
        const members = Array.from(
          { length: features.offsets[feature + 1] - features.offsets[feature] },
          (_, i) => ({
            unit: unit as Unit.Atomic,
            index: unit.elements[features.members[features.offsets[feature] + i]],
          })
        );
        if (
          !members.every(
            (p) =>
              unit.model.atomicHierarchy.atoms.label_comp_id.value(p.index) === 'HEC' &&
              unit.model.atomicHierarchy.atoms.type_symbol.value(p.index) === 'N'
          )
        )
          continue;
        const reason = unsupportedNitrogenCharge(f.source, members, feature, features);
        expect(reason).toMatch(
          /without a supporting negative deposited or computed valence charge/
        );
        found.push(reason!);
      }
    }
    expect(found.length).toBeGreaterThan(0);
  });

  it('keeps contact lines unlabeled by default and permits explicit distance labels', async () => {
    const f = await fixture();
    const build = (measurements?: boolean) =>
      buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
        focus: false,
        measurements,
      });
    const plain = await build();
    const labeled = await build(true);
    const guides = (scene: string): MolecularProfileNode[] => {
      const visit = (node: MolecularProfileNode): MolecularProfileNode[] => [
        node,
        ...(node.children ?? []).flatMap(visit),
      ];
      return visit(JSON.parse(scene).root).filter((node) => node.kind === 'primitive');
    };
    const plainGuides = guides(plain.scene);
    expect(plainGuides.length).toBeGreaterThan(0);
    expect(plainGuides.every((node) => node.params?.kind === 'tube')).toBe(true);
    expect(plainGuides.every((node) => String(node.params?.tooltip).includes('Å'))).toBe(true);
    expect(guides(labeled.scene).length).toBe(plainGuides.length);
    expect(guides(labeled.scene).some((node) => node.params?.kind === 'distance_measurement')).toBe(
      true
    );
    expect(labeled.context.contactCount).toBe(plain.context.contactCount);
  });
  it('records an explicit contact policy and ignores an ambient disabled interaction cache', async () => {
    const f = await fixture();
    const original = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
    });
    const props = PD.getDefaultValues(InteractionsParams);
    for (const key of Object.keys(props.providers) as Array<keyof typeof props.providers>) {
      props.providers[key] = { name: 'off', params: {} };
    }
    try {
      await f.plugin.runTask(
        Task.create('Change ambient interaction cache', (ctx) =>
          InteractionsProvider.attach(
            { runtime: ctx, assetManager: f.plugin.managers.asset, errorContext: undefined },
            f.source,
            props
          )
        )
      );
      const rewritten = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
        focus: false,
      });
      expect(rewritten.context.contactCount).toBe(original.context.contactCount);
      expect(rewritten.context).toHaveProperty('contactCalculation.types');
      expect(rewritten.context).toHaveProperty('contactCalculation.parameters');
      expect(rewritten.context.contactCalculation).toEqual(original.context.contactCalculation);
    } finally {
      await f.plugin.runTask(
        Task.create('Restore contact cache', (ctx) =>
          InteractionsProvider.attach(
            { runtime: ctx, assetManager: f.plugin.managers.asset, errorContext: undefined },
            f.source,
            PD.getDefaultValues(InteractionsParams)
          )
        )
      );
    }
  });
  it('keeps a complete ligand contour when interface mode requests the protein side', async () => {
    const f = await fixture();
    const plan = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
      presentationRole: 'interface',
      surfaceSide: 'partner',
      partnerSelector: 'polymer',
    });
    expect(plan.context.presentationRole).toBe('binding-site');
    expect(plan.context.surfaceSide).toBe('target');
    const root = JSON.parse(plan.scene).root;
    const region = root.children[0].children[0].children[0].children.find(
      (n: MolecularProfileNode) =>
        n.custom?.dnaforge_interaction_context === 'native-interaction-context-v1'
    );
    expect(region.custom.dnaforge_presentation_role).toBe('binding-site');
    const selected = substructureFromSelector(
      f.source,
      componentPropsFromSelector(region.params.selector)
    );
    expect(selected.elementCount).toBe(plan.context.environmentAtomCount);
    expect(
      selected.units.flatMap((u) =>
        Array.from(u.elements).map((i) => u.model.atomicHierarchy.atoms.label_comp_id.value(i))
      )
    ).toContain('HEC');
    expect(selected.elementCount).toBeGreaterThan(StructureElement.Loci.size(f.loci));
  });
  it('rejects a polymer interface without a scientific surface owner', async () => {
    const f = await fixture();
    await expect(
      buildMolecularInteractionContext(
        f.plugin,
        f.document,
        Structure.toStructureElementLoci(
          substructureFromSelector(f.source, componentPropsFromSelector('polymer'))
        ),
        {
          presentationRole: 'interface',
        }
      )
    ).rejects.toThrow(/surfaceSide/);
  });

  it('keeps the local contact seed separate from the declared scientific surface extent', async () => {
    const f = await fixture();
    const plan = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
      presentationRole: 'interface',
      surfaceSide: 'target',
      targetSelector: [{ label_comp_id: 'HEC' }, { auth_seq_id: 14 }],
      partnerSelector: { auth_seq_id: 17 },
      interfaceDetailSide: 'both',
      interfaceDetailBasis: 'burial',
    });
    expect(plan.context.scientificTargetAtomCount).toBeGreaterThan(plan.context.targetAtomCount);
    expect(plan.context.surfaceAtomCount).toBe(plan.context.scientificTargetAtomCount);
    await expect(
      buildMolecularInteractionContext(f.plugin, f.document, f.loci, { targetSelector: 'polymer' })
    ).rejects.toThrow(/seed must belong/);
  });

  async function contactScene() {
    const f = await fixture();
    const plan = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
    });
    expect(plan.context.contactCount).toBeGreaterThan(1);
    const document = JSON.parse(plan.scene);
    const structure = document.root.children[0].children[0].children[0];
    const guides = structure.children.find(
      (node: MolecularProfileNode) =>
        node.kind === 'primitives' && node.custom?.dnaforge_interaction_context
    );
    return { scene: plan.scene, document, structure, guides };
  }

  it('rejects a rewrite dropping the computed contact group', async () => {
    const f = await contactScene();
    f.structure.children = f.structure.children.filter(
      (node: MolecularProfileNode) => node !== f.guides
    );
    expect(() => requireRetainedInteractionContacts(f.scene, JSON.stringify(f.document))).toThrow(
      /computed contacts/
    );
  });

  it('rejects deleting one contact or changing its atom endpoint', async () => {
    const f = await contactScene();
    const changed = structuredClone(f.document);
    f.guides.children.pop();
    expect(() => requireRetainedInteractionContacts(f.scene, JSON.stringify(f.document))).toThrow();
    const guides = changed.root.children[0].children[0].children[0].children.find(
      (node: MolecularProfileNode) => node.kind === 'primitives'
    );
    guides.children[0].params.start.expressions[0].atom_index += 100;
    expect(() => requireRetainedInteractionContacts(f.scene, JSON.stringify(changed))).toThrow();
  });

  it('rejects hiding the complete computed contact set', async () => {
    const f = await contactScene();
    f.guides.params.opacity = 0;
    expect(() => requireRetainedInteractionContacts(f.scene, JSON.stringify(f.document))).toThrow();
  });

  it('allows editable contact styling with the same physical endpoints', async () => {
    const f = await contactScene();
    f.guides.children.reverse();
    for (const guide of f.guides.children) {
      guide.params.color = '#aabbcc';
      guide.params.radius = 0.08;
      const start = guide.params.start;
      guide.params.start = guide.params.end;
      guide.params.end = start;
    }
    expect(() =>
      requireRetainedInteractionContacts(f.scene, JSON.stringify(f.document))
    ).not.toThrow();
  });

  it('allows a simplified overview if a detail step retains the complete contact set', async () => {
    const f = await contactScene();
    const overview = structuredClone(f.document.root);
    const structure = overview.children[0].children[0].children[0];
    structure.children = structure.children.filter(
      (node: MolecularProfileNode) => node.kind !== 'primitives'
    );
    const story = {
      kind: 'multiple',
      metadata: f.document.metadata,
      snapshots: [
        { root: overview, metadata: { title: 'Overview', linger_duration_ms: 1000 } },
        { root: f.document.root, metadata: { title: 'Detail', linger_duration_ms: 1000 } },
      ],
    };
    expect(() => requireRetainedInteractionContacts(f.scene, JSON.stringify(story))).not.toThrow();
    expect(() =>
      requireRetainedInteractionContacts(
        JSON.stringify(story),
        JSON.stringify({
          ...f.document,
          root: overview,
        })
      )
    ).toThrow();
  });

  it('rejects scattering one contact set across incomplete story steps', async () => {
    const f = await contactScene();
    const first = structuredClone(f.document.root);
    const second = structuredClone(first);
    const guides = (root: typeof first) =>
      root.children[0].children[0].children[0].children.find(
        (node: MolecularProfileNode) => node.kind === 'primitives'
      );
    guides(first).children = f.guides.children.slice(0, 1);
    guides(second).children = f.guides.children.slice(1);
    expect(() =>
      requireRetainedInteractionContacts(
        f.scene,
        JSON.stringify({
          kind: 'multiple',
          metadata: f.document.metadata,
          snapshots: [
            { root: first, metadata: { linger_duration_ms: 1000 } },
            { root: second, metadata: { linger_duration_ms: 1000 } },
          ],
        })
      )
    ).toThrow();
  });
});

describe('native interaction-context scene ownership', () => {
  const walk = (node: MolecularProfileNode): MolecularProfileNode[] => [
    node,
    ...(node.children ?? []).flatMap(walk),
  ];

  it('retains the native camera when replacing a previously focused context with focus:false', async () => {
    const f = await fixture();
    const camera = new Camera({
      position: Vec3.create(41, -28, 81),
      target: Vec3.create(41, -28, 51),
      up: Vec3.create(0, 1, 0),
      fov: Math.PI / 4,
      minNear: 0.7,
    });
    Object.assign(f.plugin, { canvas3d: { camera } });
    const focused = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: true,
    });
    expect(
      walk(JSON.parse(focused.scene).root).filter((node) => node.kind === 'focus')
    ).toHaveLength(1);
    const originalPose = camera.getSnapshot();
    const retained = await buildMolecularInteractionContext(
      f.plugin,
      MVSData.fromMVSJ(focused.scene),
      f.loci,
      { focus: false }
    );
    const nodes = walk(JSON.parse(retained.scene).root);
    expect(nodes.filter((node) => node.kind === 'focus')).toEqual([]);
    const storedCamera = nodes.filter((node) => node.kind === 'camera');
    expect(storedCamera).toHaveLength(1);
    const reapplied = cameraParamsToCameraSnapshot(
      f.plugin,
      storedCamera[0].params as Parameters<typeof cameraParamsToCameraSnapshot>[1]
    );
    expect(reapplied.target).toEqual(originalPose.target);
    expect(Vec3.distance(reapplied.position!, originalPose.position)).toBeLessThan(1e-10);
    expect(reapplied.up).toEqual(originalPose.up);
    expect(reapplied.minNear).toBe(originalPose.minNear);
    expect(retained.context).toEqual(focused.context);
  });

  it('retains an explicit authored camera and its valid attributes when focus:false', async () => {
    const f = await fixture();
    const camera = new Camera({
      mode: 'orthographic',
      position: Vec3.create(8, 13, 70),
      target: Vec3.create(8, 13, 20),
      up: Vec3.create(0, 1, 0),
      fov: Math.PI / 5,
      minNear: 1.2,
    });
    Object.assign(f.plugin, { canvas3d: { camera } });
    const current = camera.getSnapshot();
    const authoredCamera = {
      kind: 'camera' as const,
      ref: 'authored-camera',
      params: {
        position: [
          ...fovNormalizedCameraPosition(
            current.target,
            current.position,
            current.mode,
            current.fov
          ),
        ],
        target: [...current.target],
        up: [...current.up],
        near: current.minNear,
      },
    };
    f.document.root.children!.push(authoredCamera as never);
    const ligand = walk(f.document.root as MolecularProfileNode).find(
      (node) =>
        node.kind === 'component' &&
        JSON.stringify(node.params?.selector) === JSON.stringify({ label_comp_id: 'HEC' })
    )!;
    ligand.children!.push({
      kind: 'focus',
      params: { direction: [0, 0, -1], up: [0, 1, 0] },
    });
    const retained = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
    });
    const nodes = walk(JSON.parse(retained.scene).root);
    expect(nodes.filter((node) => node.kind === 'focus')).toEqual([]);
    expect(nodes.filter((node) => node.kind === 'camera')).toEqual([authoredCamera]);
  });

  it('inherits relevant backbone carbon tints while preserving ligand identity and element colors', async () => {
    const f = await fixture();
    const plan = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
    });
    const colors = localColors(plan.scene)!;
    expect(colors.map((c) => c.params?.color)).toEqual(['#237ac9', '#e8aa28']);
    expect(colors.every((c) => c.custom?.molstar_color_theme_name === 'element-symbol')).toBe(true);
    expect(plan.context.targetAtomCount).toBeGreaterThan(0);
    expect(plan.context.environmentAtomCount).toBeGreaterThan(plan.context.targetAtomCount);
  });

  it('repeats without accumulating molecular owners or losing carbon color rules', async () => {
    const f = await fixture();
    const first = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
    });
    const second = await buildMolecularInteractionContext(
      f.plugin,
      MVSData.fromMVSJ(first.scene),
      f.loci,
      { focus: false }
    );
    expect(localColors(second.scene)).toEqual(localColors(first.scene));
    expect(JSON.parse(second.scene).root).toEqual(JSON.parse(first.scene).root);
  });

  it('retains published legend labels and selection IDs when repeated geometry is unchanged', async () => {
    const f = await fixture();
    assignMolViewSpecStructureRefs(f.document);
    const first = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
    });
    const publish = (scene: string) => {
      const document = resolveMolecularDisplayGroups(
        resolveMolViewSpecRenderProfile(MVSData.fromMVSJ(scene))
      );
      if (document.kind === 'multiple') throw Error('Expected one interaction view');
      for (const color of walk(document.root).filter((node) => node.kind === 'color'))
        if (color.custom?.dnaforge_legend_generated === true)
          color.custom.dnaforge_selection_id = `selection:${crypto.randomUUID()}`;
      return MVSData.toMVSJ(document);
    };
    const published = publish(first.scene);
    const repeated = await buildMolecularInteractionContext(
      f.plugin,
      MVSData.fromMVSJ(published),
      f.loci,
      { focus: false }
    );
    const retained = preserveEquivalentGeneratedLegendEntries(published, publish(repeated.scene));
    expect(JSON.parse(retained).root).toEqual(JSON.parse(published).root);
    const changed = JSON.parse(published);
    const color = walk(changed.root).find((node) => node.kind === 'color')!;
    color.params!.color = '#ee4411';
    const authored = JSON.stringify(changed);
    expect(preserveEquivalentGeneratedLegendEntries(published, authored)).toBe(authored);
  });

  it('retains the last equivalent inherited overlay after a uniform atomic base layer', async () => {
    const f = await fixture();
    const first = await buildMolecularInteractionContext(f.plugin, f.document, f.loci, {
      focus: false,
    });
    const previous = JSON.parse(first.scene);
    const owner = walk(previous.root).find(
      (node) => node.custom?.dnaforge_interaction_context === 'native-interaction-context-v1'
    )!;
    owner.children![0].children!.unshift({
      kind: 'color',
      params: { color: '#446655', selector: 'all' },
    });
    const retained = await buildMolecularInteractionContext(f.plugin, previous, f.loci, {
      focus: false,
    });
    const colors = localColors(retained.scene)!;
    const nativeOwner = walk(JSON.parse(retained.scene).root).find(
      (node) => node.ref === retained.contextRef
    )!;
    const detail = substructureFromSelector(
      f.source,
      componentPropsFromSelector(nativeOwner.params!.selector as never)
    );
    const sourceAtoms = new Set(
      detail.units.flatMap((unit) =>
        unit.kind === 0
          ? Array.from(unit.elements)
              .filter(
                (index) =>
                  unit.model.atomicHierarchy.atoms.type_symbol.value(index) === 'C' &&
                  isProtein(
                    unit.model.atomicHierarchy.derived.residue.moleculeType[
                      unit.residueIndex[index]
                    ]
                  )
              )
              .map((index) => `${unit.id}:${index}`)
          : []
      )
    );
    expect(sourceAtoms.size).toBeGreaterThan(0);
    const applied = new Map<string, string>();
    for (const layer of colors) {
      const selected = substructureFromSelector(
        f.source,
        componentPropsFromSelector(layer.params!.selector as never)
      );
      for (const unit of selected.units)
        for (const atom of unit.elements) {
          const key = `${unit.id}:${atom}`;
          if (sourceAtoms.has(key)) applied.set(key, layer.params!.color as string);
        }
    }
    expect([...sourceAtoms].map((key) => applied.get(key))).toEqual(
      [...sourceAtoms].map(() => '#237ac9')
    );
  });

  it('derives nucleotide cartoon exclusions from current detail owners, including resolved ones', () => {
    const cartoon: MolecularProfileNode = { kind: 'representation', params: { type: 'cartoon' } };
    const component = (seq: number): MolecularProfileNode => ({
      kind: 'component',
      params: { selector: { label_seq_id: seq } },
      children: [
        {
          kind: 'representation',
          params: { type: 'ball_and_stick' },
          custom: { dnaforge_nucleotide_presentation: {} },
        },
      ],
    });
    const root: MolecularProfileNode = {
      kind: 'structure',
      children: [
        { kind: 'component', params: { selector: 'polymer' }, children: [cartoon] },
        component(1),
      ],
    };
    const defaults = {
      connectorMode: 'simplified' as const,
      baseOpacity: 0.35,
      baseThickness: 0.08,
      connectorRadius: 0.15,
    };
    resolveNucleotidePresentations(root, defaults, '#237ac9');
    const exclusions = () =>
      (cartoon.custom?.molstar_representation_params as Record<string, unknown>)
        .dnaforgeNucleotideExclude;
    resolveNucleotidePresentations(root, defaults, '#237ac9');
    expect(exclusions()).toEqual([{ label_seq_id: 1 }]);
    root.children![1] = component(2);
    resolveNucleotidePresentations(root, defaults, '#237ac9');
    expect(exclusions()).toEqual([{ label_seq_id: 2 }]);
    root.children!.pop();
    resolveNucleotidePresentations(root, defaults, '#237ac9');
    expect(exclusions()).toEqual([]);
  });

  it('keeps each nucleotide plane tinted to its own carbon layer independently of polymer opacity', () => {
    const carbon = (value: number, seq: number): MolecularProfileNode => ({
      kind: 'color',
      params: { color: '#909090', selector: { label_seq_id: seq } },
      custom: {
        molstar_color_theme_name: 'element-symbol',
        molstar_color_theme_params: { carbonColor: { name: 'uniform', params: { value } } },
      },
    });
    const root: MolecularProfileNode = {
      kind: 'structure',
      children: [
        {
          kind: 'component',
          params: { selector: 'all' },
          children: [
            {
              kind: 'representation',
              params: { type: 'ball_and_stick' },
              custom: { dnaforge_nucleotide_presentation: {} },
              children: [carbon(0xe8aa28, 1), carbon(0x237ac9, 2)],
            },
          ],
        },
      ],
    };
    resolveNucleotidePresentations(
      root,
      {
        connectorMode: 'simplified',
        baseOpacity: 0.35,
        baseThickness: 0.08,
        connectorRadius: 0.15,
      },
      '#909090'
    );
    const plane = root.children![0].children![1];
    expect(
      plane
        .children!.filter((c) => c.kind === 'color')
        .slice(1)
        .map((c) => c.params)
    ).toEqual([
      { color: '#e8aa28', selector: { label_seq_id: 1 } },
      { color: '#237ac9', selector: { label_seq_id: 2 } },
    ]);
    expect(plane.children!.find((c) => c.kind === 'opacity')!.params!.opacity).toBe(0.35);
  });
});
