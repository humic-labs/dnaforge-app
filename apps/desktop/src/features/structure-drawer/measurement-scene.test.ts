import { describe, expect, it } from 'vitest';
import { compileMeasurementScene } from './measurement-scene';
import {
  log2Enrichment,
  measurementColor,
  residueMeasurementSchema,
} from '../page/public/embeds/structure3d/residueMeasurement';

const measurement = residueMeasurementSchema.parse({
  id: 'test',
  name: 'Enrichment',
  proteinSequenceSha256: 'a'.repeat(64),
  source: { label: 'counts.csv', analysisId: 'library', revision: 'sha256:input' },
  units: 'log2',
  values: [
    { residue: 2, value: -1 },
    { residue: 3, value: 1 },
  ],
  scale: {
    transform: 'linear',
    domain: [-1, 1],
    colors: ['#0000ff', '#ff0000'],
    missingColor: '#888888',
  },
});
const scene = JSON.stringify({
  kind: 'single',
  metadata: { version: '1' },
  root: {
    kind: 'root',
    children: [
      { kind: 'canvas', params: { background_color: '#ffffff' } },
      {
        kind: 'download',
        children: [
          {
            kind: 'parse',
            children: [
              {
                kind: 'structure',
                params: { type: 'model' },
                children: [
                  {
                    kind: 'component',
                    params: { selector: 'protein' },
                    children: [
                      {
                        kind: 'representation',
                        params: { type: 'cartoon' },
                        children: [{ kind: 'color', params: { color: '#123456' } }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
});
describe('analysis measurements rendered as standard scenes', () => {
  it('retains camera/background/geometry and maps sequence positions to actual scoped residues', () => {
    const result = compileMeasurementScene(scene, measurement, {
      residueTargets: [
        {
          chain: 'B',
          labelAsymId: 'X',
          operator: 'ASM_1',
          residues: [{ residueIndex: 1, position: 401, labelSeqId: 9 }],
        },
      ],
    });
    expect(result.unmappedResidues).toEqual([3]);
    const tree = JSON.parse(result.scene);
    expect(tree.root.children[0]).toEqual(JSON.parse(scene).root.children[0]);
    const structure = tree.root.children[1].children[0].children[0];
    expect(structure.children).toHaveLength(1);
    const colors = structure.children[0].children[0].children;
    expect(colors).toContainEqual(
      expect.objectContaining({
        kind: 'color',
        params: {
          color: '#0000ff',
          selector: [{ label_asym_id: 'X', label_seq_id: 9, instance_id: 'ASM_1' }],
        },
      })
    );
    const again = compileMeasurementScene(result.scene, measurement, {
      residueTargets: [
        {
          chain: 'B',
          labelAsymId: 'X',
          operator: 'ASM_1',
          residues: [{ residueIndex: 1, position: 401, labelSeqId: 9 }],
        },
      ],
    });
    expect(again.scene).toBe(result.scene);
  });
  it('does not guess a chain mapping or turn missing values into zeros', () => {
    expect(() => compileMeasurementScene(scene, measurement, {})).toThrow(/mapping/i);
    expect(measurementColor(measurement, null)).toBe('#888888');
    expect(measurementColor(measurement, 0)).not.toBe('#888888');
  });
  it('derives enrichment from preserved counts and rejects duplicate sites', () => {
    const result = log2Enrichment(
      [
        { residue: 1, before: 9, after: 1 },
        { residue: 2, before: 1, after: 9 },
      ],
      1
    );
    expect(result[0].value).toBeCloseTo(Math.log2(0.2), 12);
    expect(result[1].value).toBeCloseTo(Math.log2(5), 12);
    expect(() =>
      log2Enrichment(
        [
          { residue: 1, before: 9, after: 1 },
          { residue: 1, before: 1, after: 9 },
        ],
        1
      )
    ).toThrow(/one count pair/);
    expect(() =>
      residueMeasurementSchema.parse({
        ...measurement,
        values: [measurement.values[0], measurement.values[0]],
      })
    ).toThrow(/one value/);
  });
});

it('colors both explicitly identified comparison models without changing their geometry', () => {
  const tree = JSON.parse(scene);
  const parse = tree.root.children[1].children[0];
  const first = parse.children[0];
  first.params.model_index = 0;
  const second = structuredClone(first);
  second.params.model_index = 1;
  parse.children.push(second);
  const link = {
    residueTargets: ['R', 'V'].map((chain) => ({
      chain,
      labelAsymId: chain,
      residues: [{ residueIndex: 1, position: 2, labelSeqId: 2 }],
    })),
  };
  const result = compileMeasurementScene(JSON.stringify(tree), measurement, link, {
    reference: {},
    alternate: {},
  } as any);
  const models = JSON.parse(result.scene).root.children[1].children[0].children;
  expect(models).toHaveLength(2);
  for (const model of models) {
    expect(model.children[0].children[0].params.type).toBe('cartoon');
    expect(model.children[0].children[0].children.at(-1).params).toMatchObject({
      color: '#0000ff',
    });
  }
  expect(result.mappedResidues).toEqual([2]);
  expect(result.unmappedResidues).toEqual([3]);
  second.params.model_index = 0;
  expect(() =>
    compileMeasurementScene(JSON.stringify(tree), measurement, link, {
      reference: {},
      alternate: {},
    } as any)
  ).toThrow(/model/i);
});
