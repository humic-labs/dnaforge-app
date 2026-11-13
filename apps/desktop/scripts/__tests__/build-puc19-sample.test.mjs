import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reverseComplement } from '@waypoint/sequence-utils/iupac';
import {
  PUC19_ACCESSION_VERSION,
  PUC19_OUTPUTS,
  annotatePuc19Record,
  puc19Features,
  sequenceOf,
  translate,
} from '../build-puc19-sample.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const readOutput = (output) => readFile(path.join(repoRoot, output), 'utf8');
const FEATURES_HEADER = 'FEATURES             Location/Qualifiers';

function ncbiPartOf(record) {
  const [header, rest] = record.split(`\n${FEATURES_HEADER}\n`);
  const lines = rest.split('\n');
  const firstAddedFeature = lines.findIndex((line, index) => index > 0 && /^ {5}\S/.test(line));
  const origin = lines.findIndex((line) => line.startsWith('ORIGIN'));
  return [
    header,
    FEATURES_HEADER,
    ...lines.slice(0, firstAddedFeature),
    ...lines.slice(origin),
  ].join('\n');
}

test('the website and the sample workspace ship the same NCBI pUC19 record', async () => {
  const [sample, website] = await Promise.all(PUC19_OUTPUTS.map(readOutput));
  assert.equal(website, sample);
  assert.match(
    sample,
    new RegExp(`^VERSION {5}${PUC19_ACCESSION_VERSION.replace('.', '\\.')}$`, 'm')
  );
  assert.doesNotMatch(sample, /snapgene|SGRef/i);
});

test('rebuilding the committed record from its NCBI part reproduces it byte for byte', async () => {
  const sample = await readOutput(PUC19_OUTPUTS[0]);
  const ncbiPart = ncbiPartOf(sample);
  assert.doesNotMatch(ncbiPart, /lacZ-alpha|AmpR|M13 fwd/);
  assert.equal(annotatePuc19Record(ncbiPart), sample);
});

test('places every feature from sequence evidence alone', async () => {
  const sequence = sequenceOf(await readOutput(PUC19_OUTPUTS[0]));
  assert.equal(sequence.length, 2686);
  const where = Object.fromEntries(
    puc19Features(sequence).map((feature) => [
      feature.qualifiers.find(([name]) => name === 'label')[1],
      feature.where,
    ])
  );
  assert.deepEqual(where, {
    'lacZ-alpha': { strand: -1, start: 146, end: 469 },
    'M13 fwd': { strand: 1, start: 379, end: 395 },
    MCS: { strand: 1, start: 396, end: 452 },
    'M13 rev': { strand: -1, start: 465, end: 481 },
    'lac operator': { strand: -1, start: 489, end: 505 },
    ori: { strand: 1, start: 866, end: 866 },
    AmpR: { strand: -1, start: 1626, end: 2486 },
  });
  const lacZAlpha = translate(reverseComplement(sequence.slice(145, 469)));
  assert.match(lacZAlpha, /^MTMITPSLHACRS[A-Z]+\*$/);
  const betaLactamase = translate(reverseComplement(sequence.slice(1625, 2486)));
  assert.match(betaLactamase, /^MSIQHFRVALIPFFAAF[A-Z]+\*$/);
  assert.equal(betaLactamase.length, 287);
});
