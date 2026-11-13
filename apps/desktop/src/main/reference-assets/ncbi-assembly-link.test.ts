// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as storage from '@waypoint/platform/node-storage';

import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveNcbiDatasetsSelection } from './ncbi-datasets-reference-resolver';
import {
  acquireNcbiAssemblyPackage,
  ncbiAssemblyPackageDownloadUrl,
  parseNcbiAssemblyLink,
} from './ncbi-assembly-link';

const ACCESSION = 'GCF_000005845.2';
const temporaryRoots: string[] = [];

beforeEach(() => {
  vi.spyOn(storage, 'readStorageCapacity').mockResolvedValue({
    destinationPath: '',
    totalBytes: 3996329328640,
    freeBytes: 0,
    importantBytes: 789331063752,
    opportunisticBytes: null,
    availableBytes: 789331063752,
    source: 'macos-important-usage',
    purpose: 'important',
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('NCBI assembly links', () => {
  it.each([
    ACCESSION,
    `  ${ACCESSION}  `,
    `https://www.ncbi.nlm.nih.gov/datasets/genome/${ACCESSION}/`,
    `https://www.ncbi.nlm.nih.gov/datasets/genome/GCA_000005845.2`,
    `https://www.ncbi.nlm.nih.gov/assembly/${ACCESSION}`,
    `https://www.ncbi.nlm.nih.gov/datasets/metagenome/GCA_000007265.1/?utm=1`,
    `https://ftp.ncbi.nlm.nih.gov/genomes/all/GCF/000/005/845/${ACCESSION}_ASM584v2/`,
    'https://www.ebi.ac.uk/ena/browser/view/GCA_000001405.29',
    `https://ftp.ebi.ac.uk/pub/databases/ena/GCF_000008865.2/`,
    'https://genome.ucsc.edu/h/GCF_000008865.2',
    'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/008/865/GCF_000008865.2/hub.txt',
    'https://genome.ucsc.edu/cgi-bin/hgTracks?hubUrl=https://hgdownload.soe.ucsc.edu/hubs/GCF/000/008/865/GCF_000008865.2/hub.txt',
  ])('accepts %s', (link) => {
    const accession = link.includes('GCA_000007265.1')
      ? 'GCA_000007265.1'
      : link.includes('GCA_000001405.29')
        ? 'GCA_000001405.29'
        : link.includes('GCA_000005845.2')
          ? 'GCA_000005845.2'
          : link.includes('GCF_000008865.2')
            ? 'GCF_000008865.2'
            : ACCESSION;
    expect(parseNcbiAssemblyLink(link)).toEqual({ accession });
  });

  it.each([
    '',
    'NC_000913.3',
    'GCF_000005845',
    'https://example.com/datasets/genome/GCF_000005845.2',
    'https://www.ncbi.nlm.nih.gov/datasets/genome/?search=GCF_000005845.2',
    'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000005845.2/GCA_000005845.2',
    'http://www.ncbi.nlm.nih.gov/assembly/GCF_000005845.2',
    'https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg38',
    'hg38',
  ])('rejects %s', (link) => {
    expect(() => parseNcbiAssemblyLink(link)).toThrow();
  });

  it('downloads the one datasets package for that accession and the existing checker admits it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-ncbi-link-fixture-'));
    temporaryRoots.push(root);
    const archivePath = join(root, 'fixture.zip');
    const fastaPath = `ncbi_dataset/data/${ACCESSION}/${ACCESSION}_fixture_genomic.fna`;
    const gffPath = `ncbi_dataset/data/${ACCESSION}/genomic.gff`;
    const fasta = '>NC_000001.1 fixture\nACGT\n';
    const gff = '##gff-version 3\nNC_000001.1\tRefSeq\tregion\t1\t4\t.\t+\t.\tID=chr1\n';
    const files: Record<string, Uint8Array> = {
      'ncbi_dataset/data/dataset_catalog.json': strToU8('{"version":"1"}'),
      'ncbi_dataset/data/assembly_data_report.jsonl': strToU8(
        `${JSON.stringify({ accession: ACCESSION })}\n`
      ),
      'md5sum.txt': strToU8(`${md5(fasta)}  ${fastaPath}\n${md5(gff)}  ${gffPath}\n`),
      [fastaPath]: strToU8(fasta),
      [gffPath]: strToU8(gff),
    };
    await writeFile(archivePath, zipSync(files));

    const acquired = await acquireNcbiAssemblyPackage({
      link: `https://www.ncbi.nlm.nih.gov/datasets/genome/${ACCESSION}/`,
      download: async (url, destinationPath) => {
        expect(url).toBe(ncbiAssemblyPackageDownloadUrl(ACCESSION));
        await writeFile(destinationPath, await readFile(archivePath));
      },
    });
    temporaryRoots.push(acquired.directoryPath);

    await expect(
      resolveNcbiDatasetsSelection({
        selectedPath: acquired.packagePath,
        selectedKind: 'file',
        stagingRoot: join(acquired.directoryPath, 'staging'),
      })
    ).resolves.toMatchObject({ kind: 'ncbi-datasets' });
  });
});

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}
