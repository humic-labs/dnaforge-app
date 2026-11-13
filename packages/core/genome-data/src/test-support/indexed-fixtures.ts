import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IndexedGenomeManifest, SearchHit } from '../types';

const TEST_SUPPORT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(TEST_SUPPORT_DIR, '../../../../..');
const API_DIR = path.join(REPO_ROOT, 'apps/api');
const API_VENV_PYTHON =
  process.platform === 'win32'
    ? path.join(API_DIR, '.venv/Scripts/python.exe')
    : path.join(API_DIR, '.venv/bin/python');

export const FIXTURES = {
  puc19Gb: path.join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb'),
  mg1655CompleteGb: path.join(
    REPO_ROOT,
    'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb'
  ),
  mg1655RegionGb: path.join(REPO_ROOT, 'test-fixtures/sequences/linear/ecoli-mg1655-region.gb'),
  yeastChrIVGbff: path.join(REPO_ROOT, 'test-fixtures/genomes/yeast-chrIV/chrIV.gbff'),
  puc19IndexedDir: path.join(REPO_ROOT, 'test-fixtures/indexed/pUC19'),
  yeastChrIVIndexedDir: path.join(REPO_ROOT, 'test-fixtures/indexed/yeast-chrIV'),
} as const;

export function puc19IndexedManifest(): IndexedGenomeManifest {
  const dir = FIXTURES.puc19IndexedDir;
  return indexedQuartetManifest(dir, 'puc19', 'pUC19');
}

export function yeastChrIVIndexedManifest(): IndexedGenomeManifest {
  const dir = FIXTURES.yeastChrIVIndexedDir;
  return indexedQuartetManifest(dir, 'chrIV', 'chrIV');
}

function annotationIndexPath(dir: string, fileBase: string): string | null {
  const csiPath = path.join(dir, `${fileBase}.gff3.gz.csi`);
  if (existsSync(csiPath)) return csiPath;
  const tbiPath = path.join(dir, `${fileBase}.gff3.gz.tbi`);
  return existsSync(tbiPath) ? tbiPath : null;
}

function indexedQuartetManifest(
  dir: string,
  chrom: string,
  fileBase: string
): IndexedGenomeManifest {
  const fastaGzPath = path.join(dir, `${fileBase}.fa.gz`);
  const fastaPath = existsSync(fastaGzPath) ? fastaGzPath : path.join(dir, `${fileBase}.fa`);
  return {
    chrom,
    fastaPath,
    faiPath: `${fastaPath}.fai`,
    ...(existsSync(fastaGzPath) ? { gziPath: `${fastaGzPath}.gzi` } : {}),
    gffPath: path.join(dir, `${fileBase}.gff3.gz`),
    tbiPath: annotationIndexPath(dir, fileBase),
  };
}

export interface IndexedFixture {
  workspace: string;
  manifest: IndexedGenomeManifest;
  sourcePath: string;
}

export async function indexFixture(sourcePath: string, name: string): Promise<IndexedFixture> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'genome-data-index-'));
  const input = path.join(workspace, path.basename(sourcePath));
  const outputDir = path.join(workspace, 'derived');
  await copyFile(sourcePath, input);

  runIndexer(input, outputDir, name, workspace);

  const gffPath = path.join(outputDir, `${name}.gff3.gz`);
  const indexPath = annotationIndexPath(outputDir, name);
  const fastaGzPath = path.join(outputDir, `${name}.fa.gz`);
  const fastaPath = existsSync(fastaGzPath) ? fastaGzPath : path.join(outputDir, `${name}.fa`);

  return {
    workspace,
    sourcePath: input,
    manifest: {
      chrom: name,
      fastaPath,
      faiPath: `${fastaPath}.fai`,
      ...(existsSync(fastaGzPath) ? { gziPath: `${fastaGzPath}.gzi` } : {}),
      gffPath: existsSync(gffPath) ? gffPath : null,
      tbiPath: indexPath,
    },
  };
}

export async function indexRealFastaDerivedFrom(
  sourcePath: string,
  sourceName: string,
  fastaName: string
): Promise<IndexedFixture> {
  const sourceIndexed = await indexFixture(sourcePath, sourceName);
  return indexFixture(sourceIndexed.manifest.fastaPath, fastaName);
}

export async function readFastaSequence(fastaPath: string): Promise<string> {
  if (fastaPath.toLowerCase().endsWith('.gz')) {
    const { BgzipIndexedFasta } = await import('@gmod/indexedfasta');
    const fasta = new BgzipIndexedFasta({
      path: fastaPath,
      faiPath: `${fastaPath}.fai`,
      gziPath: `${fastaPath}.gzi`,
    });
    const names = await fasta.getSequenceNames();
    const chrom = names[0];
    if (!chrom) return '';
    const length = (await fasta.getSequenceSize(chrom)) ?? 0;
    const seq = length > 0 ? await fasta.getSequence(chrom, 0, length) : '';
    return (seq ?? '').toUpperCase();
  }
  const raw = await readFile(fastaPath, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('>'))
    .join('')
    .toUpperCase();
}

export async function collectSearchHits(iterable: AsyncIterable<SearchHit>): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  for await (const hit of iterable) hits.push(hit);
  return hits;
}

export async function readIndexedFastaWindow(
  fastaPath: string,
  faiPath: string,
  chrom: string,
  start: number,
  end: number
): Promise<string> {
  const rawFai = await readFile(faiPath, 'utf8');
  const row = rawFai
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .find((cols) => cols[0] === chrom);
  if (!row) throw new Error(`Missing ${chrom} in ${faiPath}`);

  const [, lengthRaw, offsetRaw, lineBasesRaw, lineBytesRaw] = row;
  const length = Number(lengthRaw);
  const offset = Number(offsetRaw);
  const lineBases = Number(lineBasesRaw);
  const lineBytes = Number(lineBytesRaw);
  if (start < 0 || end < start || end > length) {
    throw new Error(`Invalid FASTA window ${chrom}:${start}-${end}`);
  }

  const firstLine = Math.floor(start / lineBases);
  const lastLine = Math.floor(Math.max(start, end - 1) / lineBases);
  const byteStart = offset + firstLine * lineBytes + (start % lineBases);
  const byteEnd = offset + lastLine * lineBytes + (end % lineBases || lineBases);
  const bytesToRead = byteEnd - byteStart;

  const handle = await open(fastaPath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, byteStart);
    return buffer
      .toString('utf8')
      .replace(/\s/g, '')
      .slice(0, end - start)
      .toUpperCase();
  } finally {
    await handle.close();
  }
}

function runIndexer(input: string, outputDir: string, name: string, workspace: string): void {
  const code = `
from pathlib import Path
from src.services.genome_indexer import index_genome
index_genome(
    input_path=Path(${JSON.stringify(input)}),
    output_dir=Path(${JSON.stringify(outputDir)}),
    name=${JSON.stringify(name)},
    workspace_root=Path(${JSON.stringify(workspace)}),
)
`;
  execFileSync(resolveIndexerPython(), ['-c', code], {
    cwd: API_DIR,
    env: { ...process.env, PYTHONPATH: path.join(REPO_ROOT, 'apps/api') },
    stdio: 'pipe',
  });
}

function pythonHasPysam(python: string): boolean {
  try {
    execFileSync(python, ['-c', 'import pysam'], {
      cwd: API_DIR,
      env: { ...process.env, PYTHONPATH: API_DIR },
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

let cachedIndexerPython: string | undefined;
let cachedHasPysam: boolean | undefined;
function computeIndexerPython(): void {
  const candidates = [
    process.env.GENOME_INDEXER_PYTHON,
    existsSync(API_VENV_PYTHON) ? API_VENV_PYTHON : undefined,
    'python3',
  ].filter((c): c is string => Boolean(c));
  const withPysam = candidates.find(pythonHasPysam);
  cachedIndexerPython = withPysam ?? candidates[0] ?? 'python3';
  cachedHasPysam = withPysam != null;
}

function resolveIndexerPython(): string {
  if (cachedIndexerPython === undefined) computeIndexerPython();
  return cachedIndexerPython as string;
}

export function hasPysam(): boolean {
  if (cachedHasPysam === undefined) computeIndexerPython();
  return cachedHasPysam as boolean;
}
