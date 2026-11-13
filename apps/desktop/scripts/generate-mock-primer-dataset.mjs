import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export const GENERATOR_SEED = 0x5109b00b;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FORBIDDEN_TOKENS_FILE = new URL('./lab/mock-primer-forbidden-tokens.json', import.meta.url);
export const FORBIDDEN_GENE_TOKENS = existsSync(FORBIDDEN_TOKENS_FILE)
  ? JSON.parse(readFileSync(FORBIDDEN_TOKENS_FILE, 'utf8'))
  : [];
const isForbiddenGene = (name) => {
  const u = name.toUpperCase();
  return FORBIDDEN_GENE_TOKENS.some((t) => u.includes(t));
};

const COMP = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' };
export function revComp(seq) {
  let out = '';
  for (let i = seq.length - 1; i >= 0; i--) out += COMP[seq[i]] ?? 'N';
  return out;
}
const gcCount = (s) => {
  let n = 0;
  for (const c of s) if (c === 'G' || c === 'C') n++;
  return n;
};
export const gcPercent = (s) => Math.round((gcCount(s) / s.length) * 1000) / 10;
export function primerTm(s) {
  const n = s.length;
  const gc = gcCount(s);
  if (n < 14) return 2 * (n - gc) + 4 * gc;
  return Math.round((64.9 + (41 * (gc - 16.4)) / n) * 10) / 10;
}
const isPureDna = (s) => /^[ACGT]+$/.test(s);

const CODON_TABLE = {
  TTT: 'F',
  TTC: 'F',
  TTA: 'L',
  TTG: 'L',
  CTT: 'L',
  CTC: 'L',
  CTA: 'L',
  CTG: 'L',
  ATT: 'I',
  ATC: 'I',
  ATA: 'I',
  ATG: 'M',
  GTT: 'V',
  GTC: 'V',
  GTA: 'V',
  GTG: 'V',
  TCT: 'S',
  TCC: 'S',
  TCA: 'S',
  TCG: 'S',
  CCT: 'P',
  CCC: 'P',
  CCA: 'P',
  CCG: 'P',
  ACT: 'T',
  ACC: 'T',
  ACA: 'T',
  ACG: 'T',
  GCT: 'A',
  GCC: 'A',
  GCA: 'A',
  GCG: 'A',
  TAT: 'Y',
  TAC: 'Y',
  TAA: '*',
  TAG: '*',
  CAT: 'H',
  CAC: 'H',
  CAA: 'Q',
  CAG: 'Q',
  AAT: 'N',
  AAC: 'N',
  AAA: 'K',
  AAG: 'K',
  GAT: 'D',
  GAC: 'D',
  GAA: 'E',
  GAG: 'E',
  TGT: 'C',
  TGC: 'C',
  TGA: '*',
  TGG: 'W',
  CGT: 'R',
  CGC: 'R',
  CGA: 'R',
  CGG: 'R',
  AGT: 'S',
  AGC: 'S',
  AGA: 'R',
  AGG: 'R',
  GGT: 'G',
  GGC: 'G',
  GGA: 'G',
  GGG: 'G',
};

function tuneAnneal(seq, pos, dir, tmFloor = 58) {
  let longest = null;
  for (let L = 18; L <= 33; L++) {
    let oligo;
    if (dir > 0) {
      if (pos + L > seq.length) break;
      oligo = seq.slice(pos, pos + L);
    } else {
      if (pos - L < 0) break;
      oligo = revComp(seq.slice(pos - L, pos));
    }
    if (!isPureDna(oligo)) continue;
    longest = oligo;
    if (primerTm(oligo) >= tmFloor) return oligo;
  }
  return longest;
}

export function extractGenBankOrigin(gbText) {
  const m = gbText.match(/ORIGIN[^\n]*\n([\s\S]*?)\/\//);
  if (!m) return '';
  return m[1].replace(/[\s0-9]/g, '').toUpperCase();
}

export function parseGenes(content, max) {
  const lines = content.split('\n');
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const loc = lines[i].match(/^ {5}(?:CDS|misc_feature) +(complement\()?(\d+)\.\.(\d+)\)?\s*$/);
    if (!loc) continue;
    const strand = loc[1] ? -1 : 1;
    const start = Number(loc[2]);
    const end = Number(loc[3]);
    if (end - start < 320) continue;
    let gene = null;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^ {5}\S/.test(lines[j])) break;
      const lab = lines[j].match(/\/label="([A-Za-z][A-Za-z0-9-]{1,11}) CDS\b/);
      const gn = lines[j].match(/\/gene="([A-Za-z][A-Za-z0-9-]{1,11})"/);
      if (lab) {
        gene = lab[1];
        break;
      }
      if (gn) {
        gene = gn[1];
        break;
      }
    }
    if (!gene || seen.has(gene) || isForbiddenGene(gene)) continue;
    seen.add(gene);
    out.push({ gene, start, end, strand });
  }
  return out;
}

function geneSenseSeq(genomeSeq, g) {
  const sub = genomeSeq.slice(g.start - 1, g.end);
  const sense = g.strand < 0 ? revComp(sub) : sub;
  return isPureDna(sense) ? sense : null;
}

let GIBSON_TAIL_5 = 'GTAAAACGACGGCCAGTGCC';
let GIBSON_TAIL_3 = 'GCGGATAACAATTTCACACA';

function designForGene(gene, sense, categoryRotation) {
  const rows = [];
  const add = (suffix, sequence) => {
    if (sequence && isPureDna(sequence) && sequence.length >= 16) {
      rows.push({ name: `${gene}_${suffix}`, sequence });
    }
  };

  const tmF = 57 + (categoryRotation % 4);
  const tmR = 57 + ((categoryRotation + 2) % 4);

  const f = tuneAnneal(sense, 0, +1, tmF);
  const r = tuneAnneal(sense, sense.length, -1, tmR);
  add('F', f);
  add('R', r);

  if (categoryRotation % 2 === 0) {
    const off = Math.floor(sense.length * 0.3);
    const amp = Math.min(110, sense.length - off - 30);
    if (amp >= 70) {
      add('qF', tuneAnneal(sense, off, +1, tmF));
      add('qR', tuneAnneal(sense, off + amp, -1, tmR));
    }
  }

  if (categoryRotation % 3 === 0) {
    add('seqF', tuneAnneal(sense, Math.floor(sense.length / 2), +1, tmF));
  }

  if (categoryRotation % 4 === 0) {
    const annealF = tuneAnneal(sense, 0, +1, tmF);
    const annealR = tuneAnneal(sense, sense.length, -1, tmR);
    if (annealF) add('GA_F', GIBSON_TAIL_5 + annealF);
    if (annealR) add('GA_R', GIBSON_TAIL_3 + annealR);
  }

  if (categoryRotation % 5 === 0) {
    const mid = Math.floor(sense.length / 2);
    const c = mid - (mid % 3);
    const flank = 16;
    if (c - flank >= 0 && c + 3 + flank <= sense.length) {
      const wtCodon = sense.slice(c, c + 3);
      const wtAa = CODON_TABLE[wtCodon];
      if (wtAa && wtAa !== '*') {
        const bases = ['A', 'C', 'G', 'T'].filter((b) => b !== wtCodon[2]);
        let chosen = null;
        for (const b of bases) {
          const mutCodon = wtCodon.slice(0, 2) + b;
          const mutAa = CODON_TABLE[mutCodon];
          if (mutAa && mutAa !== '*' && mutAa !== wtAa) {
            chosen = { mutCodon, mutAa };
            break;
          }
        }
        if (chosen) {
          const region =
            sense.slice(c - flank, c) + chosen.mutCodon + sense.slice(c + 3, c + 3 + flank);
          const aaPos = Math.floor(c / 3) + 1;
          if (isPureDna(region)) {
            rows.push({ name: `${gene}_${wtAa}${aaPos}${chosen.mutAa}`, sequence: region });
          }
        }
      }
    }
  }

  if (categoryRotation % 7 === 0) {
    const anneal = tuneAnneal(sense, 0, +1);
    if (anneal)
      rows.push({ name: `BsaI_${gene}_F`, sequence: 'GGTCTCA' + 'AATG' + anneal.slice(0, 18) });
  }

  if (categoryRotation % 11 === 0 && sense.length >= 100) {
    rows.push({ name: `um_${gene}_block`, sequence: sense.slice(0, 100) });
  }

  return rows;
}

const STANDARD_PRIMERS = [
  ['M13_-20_F', 'GTAAAACGACGGCCAGT'],
  ['M13_-21_F', 'TGTAAAACGACGGCCAGT'],
  ['M13_R', 'CAGGAAACAGCTATGAC'],
  ['T7_F', 'TAATACGACTCACTATAGGG'],
  ['T7_term_R', 'GCTAGTTATTGCTCAGCGG'],
  ['T3_F', 'AATTAACCCTCACTAAAGGG'],
  ['SP6_F', 'ATTTAGGTGACACTATAGAA'],
  ['pUC_F', 'CCCAGTCACGACGTTGTAAAACG'],
  ['pUC_R', 'AGCGGATAACAATTTCACACAGG'],
];

function buildHeroes(pUc19Seq, chrIVSeq) {
  const heroes = [];
  for (const [name, pos] of [
    ['pUC19_ori_F', 600],
    ['pUC19_lacZ_F', 470],
    ['pUC19_bla_F', 1600],
  ]) {
    const seq = pUc19Seq.slice(pos, pos + 20);
    if (isPureDna(seq))
      heroes.push({ name, sequence: seq, target: 'puc19', expectedOrientation: 'forward' });
  }
  for (const [name, pos] of [
    ['chrIV_760k_F', 760000],
    ['chrIV_900k_R', 900000],
  ]) {
    let seq = chrIVSeq.slice(pos, pos + 24);
    const rev = name.endsWith('_R');
    if (rev) seq = revComp(seq);
    if (isPureDna(seq)) {
      heroes.push({
        name,
        sequence: seq,
        target: 'yeast-chrIV',
        expectedOrientation: rev ? 'reverse' : 'forward',
      });
    }
  }
  return heroes;
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const fx = (p) => join(repoRoot, p);
  const outDir = fx('test-fixtures/lims-mock');

  const pUc19Path = fx('test-fixtures/sequences/circular/pUC19.gb');
  const chrIVPath = fx('test-fixtures/genomes/yeast-chrIV/chrIV.gbff');
  const mg1655Path = fx('test-fixtures/sequences/circular/ecoli-mg1655-complete.gb');
  const s288cPaths = ['I', 'II', 'III', 'IV', 'V'].map((r) =>
    fx(`test-fixtures/genomes/yeast-S288C/S288C_chromosome_${r}.gb`)
  );

  for (const p of [pUc19Path, chrIVPath]) {
    if (!existsSync(p)) {
      console.error(`[gen-mock-primers] required public fixture missing: ${p}`);
      process.exit(1);
    }
  }

  const pUc19Seq = extractGenBankOrigin(readFileSync(pUc19Path, 'utf8'));
  const chrIVSeq = extractGenBankOrigin(readFileSync(chrIVPath, 'utf8'));
  GIBSON_TAIL_5 = pUc19Seq.slice(396, 416);
  GIBSON_TAIL_3 = pUc19Seq.slice(450, 470);

  const sources = [];
  for (const p of s288cPaths) {
    if (!existsSync(p)) continue;
    const content = readFileSync(p, 'utf8');
    const seq = extractGenBankOrigin(content);
    for (const g of parseGenes(content, 120)) sources.push({ g, seq });
  }
  if (existsSync(mg1655Path)) {
    const content = readFileSync(mg1655Path, 'utf8');
    const seq = extractGenBankOrigin(content);
    for (const g of parseGenes(content, 80)) sources.push({ g, seq });
  }

  const TARGET_ROWS = 1080;
  const rows = [];
  const seenName = new Set();
  const pushRow = (name, sequence) => {
    let unique = name;
    let bump = 2;
    while (seenName.has(unique)) unique = `${name}_${bump++}`;
    seenName.add(unique);
    rows.push({ name: unique, sequence });
  };

  let gi = 0;
  for (const { g, seq } of sources) {
    if (rows.length >= TARGET_ROWS) break;
    const sense = geneSenseSeq(seq, g);
    if (!sense || sense.length < 360) continue;
    for (const row of designForGene(g.gene, sense, gi)) pushRow(row.name, row.sequence);
    gi++;
  }
  for (const [name, seq] of STANDARD_PRIMERS) pushRow(name, seq);

  for (const r of rows) {
    if (!isPureDna(r.sequence)) {
      console.error(`[gen-mock-primers] non-ACGT sequence for ${r.name}: ${r.sequence}`);
      process.exit(1);
    }
  }

  const heroes = buildHeroes(pUc19Seq, chrIVSeq);

  mkdirSync(outDir, { recursive: true });
  const csv = ['Name,Sequence', ...rows.map((r) => `${r.name},${r.sequence}`)].join('\n') + '\n';
  writeFileSync(join(outDir, 'mock-primers-derivative.csv'), csv, 'utf8');

  writeFileSync(
    join(outDir, 'mock-demo-hero-manifest.json'),
    JSON.stringify(
      {
        _provenance: {
          generator: 'apps/desktop/scripts/generate-mock-primer-dataset.mjs',
          note: 'Designed against PUBLIC reference genomes only (pUC19 L09137, E. coli MG1655, S. cerevisiae S288C). No proprietary data is read. Annealing regions are exact public sub-sequences; tails are standard motifs.',
          rowCount: rows.length,
        },
        heroes,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  writeFileSync(
    join(outDir, 'PROVENANCE.md'),
    [
      '# LIMS demo primer dataset — provenance',
      '',
      'These fixtures are **primers designed against PUBLIC reference genomes only**',
      '(`apps/desktop/scripts/generate-mock-primer-dataset.mjs`). No proprietary data is',
      "read, derived, or anonymized — the designer has no path to the old lab's export.",
      '',
      '- Sources: pUC19 (L09137), E. coli K-12 MG1655, S. cerevisiae S288C chromosomes',
      '  + chr IV (NC_001136.10) — all committed public fixtures.',
      `- Rows: ${rows.length}. Deterministic — re-running reproduces these files byte-for-byte.`,
      '- Each annealing region is an exact genome sub-sequence (or reverse-complement), so',
      '  the primers genuinely bind. Categories: PCR / qPCR / sequencing / Gibson-HiFi /',
      '  QuikChange mutagenesis / Golden Gate / ultramer + universal M13/T7/T3/SP6/pUC primers.',
      '- Hero oligos (`mock-demo-hero-manifest.json`) are public pUC19 + chr IV sub-sequences;',
      '  the main-process seed computes their binding coords via `searchNucleotide`.',
      '- Leak safety = PROVENANCE (no proprietary read) + `mock-primers-leak.test.ts`',
      '  (forbidden-token gate + public-source name gate + k-mer overlap backstop).',
      '',
      'Regenerate (dev only): `npm run gen:mock-primers`',
      '',
    ].join('\n'),
    'utf8'
  );

  const idtDir = fx('apps/desktop/src/features/primers/__fixtures__');
  const toIdt = (n) => {
    const header =
      'Sequence Name,Sequence,Bases,GC Content,Tm (50mM NaCl) C,Purification,Well Position';
    const lines = rows.slice(0, n).map((r, i) => {
      const spaced = (r.sequence.match(/.{1,3}/g) ?? [r.sequence]).join(' ');
      const well = `${'ABCDEFGH'[Math.floor(i / 12) % 8]}${String((i % 12) + 1).padStart(2, '0')}`;
      return `${r.name},${spaced},${r.sequence.length},${gcPercent(r.sequence)},${primerTm(r.sequence)},Standard Desalting,${well}`;
    });
    return [header, ...lines].join('\n') + '\n';
  };
  writeFileSync(join(idtDir, 'idt-order-mock.csv'), toIdt(52), 'utf8');
  writeFileSync(join(idtDir, 'idt-order-mock-full.csv'), toIdt(351), 'utf8');

  console.log(
    `[gen-mock-primers] wrote ${rows.length} designed primers + ${heroes.length} heroes to ${outDir}; IDT mock fixtures (52, 351) to ${idtDir}`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
