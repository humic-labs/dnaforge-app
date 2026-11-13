import { describe, expect, it } from 'vitest';
import { ScaleLegend } from 'molstar/lib/mol-util/legend';
import { Color } from 'molstar/lib/mol-util/color';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { molecularViewAttrs, molecularViewSourceForCoordinates } from './molecularView';
import {
  defaultColorModeForStructure,
  resolveStructureVisualColorMode,
} from './structureColorDefaults';
import { structureVisualizationCapabilitiesFor } from './structureVisualizationCapabilities';
import { colorKeysForThemes } from '../molstar/molViewSpecLegend';
import type { Structure3dAttrs } from '../types';
import { getColorOptions } from './structureScoreState';
import type { MolecularView } from '../../../../../shared/molecular-view';

const sha256 = 'a'.repeat(64);
const coordinates = {
  sha256,
  format: 'cif' as const,
  text: readFileSync(
    resolve(
      process.cwd(),
      '../../test-fixtures/structure-complexes/alphafold/AF-P39702-F1-model_v6.cif'
    ),
    'utf8'
  ),
};
const view: MolecularView = {
  kind: 'molecular-view',
  version: 1,
  title: 'AlphaFold confidence regression',
  caption: '',
  coordinates,
  source: { source: 'alphafold', sourceId: 'P39702', providerIdentityKey: 'AF:P39702:F1:V6' },
  scene: JSON.stringify({
    kind: 'single',
    root: { kind: 'root', children: [] },
    metadata: { version: '1' },
  }),
  evidence: [],
  preview: 'data:image/png;base64,YQ==',
  createdAt: 1,
};
const scale = ScaleLegend('0', '100', [Color(0xff0000), Color(0x0000ff)]);
const themes = [{ themeName: 'uncertainty', legend: scale }];

function expectConfidence(attrs: Structure3dAttrs) {
  expect(defaultColorModeForStructure(attrs)).toBe('plddt');
  expect(structureVisualizationCapabilitiesFor(attrs).scoreColorModes).toEqual(['plddt']);
  expect(colorKeysForThemes(themes, attrs)).toEqual([{ title: 'pLDDT', legend: scale }]);
  expect(getColorOptions(attrs).map((option) => option.value)).toContain('plddt');
  expect(getColorOptions(attrs).map((option) => option.value)).not.toContain('bfactor');
  expect(resolveStructureVisualColorMode('bfactor', attrs)).toBe('plddt');
}

describe('prediction score semantics across molecular document transitions', () => {
  it('preserves AlphaFold confidence when AI saves and opens a sequence-derived view', () => {
    const attrs = molecularViewAttrs('saved-prediction', view);
    expect(attrs.source).toBe('file');
    expectConfidence(attrs);
  });
  it('preserves confidence through repeated save, reopen and historical restore', () => {
    let snapshot = view;
    for (let index = 0; index < 3; index++) {
      const attrs = molecularViewAttrs('saved-prediction', snapshot, 0);
      expectConfidence(attrs);
      snapshot = {
        ...snapshot,
        source: molecularViewSourceForCoordinates(attrs, coordinates, { source: 'file' }),
      };
      expect(snapshot.source).toEqual(view.source);
    }
  });
  it.each([
    { source: 'alphafold', sourceId: 'P39702' },
    { source: 'url', sourceId: 'https://alphafold.ebi.ac.uk/files/AF-P39702-F1-model_v6.cif' },
    { source: 'file', sourceId: coordinates.text },
    { source: 'file', sourceId: coordinates.text, providerIdentityKey: 'AF:P39702:F1:V6' },
  ] as Structure3dAttrs[])('recognizes standalone prediction route $source', (attrs) => {
    expectConfidence(attrs);
  });
  it('does not confuse an experimental UniProt-linked structure with a prediction', () => {
    const attrs: Structure3dAttrs = { source: 'pdb', sourceId: '1D3Z', uniprotId: 'P0CG47' };
    expect(defaultColorModeForStructure(attrs)).toBe('chain');
    expect(structureVisualizationCapabilitiesFor(attrs).scoreColorModes).toEqual(['bfactor']);
    expect(colorKeysForThemes(themes, attrs)).toEqual([{ title: 'B-factor (Å²)', legend: scale }]);
    expect(getColorOptions(attrs).map((option) => option.value)).not.toContain('plddt');
  });
  it('does not borrow prediction metadata from different coordinate bytes', () => {
    const attrs: Structure3dAttrs = {
      source: 'file',
      sourceId: 'HEADER    EXPERIMENTAL\nEND\n',
      coordinateSha256: 'b'.repeat(64),
      coordinateSource: { sha256, source: view.source },
    };
    expect(defaultColorModeForStructure(attrs)).toBe('chain');
    expect(structureVisualizationCapabilitiesFor(attrs).scoreColorModes).toEqual(['bfactor']);
  });
});
