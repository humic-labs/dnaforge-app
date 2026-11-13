import type { GoldenGateEnzyme } from '../../design/public/types';
import rawPryor2020Data from './pryor2020-four-base-ligation-counts.json';

export type GoldenGateFidelityDatasetKey = 'BsaI-HFv2' | 'BsmBI-v2' | 'Esp3I' | 'BbsI-HF';

export interface GoldenGateFidelitySource {
  paper: string;
  doi: string;
  paperUrl: string;
  license: string;
  licenseUrl: string;
  dataAvailability: string;
  retrievedAt: string;
}

interface RawGoldenGateFidelityDataset {
  paperEnzyme: string;
  waypointEnzyme: string;
  supplement: string;
  sourceFile: string;
  sourceUrl: string;
  sourceFileSha256: string;
  workbookCellDigestSha256: string;
  overhangLength: 4;
  rowOverhangs: string[];
  columnOverhangs: string[];
  countsRowMajor: number[];
}

interface RawGoldenGateFidelityData {
  schemaVersion: 1;
  source: GoldenGateFidelitySource;
  datasets: Record<GoldenGateFidelityDatasetKey, RawGoldenGateFidelityDataset>;
}

export interface GoldenGateFidelityDataset {
  key: GoldenGateFidelityDatasetKey;
  paperEnzyme: string;
  waypointEnzyme: string;
  supplement: string;
  sourceFile: string;
  sourceUrl: string;
  sourceFileSha256: string;
  workbookCellDigestSha256: string;
  overhangLength: 4;
  rowOverhangs: readonly string[];
  columnOverhangs: readonly string[];
  count: (rowOverhang: string, columnOverhang: string) => number;
}

export interface GoldenGateOverhangSetConflict {
  type:
    | 'invalid-overhang'
    | 'duplicate-overhang'
    | 'reverse-complement-duplicate'
    | 'self-complementary-overhang';
  overhang: string;
  otherOverhang?: string;
}

export interface GoldenGatePerOverhangFidelity {
  overhang: string;
  reverseComplement: string;
  correctLigations: number;
  totalConsideredLigations: number;
  probability: number;
}

export interface GoldenGateSetFidelityScore {
  datasetKey: GoldenGateFidelityDatasetKey;
  valid: boolean;
  fidelity: number;
  logFidelity: number;
  onTargetCount: number;
  conflicts: readonly GoldenGateOverhangSetConflict[];
  perOverhang: readonly GoldenGatePerOverhangFidelity[];
}

const PRYOR_2020_FOUR_BASE_DATA = rawPryor2020Data as unknown as RawGoldenGateFidelityData;

const DATASET_KEY_BY_WAYPOINT_ENZYME: Partial<
  Record<GoldenGateEnzyme, GoldenGateFidelityDatasetKey>
> = {
  BsaI: 'BsaI-HFv2',
  BbsI: 'BbsI-HF',
  BsmBI: 'BsmBI-v2',
};

const DATASET_CACHE = new Map<GoldenGateFidelityDatasetKey, GoldenGateFidelityDataset>();

export function getGoldenGateFidelitySource(): GoldenGateFidelitySource {
  return PRYOR_2020_FOUR_BASE_DATA.source;
}

export function getGoldenGateFidelityDatasetForEnzyme(
  enzyme: GoldenGateEnzyme
): GoldenGateFidelityDataset | null {
  const key = DATASET_KEY_BY_WAYPOINT_ENZYME[enzyme];
  return key ? getGoldenGateFidelityDataset(key) : null;
}

export function getGoldenGateFidelityDataset(
  key: GoldenGateFidelityDatasetKey
): GoldenGateFidelityDataset {
  const cached = DATASET_CACHE.get(key);
  if (cached) return cached;

  const raw = PRYOR_2020_FOUR_BASE_DATA.datasets[key];
  const rowIndex = indexOverhangs(raw.rowOverhangs);
  const columnIndex = indexOverhangs(raw.columnOverhangs);
  const columnCount = raw.columnOverhangs.length;

  const dataset: GoldenGateFidelityDataset = {
    key,
    paperEnzyme: raw.paperEnzyme,
    waypointEnzyme: raw.waypointEnzyme,
    supplement: raw.supplement,
    sourceFile: raw.sourceFile,
    sourceUrl: raw.sourceUrl,
    sourceFileSha256: raw.sourceFileSha256,
    workbookCellDigestSha256: raw.workbookCellDigestSha256,
    overhangLength: raw.overhangLength,
    rowOverhangs: raw.rowOverhangs,
    columnOverhangs: raw.columnOverhangs,
    count: (rowOverhang: string, columnOverhang: string) => {
      const row = rowIndex.get(normalizeOverhang(rowOverhang));
      const column = columnIndex.get(normalizeOverhang(columnOverhang));
      if (row === undefined || column === undefined) return 0;
      return raw.countsRowMajor[row * columnCount + column] ?? 0;
    },
  };

  DATASET_CACHE.set(key, dataset);
  return dataset;
}

export function scoreGoldenGateOverhangSet(
  overhangs: readonly string[],
  dataset: GoldenGateFidelityDataset
): GoldenGateSetFidelityScore {
  const normalized = overhangs.map(normalizeOverhang);
  const conflicts = findGoldenGateOverhangSetConflicts(normalized);
  const terminalPool = uniqueOverhangs(
    normalized.flatMap((overhang) => [overhang, reverseComplementOverhang(overhang)])
  );
  const perOverhang: GoldenGatePerOverhangFidelity[] = [];
  let logFidelity = 0;

  for (const overhang of normalized) {
    const reverseComplement = reverseComplementOverhang(overhang);
    if (overhang === reverseComplement) {
      perOverhang.push({
        overhang,
        reverseComplement,
        correctLigations: 0,
        totalConsideredLigations: 0,
        probability: 0,
      });
      logFidelity = Number.NEGATIVE_INFINITY;
      continue;
    }
    const correctLigations =
      dataset.count(reverseComplement, overhang) + dataset.count(overhang, reverseComplement);
    let totalConsideredLigations = 0;
    for (const terminal of terminalPool) {
      totalConsideredLigations +=
        dataset.count(terminal, overhang) + dataset.count(terminal, reverseComplement);
    }
    const probability =
      totalConsideredLigations > 0 ? correctLigations / totalConsideredLigations : 0;
    perOverhang.push({
      overhang,
      reverseComplement,
      correctLigations,
      totalConsideredLigations,
      probability,
    });
    logFidelity += probability > 0 ? Math.log(probability) : Number.NEGATIVE_INFINITY;
  }

  return {
    datasetKey: dataset.key,
    valid:
      conflicts.length === 0 &&
      perOverhang.every((item) => item.correctLigations > 0 && item.totalConsideredLigations > 0),
    fidelity: Math.exp(logFidelity),
    logFidelity,
    onTargetCount: perOverhang.reduce((total, item) => total + item.correctLigations, 0),
    conflicts,
    perOverhang,
  };
}

export function findGoldenGateOverhangSetConflicts(
  overhangs: readonly string[]
): GoldenGateOverhangSetConflict[] {
  const normalized = overhangs.map(normalizeOverhang);
  const conflicts: GoldenGateOverhangSetConflict[] = [];
  const firstIndexByOverhang = new Map<string, number>();

  normalized.forEach((overhang, index) => {
    if (!/^[ACGT]{4}$/.test(overhang)) {
      conflicts.push({ type: 'invalid-overhang', overhang });
      return;
    }
    if (reverseComplementOverhang(overhang) === overhang) {
      conflicts.push({ type: 'self-complementary-overhang', overhang });
    }
    const firstIndex = firstIndexByOverhang.get(overhang);
    if (firstIndex !== undefined) {
      conflicts.push({ type: 'duplicate-overhang', overhang });
    } else {
      firstIndexByOverhang.set(overhang, index);
    }
  });

  normalized.forEach((overhang, index) => {
    if (!/^[ACGT]{4}$/.test(overhang)) return;
    const reverseComplement = reverseComplementOverhang(overhang);
    const mateIndex = firstIndexByOverhang.get(reverseComplement);
    if (mateIndex !== undefined && mateIndex !== index && mateIndex < index) {
      conflicts.push({
        type: 'reverse-complement-duplicate',
        overhang,
        otherOverhang: reverseComplement,
      });
    }
  });

  return conflicts;
}

export function reverseComplementOverhang(overhang: string): string {
  let result = '';
  for (let index = overhang.length - 1; index >= 0; index--) {
    const base = overhang[index]?.toUpperCase();
    result +=
      base === 'A' ? 'T' : base === 'T' ? 'A' : base === 'C' ? 'G' : base === 'G' ? 'C' : 'N';
  }
  return result;
}

function indexOverhangs(overhangs: readonly string[]): Map<string, number> {
  return new Map(overhangs.map((overhang, index) => [normalizeOverhang(overhang), index]));
}

function normalizeOverhang(overhang: string): string {
  return overhang.trim().toUpperCase();
}

function uniqueOverhangs(overhangs: readonly string[]): string[] {
  return Array.from(new Set(overhangs));
}
