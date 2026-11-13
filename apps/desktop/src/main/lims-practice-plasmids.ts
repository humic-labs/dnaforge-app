import { parseGenBankFull } from '@waypoint/sequence-utils';

export interface PracticePlasmidBackbone {
  name: string;
  path: string;
  markers: readonly string[];
}

export interface PracticePlasmid {
  id: string;
  name: string;
  backbone: string;
  accession: string;
  markers: readonly string[];
  insertAfter: number;
  insertLength: number;
  bases: string;
}

export const PRACTICE_PLASMID_COUNT = 500;
export const PRACTICE_INSERT_LENGTH = { min: 300, max: 3000 } as const;
const PRACTICE_PLASMID_SEED = 20261021;

const SAMPLE_PLASMIDS =
  'apps/desktop/resources/sample-workspaces/standard-samples/workspace/sequences/plasmids';

export const PRACTICE_PLASMID_BACKBONES: readonly PracticePlasmidBackbone[] = [
  { name: 'pUC19', path: `${SAMPLE_PLASMIDS}/pUC19/pUC19.gb`, markers: ['Ampicillin'] },
  { name: 'pUC18', path: `${SAMPLE_PLASMIDS}/pUC18/pUC18.gb`, markers: ['Ampicillin'] },
  {
    name: 'pBR322',
    path: `${SAMPLE_PLASMIDS}/pBR322/pBR322.gb`,
    markers: ['Ampicillin', 'Tetracycline'],
  },
  {
    name: 'pBluescript II SK(+)',
    path: `${SAMPLE_PLASMIDS}/cloning-and-expression/pBluescript-II-SK+/pBluescript-II-SK+.gb`,
    markers: ['Ampicillin'],
  },
  {
    name: 'pGEM-5Zf(+)',
    path: `${SAMPLE_PLASMIDS}/cloning-and-expression/pGEM-5Zf+/pGEM-5Zf+.gb`,
    markers: ['Ampicillin'],
  },
  {
    name: 'pGEX-4T-1',
    path: `${SAMPLE_PLASMIDS}/cloning-and-expression/pGEX-4T-1/pGEX-4T-1.gb`,
    markers: ['Ampicillin'],
  },
  {
    name: 'pcDNA3.1(+)',
    path: `${SAMPLE_PLASMIDS}/cloning-and-expression/pcDNA3.1+/pcDNA3.1+.gb`,
    markers: ['Ampicillin'],
  },
  {
    name: 'pFastBac1-HM',
    path: `${SAMPLE_PLASMIDS}/cloning-and-expression/pFastBac1-HM/pFastBac1-HM.gb`,
    markers: ['Ampicillin', 'Gentamicin'],
  },
  {
    name: 'pEGFP-N1',
    path: `${SAMPLE_PLASMIDS}/fluorescent-protein/pEGFP-N1/pEGFP-N1.gb`,
    markers: ['Kanamycin'],
  },
  {
    name: 'pmCherry-C1',
    path: `${SAMPLE_PLASMIDS}/fluorescent-protein/pmCherry-C1/pmCherry-C1.gb`,
    markers: ['Kanamycin'],
  },
  {
    name: 'pRS416',
    path: `${SAMPLE_PLASMIDS}/yeast-shuttle/pRS416/pRS416.gb`,
    markers: ['Ampicillin'],
  },
  {
    name: 'pRS426',
    path: `${SAMPLE_PLASMIDS}/yeast-shuttle/pRS426/pRS426.gb`,
    markers: ['Ampicillin'],
  },
  {
    name: 'pAAV-MCS',
    path: `${SAMPLE_PLASMIDS}/aav/transfer/pAAV-MCS/pAAV-MCS.gb`,
    markers: ['Ampicillin'],
  },
  {
    name: 'pMD2.G',
    path: `${SAMPLE_PLASMIDS}/lentiviral-packaging/pMD2.G/pMD2.G.gb`,
    markers: ['Ampicillin'],
  },
];

interface LoadedBackbone extends PracticePlasmidBackbone {
  accession: string;
  sequence: string;
  junctionsOutsideFeatures: readonly number[];
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInteger(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

export function junctionsOutsideFeatures(
  length: number,
  features: readonly { start: number; end: number }[]
): number[] {
  const covered = new Uint8Array(length + 1);
  const cover = (from: number, to: number) => {
    for (let junction = Math.max(1, from); junction <= Math.min(length - 1, to); junction += 1) {
      covered[junction] = 1;
    }
  };
  for (const { start, end } of features) {
    if (start <= end) cover(start, end - 1);
    else {
      cover(start, length - 1);
      cover(1, end - 1);
    }
  }
  const free: number[] = [];
  for (let junction = 1; junction < length; junction += 1) {
    if (!covered[junction]) free.push(junction);
  }
  return free;
}

function loadBackbone(
  backbone: PracticePlasmidBackbone,
  readRepoFile: (relativePath: string) => string
): LoadedBackbone {
  const content = readRepoFile(backbone.path);
  const accession = content.match(/^VERSION\s+(\S+)/m)?.[1];
  if (!accession) throw new Error(`${backbone.path} has no VERSION accession`);
  const record = parseGenBankFull(content);
  const sequence = record.sequence.toUpperCase();
  const junctions = junctionsOutsideFeatures(
    sequence.length,
    record.annotations.filter((feature) => feature.type !== 'source')
  );
  if (junctions.length === 0) throw new Error(`${backbone.path} has no gap between features`);
  return { ...backbone, accession, sequence, junctionsOutsideFeatures: junctions };
}

export function buildPracticePlasmids(
  readRepoFile: (relativePath: string) => string,
  count: number = PRACTICE_PLASMID_COUNT
): PracticePlasmid[] {
  const backbones = PRACTICE_PLASMID_BACKBONES.map((backbone) =>
    loadBackbone(backbone, readRepoFile)
  );
  const random = seededRandom(PRACTICE_PLASMID_SEED);
  return Array.from({ length: count }, (_, index) => {
    const backbone = backbones[Math.floor(random() * backbones.length)];
    const insertAfter =
      backbone.junctionsOutsideFeatures[
        Math.floor(random() * backbone.junctionsOutsideFeatures.length)
      ];
    const insertLength = randomInteger(
      random,
      PRACTICE_INSERT_LENGTH.min,
      PRACTICE_INSERT_LENGTH.max
    );
    let insert = '';
    for (let base = 0; base < insertLength; base += 1) insert += 'ACGT'[Math.floor(random() * 4)];
    const serial = String(index + 1).padStart(4, '0');
    return {
      id: `syn-${serial}`,
      name: `pSYN-${serial}`,
      backbone: backbone.name,
      accession: backbone.accession,
      markers: backbone.markers,
      insertAfter,
      insertLength,
      bases:
        backbone.sequence.slice(0, insertAfter) + insert + backbone.sequence.slice(insertAfter),
    };
  });
}
