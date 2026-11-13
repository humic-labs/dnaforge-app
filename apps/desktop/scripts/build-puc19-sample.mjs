#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { reverseComplement } from '@waypoint/sequence-utils/iupac';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const PUC19_ACCESSION_VERSION = 'L09137.2';
export const PUC19_OUTPUTS = [
  'apps/desktop/resources/sample-workspaces/standard-samples/workspace/sequences/plasmids/pUC19/pUC19.gb',
  'apps/web/public/docs/samples/pUC19.gb',
  'test-fixtures/sequences/circular/pUC19.gb',
  'test-fixtures/demo-workspace/assembly-demo/plasmids/pUC19.gb',
  'apps/desktop/src/features/alignment-manager/__tests__/__fixtures__/staleness-detection/reference.gb',
];
const STALENESS_ROOT =
  'apps/desktop/src/features/alignment-manager/__tests__/__fixtures__/staleness-detection';
export const PBR322_REPLICATION_ORIGIN_IN_J01749 = 2535;
export const L09137_SEGMENT_FROM_PBR322 = { puc19Start: 683, pbr322Start: 2352 };

const BLA_PROTEIN_START = 'MSIQHFRVALIPFFAAF';
const LACZ_ALPHA_PROTEIN_START = 'MTMITPSLHACRS';
const LAC_OPERATOR = 'TTGTGAGCGGATAACAA';
const M13_FORWARD = 'GTAAAACGACGGCCAGT';
const M13_REVERSE = 'CAGGAAACAGCTATGAC';
const ECORI = 'GAATTC';
const HINDIII = 'AAGCTT';

const AMINO_ACIDS = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';
const CODON_TO_AMINO_ACID = new Map();
for (const [index, codon] of [...'TCAG']
  .flatMap((first) =>
    [...'TCAG'].flatMap((second) => [...'TCAG'].map((third) => first + second + third))
  )
  .entries()) {
  CODON_TO_AMINO_ACID.set(codon, AMINO_ACIDS[index]);
}

export function sequenceOf(genbank) {
  const origin = genbank.split(/\nORIGIN\s*\n/)[1];
  if (!origin) throw new Error('GenBank record has no ORIGIN block');
  return origin
    .replace(/\/\/[\s\S]*$/, '')
    .replace(/[^acgtACGT]/g, '')
    .toUpperCase();
}

export function translate(coding) {
  let protein = '';
  for (let index = 0; index + 3 <= coding.length; index += 3) {
    protein += CODON_TO_AMINO_ACID.get(coding.slice(index, index + 3)) ?? 'X';
  }
  return protein;
}

function reverseStrandLocation(length, reverseStart, reverseEnd) {
  return { strand: -1, start: length - reverseEnd + 1, end: length - reverseStart };
}

export function reverseStrandOrfStartingWith(sequence, proteinStart) {
  const reverse = reverseComplement(sequence);
  const matches = [];
  for (let start = reverse.indexOf('ATG'); start >= 0; start = reverse.indexOf('ATG', start + 1)) {
    let end = start;
    while (
      end + 3 <= reverse.length &&
      CODON_TO_AMINO_ACID.get(reverse.slice(end, end + 3)) !== '*'
    ) {
      end += 3;
    }
    if (end + 3 > reverse.length) continue;
    if (translate(reverse.slice(start, end)).startsWith(proteinStart)) {
      matches.push(reverseStrandLocation(sequence.length, start, end + 3));
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected one reverse-strand ORF starting ${proteinStart}, found ${matches.length}`
    );
  }
  return matches[0];
}

export function uniqueMotif(sequence, motif) {
  const found = [];
  for (let at = sequence.indexOf(motif); at >= 0; at = sequence.indexOf(motif, at + 1)) {
    found.push({ strand: 1, start: at + 1, end: at + motif.length });
  }
  const reverse = reverseComplement(sequence);
  if (reverseComplement(motif) !== motif) {
    for (let at = reverse.indexOf(motif); at >= 0; at = reverse.indexOf(motif, at + 1)) {
      found.push(reverseStrandLocation(sequence.length, at, at + motif.length));
    }
  }
  if (found.length !== 1) throw new Error(`Expected one ${motif} site, found ${found.length}`);
  return found[0];
}

function location({ strand, start, end }) {
  const range = start === end ? `${start}` : `${start}..${end}`;
  return strand === -1 ? `complement(${range})` : range;
}

function featureLines(type, where, qualifiers) {
  const lines = [`     ${type.padEnd(16)}${location(where)}`];
  for (const [name, value] of qualifiers) {
    lines.push(`                     /${name}=${typeof value === 'number' ? value : `"${value}"`}`);
  }
  return lines;
}

export function puc19Features(sequence) {
  const lacZAlpha = reverseStrandOrfStartingWith(sequence, LACZ_ALPHA_PROTEIN_START);
  const bla = reverseStrandOrfStartingWith(sequence, BLA_PROTEIN_START);
  const ecoRI = uniqueMotif(sequence, ECORI);
  const hindIII = uniqueMotif(sequence, HINDIII);
  const replicationOrigin =
    PBR322_REPLICATION_ORIGIN_IN_J01749 -
    L09137_SEGMENT_FROM_PBR322.pbr322Start +
    L09137_SEGMENT_FROM_PBR322.puc19Start;
  const coding = [
    ['codon_start', 1],
    ['transl_table', 11],
  ];
  return [
    {
      type: 'CDS',
      where: lacZAlpha,
      qualifiers: [
        ['gene', 'lacZ'],
        ['label', 'lacZ-alpha'],
        ['product', 'LacZ alpha fragment'],
        ...coding,
      ],
    },
    {
      type: 'primer_bind',
      where: uniqueMotif(sequence, M13_FORWARD),
      qualifiers: [['label', 'M13 fwd']],
    },
    {
      type: 'misc_feature',
      where: { strand: 1, start: ecoRI.start, end: hindIII.end },
      qualifiers: [
        ['label', 'MCS'],
        ['note', 'multiple cloning site, EcoRI to HindIII'],
      ],
    },
    {
      type: 'primer_bind',
      where: uniqueMotif(sequence, M13_REVERSE),
      qualifiers: [['label', 'M13 rev']],
    },
    {
      type: 'protein_bind',
      where: uniqueMotif(sequence, LAC_OPERATOR),
      qualifiers: [
        ['label', 'lac operator'],
        ['bound_moiety', 'lac repressor'],
      ],
    },
    {
      type: 'rep_origin',
      where: { strand: 1, start: replicationOrigin, end: replicationOrigin },
      qualifiers: [
        ['label', 'ori'],
        ['note', 'replication origin, pBR322 J01749 base 2535'],
      ],
    },
    {
      type: 'CDS',
      where: bla,
      qualifiers: [['gene', 'bla'], ['label', 'AmpR'], ['product', 'beta-lactamase'], ...coding],
    },
  ].sort((left, right) => left.where.start - right.where.start);
}

export function annotatePuc19Record(ncbiRecord, { normalizeWhitespace = false } = {}) {
  const [header, rest] = ncbiRecord.split(/\nFEATURES {13}Location\/Qualifiers\n/);
  if (!rest) throw new Error('NCBI record has no FEATURES table');
  const originAt = rest.indexOf('\nORIGIN');
  const sourceAndOrigin = rest.slice(0, originAt);
  const origin = rest.slice(originAt + 1);
  const sequence = sequenceOf(ncbiRecord);
  const features = puc19Features(sequence).flatMap((feature) =>
    featureLines(feature.type, feature.where, feature.qualifiers)
  );
  const annotated = [
    header,
    'FEATURES             Location/Qualifiers',
    sourceAndOrigin,
    ...features,
    origin.replace(/\n*$/, '\n'),
  ]
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/, '\n');
  return normalizeWhitespace ? annotated : annotated.replace(/^ORIGIN$/m, 'ORIGIN      ');
}

function stalenessRecord(reference, name, edits) {
  const sequence = edits.reduceRight(
    (value, { start, remove, insert }) =>
      value.slice(0, start) + insert + value.slice(start + remove),
    reference
  );
  const position = (value) =>
    edits.reduce(
      (result, { start, remove, insert }) =>
        value > start + remove
          ? result + insert.length - remove
          : value > start
            ? result + start + insert.length - value
            : result,
      value
    );
  const features = puc19Features(reference).flatMap((feature) =>
    featureLines(
      feature.type,
      {
        ...feature.where,
        start: position(feature.where.start),
        end: position(feature.where.end),
      },
      feature.qualifiers
    )
  );
  const lines = [
    `LOCUS       ${name.padEnd(16)}${String(sequence.length).padStart(11)} bp    DNA     circular SYN 12-NOV-2026`,
    `DEFINITION  Synthetic pUC19 ${name.replace('pUC19-', '')} staleness fixture.`,
    `ACCESSION   ${name}`,
    `VERSION     ${name}.1`,
    'SOURCE      synthetic DNA construct',
    '  ORGANISM  synthetic DNA construct',
    `COMMENT     Derived from NCBI GenBank ${PUC19_ACCESSION_VERSION}.`,
    'FEATURES             Location/Qualifiers',
    `     source          1..${sequence.length}`,
    '                     /organism="synthetic DNA construct"',
    '                     /mol_type="other DNA"',
    ...features,
    'ORIGIN',
  ];
  for (let start = 0; start < sequence.length; start += 60) {
    const groups = sequence
      .slice(start, start + 60)
      .toLowerCase()
      .match(/.{1,10}/g);
    lines.push(`${String(start + 1).padStart(9)} ${groups.join(' ')}`);
  }
  return [...lines, '//', ''].join('\n');
}

export function puc19StalenessFixtures(reference) {
  const substitutions = [100, 500, 1000, 1500, 2000].map((start) => ({
    start,
    remove: 1,
    insert: 'TGCA'['ACGT'.indexOf(reference[start])],
  }));
  const insertions = [
    { start: 300, remove: 0, insert: 'TCG' },
    { start: 1000, remove: 0, insert: 'AAAA' },
    { start: 2000, remove: 0, insert: 'GGGGG' },
  ];
  const deletions = [
    { start: 300, remove: 3, insert: '' },
    { start: 1000, remove: 4, insert: '' },
    { start: 2000, remove: 5, insert: '' },
  ];
  return {
    'reference-with-substitutions.gb': stalenessRecord(
      reference,
      'pUC19-substitutions',
      substitutions
    ),
    'reference-with-insertions.gb': stalenessRecord(reference, 'pUC19-insertions', insertions),
    'reference-with-deletions.gb': stalenessRecord(reference, 'pUC19-deletions', deletions),
    'query-identical.fasta': [
      '>pUC19_clone_perfect_match',
      ...reference.match(/.{1,80}/g),
      '',
    ].join('\n'),
  };
}

async function fetchNcbiRecord() {
  const url =
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore' +
    `&id=${PUC19_ACCESSION_VERSION}&rettype=gbwithparts&retmode=text` +
    '&tool=dnaforge-example-builder&email=hello@dnaforge.com';
  const response = await fetch(url);
  if (!response.ok) throw new Error(`NCBI efetch failed: HTTP ${response.status}`);
  return response.text();
}

async function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' } } });
  const annotated = annotatePuc19Record(
    values.input ? await readFile(values.input, 'utf8') : await fetchNcbiRecord()
  );
  for (const [index, output] of PUC19_OUTPUTS.entries()) {
    await writeFile(
      join(REPO_ROOT, output),
      index < 2 ? annotated : annotated.replace(/[ \t]+$/gm, '')
    );
    process.stdout.write(`wrote ${output}\n`);
  }
  for (const [name, content] of Object.entries(puc19StalenessFixtures(sequenceOf(annotated)))) {
    const output = join(STALENESS_ROOT, name);
    await writeFile(join(REPO_ROOT, output), content);
    process.stdout.write(`wrote ${output}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
