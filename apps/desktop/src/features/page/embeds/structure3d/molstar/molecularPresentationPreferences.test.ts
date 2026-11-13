/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { representationProps } from 'molstar/lib/extensions/mvs/load-helpers';
import { resolveMolViewSpecRenderProfile as resolveProfile } from './molecularRenderProfile';
import {
  DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES,
  useMolecularPresentationPreferences,
} from './molecularPresentationPreferences';

function scene() {
  const builder = MVSData.createBuilder();
  const structure = builder
    .download({ url: 'structure.cif' })
    .parse({ format: 'mmcif' })
    .modelStructure();
  structure
    .component({ selector: 'nucleic' })
    .representation({ type: 'cartoon', size_factor: 0.12 });
  structure
    .component({ selector: { label_asym_id: 'A', auth_seq_id: 1492 } })
    .representation({ type: 'ball_and_stick' });
  return builder.getState();
}

const resolveMolViewSpecRenderProfile = (document: ReturnType<typeof scene>) =>
  resolveProfile(document, 'default', () => true);

function children(document: ReturnType<typeof scene>) {
  return document.root.children![0].children![0].children![0].children!;
}

describe('persistent presentation preferences', () => {
  it('migrates the old compulsory overlay preference to purposeful authored views', async () => {
    localStorage.setItem(
      'dnaforge:molecular-presentation-preferences',
      JSON.stringify({
        version: 1,
        state: {
          preferences: {
            ...DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES,
            comparisonPresentation: 'overlay',
          },
        },
      })
    );
    await useMolecularPresentationPreferences.persist.rehydrate();
    expect(useMolecularPresentationPreferences.getState().preferences.comparisonPresentation).toBe(
      'authored'
    );
  });

  beforeEach(() => {
    useMolecularPresentationPreferences
      .getState()
      .update(DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES);
  });

  it('applies base atoms plus schematic connectors automatically and resolves readable cartoon scale', () => {
    const original = scene();
    const resolved = resolveMolViewSpecRenderProfile(original);
    if (resolved.kind === 'multiple') throw Error('Expected one scene');
    const [context, detail] = children(resolved);
    expect(context.children![0].params).toMatchObject({ size_factor: 1 });
    expect(detail.children![0].custom?.molstar_representation_params).toMatchObject({
      dnaforgeNucleotideAtomicMode: 'base-only',
    });
    expect(detail.children).toHaveLength(3);
    expect(resolved.root.custom?.dnaforge_render_profile).toMatchObject({
      version: 12,
      surfaceOwnership: 'single-side-v1',
    });
    expect(MVSData.validationIssues(resolved, { noExtra: true })).toBeUndefined();
    expect(children(original)[0].children![0].params).toMatchObject({ size_factor: 0.12 });
  });

  it('does not accept an unrecorded atomic or thin-cartoon override', () => {
    const input = scene();
    children(input)[1].children![0].custom = {
      dnaforge_nucleotide_presentation: { connectorMode: 'atomic' },
    };
    const resolved = resolveMolViewSpecRenderProfile(input);
    if (resolved.kind === 'multiple') throw Error('Expected one scene');
    expect(
      children(resolved)[1].children![0].custom?.dnaforge_nucleotide_presentation
    ).toMatchObject({ connectorMode: 'simplified' });
    expect(representationProps(children(resolved)[0].children![0]).sizeTheme).toEqual({
      name: 'uniform',
      params: { value: 1 },
    });
  });

  it('snapshots a deliberate detail exception while retaining the required nucleic ribbon scale', () => {
    const input = scene();
    input.root.custom = {
      dnaforge_presentation_override: {
        reason: 'Explain phosphate chemistry in a separate detail view.',
        fields: ['nucleotideDetail', 'cartoonScale'],
      },
    };
    children(input)[1].children![0].custom = {
      dnaforge_nucleotide_presentation: { connectorMode: 'atomic' },
    };
    const resolved = resolveMolViewSpecRenderProfile(input);
    if (resolved.kind === 'multiple') throw Error('Expected one scene');
    expect(children(resolved)[0].children![0].params).toMatchObject({ size_factor: 1 });
    expect(children(resolved)[1].children).toHaveLength(2);
    expect(children(resolved)[1].children![0].custom?.molstar_representation_params).toMatchObject({
      dnaforgeNucleotideAtomicMode: 'full',
    });
    expect(resolved.root.custom?.dnaforge_presentation_override).toEqual(
      input.root.custom.dnaforge_presentation_override
    );
  });

  it('rejects an empty exception reason', () => {
    const input = scene();
    input.root.custom = {
      dnaforge_presentation_override: { reason: ' ', fields: ['nucleotideDetail'] },
    };
    expect(() => resolveMolViewSpecRenderProfile(input)).toThrow();
  });

  it('persists edits, rehydrates them, and keeps authored snapshots independent of later preferences', async () => {
    useMolecularPresentationPreferences
      .getState()
      .update({ nucleotideDetail: 'atomic', cartoonScale: 1.3 });
    const first = resolveMolViewSpecRenderProfile(scene());
    const persisted = localStorage.getItem('dnaforge:molecular-presentation-preferences')!;
    useMolecularPresentationPreferences.setState({
      preferences: DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES,
    });
    localStorage.setItem('dnaforge:molecular-presentation-preferences', persisted);
    await useMolecularPresentationPreferences.persist.rehydrate();
    expect(useMolecularPresentationPreferences.getState().preferences).toMatchObject({
      nucleotideDetail: 'atomic',
      cartoonScale: 1.3,
    });
    useMolecularPresentationPreferences
      .getState()
      .update({ nucleotideDetail: 'simplified', cartoonScale: 0.8 });
    expect(resolveMolViewSpecRenderProfile(first)).toEqual(first);
  });

  it('adds new preferences when rehydrating old settings without resetting existing choices', async () => {
    localStorage.setItem(
      'dnaforge:molecular-presentation-preferences',
      JSON.stringify({
        version: 1,
        state: {
          preferences: {
            nucleotideDetail: 'atomic',
            cartoonScale: 1.7,
            preservePolymerContext: false,
          },
        },
      })
    );
    await useMolecularPresentationPreferences.persist.rehydrate();
    expect(useMolecularPresentationPreferences.getState().preferences).toEqual({
      nucleotideDetail: 'atomic',
      nucleotideBackbone: 'ribbon',
      cartoonScale: 1.7,
      preservePolymerContext: false,
      bindingSiteDetail: 'atomic',
      bindingSiteSurface: 'translucent',
      interfaceSurface: 'translucent',
      cameraTransitionMs: 500,
      comparisonPresentation: 'authored',
    });
  });
});
