import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { complementBase, parseGenBankFull } from '@waypoint/sequence-utils';
import PUBLIC_PUC19_GENBANK from '../../../../../test-fixtures/sequences/circular/pUC19.gb?raw';
import {
  CDS_EXTENSION_DOCUMENT_ID,
  CDS_EXTENSION_ORIGIN_DOCUMENT_ID,
  REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID,
  REAL_ASSEMBLY_PIPELINE_SEQUENCE_PATH,
  buildRealAssemblyPipelineDesign,
  cdsExtensionIncompleteCdsScenario,
  cdsExtensionOriginSpanScenario,
  realAssemblyPipelineAppScenario,
} from './assembly-real-pipeline';
import type { AppScenario } from './types';

const publicSequence = PUBLIC_PUC19_GENBANK.split(/^ORIGIN\s*$/m)[1]
  .split('//')[0]
  .replace(/[^acgt]/giu, '')
  .toUpperCase();
const reversed = [...publicSequence]
  .reverse()
  .map((base) => complementBase(base))
  .join('');
const expectedSequence = reversed.slice(1603) + reversed.slice(0, 1603);

function serializedSource(scenario: AppScenario, documentId: string) {
  const source = scenario.sequences?.[documentId];
  const sourcePath = scenario.sequenceSources?.[documentId]?.sourcePath;
  if (!source || !sourcePath) throw new Error('Scenario must expose its source cache and path.');
  const content = scenario.files?.[sourcePath];
  if (typeof content !== 'string') throw new Error('Scenario must expose its GenBank source file.');
  const parsed = parseGenBankFull(content);
  expect(parsed.sequence.toUpperCase()).toBe(expectedSequence);
  expect(createHash('sha256').update(parsed.sequence.toUpperCase()).digest('hex')).toBe(
    '8fec98bb66e9bea40b3baa0925b09af0035595b16a30444784b1bc7d888a77b3'
  );
  expect(source.sequence.toUpperCase()).toBe(expectedSequence);
  expect(parsed.annotations).toEqual(source.annotations);
  return parsed;
}

afterAll(() => {
  const bytes = readFileSync(
    resolve(process.cwd(), '../../test-fixtures/sequences/circular/pUC19.gb')
  );
  expect(bytes.toString('utf8')).toBe(PUBLIC_PUC19_GENBANK);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '1845388058a8065a101795172019d0369340e64631485bf85fc2a3b84011868d'
  );
});

describe('real assembly public-source coordinate frame', () => {
  it('keeps serialized source and every cached annotation in the independently derived frame', () => {
    const scenario = realAssemblyPipelineAppScenario('gibson-pcr-rd-pcr-two-spacers');
    expect(scenario.sequenceSources?.[REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID]?.sourcePath).toBe(
      REAL_ASSEMBLY_PIPELINE_SEQUENCE_PATH
    );
    const parsed = serializedSource(scenario, REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID);
    expect(parsed.length).toBe(2686);
    expect(parsed.annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'AmpR',
          type: 'CDS',
          start: 1284,
          end: 2144,
          direction: 1,
        }),
        expect.objectContaining({
          name: 'lacZ-alpha',
          type: 'CDS',
          start: 615,
          end: 938,
          direction: 1,
        }),
      ])
    );
    expect(parsed.annotations).toHaveLength(
      parseGenBankFull(PUBLIC_PUC19_GENBANK).annotations.length
    );
  });

  it('retains the original two-PCR product and Golden Gate junction inputs', () => {
    const design = buildRealAssemblyPipelineDesign('goldengate-pcr-pcr');
    expect(design.regions.map((region) => region.sequence)).toEqual([
      expectedSequence.slice(280, 660),
      expectedSequence.slice(1500, 1880),
    ]);
    expect(design.regions.map((region) => region.sequence).join('')).toHaveLength(760);
    expect(design.goldenGateJunctions?.map((junction) => junction.overhang)).toEqual([
      'AGTG',
      'TATT',
    ]);
  });

  it('retains the original BsmBI digest interval and physical ends', () => {
    const design = buildRealAssemblyPipelineDesign('gibson-pcr-rd-pcr-two-spacers');
    const digest = design.regions.find((region) => region.id === 'puc19-bsmbi-rd');
    expect(digest).toMatchObject({
      sourceStart: 1034,
      sourceEnd: 1076,
      sequence: expectedSequence.slice(1034, 1076),
      rdOverhangs: { upstream: 'GGGA', downstream: 'CGCG' },
    });
  });

  it('serializes the clipped AmpR factory with matching source-cache annotations', () => {
    const parsed = serializedSource(cdsExtensionIncompleteCdsScenario(), CDS_EXTENSION_DOCUMENT_ID);
    expect(parsed.annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'AmpR (clipped)',
          type: 'CDS',
          start: 1314,
          end: 2111,
          direction: 1,
        }),
        expect.objectContaining({
          name: 'lacZ-alpha',
          type: 'CDS',
          start: 615,
          end: 938,
          direction: 1,
        }),
      ])
    );
    expect(parsed.annotations.some((annotation) => annotation.name === 'AmpR')).toBe(false);
  });

  it('serializes the origin-spanning factory with its added CDS and original genes', () => {
    const parsed = serializedSource(
      cdsExtensionOriginSpanScenario(),
      CDS_EXTENSION_ORIGIN_DOCUMENT_ID
    );
    expect(parsed.annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'origin runner',
          type: 'CDS',
          start: 2569,
          end: 2686,
          direction: 1,
        }),
        expect.objectContaining({
          name: 'AmpR',
          type: 'CDS',
          start: 1284,
          end: 2144,
          direction: 1,
        }),
        expect.objectContaining({
          name: 'lacZ-alpha',
          type: 'CDS',
          start: 615,
          end: 938,
          direction: 1,
        }),
      ])
    );
  });
});
