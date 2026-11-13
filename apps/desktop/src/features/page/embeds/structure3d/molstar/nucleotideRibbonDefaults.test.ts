/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure } from 'molstar/lib/mol-model/structure';
import { molecularSceneSelections } from './molecularSceneSelections';
import {
  currentMolecularRenderProfile,
  resolveMolViewSpecRenderProfile,
} from './molecularRenderProfile';
import {
  DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES,
  useMolecularPresentationPreferences,
} from './molecularPresentationPreferences';

function thinScene(selector: 'nucleic' | 'protein' = 'nucleic') {
  const b = MVSData.createBuilder();
  b.download({ url: 'structure.cif' })
    .parse({ format: 'mmcif' })
    .modelStructure()
    .component({ selector })
    .representation({ type: 'cartoon' });
  const scene = b.getState();
  const rep = scene.root.children![0].children![0].children![0].children![0].children![0];
  rep.custom = {
    molstar_representation_params: {
      sizeFactor: 0.05,
      aspectRatio: 1,
      nucleicProfile: 'elliptical',
      visuals: ['polymer-trace'],
      alpha: 0.35,
    },
  };
  return { scene, rep };
}

function resolvedRepresentation(scene: ReturnType<typeof thinScene>['scene']) {
  const resolved = resolveMolViewSpecRenderProfile(
    scene,
    'default',
    (selector) => selector === 'nucleic'
  );
  if (resolved.kind === 'multiple') throw Error('Expected one scene');
  return resolved.root.children![0].children![0].children![0].children![0].children![0];
}

describe('nucleic backbone construction', () => {
  beforeEach(() =>
    useMolecularPresentationPreferences
      .getState()
      .update(DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES)
  );

  it('resolves a broad ribbon cross-section, not only overall scale', () => {
    const { scene } = thinScene();
    expect(resolvedRepresentation(scene).custom?.molstar_representation_params).toMatchObject({
      sizeFactor: 0.2,
      aspectRatio: 5,
      nucleicProfile: 'square',
      alpha: 0.35,
      visuals: ['polymer-trace'],
    });
  });

  it('constructs one nucleic path width even when an agent asks to shrink only some paths', () => {
    const { scene } = thinScene();
    scene.root.custom = {
      dnaforge_presentation_override: {
        reason: 'Make a selected path thinner.',
        fields: ['cartoonScale', 'nucleotideBackbone'],
      },
    };
    const structure = scene.root.children![0].children![0].children![0];
    const original = structure.children![0];
    const other = structuredClone(original);
    original.children![0].params = { type: 'cartoon', size_factor: 0.35 };
    other.children![0].params = { type: 'cartoon', size_factor: 0.4 };
    other.children![0].custom = {
      molstar_representation_params: { sizeFactor: 0.12, aspectRatio: 1 },
    };
    structure.children!.push(other);
    const result = resolveMolViewSpecRenderProfile(scene, 'default', () => true);
    if (result.kind === 'multiple') throw Error('Expected single scene');
    for (const component of result.root.children![0].children![0].children![0].children!) {
      const rep = component.children![0];
      expect(rep.params).toMatchObject({ type: 'cartoon', size_factor: 1 });
      expect(rep.custom?.molstar_representation_params).toMatchObject({
        sizeFactor: 0.2,
        aspectRatio: 5,
        nucleicProfile: 'square',
      });
    }
  });

  it('permits an authored thin path only through the explicit viewer preference', () => {
    const { scene } = thinScene();
    const rep = scene.root.children![0].children![0].children![0].children![0].children![0];
    rep.params = { ...rep.params, size_factor: 0.35 };
    useMolecularPresentationPreferences.getState().update({ nucleotideBackbone: 'authored' });
    const resolved = resolvedRepresentation(scene);
    expect(resolved.params).toMatchObject({ type: 'cartoon', size_factor: 0.35 });
    expect(resolved.custom?.molstar_representation_params).toMatchObject({
      sizeFactor: 0.05,
      aspectRatio: 1,
      nucleicProfile: 'elliptical',
      alpha: 0.35,
    });
  });

  it.each(['simplified', 'atomic'] as const)(
    'keeps %s nucleotide chemistry independent from the broad default path',
    (nucleotideDetail) => {
      useMolecularPresentationPreferences.getState().update({ nucleotideDetail });
      const { scene } = thinScene();
      const component = scene.root.children![0].children![0].children![0].children![0];
      component.children!.push({ kind: 'representation', params: { type: 'ball_and_stick' } });
      const result = resolveMolViewSpecRenderProfile(scene, 'default', () => true);
      if (result.kind === 'multiple') throw Error('Expected one scene');
      const representations =
        result.root.children![0].children![0].children![0].children![0].children!;
      expect(representations[0].params).toMatchObject({ type: 'cartoon', size_factor: 1 });
      expect(representations[0].custom?.molstar_representation_params).toMatchObject({
        sizeFactor: 0.2,
        aspectRatio: 5,
        nucleicProfile: 'square',
      });
      expect(representations[1].custom?.molstar_representation_params).toMatchObject({
        dnaforgeNucleotideAtomicMode: nucleotideDetail === 'simplified' ? 'base-only' : 'full',
      });
    }
  );

  it('qualifies identical chain selectors against their own pinned structure, preserving the protein shape', async () => {
    const native = async (nucleic: boolean) => {
      const parsed = await parsePDB(
        nucleic
          ? 'ATOM      1    P   C A   1       0.000   0.000   0.000  1.00 20.00           P\nATOM      2   N1   C A   1       1.000   0.000   0.000  1.00 20.00           N\nEND'
          : 'ATOM      1   CA ALA A   1       0.000   0.000   0.000  1.00 20.00           C\nEND'
      ).run();
      if (parsed.isError) throw Error(parsed.message);
      return molecularSceneSelections(
        Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative)
      );
    };
    const sources = new Map([
      ['rna-source', await native(true)],
      ['protein-source', await native(false)],
    ]);
    const b = MVSData.createBuilder();
    for (const ref of sources.keys()) {
      const source = b
        .download({ url: ref + '.pdb' })
        .parse({ format: 'pdb' })
        .modelStructure({ ref });
      source.component({ selector: { label_asym_id: 'A' } }).representation({
        type: 'cartoon',
        size_factor: 0.35,
        custom: { molstar_representation_params: { sizeFactor: 0.12, aspectRatio: 1 } },
      });
      source
        .component({ selector: { label_asym_id: 'A' } })
        .representation({ type: 'ball_and_stick' });
    }
    const scene = b.getState();
    scene.root.custom = {
      dnaforge_presentation_override: {
        reason: 'A narrow protein trace.',
        fields: ['cartoonScale', 'nucleotideBackbone'],
      },
    };
    const result = resolveMolViewSpecRenderProfile(scene, 'default', (selector, ref) =>
      ref ? (sources.get(ref)?.hasNucleotides(selector) ?? false) : false
    );
    if (result.kind === 'multiple') throw Error('Expected one scene');
    const structures = result.root.children!.map((download) => download.children![0].children![0]);
    const [rna, protein] = structures.map((structure) => structure.children![0].children![0]);
    expect(rna.params).toMatchObject({ size_factor: 1 });
    expect(rna.custom?.molstar_representation_params).toMatchObject({
      sizeFactor: 0.2,
      aspectRatio: 5,
      nucleicProfile: 'square',
    });
    expect(protein.params).toMatchObject({ size_factor: 0.35 });
    expect(protein.custom?.molstar_representation_params).toMatchObject({
      sizeFactor: 0.12,
      aspectRatio: 1,
    });
    expect(structures[0].children![1].children![0].custom?.dnaforge_nucleotide_resolved).toBe(true);
    expect(
      structures[1].children![1].children![0].custom?.dnaforge_nucleotide_resolved
    ).toBeUndefined();
  });

  it('preserves protein shape choices and historical nucleotide-shape exceptions', () => {
    expect(
      resolvedRepresentation(thinScene('protein').scene).custom?.molstar_representation_params
    ).toMatchObject({ aspectRatio: 1, nucleicProfile: 'elliptical' });
    const { scene } = thinScene();
    scene.root.custom = {
      dnaforge_render_profile: { ...currentMolecularRenderProfile(), version: 11 },
      dnaforge_presentation_override: {
        reason: 'Use a cylindrical nucleic trace to compare strand routing.',
        fields: ['nucleotideBackbone'],
      },
    };
    expect(resolvedRepresentation(scene).custom?.molstar_representation_params).toMatchObject({
      aspectRatio: 1,
      nucleicProfile: 'elliptical',
      sizeFactor: 0.2,
    });
  });

  it('does not alter historical profile snapshots', () => {
    const { scene, rep } = thinScene();
    const historical = { ...DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES };
    delete (historical as { nucleotideBackbone?: unknown }).nucleotideBackbone;
    scene.root.custom = {
      dnaforge_render_profile: {
        id: 'dnaforge-detail',
        version: 9,
        ballAndStick: { sizeFactor: 0.55, atomScale: 0.5, bondToAtomRatio: 0.5 },
        atomicColors: { carbonColor: '#909090', saturation: 0, lightness: 0 },
        presentation: historical,
      },
    };
    expect(resolvedRepresentation(scene).custom?.molstar_representation_params).toMatchObject({
      aspectRatio: 1,
      nucleicProfile: 'elliptical',
    });
    expect(rep.custom?.molstar_representation_params).toMatchObject({ sizeFactor: 0.05 });
  });
});
