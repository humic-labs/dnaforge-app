import { describe, expect, it } from 'vitest';
import type { Structure3dAttrs } from '../types';
import {
  getColorOptions,
  structureCoordinateScores,
  structureScoreState,
} from './structureScoreState';
import {
  createCartoonRecipe,
  createStructureViewStateFromRecipe,
  structureViewStateFromAttrs,
} from './viewRecipe';
import { reduceStructureViewCommand, type StructureViewCommand } from './structureViewCommands';
import { visualLayersForView } from './viewLayerOverrides';

const digest = 'a'.repeat(64);
const recipe = createCartoonRecipe();
recipe.layers = recipe.layers.map((layer) => ({ ...layer, color: { mode: 'bfactor' } }));

const transitions: StructureViewCommand[] = [
  { type: 'select-recipe', recipe },
  { type: 'set-global-color-mode', colorMode: 'bfactor' },
  { type: 'set-layer-color', layerId: recipe.layers[0].id, colorMode: 'bfactor' },
  { type: 'set-spin', enabled: true },
  { type: 'reset-layer-overrides' },
];

for (const attrs of [
  { source: 'alphafold', sourceId: 'P0AD86' },
  { source: 'url', url: 'https://alphafold.ebi.ac.uk/files/AF-P0AD86-F1-model_v6.cif' },
  {
    source: 'file',
    coordinateSource: { sha256: digest, source: { source: 'alphafold', sourceId: 'P0AD86' } },
  },
] satisfies Structure3dAttrs[]) {
  describe(`${attrs.source} prediction view transitions`, () => {
    it('normalizes restored recipes and overrides before commands or rendering', () => {
      const view = structureViewStateFromAttrs({
        ...attrs,
        view: {
          ...createStructureViewStateFromRecipe(recipe),
          layerOverrides: [{ layerId: recipe.layers[0].id, color: { mode: 'bfactor' } }],
        },
      });
      expect(visualLayersForView(view).every((layer) => layer.color.mode !== 'bfactor')).toBe(true);
    });
    it.each(transitions)('keeps $type in the confidence state', (command) => {
      const view = reduceStructureViewCommand({
        attrs: { ...attrs, view: createStructureViewStateFromRecipe(recipe) },
        command,
      })!;
      expect(visualLayersForView(view).every((layer) => layer.color.mode !== 'bfactor')).toBe(true);
      expect(visualLayersForView(view).some((layer) => layer.color.mode === 'plddt')).toBe(true);
    });
  });
}

it('withholds B-factor for prediction providers without a known confidence metric', () => {
  const attrs: Structure3dAttrs = {
    source: 'file',
    predictionProvenance: {
      provider: 'test',
      toolId: 'unknown-predictor',
      remoteId: 'remote',
      jobRecordId: 'job',
      proteinSequenceSha256: digest,
      coordinateSha256: digest,
      metrics: {},
    },
  };
  expect(structureScoreState(attrs)).toMatchObject({ kind: 'prediction', colorMode: null });
  expect(getColorOptions(attrs).map((option) => option.value)).toEqual(['chain', 'element']);
  const view = reduceStructureViewCommand({
    attrs,
    command: { type: 'set-global-color-mode', colorMode: 'bfactor' },
  })!;
  expect(visualLayersForView(view).every((layer) => layer.color.mode === 'chain')).toBe(true);
});

it('retains B-factor through every experimental-view transition', () => {
  for (const command of transitions) {
    const view = reduceStructureViewCommand({
      attrs: { source: 'pdb', sourceId: '1D3Z', view: createStructureViewStateFromRecipe(recipe) },
      command,
    })!;
    expect(visualLayersForView(view).every((layer) => layer.color.mode === 'bfactor')).toBe(true);
  }
});

it('recognizes non-AlphaFold ModelCIF confidence without inventing AlphaFold identity', () => {
  const attrs: Structure3dAttrs = {
    source: 'file',
    sourceId: 'data_model\n_ma_model_list.model_id 1\n_ma_qa_metric.type pLDDT\n',
  };
  expect(structureScoreState(attrs)).toEqual({
    kind: 'prediction',
    colorMode: 'plddt',
    label: 'pLDDT',
    alphaFold: false,
  });
  expect(getColorOptions(attrs).map((option) => option.value)).toEqual([
    'chain',
    'element',
    'plddt',
  ]);
});

it('withholds B-factor for an imported modeled structure with unspecified scores', () => {
  const attrs: Structure3dAttrs = {
    source: 'file',
    sourceId: 'data_model\n_ma_model_list.model_id 1\n',
  };
  expect(structureScoreState(attrs)).toMatchObject({ kind: 'prediction', colorMode: null });
  expect(getColorOptions(attrs).map((option) => option.value)).toEqual(['chain', 'element']);
});

it('ignores prediction provenance pinned to a different coordinate digest', () => {
  const attrs: Structure3dAttrs = {
    source: 'file',
    sourceId: 'HEADER    EXPERIMENTAL\nEND\n',
    coordinateSha256: 'b'.repeat(64),
    predictionProvenance: {
      provider: 'test',
      toolId: 'alphafold',
      remoteId: 'remote',
      jobRecordId: 'job',
      proteinSequenceSha256: digest,
      coordinateSha256: digest,
      metrics: {},
    },
  };
  expect(structureScoreState(attrs)).toMatchObject({ kind: 'experimental', colorMode: 'bfactor' });
});

it('carries prediction score semantics from native file bytes without replacing their path identity', () => {
  const sourceId = '/project/prediction.cif';
  const coordinateScores = structureCoordinateScores(
    'data_AF-P0AD86-F1\n_entry.id AF-P0AD86-F1\n',
    digest
  );
  const attrs: Structure3dAttrs = {
    source: 'file',
    sourceId,
    coordinateSha256: digest,
    coordinateScores,
  };
  expect(structureScoreState(attrs)).toMatchObject({ kind: 'prediction', colorMode: 'plddt' });
  expect(getColorOptions(attrs).map((option) => option.value)).not.toContain('bfactor');
  expect(attrs.sourceId).toBe(sourceId);
  expect(structureScoreState({ ...attrs, coordinateSha256: 'b'.repeat(64) })).toMatchObject({
    kind: 'experimental',
    colorMode: 'bfactor',
  });
});
