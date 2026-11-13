#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(HERE, '../resources/sample-workspaces/standard-samples/workspace');
const PUC19 = join(WS, 'sequences/plasmids/pUC19/pUC19.gb');
const OUT_DIR = join(WS, 'sequences/alignments/clone-verification');

const REGION_LEN = 900;

function readOrigin(gb) {
  const originIdx = gb.indexOf('\nORIGIN');
  if (originIdx === -1) throw new Error('no ORIGIN in GenBank');
  const body = gb.slice(originIdx + 7);
  return body
    .replace(/\/\/\s*$/, '')
    .replace(/[^acgtnACGTN]/g, '')
    .toUpperCase();
}

function toGenBank(name, seq, definition) {
  const len = seq.length;
  const date = '14-JUL-2026';
  const header =
    `LOCUS       ${name.padEnd(16)}${String(len).padStart(6)} bp    DNA     linear   SYN ${date}\n` +
    `DEFINITION  ${definition}\n` +
    `ACCESSION   ${name}\n` +
    `KEYWORDS    .\n` +
    `SOURCE      synthetic construct\n` +
    `  ORGANISM  synthetic construct\n` +
    `FEATURES             Location/Qualifiers\n` +
    `     source          1..${len}\n` +
    `                     /organism="synthetic construct"\n` +
    `                     /note="${definition}"\n`;
  let origin = 'ORIGIN\n';
  for (let i = 0; i < len; i += 60) {
    const line = seq.slice(i, i + 60).toLowerCase();
    const groups = line.match(/.{1,10}/g) ?? [];
    origin += `${String(i + 1).padStart(9)} ${groups.join(' ')}\n`;
  }
  origin += '//\n';
  return header + origin;
}

function toFasta(header, seq) {
  let out = `>${header}\n`;
  for (let i = 0; i < seq.length; i += 70) out += seq.slice(i, i + 70) + '\n';
  return out;
}

const NEXT_BASE = { A: 'G', G: 'A', C: 'T', T: 'C' };

function substitute(ref, subs) {
  const arr = ref.split('');
  const muts = [];
  for (const { pos1 } of subs) {
    const i = pos1 - 1;
    const from = arr[i];
    const to = NEXT_BASE[from] ?? 'A';
    arr[i] = to;
    muts.push({
      position: pos1,
      type: 'substitution',
      referenceBase: from,
      alternateBase: to,
      length: 1,
    });
  }
  return { seq: arr.join(''), muts };
}

const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

async function main() {
  const puc19 = readOrigin(await readFile(PUC19, 'utf8'));
  const ref = puc19.slice(0, REGION_LEN);
  if (ref.length !== REGION_LEN) throw new Error(`pUC19 too short: ${ref.length}`);

  const referenceGb = toGenBank(
    'pUC19_ref',
    ref,
    'pUC19 (bp 1-900) reference region for clone-verification alignment demo'
  );

  const clone1 = ref;

  const { seq: clone2, muts: clone2muts } = substitute(ref, [
    { pos1: 150 },
    { pos1: 402 },
    { pos1: 655 },
  ]);

  const delStart = 300;
  const delLen = 5;
  const clone3base = ref.slice(0, delStart - 1) + ref.slice(delStart - 1 + delLen);
  const { seq: clone3, muts: clone3subMuts } = substitute(clone3base, [{ pos1: 500 - delLen }]);
  const clone3subRefPos = 500;
  const clone3Muts = [
    {
      position: delStart,
      type: 'deletion',
      referenceBase: ref.slice(delStart - 1, delStart - 1 + delLen),
      alternateBase: '',
      length: delLen,
    },
    {
      position: clone3subRefPos,
      type: 'substitution',
      referenceBase: ref[clone3subRefPos - 1],
      alternateBase: NEXT_BASE[ref[clone3subRefPos - 1]] ?? 'A',
      length: 1,
    },
  ];

  const alnIdentity = (muts, len) =>
    Math.round(((len - muts.reduce((n, m) => n + m.length, 0)) / len) * 1000) / 10;

  const q3 = ref.split('');
  for (let i = delStart - 1; i < delStart - 1 + delLen; i++) q3[i] = '-';
  q3[clone3subRefPos - 1] = NEXT_BASE[ref[clone3subRefPos - 1]] ?? 'A';
  const alignedQuery3 = q3.join('');

  const withIds = (muts, trackId) => muts.map((m, i) => ({ id: `${trackId}-m${i + 1}`, ...m }));

  const tracks = [
    {
      id: 'trk-clone1',
      queryPath: 'clone-1-verified.fasta',
      label: 'Clone 1 — verified',
      alignment: {
        alignedReference: ref,
        alignedQuery: clone1,
        identity: 100,
        coverageStart: 1,
        coverageEnd: REGION_LEN,
        algorithm: 'global (demo)',
      },
      mutations: [],
      status: 'pass',
      alignedAt: '2026-07-14T12:00:00.000Z',
    },
    {
      id: 'trk-clone2',
      queryPath: 'clone-2-point-mutant.fasta',
      label: 'Clone 2 — point mutant (3 SNPs)',
      alignment: {
        alignedReference: ref,
        alignedQuery: clone2,
        identity: alnIdentity(clone2muts, REGION_LEN),
        coverageStart: 1,
        coverageEnd: REGION_LEN,
        algorithm: 'global (demo)',
      },
      mutations: withIds(clone2muts, 'trk-clone2'),
      status: 'variants',
      alignedAt: '2026-07-14T12:00:00.000Z',
    },
    {
      id: 'trk-clone3',
      queryPath: 'clone-3-frameshift.fasta',
      label: 'Clone 3 — frameshift (5 bp deletion)',
      alignment: {
        alignedReference: ref,
        alignedQuery: alignedQuery3,
        identity: alnIdentity(clone3Muts, REGION_LEN),
        coverageStart: 1,
        coverageEnd: REGION_LEN,
        algorithm: 'global (demo)',
      },
      mutations: withIds(clone3Muts, 'trk-clone3'),
      status: 'fail',
      alignedAt: '2026-07-14T12:00:00.000Z',
    },
  ];

  const sidecar = {
    type: 'alignment-history',
    version: '2.0',
    reference: { name: 'pUC19_ref', checksum: `sha256:${sha256(referenceGb)}` },
    savedAt: '2026-07-14T12:00:00.000Z',
    activeSessionId: 'sess-clone-verification',
    sessions: [
      {
        id: 'sess-clone-verification',
        name: 'Colony sequencing — 3 clones',
        createdAt: '2026-07-14T12:00:00.000Z',
        mode: 'one-per-clone',
        tracks,
      },
    ],
    viewPreferences: {},
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'reference.gb'), referenceGb);
  await writeFile(
    join(OUT_DIR, 'clone-1-verified.fasta'),
    toFasta('clone-1-verified pUC19 clone (matches reference)', clone1)
  );
  await writeFile(
    join(OUT_DIR, 'clone-2-point-mutant.fasta'),
    toFasta('clone-2-point-mutant pUC19 clone with 3 substitutions', clone2)
  );
  await writeFile(
    join(OUT_DIR, 'clone-3-frameshift.fasta'),
    toFasta('clone-3-frameshift pUC19 clone with a 5 bp deletion', clone3)
  );
  await writeFile(
    join(OUT_DIR, 'reference.gb.waypoint.json'),
    JSON.stringify(sidecar, null, 2) + '\n'
  );

  for (const t of tracks) {
    const nonGap = [...t.alignment.alignedReference].filter((c) => c !== '-').length;
    if (nonGap !== REGION_LEN)
      throw new Error(
        `track ${t.id}: alignedReference non-gap ${nonGap} != ${REGION_LEN} (would be STALE)`
      );
    if (t.alignment.alignedReference.length !== t.alignment.alignedQuery.length)
      throw new Error(`track ${t.id}: aligned strings differ in length`);
  }

  console.log(`alignment demo written to ${OUT_DIR}`);
  console.log(
    `  reference.gb ${ref.length} bp, checksum sha256:${sha256(referenceGb).slice(0, 12)}…`
  );
  console.log(
    `  tracks: ${tracks.map((t) => `${t.label} (${t.mutations.length} mut, ${t.status})`).join('; ')}`
  );
}

main().catch((e) => {
  console.error('build-alignment-demo failed:', e.message);
  process.exit(1);
});
